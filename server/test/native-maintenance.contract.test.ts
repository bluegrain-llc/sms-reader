import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore, Timestamp, FieldValue } from 'firebase-admin/firestore';
import { MaintenancePages } from '../src/maintenance-pages.js';
import { telemetry } from '../src/telemetry.js';
import { Relay } from '../src/relay.js';
import { hash } from '../src/model.js';
import { RustRelay } from './rust-adapter.js';

if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) {
  throw Error('Native maintenance contracts require Firestore and Auth emulators');
}
const firebase = initializeApp({ projectId: 'demo-sms-relay' }, 'native-maintenance-contract');
const db = getFirestore(firebase);
const now = 1_800_000_000_000;
const rust = new RustRelay(db, async () => {}, () => now);
type Page = { count: number; processed: string[] };

after(async () => { await deleteApp(firebase); });

async function seed(collection: string, count: number, value: Record<string, unknown>) {
  for (let offset = 0; offset < count; offset += 200) {
    const batch = db.batch();
    for (let i = offset; i < Math.min(offset + 200, count); i++) {
      batch.set(db.collection(collection).doc(String(i).padStart(4, '0')), value);
    }
    await batch.commit();
  }
}

function scan(name: string, collection: string, poison: string[] = [], override?: Record<string, unknown>) {
  return rust.call('maintenance.scan', [name, collection, 'due', 250, 8, poison, override]) as Promise<Page>;
}

test('native maintenance advances past failed rows, shares tied cursors with TypeScript and wraps for retry', { timeout: 60_000 }, async () => {
  const collection = 'nativeMaintenanceFairRows', name = 'native-maintenance-fair';
  const processed = new Set<string>();
  const emit = telemetry.emit, failures: Parameters<typeof telemetry.emit>[0][] = [];
  telemetry.emit = entry => { if (entry.event === 'maintenance_failed') failures.push(entry); };
  try {
    await seed(collection, 501, { due: 0 });
    const first = await scan(name, collection, ['0000']);
    assert.equal(first.count, 250);
    assert.equal(first.processed.length, 249);
    first.processed.forEach(id => processed.add(id));
    assert.equal(failures.length, 1);
    assert.equal(processed.has('0000'), false);
    assert.equal(processed.has('0249'), true);

    // The next runtime must use the same document-ID tiebreaker for equal due times.
    assert.equal(await new MaintenancePages(db).run(name, db.collection(collection), 'due', 250, async id => { processed.add(id); }), 250);
    const third = await scan(name, collection);
    assert.deepEqual(third, { count: 1, processed: ['0500'] });
    third.processed.forEach(id => processed.add(id));
    assert.equal(processed.size, 500);

    const wrapped = await scan(name, collection);
    assert.equal(wrapped.count, 250);
    assert.equal(wrapped.processed.includes('0000'), true);
    wrapped.processed.forEach(id => processed.add(id));
    assert.equal(processed.size, 501);
    assert.deepEqual((await db.collection('maintenancePages').doc(name).get()).data(), { version: 4, id: '0249', value: 0 });
  } finally {
    telemetry.emit = emit;
    await db.recursiveDelete(db.collection(collection));
    await db.collection('maintenancePages').doc(name).delete();
  }
});

test('native scan leaves a concurrently advanced cursor version intact', { timeout: 30_000 }, async () => {
  const collection = 'nativeMaintenanceCursorRace', name = 'native-maintenance-cursor-race';
  const newer = { version: 19, id: 'another-worker', value: 99 };
  try {
    await seed(collection, 3, { due: 0 });
    // The test host writes this competing cursor during the first item handler,
    // after the production scan has captured its starting version.
    const page = await scan(name, collection, [], newer);
    assert.equal(page.count, 3);
    assert.deepEqual(new Set(page.processed), new Set(['0000', '0001', '0002']));
    assert.deepEqual((await db.collection('maintenancePages').doc(name).get()).data(), newer);
  } finally {
    await db.recursiveDelete(db.collection(collection));
    await db.collection('maintenancePages').doc(name).delete();
  }
});

