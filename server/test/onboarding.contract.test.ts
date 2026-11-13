import { after, before, test } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { compactDecrypt, exportJWK, generateKeyPair, importJWK } from 'jose';
import { Relay } from '../src/relay.js';
import { app } from '../src/http.js';
import { RustRelay, rustApp } from './rust-adapter.js';
import { hash, HISTORY, MINUTE } from '../src/model.js';
import type { HttpOptions } from '../src/http.js';
import type { Server } from 'node:http';
import { capabilityTools, hostedProviderConfig } from '../../integrations/providers.mjs';
import { OAuth } from '../src/oauth.js';

if (!process.env.FIRESTORE_EMULATOR_HOST) throw Error('Onboarding contracts require the Firestore emulator');
process.env.OAUTH_CODE_KEY = '64'.repeat(32); // Isolated contract key, never used for deployment.
const firebase = initializeApp({ projectId: 'demo-sms-relay' }, 'onboarding-contract'), db = getFirestore(firebase);
let time = 1_800_000_000_000;
const uid = 'onboarding-operator', recipient = 'onboarding-recipient';
const secrets = (prefix: string) => `${prefix}_${randomBytes(32).toString('base64url')}`;
const relay = new Relay(db, async () => {}, () => time), native = new RustRelay(db, async () => {}, () => time);
const options: HttpOptions = { verifyOwner: async t => { assert.ok(t.startsWith('owner:') || t.startsWith('owner64:')); return { uid: t.startsWith('owner64:') ? Buffer.from(t.slice(8),'base64url').toString('utf8') : t.slice(6), authTime: time / 1000 }; }, verifyScheduler: async () => {}, deleteIdentity: async () => {}, publicUrl: 'https://relay.example', firebaseWebConfig: { apiKey: 'public', authDomain: 'demo-sms-relay.firebaseapp.com', projectId: 'demo-sms-relay', appId: 'public' } };
let servers: Server[] = [], bases: string[] = [];
const contractFetch: typeof fetch = (input, init) => fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000) });
async function call(runtime: number, path: string, token: string, body?: unknown, method = body === undefined ? 'GET' : 'POST', expected = 200) {
  const response = await contractFetch(bases[runtime] + path, { method, headers: { Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json(); assert.equal(response.status, expected, JSON.stringify(result)); return result;
}
const owner = (uid: string) => /^[\x20-\x7e]+$/.test(uid) ? `owner:${uid}` : `owner64:${Buffer.from(uid).toString('base64url')}`;
const decision = (selfAccess = false, capabilities = ['forms']) => ({ decision: 'approved', selfAccess, capabilities, expiresInDays: null });
async function register(runtime = 0, self = false, capabilities = ['forms']) {
  const pair = await generateKeyPair('ECDH-ES', { crv: 'P-256', extractable: true });
  const publicKey = await exportJWK(pair.publicKey), privateKey = await exportJWK(pair.privateKey);
  const credential = secrets('smss'), pending = secrets('smsreg');
  const input = { name: 'Personal agent', purpose: 'Ask for decisions', deliveryPublicKey: publicKey, credentialHash: hash(credential), capabilities };
  const session = await call(runtime, '/v3/registration-sessions', pending, input, 'POST', 201);
  const approved = await call(1 - runtime, `/v3/registration-sessions/${session.sessionId}/decision`, owner(uid), decision(self, capabilities));
  return { credential, pending, publicKey, privateKey, session, approved, input };
}
async function connect(s: Awaited<ReturnType<typeof register>>, runtime = 0, capabilities = ['forms'], externalAccountRef?: string) {
  const p = await call(runtime, '/v3/service/pairing-sessions', s.credential, { capabilities, expiresInDays: null, idempotencyKey: randomUUID(), ...(externalAccountRef ? { externalAccountRef } : {}) }, 'POST', 201);
  const approved = await call(1 - runtime, `/v3/pairing-sessions/${p.sessionId}/decision`, owner(recipient), { decision: 'approved', capabilities, expiresInDays: null });
  return { p, approved };
}
async function consume(s: Awaited<ReturnType<typeof register>>, runtime = 0) {
  const page = await call(runtime, '/v3/service/deliveries', s.credential);
  const d = page.deliveries[0]; assert.ok(d);
  const { plaintext, protectedHeader } = await compactDecrypt(d.envelope, await importJWK(s.privateKey, 'ECDH-ES'), { keyManagementAlgorithms: ['ECDH-ES'], contentEncryptionAlgorithms: ['A256GCM'] });
  const payload = JSON.parse(Buffer.from(plaintext).toString());
  assert.equal(protectedHeader.serviceId, s.session.serviceId); assert.equal(protectedHeader.connectionId, d.connectionId); assert.equal(protectedHeader.deliveryId, d.deliveryId);
  assert.equal(payload.connectionId, d.connectionId); assert.equal(payload.deliveryId, d.deliveryId);
  return { d, payload };
}
before(async () => {
  for (const c of ['accounts', 'devices', 'grants', 'services', 'serviceCredentials', 'serviceDeliveryKeys', 'registrationSessions', 'pairingSessions', 'serviceConnections', 'connectionBindings', 'credentialDeliveries', 'onboardingRates', 'oauthClients', 'oauthSessions', 'oauthCodes', 'oauthBindings', 'oauthFamilies', 'oauthAccess', 'oauthRefresh', 'oauthCleanup', 'oauthGrantCleanup']) await db.recursiveDelete(db.collection(c));
  servers = [app(relay, options).listen(0, '127.0.0.1'), rustApp(native as unknown as Relay, options).listen() as unknown as Server];
  for (const server of servers) { if (!server.listening) await once(server, 'listening', {signal:AbortSignal.timeout(10000)}); bases.push(`http://127.0.0.1:${(server.address() as { port: number }).port}`); }
});
after(async () => { for (const s of servers) { s.closeAllConnections(); await new Promise<void>(resolve => s.close(() => resolve())); } await deleteApp(firebase); });
test('contract HTTP deadline aborts an unfinished response body', {timeout:15000}, async () => {
  const stalled = createServer((_request, response) => { response.writeHead(200, {'Content-Type':'application/json'}); response.write('{'); });
  stalled.listen(0, '127.0.0.1');
  try {
    await once(stalled, 'listening', {signal:AbortSignal.timeout(1000)});
    const base = `http://127.0.0.1:${(stalled.address() as {port:number}).port}`;
    await assert.rejects(async () => (await contractFetch(base)).json(), (error: Error) => ['AbortError','TimeoutError'].includes(error.name));
  } finally { stalled.closeAllConnections(); await new Promise<void>(resolve => stalled.close(() => resolve())); }
});
for (const runtime of [0, 1]) {
  test(`runtime ${runtime}: approved registration recovers after session retention without new consent or duplicate service`, async () => {
    for (const self of [false, true]) {
      const s = await register(runtime, self);
      time += HISTORY + 1;
      if (runtime === 0) await relay.onboarding.cleanup(); else await native.call('onboarding.cleanup', []);
      assert.equal((await db.collection('registrationSessions').doc(s.session.sessionId).get()).exists, false);
      await call(runtime, '/v3/registration-sessions', secrets('smsreg'), s.input, 'POST', 409);
      const recovered = await call(runtime, '/v3/registration-sessions', s.pending, s.input, 'POST', 201);
      assert.equal(recovered.status, 'approved'); assert.equal(recovered.serviceId, s.session.serviceId);
      assert.equal(recovered.connectionId, s.approved.connectionId);
      assert.equal((await call(1-runtime, '/v3/registration-sessions/current', s.pending)).serviceId, s.session.serviceId);
      await call(runtime, '/v3/registration-sessions', s.pending, {...s.input,name:'Changed'}, 'POST', 409);
      await db.collection('registrationSessions').doc(s.session.sessionId).delete();
      await call(runtime, `/v3/services/${s.session.serviceId}`, owner(uid), {active:false}, 'PATCH');
      await call(1-runtime, '/v3/registration-sessions', s.pending, s.input, 'POST', 404);
    }
  });
  test(`runtime ${runtime}: registration without receiving phone or self access; idempotent approval and private payloads`, async () => {
    const s = await register(runtime);
    assert.equal(s.approved.status, 'approved'); assert.equal(s.approved.connectionId, null);
    const view = await call(runtime, `/v3/registration-sessions/${s.session.sessionId}`, owner(uid));
    for (const hidden of [uid, 'credentialHash', 'deliveryPublicKey', 'ownerId', s.credential]) assert.ok(!JSON.stringify(view).includes(hidden));
    assert.equal((await call(runtime, `/v3/registration-sessions/${s.session.sessionId}/decision`, owner(uid), decision())).serviceId, s.session.serviceId);
    assert.equal((await call(runtime, '/v3/service/deliveries', s.credential)).deliveries.length, 0);
    await call(runtime, '/v1/requests', s.credential, { purpose: 'No access', idempotencyKey: randomUUID() }, 'POST', 401);
    await call(runtime, '/v3/registration-sessions/current', s.pending);
    await call(runtime, '/v3/registration-sessions/current', s.pending, undefined, 'GET', 429);
    time += 5001;
  });
  test(`runtime ${runtime}: owner access is atomic and offline credential delivery interoperates`, async () => {
    const s = await register(runtime, true);
    assert.ok(s.approved.connectionId);
    const { d, payload } = await consume(s, runtime);
    const status = await call(runtime, '/v3/connection', payload.token);
    assert.equal(status.expiresAt, null); assert.equal(status.setup, 'phone_setup_needed');
    const repeat = await call(1 - runtime, '/v3/service/deliveries', s.credential);
    assert.equal(repeat.deliveries[0].envelope, d.envelope);
    await call(1 - runtime, `/v3/service/deliveries/${d.deliveryId}/acknowledgement`, s.credential, {});
    await call(runtime, `/v3/service/deliveries/${d.deliveryId}/acknowledgement`, s.credential, {});
    assert.equal((await call(runtime, '/v3/service/deliveries', s.credential)).deliveries.length, 0);
    await call(runtime, '/v1/requests', payload.token, { purpose: 'SMS blocked', idempotencyKey: randomUUID() }, 'POST', 403);
  });
  test(`runtime ${runtime}: racing scans reuse grants, narrowed permissions and no cross-connection results`, async () => {
    const s = await register(runtime, false, ['forms', 'sms']);
    const input = { capabilities: ['forms', 'sms'], expiresInDays: null, idempotencyKey: randomUUID() };
    const p = await call(runtime, '/v3/service/pairing-sessions', s.credential, input, 'POST', 201);
    const review = await call(1 - runtime, `/v3/pairing-sessions/${p.sessionId}`, owner(recipient));
    assert.ok(review.comparisonCode); assert.ok(!JSON.stringify(review).includes(uid));
    const body = { decision: 'approved', capabilities: ['forms'], expiresInDays: null };
    const decisions = await Promise.all([0, 1].map(i => call(i, `/v3/pairing-sessions/${p.sessionId}/decision`, owner(recipient), body)));
    assert.equal(decisions[0].connectionId, decisions[1].connectionId);
    const second = await connect(s, runtime, ['forms']); assert.equal(second.approved.connectionId, decisions[0].connectionId);
    const { payload } = await consume(s, runtime);
    assert.deepEqual((await call(runtime, '/v3/connection', payload.token)).capabilities, ['forms']);
    await call(runtime, '/v1/requests', payload.token, { purpose: 'Blocked', idempotencyKey: randomUUID() }, 'POST', 403);
    await call(runtime, `/v3/pairing-sessions/${p.sessionId}`, owner('another-recipient'), undefined, 'GET', 404);
    const other = await register(runtime);
    await call(runtime, `/v3/service/connections/${decisions[0].connectionId}`, other.credential, undefined, 'GET', 404);
  });
  test(`runtime ${runtime}: permanent links bind the signed-in recipient and cannot choose external accounts`, async () => {
    const s = await register(runtime);
    const path = `/v3/services/${s.session.serviceId}/connections`, input = { capabilities: ['forms'], idempotencyKey: randomUUID() };
    await call(runtime, path, owner(recipient), { ...input, externalAccountRef: randomUUID() }, 'POST', 400);
    const p = await call(runtime, path, owner(recipient), input, 'POST', 201);
    assert.equal(p.comparisonCode, null);
    await call(1 - runtime, `/v3/pairing-sessions/${p.sessionId}/decision`, owner(uid), { decision: 'approved', capabilities: ['forms'], expiresInDays: null }, 'POST', 404);
    time += 10 * MINUTE + 1;
    await call(runtime, `/v3/pairing-sessions/${p.sessionId}/decision`, owner(recipient), { decision: 'approved', capabilities: ['forms'], expiresInDays: null }, 'POST', 410);
  });
  test(`runtime ${runtime}: rotation retains outstanding envelopes; retirement and delivery expiry invalidate grants`, async () => {
    const s = await register(runtime, true), { d, payload } = await consume(s, runtime);
    const nextKey = await generateKeyPair('ECDH-ES', { crv: 'P-256', extractable: true });
    const nextCredential = secrets('smss');
    await call(runtime, '/v3/service', s.credential, { credentialHash: hash(nextCredential), deliveryPublicKey: await exportJWK(nextKey.publicKey) }, 'PATCH');
    await call(runtime, '/v3/service/deliveries', s.credential, undefined, 'GET', 401);
    assert.equal((await call(1 - runtime, '/v3/service/deliveries', nextCredential)).deliveries[0].envelope, d.envelope);
    await call(1 - runtime, '/v3/service', nextCredential, { retireKeyId: d.keyId }, 'PATCH');
    await call(runtime, '/v3/connection', payload.token, undefined, 'GET', 401);
    const fresh = await register(runtime, true), undelivered = await consume(fresh, runtime); time += HISTORY + 1;
    await call(1 - runtime, '/v3/connection', undelivered.payload.token, undefined, 'GET', 401);
    await call(runtime, `/v3/service/deliveries/${undelivered.d.deliveryId}/acknowledgement`, fresh.credential, {}, 'POST', 410);
  });
  test(`runtime ${runtime}: service disable and operator deletion block recipient credentials immediately`, async () => {
    const s = await register(runtime); await connect(s, runtime); const { payload } = await consume(s, runtime);
    await call(runtime, `/v3/services/${s.session.serviceId}`, owner(uid), { active: false }, 'PATCH');
    await call(1 - runtime, '/v3/connection', payload.token, undefined, 'GET', 401);
    await call(runtime, `/v3/services/${s.session.serviceId}`, owner(uid), { active: true }, 'PATCH');
    await call(runtime, '/v3/connection', payload.token);
    await db.collection('accounts').doc(uid).set({ deleting: true });
    await call(1 - runtime, '/v3/connection', payload.token, undefined, 'GET', 401);
    await db.collection('accounts').doc(uid).delete();
  });
  test(`runtime ${runtime}: scoped MCP discovery, expansion, result isolation and recipient deletion`, async () => {
    const s = await register(runtime, false, ['forms', 'sms']);
    const first = await connect(s, runtime, ['forms']); const { payload } = await consume(s, runtime);
    const client = new Client({name:'scoped-test',version:'1'});
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(bases[runtime]+'/mcp'),{fetch:contractFetch,requestInit:{headers:{Authorization:`Bearer ${payload.token}`}}}));
      const forms=(await client.listTools()).tools;
      assert.equal(forms.length,5); assert.ok(forms.every(t=>t._meta?.['com.bluegrain.smsrelay/capability']==='forms'));
      assert.ok(forms.every(t=>t._meta?.securitySchemes===undefined));
      assert.equal(capabilityTools(forms,['forms']).length,5); assert.equal(capabilityTools(forms,['sms']).length,0);
      await call(runtime, `/v3/connections/${first.approved.connectionId}`,owner(recipient),{capabilities:['forms','sms'],expiresAt:null},'PATCH');
      const all=(await client.listTools()).tools; assert.equal(all.length,8);
      assert.equal(capabilityTools(all,['sms']).length,3); assert.equal(capabilityTools(all,['forms']).length,5);
      await call(runtime, `/v3/connections/${first.approved.connectionId}`,owner(recipient),{capabilities:['sms'],expiresAt:null},'PATCH');
      assert.deepEqual((await client.listTools()).tools.map(t=>t.name).sort(),capabilityTools(all,['sms']).map((t: {name:string})=>t.name).sort());
      const other = await connect(s, runtime, ['forms'],randomUUID());
      assert.notEqual(other.approved.connectionId,first.approved.connectionId);
      await db.collection('accounts').doc(recipient).set({deleting:true});
      await call(runtime,'/v3/connection',payload.token,undefined,'GET',403);
      const serviceView=await call(runtime,`/v3/service/connections/${first.approved.connectionId}`,s.credential);
      assert.equal(serviceView.revoked,true);assert.equal(serviceView.receivingDeviceAvailable,false);
      await db.collection('accounts').doc(recipient).delete();
    } finally {await client.close();}
  });
  test(`runtime ${runtime}: service deletion invalidates access and drains child data across recipient accounts`,async()=>{
    const s=await register(runtime);await connect(s,runtime);const {payload}=await consume(s,runtime);
    await call(runtime,`/v3/services/${s.session.serviceId}`,owner(uid),{},'DELETE');
    await call(1-runtime,'/v3/connection',payload.token,undefined,'GET',401);
    for(let i=0;i<9;i++) { if(runtime===0)await relay.onboarding.cleanup();else await native.call('onboarding.cleanup',[]); }
    assert.equal((await db.collection('serviceDeliveryKeys').where('serviceId','==',s.session.serviceId).get()).size,0);
    assert.equal((await db.collection('credentialDeliveries').where('serviceId','==',s.session.serviceId).get()).size,0);
    assert.equal((await db.collection('serviceConnections').where('serviceId','==',s.session.serviceId).get()).size,0);
    assert.equal((await db.collection('services').doc(s.session.serviceId).get()).data()?.deleted,true);
  });

}

