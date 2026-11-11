import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
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

if (!process.env.FIRESTORE_EMULATOR_HOST) throw Error('Onboarding contracts require the Firestore emulator');
process.env.OAUTH_CODE_KEY = '64'.repeat(32); // Isolated contract key, never used for deployment.
const firebase = initializeApp({ projectId: 'demo-sms-relay' }, 'onboarding-contract'), db = getFirestore(firebase);
let time = 1_800_000_000_000;
const uid = 'onboarding-operator', recipient = 'onboarding-recipient';
const secrets = (prefix: string) => `${prefix}_${randomBytes(32).toString('base64url')}`;
const relay = new Relay(db, async () => {}, () => time), native = new RustRelay(db, async () => {}, () => time);
const options: HttpOptions = { verifyOwner: async t => { assert.ok(t.startsWith('owner:') || t.startsWith('owner64:')); return { uid: t.startsWith('owner64:') ? Buffer.from(t.slice(8),'base64url').toString('utf8') : t.slice(6), authTime: time / 1000 }; }, verifyScheduler: async () => {}, deleteIdentity: async () => {}, publicUrl: 'https://relay.example', firebaseWebConfig: { apiKey: 'public', authDomain: 'demo-sms-relay.firebaseapp.com', projectId: 'demo-sms-relay', appId: 'public' } };
let servers: Server[] = [], bases: string[] = [];
async function call(runtime: number, path: string, token: string, body?: unknown, method = body === undefined ? 'GET' : 'POST', expected = 200) {
  const response = await fetch(bases[runtime] + path, { method, headers: { Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
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
  return { credential, pending, publicKey, privateKey, session, approved };
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
  for (const server of servers) { if (!server.listening) await once(server, 'listening'); bases.push(`http://127.0.0.1:${(server.address() as { port: number }).port}`); }
});
after(async () => { for (const s of servers) { s.closeAllConnections(); await new Promise<void>(resolve => s.close(() => resolve())); } await deleteApp(firebase); });
for (const runtime of [0, 1]) {
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
      await client.connect(new StreamableHTTPClientTransport(new URL(bases[runtime]+'/mcp'),{requestInit:{headers:{Authorization:`Bearer ${payload.token}`}}}));
      const tools=(await client.listTools()).tools.map(t=>t.name); assert.ok(tools.includes('create_request')); assert.ok(!tools.includes('request_sms_code'));
      await call(runtime, `/v3/connections/${first.approved.connectionId}`,owner(recipient),{capabilities:['forms','sms'],expiresAt:null},'PATCH');
      assert.ok((await client.listTools()).tools.some(t=>t.name==='request_sms_code'));
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
  const child=spawn(process.execPath,[new URL('../../cli/broker.mjs',import.meta.url).pathname],{stdio:['pipe','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.stdin.end(JSON.stringify(input));
  const [code]=await once(child,'exit');assert.equal(code,0,stderr+stdout);return JSON.parse(stdout).value;
}
test('all SDK broker bindings share durable registration, approval and credential delivery',async()=>{
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

const callback = 'https://8.8.8.8/relay-callback'; // Validation only; tests never navigate or send to this address.
async function oauthFlow(runtime: number, confidential = false) {
  time += 11 * MINUTE;
  const s = await register(runtime, false, ['forms', 'sms']);
  const client = await call(runtime, '/oauth/register', '', { client_name: 'Hosted client', redirect_uris: [callback], token_endpoint_auth_method: confidential ? 'client_secret_post' : 'none' }, 'POST', 201);
  const verifier = randomBytes(32).toString('base64url');
  const params = { response_type: 'code', client_id: client.client_id, redirect_uri: callback,
    resource: `https://relay.example/mcp/services/${s.session.serviceId}`, scope: 'forms sms', state: 'opaque-state',
    code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') };
  const response = await fetch(bases[runtime] + '/oauth/authorize?' + new URLSearchParams(params), { redirect: 'manual' });
  assert.equal(response.status, 303, await response.text());
  const location = response.headers.get('location')!;assert.ok(location.startsWith('/oauth/consent/'));
  const sessionId = location.split('/').at(-1)!;
  return { s, client, verifier, params, sessionId };
}
async function formCall(runtime: number, endpoint: string, fields: Record<string, string>, expected = 200) {
  const response = await fetch(bases[runtime] + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) });
  const value = await response.json();assert.equal(response.status, expected, JSON.stringify(value));return value;
}
async function approvedOAuth(f: Awaited<ReturnType<typeof oauthFlow>>, runtime: number, recipientUid = recipient) {
  const fields = { decision: 'approved', capabilities: ['forms'], expiresInDays: null };
  const result = await call(runtime, `/v3/oauth/sessions/${f.sessionId}/decision`, owner(recipientUid), fields);
  assert.equal(result.status,'approved');assert.ok(result.connectionId);
  const pending=(await db.collection('oauthSessions').doc(f.sessionId).get()).data()!;
  assert.equal((await db.collection('oauthCodes').doc(pending.codeHash).get()).exists,false);
  time += 2 * MINUTE; // Phone setup may take longer than the authorization-code lifetime.
  const completed = await call(runtime, `/v3/oauth/sessions/${f.sessionId}/response`, owner(recipientUid), {});
  const redirect = new URL(completed.redirect);assert.equal(redirect.origin, new URL(callback).origin);assert.equal(redirect.searchParams.get('state'), 'opaque-state');
  const again = await call(1-runtime, `/v3/oauth/sessions/${f.sessionId}/decision`, owner(recipientUid), fields);assert.deepEqual(again, result);
  const resumed = await call(1-runtime, `/v3/oauth/sessions/${f.sessionId}/response`, owner(recipientUid), {});assert.deepEqual(resumed, completed);
  return { grant_type: 'authorization_code', code: redirect.searchParams.get('code')!, client_id: f.client.client_id,
    ...(f.client.client_secret ? { client_secret: f.client.client_secret } : {}), redirect_uri: callback, resource: f.params.resource, code_verifier: f.verifier };
}
async function oauthTools(runtime: number, f: Awaited<ReturnType<typeof oauthFlow>>, token: string, expected = 200) {
  return call(runtime, `/mcp/services/${f.s.session.serviceId}`, token, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'POST', expected);
}
for (const runtime of [0, 1]) {
  test(`runtime ${runtime}: hosted discovery, PKCE, resource binding and private scoped MCP access interoperate`, async () => {
    const f = await oauthFlow(runtime, true);
    const discovery = await fetch(bases[runtime] + '/.well-known/oauth-authorization-server');assert.equal(discovery.status,200);
    assert.deepEqual((await discovery.json()).code_challenge_methods_supported,['S256']);
    const metadata = await fetch(bases[1-runtime] + `/.well-known/oauth-protected-resource/mcp/services/${f.s.session.serviceId}`);assert.equal((await metadata.json()).resource,f.params.resource);
    const challenge = await fetch(bases[runtime] + `/mcp/services/${f.s.session.serviceId}`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
    assert.equal(challenge.status,401);assert.ok(challenge.headers.get('www-authenticate')?.includes('/.well-known/oauth-protected-resource/'));
    const review = await call(runtime, `/v3/oauth/sessions/${f.sessionId}`, owner(recipient));
    assert.equal(review.name,'Personal agent');assert.equal(review.clientName,'Hosted client');
    assert.ok(!JSON.stringify(review).includes(recipient));assert.equal((await db.collection('oauthAccess').where('serviceId','==',f.s.session.serviceId).get()).size,0);
    const exchange = await approvedOAuth(f, 1-runtime);
    await formCall(runtime,'/oauth/token',{...exchange,code_verifier:'wrong'.repeat(12)},400);
    await formCall(runtime,'/oauth/token',{...exchange,resource:'https://relay.example/mcp'},400);
    await formCall(runtime,'/oauth/token',{...exchange,client_secret:'wrong'},401);
    const tokens = await formCall(runtime,'/oauth/token',exchange);
    assert.equal(tokens.scope,'forms');assert.equal(tokens.expires_in,600);
    assert.ok(!JSON.stringify(tokens).includes(recipient));
    const tools = await oauthTools(1-runtime,f,tokens.access_token);assert.equal(tools.result.tools.length,5);
    assert.ok(tools.result.tools.every((t: {name:string})=>!t.name.includes('sms')));
    await call(runtime,'/v3/connection',tokens.access_token,undefined,'GET',401);
    await call(runtime,'/mcp',tokens.access_token,{jsonrpc:'2.0',id:1,method:'tools/list'},'POST',401);
    await call(runtime,'/mcp/services/another',tokens.access_token,{jsonrpc:'2.0',id:1,method:'tools/list'},'POST',401);
    await oauthTools(runtime,f,f.s.credential,401);
    await call(runtime,`/v3/oauth/sessions/${f.sessionId}`,owner('different-recipient'),undefined,'GET',404);
    await formCall(1-runtime,'/oauth/token',exchange,400); // Authorization code replay revokes its token family.
    await oauthTools(runtime,f,tokens.access_token,401);
  });
  test(`runtime ${runtime}: refresh rotates, rejects expansion and replay invalidates the whole family`, async () => {
    const f = await oauthFlow(runtime), exchange = await approvedOAuth(f,runtime), tokens = await formCall(1-runtime,'/oauth/token',exchange);
    time += 10*MINUTE+1;await oauthTools(runtime,f,tokens.access_token,401);
    const renewal = {grant_type:'refresh_token',refresh_token:tokens.refresh_token,client_id:f.client.client_id,resource:f.params.resource};
    await formCall(runtime,'/oauth/token',{...renewal,scope:'forms sms'},400);
    const rotated = await formCall(runtime,'/oauth/token',renewal);assert.notEqual(rotated.refresh_token,tokens.refresh_token);
    assert.equal((await oauthTools(1-runtime,f,rotated.access_token)).result.tools.length,5);
    await formCall(1-runtime,'/oauth/token',renewal,400);
    await oauthTools(runtime,f,rotated.access_token,401);
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
    const bad=await fetch(bases[runtime]+'/oauth/authorize?'+new URLSearchParams({...f.params,redirect_uri:'https://8.8.4.4/wrong'}),{redirect:'manual'});assert.equal(bad.status,400);assert.equal(bad.headers.get('location'),null);
    await call(1-runtime,`/v3/oauth/sessions/${f.sessionId}/decision`,owner(recipient),{decision:'denied',capabilities:['forms'],expiresInDays:null});
    const denied=await call(runtime,`/v3/oauth/sessions/${f.sessionId}/response`,owner(recipient),{});
    assert.equal(new URL(denied.redirect).searchParams.get('error'),'access_denied');assert.equal(new URL(denied.redirect).searchParams.get('code'),null);
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
  const attempt=await fetch(bases[1]+'/oauth/authorize?'+new URLSearchParams(f.params),{redirect:'manual'});assert.equal(attempt.status,303);
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
