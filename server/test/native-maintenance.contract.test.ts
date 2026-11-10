import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { MaintenancePages } from '../src/maintenance-pages.js';
import { telemetry } from '../src/telemetry.js';
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
