#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { activeTtl, callbackJobId, callbackReceipts, checkedScenario, cloud, config, fixtureCredentials, ownerClaims, preflight, preserveExpiryFixture, privateValue, proveCancellation, readyIndexes, replayProgress, report, request, requireThat, runInterrupts, scenarios, settlePairings, stagingDocumentReader, winnerAgreement, writeReport } from './core.mjs';

const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const configPath = option('--config'), evidencePath = option('--evidence');
if (!configPath || (!evidencePath && !args.includes('--plan'))) {
  console.error('Usage: node scripts/cloud-acceptance/run.mjs --config PRIVATE.json --evidence NEW.json [--plan]'); process.exit(1);
}
let cfg;
try { cfg = config(JSON.parse(await readFile(configPath, 'utf8'))); }
catch { console.error('Acceptance configuration rejected.'); process.exit(1); }
if (args.includes('--plan')) {
  console.log(JSON.stringify({ projectId: cfg.projectId, service: cfg.service, budgetUsd: cfg.budgetUsd, scenarios, destructive: 'Creates fixtures and deletes the explicitly configured disposable owner account.', productionAllowed: false }));
  process.exit(0);
}
const results = [], startedAt = new Date().toISOString(), runId = randomUUID();
const preflightStarted = Date.now();
const interrupts = runInterrupts(); cfg.signal = interrupts.signal;
const wait = ms => delay(ms, undefined, { signal: cfg.signal });
let context = {}, caller, otherCaller, owner, credentials, hookIds = [], collectorIds = [], createdDevices = [], apiStarted = false;
const pairingCodes = []; let pairingCreationUncertain = false;
const call = (path, token, body, method, origin = cfg.serviceUrl) => request(origin, path, token, body, method, cfg.signal);
const ok = async (...params) => { const r = await call(...params); requireThat(r.status >= 200 && r.status < 300, 'unexpected_api_status'); return r.value; };
const ownerToken = async () => { const value = await privateValue(cfg.ownerTokenFile); ownerClaims(value, cfg.disposableOwnerUid, cfg.projectId); return value; };
const check = (scenario, fn) => checkedScenario(results, scenario, async () => { cfg.signal?.throwIfAborted(); const facts = await fn(); cfg.signal?.throwIfAborted(); return facts; });
const pending = (scenario, reason) => results.push({ scenario, status: 'pending', reason });
async function startPairing(callerName, purpose) {
  pairingCreationUncertain = true;
  const connection = await ok('/v1/connections', undefined, { callerName, purpose, expiresInDays: 1 });
  requireThat(typeof connection.userCode === 'string', 'pairing_code_missing');
  pairingCodes.push(connection.userCode); pairingCreationUncertain = false;
  return connection;
}
async function until(fn, timeoutMs = 150_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { cfg.signal?.throwIfAborted(); const value = await fn(); cfg.signal?.throwIfAborted(); if (value) return value; await wait(2_000); }
  throw new Error('acceptance_deadline');
}
async function callbackProbe(mode) {
  requireThat(cfg.callbackUrl && cfg.callbackAdminTokenFile, 'callback_receiver_required');
  const admin = credentials.callbackAdmin, id = randomUUID(); collectorIds.push(id);
  const hook = await ok('/v2/webhooks', caller, { url: `${cfg.callbackUrl}/hooks/${id}`, events: ['request.created'] }); hookIds.push(hook.id);
  const configured = await request(cfg.callbackUrl, `/admin/${id}`, admin, { secret: hook.secret, mode }, 'POST', cfg.signal);
  requireThat(configured.status === 201, 'receiver_configuration_failed');
  const form = await ok('/v2/requests', caller, { title: 'Cloud callback probe', body: 'Synthetic staging fixture.', idempotencyKey: randomUUID(), fields: [], actions: [{ id: 'ok', label: 'OK', type: 'acknowledge' }] });
  try {
    const receipts = await until(async () => {
      const response = await request(cfg.callbackUrl, `/admin/${id}`, admin, undefined, 'GET', cfg.signal);
      requireThat(response.status === 200, 'receiver_unavailable');
      const values = response.value.receipts.filter(r => r.requestId === form.requestId);
      return values.some(r => r.attempt >= 2 && r.status === 204 && r.responseFinished === true) && (mode !== 'timeout-once' || values.some(r => r.attempt === 1 && r.clientClosedBeforeResponse !== undefined)) ? values : null;
    });
    callbackReceipts(mode, receipts);
    const read = await stagingDocumentReader(cfg), jobId = callbackJobId(receipts[0].id, hook.id);
    await until(async () => (await read('deliveryOutbox', jobId)) === null);
    requireThat((await ok(`/v2/requests/${form.requestId}`, caller)).status === 'pending', 'callback_fixture_not_active');
    requireThat((await ok('/v2/webhooks', caller)).some(h => h.id === hook.id), 'callback_hook_removed');
    requireThat((await ok('/v2/events', caller)).events.some(e => e.id === receipts[0].id), 'callback_event_removed');
    return { attempts: receipts.length, verifiedPublicTls: true, verifiedSignedEvent: true, senderOutboxRetired: true };
  } finally { await ok(`/v2/requests/${form.requestId}/cancel`, caller, {}); }
}

