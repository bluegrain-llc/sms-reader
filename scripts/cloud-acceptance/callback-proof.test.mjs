import test from 'node:test';
import assert from 'node:assert/strict';
import { callbackFacts, callbackJobId, callbackReceipts, checkedScenario, observeWebhookJob, proveWebhookTimeout, stagingDocumentReader, withholdCallbackResponse } from './core.mjs';

const cfg = { projectId: 'relay-staging', service: 'sms-relay', account: 'operator@example.com' }, revision = 'sms-relay-tested';
const expected = { ownerId: 'owner', hookId: 'hook', requestId: 'request', eventId: 'event', id: callbackJobId('event', 'hook') };
const receipts = [{ id: 'event', attempt: 1, status: 204, at: 1000, withheldResponseMs: 11000, clientClosedBeforeResponse: false }, { id: 'event', attempt: 2, status: 204, responseFinished: true }];
const log = { timestamp: new Date(11000).toISOString(), resource: { type: 'cloud_run_revision', labels: { project_id: cfg.projectId, service_name: cfg.service, revision_name: revision } }, jsonPayload: { event: 'delivery_attempt', kind: 'webhook', outcome: 'failed', category: 'timeout' } };
function job(lease, attempts = 1, patch = {}) {
  return { name: 'projects/relay-staging/databases/(default)/documents/deliveryOutbox/' + expected.id, fields: { ...Object.fromEntries(Object.entries({ ...expected, kind: 'webhook', ...patch }).map(([key, value]) => [key, { stringValue: value }])), attempts: { integerValue: String(attempts) }, lease: lease === null ? { nullValue: null } : { stringValue: lease }, nextAt: { integerValue: '13500' } } };
}
function witness() {
  const value = {};
  observeWebhookJob([job('claimed-lease')], expected, value, 1500);
  observeWebhookJob([job(null)], expected, value, 11500);
  return value;
}
test('Cloud Run no-disconnect timeout passes only with exact failed sender lease and real correlated timeout evidence', () => {
  const proof = proveWebhookTimeout(receipts, witness(), [log], cfg, revision, 500);
  callbackReceipts('timeout-once', receipts, proof);
  assert.equal(proof.senderTimeoutObserved, true);
  assert.deepEqual(callbackFacts(receipts, proof), { callbackReceiptCount: 2, firstResponseWithheldMs: 11000, senderLeaseFailureObserved: true, senderTimeoutObserved: true });
});
test('a delayed204, completed500, client close or unrelated telemetry alone cannot establish sender timeout', () => {
  for (const missing of [undefined, {}, { failed: true }, { claimed: true }]) {
    assert.throws(() => callbackReceipts('timeout-once', receipts, missing));
    assert.throws(() => proveWebhookTimeout(receipts, missing ?? {}, [log], cfg, revision, 500));
  }
  const proof = proveWebhookTimeout(receipts, witness(), [log], cfg, revision, 500);
  for (const patch of [{ status: 500 }, { withheldResponseMs: 10999 }, { withheldResponseMs: undefined }, { withheldResponseMs: Infinity }]) assert.throws(() => callbackReceipts('timeout-once', [{ ...receipts[0], ...patch }, receipts[1]], proof));
  assert.throws(() => callbackReceipts('timeout-once', [receipts[0]], proof));
  assert.throws(() => callbackReceipts('timeout-once', [receipts[0], { ...receipts[1], responseFinished: false }], proof));
  for (const entries of [[], [log, log], [{ ...log, jsonPayload: { ...log.jsonPayload, category: 'rejected' } }], [{ ...log, jsonPayload: { ...log.jsonPayload, outcome: 'accepted' } }], [{ ...log, resource: { ...log.resource, labels: { ...log.resource.labels, revision_name: 'unrelated' } } }], [{ ...log, resource: { ...log.resource, labels: { ...log.resource.labels, project_id: 'other-staging' } } }], [{ ...log, timestamp: new Date(13000).toISOString() }], [{ ...log, timestamp: new Date(500).toISOString() }]]) assert.throws(() => proveWebhookTimeout(receipts, witness(), entries, cfg, revision, 500));
});
test('global webhook inventory rejects concurrent or unrelated jobs and requires an observed claimed-to-failed transition', () => {
  for (const rows of [[job('lease'), job('second')], [job('lease', 1, { hookId: 'other' })], [job('lease', 1, { ownerId: 'other' })], [job('lease', 1, { eventId: 'other' })]]) assert.throws(() => observeWebhookJob(rows, expected, {}));
  const missed = {}; observeWebhookJob([job(null)], expected, missed, 11500);
  assert.throws(() => proveWebhookTimeout(receipts, missed, [log], cfg, revision, 500));
  const retry = {}; observeWebhookJob([job('lease', 2)], expected, retry); observeWebhookJob([job(null, 2)], expected, retry);
  assert.throws(() => proveWebhookTimeout(receipts, retry, [log], cfg, revision, 500));
});
test('response withholding measures real elapsed delay without waiting for a proxy disconnect event', async () => {
  const elapsed = await withholdCallbackResponse(20);
  assert.ok(elapsed >= 20);
});
test('webhook inventory uses explicit staging operator credentials and bounded field projection without callback secrets', async () => {
  const reader = await stagingDocumentReader(cfg, {
    executeCommand: async (command, args) => { assert.equal(command, 'gcloud'); assert.ok(args.includes('--account=operator@example.com')); assert.ok(args.includes('--project=relay-staging')); return { stdout: 'private-test-token' }; },
    fetchDocument: async (url, options) => {
      assert.equal(url, 'https://firestore.googleapis.com/v1/projects/relay-staging/databases/(default)/documents:runQuery');
      const query = JSON.parse(options.body).structuredQuery;
      assert.equal(query.limit, 2); assert.equal(query.where.fieldFilter.value.stringValue, 'webhook');
      assert.deepEqual(query.select.fields.map(f => f.fieldPath), ['id', 'requestId', 'ownerId', 'eventId', 'hookId', 'kind', 'attempts', 'lease', 'nextAt']);
      return { ok: true, json: async () => [{ readTime: 'now' }, { document: job('lease') }] };
    },
  });
  assert.deepEqual(await reader.webhookJobs(), [job('lease')]);
});
test('failed callback checks retain only allowlisted numeric and boolean evidence before fixture cleanup', async () => {
  const results = [];
  await assert.rejects(checkedScenario(results, 'webhook-timeout', async () => { throw Object.assign(Error('provider body must stay private'), { callbackFacts: { ...callbackFacts(receipts, witness()), ownerId: 'private-owner', secret: 'private-secret', senderTimeoutObserved: 'forged', firstResponseWithheldMs: Infinity } }); }));
  assert.equal(results[0].callbackReceiptCount, 2); assert.equal(results[0].senderLeaseFailureObserved, true);
  const encoded = JSON.stringify(results); for (const text of ['private-owner', 'private-secret', 'provider body', 'forged']) assert.equal(encoded.includes(text), false);
  assert.equal('senderTimeoutObserved' in results[0], false); assert.equal('firstResponseWithheldMs' in results[0], false);
});

