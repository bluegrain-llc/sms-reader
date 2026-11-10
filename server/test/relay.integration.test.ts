import { Telemetry } from '../src/telemetry.js';
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
const collections = ['devices', 'grants', 'managers', 'managerCallers', 'connections', 'connectionCodes', 'connectionRates', 'requests', 'results', 'audit', 'accounts', 'formRequests', 'formResults', 'requestEvents', 'deliveryOutbox', 'deletionJobs'];
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
    assert.equal((await client.listTools()).tools.length, 8);
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
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const { fileURLToPath } = await import('node:url');
    const smoke = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../../examples/mcp-smoke.mjs', import.meta.url))], {
      env: { ...process.env, RELAY_URL: base, RELAY_TOKEN: child.token }, timeout: 20_000,
    });
    assert.match(smoke.stdout, /Authenticated MCP create\/cancel passed/);
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

const formInput = (key: string) => ({ title: 'Review invoice', body: '**Invoice** details', idempotencyKey: key,
  fields: [{ id: 'note', label: 'Note', type: 'text' as const, required: true }],
  actions: [{ id: 'approve', label: 'Approve', type: 'approve' as const }, { id: 'decline', label: 'Decline', type: 'decline' as const }] });
const formUpload = (id: string, note = 'Approved') => ({ submissionId: id, action: 'approve', values: { note } });
async function allowForms() { await relay.forms.approve(uid, grantId, true); }
integration('general requests require separate approval and coexist with SMS and other forms', async () => {
  await assert.rejects(relay.forms.create(token, formInput('forms-permission')), reason('forms_approval_required'));
  await allowForms();
  const sms = await relay.create(token, input('sms-alongside-form'));
  const forms = await Promise.all(['form-concurrent-1', 'form-concurrent-2', 'form-concurrent-3'].map(k => relay.forms.create(token, formInput(k))));
  assert.ok(forms.every(r => r.status === 'pending'));
  const inbox = await relay.forms.inbox(uid, did);
  assert.equal(inbox.length, 3);
  assert.equal('body' in inbox[0]!, false); assert.equal('fields' in inbox[0]!, false); // The list carries summaries only.
  assert.equal((await relay.get(token, sms.requestId)).status, 'pending_phone');
  const anotherSms = await relay.create(token, input('sms-quota-independent-of-forms'));
  assert.equal(anotherSms.status, 'queued');
  assert.deepEqual(await relay.forms.create(token, formInput('form-concurrent-1')), forms[0]);
  await assert.rejects(relay.forms.create(token, { ...formInput('form-concurrent-1'), body: 'Changed' }), reason('idempotency_conflict'));
  const before = await relay.forms.events(token);
  await relay.forms.get(phone, forms[0]!.requestId);
  assert.deepEqual(await relay.forms.events(token), before); // Fetching is never opening.
  assert.equal((await relay.forms.get({ secret: token }, forms[0]!.requestId)).firstOpenedAt, null);
});
integration('taps and foreground openings dedupe per device and preserve offline observed times', async () => {
  await allowForms(); const r = await relay.forms.create(token, formInput('tap-open-distinct'));
  await relay.forms.observe(uid, did, r.requestId, { type: 'notification.tapped', occurredAt: time });
  assert.equal((await relay.forms.get({ secret: token }, r.requestId)).firstOpenedAt, null);
  time += 1000;
  await relay.forms.observe(uid, second, r.requestId, { type: 'request.opened', occurredAt: time });
  time += 1000;
  await relay.forms.submit(uid, did, r.requestId, formUpload('offline-upload'));
  await Promise.all([1, 2].map(() => relay.forms.observe(uid, did, r.requestId, { type: 'request.opened', occurredAt: time - 1500 })));
  const opened = await relay.forms.get({ secret: token }, r.requestId); assert.equal(opened.firstOpenedAt, time - 1500);
  const events = (await relay.forms.events(token)).events;
  assert.equal(events.filter(e => e.type === 'request.opened').length, 2);
  assert.equal(events.filter(e => e.type === 'notification.tapped').length, 1);
  assert.deepEqual(events.map(e => e.sequence), [1, 2, 3, 4, 5]);
  assert.ok(!JSON.stringify(events).includes('Approved'));
  const independent = new Relay(db, async () => {}, () => time);
  assert.deepEqual((await independent.forms.events(token, events[1]!.id)).events, events.slice(2));
});
integration('first valid form submission wins across phones; retries are bound to ID and payload', async () => {
  await allowForms(); const r = await relay.forms.create(token, formInput('first-form-wins'));
  await assert.rejects(relay.forms.submit(uid, did, r.requestId, { submissionId: 'invalid', action: 'approve', values: {} }), reason('required_field'));
  const uploads = [formUpload('upload-a', 'First'), formUpload('upload-b', 'Second')];
  const responses = await Promise.all([relay.forms.submit(uid, did, r.requestId, uploads[0]!), relay.forms.submit(uid, second, r.requestId, uploads[1]!)]);
  assert.ok(responses.every(r => r.status === 'submitted'));
  const stored = (await db.collection('formRequests').doc(r.requestId).get()).data()!;
  const winner = stored.winner.deviceId === did ? 0 : 1, device = winner === 0 ? did : second;
  assert.equal((await relay.forms.result(token, r.requestId)).result?.values.note, uploads[winner]!.values.note);
  assert.equal((await relay.forms.events(token)).events.filter(e => e.type === 'request.submitted').length, 1);
  await relay.forms.submit(uid, device, r.requestId, uploads[winner]!);
  await assert.rejects(relay.forms.submit(uid, device, r.requestId, { ...uploads[winner]!, values: { note: 'Changed' } }), reason('submission_conflict'));
  time += 24 * 60 * MINUTE;
  assert.equal((await relay.forms.result(token, r.requestId)).result, null);
  assert.equal((await relay.forms.get({ secret: token }, r.requestId)).status, 'submitted');
  await relay.forms.maintenance(); assert.equal((await db.collection('formResults').doc(r.requestId).get()).exists, false);
});
integration('form requests, answers, events, cursors, and subscriptions are caller-isolated', async () => {
  await allowForms(); const r = await relay.forms.create(token, formInput('isolated-form'));
  const other = await relay.createGrant(uid, '', 'Other caller', 30); await relay.forms.approve(uid, other.grantId, true);
  await relay.forms.submit(uid, did, r.requestId, formUpload('private-answer'));
  for (const op of [() => relay.forms.get({ secret: other.token }, r.requestId), () => relay.forms.result(other.token, r.requestId), () => relay.forms.cancel(other.token, r.requestId)]) await assert.rejects(op(), reason('request_not_found'));
  assert.deepEqual((await relay.forms.events(other.token)).events, []);
  await assert.rejects(relay.forms.events(other.token, (await relay.forms.events(token)).events[0]!.id), reason('invalid_cursor'));
  await relay.register('unrelated', 'unrelated-phone', 'Unrelated', 'fcm');
  await assert.rejects(relay.forms.get({ uid: 'unrelated', deviceId: 'unrelated-phone' }, r.requestId), reason('request_not_found'));
  assert.equal((await relay.forms.inbox('unrelated', 'unrelated-phone')).length, 0);
  await assert.rejects(relay.forms.approve('unrelated', grantId, true), reason('grant_not_found'));
});
integration('decline, cancellation races, expiry and removal of form access never revive requests', async () => {
  await allowForms();
  const declined = await relay.forms.create(token, formInput('form-decline'));
  assert.equal((await relay.forms.submit(uid, did, declined.requestId, { submissionId: 'declining', action: 'decline', values: {} })).status, 'declined');
  assert.equal((await relay.forms.result(token, declined.requestId)).result, null);
  const race = await relay.forms.create(token, formInput('form-cancel-race'));
  await Promise.all([relay.forms.cancel(token, race.requestId), relay.forms.submit(uid, did, race.requestId, formUpload('racing-upload'))]);
  const result = await relay.forms.result(token, race.requestId);
  assert.ok(['submitted', 'cancelled'].includes(result.status)); assert.equal(result.status === 'submitted', !!result.result);
  const exp = await relay.forms.create(token, { ...formInput('form-short-expiry'), expiresInSeconds: 60 });
  time += MINUTE;
  assert.equal((await relay.forms.submit(uid, did, exp.requestId, formUpload('too-late'))).status, 'expired');
  const pending = await relay.forms.create(token, formInput('remove-forms-access'));
  await relay.forms.approve(uid, grantId, false);
  assert.equal((await relay.forms.get(phone, pending.requestId)).status, 'cancelled');
  await assert.rejects(relay.forms.events(token), reason('forms_approval_required'));
  await relay.checkAgent(token); // SMS permission remains valid.
});
integration('SMS helper readiness and timeout are independent of the form deadline and SMS capture is serialized', async () => {
  await allowForms();
  const r = await relay.forms.create(token, { ...formInput('form-sms-helper'), fields: [{ id: 'code', type: 'text', input: 'sms_code', label: 'Code', required: true }] });
  const next = await relay.forms.create(token, { ...formInput('form-next-helper'), fields: [{ id: 'code', type: 'text', input: 'sms_code', label: 'Code' }] });
  const ready = { type: 'input.ready' as const, fieldId: 'code', listenerStartedAt: time };
  await relay.forms.observe(uid, did, r.requestId, ready);
  await relay.forms.observe(uid, did, r.requestId, ready);
  await assert.rejects(relay.forms.observe(uid, did, next.requestId, ready), reason('sms_listener_busy'));
  await assert.rejects(relay.forms.observe(uid, second, next.requestId, ready), reason('sms_listener_busy'));
  await relay.forms.observe(uid, second, r.requestId, ready); // Multiple phones can listen for the same helper.
  const sms = await relay.create(token, input('helper-blocks-legacy-listener'));
  assert.equal(sms.status, 'queued');
  await assert.rejects(relay.transition(phone, sms.requestId, 'ready', null, undefined, time), reason('request_not_ready'));
  await relay.forms.submit(uid, second, next.requestId, { submissionId: 'manual-no-listener', action: 'approve', values: { code: '123456' } });
  time += 5 * MINUTE; await relay.forms.maintenance(); await relay.forms.maintenance();
  assert.equal((await relay.forms.get(phone, r.requestId)).status, 'pending');
  await assert.rejects(relay.forms.observe(uid, did, r.requestId, { ...ready, listenerStartedAt: time }), reason('input_already_started'));
  const events = (await relay.forms.events(token)).events.filter(e => e.requestId === r.requestId);
  assert.equal(events.filter(e => e.type === 'input.ready').length, 2);
  assert.equal(events.filter(e => e.type === 'input.timeout').length, 2);
  await relay.forms.submit(uid, did, r.requestId, { submissionId: 'after-helper-timeout', action: 'approve', values: { code: '654321' } });
  assert.equal((await relay.forms.result(token, r.requestId)).result?.values.code, '654321');
});
integration('transactional outbox leases tolerate duplicate workers, failures and a lost wakeup', async () => {
  await allowForms();
  const { Forms } = await import('../src/forms.js');
  let callbacks: { id: string; type: string }[] = [], fail = true;
  const forms = new Forms(relay, async () => { throw Error('tasks temporarily down'); }, async (_url, _secret, event) => {
    callbacks.push(event as { id: string; type: string }); if (fail) { fail = false; throw Error('timeout'); }
  });
  const hook = await forms.registerWebhook(token, { url: 'https://8.8.8.8/callback', events: ['request.created', 'request.submitted', 'notification.accepted'] });
  assert.ok(hook.secret); assert.equal('secret' in (await forms.webhooks(token))[0]!, false);
  const r = await forms.create(token, formInput('durable-outbox'));
  const jobs = await db.collection('deliveryOutbox').get(); assert.equal(jobs.size, 3);
  await Promise.all(jobs.docs.flatMap(d => [forms.deliver(d.id), forms.deliver(d.id)]));
  assert.equal(sends.length, 2); assert.equal(callbacks.length, 1);
  await forms.submit(uid, did, r.requestId, formUpload('webhook-submit'));
  await forms.maintenance(); // Submission callback can arrive before the failed created callback.
  assert.ok(callbacks.some(e => e.type === 'request.submitted'));
  time += MINUTE; await forms.maintenance();
  const created = callbacks.filter(e => e.type === 'request.created');
  assert.equal(created.length, 2); assert.equal(created[0]!.id, created[1]!.id);
  assert.equal((await db.collection('deliveryOutbox').get()).size, 0);
  const events = (await forms.events(token)).events;
  assert.equal(events.filter(e => e.type === 'notification.accepted').length, 2);
  assert.ok(!JSON.stringify(callbacks).includes('Approved'));
  await forms.webhooks(token, hook.id); assert.equal((await forms.webhooks(token)).length, 0);
});
integration('v2 REST, MCP, and SSE authenticate, replay from durable storage and close before request timeout', async () => {
  await allowForms(); let server: Server | undefined, secondServer: Server | undefined;
  const options = { verifyOwner: async (secret: string) => { if (secret !== 'owner-session') throw Error('bad owner'); return { uid, authTime: time / 1000 }; },
    verifyScheduler: async () => { throw Error('bad worker'); }, deleteIdentity: async () => {}, sseDurationMs: 100 };
  const client = new Client({ name: 'forms-test', version: '1' });
  try {
    server = app(relay, options).listen(0, '127.0.0.1');
    secondServer = app(new Relay(db, async () => {}, () => time), options).listen(0, '127.0.0.1');
    await Promise.all([server, secondServer].map(s => new Promise<void>(resolve => s!.once('listening', resolve))));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const base2 = `http://127.0.0.1:${(secondServer.address() as { port: number }).port}`;
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const created = await fetch(base + '/v2/requests', { method: 'POST', headers, body: JSON.stringify(formInput('rest-forms')) }); assert.equal(created.status, 201);
    const r = await created.json() as { requestId: string };
    assert.equal((await fetch(base + `/v2/devices/${did}/inbox`, { headers })).status, 401);
    assert.equal((await fetch(base + `/v2/devices/${did}/inbox`, { headers: { authorization: 'Bearer owner-session' } })).status, 200);
    const first = await fetch(base + '/v2/events/stream', { headers });
    const stream = await first.text(); assert.ok(stream.includes('event: request.created')); assert.ok(stream.includes(': heartbeat'));
    const cursor = (await relay.forms.events(token)).cursor!;
    const submit = await fetch(base + `/v2/devices/${did}/requests/${r.requestId}/submissions`, { method: 'POST', headers: { ...headers, authorization: 'Bearer owner-session' }, body: JSON.stringify(formUpload('rest-upload')) }); assert.equal(submit.status, 200);
    const replay = await fetch(base2 + '/v2/events/stream', { headers: { ...headers, 'Last-Event-ID': cursor } });
    const replayed = await replay.text(); assert.ok(replayed.includes('event: request.submitted')); assert.ok(!replayed.includes('event: request.created')); assert.ok(!replayed.includes('Approved'));
    assert.equal((await fetch(base + '/v2/events/stream?cursor=bogus', { headers })).status, 400);
    await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers } }));
    const result = await client.callTool({ name: 'get_request_result', arguments: { requestId: r.requestId } });
    assert.equal(JSON.parse((result.content as { text: string }[])[0]!.text).result.values.note, 'Approved');
    const ownerHeaders = { ...headers, authorization: 'Bearer owner-session' };
    assert.equal((await fetch(base + `/v1/devices/${did}`, { method: 'PUT', headers: ownerHeaders,
      body: JSON.stringify({ name: 'Wizard phone', fcmToken: 'first-fcm', wizardVersion: 1 }) })).status, 200);
    const wizard = await client.callTool({ name: 'create_request', arguments: wizardInput('mcp-wizard') });
    assert.equal(wizard.isError, undefined);
    const w = JSON.parse((wizard.content as { text: string }[])[0]!.text);
    assert.equal(w.steps[1].when.equals, true);
    const inspected = await fetch(base + `/v2/devices/${did}/requests/${w.requestId}`, { headers: ownerHeaders });
    assert.equal((await inspected.json() as { steps: unknown[] }).steps.length, 2);
    assert.equal((await fetch(base + `/v2/devices/${did}/requests/${w.requestId}/submissions`, { method: 'POST', headers: ownerHeaders,
      body: JSON.stringify({ submissionId: 'wizard-via-rest', action: 'approve', values: { travel: false } }) })).status, 200);
    const wizardResult = await client.callTool({ name: 'get_request_result', arguments: { requestId: w.requestId } });
    assert.deepEqual(JSON.parse((wizardResult.content as { text: string }[])[0]!.text).result.values, { travel: false });
    assert.equal((await fetch(base + '/internal/delivery', { method: 'POST', headers })).status, 401);
  } finally { await client.close(); await Promise.all([server, secondServer].map(s => new Promise<void>(resolve => s ? s.close(() => resolve()) : resolve()))); }
});
integration('general request data and webhook credentials are removed with the account; retained metadata expires', async () => {
  await allowForms(); const r = await relay.forms.create(token, formInput('form-delete-account'));
  await relay.forms.submit(uid, did, r.requestId, formUpload('delete-answer'));
  const terminal = time; time += 7 * 24 * 60 * MINUTE;
  await assert.rejects(relay.forms.get(phone, r.requestId), reason('request_not_found'));
  assert.equal((await relay.forms.events(token)).events.length, 0);
  await relay.forms.maintenance(); assert.equal((await db.collection('formRequests').doc(r.requestId).get()).exists, false);
  assert.equal((await db.collection('requestEvents').where('requestId', '==', r.requestId).get()).size, 0);
  time = terminal; await relay.forms.create(token, formInput('form-account-delete'));
  await relay.deleteAccount(uid);
  for (const collection of ['formRequests', 'formResults', 'requestEvents', 'deliveryOutbox', 'grants']) assert.equal((await db.collection(collection).where('ownerId', '==', uid).get()).size, 0);
});

