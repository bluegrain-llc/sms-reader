import { after, test } from 'node:test';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { Relay } from '../src/relay.js';
import { hash, MINUTE } from '../src/model.js';
import { submissionSchema } from '../src/forms-model.js';
import { RustRelay, rustApp } from './rust-adapter.js';
import { app } from '../src/http.js';

if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) {
  throw Error('Native identity contracts require Firestore and Auth emulators');
}
const firebase = initializeApp({ projectId: 'demo-sms-relay' }, 'native-identity-contract');
const db = getFirestore(firebase), now = 1_800_000_000_000;
const ts = new Relay(db, async () => {}, () => now);
const rust = new RustRelay(db, async () => {}, () => now) as unknown as Relay;
after(async () => { await deleteApp(firebase); });

async function cleanup(uid: string, grant: string) {
  const id = hash(uid), window = Math.floor(now / MINUTE);
  const receipts = await db.collection('deletionReceipts').where('jobId', '==', id).get();
  const batch = db.batch();
  for (const receipt of receipts.docs) {
    batch.delete(receipt.ref);
    batch.delete(db.collection('accessRates').doc(hash(`grant:deletion:${receipt.id}:${window}`)));
  }
  for (const collection of ['accounts']) batch.delete(db.collection(collection).doc(uid));
  for (const collection of ['deletionJobs', 'deletionAttempts']) batch.delete(db.collection(collection).doc(id));
  for (const scope of [`owner:${uid}`, `grant:${grant}`]) {
    batch.delete(db.collection('accessRates').doc(hash(`${scope}:${window}`)));
    batch.delete(db.collection('streamLimits').doc(hash(scope)));
  }
  await batch.commit();
}

for (const direction of ['typescript-to-rust', 'rust-to-typescript']) {
  test(`${direction}: literal private Unicode marker keeps deletion identity and shared budgets`, { timeout: 60_000 }, async () => {
    const [writer, reader] = direction.startsWith('typescript') ? [ts, rust] : [rust, ts];
    // The adjacent private-use code point also distinguishes a literal UID from
    // the native representation used for isolated UTF-16 surrogates.
    const uid = `native-identity-${direction}-\u{f0000}\ue000`, grant = `marker-grant-${direction}-\u{f0000}`;
    const jobId = hash(uid), window = Math.floor(now / MINUTE);
    try {
      const ownerRate = db.collection('accessRates').doc(hash(`owner:${uid}:${window}`));
      const grantRate = db.collection('accessRates').doc(hash(`grant:${grant}:${window}`));
      await ownerRate.set({ count: 599, purgeAt: new Date(now + MINUTE) });
      await writer.access.read(uid);
      await assert.rejects(reader.access.read(uid), /poll_rate_limited/);
      assert.equal((await ownerRate.get()).data()?.count, 600);
      await ownerRate.delete();
      await grantRate.set({ count: 119, purgeAt: new Date(now + MINUTE) });
      await writer.access.read(uid, grant);
      await assert.rejects(reader.access.read(uid, grant), /poll_rate_limited/);
      assert.equal((await grantRate.get()).data()?.count, 120);

      const first = await writer.access.stream(uid, grant, 100_000);
      const second = await reader.access.stream(uid, grant, 100_000);
      try {
        await assert.rejects(reader.access.stream(uid, grant, 100_000), /stream_limit_reached/);
        assert.equal(Object.keys((await db.collection('streamLimits').doc(hash(`owner:${uid}`)).get()).data()!.leases).length, 2);
      } finally { await first(); await second(); }

      await db.collection('accounts').doc(uid).set({ version: 1 });
      await db.collection('deletionAttempts').doc(jobId).set({ ownerId: uid, nextAt: now - MINUTE });
      await writer.deletions.migrateLegacy();
      assert.equal((await db.collection('deletionAttempts').doc(jobId).get()).exists, false);
      assert.equal((await db.collection('deletionJobs').doc(jobId).get()).data()?.ownerId, uid);
      assert.equal((await db.collection('deletionJobs').doc(jobId).get()).data()?.createdAt, now - MINUTE);
      const requested = await reader.deletions.request(uid);
      const repeated = await writer.deletions.request(uid);
      assert.notEqual(requested.receipt, repeated.receipt);
      for (const receipt of [requested.receipt, repeated.receipt]) {
        assert.equal((await db.collection('deletionReceipts').doc(hash(receipt)).get()).data()?.jobId, jobId);
        assert.deepEqual(await reader.deletions.status(receipt), { status: 'pending' });
      }
      assert.equal((await db.collection('deletionJobs').where('ownerId', '==', uid).get()).size, 1);
      const removed: string[] = [];
      for (let step = 0; step < 13; step++) {
        await (step % 2 ? writer : reader).deletions.step(jobId, async owner => { removed.push(owner); });
      }
      assert.equal(removed.length, 0); // Collection cleanup completes before identity removal.
      await rust.deletions.dispatch(async owner => {
        if (owner.startsWith(`native-identity-${direction}-`)) { assert.equal(owner, uid); removed.push(owner); }
      });
      assert.deepEqual(removed, [uid]);
      assert.deepEqual(await writer.deletions.status(requested.receipt), { status: 'completed' });
      assert.deepEqual(await reader.deletions.status(repeated.receipt), { status: 'completed' });
    } finally { await cleanup(uid, grant); }
  });
}