// Every fixture request owns its deadline and handles response aborts, so a
// node:test timeout is never responsible for releasing listening servers.
async function boundedRequest(port, { signal, timeoutMs = 2000 } = {}) {
  const { request } = await import('node:http');
  return new Promise((resolve, reject) => {
    let response, settled = false;
    const finish = error => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (error) { response?.destroy(); outgoing.destroy(); reject(error); }
      else resolve();
    };
    const abort = () => finish(signal.reason ?? Error('request_aborted'));
    const outgoing = request({ host: '127.0.0.1', port }, reply => {
      response = reply;
      reply.on('error', finish);
      reply.once('aborted', () => finish(Error('response_aborted')));
      reply.once('end', () => finish()); reply.resume();
    });
    const timer = setTimeout(() => finish(Error('request_timeout')), timeoutMs);
    outgoing.on('error', finish);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort(); else outgoing.end();
  });
}
async function closeFixture(...servers) {
  await Promise.all(servers.map(server => new Promise(resolve => {
    server.close(resolve); server.closeAllConnections();
  })));
}
async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
}
test('stalled and aborted HTTP responses reject locally and fixture servers close', { timeout: 3000 }, async () => {
  const { createServer } = await import('node:http');
  for (const mode of ['no-headers', 'no-end', 'aborted']) {
    const server = createServer((_request, response) => {
      if (mode === 'no-headers') return;
      response.writeHead(200); response.write('partial');
      if (mode === 'aborted') setImmediate(() => response.destroy());
    });
    try {
      await listen(server);
      await assert.rejects(boundedRequest(server.address().port, { timeoutMs: 50 }), mode === 'aborted' ? /response_aborted/ : /request_timeout/);
    } finally { await closeFixture(server); }
    assert.equal(server.listening, false);
  }
  const server = createServer(() => {}), controller = new AbortController();
  try {
    await listen(server);
    const pending = boundedRequest(server.address().port, { signal: controller.signal });
    controller.abort(Error('fixture_cancelled'));
    await assert.rejects(pending, /fixture_cancelled/);
  } finally { await closeFixture(server); }
  assert.equal(server.listening, false);
});

