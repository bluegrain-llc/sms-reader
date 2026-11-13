import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import type { Firestore } from 'firebase-admin/firestore';
import { app } from '../src/http.js';
import { Relay } from '../src/relay.js';
import { RecoveryGate } from '../src/recovery-gate.js';

test('HTTP startup waits for the authoritative recovery watch while liveness stays available', async () => {
  let snapshot: (doc: { data: () => unknown }) => void = () => {};
  let fail: () => void = () => {};
  const db = { collection: () => ({ doc: () => ({ get: async () => ({}),
    onSnapshot: (next: typeof snapshot, error: typeof fail) => { snapshot = next; fail = error; return () => {}; },
  }) }) } as unknown as Firestore;
  const gate = new RecoveryGate(db);
  let authCalls = 0;
  const server = app(new Relay(db, async () => {}), {
    assertServing: () => gate.assertServing(),
    verifyOwner: async () => { authCalls++; throw Error('authentication must not run for probes'); },
    verifyScheduler: async () => { throw Error('worker authentication must not run for probes'); },
    deleteIdentity: async () => { throw Error('identity deletion must not run for probes'); },
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const check = async (path: string, status: number, ok: boolean) => {
    const response = await fetch(origin + path);
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { ok });
    assert.equal(response.headers.get('cache-control'), 'no-store');
  };
  try {
    await setImmediate(); // Install the watch without delivering its initial snapshot.
    await check('/health', 200, true);
    await check('/healthz', 200, true);
    await check('/startup', 503, false);
    assert.equal((await fetch(origin + '/v1/devices', { headers: { authorization: 'Bearer synthetic' } })).status, 503);
    snapshot({ data: () => undefined });
    await check('/startup', 200, true);
    snapshot({ data: () => ({ blocked: true }) });
    await check('/startup', 503, false);
    await check('/health', 200, true);
    snapshot({ data: () => ({ blocked: false }) });
    await check('/startup', 200, true);
    fail();
    await check('/startup', 503, false);
    gate.close(); snapshot({ data: () => ({ blocked: false }) });
    await check('/startup', 503, false);
    assert.equal(authCalls, 0);
  } finally {
    gate.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
