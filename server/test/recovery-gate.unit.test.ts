import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import type { Firestore } from 'firebase-admin/firestore';
import { RecoveryGate } from '../src/recovery-gate.js';

function source(get: () => Promise<unknown> = async () => ({})) {
  let snapshot: (doc: { data: () => unknown }) => void = () => {};
  let error: () => void = () => {};
  let watches = 0, stops = 0;
  const db = { collection: () => ({ doc: () => ({ get,
    onSnapshot: (next: typeof snapshot, failed: typeof error) => {
      watches++; snapshot = next; error = failed; return () => { stops++; };
    } }) }) } as unknown as Firestore;
  return { db, emit: (blocked?: boolean) => snapshot({ data: () => blocked === undefined ? undefined : { blocked } }),
    fail: () => error(), watches: () => watches, stops: () => stops };
}
test('recovery gate waits for the initialized watch and closes on watch errors', async () => {
  const s = source(), gate = new RecoveryGate(s.db);
  assert.throws(() => gate.assertServing(), /recovery_in_progress/);
  await setImmediate();
  assert.equal(s.watches(), 1);
  assert.throws(() => gate.assertServing(), /recovery_in_progress/);
  s.emit(); gate.assertServing();
  s.emit(true); assert.throws(() => gate.assertServing(), /recovery_in_progress/);
  s.emit(false); gate.assertServing();
  s.fail(); assert.throws(() => gate.assertServing(), /recovery_in_progress/);
  gate.close(); assert.equal(s.stops(), 1);
  s.emit(false); assert.throws(() => gate.assertServing(), /recovery_in_progress/);
});
test('credential initialization errors are handled and keep serving blocked', async () => {
  let reads = 0;
  const s = source(async () => { reads++; }), gate = new RecoveryGate(s.db, async () => { throw Error('synthetic missing credentials'); });
  await setImmediate();
  assert.equal(reads, 0);
  assert.equal(s.watches(), 0);
  assert.throws(() => gate.assertServing(), /recovery_in_progress/);
  gate.close();
});
test('closing during initialization cannot start or reopen the watch', async () => {
  let initialized: () => void = () => {};
  const s = source(() => new Promise<void>(resolve => { initialized = resolve; })), gate = new RecoveryGate(s.db);
  await setImmediate(); gate.close(); initialized(); await setImmediate();
  assert.equal(s.watches(), 0);
  assert.throws(() => gate.assertServing(), /recovery_in_progress/);
});
