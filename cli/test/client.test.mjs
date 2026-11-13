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
    try { await store.write(value); assert.deepEqual(await store.read(), value); assert.equal((await stat(store.path)).mode & 0o777, 0o600); }
    finally { await unlock(); }
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

test('interrupted key rotation resumes its durable retirement intent', async () => {
  const {ServiceSession} = await import('../service.mjs');
  let saved, fail = true;
  const storage = {load:async()=>structuredClone(saved),save:async s=>{saved=structuredClone(s);}};
  const fetcher = async (_url, request) => {
    const body=JSON.parse(request.body);
    assert.equal(body.retireKeyId,'compromised-key');assert.equal(saved.nextRetireKeyId,'compromised-key');
    if(fail)throw Error('offline');
    return Response.json({ok:true});
  };
  const service=await ServiceSession.create({baseUrl:'https://relay.example',name:'Agent',purpose:'Decisions'},storage,{fetch:fetcher});
  service.client.request=async(_path,_token,body)=>{assert.equal(body.retireKeyId,'compromised-key');assert.equal(saved.nextRetireKeyId,'compromised-key');throw Error('interrupted');};
  await assert.rejects(service.rotateKey('compromised-key'));
  assert.ok(saved.nextKey);fail=false;
  const resumed=await ServiceSession.resume(storage,{fetch:fetcher});
  await resumed.rotateKey();assert.equal(saved.nextKey,undefined);assert.equal(saved.nextRetireKeyId,undefined);assert.equal(saved.keys.length,2);
});

test('private command storage hides failures and round trips through a durable hook', async () => {
  const {CommandStore} = await import('../command-store.mjs');
  const directory=await mkdtemp(join(tmpdir(),'relay-hook-'));
  const {writeFile} = await import('node:fs/promises');
  const command=join(directory,'hook.mjs');
  await writeFile(command,`#!/usr/bin/env node\nimport fs from 'node:fs';\nlet text='';for await(const c of process.stdin)text+=c;const r=JSON.parse(text),path=${JSON.stringify(join(directory,'state'))};if(r.operation==='save'){fs.writeFileSync(path,JSON.stringify(r.state),{mode:0o600});console.log('{"ok":true}');}else console.log(JSON.stringify({ok:true,state:fs.existsSync(path)?JSON.parse(fs.readFileSync(path,'utf8')):null}));`,{mode:0o700});
  const store=new CommandStore(command,directory,'hook');
  try {assert.equal(await store.load(),null);const state={token:credential('smss')};await store.save(state);assert.deepEqual(await store.load(),state);await writeFile(command,'#!/bin/sh\necho private-secret\nexit 1\n');await assert.rejects(store.load(),e=>e.message==='storage_hook_failed');}
  finally {await rm(directory,{recursive:true,force:true});}
});

test('CLI resumes shared pairing and credential transitions after interrupted persistence boundaries', async t => {
  const {main} = await import('../relay.mjs');
  const directory = await mkdtemp(join(tmpdir(), 'relay-cli-resume-'));
  const store = new PrivateStore(directory), output = [];
  t.mock.method(console, 'log', (...values) => output.push(values.join(' ')));
  let failDelivery = false, rotatedToken, pairingKey;
  t.mock.method(globalThis, 'fetch', async (url, request) => {
    const path = new URL(url).pathname, saved = await store.read();
    const body = request.body && JSON.parse(request.body);
    if (path === '/v3/registration-sessions') {
      assert.ok(saved.registrationToken); assert.ok(saved.keys[0].privateKey);
      return Response.json({status:'pending',registrationPath:'/register/public-session'});
    }
    if (path === '/v3/registration-sessions/current') return Response.json({status:'approved',serviceId:'service',servicePath:'/services/service'});
    if (path === '/v3/service/pairing-sessions') {
      assert.equal(saved.pairingInput.idempotencyKey, body.idempotencyKey);
      if (pairingKey) assert.equal(body.idempotencyKey, pairingKey);
      pairingKey = body.idempotencyKey;
      return Response.json({sessionId:'pairing',comparisonCode:'123456',connectionPath:'/connect/public-session'});
    }
    if (path === '/v3/service/pairing-sessions/pairing') return Response.json({status:'approved',connectionId:'connection'});
    if (path === '/v3/service' && request.method === 'PATCH') {
      assert.ok(saved.nextServiceToken);
      if (!rotatedToken) {
        rotatedToken = saved.nextServiceToken;
        return Response.json({error:'interrupted_after_rotation'}, {status:400});
      }
      return Response.json({error:'invalid_token'}, {status:401});
    }
    assert.equal(path, '/v3/service/deliveries'); assert.equal(saved.registered, true);
    if (rotatedToken) assert.equal(request.headers.Authorization, `Bearer ${rotatedToken}`);
    if (failDelivery) return Response.json({error:'interrupted_before_delivery'}, {status:400});
    return Response.json({deliveries:[],hasMore:false});
  });
  const run = (...args) => main([...args, '--store', directory, '--no-open']);
  try {
    await run('service', 'register', '--name', 'Agent', '--relay', 'https://relay.example');
    failDelivery = true;
    await assert.rejects(run('service', 'connect'), /interrupted_before_delivery/);
    assert.equal((await store.read()).pairingInput.idempotencyKey, pairingKey);
    failDelivery = false;
    await run('resume'); assert.equal((await store.read()).pairingInput, null);
    await assert.rejects(run('service', 'rotate-credential'), /interrupted_after_rotation/);
    assert.equal((await store.read()).nextServiceToken, rotatedToken);
    await run('resume');
    const saved = await store.read();
    assert.equal(saved.serviceToken, rotatedToken); assert.equal(saved.nextServiceToken, undefined);
    assert.ok(output.some(line => line.includes('Connection connection')));
    for (const secret of [saved.serviceToken, saved.registrationToken, JSON.stringify(saved.keys[0].privateKey)]) assert.ok(!output.join('\n').includes(secret));
  } finally { await rm(directory, {recursive:true,force:true}); }
});