test('native purge shares timestamp cursors with TypeScript and retains unexpired records', { timeout: 60_000 }, async () => {
  const collection = 'nativeMaintenancePurgeRows', cursor = db.collection('maintenancePages').doc(`purge-${collection}`);
  const expired = new Timestamp(Math.floor(now / 1000) - 1, 123_456_000);
  try {
    await seed(collection, 405, { purgeAt: expired });
    await db.collection(collection).doc('unexpired').set({ purgeAt: Timestamp.fromMillis(now + 60_000), retained: true });
    const renewed = db.collection(collection).doc('renewed');
    await renewed.set({ purgeAt: expired });
    await renewed.update({ purgeAt: Timestamp.fromMillis(now + 120_000), retained: true });

    assert.equal(await rust.call('maintenance.purge', [collection, now]), 400);
    const nativeCursor = (await cursor.get()).data()!;
    assert.ok(nativeCursor.value instanceof Timestamp);
    assert.equal(nativeCursor.value.isEqual(expired), true);
    assert.equal(nativeCursor.id, '0399');
    assert.equal((await db.collection(collection).get()).size, 7);

    assert.equal(await new MaintenancePages(db).purge(collection, now), 5);
    const tsCursor = (await cursor.get()).data()!;
    assert.equal(tsCursor.id, '0404');
    assert.equal(tsCursor.value.isEqual(expired), true);

    // An earlier expiry added behind the cursor must be found after wraparound.
    await db.collection(collection).doc('earlier-expiry').set({ purgeAt: Timestamp.fromMillis(now - 60_000) });
    assert.equal(await rust.call('maintenance.purge', [collection, now]), 1);
    assert.equal(await rust.call('maintenance.purge', [collection, now]), 0);
    const survivors = await db.collection(collection).get();
    assert.deepEqual(survivors.docs.map(doc => doc.id).sort(), ['renewed', 'unexpired']);
    assert.ok(survivors.docs.every(doc => doc.data().retained));
    assert.deepEqual((await cursor.get()).data(), { version: 4, id: null });
  } finally {
    await db.recursiveDelete(db.collection(collection));
    await cursor.delete();
  }
});


for (const field of ['due', null]) {
  test(`native maintenance preserves literal marker IDs through ${field ?? 'document ID'} cursor handoff and wrap`, { timeout: 30_000 }, async () => {
    const collection = `nativeMaintenanceMarker${field ?? 'Id'}`;
    const name = `native-maintenance-marker-${field ?? 'id'}-\u{f0000}\ue000`;
    const ids = ['a', 'b', 'c'].map(suffix => `row-\u{f0000}\ue000-${suffix}`);
    const page = () => rust.call('maintenance.scan', [name, collection, field, 1, 1, []]) as Promise<Page>;
    try {
      for (const id of ids) await db.collection(collection).doc(id).set({ due: 0 });
      assert.deepEqual(await page(), { count: 1, processed: [ids[0]] });
      assert.equal((await db.collection('maintenancePages').doc(name).get()).data()?.id, ids[0]);
      const handedOff: string[] = [];
      assert.equal(await new MaintenancePages(db).run(name, db.collection(collection), field, 1, async id => { handedOff.push(id); }), 1);
      assert.deepEqual(handedOff, [ids[1]]);
      assert.deepEqual(await page(), { count: 1, processed: [ids[2]] });
      assert.deepEqual(await page(), { count: 1, processed: [ids[0]] });
      assert.deepEqual((await db.collection('maintenancePages').doc(name).get()).data(), { version: 4, id: ids[0], ...(field ? { value: 0 } : {}) });
    } finally {
      await db.recursiveDelete(db.collection(collection));
      await db.collection('maintenancePages').doc(name).delete();
    }
  });
}

test('native conditional purge retains raw marker document paths and resumes after its persisted cursor', { timeout: 30_000 }, async () => {
  const collection = 'nativeMaintenanceMarkerPurge';
  const cursor = db.collection('maintenancePages').doc(`purge-${collection}`);
  const expired = new Timestamp(Math.floor(now / 1000) - 1, 123_456_000);
  const id = (i: number) => `row-\u{f0000}\ue000-${String(i).padStart(4, '0')}`;
  try {
    for (let offset = 0; offset < 401; offset += 200) {
      const batch = db.batch();
      for (let i = offset; i < Math.min(offset + 200, 401); i++) batch.set(db.collection(collection).doc(id(i)), { purgeAt: expired });
      await batch.commit();
    }
    await db.collection(collection).doc('retained-\u{f0000}\ue000').set({ purgeAt: Timestamp.fromMillis(now + 60_000) });
    assert.equal(await rust.call('maintenance.purge', [collection, now]), 400);
    assert.equal((await cursor.get()).data()?.id, id(399));
    assert.equal((await db.collection(collection).doc(id(400)).get()).exists, true);
    assert.equal(await rust.call('maintenance.purge', [collection, now]), 1);
    assert.equal((await cursor.get()).data()?.id, id(400));
    await db.collection(collection).doc(id(0)).set({ purgeAt: expired });
    assert.equal(await rust.call('maintenance.purge', [collection, now]), 1);
    assert.equal((await cursor.get()).data()?.id, id(0));
    assert.equal(await rust.call('maintenance.purge', [collection, now]), 0);
    assert.deepEqual((await db.collection(collection).get()).docs.map(doc => doc.id), ['retained-\u{f0000}\ue000']);
  } finally {
    await db.recursiveDelete(db.collection(collection));
    await cursor.delete();
  }
});