async function broker(input: unknown) {
  const child=spawn(process.execPath,[new URL('../../cli/broker.mjs',import.meta.url).pathname],{detached:true,stdio:['pipe','pipe','pipe']});
  const stop=()=>{if(child.pid)try{process.kill(-child.pid,'SIGKILL');}catch{};},bound=setTimeout(stop,20000);
  let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.stdin.on('error',()=>{});
  try {child.stdin.end(JSON.stringify(input));const [code]=await once(child,'close');assert.equal(code,0,stderr+stdout);return JSON.parse(stdout).value;}
  finally {clearTimeout(bound);stop();}
}
test('all SDK broker bindings share durable registration, approval and credential delivery',{timeout:120000},async()=>{
  const directory=await mkdtemp(join(tmpdir(),'relay-sdk-contract-'));
  try {
    const common={directory,profile:'sdk-conformance',relayUrl:bases[0],allowHttpLoopback:true};
    const start=await broker({...common,operation:'startRegistration',input:{name:'SDK agent',purpose:'Decisions'}});
    assert.ok(start.link.startsWith(bases[0]));assert.ok(!JSON.stringify(start).includes('Token'));
    await call(1,`/v3/registration-sessions/${start.sessionId}/decision`,owner(uid),decision(true));
    const invalid=db.batch();
    for(let i=0;i<100;i++) {const id=`000-invalid-${String(i).padStart(3,'0')}`;invalid.set(db.collection('credentialDeliveries').doc(id),{id,serviceId:start.serviceId,ownerId:uid,connectionId:'missing',grantId:'missing',keyId:'missing',envelope:'discarded',expiresAt:time+HISTORY,acknowledged:false,purgeAt:new Date(time+HISTORY)});}
    await invalid.commit();
    const approved=await broker({...common,operation:'pollRegistration'});assert.equal(approved.status,'approved');
    const ids=await broker({...common,operation:'listConnections'});assert.equal(ids.length,1);
    const status=await broker({...common,operation:'status',connectionId:ids[0]});assert.deepEqual(status.capabilities,['forms']);
    const resumed=await broker({...common,operation:'resume'});assert.equal(resumed.status,'registered');
  } finally {await rm(directory,{recursive:true,force:true});}
});

