import { randomUUID } from 'node:crypto';
import { Firestore } from 'firebase-admin/firestore';
import { ensure, hash, MINUTE } from './model.js';

/** Shared counters and stream leases work across stateless Cloud Run instances. */
export class Access {
  constructor(readonly db: Firestore, readonly now: () => number) {}
  async read(ownerId: string, grantId?: string) {
    await this.db.runTransaction(async tx => {
      const window = Math.floor(this.now() / MINUTE);
      const scopes = [{ key: `owner:${ownerId}`, max: 600 }, ...(grantId ? [{ key: `grant:${grantId}`, max: 120 }] : [])];
      const refs = scopes.map(s => this.db.collection('accessRates').doc(hash(`${s.key}:${window}`)));
      const docs = await Promise.all(refs.map(r => tx.get(r)));
      for (let i = 0; i < refs.length; i++) ensure((docs[i]!.data()?.count ?? 0) < scopes[i]!.max, 429, 'poll_rate_limited');
      refs.forEach((ref, i) => tx.set(ref, { count: (docs[i]!.data()?.count ?? 0) + 1, purgeAt: new Date((window + 2) * MINUTE) }));
    });
  }
  private streamRef(scope: string) { return this.db.collection('streamLimits').doc(hash(scope)); }
  async stream(ownerId: string, grantId: string, lifetimeMs: number) {
    const id = randomUUID(); let expiresAt = 0;
    const refs = [this.streamRef(`owner:${ownerId}`), this.streamRef(`grant:${grantId}`)];
    await this.db.runTransaction(async tx => {
      const docs = await Promise.all(refs.map(r => tx.get(r)));
      expiresAt = this.now() + Math.min(lifetimeMs, 100_000) + 10_000;
      const leases = docs.map(d => Object.fromEntries(Object.entries(d.data()?.leases ?? {}).filter(([, until]) => Number(until) > this.now())));
      ensure(Object.keys(leases[0]!).length < 4 && Object.keys(leases[1]!).length < 2, 429, 'stream_limit_reached');
      refs.forEach((ref, i) => tx.set(ref, { leases: { ...leases[i], [id]: expiresAt }, purgeAt: new Date(Math.max(expiresAt, ...Object.values(leases[i]!).map(Number)) + MINUTE) }));
    });
    let released = false;
    const release = async () => {
      if (released) return; released = true;
      await this.db.runTransaction(async tx => {
        const docs = await Promise.all(refs.map(r => tx.get(r)));
        docs.forEach((doc, i) => { if (doc.exists) { const leases = { ...doc.data()!.leases }; delete leases[id]; tx.update(refs[i]!, { leases }); } });
      });
    };
    return Object.assign(release, { deadline: expiresAt - 10_000 });
  }
  async cleanup() {
    for (const name of ['accessRates', 'streamLimits']) {
      const expired = await this.db.collection(name).where('purgeAt', '<=', new Date(this.now())).limit(400).get();
      for (const doc of expired.docs) await this.db.runTransaction(async tx => {
        const current = await tx.get(doc.ref);
        if (current.exists && current.data()!.purgeAt.toMillis() <= this.now()) tx.delete(doc.ref);
      });
    }
  }
}
