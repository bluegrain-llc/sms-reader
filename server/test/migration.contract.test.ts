import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { gzipSync, deflateSync, brotliCompressSync } from 'node:zlib';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { Relay } from '../src/relay.js';
import { app } from '../src/http.js';
import type { HttpOptions } from '../src/http.js';
import { RustRelay, rustApp } from './rust-adapter.js';
import { MINUTE, hash } from '../src/model.js';
if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) throw Error('Migration contracts require emulators');
const firebase = initializeApp({ projectId: 'demo-sms-relay' }, 'migration-contract');
const db = getFirestore(firebase);
let time: number;
let ts: Relay, rust: Relay;
const uid = 'migration-owner', did = 'migration-device';
const form = (key: string) => ({ title: ' Review ', body: 'Body', idempotencyKey: key,
  fields: [{ id: 'code', type: 'text' as const, input: 'sms_code' as const, label: ' Code ', required: true }],
  actions: [{ id: 'submit', type: 'submit' as const, label: ' Send ' }] });
beforeEach(async () => {
  // Emulator admin clear also removes records left by the other implementation.
  const response = await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-sms-relay/databases/(default)/documents`, { method: 'DELETE', signal: AbortSignal.timeout(10_000) });
  assert.equal(response.status, 200);
  time = 1_800_000_000_000;
  ts = new Relay(db, async () => {}, () => time);
  rust = new RustRelay(db, async () => {}, () => time) as unknown as Relay;
});
after(async () => { await deleteApp(firebase); });
for (const direction of ['typescript-to-rust', 'rust-to-typescript']) {
  test(`${direction}: credentials, active SMS, legacy documents and result timestamps`, { timeout: 60_000 }, async () => {
    const [writer, reader] = direction.startsWith('typescript') ? [ts, rust] : [rust, ts];
    await writer.register(uid, did, 'Phone', 'synthetic-fcm', 1);
    const grant = await writer.createGrant(uid, did, 'Caller', 30);
    await reader.checkAgent(grant.token);
    const raw = { purpose: '  Unicode 😀  ', idempotencyKey: 'cross-sms-id', title: ' Sign in ' };
    const r = await writer.create(grant.token, raw);
    assert.deepEqual(await reader.create(grant.token, raw), r);
    // Reproduce the legacy single-phone document without deviceIds or phones.
    await db.collection('requests').doc(r.requestId).update({ deviceIds: FieldValue.delete(), phones: FieldValue.delete() });
    await reader.transition({ uid, deviceId: did }, r.requestId, 'ready', null, undefined, time);
    await writer.transition({ uid, deviceId: did }, r.requestId, 'completed', null, 'A1234', undefined, 'manual');
    assert.equal((await reader.get(grant.token, r.requestId)).code, 'A1234');
    const stored = (await db.collection('results').doc(r.requestId).get()).data()!;
    assert.ok(stored.purgeAt instanceof Timestamp); assert.equal(stored.grantId, grant.grantId);
    time += 2 * MINUTE;
    assert.equal((await reader.get(grant.token, r.requestId)).status, 'expired');
    assert.equal((await db.collection('results').doc(r.requestId).get()).exists, false);
  });
  test(`${direction}: pending pairings, form defaults, cursors and claimed delivery jobs`, { timeout: 60_000 }, async () => {
    const [writer, reader] = direction.startsWith('typescript') ? [ts, rust] : [rust, ts];
    await writer.register(uid, did, 'Phone', 'synthetic-fcm', 1);
    const connection = await writer.connections.start('cross-source', { callerName: 'Bot', purpose: 'Cross-version pairing' });
    const grant = await reader.connections.owner(uid, connection.userCode, 'approved');
    assert.equal((await writer.connections.poll(connection.connectionToken)).status, 'approved');
    const token = connection.connectionToken;
    await reader.forms.approve(uid, grant.connectionId, true);
    const request = await writer.forms.create(token, form('cross-form-defaults'));
    assert.deepEqual(JSON.parse(JSON.stringify(await reader.forms.create(token, { ...form('cross-form-defaults'), expiresInSeconds: 86400 }))), JSON.parse(JSON.stringify(request)));
    const cursor = (await writer.forms.events(token)).cursor!;
    const jobs = await db.collection('deliveryOutbox').get();
    for (const job of jobs.docs) await job.ref.update({ lease: 'dead-worker', nextAt: time + MINUTE, attempts: 1 });
    await reader.forms.dispatch(); assert.equal((await reader.forms.events(token, cursor)).events.length, 0);
    time += MINUTE;
    await reader.forms.dispatch();
    assert.equal((await writer.forms.events(token, cursor)).events[0]!.type, 'notification.accepted');
    await reader.forms.submit(uid, did, request.requestId, { submissionId: 'cross-submit', action: 'submit', values: { code: '001234' } });
    assert.equal((await writer.forms.result(token, request.requestId)).result?.values.code, '001234');
    const stored = (await db.collection('formResults').doc(request.requestId).get()).data()!;
    assert.ok(stored.purgeAt instanceof Timestamp);
    await writer.forms.submit(uid, did, request.requestId, { submissionId: 'cross-submit', action: 'submit', values: { code: '001234' } });
    assert.equal((await reader.forms.events(token)).events.filter(e => e.type === 'request.submitted').length, 1);
  });
}
const options: HttpOptions = {
  publicUrl: 'https://relay.example.test', androidCertSha256: Array(32).fill('AA').join(':'), origins: ['https://allowed.example'],
  verifyOwner: async token => { if (token !== 'owner-session') throw Error('bad identity'); return { uid, authTime: Date.now() / 1000 }; },
  verifyScheduler: async () => { throw Error('not scheduler'); }, deleteIdentity: async () => {}, sseDurationMs: 25,
};
test('HTTP errors, body bounds, auth ordering, headers and protocol negotiation match both runtimes', { timeout: 60_000 }, async () => {
  await ts.register(uid, did, 'Phone', 'synthetic-fcm');
  const { token, grantId } = await ts.createGrant(uid, did, 'Caller', 30);
  const servers = [app(ts, options).listen(0, '127.0.0.1'), rustApp(rust, options).listen()];
  try {
    await Promise.all(servers.map(server => once(server, 'listening')));
    const bases = servers.map(server => `http://127.0.0.1:${(server.address() as { port: number }).port}`);
    const cases: (RequestInit & { path: string })[] = [
      { path: '/health' }, { path: '/HEALTH' }, { path: '/health/' }, { path: '/health//' }, { path: '//health' }, { path: '/health', method: 'HEAD' }, { path: '/healthz' }, { path: '/missing' }, { path: '/v1/devices' },
      { path: '/health', headers: { origin: 'https://denied.example' } },
      { path: '/health', headers: { origin: 'https://allowed.example' } },
      { path: '/health', headers: { origin: '' } },
      { path: '/v1/devices', headers: { authorization: 'Bearer wrong' } },
      { path: '/v1/requests', method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' },
      { path: '/v1/requests', method: 'POST', headers: { 'content-type': 'application/json' }, body: '1' },
      { path: '/v1/requests', method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ purpose: 'x'.repeat(40_000), idempotencyKey: 'body-limit' }) },
      { path: '/v1/requests', method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ purpose: 'x'.repeat(256 * 1024) }) },
      { path: '/connect?code=AAAAAAAAAA&code=BBBBBBBBBB' }, { path: '/mcp' },
      { path: '/internal/delivery', method: 'POST' }, { path: '/internal/maintenance', method: 'POST' },
      { path: '/v2/requests/nope', headers: { authorization: `Bearer ${token}` } },
      { path: '/v1/requests/%ZZ' }, { path: '/v1/requests/%ZZ', headers: { authorization: `Bearer ${token}` } },
      { path: '/v1/devices/%FF', method: 'POST' },
      { path: '/v2/webhooks', method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer bad' }, body: '{"url":"not a url","events":["request.created"]}' },
      { path: '/v2/webhooks', method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer bad' }, body: '{"url":"mailto:user@example.test","events":["request.created"]}' },
      { path: '/v1/devices/nope', method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{"paused":"yes"}' },
      { path: '/v1/requests', method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer bad' }, body: '{"purpose":"\\ud800","idempotencyKey":"surrogate-invalid-token"}' },
      { path: `/v1/grants/${grantId}&ignored`, method: 'DELETE', headers: { authorization: 'Bearer owner-session' } },
      ...['POLL', 'REVIEW', 'DECISION'].map(operation => ({ path: `/v1/connections/${operation}`, method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })),
      ...[gzipSync, deflateSync, brotliCompressSync].map((compress, i) => ({ path: '/v1/requests', method: 'POST', headers: { 'content-type': 'application/json', 'content-encoding': ['gzip', 'deflate', 'br'][i]!, authorization: `Bearer ${token}` }, body: compress(Buffer.from('{"purpose":"Compressed","idempotencyKey":"encoded-body"}')) })),
      { path: '/v1/requests', method: 'POST', headers: { 'content-type': 'application/json; charset=utf-16le', authorization: `Bearer ${token}` }, body: Buffer.from('{"purpose":"Compressed","idempotencyKey":"encoded-body"}', 'utf16le') },
      { path: '/v1/requests', method: 'POST', headers: { 'content-type': 'application/json; charset=utf-16', authorization: `Bearer ${token}` }, body: Buffer.from('{"purpose":"Compressed","idempotencyKey":"encoded-body"}', 'utf16le').swap16() },
      { path: '/v1/requests', method: 'POST', headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' }, body: gzipSync(Buffer.from(JSON.stringify({ purpose: 'x'.repeat(256 * 1024) }))) },
      { path: '/health', method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x'.repeat(256 * 1024 + 1) },
    ];
    for (const item of cases) {
      const results = await Promise.all(bases.map(async base => { const response = await fetch(base + item.path, { ...item, signal: AbortSignal.timeout(15_000) });
        return { status: response.status, body: await response.text(), cache: response.headers.get('cache-control'), nosniff: response.headers.get('x-content-type-options') }; }));
      assert.deepEqual(results[1], results[0], `${item.method ?? 'GET'} ${item.path}`);
    }
    for (const version of ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07', '2099-01-01']) {
      const results = await Promise.all(bases.map(async base => { const response = await fetch(base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: version, capabilities: {}, clientInfo: { name: 'migration', version: '1' } } }), signal: AbortSignal.timeout(15_000) });
        const v = await response.json() as any; return { status: response.status, protocol: v.result?.protocolVersion, server: v.result?.serverInfo }; }));
      assert.deepEqual(results[1], results[0], version);
    }
    const list = (id: number) => ({ jsonrpc: '2.0', id, method: 'tools/list' });
    const rpc = async (base: string, body: RequestInit['body'], headers: Record<string, string> = {}) => {
      const response = await fetch(base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}`, ...headers }, body, signal: AbortSignal.timeout(15_000) });
      const text = await response.text(); return { status: response.status, type: response.headers.get('content-type'), body: text ? JSON.parse(text) : null };
    };
    for (const [body, headers] of [
      [JSON.stringify([list(1), list(2)]), {}], [JSON.stringify([list(1)]), {}], ['[]', {}],
      [JSON.stringify(list(-1)), {}], [JSON.stringify(list(1)), { 'mcp-protocol-version': '2024-10-07' }],
      [JSON.stringify(list(1)), { 'mcp-protocol-version': 'unsupported' }],
      [JSON.stringify(list(1)), { accept: 'application/json' }], [JSON.stringify(list(1)), { 'content-type': 'text/plain' }],
      [JSON.stringify(Array.from({ length: 101 }, (_, i) => list(i))), {}],
      [JSON.stringify({ ...list(1), params: { cursor: 1 } }), {}],
      ...[130, 10000].map(depth => [`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"request_sms_code","arguments":{"purpose":"Ignored depth","idempotencyKey":"depth-${depth}","ignored":${'['.repeat(depth)}0${']'.repeat(depth)}}}}`, {}]),
      ['{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"request_sms_code","arguments":{"purpose":"Ignored overflow","idempotencyKey":"overflow-ignored","ignored":1e400}}}', {}],
      ['{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"create_request","arguments":{"title":"Test","body":"Body","actions":[{"id":"ok","type":"submit","label":"OK"}],"idempotencyKey":"overflow-bounds","expiresInSeconds":1e400}}}', {}],
    ] as [string, Record<string, string>][]) {
      assert.deepEqual(await rpc(bases[1]!, body, headers), await rpc(bases[0]!, body, headers), body.slice(0,150));
    }
    for (const capabilities of [{ elicitation: {} }, { sampling: { tools: {}, context: {} } }, { experimental: { feature: {} }, extensions: { feature: [] } }, { tasks: { list: {}, cancel: {} } }, { sampling: { tools: null } }, { elicitation: [] }]) {
      const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities, clientInfo: { name: 'capabilities', version: '1' } } });
      assert.deepEqual(await rpc(bases[1]!, body), await rpc(bases[0]!, body), JSON.stringify(capabilities));
    }
    const rawId = Buffer.from('{"jsonrpc":"2.0","id":"' + '\ud800' + '","method":"tools/list"}', 'utf16le');
    assert.deepEqual(await rpc(bases[1]!, rawId, { 'content-type': 'application/json; charset=utf-16le' }), await rpc(bases[0]!, rawId, { 'content-type': 'application/json; charset=utf-16le' }));
    for (const [name, args] of [
      ['get_sms_code_request', {}], ['get_sms_code_request', { requestId: 1 }], ['get_sms_code_request', { requestId: '?' }],
      ['request_sms_code', { purpose: '   ', idempotencyKey: 'short' }], ['request_sms_code', { purpose: 'MCP extras', idempotencyKey: 'mcp-extras', ignored: true }],
      ['create_request', { ...form('mcp-extra-form'), ignored: true }], ['create_request', { ...form('mcp-invalid-form'), fields: [{ type: 'invalid' }] }],
      ['create_request', { ...form('mcp-null-field'), fields: [null] }],
      ['poll_request_events', { cursor: 'x'.repeat(129) }], ['not_a_tool', {}],
    ] as const) {
      const responses = await Promise.all(bases.map(async base => {
        const response = await fetch(base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }), signal: AbortSignal.timeout(15_000) });
        return response.json();
      }));
      assert.deepEqual(responses[1], responses[0], `${name} ${JSON.stringify(args)}`);
    }
    for (const params of [
      { name: 'request_sms_code', arguments: { purpose: 'Task', idempotencyKey: 'task-envelope' }, task: { ttl: 60000 } },
      { name: 'poll_request_events', arguments: null },
      { name: 'poll_request_events', arguments: [] }, { name: 'poll_request_events', task: null },
      { name: 'poll_request_events', task: { ttl: 'bad' } }, { name: 1, arguments: {} },
      { name: 'poll_request_events', _meta: false },
      { name: 'request_sms_code', arguments: { purpose: 'Ignored params', idempotencyKey: 'ignored-params' }, requestState: 1, inputResponses: 1 },
      { name: 'request_sms_code', arguments: { purpose: 'Surrogate', idempotencyKey: 'surrogate-ignored', ignored: '\ud800' } },
    ]) {
      const responses = await Promise.all(bases.map(async base => {
        const response = await fetch(base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params }), signal: AbortSignal.timeout(15_000) });
        return response.json();
      }));
      assert.deepEqual(responses[1], responses[0], JSON.stringify(params));
    }
    const deletes = await Promise.all(bases.map(async base => {
      const response = await fetch(base + '/v1/account', { method: 'DELETE', headers: { authorization: 'Bearer owner-session' }, signal: AbortSignal.timeout(15_000) });
      return { status: response.status, body: await response.json() };
    }));
    assert.deepEqual(deletes[1], deletes[0]); assert.equal(deletes[0]!.status, 200);
  } finally { await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve())))); }
});

test('raw JSON numbers and live HTTP clocks preserve observations, helper retries and answers', { timeout: 60_000 }, async () => {
  await ts.register(uid, did, 'Phone', 'synthetic-fcm', 1);
  const { token, grantId } = await ts.createGrant(uid, did, 'Caller', 30);
  await ts.forms.approve(uid, grantId, true);
  const servers = [app(ts, options).listen(0, '127.0.0.1'), rustApp(rust, options).listen()];
  try {
    await Promise.all(servers.map(server => once(server, 'listening')));
    time += MINUTE;
    for (const [i, server] of servers.entries()) {
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const request = await ts.forms.create(token, { ...form(`raw-json-${i}`), fields: [...form('unused').fields, { id: 'amount', type: 'number', label: 'Amount' }] });
      time += MINUTE;
      const post = async (suffix: string, body: string) => {
        const response = await fetch(`${base}/v2/devices/${did}/requests/${request.requestId}/${suffix}`, { method: 'POST', headers: { authorization: 'Bearer owner-session', 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(15_000) });
        assert.equal(response.status, 200, await response.clone().text()); return response.json() as Promise<any>;
      };
      const opened = await post('events', `{"type":"request.opened","occurredAt":${time - 10_000}.0}`);
      assert.equal(opened.firstOpenedAt, time - 10_000);
      const ready = `{"type":"input.ready","fieldId":"code","listenerStartedAt":${time}.0}`;
      await post('events', ready); await post('events', ready);
      await post('submissions', '{"submissionId":"raw-number","action":"submit","values":{"code":"1234","amount":9007199254740993}}');
      assert.equal((await ts.forms.result(token, request.requestId)).result?.values.amount, 9007199254740992);
      time += 6 * MINUTE;
    }
  } finally { await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve())))); }
});

test('native Firebase verifier checks Google provider, disabled/deleted users and revocation on each request', { timeout: 30_000 }, async () => {
  const base = `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1`;
  const auth = getAuth(firebase);
  const fakeGoogle = Buffer.from(JSON.stringify({ sub: 'synthetic-google-user', email: 'synthetic@example.test', email_verified: true })).toString('base64url');
  const identityToken = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${fakeGoogle}.`;
  const login = await fetch(`${base}/accounts:signInWithIdp?key=demo`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requestUri: 'http://localhost', postBody: new URLSearchParams({ providerId: 'google.com', id_token: identityToken }).toString(), returnSecureToken: true }), signal: AbortSignal.timeout(10_000) });
  assert.equal(login.status, 200);
  const { idToken, localId } = await login.json() as { idToken: string; localId: string };
  const verify = (token: string) => (rust as unknown as RustRelay).call('verifyOwner', [token]) as Promise<{ uid: string }>;
  assert.equal((await verify(idToken)).uid, localId);
  await auth.updateUser(localId, { disabled: true });
  await assert.rejects(verify(idToken));
  await auth.updateUser(localId, { disabled: false });
  assert.equal((await verify(idToken)).uid, localId);
  const custom = await auth.createCustomToken(localId);
  const customLogin = await fetch(`${base}/accounts:signInWithCustomToken?key=demo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: custom, returnSecureToken: true }), signal: AbortSignal.timeout(10_000) });
  const customSession = await customLogin.json() as { idToken: string };
  await assert.rejects(verify(customSession.idToken));
  const revoked = await fetch(`${base}/projects/demo-sms-relay/accounts:update`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer owner' }, body: JSON.stringify({ localId, validSince: String(Math.floor(Date.now() / 1000) + 10) }), signal: AbortSignal.timeout(10_000) });
  assert.equal(revoked.status, 200);
  await assert.rejects(verify(idToken));
  await auth.deleteUser(localId);
  await assert.rejects(verify(idToken));
});

test('isolated UTF-16 JSON and literal marker characters preserve storage and wire behavior', { timeout: 60_000 }, async () => {
  await ts.register(uid, did, 'Phone', 'synthetic-fcm');
  const { token, grantId } = await ts.createGrant(uid, did, 'Caller', 30);
  await ts.forms.approve(uid, grantId, true);
  const servers = [app(ts, options).listen(0, '127.0.0.1'), rustApp(rust, options).listen()];
  try {
    await Promise.all(servers.map(server => once(server, 'listening')));
    const bases = servers.map(server => `http://127.0.0.1:${(server.address() as { port: number }).port}`);
    for (const base of bases) {
      const response = await fetch(base + '/v2/requests', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ title: '\ud800', body: 'Body', idempotencyKey: 'isolated-storage', actions: [{ id: 'ok', label: 'OK', type: 'submit' }] }), signal: AbortSignal.timeout(15_000) });
      assert.equal(response.status, 500); assert.deepEqual(await response.json(), { error: 'internal_error' });
    }
    for (const [i, base] of bases.entries()) {
      const body = JSON.stringify({ title: 'Unicode', body: '\u{f0000}\ue000', idempotencyKey: `unicode-form-${i}`, actions: [{ id: 'ok', label: 'OK', type: 'submit' }] });
      const post = async (target: string) => {
        const response = await fetch(target + '/v2/requests', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(15_000) });
        assert.equal(response.status, 201, await response.clone().text()); return response.json() as Promise<any>;
      };
      const first = await post(base); assert.equal(first.title, 'Unicode'); assert.equal(first.body, '\u{f0000}\ue000');
      const replay = await post(bases[1 - i]!); assert.equal(replay.requestId, first.requestId); assert.equal(replay.title, 'Unicode'); assert.equal(replay.body, first.body);
      const inspections = await Promise.all(bases.map(async target => {
        const response = await fetch(target + '/mcp', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'inspect_request', arguments: { requestId: first.requestId } } }), signal: AbortSignal.timeout(15_000) });
        return response.json();
      }));
      for (const inspection of inspections as any[]) {
        assert.deepEqual(JSON.parse(inspection.result.content[0].text), inspection.result.structuredContent);
        inspection.result.content[0].text = JSON.parse(inspection.result.content[0].text);
      }
      assert.deepEqual(inspections[1], inspections[0]);
    }
  } finally { await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve())))); }
});