const callback = 'https://8.8.8.8/relay-callback?state=old&state=older&code=stale&error=stale&keep=opaque'; // Validation only; tests never navigate or send to this address.
async function oauthFlow(runtime: number, confidential = false, refresh = true) {
  time += 11 * MINUTE;
  const s = await register(runtime, false, ['forms', 'sms']);
  const client = await call(runtime, '/oauth/register', '', { client_name: 'Hosted client', redirect_uris: [callback], token_endpoint_auth_method: confidential ? 'client_secret_post' : 'none', grant_types: refresh ? ['authorization_code','refresh_token'] : ['authorization_code'] }, 'POST', 201);
  const verifier = randomBytes(32).toString('base64url');
  const params = { response_type: 'code', client_id: client.client_id, redirect_uri: callback,
    resource: `https://relay.example/mcp/services/${s.session.serviceId}`, scope: 'forms sms', state: 'opaque-state',
    code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') };
  const response = await contractFetch(bases[runtime] + '/oauth/authorize?' + new URLSearchParams(params), { redirect: 'manual' });
  assert.equal(response.status, 303, await response.text());
  const location = response.headers.get('location')!;assert.ok(location.startsWith('/oauth/consent/'));
  const sessionId = location.split('/').at(-1)!;
  return { s, client, verifier, params, sessionId };
}
for (const runtime of [0,1]) test(`runtime ${runtime}: OAuth rejects malformed resources and explicit invalid authentication methods`, async () => {
  for (const method of ['', null, 7]) {
    await call(runtime, '/oauth/register', '', {client_name:'Invalid client',redirect_uris:[callback],token_endpoint_auth_method:method}, 'POST', 400);
  }
  const defaults = await call(runtime, '/oauth/register', '', {client_name:'Default client',redirect_uris:[callback]}, 'POST', 201);
  assert.equal(defaults.token_endpoint_auth_method,'none');
  const f = await oauthFlow(runtime);
  for (const resource of ['not-a-url','https://']) {
    const response = await contractFetch(bases[runtime]+'/oauth/authorize?'+new URLSearchParams({...f.params,resource}), {redirect:'manual'});
    assert.equal(response.status,400); assert.equal((await response.json()).error,'invalid_target');
  }
});
async function formCall(runtime: number, endpoint: string, fields: Record<string, string>, expected = 200, timeoutMs = 10000) {
  const response = await fetch(bases[runtime] + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields), signal: AbortSignal.timeout(timeoutMs) });
  const value = await response.json();assert.equal(response.status, expected, JSON.stringify(value));return value;
}
async function approvedOAuth(f: Awaited<ReturnType<typeof oauthFlow>>, runtime: number, recipientUid = recipient, capabilities = ['forms']) {
  const fields = { decision: 'approved', capabilities, expiresInDays: null };
  const result = await call(runtime, `/v3/oauth/sessions/${f.sessionId}/decision`, owner(recipientUid), fields);
  assert.equal(result.status,'approved');assert.ok(result.connectionId);
  const pending=(await db.collection('oauthSessions').doc(f.sessionId).get()).data()!;
  assert.equal((await db.collection('oauthCodes').doc(pending.codeHash).get()).exists,false);
  time += 2 * MINUTE; // Phone setup may take longer than the authorization-code lifetime.
  const completed = await call(runtime, `/v3/oauth/sessions/${f.sessionId}/response`, owner(recipientUid), {});
  const redirect = new URL(completed.redirect);assert.equal(redirect.origin, new URL(callback).origin);assert.deepEqual(redirect.searchParams.getAll('state'), ['opaque-state']);assert.equal(redirect.searchParams.getAll('code').length,1);assert.equal(redirect.searchParams.has('error'),false);assert.equal(redirect.searchParams.get('keep'),'opaque');
  const again = await call(1-runtime, `/v3/oauth/sessions/${f.sessionId}/decision`, owner(recipientUid), fields);assert.deepEqual(again, result);
  const resumed = await call(1-runtime, `/v3/oauth/sessions/${f.sessionId}/response`, owner(recipientUid), {});assert.deepEqual(resumed, completed);
  return { grant_type: 'authorization_code', code: redirect.searchParams.get('code')!, client_id: f.client.client_id,
    ...(f.client.client_secret ? { client_secret: f.client.client_secret } : {}), redirect_uri: callback, resource: f.params.resource, code_verifier: f.verifier };
}
async function oauthTools(runtime: number, f: Awaited<ReturnType<typeof oauthFlow>>, token: string, expected = 200) {
  return call(runtime, `/mcp/services/${f.s.session.serviceId}`, token, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'POST', expected);
}
for (const runtime of [0,1]) test(`runtime ${runtime}: unconfigured revisions reject resource credentials on REST and legacy MCP`, {timeout:30000}, async () => {
  const f=await oauthFlow(runtime),tokens=await formCall(runtime,'/oauth/token',await approvedOAuth(f,runtime));
  const noOAuth={...options,publicUrl:undefined};
  const server=runtime===0?app(relay,noOAuth).listen(0,'127.0.0.1'):rustApp(native as unknown as Relay,noOAuth).listen() as unknown as Server;
  try {
    if(!server.listening)await once(server,'listening',{signal:AbortSignal.timeout(10000)});
    const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
    for(const path of ['/v2/requests/opaque-request/result','/mcp',`/mcp/services/${f.s.session.serviceId}`]){
      const response=await contractFetch(base+path,{headers:{Authorization:`Bearer ${tokens.access_token}`},signal:AbortSignal.timeout(10000)});
      assert.ok([401,503].includes(response.status),`${path}: ${response.status}`);await response.body?.cancel();
    }
  } finally {server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));native.options=options;}
});