test('an HTTP proxy that retains its upstream request hides disconnect while actual sender timeout evidence passes', { timeout: 22000 }, async t => {
  const { createServer, request } = await import('node:http');
  const { setTimeout: delay } = await import('node:timers/promises');
  const controller = new AbortController(), signal = AbortSignal.any([controller.signal, t.signal]);
  const deadline = setTimeout(() => controller.abort(Error('fixture_deadline')), 20000);
  const firstFinished = Promise.withResolvers();
  // Attach the rejection consumer immediately, including during sender I/O.
  firstFinished.promise.catch(() => {});
  const abort = () => firstFinished.reject(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  const firstAt = Date.now(), actualReceipts = [], observed = {}, logs = [];
  let prematureBackendClose = false, attempts = 0;
  const backend = createServer(async (_req, response) => {
    const attempt = ++attempts, receipt = { id: 'event', attempt, status: 204, at: Date.now() };
    actualReceipts.push(receipt);
    response.once('close', () => { if (!response.writableFinished) prematureBackendClose = true; });
    try {
      if (attempt === 1) {
        const started = performance.now();
        // Abortable fixture equivalent of the receiver's real eleven-second hold.
        do { await delay(Math.ceil(11000 - (performance.now() - started)), undefined, { signal }); }
        while (performance.now() - started < 11000);
        receipt.withheldResponseMs = Math.floor(performance.now() - started);
      }
      response.on('finish', () => {
        receipt.responseFinished = true;
        if (attempt === 1) firstFinished.resolve();
      });
      response.writeHead(204); response.end();
    } catch (error) { firstFinished.reject(error); response.destroy(); }
  });
  const proxy = createServer(async (_req, response) => {
    try {
      // Deliberately accept upstream late enough to exceed the old polling
      // deadline. Completion is synchronized to backend finish, not sender time.
      if (attempts === 0) await delay(2200, undefined, { signal });
      // Cloud Run HTTP1 keeps upstream alive after downstream disconnects.
      const upstream = request({ host: '127.0.0.1', port: backend.address().port, signal }, reply => { response.writeHead(reply.statusCode); reply.pipe(response); });
      upstream.on('error', () => response.destroy()); upstream.end();
    } catch { response.destroy(); }
  });
  try {
    await listen(backend); await listen(proxy);
    observeWebhookJob([job('actual-lease')], expected, observed);
    await assert.rejects(boundedRequest(proxy.address().port, { signal, timeoutMs: 10000 }), error => {
      if (error.message !== 'request_timeout') return false;
      logs.push({ ...log, timestamp: new Date().toISOString() });
      observeWebhookJob([job(null)], expected, observed);
      return true;
    });
    await firstFinished.promise;
    assert.equal(actualReceipts[0].responseFinished, true);
    assert.equal(prematureBackendClose, false);
    await boundedRequest(proxy.address().port, { signal });
    const proof = proveWebhookTimeout(actualReceipts, observed, logs, cfg, revision, firstAt);
    callbackReceipts('timeout-once', actualReceipts, proof);
  } finally {
    clearTimeout(deadline); signal.removeEventListener('abort', abort);
    controller.abort(Error('fixture_cleanup'));
    await closeFixture(proxy, backend);
  }
});