integration('delivery leases recover a dead worker and a grant cancellation resumes after process loss', async () => {
  await allowForms(); const r = await relay.forms.create(token, formInput('worker-process-loss'));
  const jobs = await db.collection('deliveryOutbox').get();
  for (const doc of jobs.docs) await doc.ref.update({ lease: 'dead-worker', nextAt: time + MINUTE, attempts: 1 });
  await relay.forms.dispatch(); assert.equal(sends.length, 0);
  time += MINUTE;
  const restarted = new Relay(db, async fcm => { sends.push(fcm); }, () => time);
  await restarted.forms.dispatch(); assert.equal(sends.length, 2);
  await db.collection('grants').doc(grantId).update({ formsApproved: false, formsCancellationPending: true });
  await restarted.forms.maintenance();
  assert.equal((await restarted.forms.get(phone, r.requestId)).status, 'cancelled');
  assert.equal((await db.collection('grants').doc(grantId).get()).data()?.formsCancellationPending, false);
});
integration('a slow expired-event page cannot hide retained events from polling', async () => {
  await allowForms();
  const first = await relay.forms.create(token, formInput('old-retained-events'));
  await relay.forms.cancel(token, first.requestId);
  const expired = await db.collection('requestEvents').get();
  for (const doc of expired.docs) await doc.ref.update({ purgeAt: new Date(time - 1) });
  const next = await relay.forms.create(token, formInput('new-retained-events'));
  const page = await relay.forms.events(token);
  assert.equal(page.events.length, 1); assert.equal(page.events[0]!.requestId, next.requestId);
  assert.equal(page.cursor, page.events[0]!.id);
});

