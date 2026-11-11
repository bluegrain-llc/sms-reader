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
