import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import type { Firestore } from 'firebase-admin/firestore';
import { RecoveryGate } from '../src/recovery-gate.js';
import { telemetry, type RecoveryGatePhase } from '../src/telemetry.js';

function source(get: () => Promise<unknown> = async () => ({}), setup = () => {}) {
  let snapshot: (doc: { data: () => unknown }) => void = () => {};
  let error: (error?: unknown) => void = () => {};
  let watches = 0, stops = 0;
  const db = { collection: () => ({ doc: () => ({ get,
    onSnapshot: (next: typeof snapshot, failed: typeof error) => {
      setup();
      watches++; snapshot = next; error = failed; return () => { stops++; };
    } }) }) } as unknown as Firestore;
  return { db, emit: (blocked?: boolean) => snapshot({ data: () => blocked === undefined ? undefined : { blocked } }),
    fail: (value?: unknown) => error(value), watches: () => watches, stops: () => stops };
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

for (const phase of ['credential', 'initial_read', 'watch_setup', 'watch'] as const satisfies readonly RecoveryGatePhase[]) {
  test(`recovery failure identifies ${phase} and keeps startup closed without logging the error`, async t => {
    const records: unknown[] = [];
    t.mock.method(telemetry, 'emit', (entry: Parameters<typeof telemetry.emit>[0]) => { records.push(entry); });
    const secret = 'private-owner Bearer private-access-token private-document';
    const error = Object.assign(new Error(secret), { code: 7, cause: { token: secret }, metadata: { authorization: secret },
      toJSON: () => { throw Error('raw error must never be serialized'); } });
    let reads = 0;
    const s = source(async () => { reads++; if (phase === 'initial_read') throw error; },
      () => { if (phase === 'watch_setup') throw error; });
    const gate = new RecoveryGate(s.db, async () => { if (phase === 'credential') throw error; });
    await setImmediate();
    if (phase === 'watch') { s.emit(false); gate.assertServing(); s.fail(error); }
    assert.throws(() => gate.assertServing(), /recovery_in_progress/);
    assert.equal(reads, phase === 'credential' ? 0 : 1);
    assert.equal(s.watches(), phase === 'watch' ? 1 : 0);
    assert.deepEqual(records, [{ event: 'recovery_gate_unavailable', phase, category: 'internal', error_code: 7 }]);
    assert.ok(!JSON.stringify(records).includes(secret));
    gate.close();
    assert.equal(s.stops(), phase === 'watch' ? 1 : 0);
    s.emit(false); assert.throws(() => gate.assertServing(), /recovery_in_progress/);
  });
}

test('a diagnostic sink failure cannot reopen serving or reject startup handling', async t => {
  t.mock.method(console, 'info', () => { throw Error('synthetic logging failure'); });
  const s = source(), gate = new RecoveryGate(s.db, async () => { throw { code: '14' }; });
  await setImmediate();
  assert.equal(s.watches(), 0);
  assert.throws(() => gate.assertServing(), /recovery_in_progress/);
  gate.close();
});