test('native active-owner maintenance advances and delivers queued SMS for literal marker owner IDs', { timeout: 30_000 }, async () => {
  const uid = 'native-maintenance-owner-\u{f0000}\ue000', device = 'native-maintenance-marker-device';
  const fcm = 'native-maintenance-marker-fcm';
  const sends: string[] = [];
  const writer = new Relay(db, async () => {}, () => now);
  const worker = new RustRelay(db, async token => { sends.push(token); }, () => now);
  try {
    await writer.register(uid, device, 'Phone', fcm);
    const grant = await writer.createGrant(uid, device, 'Maintenance test', 30);
    const first = await writer.create(grant.token, { purpose: 'First request', idempotencyKey: 'marker-first' });
    const queued = await writer.create(grant.token, { purpose: 'Queued request', idempotencyKey: 'marker-queued' });
    assert.equal(queued.status, 'queued');
    await db.collection('requests').doc(first.requestId).update({ status: 'cancelled', notificationSent: true });
    await db.collection('accounts').doc(uid).update({ activeRequestId: null });
    await worker.call('maintenance', []);
    const account = (await db.collection('accounts').doc(uid).get()).data()!;
    const request = (await db.collection('requests').doc(queued.requestId).get()).data()!;
    assert.equal(account.activeRequestId, queued.requestId);
    assert.deepEqual(account.queueIds, []);
    assert.equal(request.status, 'pending_phone');
    assert.equal(request.notificationSent, true);
    assert.equal(sends.filter(token => token === fcm).length, 1);
    // A subsequent scan must read the persisted native cursor without losing
    // this owner or notifying the accepted request again.
    await worker.call('maintenance', []);
    assert.equal(sends.filter(token => token === fcm).length, 1);
  } finally {
    for (const collection of ['devices', 'grants', 'requests', 'audit']) {
      const docs = await db.collection(collection).where('ownerId', '==', uid).get();
      const batch = db.batch(); for (const doc of docs.docs) batch.delete(doc.ref); await batch.commit();
    }
    await db.collection('accounts').doc(uid).delete();
  }
});


test('native deletion shrinks failed transaction pages and resumes cleanup after storage repair', { timeout: 30_000 }, async () => {
  const uid = 'native-delete-shrink-owner', jobId = hash(uid);
  const records = Array.from({ length: 40 }, (_, i) => `native-delete-shrink-${String(i).padStart(3, '0')}`);
  const broken = db.collection('devices').doc(records[30]!);
  let receipt: string | undefined;
  try {
    const batch = db.batch();
    for (const id of records) batch.set(db.collection('devices').doc(id), { ownerId: uid });
    await batch.commit();
    // This deliberately malformed stored domain value makes the native query
    // decoder fail inside the real transaction, without a production test hook.
    await broken.update({ invalidStoredValue: Buffer.from('unsupported domain bytes') });
    receipt = (await rust.call('deletions.request', [uid]) as { receipt: string }).receipt;
    const job = db.collection('deletionJobs').doc(jobId);
    const identity = async () => { assert.fail('identity deletion must follow record cleanup'); };
    const count = async () => (await db.collection('devices').where('ownerId', '==', uid).get()).size;
    assert.equal(await rust.deletions.step(jobId, identity), false);
    assert.equal((await job.get()).data()?.batchSize, 50);
    assert.equal(await count(), 40);
    assert.equal(await rust.deletions.step(jobId, identity), false);
    assert.equal((await job.get()).data()?.batchSize, 25);
    assert.equal(await count(), 40);
    assert.equal(await rust.deletions.step(jobId, identity), true);
    assert.equal((await job.get()).data()?.collectionIndex, 0);
    assert.equal(await count(), 15);
    await broken.update({ invalidStoredValue: FieldValue.delete() });
    let removed = 0;
    await rust.deletions.dispatch(async (owner: string) => {
      if (owner === uid) { assert.equal(await count(), 0); removed++; }
    });
    assert.equal(removed, 1);
    assert.equal((await job.get()).data()?.batchSize, 25);
    assert.deepEqual(await rust.deletions.status(receipt), { status: 'completed' });
  } finally {
    const batch = db.batch();
    for (const id of records) batch.delete(db.collection('devices').doc(id));
    batch.delete(db.collection('accounts').doc(uid));
    batch.delete(db.collection('deletionJobs').doc(jobId));
    if (receipt) batch.delete(db.collection('deletionReceipts').doc(hash(receipt)));
    await batch.commit();
  }
});