integration('a general SMS helper cannot start during legacy capture and queued SMS waits through form completion', async () => {
  await allowForms();
  const legacy = await relay.create(token, input('legacy-helper-exclusion'));
  const form = await relay.forms.create(token, { ...formInput('owner-helper-exclusion'), fields: [{ id: 'code', type: 'text', input: 'sms_code', label: 'Code' }] });
  await assert.rejects(relay.forms.observe(uid, second, form.requestId, { type: 'input.ready', fieldId: 'code', listenerStartedAt: time }), reason('sms_listener_busy'));
  await relay.transition({ secret: token }, legacy.requestId, 'cancelled');
  await relay.forms.observe(uid, did, form.requestId, { type: 'input.ready', fieldId: 'code', listenerStartedAt: time });
  const queued = await relay.create(token, input('queued-during-form-helper'));
  assert.equal(queued.status, 'queued');
  await relay.forms.submit(uid, second, form.requestId, { submissionId: 'form-done-helper-still-alive', action: 'approve', values: { code: '123456' } });
  await relay.maintenance(); assert.equal((await relay.get(token, queued.requestId)).status, 'queued');
  time += 5 * MINUTE; await relay.maintenance();
  assert.equal((await relay.get(token, queued.requestId)).status, 'pending_phone');
});
integration('competing forms on different phones cannot both become SMS-ready', async () => {
  await allowForms();
  const definition = (key: string) => ({ ...formInput(key), expiresInSeconds: 60, fields: [{ id: 'code', type: 'text' as const, input: 'sms_code' as const, label: 'Code' }] });
  const requests = await Promise.all([relay.forms.create(token, definition('concurrent-helper-one')), relay.forms.create(token, definition('concurrent-helper-two'))]);
  const outcomes = await Promise.allSettled(requests.map((r, i) => relay.forms.observe(uid, i === 0 ? did : second, r.requestId, { type: 'input.ready', fieldId: 'code', listenerStartedAt: time })));
  assert.equal(outcomes.filter(o => o.status === 'fulfilled').length, 1);
  const rejected = outcomes.find(o => o.status === 'rejected') as PromiseRejectedResult;
  assert.ok(reason('sms_listener_busy')(rejected.reason));
  assert.equal((await relay.forms.events(token)).events.filter(e => e.type === 'input.ready').length, 1);
  assert.equal((await relay.forms.inbox(uid, did)).length, 2);
  time += MINUTE; await relay.forms.maintenance();
  const next = await relay.forms.create(token, { ...definition('after-short-form-expiry'), expiresInSeconds: 600 });
  await assert.rejects(relay.forms.observe(uid, second, next.requestId, { type: 'input.ready', fieldId: 'code', listenerStartedAt: time }), reason('sms_listener_busy'));
  time += 4 * MINUTE;
  await relay.forms.observe(uid, second, next.requestId, { type: 'input.ready', fieldId: 'code', listenerStartedAt: time });
});

