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

test('an HTTP proxy that retains its upstream request hides disconnect while actual sender timeout evidence passes', { timeout: 16000 }, async () => {
  const { createServer, request } = await import('node:http');
  const firstAt = Date.now(), actualReceipts = [], observed = {}, logs = [];
  let prematureBackendClose = false, attempts = 0;
  const backend = createServer(async (_req, response) => {
    const attempt = ++attempts, receipt = { id: 'event', attempt, status: 204, at: Date.now() };
    actualReceipts.push(receipt);
    response.once('close', () => { if (!response.writableFinished) prematureBackendClose = true; });
    if (attempt === 1) receipt.withheldResponseMs = await withholdCallbackResponse();
    response.on('finish', () => { receipt.responseFinished = true; });
    response.writeHead(204); response.end();
  });
  const proxy = createServer((_req, response) => {
    // Cloud Run HTTP1 keeps the upstream alive after its downstream disconnects.
    const upstream = request({ host: '127.0.0.1', port: backend.address().port }, reply => { response.writeHead(reply.statusCode); reply.pipe(response); });
    upstream.on('error', () => response.destroy()); upstream.end();
  });
  const listen = server => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try {
    await listen(backend); await listen(proxy);
    observeWebhookJob([job('actual-lease')], expected, observed);
    await new Promise((resolve, reject) => {
      const outgoing = request({ host: '127.0.0.1', port: proxy.address().port }, () => reject(Error('first response arrived before sender deadline')));
      const timer = setTimeout(() => outgoing.destroy(Error('webhook_timeout')), 10000);
      outgoing.on('error', error => {
        clearTimeout(timer);
        if (error.message !== 'webhook_timeout') return reject(error);
        logs.push({ ...log, timestamp: new Date().toISOString() });
        observeWebhookJob([job(null)], expected, observed);
        resolve();
      });
      outgoing.end();
    });
    const end = Date.now() + 3000;
    while (!actualReceipts[0]?.responseFinished && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(actualReceipts[0].responseFinished, true);
    assert.equal(prematureBackendClose, false);
    await new Promise((resolve, reject) => {
      const outgoing = request({ host: '127.0.0.1', port: proxy.address().port }, reply => { reply.resume(); reply.on('end', resolve); });
      outgoing.on('error', reject); outgoing.end();
    });
    const proof = proveWebhookTimeout(actualReceipts, observed, logs, cfg, revision, firstAt);
    callbackReceipts('timeout-once', actualReceipts, proof);
  } finally {
    proxy.closeAllConnections(); backend.closeAllConnections();
    await Promise.all([proxy, backend].map(server => new Promise(resolve => server.close(resolve))));
  }
});
