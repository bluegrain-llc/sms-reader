import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Relay } from '../src/relay.js';
import { app } from '../src/http.js';
import { hash, MINUTE, RelayError } from '../src/model.js';
import type { Server } from 'node:http';

const enabled = !!process.env.FIRESTORE_EMULATOR_HOST && !!process.env.FIREBASE_AUTH_EMULATOR_HOST;
if (!enabled) throw new Error('Integration tests require Firestore and Auth emulators. Run npm run test:integration from the repository root.');
const integration = test;
const collections = ['devices', 'grants', 'managers', 'managerCallers', 'connections', 'connectionCodes', 'connectionRates', 'requests', 'results', 'audit', 'accounts'];
let firebase: ReturnType<typeof initializeApp>, db: ReturnType<typeof getFirestore>, relay: Relay;
let time: number, sends: string[], token: string, grantId: string;
const uid = 'owner', did = 'installation', second = 'second-phone';
const phone = { uid, deviceId: did }, otherPhone = { uid, deviceId: second };
const input = (key: string) => ({ purpose: 'Test sign-in', idempotencyKey: key });
const reason = (value: string) => (e: unknown) => e instanceof RelayError && e.reason === value;
before(async () => {
  firebase = initializeApp({ projectId: 'demo-sms-relay' }); db = getFirestore(firebase);
});
beforeEach(async () => {
  for (const c of collections) await db.recursiveDelete(db.collection(c));
  time = 1_800_000_000_000; sends = [];
  relay = new Relay(db, async fcm => { sends.push(fcm); }, () => time);
  await relay.register(uid, did, 'First phone', 'first-fcm');
  await relay.register(uid, second, 'Second phone', 'second-fcm');
  ({ token, grantId } = await relay.createGrant(uid, did, 'First caller', 30));
});
after(async () => { if (firebase) await deleteApp(firebase); });
async function prepare(id: string, device = phone) {
  await relay.transition(device, id, 'ready', null, undefined, time);
  await relay.transition(device, id, 'awaiting_consent');
}
async function complete(key: string, secret = token) {
  const r = await relay.create(secret, input(key)); await prepare(r.requestId);
  await relay.transition(phone, r.requestId, 'completed', null, 'A12B34'); return r.requestId;
}

