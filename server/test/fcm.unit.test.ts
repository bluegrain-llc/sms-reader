import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { GoogleAuth } from 'google-auth-library';
import { FcmNotifier, FCM_DEADLINE_MS } from '../src/fcm.js';
import { Telemetry, category, type Sink } from '../src/telemetry.js';

const id = 'a'.repeat(64);
const headers = (token: string) => new Headers({ Authorization: 'Bearer ' + token, 'x-goog-user-project': 'actual-quota-project' });
const auth = { getProjectId: async () => 'real-google-project', getRequestHeaders: async () => headers('private-access-token') };
type Entry = Parameters<Sink>[0];
async function bounded<T>(work: Promise<T>, ms = 1000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([work, new Promise<never>((_r, reject) => { timer = setTimeout(() => reject(Error('fixture deadline exceeded')), ms); })]); }
  finally { clearTimeout(timer!); }
}
async function readyOrFailure(ready: Promise<void>, outcome: Promise<{ error: unknown }>) {
  await bounded(Promise.race([ready, outcome.then(() => { throw Error('send settled before fixture became ready'); })]));
}
async function closePeers(server: net.Server, peers: Set<net.Socket>) {
  for (const peer of peers) peer.destroy();
  await bounded(new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
}
async function receiver(handler: http.RequestListener) {
  const server = http.createServer(handler).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port, entries: Entry[] = [];
  const notifier = (options: ConstructorParameters<typeof FcmNotifier>[0] = {}) => new FcmNotifier({ auth,
    telemetry: new Telemetry(e => entries.push(e)),
    request: (url, options, response) => {
      assert.equal(url.href, 'https://fcm.googleapis.com/v1/projects/real-google-project/messages:send');
      return http.request({ ...options, hostname: '127.0.0.1', port, path: '/fcm' }, response);
    }, ...options });
  return { server, entries, notifier, async close() { server.closeAllConnections(); await bounded(new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))); } };
}
function completed(entries: Entry[]) {
  return entries.filter((e): e is Entry & { event: 'fcm_send' } => e.event === 'fcm_send' && e.phase === 'completed');
}
async function transportClosed(entries: Entry[], wait: () => Promise<unknown> = () => delay(10)) {
  for (let i = 0; i < 100; i++) {
    if (entries.some(e => e.event === 'fcm_send' && e.phase === 'transport_closed')) return;
    await wait();
  }
  assert(entries.some(e => e.event === 'fcm_send' && e.phase === 'transport_closed'), 'actual socket closure was not observed');
}
test('transport observation rechecks the final interval and still rejects absent closure', async () => {
  const closed: Entry = { event: 'fcm_send', phase: 'transport_closed', attempt_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    kind: 'sms', duration_ms: 1, http_attempts: 1, component: 'relay', severity: 'INFO' };
  const entries: Entry[] = []; let waits = 0;
  await transportClosed(entries, async () => {
    if (++waits === 100) entries.push(closed);
  });
  assert.equal(waits, 100);
  await transportClosed([closed], async () => { assert.fail('already observed closure must not wait'); });
  let absentWaits = 0;
  await assert.rejects(transportClosed([], async () => { absentWaits++; }), /actual socket closure was not observed/);
  assert.equal(absentWaits, 100);
});
test('FCM uses one authenticated HTTP v1 POST and preserves Android/APNs/data payloads', async () => {
  let body: unknown, authorization: string | undefined;
  const r = await receiver((req, res) => {
    authorization = req.headers.authorization; assert.equal(req.headers['x-goog-user-project'], 'actual-quota-project');
    const chunks: Buffer[] = [];
    req.on('data', b => chunks.push(b)); req.on('end', () => { body = JSON.parse(Buffer.concat(chunks).toString()); res.end(JSON.stringify({ name: 'projects/p/messages/accepted' })); });
  });
  try {
    const before = Date.now(); await r.notifier().notify('private-phone-token', id, 60_123, 'form'); const after = Date.now();
    const value = body as any;
    assert.equal(authorization, 'Bearer private-access-token');
    assert.deepEqual(value.message.data, { requestId: id, kind: 'form' });
    assert.deepEqual(value.message.android, { priority: 'high', ttl: '60.123000000s', collapse_key: id });
    assert.equal(value.message.token, 'private-phone-token');
    assert.deepEqual(value.message.apns.payload, { aps: { alert: { title: 'Request Relay', body: 'Open Inbox to review a request.' }, sound: 'default' } });
    const headers = value.message.apns.headers;
    assert.equal(headers['apns-push-type'], 'alert'); assert.equal(headers['apns-priority'], '10'); assert.equal(headers['apns-collapse-id'], id);
    assert(Number(headers['apns-expiration']) >= Math.floor((before + 60_123) / 1000));
    assert(Number(headers['apns-expiration']) <= Math.floor((after + 60_123) / 1000));
    assert.equal(value.message.notification, undefined);
    assert.deepEqual(r.entries.filter(e => (e as any).phase !== 'transport_closed').map(e => (e as any).phase), ['started', 'http_started', 'completed']);
    await transportClosed(r.entries);
    assert.equal(completed(r.entries)[0]?.http_attempts, 1); assert.equal(completed(r.entries)[0]?.outcome, 'accepted');
    assert.equal(new Set(r.entries.map(e => (e as any).attempt_id)).size, 1);
    assert(!JSON.stringify(r.entries).includes('private-'));
    assert(FCM_DEADLINE_MS < 60_000);
  } finally { await r.close(); }
});
test('FCM keeps the configured Firebase project and Firebase environment precedence', { timeout: 10_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'fcm-project-'));
  const credentialPath = join(directory, 'credential.json');
  const keys = ['GOOGLE_CLOUD_PROJECT', 'GCLOUD_PROJECT', 'GOOGLE_APPLICATION_CREDENTIALS'] as const;
  const saved = keys.map(key => [key, process.env[key]] as const);
  t.after(async () => {
    for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(directory, { recursive: true, force: true });
  });
  // Local project discovery only: this fixture never signs or fetches a credential.
  await writeFile(credentialPath, JSON.stringify({ type: 'service_account', project_id: 'credential-project',
    client_email: 'fixture@example.invalid', private_key: 'unused-local-fixture' }), { mode: 0o600 });
  process.env.GOOGLE_APPLICATION_CREDENTIALS = credentialPath;
  const authorizedUrls: string[] = [];
  t.mock.method(GoogleAuth.prototype, 'getRequestHeaders', async (url?: string) => {
    authorizedUrls.push(url!); return headers('local-fixture-token');
  });
  const cases = [
    { name: 'explicit app project overrides conflicting environment', configured: 'configured-project', google: 'google-project', gcloud: 'gcloud-project', expected: 'configured-project' },
    { name: 'GOOGLE_CLOUD_PROJECT overrides conflicting GCLOUD_PROJECT', google: 'google-project', gcloud: 'gcloud-project', expected: 'google-project' },
    { name: 'GOOGLE_CLOUD_PROJECT only', google: 'google-project', expected: 'google-project' },
    { name: 'GCLOUD_PROJECT only', gcloud: 'gcloud-project', expected: 'gcloud-project' },
    { name: 'matching environment projects', google: 'matching-project', gcloud: 'matching-project', expected: 'matching-project' },
    { name: 'empty GOOGLE_CLOUD_PROJECT falls back', google: '', gcloud: 'gcloud-project', expected: 'gcloud-project' },
    { name: 'ADC project discovery without environment project', expected: 'credential-project' },
  ];
  for (const [index, value] of cases.entries()) await t.test(value.name, { timeout: 2000 }, async () => {
    for (const [key, project] of [['GOOGLE_CLOUD_PROJECT', value.google], ['GCLOUD_PROJECT', value.gcloud]] as const) {
      if (project === undefined) delete process.env[key]; else process.env[key] = project;
    }
    const firebase = initializeApp({ projectId: value.configured }, `fcm-project-${index}`);
    const r = await receiver((_req, res) => res.end(JSON.stringify({ name: 'accepted' })));
    const expectedUrl = `https://fcm.googleapis.com/v1/projects/${value.expected}/messages:send`;
    let observedUrl: string | undefined;
    const n = r.notifier({ auth: undefined, projectId: firebase.options.projectId,
      request: (url, options, response) => {
        observedUrl = url.href;
        return http.request({ ...options, hostname: '127.0.0.1', port: (r.server.address() as AddressInfo).port, path: '/fcm' }, response);
      } });
    const pending = n.notify('local-fixture-device', id, 60_000);
    try {
      await bounded(pending);
      assert.equal(observedUrl, expectedUrl);
      assert.equal(authorizedUrls.at(-1), expectedUrl);
      assert.equal(completed(r.entries)[0]?.outcome, 'accepted');
    } finally { n.close(); await r.close(); await bounded(pending.catch(() => {})); await deleteApp(firebase); }
  });
});
test('503 Retry-After3600 fails immediately with no SDK retry or later provider POST', async () => {
  let calls = 0;
  const r = await receiver((_req, res) => { calls++; res.writeHead(503, { 'Retry-After': '3600' }); res.end(JSON.stringify({ error: { status: 'UNAVAILABLE' } })); });
  try {
    const started = performance.now(); await assert.rejects(r.notifier().notify('token', id, 60_000), e => category(e) === 'unavailable');
    assert(performance.now() - started < 2000);
    await delay(80); assert.equal(calls, 1); assert.equal(completed(r.entries)[0]?.http_attempts, 1);
  } finally { await r.close(); }
});
test('late authentication cannot send after the shared deadline', { timeout: 3000 }, async () => {
  let posts = 0, resolve!: (value: Headers) => void;
  const token = new Promise<Headers>(r => { resolve = r; });
  const r = await receiver((_req, res) => { posts++; res.end('{}'); });
  const n = r.notifier({ deadlineMs: 40, auth: { ...auth, getRequestHeaders: () => token } });
  const pending = n.notify('token', id, 60_000);
  try {
    await assert.rejects(bounded(pending, 500), e => category(e) === 'timeout');
    resolve(headers('late-private-token')); await delay(80);
    assert.equal(posts, 0); assert.equal(completed(r.entries)[0]?.http_attempts, 0);
    assert.equal(completed(r.entries).length, 1);
  } finally { n.close(); resolve(headers('cleanup')); await r.close(); await bounded(pending.catch(() => {})); }
});
test('project discovery and auth share one deadline; late rejection stays observed', { timeout: 3000 }, async () => {
  let reject!: (error: Error) => void, calls = 0;
  const project = new Promise<string>((_r, j) => { reject = j; });
  const r = await receiver((_req, res) => { calls++; res.end('{}'); });
  const n = r.notifier({ deadlineMs: 40, auth: { ...auth, getProjectId: () => project } });
  const pending = n.notify('token', id, 60_000);
  try {
    await assert.rejects(bounded(pending, 500), e => category(e) === 'timeout');
    reject(Error('private late credential error')); await delay(30); assert.equal(calls, 0);
  } finally { n.close(); reject(Error('fixture cleanup')); await r.close(); await bounded(pending.catch(() => {})); }
});
test('slow auth does not receive another full HTTP deadline', async () => {
  let calls = 0;
  const r = await receiver((_req, res) => { calls++; setTimeout(() => res.end(JSON.stringify({ name: 'accepted-with-a-fresh-http-budget' })), 90); });
  try {
    const start = performance.now();
    await assert.rejects(r.notifier({ deadlineMs: 150, auth: { ...auth, getRequestHeaders: async () => { await delay(90); return headers('token'); } } }).notify('token', id, 60_000), e => category(e) === 'timeout');
    assert.equal(calls, 1); assert(performance.now() - start < 1000);
    assert((completed(r.entries)[0]?.duration_ms ?? Infinity) < 500);
  } finally { await r.close(); }
});
for (const phase of ['headers', 'body'] as const) test(`deadline destroys an actual socket with hung ${phase}`, { timeout: 3000 }, async () => {
  let closed = false;
  const r = await receiver((_req, res) => { res.on('close', () => { closed = true; }); if (phase === 'body') { res.writeHead(200); res.write('{"name":'); } });
  const n = r.notifier({ deadlineMs: 80 }), pending = n.notify('token', id, 60_000);
  try {
    await assert.rejects(bounded(pending, 500), e => category(e) === 'timeout');
    await transportClosed(r.entries); await delay(30); assert.equal(closed, true); assert.equal(completed(r.entries)[0]?.outcome, 'failed');
  } finally { n.close(); await r.close(); await bounded(pending.catch(() => {})); }
});
test('deadline during TLS never writes a later HTTP POST', { timeout: 3000 }, async () => {
  let closed = false; const chunks: Buffer[] = [], peers = new Set<net.Socket>();
  const server = net.createServer(socket => { peers.add(socket); socket.on('data', b => chunks.push(b)); socket.on('end', () => socket.end()); socket.on('close', () => { closed = true; peers.delete(socket); }); }).listen(0, '127.0.0.1');
  await once(server, 'listening'); const port = (server.address() as AddressInfo).port;
  const entries: Entry[] = [];
  const n = new FcmNotifier({ auth, deadlineMs: 80, telemetry: new Telemetry(e => entries.push(e)),
    request: (_url, options, callback) => https.request({ ...options, hostname: '127.0.0.1', port, servername: 'localhost' }, callback) });
  const pending = n.notify('token', id, 60_000);
  try {
    await assert.rejects(bounded(pending, 500), e => category(e) === 'timeout'); await delay(40);
    assert.equal(closed, true); assert.equal(completed(entries)[0]?.http_attempts, 0); assert(!Buffer.concat(chunks).includes(Buffer.from('POST')));
  } finally { n.close(); await closePeers(server, peers); await bounded(pending.catch(() => {})); }
});
test('a delayed instrumentation callback cannot enqueue a POST after its deadline', async () => {
  let posts = 0;
  const r = await receiver((_req, res) => { posts++; res.end(JSON.stringify({ name: 'accepted' })); });
  try {
    const telemetry = new Telemetry(event => {
      if (event.event === 'fcm_send' && event.phase === 'http_started') {
        const until = performance.now() + 80;
        while (performance.now() < until) { /* Simulate a temporarily blocked event loop. */ }
      }
    });
    await assert.rejects(r.notifier({ deadlineMs: 40, telemetry }).notify('token', id, 60_000), e => category(e) === 'timeout');
    await delay(30); assert.equal(posts, 0);
  } finally { await r.close(); }
});
test('shutdown promptly cancels HTTP work before its natural five-second deadline', { timeout: 3000 }, async () => {
  let posts = 0, started!: () => void;
  const received = new Promise<void>(resolve => { started = resolve; });
  const r = await receiver((_req, res) => { posts++; res.writeHead(200); res.flushHeaders(); started(); });
  const n = r.notifier({ deadlineMs: 5000 });
  const outcome = n.notify('token', id, 60_000).then(() => ({ error: undefined }), error => ({ error }));
  try {
    await readyOrFailure(received, outcome);
    n.close();
    assert.equal(category((await bounded(outcome, 250)).error), 'timeout');
    await assert.rejects(n.notify('token', id, 60_000));
    assert.equal(posts, 1);
  } finally { n.close(); await r.close(); await bounded(outcome); }
});
test('shutdown promptly cancels auth and late credentials cannot POST', { timeout: 3000 }, async () => {
  let posts = 0, resolve!: (value: Headers) => void, authStarted!: () => void;
  const discovering = new Promise<void>(r => { authStarted = r; });
  const credentials = new Promise<Headers>(r => { resolve = r; });
  const r = await receiver((_req, res) => { posts++; res.end(JSON.stringify({ name: 'accepted' })); });
  const n = r.notifier({ deadlineMs: 5000, auth: { ...auth, getRequestHeaders: () => { authStarted(); return credentials; } } });
  const outcome = n.notify('token', id, 60_000).then(() => ({ error: undefined }), error => ({ error }));
  try {
    await readyOrFailure(discovering, outcome);
    n.close();
    assert.equal(category((await bounded(outcome, 250)).error), 'timeout');
    resolve(headers('late')); await delay(30);
    assert.equal(posts, 0);
  } finally { n.close(); resolve(headers('cleanup')); await r.close(); await bounded(outcome); }
});
test('readiness failure and accepted TLS peers have bounded fixture cleanup', { timeout: 3000 }, async () => {
  await assert.rejects(readyOrFailure(new Promise(() => {}), Promise.resolve({ error: Error('early send failure') })), /before fixture/);
  await assert.rejects(bounded(new Promise(() => {}), 20), /fixture deadline/);
  const peers = new Set<net.Socket>();
  const server = net.createServer(socket => { peers.add(socket); }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const client = net.connect((server.address() as AddressInfo).port, '127.0.0.1');
  try {
    await bounded(once(client, 'connect'));
    assert.equal(peers.size, 1);
    // Exercise finally cleanup with a peer that deliberately never ends itself.
    await assert.rejects(Promise.reject(Error('simulated failed transport assertion')));
  } finally { try { await closePeers(server, peers); } finally { client.destroy(); } }
});
test('FCM destination/quota/unavailable classification excludes provider response secrets', async () => {
  let errorCode = 'UNREGISTERED', status = 404;
  const r = await receiver((_req, res) => { res.writeHead(status); res.end(JSON.stringify({ error: { message: 'private response', details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode }] } })); });
  try {
    for (const [code, httpStatus, expected] of [['UNREGISTERED', 404, 'destination'], ['QUOTA_EXCEEDED', 429, 'quota'], ['UNAVAILABLE', 503, 'unavailable'], ['INVALID_ARGUMENT', 400, 'internal']] as const) {
      errorCode = code; status = httpStatus;
      await assert.rejects(r.notifier().notify('private-phone-token', id, 60_000), e => category(e) === expected && !String(e).includes('private response'));
    }
    assert(!JSON.stringify(r.entries).includes('private'));
  } finally { await r.close(); }
});
test('oversized, truncated, malformed success and redirect responses never count as acceptance', async () => {
  let mode = 'large', redirected = 0;
  const r = await receiver((_req, res) => {
    if (mode === 'large') res.end(JSON.stringify({ name: 'x'.repeat(65 * 1024) }));
    else if (mode === 'redirect') { redirected++; res.writeHead(307, { Location: '/other' }); res.end('{}'); }
    else if (mode === 'truncated') { res.writeHead(200, { 'Content-Length': '1000' }); res.end('{"name":"short"}'); }
    else res.end('{}');
  });
  try {
    for (const value of ['large', 'redirect', 'truncated', 'malformed']) { mode = value; await assert.rejects(r.notifier().notify('token', id, 60_000)); }
    assert.equal(redirected, 1); assert(completed(r.entries).every(e => e.outcome === 'failed'));
  } finally { await r.close(); }
});
