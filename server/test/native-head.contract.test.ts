import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingHttpHeaders } from 'node:http';
import { createConnection } from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import type { Relay } from '../src/relay.js';
import { hash, MINUTE } from '../src/model.js';
import { RustRelay, rustApp } from './rust-adapter.js';

if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) throw Error('Native HEAD contracts require emulators');
const firebase = initializeApp({ projectId: 'demo-sms-relay' }, 'native-head-contract');
const db = getFirestore(firebase);
after(async () => { await deleteApp(firebase); });

test('native HEAD SSE releases its lease, charges read budgets and preserves the same TCP connection', { timeout: 20_000 }, async t => {
  const cleared = await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-sms-relay/databases/(default)/documents`, { method: 'DELETE', signal: AbortSignal.timeout(10_000) });
  assert.equal(cleared.status, 200);
  const time = 1_800_000_000_000, uid = 'head-owner', did = 'head-device';
  const relay = new RustRelay(db, async () => {}, () => time) as unknown as Relay;
  await relay.register(uid, did, 'Phone', 'synthetic-fcm');
  const grant = await relay.createGrant(uid, did, 'Caller', 30);
  await relay.forms.approve(uid, grant.grantId, true);
  const server = rustApp(relay, { verifyOwner: async () => ({ uid, authTime: time / 1000 }), verifyScheduler: async () => {}, deleteIdentity: async () => {}, sseDurationMs: 60_000 }).listen();
  // Keep one raw socket throughout: a client pool must not close or replace it
  // based on its own policy for HEAD responses without body framing headers.
  let socket: ReturnType<typeof createConnection> | undefined;
  let wire = Buffer.alloc(0), terminal: Error | undefined;
  let changed: (() => void) | undefined;
  const send = async (method: string, path: string, authorization?: string) => {
    assert.ok(socket && !socket.destroyed, 'the original TCP socket must remain connected');
    socket.write(`${method} ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n${authorization ? `Authorization: ${authorization}\r\n` : ''}\r\n`);
    const header = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(Error('Native HEAD TCP response timed out')); }, 5000);
      const cleanup = () => { clearTimeout(timer); changed = undefined; };
      const inspect = () => {
        const end = wire.indexOf('\r\n\r\n');
        if (end >= 0) {
          const header = wire.subarray(0, end).toString('latin1');
          wire = wire.subarray(end + 4); cleanup(); resolve(header);
        } else if (terminal) { cleanup(); reject(terminal); }
      };
      changed = inspect; inspect();
    });
    const [statusLine, ...fields] = header.split('\r\n');
    assert.match(statusLine!, /^HTTP\/1\.1 \d{3} /);
    const headers: IncomingHttpHeaders = {};
    for (const field of fields) {
      const colon = field.indexOf(':');
      assert.ok(colon > 0);
      headers[field.slice(0, colon).toLowerCase()] = field.slice(colon + 1).trim();
    }
    return { status: Number(statusLine!.split(' ')[1]), headers };
  };
  try {
    await once(server, 'listening');
    socket = createConnection({ host: '127.0.0.1', port: server.address().port });
    socket.on('data', chunk => { wire = Buffer.concat([wire, chunk]); changed?.(); });
    socket.on('error', error => { terminal = error; changed?.(); });
    socket.on('close', () => { terminal ??= Error('Original native HEAD TCP socket closed'); changed?.(); });
    socket.setTimeout(5000, () => socket!.destroy(Error('Native HEAD TCP connection timed out')));
    await once(socket, 'connect');
    const originalSocket = socket;
    const denied = await send('HEAD', '/v2/events/stream');
    assert.equal(denied.status, 401); assert.equal(wire.length, 0);
    assert.equal((await db.collection('accessRates').get()).size, 0);
    const head = await send('HEAD', '/v2/events/stream', `Bearer ${grant.token}`);
    assert.equal(head.status, 200); assert.equal(wire.length, 0);
    assert.match(String(head.headers['content-type']), /^text\/event-stream/);
    assert.equal(head.headers['cache-control'], 'no-cache, no-store');
    assert.equal(head.headers['x-accel-buffering'], 'no');
    for (const scope of [`owner:${uid}`, `grant:${grant.grantId}`]) {
      assert.equal((await db.collection('accessRates').doc(hash(`${scope}:${Math.floor(time / MINUTE)}`)).get()).data()?.count, 1);
    }
    const scopes = [`owner:${uid}`, `grant:${grant.grantId}`].map(scope => db.collection('streamLimits').doc(hash(scope)));
    let released = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const limits = await db.getAll(...scopes);
      released = limits.every(limit => limit.exists && Object.keys(limit.data()!.leases).length === 0);
      if (released) break;
      await delay(20, undefined, { signal: t.signal });
    }
    assert.ok(released, 'HEAD must release both shared stream admissions before its 60s deadline');
    await delay(1250, undefined, { signal: t.signal });
    assert.equal(socket, originalSocket);
    assert.ok(!originalSocket.destroyed, 'HEAD must preserve the actual original TCP socket past its grace period');
    assert.equal(wire.length, 0, 'HEAD must not leak SSE frames or chunk framing before the next response');
    const next = await send('GET', '/health');
    assert.equal(next.status, 200);
    assert.equal(socket, originalSocket, 'the health request must use the same original socket without reconnecting');
    assert.ok(!originalSocket.destroyed);
  } finally {
    socket?.destroy(); server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
