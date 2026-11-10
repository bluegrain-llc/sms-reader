#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { cloud, config, ownerClaims, preflight, privateValue, report, request, requireThat, scenarios, writeReport } from './core.mjs';

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
  console.log(JSON.stringify({ projectId: cfg.projectId, service: cfg.service, scenarios, destructive: 'Creates fixtures and deletes the explicitly configured disposable owner account.', productionAllowed: false }));
  process.exit(0);
}
const results = [], startedAt = new Date().toISOString(), runId = randomUUID();
let context = {}, caller, otherCaller, owner, hookIds = [], collectorIds = [], createdDevices = [], apiStarted = false;
const call = (path, token, body, method, origin = cfg.serviceUrl) => request(origin, path, token, body, method);
const ok = async (...params) => { const r = await call(...params); requireThat(r.status >= 200 && r.status < 300, 'unexpected_api_status'); return r.value; };
const ownerToken = async () => { const value = await privateValue(cfg.ownerTokenFile); ownerClaims(value, cfg.disposableOwnerUid, cfg.projectId); return value; };
const check = async (scenario, fn) => {
  const begin = Date.now();
  try { const facts = await fn(); results.push({ scenario, status: 'passed', durationMs: Date.now() - begin, ...facts }); }
  catch { results.push({ scenario, status: 'failed', durationMs: Date.now() - begin }); throw new Error('scenario_failed'); }
};
const pending = (scenario, reason) => results.push({ scenario, status: 'pending', reason });
async function until(fn, timeoutMs = 150_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await delay(2_000); }
  throw new Error('acceptance_deadline');
}
async function callbackProbe(mode) {
  requireThat(cfg.callbackUrl && cfg.callbackAdminTokenFile, 'callback_receiver_required');
  const admin = await privateValue(cfg.callbackAdminTokenFile), id = randomUUID(); collectorIds.push(id);
  const hook = await ok('/v2/webhooks', caller, { url: `${cfg.callbackUrl}/hooks/${id}`, events: ['request.created'] }); hookIds.push(hook.id);
  const configured = await request(cfg.callbackUrl, `/admin/${id}`, admin, { secret: hook.secret, mode });
  requireThat(configured.status === 201, 'receiver_configuration_failed');
  const form = await ok('/v2/requests', caller, { title: 'Cloud callback probe', body: 'Synthetic staging fixture.', idempotencyKey: randomUUID(), fields: [], actions: [{ id: 'ok', label: 'OK', type: 'acknowledge' }] });
  try {
    const receipts = await until(async () => {
      const response = await request(cfg.callbackUrl, `/admin/${id}`, admin);
      requireThat(response.status === 200, 'receiver_unavailable');
      const values = response.value.receipts.filter(r => r.requestId === form.requestId);
      return values.some(r => r.attempt >= 2 && r.status === 204) ? values : null;
    });
    requireThat(receipts[0]?.status === 503 && new Set(receipts.map(r => r.id)).size === 1, 'callback_retry_contract');
    return { attempts: receipts.length, verifiedPublicTls: true, verifiedSignedEvent: true };
  } finally { await ok(`/v2/requests/${form.requestId}/cancel`, caller, {}); }
}

