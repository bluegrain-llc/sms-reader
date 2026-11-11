import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompactEncrypt, importJWK } from 'jose';
import { RelayClient, deliveryKey, credential } from '../client.mjs';
import { PrivateStore } from '../store.mjs';
test('private durable storage refuses world-readable files and symlinks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-store-')); await chmod(directory, 0o700);
  try {
    const store = new PrivateStore(directory), value = { token: credential('smss') }; const unlock = await store.lock();
    await store.write(value); assert.deepEqual(await store.read(), value); assert.equal((await stat(store.path)).mode & 0o777, 0o600); await unlock();
    await chmod(store.path, 0o644); await assert.rejects(store.read()); await chmod(store.path, 0o600);
    const other = new PrivateStore(directory, 'other'); await symlink(store.path, other.path); await assert.rejects(other.read());
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('delivery is persisted before acknowledgement, with safe retry after storage failure', async () => {
  const key = await deliveryKey(); const token = credential('smsr');
  const payload = { version: 1, serviceId: 'service', connectionId: 'connection', deliveryId: 'delivery', token, externalAccountRef: null };
  const envelope = await new CompactEncrypt(Buffer.from(JSON.stringify(payload))).setProtectedHeader({ alg: 'ECDH-ES', enc: 'A256GCM', kid: key.id, serviceId: 'service', connectionId: 'connection', deliveryId: 'delivery' }).encrypt(await importJWK(key.publicKey, 'ECDH-ES'));
  let saved = false, acks = 0;
  const fetcher = async (url) => {
    if (url.endsWith('/acknowledgement')) { assert.equal(saved, true); acks++; return Response.json({ ok: true }); }
    return Response.json({ deliveries: [{ deliveryId: 'delivery', connectionId: 'connection', keyId: key.id, envelope }] });
  };
  const client = new RelayClient('https://relay.example', { fetch: fetcher }), state = { serviceId: 'service', serviceToken: credential('smss'), keys: [key], connections: {} };
  await assert.rejects(client.consume(state, async () => { throw Error('disk full'); })); assert.equal(acks, 0);
  await client.consume(state, async () => { saved = true; }); assert.equal(acks, 1); assert.equal(state.connections.connection.token, token);
  await client.consume(state, async () => {}); assert.equal(acks, 2); assert.equal(Object.keys(state.connections).length, 1);
  state.serviceId = 'other-service'; await assert.rejects(client.consume(state, async () => {}));
});
test('credentials cannot be redirected or sent to URLs with credentials or queries', () => {
  for (const url of ['http://relay.example', 'https://user:secret@relay.example', 'https://relay.example/path', 'https://relay.example?token=secret']) assert.throws(() => new RelayClient(url));
  assert.throws(() => new RelayClient('http://127.0.0.1:8080'));
  assert.doesNotThrow(() => new RelayClient('http://127.0.0.1:8080', { allowHttpLoopback: true }));
});