const wizardInput = (key: string) => ({ ...formInput(key), fields: [
  { id: 'travel', type: 'checkbox' as const, label: 'Travel' }, { id: 'city', type: 'text' as const, label: 'Destination', required: true }],
  steps: [{ id: 'kind', title: 'Expense type', fieldIds: ['travel'] }, { id: 'trip', title: 'Trip', body: '**Where?**', fieldIds: ['city'], when: { fieldId: 'travel', equals: true } }] });
integration('wizards advertise capabilities, isolate old clients and keep their definitions immutable', async () => {
  await allowForms();
  await assert.rejects(relay.forms.create(token, wizardInput('wizard-capabilities')), reason('wizard_devices_unavailable'));
  await relay.register(uid, did, 'First phone', 'first-fcm', 1);
  const r = await relay.forms.create(token, wizardInput('wizard-capabilities'));
  assert.equal(r.steps?.[1]?.body, '**Where?**');
  assert.equal((await relay.forms.inbox(uid, did)).length, 1); assert.equal((await relay.forms.inbox(uid, second)).length, 0);
  await assert.rejects(relay.forms.get(otherPhone, r.requestId), reason('wizard_app_update_required'));
  await assert.rejects(relay.forms.submit(uid, second, r.requestId, { submissionId: 'old-client', action: 'approve', values: {} }), reason('wizard_app_update_required'));
  await relay.forms.dispatch(); assert.deepEqual(sends, ['first-fcm']);
  await assert.rejects(relay.forms.create(token, { ...wizardInput('wizard-capabilities'), steps: [...wizardInput('wizard-capabilities').steps].reverse() }));
  await assert.rejects(relay.forms.create(token, { ...wizardInput('wizard-capabilities'), steps: wizardInput('wizard-capabilities').steps.map(s => ({ ...s, title: 'Changed' })) }), reason('idempotency_conflict'));
  await relay.register(uid, did, 'First phone', 'first-fcm'); // Downgrading withdraws capability.
  assert.equal((await relay.forms.inbox(uid, did)).length, 0);
  const flat = await relay.forms.create(token, formInput('flat-still-supported'));
  assert.equal((await relay.forms.get(phone, flat.requestId)).status, 'pending');
});
integration('wizard submissions validate their selected branch and remain atomic and idempotent across phones', async () => {
  await allowForms(); await relay.register(uid, did, 'First', 'first-fcm', 1); await relay.register(uid, second, 'Second', 'second-fcm', 1);
  const r = await relay.forms.create(token, wizardInput('wizard-final-response'));
  const upload = { submissionId: 'wizard-final', action: 'approve', values: { travel: true, city: 'Santo Domingo' } };
  await assert.rejects(relay.forms.submit(uid, did, r.requestId, { ...upload, values: { travel: true } }), reason('required_field'));
  await assert.rejects(relay.forms.submit(uid, did, r.requestId, { ...upload, values: { travel: false, city: 'Stale' } }), reason('hidden_field'));
  assert.equal((await relay.forms.get(phone, r.requestId)).status, 'pending');
  assert.equal((await relay.forms.result(token, r.requestId)).result, null);
  await Promise.all([relay.forms.submit(uid, did, r.requestId, upload), relay.forms.submit(uid, second, r.requestId, { ...upload, submissionId: 'second-wizard-final' })]);
  await relay.forms.submit(uid, did, r.requestId, upload);
  const result = await relay.forms.result(token, r.requestId); assert.deepEqual(result.result?.values, upload.values);
  assert.equal((await relay.forms.events(token)).events.filter(e => e.type === 'request.submitted').length, 1);
  assert.equal((await db.collection('formResults').get()).size, 1);
  const skipped = await relay.forms.create(token, wizardInput('wizard-skipped-branch'));
  await relay.forms.submit(uid, did, skipped.requestId, { submissionId: 'skip-trip', action: 'approve', values: { travel: false } });
  assert.deepEqual((await relay.forms.result(token, skipped.requestId)).result?.values, { travel: false });
  const declined = await relay.forms.create(token, wizardInput('wizard-early-decline'));
  assert.equal((await relay.forms.submit(uid, second, declined.requestId, { submissionId: 'decline-early', action: 'decline', values: {} })).status, 'declined');
});
integration('wizard cancellation, expiry and connection isolation preserve one terminal outcome without answers', async () => {
  await allowForms(); await relay.register(uid, did, 'Wizard phone', 'first-fcm', 1);
  const other = await relay.createGrant(uid, '', 'Other connection', 30); await relay.forms.approve(uid, other.grantId, true);
  const r = await relay.forms.create(token, { ...wizardInput('wizard-expiry'), expiresInSeconds: 60 });
  await assert.rejects(relay.forms.get({ secret: other.token }, r.requestId), reason('request_not_found'));
  await assert.rejects(relay.forms.get({ uid: 'unrelated', deviceId: did }, r.requestId), reason('device_not_found'));
  time += MINUTE;
  const upload = { submissionId: 'too-late-wizard', action: 'approve', values: { travel: false } };
  assert.equal((await relay.forms.submit(uid, did, r.requestId, upload)).status, 'expired');
  assert.equal((await relay.forms.result(token, r.requestId)).result, null);
  const cancelled = await relay.forms.create(token, wizardInput('wizard-cancelled'));
  await relay.forms.observe(uid, did, cancelled.requestId, { type: 'request.opened' });
  await relay.forms.cancel(token, cancelled.requestId);
  assert.equal((await relay.forms.submit(uid, did, cancelled.requestId, upload)).status, 'cancelled');
  assert.equal((await relay.forms.result(token, cancelled.requestId)).result, null);
  const revoked = await relay.forms.create(token, wizardInput('wizard-permission-revoked'));
  await relay.forms.approve(uid, grantId, false);
  assert.equal((await relay.forms.get(phone, revoked.requestId)).status, 'cancelled');
  assert.equal((await db.collection('formResults').get()).size, 0);
});