try {
  // Complete the cloud guard before reading credentials or sending any mutating request.
  context = await preflight(cfg);
  owner = await ownerToken();
  requireThat((await ok('/v1/devices', owner)).length === 0 && (await ok('/v1/callers', owner)).length === 0, 'fresh_disposable_owner_required');
  await check('infrastructure', async () => {
    const health = await call('/health'); requireThat(health.status === 200 && health.value?.ok === true, 'health_failed');
    for (const path of ['/internal/delivery', '/internal/maintenance']) {
      requireThat((await call(path, undefined, {})).status === 401 && (await call(path, owner, {})).status === 401, 'worker_identity_boundary');
    }
    const indexes = await cloud(cfg, ['firestore', 'indexes', 'composite', 'list']);
    requireThat(indexes.length > 0 && indexes.every(i => i.state === 'READY'), 'indexes_not_ready');
    const fields = await cloud(cfg, ['firestore', 'fields', 'ttls', 'list']);
    for (const collection of ['results', 'requests', 'audit', 'connections', 'connectionCodes', 'connectionRates', 'formResults', 'formRequests', 'requestEvents', 'deliveryOutbox']) {
      requireThat(fields.some(f => f.name?.includes(`/collectionGroups/${collection}/`) && f.ttlConfig?.state === 'ACTIVE'), 'ttl_not_active');
    }
    const queue = await cloud(cfg, ['tasks', 'queues', 'describe', 'relay-delivery', `--location=${cfg.region}`]);
    const scheduler = await cloud(cfg, ['scheduler', 'jobs', 'describe', 'sms-relay-maintenance', `--location=${cfg.region}`]);
    requireThat(queue.state === 'RUNNING' && scheduler.state === 'ENABLED', 'delivery_resources_disabled');
    requireThat(scheduler.httpTarget?.oidcToken?.audience === cfg.serviceUrl && scheduler.httpTarget?.uri === `${cfg.serviceUrl}/internal/maintenance`, 'scheduler_target_mismatch');
    return { readyIndexes: indexes.length, activeTtlPolicies: fields.filter(f => f.ttlConfig?.state === 'ACTIVE').length };
  });
  apiStarted = true;
  for (const tokenFile of cfg.fcmTokenFiles) {
    const id = randomUUID(), fcmToken = await privateValue(tokenFile);
    await ok(`/v1/devices/${id}`, owner, { name: 'Cloud acceptance fixture', fcmToken, wizardVersion: 1 }, 'PUT'); createdDevices.push(id);
  }
  await check('pairing', async () => {
    const connection = await ok('/v1/connections', undefined, { callerName: 'Staging acceptance', purpose: 'Disposable cloud verification fixture.', expiresInDays: 1 });
    caller = connection.connectionToken;
    requireThat((await call('/mcp', caller, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status === 401, 'pending_credential_authorized');
    await ok('/v1/connections/decision', owner, { userCode: connection.userCode, decision: 'approved' });
    const state = await ok('/v1/connections/poll', caller, {}); requireThat(state.status === 'approved', 'pairing_not_approved');
    const other = await ok('/v1/connections', undefined, { callerName: 'Staging isolation fixture', purpose: 'Independent disposable caller.', expiresInDays: 1 });
    await ok('/v1/connections/decision', owner, { userCode: other.userCode, decision: 'approved' }); otherCaller = other.connectionToken;
    const grant = (await ok('/v1/callers', owner)).find(g => g.callerName === 'Staging acceptance'); requireThat(grant, 'grant_missing');
    await ok(`/v2/grants/${grant.grantId}/forms`, owner, { approved: true }, 'PUT');
    const client = new Client({ name: 'cloud-acceptance', version: '1' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`${cfg.serviceUrl}/mcp`), { requestInit: { headers: { authorization: `Bearer ${caller}` } } }));
      const names = new Set((await client.listTools()).tools.map(t => t.name));
      for (const name of ['request_sms_code', 'get_sms_code_request', 'cancel_sms_code_request', 'create_request', 'inspect_request', 'cancel_request', 'get_request_result', 'poll_request_events']) requireThat(names.has(name), 'mcp_tool_missing');
      const created = await client.callTool({ name: 'create_request', arguments: { title: 'MCP fixture', body: 'Synthetic.', idempotencyKey: randomUUID(), fields: [], actions: [{ id: 'ok', label: 'OK', type: 'acknowledge' }] } });
      requireThat(!created.isError, 'mcp_create_failed'); const value = JSON.parse(created.content[0].text);
      requireThat(!(await client.callTool({ name: 'cancel_request', arguments: { requestId: value.requestId } })).isError, 'mcp_cancel_failed');
    } finally { await client.close(); }
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
    const other = await ok(`/v1/devices/${createdDevices[1]}/requests/${r.requestId}`, owner); requireThat(!('code' in other), 'code_leaked_to_phone');
    await delay(121_000);
    requireThat(!(await ok(`/v1/requests/${r.requestId}`, caller)).code, 'result_expiry_failed');
    return { source: 'synthetic_manual_api', physicalConsentProven: false, expiryWaitMs: 121000 };
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
    await Promise.all(createdDevices.map((id, i) => ok(`/v2/devices/${id}/requests/${form.requestId}/submissions`, owner, { submissionId: randomUUID(), action: 'submit', values: { enabled: true, note: `synthetic-${i}` } })));
    const result = await ok(`/v2/requests/${form.requestId}/result`, caller); requireThat(['synthetic-0', 'synthetic-1'].includes(result.result?.values?.note), 'wizard_winner_invalid');
    return { competingPhones: 2, acceptedResults: 1, fcmAcceptedDevices: 2, phoneDisplayProven: false };
  });
  await check('events-replay', async () => {
    requireThat(cfg.replayUrl, 'second_revision_required');
    const first = await ok('/v2/events', caller);
    requireThat(first.events.length > 0, 'events_missing');
    const cursor = first.events[0].id;
    const expected = await ok(`/v2/events?cursor=${encodeURIComponent(cursor)}`, caller);
    const response = await fetch(`${cfg.replayUrl}/v2/events/stream`, { headers: { authorization: `Bearer ${caller}`, 'Last-Event-ID': cursor }, signal: AbortSignal.timeout(15_000), redirect: 'error' });
    requireThat(response.ok && response.headers.get('content-type')?.startsWith('text/event-stream'), 'sse_unavailable');
    const reader = response.body.getReader(); let text = '';
    try {
      while (expected.events.some(e => !text.includes(`id: ${e.id}\n`))) { const next = await reader.read(); requireThat(!next.done, 'sse_replay_incomplete'); text += new TextDecoder().decode(next.value); requireThat(text.length < 262144, 'sse_too_large'); }
    } finally { await reader.cancel(); }
    return { replayedEvents: expected.events.length, distinctRevisionOrigin: cfg.replayUrl !== cfg.serviceUrl };
  });
  if (cfg.callbackUrl) {
    await check('webhook-tls-retry', () => callbackProbe('fail-once'));
    await check('webhook-timeout', () => callbackProbe('timeout-once'));
  } else { pending('webhook-tls-retry', 'public_receiver_required'); pending('webhook-timeout', 'public_receiver_required'); }
  for (const name of ['enqueue-recovery', 'worker-recovery', 'duplicate-delivery', 'provider-outage', 'storage-outage']) pending(name, 'operator_fault_drill_required');
} catch { /* Never print arbitrary provider errors, responses, tokens or submitted values. */ }
finally {
  if (!results.some(r => r.scenario === 'infrastructure')) results.push({ scenario: 'infrastructure', status: 'failed' });
  let cleaned = !apiStarted;
  let receiverCleaned = true;
  if (apiStarted) {
    for (const id of hookIds) { try { await ok(`/v2/webhooks/${id}`, caller, undefined, 'DELETE'); } catch { /* owner deletion retries cleanup */ } }
    if (cfg.callbackUrl && cfg.callbackAdminTokenFile) {
      for (const id of collectorIds) { try { const r = await request(cfg.callbackUrl, `/admin/${id}`, await privateValue(cfg.callbackAdminTokenFile), undefined, 'DELETE'); requireThat(r.status === 200, 'receiver_cleanup_failed'); } catch { receiverCleaned = false; } }
    }
    try {
      owner = await ownerToken(); const claims = ownerClaims(owner, cfg.disposableOwnerUid, cfg.projectId);
      requireThat(Date.now() - claims.auth_time * 1000 < 300_000, 'recent_sign_in_required');
      const deletion = await call('/v1/account', owner, undefined, 'DELETE');
      requireThat(deletion.status === 202 && deletion.value?.receipt, 'resumable_deletion_required');
      await until(async () => (await call('/v1/account-deletion', deletion.value.receipt)).value?.status === 'completed');
      requireThat((await call('/v1/devices', owner)).status === 401, 'deleted_identity_still_authorized');
      results.push({ scenario: 'deletion', status: 'passed' }); cleaned = receiverCleaned;
    } catch { if (!results.some(r => r.scenario === 'deletion')) results.push({ scenario: 'deletion', status: 'failed' }); }
  }
  for (const name of scenarios) if (!results.some(r => r.scenario === name)) pending(name, 'prerequisite_not_completed');
  const evidence = report(results, { runId, projectId: cfg.projectId, ...context, startedAt, finishedAt: new Date().toISOString(), cleanupComplete: cleaned });
  try { await writeReport(evidencePath, evidence); }
  catch { console.error('Evidence write failed; use a new private output path.'); process.exitCode = 1; }
  console.log(JSON.stringify({ complete: evidence.complete, passed: results.filter(r => r.status === 'passed').length, failed: results.filter(r => r.status === 'failed').length, pending: results.filter(r => r.status === 'pending').length, cleanupComplete: cleaned }));
  process.exitCode ||= results.some(r => r.status === 'failed') || !cleaned ? 1 : evidence.complete ? 0 : 2;
}
