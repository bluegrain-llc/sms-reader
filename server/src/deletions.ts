import { randomBytes, randomUUID } from 'node:crypto';
import { telemetry, category } from './telemetry.js';
import { Access } from './access.js';
import { Firestore } from 'firebase-admin/firestore';
import { ensure, hash, HISTORY, MINUTE } from './model.js';

const DAY = 24 * 60 * MINUTE;
export const ownedCollections = ['devices', 'grants', 'managers', 'managerCallers', 'connections', 'connectionCodes', 'requests', 'results', 'audit', 'formRequests', 'formResults', 'requestEvents', 'deliveryOutbox'] as const;
export interface DeletionJob {
  ownerId: string; status: 'pending' | 'running' | 'completed'; createdAt: number; updatedAt: number;
  nextAt: number; backlogAt: number; lease: string | null; leaseUntil: number; collectionIndex: number; attempts: number; purgeAt: Date | null;
}
/** The account tombstone survives cleanup. Receipts authorize status only, never account access. */
export class Deletions {
  constructor(readonly db: Firestore, readonly now: () => number, readonly wake: () => Promise<void>) {}
  private initialJob(uid: string): DeletionJob {
    return { ownerId: uid, status: 'pending', createdAt: this.now(), updatedAt: this.now(), nextAt: this.now(), backlogAt: this.now(), lease: null,
      leaseUntil: 0, collectionIndex: 0, attempts: 0, purgeAt: null };
  }
  /** Adopt interrupted pre-worker deletions before sampling or executing the durable queue. */
  async migrateLegacy() {
    const attempts = await this.db.collection('deletionAttempts').orderBy('nextAt').limit(100).get();
    for (const attempt of attempts.docs) await this.db.runTransaction(async tx => {
      const current = await tx.get(attempt.ref);
      if (!current.exists) return;
      const uid: unknown = current.data()?.ownerId;
      ensure(typeof uid === 'string' && uid.length > 0 && hash(uid) === attempt.id, 500, 'invalid_legacy_deletion');
      const account = this.db.collection('accounts').doc(uid), job = this.db.collection('deletionJobs').doc(attempt.id);
      const [owner, existing] = await Promise.all([tx.get(account), tx.get(job)]);
      // Legacy completion was committed only after both record and identity cleanup succeeded.
      if (!owner.data()?.deletionTelemetryComplete && !existing.exists) tx.create(job, this.initialJob(uid));
      tx.set(account, { deleting: true });
      tx.delete(attempt.ref);
    });
  }
  async request(uid: string) {
    const receipt = `smsd_${randomBytes(32).toString('base64url')}`, jobId = hash(uid), expiresAt = this.now() + DAY;
    const ref = this.db.collection('deletionJobs').doc(jobId);
    const status = await this.db.runTransaction(async tx => {
      const old = (await tx.get(ref)).data() as DeletionJob | undefined;
      tx.set(this.db.collection('accounts').doc(uid), { deleting: true });
      if (!old) tx.create(ref, this.initialJob(uid));
      tx.delete(this.db.collection('deletionAttempts').doc(jobId));
      tx.create(this.db.collection('deletionReceipts').doc(hash(receipt)), { jobId, expiresAt, purgeAt: new Date(expiresAt) });
      return old?.status ?? 'pending';
    });
    try { await this.wake(); } catch (error) { telemetry.emit({ event: 'wakeup_failed', category: category(error) }); }
    return { ok: true, status, receipt, receiptExpiresAt: expiresAt };
  }
  async status(receipt: string) {
    ensure(/^smsd_[A-Za-z0-9_-]{43}$/.test(receipt), 401, 'invalid_deletion_receipt');
    const r = (await this.db.collection('deletionReceipts').doc(hash(receipt)).get()).data();
    ensure(r && r.expiresAt > this.now(), 401, 'invalid_deletion_receipt');
    const job = (await this.db.collection('deletionJobs').doc(r.jobId).get()).data() as DeletionJob | undefined;
    ensure(job, 404, 'deletion_not_found');
    await new Access(this.db, this.now).read(job.ownerId, `deletion:${hash(receipt)}`);
    return { status: job.status };
  }
  async step(id: string, deleteIdentity: (uid: string) => Promise<void>) {
    const ref = this.db.collection('deletionJobs').doc(id), lease = randomUUID();
    const job = await this.db.runTransaction(async tx => {
      const j = (await tx.get(ref)).data() as DeletionJob | undefined;
      if (!j || j.status === 'completed' || j.nextAt > this.now() || j.leaseUntil > this.now()) return null;
      const claim = { ...j, status: 'running' as const, lease, leaseUntil: this.now() + MINUTE, nextAt: this.now() + MINUTE,
        updatedAt: this.now(), attempts: j.attempts + 1 };
      tx.set(ref, claim); return claim;
    });
    if (!job) return false;
    try {
      const collection = ownedCollections[job.collectionIndex];
      if (collection) {
        // Each transaction deletes at most 100 records. A lost worker leaves a recoverable lease.
        await this.db.runTransaction(async tx => {
          const current = (await tx.get(ref)).data() as DeletionJob | undefined;
          if (current?.lease !== lease || current.leaseUntil <= this.now()) return;
          const page = await tx.get(this.db.collection(collection).where('ownerId', '==', job.ownerId).limit(100));
          for (const doc of page.docs) tx.delete(doc.ref);
          tx.update(ref, { collectionIndex: job.collectionIndex + (page.size < 100 ? 1 : 0), status: 'pending', lease: null,
            leaseUntil: 0, nextAt: this.now(), updatedAt: this.now() });
        });
      } else {
        try { await deleteIdentity(job.ownerId); }
        catch (e) { if ((e as { code?: string }).code !== 'auth/user-not-found') throw e; }
        await this.db.runTransaction(async tx => {
          const current = (await tx.get(ref)).data() as DeletionJob | undefined;
          if (current?.lease !== lease) return;
          tx.update(ref, { status: 'completed', lease: null, leaseUntil: 0, updatedAt: this.now(), nextAt: Number.MAX_SAFE_INTEGER, backlogAt: Number.MAX_SAFE_INTEGER,
            purgeAt: new Date(this.now() + HISTORY) });
        });
      }
      return true;
    } catch (error) {
      telemetry.emit({ event: 'deletion_failed', category: category(error) });
      await this.db.runTransaction(async tx => {
        if ((await tx.get(ref)).data()?.lease === lease) tx.update(ref, { status: 'pending', lease: null, leaseUntil: 0,
          nextAt: this.now() + MINUTE, updatedAt: this.now() });
      });
      return false;
    }
  }
  async dispatch(deleteIdentity: (uid: string) => Promise<void>) {
    const deadline = Date.now() + 40_000;
    await this.migrateLegacy();
    // Fair rounds let multiple owners make progress; wall-clock budget fits the HTTP deadline.
    for (let round = 0; round < 40 && Date.now() < deadline; round++) {
      const jobs = await this.db.collection('deletionJobs').where('nextAt', '<=', this.now()).orderBy('nextAt').limit(10).get();
      if (jobs.empty) break;
      await Promise.all(jobs.docs.map(doc => this.step(doc.id, deleteIdentity)));
    }
    const remaining = await this.db.collection('deletionJobs').where('nextAt', '<=', this.now()).limit(1).get();
    if (!remaining.empty) { try { await this.wake(); } catch (error) { telemetry.emit({ event: 'wakeup_failed', category: category(error) }); } }
    for (const name of ['deletionReceipts', 'deletionJobs']) {
      const expired = await this.db.collection(name).where('purgeAt', '<=', new Date(this.now())).limit(100).get();
      if (!expired.empty) { const batch = this.db.batch(); for (const d of expired.docs) batch.delete(d.ref); await batch.commit(); }
    }
  }
}