try {
  // Complete the cloud guard before reading credentials or sending any mutating request.
  context = await preflight(cfg, cloud, facts => { context = facts; });
  credentials = await fixtureCredentials(cfg); owner = credentials.owner;
  if (cfg.callbackUrl) requireThat((await request(cfg.callbackUrl, `/admin/${randomUUID()}`, credentials.callbackAdmin, undefined, 'GET', cfg.signal)).status === 404, 'callback_admin_preflight_failed');
  requireThat((await ok('/v1/devices', owner)).length === 0 && (await ok('/v1/callers', owner)).length === 0, 'fresh_disposable_owner_required');
  await check('infrastructure', async () => {
    const health = await call('/health'); requireThat(health.status === 200 && health.value?.ok === true, 'health_failed');
    for (const path of ['/internal/delivery', '/internal/maintenance']) {
      requireThat((await call(path, undefined, {})).status === 401 && (await call(path, owner, {})).status === 401, 'worker_identity_boundary');
    }
    const indexes = await cloud(cfg, ['firestore', 'indexes', 'composite', 'list']);
    const ttlSpec = JSON.parse(await readFile(new URL('../../firestore.indexes.json', import.meta.url), 'utf8'));
    readyIndexes(indexes, ttlSpec.indexes);
    const fields = await cloud(cfg, ['firestore', 'fields', 'ttls', 'list']);
    const collections = ttlSpec.fieldOverrides.filter(field => field.ttl).map(field => field.collectionGroup);
    if (cfg.callbackUrl) collections.push('acceptanceCallbacks');
    for (const collection of collections) {
      requireThat(activeTtl(fields, collection), 'ttl_not_active');
    }
    return { readyIndexes: indexes.length, activeTtlPolicies: fields.filter(f => f.ttlConfig?.state === 'ACTIVE').length };
  });
  await check('device-setup', async () => {
    apiStarted = true;
    for (const fcmToken of credentials.phones) {
      const id = randomUUID();
      await ok(`/v1/devices/${id}`, owner, { name: 'Cloud acceptance fixture', fcmToken, wizardVersion: 1 }, 'PUT'); createdDevices.push(id);
    }
    return { registeredDevices: createdDevices.length };
  });
  await check('pairing', async () => {
    const connection = await startPairing('Staging acceptance', 'Disposable cloud verification fixture.');
    caller = connection.connectionToken;
    requireThat((await call('/mcp', caller, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status === 401, 'pending_credential_authorized');
    await ok('/v1/connections/decision', owner, { userCode: connection.userCode, decision: 'approved' });
    const state = await ok('/v1/connections/poll', caller, {}); requireThat(state.status === 'approved', 'pairing_not_approved');
    const other = await startPairing('Staging isolation fixture', 'Independent disposable caller.');
    await ok('/v1/connections/decision', owner, { userCode: other.userCode, decision: 'approved' }); otherCaller = other.connectionToken;
    const grants = await ok('/v1/callers', owner);
    for (const name of ['Staging acceptance', 'Staging isolation fixture']) {
      const grant = grants.find(g => g.callerName === name); requireThat(grant, 'grant_missing');
      await ok(`/v2/grants/${grant.grantId}/forms`, owner, { approved: true }, 'PUT');
    }
    await ok('/v2/events', otherCaller);
    const client = new Client({ name: 'cloud-acceptance', version: '1' });
    const abortClient = () => { void client.close().catch(() => {}); };
    cfg.signal.addEventListener('abort', abortClient, { once: true });
    try {
      cfg.signal.throwIfAborted();
      await client.connect(new StreamableHTTPClientTransport(new URL(`${cfg.serviceUrl}/mcp`), { requestInit: { headers: { authorization: `Bearer ${caller}` } } }));
      const names = new Set((await client.listTools()).tools.map(t => t.name));
      for (const name of ['request_sms_code', 'get_sms_code_request', 'cancel_sms_code_request', 'create_request', 'inspect_request', 'cancel_request', 'get_request_result', 'poll_request_events']) requireThat(names.has(name), 'mcp_tool_missing');
      const created = await client.callTool({ name: 'create_request', arguments: { title: 'MCP fixture', body: 'Synthetic.', idempotencyKey: randomUUID(), fields: [], actions: [{ id: 'ok', label: 'OK', type: 'acknowledge' }] } });
      requireThat(!created.isError, 'mcp_create_failed'); const value = JSON.parse(created.content[0].text);
      await proveCancellation(value.requestId, async () => {
        const cancelled = await client.callTool({ name: 'cancel_request', arguments: { requestId: value.requestId } });
        requireThat(!cancelled.isError, 'mcp_cancel_failed'); return JSON.parse(cancelled.content[0].text);
      }, () => ok(`/v2/requests/${value.requestId}`, caller), async () => (await ok('/v2/events', caller)).events);
    } finally { cfg.signal.removeEventListener('abort', abortClient); await client.close(); }
    return { googleAuthenticated: true, mcpRoundTrip: true };
  });
  await check('sms-api', async () => {
    const body = { title: 'Synthetic manual fixture', purpose: 'No real SMS is requested or consumed.', idempotencyKey: randomUUID() };
    const r = await ok('/v1/requests', caller, body);
    requireThat((await ok('/v1/requests', caller, body)).requestId === r.requestId, 'sms_idempotency_failed');
    requireThat(!(await ok(`/v1/requests/${r.requestId}`, caller)).code, 'code_before_submission');
    const fakeCaller = `smsr_${randomBytes(32).toString('base64url')}`;
    requireThat((await call(`/v1/requests/${r.requestId}`, fakeCaller)).status === 401, 'foreign_caller_authorized');
    requireThat((await call(`/v1/requests/${r.requestId}`, otherCaller)).status === 404, 'other_valid_caller_authorized');
    await ok(`/v1/devices/${createdDevices[0]}/requests/${r.requestId}/events`, owner, { status: 'ready', listenerStartedAt: Date.now() });
    const code = `T${randomBytes(4).readUInt32BE() % 10000000}`.padEnd(8, '0');
    await ok(`/v1/devices/${createdDevices[0]}/requests/${r.requestId}/events`, owner, { status: 'completed', source: 'manual', code });
    requireThat((await ok(`/v1/requests/${r.requestId}`, caller)).code === code, 'manual_result_mismatch');
    requireThat((await call(`/v1/requests/${r.requestId}`, otherCaller)).status === 404, 'completed_sms_result_leaked');
    const other = await ok(`/v1/devices/${createdDevices[1]}/requests/${r.requestId}`, owner); requireThat(!('code' in other), 'code_leaked_to_phone');
    const proveRetained = await preserveExpiryFixture(cfg, r.requestId);
    await wait(121_000);
    await proveRetained();
    requireThat(!(await ok(`/v1/requests/${r.requestId}`, caller)).code, 'result_expiry_failed');
    return { source: 'synthetic_manual_api', physicalConsentProven: false, expiryWaitMs: 121000, expiredResultRetainedBeforeApiRead: true };
  });
  await check('forms-wizard', async () => {
    const definition = { title: 'Synthetic wizard', body: 'Synthetic cloud acceptance.', idempotencyKey: randomUUID(), fields: [{ id: 'enabled', type: 'checkbox' }, { id: 'note', type: 'text', required: true }].map(f => ({ ...f, label: f.id })), steps: [{ id: 'start', title: 'Start', fieldIds: ['enabled'] }, { id: 'branch', title: 'Branch', fieldIds: ['note'], when: { fieldId: 'enabled', equals: true } }], actions: [{ id: 'submit', label: 'Submit', type: 'submit' }] };
    const form = await ok('/v2/requests', caller, definition);
    requireThat((await ok('/v2/requests', caller, definition)).requestId === form.requestId, 'wizard_idempotency_failed');
    await until(async () => {
      const page = await ok('/v2/events', caller);
      return new Set(page.events.filter(e => e.requestId === form.requestId && e.type === 'notification.accepted').map(e => e.deviceId)).size === 2;
    });
    const wrong = await call(`/v2/devices/${createdDevices[0]}/requests/${form.requestId}/submissions`, owner, { submissionId: randomUUID(), action: 'submit', values: { enabled: false, note: 'hidden' } }); requireThat(wrong.status === 400, 'hidden_branch_accepted');
    const uploads = createdDevices.map((id, i) => ({ id, body: { submissionId: randomUUID(), action: 'submit', values: { enabled: true, note: `synthetic-${i}` } } }));
    const submit = upload => ok(`/v2/devices/${upload.id}/requests/${form.requestId}/submissions`, owner, upload.body);
    const responses = await Promise.all(uploads.map(submit));
    const winningDevice = winnerAgreement(responses, createdDevices);
    const result = await ok(`/v2/requests/${form.requestId}/result`, caller); requireThat(['synthetic-0', 'synthetic-1'].includes(result.result?.values?.note), 'wizard_winner_invalid');
    const winner = uploads.find(u => u.id === winningDevice), loser = uploads.find(u => u.id !== winningDevice);
    requireThat(result.result.values.note === winner.body.values.note, 'wizard_winner_value_mismatch');
    requireThat((await call(`/v2/requests/${form.requestId}/result`, otherCaller)).status === 404, 'completed_wizard_result_leaked');
    winnerAgreement([await submit(loser), await submit(winner)], [winningDevice]);
    requireThat(JSON.stringify((await ok(`/v2/requests/${form.requestId}/result`, caller)).result) === JSON.stringify(result.result), 'wizard_result_overwritten');
    const terminalEvents = (await ok('/v2/events', caller)).events.filter(e => e.requestId === form.requestId && e.type === 'request.submitted');
    requireThat(terminalEvents.length === 1, 'duplicate_terminal_submission');
    return { competingPhones: 2, acceptedResults: 1, fcmAcceptedDevices: 2, phoneDisplayProven: false };
  });
  await check('events-replay', async () => {
    requireThat(cfg.replayUrl, 'second_revision_required');
    const first = await ok('/v2/events', caller);
    requireThat(first.events.length > 0, 'events_missing');
    const cursor = first.events[0].id;
    const expected = await ok(`/v2/events?cursor=${encodeURIComponent(cursor)}`, caller);
    const response = await fetch(`${cfg.replayUrl}/v2/events/stream`, { headers: { authorization: `Bearer ${caller}`, 'Last-Event-ID': cursor }, signal: AbortSignal.any([cfg.signal, AbortSignal.timeout(15_000)]), redirect: 'error' });
    requireThat(response.ok && response.headers.get('content-type')?.startsWith('text/event-stream'), 'sse_unavailable');
    const reader = response.body.getReader(), decoder = new TextDecoder(); let text = '';
    try {
      while (!replayProgress(text, expected.events, cursor)) { const next = await reader.read(); requireThat(!next.done, 'sse_replay_incomplete'); text += decoder.decode(next.value, { stream: true }); requireThat(text.length < 262144, 'sse_too_large'); }
    } finally { await reader.cancel(); }
    return { replayedEvents: expected.events.length, distinctRevisionOrigin: cfg.replayUrl !== cfg.serviceUrl };
  });
  if (cfg.callbackUrl) {
    await check('webhook-tls-retry', () => callbackProbe('fail-once'));
    await check('webhook-timeout', () => callbackProbe('timeout-once'));
  } else { pending('webhook-tls-retry', 'public_receiver_required'); pending('webhook-timeout', 'public_receiver_required'); }
  for (const name of ['enqueue-recovery', 'worker-recovery', 'duplicate-delivery', 'provider-outage', 'storage-outage']) pending(name, 'operator_fault_drill_required');
} catch {
  // Never print arbitrary provider errors, responses, tokens or submitted values.
  if (!results.some(r => r.status === 'failed')) {
    const previous = results.find(r => r.scenario === 'infrastructure');
    if (previous) previous.status = 'failed'; else results.push({ scenario: 'infrastructure', status: 'failed', ...(context.revision ? { durationMs: Date.now() - preflightStarted } : {}) });
  }
}
finally {
  cfg.signal = undefined;
  if (!results.some(r => r.scenario === 'infrastructure')) results.push({ scenario: 'infrastructure', status: 'failed' });
  let cleaned = !apiStarted;
  let receiverCleaned = true;
  let pairingsCleaned = !pairingCreationUncertain;
  if (apiStarted) {
    for (const id of hookIds) { try { await ok(`/v2/webhooks/${id}`, caller, undefined, 'DELETE'); } catch { /* owner deletion retries cleanup */ } }
    if (cfg.callbackUrl && cfg.callbackAdminTokenFile) {
      for (const id of collectorIds) { try { const r = await request(cfg.callbackUrl, `/admin/${id}`, await privateValue(cfg.callbackAdminTokenFile), undefined, 'DELETE'); requireThat(r.status === 200, 'receiver_cleanup_failed'); } catch { receiverCleaned = false; } }
    }
    try {
      owner = await ownerToken(); const claims = ownerClaims(owner, cfg.disposableOwnerUid, cfg.projectId);
      requireThat(Date.now() - claims.auth_time * 1000 < 300_000, 'recent_sign_in_required');
      pairingsCleaned = await settlePairings(pairingCodes, userCode => ok('/v1/connections/decision', owner, { userCode, decision: 'denied' })) && pairingsCleaned;
      const deletion = await call('/v1/account', owner, undefined, 'DELETE');
      requireThat(deletion.status === 202 && deletion.value?.receipt, 'resumable_deletion_required');
      await until(async () => (await call('/v1/account-deletion', deletion.value.receipt)).value?.status === 'completed');
      requireThat((await call('/v1/devices', owner)).status === 401, 'deleted_identity_still_authorized');
      results.push({ scenario: 'deletion', status: 'passed' }); cleaned = receiverCleaned && pairingsCleaned;
    } catch { if (!results.some(r => r.scenario === 'deletion')) results.push({ scenario: 'deletion', status: 'failed' }); }
  }
  for (const name of scenarios) if (!results.some(r => r.scenario === name)) pending(name, 'prerequisite_not_completed');
  const evidence = report(results, { runId, projectId: cfg.projectId, budgetUsd: cfg.budgetUsd, ...context, startedAt, finishedAt: new Date().toISOString(), cleanupComplete: cleaned, interrupted: interrupts.signal.aborted });
  try { await writeReport(evidencePath, evidence); }
  catch { console.error('Evidence write failed; use a new private output path.'); process.exitCode = 1; }
  console.log(JSON.stringify({ complete: evidence.complete, passed: results.filter(r => r.status === 'passed').length, failed: results.filter(r => r.status === 'failed').length, pending: results.filter(r => r.status === 'pending').length, cleanupComplete: cleaned }));
  process.exitCode ||= interrupts.signal.aborted || results.some(r => r.status === 'failed') || !cleaned ? 1 : evidence.complete ? 0 : 2;
  interrupts.dispose();
}