const providerProfiles: {name:string;provider:string;redirectUri:string;metadataId?:string;source:string}[]=JSON.parse(readFileSync(new URL('../../contracts/provider-authorization.json',import.meta.url),'utf8'));
for(const runtime of [0,1])for(const profile of providerProfiles){
  const name=`provider authorization ${profile.name} runtime ${runtime}`;
  test(name,{timeout:60000},async()=>{
    const providerRecipient='provider-'+randomUUID();
    time+=11*MINUTE;const s=await register(runtime,false,['forms','sms']),resource=`https://relay.example/mcp/services/${s.session.serviceId}`;
    const endpoint=`/mcp/services/${s.session.serviceId}`;
    const challenge=await contractFetch(bases[runtime]+endpoint,{signal:AbortSignal.timeout(10000)});
    assert.equal(challenge.status,401);assert.ok(challenge.headers.get('www-authenticate')?.includes(`/.well-known/oauth-protected-resource${endpoint}`));await challenge.body?.cancel();
    const metadata=await (await contractFetch(bases[runtime]+`/.well-known/oauth-protected-resource${endpoint}`)).json();
    assert.equal(metadata.resource,resource);assert.deepEqual(metadata.authorization_servers,['https://relay.example']);
    const issuer=await (await contractFetch(bases[runtime]+'/.well-known/oauth-authorization-server')).json();
    for(const field of ['authorization_endpoint','token_endpoint','registration_endpoint'])assert.ok(issuer[field].startsWith('https://relay.example/oauth/'));
    assert.ok(issuer.response_types_supported.includes('code'));assert.ok(issuer.code_challenge_methods_supported.includes('S256'));assert.ok(issuer.grant_types_supported.includes('refresh_token'));
    assert.ok(issuer.token_endpoint_auth_methods_supported.includes('none'));
    if(profile.metadataId)assert.equal(issuer.client_id_metadata_document_supported,true);
    const declaration={client_name:profile.name,redirect_uris:[profile.redirectUri],token_endpoint_auth_method:'none' as const};
    // CIMD fixtures are validated through the real registration code, then consumed from its shared cache.
    // Provider callbacks/documents are never navigated or fetched by this conformance harness.
    const client=profile.metadataId?await new OAuth(relay,'https://relay.example').register({...declaration,client_id:profile.metadataId},'provider-fixture',profile.metadataId):await call(runtime,'/oauth/register','',declaration,'POST',201);
    const verifier=randomBytes(32).toString('base64url'),state=randomUUID();
    const params={response_type:'code',client_id:client.client_id,redirect_uri:profile.redirectUri,resource,scope:'forms sms',state,code_challenge_method:'S256',code_challenge:createHash('sha256').update(verifier).digest('base64url')};
    const authorize=await contractFetch(bases[runtime]+'/oauth/authorize?'+new URLSearchParams(params),{redirect:'manual'});assert.equal(authorize.status,303);
    const session=authorize.headers.get('location')!.split('/').at(-1)!;
    const view=await call(runtime,`/v3/oauth/sessions/${session}`,owner(providerRecipient));assert.equal(view.clientName,profile.name);assert.equal(view.clientOrigin,new URL(profile.redirectUri).origin);
    await call(1-runtime,`/v3/oauth/sessions/${session}/decision`,owner(providerRecipient),{decision:'approved',capabilities:['forms'],expiresInDays:null});
    const response=await call(runtime,`/v3/oauth/sessions/${session}/response`,owner(providerRecipient),{}),redirect=new URL(response.redirect),target=new URL(profile.redirectUri);
    assert.equal(redirect.origin+redirect.pathname,target.origin+target.pathname);assert.deepEqual(redirect.searchParams.getAll('state'),[state]);
    const exchange={grant_type:'authorization_code',client_id:client.client_id,redirect_uri:profile.redirectUri,resource,code:redirect.searchParams.get('code')!,code_verifier:verifier};
    await formCall(runtime,'/oauth/token',{...exchange,code_verifier:randomBytes(32).toString('base64url')},400);
    if(profile.provider==='xai'){
      await formCall(runtime,'/oauth/token',{...exchange,redirect_uri:profile.redirectUri+'/unregistered'},400);
      await formCall(runtime,'/oauth/token',{...exchange,resource:'https://relay.example/mcp/services/another'},400);
    }
    const tokens=await formCall(1-runtime,'/oauth/token',exchange);assert.equal(tokens.scope,'forms');assert.equal(tokens.token_type,'Bearer');assert.ok(tokens.refresh_token);
    const config=profile.provider==='google'?{authorization:tokens.access_token}:hostedProviderConfig(profile.provider,{resource,accessToken:tokens.access_token});
    const softwareToken='authorization' in config?config.authorization:config.mcp_servers[0]!.authorization_token;
    assert.ok(typeof softwareToken==='string');
    const tools=await call(runtime,endpoint,softwareToken,{jsonrpc:'2.0',id:'provider-list',method:'tools/list'});
    assert.equal(tools.result.tools.length,5);
    for(const tool of tools.result.tools)assert.deepEqual(tool._meta.securitySchemes,[{type:'oauth2',scopes:['forms']}]);
    await call(runtime,`/v1/devices/${randomUUID()}`,owner(providerRecipient),{name:'Synthetic provider phone',fcmToken:'synthetic',wizardVersion:1},'PUT');
    if(profile.provider==='xai'){
      assert.deepEqual(config,{type:'mcp',server_label:'relay',server_url:resource,authorization:tokens.access_token});
      assert.ok(tools.result.tools.every((tool: {name:string})=>!tool.name.includes('sms')));
      await call(runtime,'/mcp/services/another',softwareToken,{jsonrpc:'2.0',id:'wrong-resource',method:'tools/list'},'POST',401);
      await call(runtime,'/mcp',softwareToken,{jsonrpc:'2.0',id:'legacy-resource',method:'tools/list'},'POST',401);
      const denied=await call(runtime,endpoint,softwareToken,{jsonrpc:'2.0',id:'sms-denied',method:'tools/call',params:{name:'request_sms_code',arguments:{title:'Not approved',purpose:'No SMS grant',idempotencyKey:randomUUID()}}});
      assert.equal(denied.result.isError,true);
      assert.deepEqual(denied.result.content,[{type:'text',text:runtime===0?'MCP error -32602: Tool request_sms_code not found':JSON.stringify({error:'sms_approval_required'})}]);
    }
    const created=await call(runtime,endpoint,tokens.access_token,{jsonrpc:'2.0',id:'create',method:'tools/call',params:{name:'create_request',arguments:{title:'Review',body:'Provider fixture',fields:[{id:'decision',type:'text',label:'Decision'}],actions:[{id:'send',type:'submit',label:'Send'}],idempotencyKey:randomUUID()}}});
    const requestId=created.result.structuredContent.requestId;assert.equal(typeof requestId,'string');
    const inspected=await call(runtime,endpoint,tokens.access_token,{jsonrpc:'2.0',id:'inspect',method:'tools/call',params:{name:'inspect_request',arguments:{requestId}}});
    assert.equal(inspected.result.structuredContent.requestId,requestId);
    await call(runtime,endpoint,tokens.access_token,{jsonrpc:'2.0',id:'cancel',method:'tools/call',params:{name:'cancel_request',arguments:{requestId}}});
    if(profile.provider==='openai'){
      const result=await call(runtime,endpoint,'',{jsonrpc:'2.0',id:'linking',method:'tools/call',params:{name:'inspect_request',arguments:{requestId:'opaque-request'}}});
      assert.equal(result.result.isError,true);assert.ok(result.result._meta['mcp/www_authenticate'][0].includes('error_description='));assert.ok(result.result._meta['mcp/www_authenticate'][0].includes('resource_metadata='));
      time+=10*MINUTE+1;
      const durable=await call(runtime,endpoint,tokens.access_token,{jsonrpc:'2.0',id:'durable',method:'tools/call',params:{name:'inspect_request',arguments:{requestId}}});
      assert.equal(durable.result.structuredContent.requestId,requestId);
    }
    if(profile.name.includes('Messages')){
      assert.ok('mcp_servers' in config && config.mcp_servers);
      assert.equal(config.mcp_servers[0]!.authorization_token,tokens.access_token);assert.ok(!JSON.stringify(config.tools).includes(tokens.access_token));
    }
    const refreshed=await formCall(runtime,'/oauth/token',{grant_type:'refresh_token',client_id:client.client_id,refresh_token:tokens.refresh_token,resource});assert.equal(refreshed.refresh_token,tokens.refresh_token);assert.equal(refreshed.access_token,tokens.access_token);assert.equal(refreshed.expires_in,undefined);
    await formCall(1-runtime,'/oauth/revoke',{client_id:client.client_id,token:refreshed.refresh_token});
    await call(runtime,endpoint,refreshed.access_token,{jsonrpc:'2.0',id:'revoked',method:'tools/list'},'POST',401);
  });
}
for (const runtime of [0, 1]) {
  test(`runtime ${runtime}: hosted discovery, PKCE, resource binding and private scoped MCP access interoperate`, async () => {
    const f = await oauthFlow(runtime, true);
    const discovery = await contractFetch(bases[runtime] + '/.well-known/oauth-authorization-server');assert.equal(discovery.status,200);
    assert.deepEqual((await discovery.json()).code_challenge_methods_supported,['S256']);
    const metadata = await contractFetch(bases[1-runtime] + `/.well-known/oauth-protected-resource/mcp/services/${f.s.session.serviceId}`);assert.equal((await metadata.json()).resource,f.params.resource);
    const challenge = await contractFetch(bases[runtime] + `/mcp/services/${f.s.session.serviceId}`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
    assert.equal(challenge.status,401);assert.ok(challenge.headers.get('www-authenticate')?.includes('/.well-known/oauth-protected-resource/'));
    const review = await call(runtime, `/v3/oauth/sessions/${f.sessionId}`, owner(recipient));
    assert.equal(review.name,'Personal agent');assert.equal(review.clientName,'Hosted client');
    assert.ok(!JSON.stringify(review).includes(recipient));assert.equal((await db.collection('oauthAccess').where('serviceId','==',f.s.session.serviceId).get()).size,0);
    const exchange = await approvedOAuth(f, 1-runtime);
    await formCall(runtime,'/oauth/token',{...exchange,code_verifier:'wrong'.repeat(12)},400);
    await formCall(runtime,'/oauth/token',{...exchange,resource:'https://relay.example/mcp'},400);
    await formCall(runtime,'/oauth/token',{...exchange,client_secret:'wrong'},401);
    const tokens = await formCall(runtime,'/oauth/token',exchange);
    assert.equal(tokens.scope,'forms');assert.equal(tokens.expires_in,undefined);
    assert.ok(!JSON.stringify(tokens).includes(recipient));
    const tools = await oauthTools(1-runtime,f,tokens.access_token);assert.equal(tools.result.tools.length,5);
    assert.ok(tools.result.tools.every((t: {name:string})=>!t.name.includes('sms')));
    await call(runtime,'/v3/connection',tokens.access_token,undefined,'GET',401);
    await call(runtime,'/mcp',tokens.access_token,{jsonrpc:'2.0',id:1,method:'tools/list'},'POST',401);
    await call(runtime,'/mcp/services/another',tokens.access_token,{jsonrpc:'2.0',id:1,method:'tools/list'},'POST',401);
    await oauthTools(runtime,f,f.s.credential,401);
    await call(runtime,`/v3/oauth/sessions/${f.sessionId}`,owner('different-recipient'),undefined,'GET',404);
    await formCall(1-runtime,'/oauth/token',exchange,400); // One-time authorization code replay cannot revoke a static connection.
    await oauthTools(runtime,f,tokens.access_token);
  });
  test(`runtime ${runtime}: static OAuth credentials survive time, retries and concurrent refresh until explicit revocation`, async () => {
    const f = await oauthFlow(runtime,true), exchange = await approvedOAuth(f,runtime), tokens = await formCall(1-runtime,'/oauth/token',exchange);
    assert.equal(tokens.expires_in,undefined);
    time += 400*24*60*MINUTE;
    await relay.onboarding.cleanup();await native.call('onboarding.cleanup',[]);
    await oauthTools(runtime,f,tokens.access_token);
    const renewal = {grant_type:'refresh_token',refresh_token:tokens.refresh_token,client_id:f.client.client_id,client_secret:f.client.client_secret,resource:f.params.resource};
    await formCall(runtime,'/oauth/token',{...renewal,client_secret:'wrong'},401);
    await formCall(runtime,'/oauth/token',{...renewal,scope:'forms sms'},400);
    await formCall(runtime,'/oauth/token',{...renewal,resource:'https://relay.example/mcp/services/wrong'},400);
    // Same-family transaction retries can exceed the ordinary request deadline under emulator contention.
    for(const refreshed of await Promise.all([0,1,0,1].map(r=>formCall(r,'/oauth/token',renewal,200,30000))))assert.deepEqual(refreshed,tokens);
    const records=await db.collection('oauthAccess').where('serviceId','==',f.s.session.serviceId).get();assert.equal(records.size,1);
    const refreshRecords=await db.collection('oauthRefresh').where('serviceId','==',f.s.session.serviceId).get();assert.equal(refreshRecords.size,1);
    for(const record of [...records.docs,...refreshRecords.docs]){
      assert.equal(record.data().purgeAt,null);
      assert.ok(!JSON.stringify(record.data()).includes(tokens.access_token));assert.ok(!JSON.stringify(record.data()).includes(tokens.refresh_token));
    }
    await oauthTools(1-runtime,f,tokens.access_token);
    await formCall(1-runtime,'/oauth/revoke',{client_id:f.client.client_id,client_secret:f.client.client_secret,token:tokens.access_token});
    await oauthTools(runtime,f,tokens.access_token,401);await formCall(runtime,'/oauth/token',renewal,400);
  });
  test(`runtime ${runtime}: static refresh narrows permissions without changing either credential`, async () => {
    const f=await oauthFlow(runtime),exchange=await approvedOAuth(f,runtime,recipient,['forms','sms']),tokens=await formCall(runtime,'/oauth/token',exchange);
    assert.equal((await oauthTools(runtime,f,tokens.access_token)).result.tools.length,8);
    const renewal={grant_type:'refresh_token',refresh_token:tokens.refresh_token,client_id:f.client.client_id,resource:f.params.resource};
    await db.collection('oauthAccess').doc(hash(tokens.access_token)).update({capabilities:['forms']});
    assert.equal((await oauthTools(runtime,f,tokens.access_token)).result.tools.length,5);
    assert.deepEqual(await formCall(1-runtime,'/oauth/token',renewal),tokens);
    assert.equal((await oauthTools(runtime,f,tokens.access_token)).result.tools.length,8);
    const updated=await formCall(1-runtime,'/oauth/token',{...renewal,scope:'forms'});
    assert.equal(updated.access_token,tokens.access_token);assert.equal(updated.refresh_token,tokens.refresh_token);
    assert.deepEqual(await formCall(runtime,'/oauth/token',renewal),updated);
    assert.equal((await oauthTools(1-runtime,f,tokens.access_token)).result.tools.length,5);
    await formCall(runtime,'/oauth/token',{...renewal,scope:'forms sms'},400);
  });
  test(`runtime ${runtime}: legacy OAuth refresh establishes static credentials without migrating old access`, async () => {
    const f=await oauthFlow(runtime,true),exchange=await approvedOAuth(f,runtime);
    const codeRef=db.collection('oauthCodes').doc(hash(exchange.code)),code=(await codeRef.get()).data()!;
    const grant=(await db.collection('grants').doc(code.grantId).get()).data()!;
    const familyId=randomUUID(),access=secrets('smsa'),refresh=secrets('smsf'),accessExpiry=time+10*MINUTE;
    const family={id:familyId,ownerId:code.ownerId,serviceId:code.serviceId,grantId:code.grantId,clientId:code.clientId,resource:code.resource,capabilities:code.capabilities,expiresAt:grant.expiresAt,revoked:false,purgeAt:null};
    const legacyRefresh={ownerId:code.ownerId,serviceId:code.serviceId,clientId:code.clientId,resource:code.resource,familyId,expiresAt:grant.expiresAt,consumed:false,purgeAt:null};
    // Reproduce the pre-update schema: independently random access and refresh, with a ten-minute access TTL.
    const seed=db.batch();
    seed.update(codeRef,{consumed:true,familyId});
    seed.update(db.collection('oauthClients').doc(hash(code.clientId)),{purgeAt:null});
    seed.set(db.collection('oauthFamilies').doc(familyId),family);
    seed.set(db.collection('oauthAccess').doc(hash(access)),{ownerId:code.ownerId,serviceId:code.serviceId,grantId:code.grantId,clientId:code.clientId,familyId,resource:code.resource,capabilities:code.capabilities,expiresAt:accessExpiry,purgeAt:new Date(accessExpiry)});
    seed.set(db.collection('oauthRefresh').doc(hash(refresh)),legacyRefresh);
    await seed.commit();
    await oauthTools(1-runtime,f,access);
    const renewal={grant_type:'refresh_token',refresh_token:refresh,client_id:f.client.client_id,client_secret:f.client.client_secret,resource:f.params.resource};
    for(const state of ['expired','consumed','deleted']){
      const invalid=secrets('smsf');
      if(state!=='deleted')await db.collection('oauthRefresh').doc(hash(invalid)).set({...legacyRefresh,expiresAt:state==='expired'?time-1:grant.expiresAt,consumed:state==='consumed'});
      await formCall(runtime,'/oauth/token',{...renewal,refresh_token:invalid},400);
    }
    time=accessExpiry+1;
    await oauthTools(runtime,f,access,401);
    const upgraded=await formCall(runtime,'/oauth/token',renewal);
    assert.notEqual(upgraded.access_token,access);assert.equal(upgraded.refresh_token,refresh);assert.equal(upgraded.expires_in,undefined);
    const previous=(await db.collection('oauthAccess').doc(hash(access)).get()).data()!;
    assert.equal(previous.expiresAt,accessExpiry);assert.equal(previous.purgeAt.toMillis(),accessExpiry);
    for(const repeated of await Promise.all([0,1,0,1].map(r=>formCall(r,'/oauth/token',renewal,200,30000))))assert.deepEqual(repeated,upgraded);
    time+=400*24*60*MINUTE;
    await relay.onboarding.cleanup();await native.call('onboarding.cleanup',[]);
    assert.equal((await db.collection('oauthAccess').doc(hash(access)).get()).exists,false);
    await oauthTools(1-runtime,f,upgraded.access_token);
    assert.deepEqual(await formCall(1-runtime,'/oauth/token',renewal),upgraded);
  });
  test(`runtime ${runtime}: an access-only OAuth client needs no refresh to retain access`, async () => {
    const f=await oauthFlow(runtime,false,false),exchange=await approvedOAuth(f,runtime),tokens=await formCall(1-runtime,'/oauth/token',exchange);
    assert.equal(tokens.refresh_token,undefined);assert.equal(tokens.expires_in,undefined);
    time+=400*24*60*MINUTE;
    await relay.onboarding.cleanup();await native.call('onboarding.cleanup',[]);
    await oauthTools(1-runtime,f,tokens.access_token);
    await formCall(runtime,'/oauth/revoke',{client_id:f.client.client_id,token:tokens.access_token});
    await oauthTools(1-runtime,f,tokens.access_token,401);
  });
  test(`runtime ${runtime}: hosted grants need no online service and disconnect/revocation are immediate`, async () => {
    const f=await oauthFlow(runtime),exchange=await approvedOAuth(f,runtime),tokens=await formCall(runtime,'/oauth/token',exchange);
    const review=await call(runtime,`/v3/oauth/sessions/${f.sessionId}`,owner(recipient));
    const state=await call(1-runtime,`/v3/connections/${review.connectionId}`,owner(recipient));assert.equal(state.setup,'phone_setup_needed');
    time+=40*24*60*MINUTE; // No encrypted delivery consumer is needed for a hosted OAuth client.
    await relay.onboarding.cleanup();await native.call('onboarding.cleanup',[]);
    const newer=await formCall(runtime,'/oauth/token',{grant_type:'refresh_token',refresh_token:tokens.refresh_token,client_id:f.client.client_id,resource:f.params.resource});
    await oauthTools(1-runtime,f,newer.access_token);
    await call(runtime,`/v3/connections/${review.connectionId}`,owner(recipient),undefined,'DELETE');
    await oauthTools(1-runtime,f,newer.access_token,401);
    for(let i=0;i<6;i++){if(runtime===0)await relay.onboarding.cleanup();else await native.call('onboarding.cleanup',[]);}
    assert.equal((await db.collection('oauthRefresh').where('serviceId','==',f.s.session.serviceId).get()).size,0);
    assert.equal((await db.collection('oauthFamilies').where('serviceId','==',f.s.session.serviceId).get()).size,0);
    const again=await oauthFlow(runtime),pair=await approvedOAuth(again,runtime),issued=await formCall(1-runtime,'/oauth/token',pair);
    await formCall(runtime,'/oauth/revoke',{client_id:again.client.client_id,token:issued.refresh_token});
    await oauthTools(1-runtime,again,issued.access_token,401);
    for(let i=0;i<5;i++){if(runtime===0)await relay.onboarding.cleanup();else await native.call('onboarding.cleanup',[]);}
    assert.equal((await db.collection('oauthRefresh').where('serviceId','==',again.s.session.serviceId).get()).size,0);
  });
  test(`runtime ${runtime}: invalid redirects and expired/cancelled hosted attempts grant no access`, async () => {
    await call(runtime,'/oauth/register','',{client_name:'Invalid',redirect_uris:['https://127.0.0.1/private']},'POST',400);
    const f=await oauthFlow(runtime);
    const bad=await contractFetch(bases[runtime]+'/oauth/authorize?'+new URLSearchParams({...f.params,redirect_uri:'https://8.8.4.4/wrong'}),{redirect:'manual'});assert.equal(bad.status,400);assert.equal(bad.headers.get('location'),null);
    await call(1-runtime,`/v3/oauth/sessions/${f.sessionId}/decision`,owner(recipient),{decision:'denied',capabilities:['forms'],expiresInDays:null});
    const denied=await call(runtime,`/v3/oauth/sessions/${f.sessionId}/response`,owner(recipient),{});
    assert.equal(new URL(denied.redirect).searchParams.get('error'),'access_denied');assert.equal(new URL(denied.redirect).searchParams.get('code'),null);assert.deepEqual(new URL(denied.redirect).searchParams.getAll('state'),['opaque-state']);assert.deepEqual(new URL(denied.redirect).searchParams.getAll('error'),['access_denied']);
    const expired=await oauthFlow(runtime);time+=11*MINUTE;
    assert.equal((await call(runtime,`/v3/oauth/sessions/${expired.sessionId}`,owner(recipient))).status,'expired');
    await call(1-runtime,`/v3/oauth/sessions/${expired.sessionId}/decision`,owner(recipient),{decision:'approved',capabilities:['forms'],expiresInDays:null},'POST',410);
  });
}
for (const runtime of [0,1]) test(`runtime ${runtime}: registration can always be declined at the owned-service quota`,async()=>{
  time+=11*MINUTE;
  const limited=`limited-service-owner-${runtime}`,key=await generateKeyPair('ECDH-ES',{crv:'P-256',extractable:true});
  const registration=await call(runtime,'/v3/registration-sessions',secrets('smsreg'),{name:'Over quota',purpose:'Test cancellation',capabilities:['forms'],deliveryPublicKey:await exportJWK(key.publicKey),credentialHash:hash(secrets('smss'))},'POST',201);
  const rows=Array.from({length:100},(_,i)=>db.collection('services').doc(`quota-${runtime}-${i}`));
  const setup=db.batch();for(const row of rows)setup.set(row,{id:row.id,ownerId:limited,deleted:false,active:true});await setup.commit();
  try {
    await call(1-runtime,`/v3/registration-sessions/${registration.sessionId}/decision`,owner(limited),decision(),'POST',409);
    const denied=await call(runtime,`/v3/registration-sessions/${registration.sessionId}/decision`,owner(limited),{...decision(),decision:'denied'});
    assert.equal(denied.status,'denied');assert.equal(denied.connectionId,null);
  }finally{const cleanup=db.batch();for(const row of rows)cleanup.delete(row);await cleanup.commit();}
});
for(const runtime of [0,1])test(`runtime ${runtime}: forms cannot bypass SMS scope through an SMS helper field`,async()=>{
  time+=11*MINUTE;
  const s=await register(runtime,true,['forms','sms']),{payload}=await consume(s,runtime);
  const device=`helper-scope-${runtime}`;
  await call(runtime,`/v1/devices/${device}`,owner(uid),{name:'Synthetic phone',fcmToken:'synthetic',wizardVersion:1},'PUT');
  const input={title:'Code',body:'Share only with consent',fields:[{id:'code',type:'text',label:'Code',input:'sms_code'}],actions:[{id:'send',type:'submit',label:'Send'}],idempotencyKey:randomUUID()};
  const created=await call(runtime,'/v2/requests',payload.token,input,'POST',201);
  await call(1-runtime,`/v3/connections/${s.approved.connectionId}`,owner(uid),{capabilities:['forms'],expiresAt:null},'PATCH');
  await call(runtime,'/v2/requests',payload.token,{...input,idempotencyKey:randomUUID()},'POST',403);
  await call(1-runtime,`/v2/requests/${created.requestId}/result`,payload.token,undefined,'GET',403);
  await call(runtime,`/v2/requests/${created.requestId}`,payload.token,undefined,'GET',403);
  const phone=await call(1-runtime,`/v2/devices/${device}/requests/${created.requestId}`,owner(uid));assert.equal(phone.status,'cancelled');
});
test('Unicode owner identities keep OAuth response codes and reusable grant bindings identical across runtimes',async()=>{
  const recipientUid='onboarding-\u{f0000}-😀',f=await oauthFlow(0);
  const issued=await approvedOAuth(f,0,recipientUid),first=await call(1,`/v3/oauth/sessions/${f.sessionId}`,owner(recipientUid));
  await formCall(1,'/oauth/token',issued);
  const attempt=await contractFetch(bases[1]+'/oauth/authorize?'+new URLSearchParams(f.params),{redirect:'manual'});assert.equal(attempt.status,303);
  const next={...f,sessionId:attempt.headers.get('location')!.split('/').at(-1)!};
  await approvedOAuth(next,1,recipientUid);
  const second=await call(0,`/v3/oauth/sessions/${next.sessionId}`,owner(recipientUid));assert.equal(second.connectionId,first.connectionId);
  const pairing={capabilities:['forms'],expiresInDays:null,idempotencyKey:randomUUID()};
  const a=await call(0,`/v3/services/${f.s.session.serviceId}/connections`,owner(recipientUid),pairing,'POST',201);
  const b=await call(1,`/v3/services/${f.s.session.serviceId}/connections`,owner(recipientUid),pairing,'POST',201);assert.equal(a.sessionId,b.sessionId);
  const decision={decision:'approved',capabilities:['forms'],expiresInDays:null};
  const approved=await call(0,`/v3/pairing-sessions/${a.sessionId}/decision`,owner(recipientUid),decision);
  const fresh=await call(1,`/v3/services/${f.s.session.serviceId}/connections`,owner(recipientUid),{...pairing,idempotencyKey:randomUUID()},'POST',201);
  assert.equal((await call(1,`/v3/pairing-sessions/${fresh.sessionId}/decision`,owner(recipientUid),decision)).connectionId,approved.connectionId);
});

const sdkCommands: Record<string,string[]> = process.env.RELAY_SDK_CONFORMANCE ? JSON.parse(readFileSync(process.env.RELAY_SDK_CONFORMANCE,'utf8')) : {};
for(const runtime of [0,1]) for(const [family,command] of Object.entries(sdkCommands)) {
  test(`SDK family ${family} runtime ${runtime}: durable hooks, lifecycle, encrypted delivery and request conformance`,{timeout:120000},async()=>{
    time+=11*MINUTE;
    const directory=await mkdtemp(join(tmpdir(),'relay-language-conformance-'));
    const common={broker:new URL('../../scripts/sdk-conformance-broker.mjs',import.meta.url).pathname,storageCommand:new URL('../../scripts/sdk-conformance-storage.py',import.meta.url).pathname,directory,profile:'sdk-'+family,relayUrl:bases[runtime],allowHttpLoopback:true};
    let failSave=false;
    const invoke=async(operation:string,input:unknown={},connectionId?:string,expected=true)=>{
      const child=spawn(command[0]!,command.slice(1),{detached:true,stdio:['pipe','pipe','pipe'],env:{...process.env,RELAY_TEST_STORAGE_DIR:directory,RELAY_TEST_FAIL_SAVE:failSave?'1':'',PYTHONPATH:new URL('../../sdks/python',import.meta.url).pathname}});
      let output='';child.stdout.on('data',b=>{output+=b;});child.stderr.resume();
      const stop=()=>{if(child.pid)try{process.kill(-child.pid,'SIGKILL');}catch{};};
      const bound=setTimeout(stop,20000);
      child.stdin.on('error',()=>{});
      try {child.stdin.end(JSON.stringify({...common,operation,input,connectionId}));await once(child,'close');const result=JSON.parse(output);assert.equal(result.ok,expected,`${family}: ${operation}`);return result.value;}
      finally {clearTimeout(bound);stop();}
    };
    try {
      failSave=true;await invoke('startRegistration',{name:'SDK '+family,purpose:'Synthetic decisions'},undefined,false);failSave=false;
      const start=await invoke('startRegistration',{name:'SDK '+family,purpose:'Synthetic decisions',capabilities:['forms','sms']});
      assert.ok(start.link.startsWith(bases[runtime]));
      const approved=await call(1-runtime,`/v3/registration-sessions/${start.sessionId}/decision`,owner(uid),decision(true,['forms']));
      await invoke('pollRegistration');
      const ids=await invoke('listConnections');assert.deepEqual(ids,[approved.connectionId]);
      const connection=ids[0];
      assert.deepEqual((await invoke('status',{},connection)).capabilities,['forms']);
      await invoke('requestSms',{purpose:'Not authorized',idempotencyKey:randomUUID()},connection,false);
      const permanent=await invoke('permanentLink');assert.ok(permanent.includes('/services/'));
      await relay.register(uid,'sdk-phone-'+family,'Synthetic phone','fake-fcm',1);
      const definition={title:'Decision',body:'Synthetic request',fields:[],actions:[{id:'approve',label:'Approve',type:'approve'}],idempotencyKey:randomUUID()};
      const created=await invoke('requestForm',definition,connection);assert.ok(created.requestId);
      assert.equal((await invoke('requestForm',definition,connection)).requestId,created.requestId);
      assert.equal((await invoke('getForm',{id:created.requestId},connection)).status,'pending');
      await relay.register(uid,'sdk-phone-'+family,'Synthetic phone','fake-fcm',1);
      await relay.forms.submit(uid,'sdk-phone-'+family,created.requestId,{submissionId:randomUUID(),action:'approve',values:{}});
      assert.ok(await invoke('formResult',{id:created.requestId},connection));
      const hook=await invoke('registerWebhook',{url:'https://8.8.8.8/sdk-callback',events:['request.submitted']},connection);assert.ok((await invoke('webhooks',{},connection)).some((h:any)=>h.id===hook.id));await invoke('deleteWebhook',{id:hook.id},connection);assert.equal((await invoke('webhooks',{},connection)).length,0);
      const events=await invoke('events',{},connection);assert.ok(JSON.stringify(events).includes('request.submitted'));
      const cancelled=await invoke('requestForm',{...definition,idempotencyKey:randomUUID()},connection);await invoke('cancelForm',{id:cancelled.requestId},connection);
      assert.equal((await invoke('getForm',{id:cancelled.requestId},connection)).status,'cancelled');
      const hookState=JSON.parse(await readFile(join(directory,common.profile+'.json'),'utf8'));
      assert.equal(hookState.keys.length,1);assert.ok(hookState.connections[connection].token);
      await invoke('rotateKey',{retireKeyId:hookState.keys[0].id});await invoke('rotateCredential');await invoke('resume');
      const attempt=await invoke('startPairing',{capabilities:['forms'],externalAccountRef:randomUUID()});
      assert.equal((await invoke('startPairing')).sessionId,attempt.sessionId);
      assert.equal((await invoke('pollPairing')).status,'pending');
      await call(1-runtime,`/v3/pairing-sessions/${attempt.sessionId}/decision`,owner(recipient),{decision:'approved',capabilities:['forms'],expiresInDays:null});
      time+=5001;
      failSave=true;await invoke('consumeDeliveries',{},undefined,false);failSave=false;
      const unack=await db.collection('credentialDeliveries').where('serviceId','==',start.serviceId).where('acknowledged','==',false).get();assert.equal(unack.size,1);
      await invoke('waitForPairing');const allIds=await invoke('listConnections');assert.equal(allIds.length,2);await invoke('getForm',{id:created.requestId},allIds.find((id:string)=>id!==connection),false);
      await call(1-runtime,`/v3/connections/${connection}`,owner(uid),{capabilities:['forms','sms'],expiresAt:null},'PATCH');
      const sms=await invoke('requestSms',{purpose:'Synthetic SMS consent',idempotencyKey:randomUUID()},connection);assert.ok(sms.requestId);await invoke('getSms',{id:sms.requestId},connection);await invoke('cancelSms',{id:sms.requestId},connection);
      await call(1-runtime,`/v3/connections/${connection}`,owner(uid),undefined,'DELETE');await invoke('status',{},connection,false);
      assert.equal(await invoke('consumeDeliveries'),0);
    } finally {await rm(directory,{recursive:true,force:true});}
  });
}

test('native scoped stream closes at undelivered expiry and tracks shortened grant expiry',{timeout:15000},async()=>{
  for(const delivered of [false,true]) {
    time+=11*MINUTE;
    const s=await register(1,true);const {d,payload}=await consume(s,1);
    const ref=db.collection('grants').doc(hash(payload.token));
    await ref.update({deliveryExpiresAt:time+1000});
    const subscription=await native.call('streamSubscribe',[payload.token]) as {subscriptionId:string};
    try {
      if(delivered) {
        await call(0,`/v3/service/deliveries/${d.deliveryId}/acknowledgement`,s.credential,{});
        await call(0,`/v3/connections/${payload.connectionId}`,owner(uid),{capabilities:['forms'],expiresAt:time+1000},'PATCH');
        const observedBy=Date.now()+3000;let observed=false;
        while(Date.now()<observedBy) {
          const snapshot=await native.call('streamSnapshot',[subscription.subscriptionId]) as {failed:boolean,expiresAt:number};
          if(snapshot.expiresAt===time+1000){assert.equal(snapshot.failed,false);observed=true;break;}
          await new Promise(resolve=>setTimeout(resolve,10));
        }
        assert.equal(observed,true,'watch must observe the shortened future expiry before clock advances');
      }
      time+=1001;
      const until=Date.now()+4000;let failed=false;
      while(Date.now()<until) {
        const snapshot=await native.call('streamSnapshot',[subscription.subscriptionId]) as {failed:boolean};
        if(snapshot.failed){failed=true;break;}
        await new Promise(resolve=>setTimeout(resolve,25));
      }
      assert.equal(failed,true,delivered?'shortened expiry must close':'undelivered expiry must close');
    } finally {await native.call('streamStop',[subscription.subscriptionId]);}
  }
});