test('large submission records preserve cached native union-validation parity', { timeout: 30_000 }, async () => {
  await ts.register('native-schema-owner', 'native-schema-device', 'Schema phone', 'synthetic-fcm');
  try {
    const values = Object.fromEntries(Array.from({ length: 10_000 }, (_, i) => [`field_${i}`, true]));
    const input = { submissionId: 'large', action: 'send', values };
    assert.ok(Buffer.byteLength(JSON.stringify(input)) < 256 * 1024);
    assert.equal(submissionSchema.safeParse(input).success, true);
    // Valid input reaches the same missing-request check in each production
    // submission path; invalid union branches must fail before any lookup.
    for (const backend of [ts, rust]) {
      await assert.rejects(backend.forms.submit('native-schema-owner', 'native-schema-device', 'missing-schema-request', input), /request_not_found/);
    }
    for (const value of [true, 1.5, 'a'.repeat(4000), ['valid_id'], 'a'.repeat(4001), ['invalid id'], { invalid: true }]) {
      const candidate = { submissionId: 'union', action: 'send', values: { field: value } };
      const valid = submissionSchema.safeParse(candidate).success;
      if (valid) {
        await assert.rejects(rust.forms.submit('native-schema-owner', 'native-schema-device', 'missing-schema-request', candidate as never), /request_not_found/);
      } else {
        await assert.rejects(rust.forms.submit('native-schema-owner', 'native-schema-device', 'missing-schema-request', candidate as never), /invalid_input/);
      }
    }
  } finally {
    await db.collection('accounts').doc('native-schema-owner').delete();
    await db.collection('devices').doc('native-schema-device').delete();
  }
});

for (const backend of ['typescript', 'rust']) {
  test(`${backend}: owner authentication preserves literal marker UID and recent-auth clock boundary`, { timeout: 30_000 }, async () => {
    const uid = `native-http-identity-${backend}-\u{f0000}\ue000`;
    const relay = backend === 'rust' ? rust : ts;
    let authTime = now / 1000 + 31;
    const options = { verifyOwner: async () => ({ uid, authTime }), deleteIdentity: async () => {}, verifyScheduler: async () => {} };
    const server = (backend === 'rust' ? rustApp(relay, options) : app(relay, options)).listen(0, '127.0.0.1');
    try {
      await once(server, 'listening');
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const request = () => fetch(`${base}/v1/account`, { method: 'DELETE', headers: { Authorization: 'Bearer test-owner' }, signal: AbortSignal.timeout(10_000) });
      const rejected = await request();
      assert.equal(rejected.status, 401);
      assert.deepEqual(await rejected.json(), { error: 'recent_sign_in_required' });
      assert.equal((await db.collection('deletionJobs').doc(hash(uid)).get()).exists, false);
      authTime = now / 1000 + 30;
      const accepted = await request();
      assert.equal(accepted.status, 202);
      const body = await accepted.json() as { receipt: string };
      assert.equal((await db.collection('deletionJobs').doc(hash(uid)).get()).data()?.ownerId, uid);
      assert.equal((await db.collection('deletionReceipts').doc(hash(body.receipt)).get()).data()?.jobId, hash(uid));
      assert.deepEqual(await (backend === 'rust' ? ts : rust).deletions.status(body.receipt), { status: 'pending' });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await cleanup(uid, 'unused');
    }
  });
}