integration('monitoring samples real due queues and timestamp expiries without emitting document data', { timeout: 30_000 }, async () => {
  await db.collection('requests').doc('sample-a').set({ status: 'pending_phone', notificationSent: false, nextNotificationAt: time - 200_000, purpose: 'private-code' });
  await db.collection('requests').doc('sample-b').set({ status: 'ready', notificationSent: false, nextNotificationAt: time - 300_000 });
  await db.collection('requests').doc('not-due').set({ status: 'pending_phone', notificationSent: false, nextNotificationAt: time + 1 });
  await db.collection('deliveryOutbox').doc('sample').set({ nextAt: time - 181_000, secret: 'private-token' });
  await db.collection('results').doc('sample').set({ purgeAt: new Date(time - 301_000), code: 'private-answer' });
  await db.collection('formResults').doc('sample').set({ purgeAt: new Date(time - 2_000), values: { field: 'private-answer' } });
  await db.collection('deletionJobs').doc('sample').set({ nextAt: time - 400_000, ownerId: 'private-owner' });
  await db.collection('deletionJobs').doc('complete').set({ nextAt: Number.MAX_SAFE_INTEGER });
  const entries: unknown[] = [];
  await new Telemetry(entry => entries.push(entry), () => time).backlogs(db);
  const samples = entries as { kind: string; count: number; oldest_due_age_s: number }[];
  assert.equal(samples.length, 5);
  assert.deepEqual(Object.fromEntries(samples.map(s => [s.kind, [s.count, s.oldest_due_age_s]])), {
    sms: [2, 300], form: [1, 181], results: [1, 301], form_results: [1, 2], deletion: [1, 400],
  });
  assert.ok(!JSON.stringify(samples).includes('private'));
});