integration('concurrent callers queue, idempotency is stable, and promotion preserves order', async () => {
  const other = await relay.createGrant(uid, '', 'Other caller', 30);
  const rs = await Promise.all([relay.create(token, input('concurrent-one')), relay.create(other.token, input('concurrent-two'))]);
  assert.deepEqual(rs.map(r => r.status).sort(), ['pending_phone', 'queued']);
  const index = rs.findIndex(r => r.status === 'pending_phone'), secrets = [token, other.token];
  const active = rs[index]!, queued = rs[1 - index]!;
  assert.deepEqual(await relay.create(secrets[index]!, input(index === 0 ? 'concurrent-one' : 'concurrent-two')), active);
  assert.equal(sends.length, 0);
  await relay.maintenance(); assert.deepEqual(sends.sort(), ['first-fcm', 'second-fcm']);
  await relay.maintenance(); assert.equal(sends.length, 2);
  await relay.transition({ secret: secrets[index]! }, active.requestId, 'cancelled');
  assert.equal((await relay.get(secrets[1 - index]!, queued.requestId)).status, 'pending_phone');
  await relay.maintenance(); assert.equal(sends.length, 4);
  await assert.rejects(relay.create(token, { ...input('concurrent-one'), purpose: 'Changed' }), reason('idempotency_conflict'));
});
integration('phone ownership and individual consent gates; caller result isolation', async () => {
  const r = await relay.create(token, input('scope-checks'));
  const other = await relay.createGrant(uid, '', 'Other', 1);
  await assert.rejects(relay.get(other.token, r.requestId), reason('request_not_found'));
  await assert.rejects(relay.phoneGet('another-owner', did, r.requestId), reason('device_not_found'));
  await relay.register(uid, 'new-phone', 'New phone', 'new-fcm');
  await assert.rejects(relay.phoneGet(uid, 'new-phone', r.requestId), reason('request_not_found'));
  await assert.rejects(relay.transition({ secret: token }, r.requestId, 'ready'), reason('agent_cannot_submit'));
  await assert.rejects(relay.transition(phone, r.requestId, 'completed', null, '123456'), reason('invalid_transition'));
  await prepare(r.requestId);
  await assert.rejects(relay.transition(otherPhone, r.requestId, 'completed', null, '123456'), reason('invalid_transition'));
  assert.equal((await relay.get(token, r.requestId)).code, undefined);
  await relay.transition(phone, r.requestId, 'completed', null, '123456');
  const losingPhone = await relay.phoneGet(uid, second, r.requestId);
  assert.equal(losingPhone.reason, 'handled_on_another_device'); assert.equal('code' in losingPhone, false);
  assert.equal((await relay.get(token, r.requestId)).code, '123456');
});
integration('simultaneous approvals yield one result, with safe duplicate uploads', async () => {
  const r = await relay.create(token, input('racing-approvals'));
  await prepare(r.requestId); await prepare(r.requestId, otherPhone);
  await Promise.all([relay.transition(phone, r.requestId, 'completed', null, 'A12B34'), relay.transition(otherPhone, r.requestId, 'completed', null, '987654')]);
  const result = await relay.get(token, r.requestId);
  assert.ok(['A12B34', '987654'].includes(result.code!));
  const winner = result.code === 'A12B34' ? phone : otherPhone;
  await relay.transition(winner, r.requestId, 'completed', null, result.code);
  await assert.rejects(relay.transition(winner, r.requestId, 'completed', null, '111111'), reason('upload_conflict'));
  const requests = await db.collection('requests').get(), audit = await db.collection('audit').get();
  const metadata = JSON.stringify([...requests.docs, ...audit.docs].map(d => d.data()));
  assert.ok(!metadata.includes(result.code!));
  time += 2 * MINUTE;
  assert.equal((await relay.get(token, r.requestId)).status, 'expired');
  assert.equal((await db.collection('results').doc(r.requestId).get()).exists, false);
});
integration('manual entry requires a ready participating phone and preserves caller isolation', async () => {
  const r = await relay.create(token, { ...input('manual-entry'), title: 'Verify Bizee', purpose: '## Sign in\n\nEnter the **SMS code**.' });
  await assert.rejects(relay.transition(phone, r.requestId, 'completed', null, '123456', undefined, 'manual'), reason('invalid_transition'));
  await relay.transition(phone, r.requestId, 'ready', null, undefined, time);
  const visible = await relay.phoneGet(uid, did, r.requestId);
  assert.equal(visible.title, 'Verify Bizee'); assert.equal(visible.purpose, '## Sign in\n\nEnter the **SMS code**.');
  await assert.rejects(relay.transition(otherPhone, r.requestId, 'completed', null, '123456', undefined, 'manual'), reason('invalid_transition'));
  assert.equal((await relay.get(token, r.requestId)).code, undefined);
  await relay.transition(phone, r.requestId, 'completed', null, 'A12b34', undefined, 'manual');
  assert.equal((await relay.get(token, r.requestId)).code, 'A12b34');
  assert.equal((await db.collection('requests').doc(r.requestId).get()).data()!.submissionSource, 'manual');
  await relay.transition(phone, r.requestId, 'completed', null, 'A12b34', undefined, 'manual');
  await assert.rejects(relay.transition(phone, r.requestId, 'completed', null, '654321', undefined, 'manual'), reason('upload_conflict'));
  const other = await relay.createGrant(uid, '', 'Another bot', 1);
  await assert.rejects(relay.get(other.token, r.requestId), reason('request_not_found'));
});
integration('request Markdown is bounded and title is part of idempotency', async () => {
  const body = '## Verification\n\n' + 'Read this explanation. '.repeat(100);
  const r = await relay.create(token, { ...input('markdown-long'), title: 'Sign in', purpose: body });
  assert.equal((await relay.phoneGet(uid, did, r.requestId)).purpose, body.trim());
  assert.equal((await relay.create(token, { ...input('markdown-long'), title: 'Sign in', purpose: body })).requestId, r.requestId);
  await assert.rejects(relay.create(token, { ...input('markdown-long'), title: 'Changed', purpose: body }), reason('idempotency_conflict'));
  await assert.rejects(relay.create(token, { ...input('markdown-limit'), purpose: 'x'.repeat(4001) }));
});
integration('declining or stopping on one phone leaves the other available', async () => {
  const r = await relay.create(token, input('one-phone-stops'));
  const local = await relay.transition(phone, r.requestId, 'cancelled'); assert.equal(local.status, 'cancelled');
  assert.equal((await relay.get(token, r.requestId)).status, 'pending_phone');
  await prepare(r.requestId, otherPhone);
  await relay.transition(otherPhone, r.requestId, 'denied');
  assert.equal((await relay.get(token, r.requestId)).status, 'denied');
  assert.equal((await db.collection('results').doc(r.requestId).get()).exists, false);
});
integration('pause/removal affects only that phone and preserves account caller credentials', async () => {
  const r = await relay.create(token, input('pause-one-phone'));
  await prepare(r.requestId);
  await relay.changeDevice(uid, did, true);
  assert.equal((await relay.get(token, r.requestId)).status, 'pending_phone');
  await prepare(r.requestId, otherPhone); await relay.transition(otherPhone, r.requestId, 'completed', null, '123456');
  await relay.changeDevice(uid, did, true, true);
  await relay.checkAgent(token);
  const next = await relay.create(token, input('after-device-removal'));
  const record = (await db.collection('requests').doc(next.requestId).get()).data()!;
  assert.deepEqual(record.deviceIds, [second]);
  await assert.rejects(relay.phoneGet(uid, did, next.requestId), reason('device_not_found'));
  time += 5 * MINUTE; await relay.maintenance();
  await relay.changeDevice(uid, second, true);
  assert.equal((await relay.get(token, next.requestId)).status, 'cancelled');
});
integration('FCM leases retry only failed phones and never notify queued requests', async () => {
  const attempts: string[] = [];
  const flaky = new Relay(db, async fcm => { attempts.push(fcm); if (fcm === 'second-fcm' && attempts.filter(x => x === fcm).length === 1) throw Error('offline'); }, () => time);
  const r = await flaky.create(token, input('delivery-retries'));
  await flaky.create(token, input('queued-no-notify'));
  await Promise.all([flaky.deliver(r.requestId), flaky.deliver(r.requestId)]);
  assert.deepEqual(attempts.sort(), ['first-fcm', 'second-fcm']);
  time += MINUTE; await flaky.maintenance();
  assert.equal(attempts.filter(x => x === 'first-fcm').length, 1);
  assert.equal(attempts.filter(x => x === 'second-fcm').length, 2);
  assert.equal((await db.collection('requests').doc(r.requestId).get()).data()?.notificationSent, true);
});
integration('listener deadlines do not restart; queue and results have hard expiry', async () => {
  const r = await relay.create(token, input('ready-deadline'));
  await assert.rejects(relay.transition(phone, r.requestId, 'ready', null, undefined, time - 2 * MINUTE), reason('listener_start_stale'));
  const ready = await relay.transition(phone, r.requestId, 'ready', null, undefined, time);
  time += MINUTE;
  assert.equal((await relay.transition(phone, r.requestId, 'ready', null, undefined, time)).listeningDeadline, ready.listeningDeadline);
  const q = await relay.create(token, input('queued-deadline'));
  time += 4 * MINUTE;
  assert.equal((await relay.get(token, r.requestId)).status, 'expired');
  await relay.maintenance(); assert.equal((await relay.get(token, q.requestId)).status, 'pending_phone');
  time += 6 * MINUTE; await relay.maintenance();
  assert.equal((await relay.get(token, q.requestId)).status, 'expired');
  const id = await complete('cleanup-code'); time += 2 * MINUTE; await relay.maintenance();
  assert.equal((await db.collection('results').doc(id).get()).exists, false);
});
integration('queued callers wait until at least one prior Android listening window ends', async () => {
  const r = await relay.create(token, input('both-phones-listening'));
  await prepare(r.requestId); await prepare(r.requestId, otherPhone);
  await relay.transition(phone, r.requestId, 'completed', null, '123456');
  const next = await relay.create(token, input('wait-listener-cooldown'));
  assert.equal(next.status, 'queued');
  await relay.maintenance(); assert.equal(sends.length, 0);
  time += 5 * MINUTE; await relay.maintenance();
  assert.equal((await relay.get(token, next.requestId)).status, 'pending_phone');
  assert.deepEqual(sends.sort(), ['first-fcm', 'second-fcm']);
});
integration('queued activation uses current devices after the original phones are removed', async () => {
  const r = await relay.create(token, input('original-phone-request'));
  const queued = await relay.create(token, input('queued-new-phone'));
  await relay.register(uid, 'replacement', 'Replacement', 'replacement-fcm');
  await relay.changeDevice(uid, did, true, true); await relay.changeDevice(uid, second, true, true);
  assert.equal((await relay.get(token, r.requestId)).status, 'cancelled');
  assert.equal((await relay.get(token, queued.requestId)).status, 'pending_phone');
  const record = (await db.collection('requests').doc(queued.requestId).get()).data()!;
  assert.deepEqual(record.deviceIds, ['replacement']);
});
integration('connection approval binds one bot to the deciding account without exposing a credential on the phone', async () => {
  const c = await relay.connections.start('source', { callerName: 'Invoice bot', purpose: 'Receive sign-in codes' });
  await assert.rejects(relay.checkAgent(c.connectionToken), reason('invalid_token'));
  const review = await relay.connections.owner(uid, c.userCode);
  assert.equal(review.status, 'pending'); assert.equal('connectionToken' in review, false);
  const approved = await relay.connections.owner(uid, c.userCode, 'approved');
  assert.equal(approved.status, 'approved'); assert.equal('token' in approved, false);
  assert.deepEqual(await relay.connections.owner(uid, c.userCode, 'approved'), approved);
  assert.equal((await relay.connections.poll(c.connectionToken)).status, 'approved');
  await relay.checkAgent(c.connectionToken);
  const r = await relay.create(c.connectionToken, input('paired-bot-request'));
  assert.deepEqual((await db.collection('requests').doc(r.requestId).get()).data()?.deviceIds, [did, second]);
  await assert.rejects(relay.connections.owner('other-owner', c.userCode), reason('connection_not_found'));
  const stored = JSON.stringify((await db.collection('connections').get()).docs.map(d => d.data()));
  assert.ok(!stored.includes(c.connectionToken));
});
integration('denial and expiry never produce a grant; polling is paced and secret-bound', async () => {
  const c = await relay.connections.start('source', { callerName: 'Bot', purpose: 'Sign in' });
  assert.equal((await relay.connections.poll(c.connectionToken)).status, 'pending');
  await assert.rejects(relay.connections.poll(c.connectionToken), reason('slow_down'));
  await relay.connections.owner(uid, c.userCode, 'denied'); time += 5_000;
  assert.equal((await relay.connections.poll(c.connectionToken)).status, 'denied');
  await relay.connections.owner(uid, c.userCode, 'approved');
  await assert.rejects(relay.checkAgent(c.connectionToken), reason('invalid_token'));
  await assert.rejects(relay.connections.poll(token), reason('invalid_connection_token'));
  const expired = await relay.connections.start('source', { callerName: 'Expired', purpose: 'Sign in' });
  time += 10 * MINUTE;
  assert.equal((await relay.connections.owner(uid, expired.userCode, 'approved')).status, 'expired');
  assert.equal((await relay.connections.poll(expired.connectionToken)).status, 'expired');
  await assert.rejects(relay.checkAgent(expired.connectionToken), reason('invalid_token'));
});
integration('two accounts racing to approve have only one owner and one grant', async () => {
  const c = await relay.connections.start('source', { callerName: 'Racing bot', purpose: 'Connect account' });
  const decisions = await Promise.allSettled([relay.connections.owner(uid, c.userCode, 'approved'), relay.connections.owner('other-owner', c.userCode, 'approved')]);
  assert.equal(decisions.filter(r => r.status === 'fulfilled').length, 1);
  const grant = (await relay.db.collection('grants').doc(hash(c.connectionToken)).get()).data()!;
  assert.ok([uid, 'other-owner'].includes(grant.ownerId));
  assert.equal((await relay.connections.poll(c.connectionToken)).status, 'approved');
});
integration('a paired credential is isolated and revocation blocks its completed result', async () => {
  const a = await relay.connections.start('source', { callerName: 'Bot A', purpose: 'Sign in' });
  const b = await relay.connections.start('source', { callerName: 'Bot B', purpose: 'Sign in' });
  const approved = await relay.connections.owner(uid, a.userCode, 'approved');
  await relay.connections.owner(uid, b.userCode, 'approved');
  const id = await complete('paired-completed-code', a.connectionToken);
  await assert.rejects(relay.get(b.connectionToken, id), reason('request_not_found'));
  await relay.revoke(uid, approved.connectionId!);
  await assert.rejects(relay.get(a.connectionToken, id), reason('invalid_token'));
  assert.equal((await relay.connections.poll(a.connectionToken)).status, 'revoked');
  assert.equal((await relay.connections.owner(uid, a.userCode)).status, 'revoked');
  await relay.checkAgent(b.connectionToken);
});
integration('persistent public/owner connection limits count invalid guesses and resist forwarded headers', async () => {
  for (let i = 0; i < 30; i++) await assert.rejects(relay.connections.owner(uid, 'AAAAAAAAAA'), reason('connection_not_found'));
  await assert.rejects(relay.connections.owner(uid, 'BBBBBBBBBB'), reason('rate_limited'));
  for (let i = 0; i < 60; i++) await relay.connections.start('one-source', { callerName: 'Bot', purpose: 'Sign in' });
  await assert.rejects(relay.connections.start('one-source', { callerName: 'Bot', purpose: 'Sign in' }), reason('rate_limited'));
  time += 11 * MINUTE;
  await relay.connections.start('one-source', { callerName: 'Bot', purpose: 'New window' });
  await relay.maintenance();
  assert.equal((await db.collection('connectionCodes').get()).size, 1);
});
integration('cancellation racing an upload cannot revive a request', async () => {
  const r = await relay.create(token, input('cancel-upload-race')); await prepare(r.requestId);
  await Promise.all([relay.transition({ secret: token }, r.requestId, 'cancelled'), relay.transition(phone, r.requestId, 'completed', null, '123456')]);
  const final = await relay.get(token, r.requestId);
  assert.ok(['completed', 'cancelled'].includes(final.status)); assert.equal(final.status === 'completed', !!final.code);
});
integration('caller and account quotas survive cancellation, rotation and device changes', async () => {
  for (let i = 0; i < 3; i++) {
    const r = await relay.create(token, input(`caller-quota-${i}`)); await relay.transition({ secret: token }, r.requestId, 'cancelled');
  }
  await assert.rejects(relay.create(token, input('caller-quota-end')), reason('rate_limited'));
  const other = await relay.createGrant(uid, '', 'Other', 1);
  for (let i = 0; i < 2; i++) {
    const r = await relay.create(other.token, input(`account-quota-${i}`)); await relay.transition({ secret: other.token }, r.requestId, 'cancelled');
  }
  const third = await relay.createGrant(uid, '', 'Third', 1);
  await assert.rejects(relay.create(third.token, input('account-quota-end')), reason('rate_limited'));
  time += 11 * MINUTE; assert.equal((await relay.create(third.token, input('quota-window-reset'))).status, 'pending_phone');
});
integration('REST role separation and bearer-authenticated MCP, including queued requests', async () => {
  const auth = getAuth(firebase), custom = await auth.createCustomToken(uid);
  const login = await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=demo`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: custom, returnSecureToken: true }),
  });
  const { idToken } = await login.json() as { idToken: string };
  let server: Server | undefined;
  const client = new Client({ name: 'test', version: '1' });
  try {
    server = app(relay, { publicUrl: 'https://relay.example.test', androidCertSha256: Array(32).fill('AA').join(':'), verifyOwner: async token => { const u = await auth.verifyIdToken(token); return { uid: u.uid, authTime: u.auth_time }; },
      verifyScheduler: async () => { throw Error('not scheduler'); }, deleteIdentity: uid => auth.deleteUser(uid) }).listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server!.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const call = (path: string, credential: string, body?: object) => fetch(base + path, { method: body ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal((await fetch(base + '/v1/devices')).status, 401);
    assert.equal((await call('/v1/devices', token)).status, 401);
    assert.equal((await call('/v1/devices', idToken)).status, 200);
    assert.equal((await call('/v1/managers', idToken, {})).status, 404);
    assert.equal((await call('/v1/manager/callers', token, { callerId: 'bad', callerName: 'Bad' })).status, 404);
    const connectionResponse = await fetch(base + '/v1/connections', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ callerName: 'HTTP bot', purpose: 'Receive codes' }) });
    assert.equal(connectionResponse.status, 201);
    const c = await connectionResponse.json() as { connectionToken: string; userCode: string; verificationUri: string };
    assert.ok(!c.verificationUri.includes(c.connectionToken));
    assert.equal((await call('/v1/connections/decision', token, { userCode: c.userCode, decision: 'approved' })).status, 401);
    assert.equal((await call('/v1/connections/decision', idToken, { userCode: c.userCode, decision: 'approved' })).status, 200);
    const child = { token: c.connectionToken };
    const page = await fetch(base + '/connect?code=' + c.userCode);
    assert.equal(page.status, 200); assert.ok((await page.text()).includes('smsrelay://connect?code='));
    const links = await fetch(base + '/.well-known/assetlinks.json'); assert.equal(links.status, 200);
    await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { authorization: `Bearer ${child.token}` } } }));
    assert.equal((await client.listTools()).tools.length, 3);
    const tool = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args }); return JSON.parse((result.content as { text: string }[])[0]!.text);
    };
    const r = await tool('request_sms_code', input('mcp-smoke-request'));
    assert.equal(r.status, 'pending_phone'); assert.equal(r.code, undefined);
    const q = await tool('request_sms_code', input('mcp-queued-request')); assert.equal(q.status, 'queued');
    const event = (body: object, credential = idToken) => call(`/v1/devices/${did}/requests/${r.requestId}/events`, credential, body);
    assert.equal((await event({ status: 'ready', listenerStartedAt: time }, child.token)).status, 401);
    assert.equal((await event({ status: 'ready', listenerStartedAt: time })).status, 200);
    assert.equal((await event({ status: 'completed', code: '654321' })).status, 409);
    assert.equal((await event({ status: 'awaiting_consent' })).status, 200);
    assert.equal((await tool('get_sms_code_request', { requestId: r.requestId })).code, undefined);
    assert.equal((await event({ status: 'completed', code: '654321' })).status, 200);
    assert.equal((await tool('get_sms_code_request', { requestId: r.requestId })).code, '654321');
    assert.equal((await tool('get_sms_code_request', { requestId: q.requestId })).status, 'pending_phone');
    const manualEvent = (body: object, credential = idToken) => call(`/v1/devices/${did}/requests/${q.requestId}/events`, credential, body);
    assert.equal((await manualEvent({ status: 'completed', source: 'manual', code: 'A12b34' }, child.token)).status, 401);
    assert.equal((await manualEvent({ status: 'completed', source: 'manual', code: 'A12b34' })).status, 409);
    assert.equal((await manualEvent({ status: 'ready', listenerStartedAt: time })).status, 200);
    assert.equal((await manualEvent({ status: 'completed', source: 'unknown', code: 'A12b34' })).status, 400);
    assert.equal((await manualEvent({ status: 'completed', source: 'manual', code: '12345678901' })).status, 400);
    assert.equal((await manualEvent({ status: 'completed', source: 'manual', code: 'A12b34' })).status, 200);
    assert.equal((await tool('get_sms_code_request', { requestId: q.requestId })).code, 'A12b34');
    const { connectSmsRelay } = await import('../../examples/connect.mjs');
    const saved: { token: string; status: string }[] = [];
    const paired = await connectSmsRelay({ baseUrl: base, callerName: 'Example app', purpose: 'Connect from helper',
      signal: AbortSignal.timeout(15_000),
      saveCredential: async (value: { token: string; status: string }) => { saved.push(value); },
      showConnection: async (value: { url: string; userCode: string }) => {
        assert.equal('token' in value, false);
        assert.ok(!value.url.includes(saved[0]!.token));
        const result = await call('/v1/connections/decision', idToken, { userCode: value.userCode, decision: 'approved' });
        assert.equal(result.status, 200);
      },
    });
    assert.deepEqual(saved.map(x => x.status), ['pending', 'approved']); assert.equal(paired, saved[0]!.token);
    await relay.checkAgent(paired);
    await db.collection('connectionRates').doc(hash(`source:127.0.0.1:${Math.floor(time / (10 * MINUTE))}`)).set({ start: time, count: 60, purgeAt: new Date(time + 10 * MINUTE) });
    assert.equal((await fetch(base + '/v1/connections', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '192.0.2.99' },
      body: JSON.stringify({ callerName: 'Spoofed source', purpose: 'Try another IP' }) })).status, 429);
    assert.equal((await fetch(base + '/health', { headers: { origin: 'https://untrusted.example' } })).status, 403);
  } finally { await client.close(); await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve()); }
});
integration('account deletion removes pairings and all phones, and prevents stale resurrection', async () => {
  const c = await relay.connections.start('source', { callerName: 'Bot', purpose: 'Delete test' });
  await relay.connections.owner(uid, c.userCode, 'approved');
  await complete('delete-result');
  await relay.deleteAccount(uid);
  for (const c of collections.filter(c => c !== 'accounts' && c !== 'connectionRates')) assert.equal((await db.collection(c).where('ownerId', '==', uid).get()).empty, true);
  await assert.rejects(relay.register(uid, 'brand-new', 'Stale phone', 'fcm'), reason('account_deleted'));
  await assert.rejects(relay.connections.poll(c.connectionToken), reason('invalid_connection_token'));
});