test('broker retains approved pairing until its credential survives a delivery backlog', { timeout: 20000 }, async () => {
  const { createServer } = await import('node:http');
  const { execFile } = await import('node:child_process');
  const directory = await mkdtemp(join(tmpdir(), 'relay-broker-backlog-'));
  const key = await deliveryKey(), token = credential('smsr');
  const payload = { version: 1, serviceId: 'service', connectionId: 'target', deliveryId: 'target-delivery', token };
  const envelope = await new CompactEncrypt(Buffer.from(JSON.stringify(payload))).setProtectedHeader({ alg: 'ECDH-ES', enc: 'A256GCM', kid: key.id, serviceId: 'service', connectionId: 'target', deliveryId: 'target-delivery' }).encrypt(await importJWK(key.publicKey, 'ECDH-ES'));
  let pages = 0, acknowledged = false;
  const server = createServer((request, response) => {
    let value;
    if (request.url === '/v3/service/pairing-sessions/pairing') value = { status: 'approved', connectionId: 'target' };
    else if (request.url === '/v3/service/deliveries/target-delivery/acknowledgement') { acknowledged = true; value = { ok: true }; }
    else if (request.url === '/v3/service/deliveries') {
      pages++;
      // A full page of invalidated deliveries is discarded by the relay before returning this empty page.
      value = pages <= 10 ? { deliveries: [], hasMore: true } : { deliveries: [{ deliveryId: 'target-delivery', connectionId: 'target', keyId: key.id, envelope }], hasMore: false };
    } else { response.writeHead(404); response.end('{}'); return; }
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value));
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const store = new PrivateStore(directory);
    await store.write({ version: 1, baseUrl: `http://127.0.0.1:${server.address().port}`, registered: true, serviceId: 'service', serviceToken: credential('smss'), keys: [key], connections: {}, pairing: { sessionId: 'pairing' }, pairingInput: { idempotencyKey: 'same-pairing' } });
    const poll = () => new Promise((resolve, reject) => {
      const child = execFile(process.execPath, [new URL('../broker.mjs', import.meta.url).pathname], { timeout: 10000 }, (error, stdout) => error ? reject(error) : resolve(JSON.parse(stdout)));
      child.stdin.end(JSON.stringify({ operation: 'pollPairing', directory, allowHttpLoopback: true }));
    });
    assert.equal((await poll()).value.status, 'approved');
    let saved = await store.read();
    assert.equal(pages, 10); assert.equal(saved.connections.target, undefined); assert.equal(acknowledged, false);
    assert.equal(saved.pairing.sessionId, 'pairing'); assert.equal(saved.pairingInput.idempotencyKey, 'same-pairing');
    assert.equal((await poll()).value.status, 'approved');
    saved = await store.read();
    assert.equal(saved.connections.target.token, token); assert.equal(acknowledged, true);
    assert.equal(saved.pairing, null); assert.equal(saved.pairingInput, null);
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
