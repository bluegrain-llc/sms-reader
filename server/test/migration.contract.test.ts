import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { gzipSync, deflateSync, brotliCompressSync } from 'node:zlib';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { Relay } from '../src/relay.js';
import { app } from '../src/http.js';
import type { HttpOptions } from '../src/http.js';
import { RustRelay, rustApp } from './rust-adapter.js';
import { MINUTE, hash } from '../src/model.js';
import { telemetry } from '../src/telemetry.js';
if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) throw Error('Migration contracts require emulators');
const firebase = initializeApp({ projectId: 'demo-sms-relay' }, 'migration-contract');
const db = getFirestore(firebase);
let time: number;
let ts: Relay, rust: Relay;
const uid = 'migration-owner', did = 'migration-device';
const form = (key: string) => ({ title: ' Review ', body: 'Body', idempotencyKey: key,
  fields: [{ id: 'code', type: 'text' as const, input: 'sms_code' as const, label: ' Code ', required: true }],
  actions: [{ id: 'submit', type: 'submit' as const, label: ' Send ' }] });
const utf32 = (text: string, be = false) => {
  const points = [...text].map(c => c.codePointAt(0)!); const bytes = Buffer.alloc(points.length * 4);
  points.forEach((point, i) => be ? bytes.writeUInt32BE(point, i * 4) : bytes.writeUInt32LE(point, i * 4)); return bytes;
};
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
  test(`${direction}: numeric device IDs preserve aggregate SMS failure precedence`, { timeout: 60_000 }, async () => {
    const [writer, reader] = direction.startsWith('typescript') ? [ts, rust] : [rust, ts];
    await writer.register(uid, '10', 'Ten', 'synthetic-ten');
    await writer.register(uid, '2', 'Two', 'synthetic-two');
    const grant = await writer.createGrant(uid, '10', 'Caller', 30);
    const request = await writer.create(grant.token, { purpose: 'Failure precedence', idempotencyKey: 'numeric-device-failure' });
    await writer.transition({ uid, deviceId: '2' }, request.requestId, 'failed', 'listener_failed');
    await reader.transition({ uid, deviceId: '10' }, request.requestId, 'failed', 'process_restarted');
    for (const backend of [writer, reader]) {
      const result = await backend.get(grant.token, request.requestId);
      assert.equal(result.status, 'failed'); assert.equal(result.reason, 'listener_failed');
    }
    const stored = (await db.collection('requests').doc(request.requestId).get()).data()!;
    assert.equal(stored.reason, 'listener_failed');
    assert.equal(stored.phones['2'].reason, 'listener_failed');
    assert.equal(stored.phones['10'].reason, 'process_restarted');
  });
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
    const empty = await writer.forms.create(token, { title: 'No fields', body: 'Body', actions: [{ id: 'submit', label: 'Send', type: 'submit' }], idempotencyKey: 'cross-proto-key' });
    const submission = JSON.parse('{"submissionId":"retry-proto","action":"submit","values":{"__proto__":{"ignored":"even invalid value types are stripped"}}}');
    const accepted = await writer.forms.submit(uid, did, empty.requestId, submission);
    assert.deepEqual(JSON.parse(JSON.stringify(await reader.forms.submit(uid, did, empty.requestId, submission))), JSON.parse(JSON.stringify(accepted)));
    assert.deepEqual((await reader.forms.result(token, empty.requestId)).result?.values, {});
    for (const fieldId of ['constructor', 'toString', '__proto__']) {
      const prototype = await writer.forms.create(token, { title: 'Prototype field', body: 'Body', fields: [{ id: fieldId, type: 'text', label: 'Name' }], actions: [{ id: 'submit', label: 'Send', type: 'submit' }], idempotencyKey: `cross-prototype-${fieldId}` });
      for (const backend of [writer, reader]) await assert.rejects(backend.forms.submit(uid, did, prototype.requestId, { submissionId: 'missing-prototype', action: 'submit', values: {} }), /invalid_text/);
      assert.equal((await reader.forms.get({ secret: token }, prototype.requestId)).status, 'pending');
      await writer.forms.cancel(token, prototype.requestId);
    }
    await writer.register(uid, 'constructor', 'Prototype device', 'synthetic-fcm', 1);
    const observed = await writer.forms.create(token, form('cross-device-prototype'));
    const eventCursor = (await writer.forms.events(token)).cursor!;
    for (const backend of [writer, reader]) {
      await assert.rejects(backend.forms.observe(uid, 'constructor', observed.requestId, { type: 'input.ready', fieldId: 'code', listenerStartedAt: time }), /input_already_started/);
      for (const type of ['request.opened', 'notification.tapped'] as const) {
        const view = await backend.forms.observe(uid, 'constructor', observed.requestId, { type });
        assert.equal(view.firstOpenedAt, null); assert.deepEqual(view.helpers, {});
      }
    }
    assert.deepEqual((await reader.forms.events(token, eventCursor)).events, []);
    const prototypeDevice = (await db.collection('devices').doc('constructor').get()).data()!;
    assert.ok(!prototypeDevice.formListenerUntil);
    await writer.forms.registerWebhook(token, { url: 'https://8.8.8.8/#', events: ['request.created'] });
    assert.equal((await reader.forms.webhooks(token))[0]!.url, 'https://8.8.8.8/#');
  });
  test(`${direction}: durable deletion receipts, read counters and stream leases survive runtime handoff`, { timeout: 60_000 }, async () => {
    const [writer, reader] = direction.startsWith('typescript') ? [ts, rust] : [rust, ts];
    await writer.register(uid, did, 'Phone', 'synthetic-fcm');
    const grant = await writer.createGrant(uid, did, 'Caller', 30);
    const window = Math.floor(time / MINUTE);
    await db.collection('accessRates').doc(hash(`grant:${grant.grantId}:${window}`)).set({ count: 119, purgeAt: new Date(time + MINUTE) });
    await writer.access.read(uid, grant.grantId);
    await assert.rejects(reader.access.read(uid, grant.grantId), /poll_rate_limited/);
    const first = await writer.access.stream(uid, grant.grantId, 100_000);
    const second = await reader.access.stream(uid, grant.grantId, 100_000);
    try { await assert.rejects(writer.access.stream(uid, grant.grantId, 100_000), /stream_limit_reached/); }
    finally { await first(); await second(); }
    const replacement = await reader.access.stream(uid, grant.grantId, 100_000); await replacement();
    const requested = await writer.deletions.request(uid);
    const repeated = await reader.deletions.request(uid);
    assert.notEqual(requested.receipt, repeated.receipt);
    assert.deepEqual(await reader.deletions.status(requested.receipt), { status: 'pending' });
    assert.equal((await db.collection('deletionJobs').get()).size, 1);
    assert.equal((await db.collection('deletionJobs').doc(hash(uid)).get()).data()?.purgeAt, null);
    let deleted = 0;
    await reader.deletions.dispatch(async owner => {
      assert.equal(owner, uid);
      assert.equal((await db.collection('devices').where('ownerId', '==', uid).get()).size, 0);
      assert.equal((await db.collection('grants').where('ownerId', '==', uid).get()).size, 0);
      deleted++;
    });
    assert.equal(deleted, 1);
    assert.deepEqual(await writer.deletions.status(repeated.receipt), { status: 'completed' });
    await assert.rejects(writer.checkAgent(grant.token), /invalid_token|account_deleted/);
    await assert.rejects(reader.register(uid, 'stale-installation', 'Stale', 'synthetic-fcm'), /account_deleted/);
    time += 24 * 60 * MINUTE;
    await assert.rejects(writer.deletions.status(requested.receipt), /invalid_deletion_receipt/);
  });
}
const options: HttpOptions = {
  publicUrl: 'https://relay.example.test', androidCertSha256: Array(32).fill('AA').join(':'), origins: ['https://allowed.example'],
  verifyOwner: async token => { if (token !== 'owner-session') throw Error('bad identity'); return { uid, authTime: time / 1000 }; },
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
      { path: '/health' }, { path: '/HEALTH' }, { path: '/health/' }, { path: '/health//' }, { path: '//health' }, { path: '/health', method: 'HEAD' }, { path: '/healthz' }, { path: '/missing' }, { path: '/v1/devices' }, { path: '/v2/events/STREAM' },
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
      { path: '/v1/requests', method: 'POST', headers: { 'content-type': 'application/json', 'content-encoding': 'gzip', authorization: `Bearer ${token}` }, body: Buffer.concat([gzipSync(Buffer.from('{"purpose":"Compressed",')), gzipSync(Buffer.from('"idempotencyKey":"encoded-body"}'))]) },
      ...['utf-7', 'utf-7-imap'].map(charset => ({ path: '/v1/requests', method: 'POST', headers: { 'content-type': `application/json; charset=${charset}`, authorization: `Bearer ${token}` }, body: '{"purpose":"Compressed","idempotencyKey":"encoded-body"}' })),
      ...[gzipSync, deflateSync, brotliCompressSync].map((compress, i) => ({ path: '/v1/requests', method: 'POST', headers: { 'content-type': 'application/json', 'content-encoding': ['gzip', 'deflate', 'br'][i]!, authorization: `Bearer ${token}` }, body: compress(Buffer.from('{"purpose":"Compressed","idempotencyKey":"encoded-body"}')) })),
      { path: '/v1/requests', method: 'POST', headers: { 'content-type': 'application/json; charset=utf-16le', authorization: `Bearer ${token}` }, body: Buffer.from('{"purpose":"Compressed","idempotencyKey":"encoded-body"}', 'utf16le') },
      { path: '/v1/requests', method: 'POST', headers: { 'content-type': 'application/json; charset=utf-16', authorization: `Bearer ${token}` }, body: Buffer.from('{"purpose":"Compressed","idempotencyKey":"encoded-body"}', 'utf16le').swap16() },
      ...[['utf-32', false], ['utf-32', true], ['utf-32be', true]].map(([charset, be]) => ({ path: '/v1/requests', method: 'POST', headers: { 'content-type': `application/json; charset=${charset}`, authorization: `Bearer ${token}` }, body: utf32('{"purpose":"Compressed","idempotencyKey":"encoded-body"}', be as boolean) })),
      ...[1, 2, 3].map(length => ({ path: '/v1/requests', method: 'POST', headers: { 'content-type': 'application/json; charset=utf-32le', authorization: `Bearer ${token}` }, body: Buffer.concat([utf32('{"purpose":"Compressed","idempotencyKey":"encoded-body"}'), Buffer.alloc(length)]) })),
      { path: '/v1/requests', method: 'POST', headers: { 'content-type': 'application/json; charset=utf8', authorization: `Bearer ${token}` }, body: '{"purpose":"Compressed","idempotencyKey":"encoded-body"}' },
      { path: '/v1/requests', method: 'POST', headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' }, body: gzipSync(Buffer.from(JSON.stringify({ purpose: 'x'.repeat(256 * 1024) }))) },
      { path: '/health', method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x'.repeat(256 * 1024 + 1) },
    ];
    for (const item of cases) {
      const results = await Promise.all(bases.map(async base => { const response = await fetch(base + item.path, { ...item, signal: AbortSignal.timeout(15_000) });
        return { status: response.status, body: await response.text(), cache: response.headers.get('cache-control'), nosniff: response.headers.get('x-content-type-options') }; }));
      assert.deepEqual(results[1], results[0], `${item.method ?? 'GET'} ${item.path}`);
    }
    for (const [charset, content, firstChunk] of [['utf-16', 'Ā', 16], ['utf-32', '𐀀', 32]] as const) {
      const text = JSON.stringify({ purpose: content.repeat(100), idempotencyKey: `streaming-${charset}` });
      const bytes = charset === 'utf-16' ? Buffer.from(text, 'utf16le') : utf32(text);
      const results = await Promise.all(bases.map(base => new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = httpRequest(base + '/v1/requests', { method: 'POST', headers: { 'content-type': `application/json; charset=${charset}`, authorization: `Bearer ${token}` } }, response => {
          const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(chunk));
          response.on('end', () => resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString() }));
          response.on('error', reject);
        });
        req.setTimeout(15_000, () => req.destroy(Error('chunked request timed out'))); req.on('error', reject);
        // Separate HTTP chunks select the codec before competing later votes.
        req.write(bytes.subarray(0, firstChunk)); req.end(bytes.subarray(firstChunk));
      })));
      assert.equal(results[0]!.status, 201); assert.deepEqual(results[1], results[0], charset);
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
      ...['resources/list', 'prompts/list', 'resources/templates/list', 'resources/read', 'tasks/list', 'unknown'].map(method => [JSON.stringify({ jsonrpc: '2.0', id: 1, method }), {}]),
      ['{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"create_request","arguments":{"title":"Test","body":"Body","idempotencyKey":"numeric-errors","actions":[{"id":"send","label":"Send","type":"submit","2":0,"1":0}]}}}', {}],
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
    for (const capabilities of [JSON.parse('{"experimental":{"__proto__":1}}'), { experimental: { '\ud800': 1 } }, { elicitation: {} }, { sampling: { tools: {}, context: {} } }, { experimental: { feature: {} }, extensions: { feature: [] } }, { tasks: { list: {}, cancel: {} } }, { sampling: { tools: null } }, { elicitation: [] }]) {
      const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities, clientInfo: { name: 'capabilities', version: '1' } } });
      assert.deepEqual(await rpc(bases[1]!, body), await rpc(bases[0]!, body), JSON.stringify(capabilities));
    }
    for (const [charset, encoded] of [['utf-7', '+AOk-+-'], ['utf-7-imap', '&AOk-&-']]) {
      const wire = `{"jsonrpc":"2.0","id":"${encoded}","method":"tools/list"}`;
      assert.deepEqual(await rpc(bases[1]!, wire, { 'content-type': `application/json; charset=${charset}` }), await rpc(bases[0]!, wire, { 'content-type': `application/json; charset=${charset}` }));
    }
    const rawId = Buffer.from('{"jsonrpc":"2.0","id":"' + '\ud800' + '","method":"tools/list"}', 'utf16le');
    assert.deepEqual(await rpc(bases[1]!, rawId, { 'content-type': 'application/json; charset=utf-16le' }), await rpc(bases[0]!, rawId, { 'content-type': 'application/json; charset=utf-16le' }));
    const utf32Id = utf32('{"jsonrpc":"2.0","id":"' + '\ud800' + '","method":"tools/list"}');
    assert.deepEqual(await rpc(bases[1]!, utf32Id, { 'content-type': 'application/json; charset=utf-32le' }), await rpc(bases[0]!, utf32Id, { 'content-type': 'application/json; charset=utf-32le' }));
    for (const [name, args] of [
      ['get_sms_code_request', {}], ['get_sms_code_request', { requestId: 1 }], ['get_sms_code_request', { requestId: '?' }],
      ['request_sms_code', { purpose: '   ', idempotencyKey: 'short' }], ['request_sms_code', { purpose: 'MCP extras', idempotencyKey: 'mcp-extras', ignored: true }],
      ['create_request', { ...form('mcp-extra-form'), ignored: true }], ['create_request', { ...form('mcp-invalid-form'), fields: [{ type: 'invalid' }] }],
      ['create_request', { ...form('mcp-null-field'), fields: [null] }],
      ['create_request', { ...form('mcp-cap-first'), fields: Array(31).fill(null) }],
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
    assert.deepEqual(deletes.map(result => result.status), [202, 202]);
    for (const result of deletes) {
      assert.equal(result.body.ok, true); assert.equal(result.body.status, 'pending');
      assert.match(result.body.receipt, /^smsd_[A-Za-z0-9_-]{43}$/);
      assert.equal(result.body.receiptExpiresAt, time + 24 * 60 * MINUTE);
    }
    assert.notEqual(deletes[0]!.body.receipt, deletes[1]!.body.receipt);
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
  const restored = await fetch(`${base}/projects/demo-sms-relay/accounts:update`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer owner' }, body: JSON.stringify({ localId, validSince: '0' }), signal: AbortSignal.timeout(10_000) });
  assert.equal(restored.status, 200);
  assert.equal((await verify(idToken)).uid, localId);
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

test('Rust durable worker records provider failure and exact backlogs without private context', { timeout: 60_000 }, async () => {
  const rows: Parameters<typeof telemetry.emit>[0][] = [], original = telemetry.emit;
  const native = new RustRelay(db, async () => {}, () => time, async () => { throw { code: 'unavailable' }; });
  telemetry.emit = row => { rows.push(row); };
  try {
    await native.deletions.request(uid);
    assert.equal(rows.filter(row => row.event === 'wakeup_failed').length, 1);
    time += 6 * MINUTE;
    await native.deletions.dispatch(async () => { throw { code: 'permission-denied' }; });
    assert.equal(rows.filter(row => row.event === 'deletion_failed').length, 1);
    await db.collection('results').doc('private-result-id').set({ code: 'private-answer', purgeAt: new Date(time - 301_000) });
    await native.call('telemetryBacklogs', []);
    const snapshot = rows.filter(row => row.event === 'backlog_snapshot');
    assert.equal(snapshot.length, 6);
    const deletion = snapshot.find(row => row.kind === 'deletion');
    assert.ok(deletion?.event === 'backlog_snapshot' && deletion.count === 1 && deletion.oldest_due_age_s >= 360);
    const result = snapshot.find(row => row.kind === 'results');
    assert.ok(result?.event === 'backlog_snapshot' && result.count === 1 && result.oldest_due_age_s === 301);
    assert.ok(!JSON.stringify(rows).includes('private-'));
    time += MINUTE;
    let deleted = 0;
    await native.deletions.dispatch(async () => { deleted++; });
    assert.equal(deleted, 1);
    assert.equal((await db.collection('deletionJobs').doc(hash(uid)).get()).data()?.status, 'completed');
  } finally { telemetry.emit = original; }
});
