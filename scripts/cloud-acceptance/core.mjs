import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { isDeepStrictEqual, promisify } from 'node:util';

const execute = promisify(execFile);
export const scenarios = ['infrastructure', 'device-setup', 'pairing', 'sms-api', 'forms-wizard', 'events-replay', 'webhook-tls-retry', 'webhook-timeout', 'enqueue-recovery', 'worker-recovery', 'duplicate-delivery', 'provider-outage', 'storage-outage', 'deletion'];
export function requireThat(condition, code) { if (!condition) throw new Error(code); }
export function runInterrupts(host = process) {
  const controller = new AbortController();
  const stop = () => controller.abort(new Error('acceptance_interrupted'));
  host.on('SIGINT', stop); host.on('SIGTERM', stop);
  return { signal: controller.signal, dispose() { host.removeListener('SIGINT', stop); host.removeListener('SIGTERM', stop); } };
}
const deadline = (timeoutMs, signal) => signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
export function httpsOrigin(raw) {
  const url = new URL(raw);
  requireThat(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/', 'invalid_service_origin');
  return url.origin;
}
export function config(raw) {
  requireThat(raw && typeof raw.projectId === 'string' && /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(raw.projectId), 'invalid_project');
  requireThat(typeof raw.productionProjectId === 'string' && raw.projectId !== raw.productionProjectId && /^[a-z][a-z0-9-]+$/.test(raw.productionProjectId), 'production_project_required');
  requireThat(raw.projectId.includes('staging') || raw.projectId.includes('-stg'), 'staging_project_name_required');
  requireThat(typeof raw.securityLedgerBucket === 'string' && /^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(raw.securityLedgerBucket) && /staging|-stg/.test(raw.securityLedgerBucket), 'explicit_staging_ledger_required');
  requireThat(typeof raw.region === 'string' && typeof raw.service === 'string' && /^[a-z][a-z0-9-]+$/.test(raw.region) && /^[a-z][a-z0-9-]+$/.test(raw.service), 'invalid_resource_name');
  requireThat(typeof raw.account === 'string' && /^[^\s@]+@[^\s@]+$/.test(raw.account), 'explicit_cloud_account_required');
  requireThat(raw.disposableOwnerUid && raw.ownerTokenFile && Array.isArray(raw.fcmTokenFiles) && raw.fcmTokenFiles.length === 2, 'disposable_owner_and_two_phones_required');
  requireThat(raw.budgetUsd > 0 && raw.budgetUsd <= 100, 'explicit_test_budget_required');
  const serviceUrl = httpsOrigin(raw.serviceUrl);
  const replayUrl = raw.replayUrl ? httpsOrigin(raw.replayUrl) : undefined;
  const callbackUrl = raw.callbackUrl ? httpsOrigin(raw.callbackUrl) : undefined;
  if (callbackUrl) requireThat(typeof raw.callbackService === 'string' && /^[a-z][a-z0-9-]+$/.test(raw.callbackService), 'callback_service_required');
  return { ...raw, serviceUrl, replayUrl, callbackUrl };
}
export async function privateValue(file) {
  const metadata = await stat(file);
  requireThat(metadata.isFile() && (metadata.mode & 0o077) === 0, 'private_credential_file_required');
  const value = (await readFile(file, 'utf8')).trim();
  requireThat(value.length > 0, 'empty_credential'); return value;
}
export async function fixtureCredentials(cfg) {
  const owner = await privateValue(cfg.ownerTokenFile);
  ownerClaims(owner, cfg.disposableOwnerUid, cfg.projectId);
  const phones = await Promise.all(cfg.fcmTokenFiles.map(privateValue));
  requireThat(phones.every(token => token.length <= 4096 && !/\s/.test(token)), 'invalid_fcm_token');
  requireThat(new Set(phones).size === 2, 'distinct_fcm_tokens_required');
  const callbackAdmin = cfg.callbackUrl ? await privateValue(cfg.callbackAdminTokenFile) : undefined;
  if (cfg.callbackUrl) requireThat(/^[A-Za-z0-9_-]{43}$/.test(callbackAdmin), 'invalid_callback_admin_secret');
  return { owner, phones, callbackAdmin };
}
export function callbackOutcome(mode, attempt) {
  return { status: attempt === 1 && mode === 'fail-once' ? 503 : 204, timeout: attempt === 1 && mode === 'timeout-once' };
}
export async function clientDisconnectedBeforeResponse(response, deadlineMs = 11_000) {
  return new Promise(resolve => {
    const done = closed => { clearTimeout(timer); response.removeListener('close', close); resolve(closed); };
    const close = () => done(!response.writableFinished);
    const timer = setTimeout(() => done(false), deadlineMs);
    response.once('close', close);
    if (response.destroyed) close();
  });
}
export function callbackReceipts(mode, receipts) {
  const first = receipts.find(r => r.attempt === 1);
  const retry = receipts.find(r => r.attempt >= 2 && r.status === 204 && r.responseFinished === true);
  requireThat(first && retry && new Set(receipts.map(r => r.id)).size === 1, 'callback_retry_contract');
  if (mode === 'timeout-once') requireThat(first.status === 204 && first.clientClosedBeforeResponse === true, 'callback_timeout_not_observed');
  else requireThat(first.status === 503 && first.responseFinished === true, 'callback_rejection_not_observed');
}
export function readyIndexes(actual, required) {
  const fields = rows => rows.filter(field => field.fieldPath !== '__name__').map(({ fieldPath, order, arrayConfig }) => ({ fieldPath, ...(order ? { order } : {}), ...(arrayConfig ? { arrayConfig } : {}) }));
  requireThat(actual.every(index => index.state === 'READY') && required.every(wanted => actual.some(index =>
    index.name?.includes(`/collectionGroups/${wanted.collectionGroup}/indexes/`) && index.queryScope === wanted.queryScope && isDeepStrictEqual(fields(index.fields ?? []), fields(wanted.fields)))), 'indexes_not_ready');
}
export function activeTtl(fields, collection) {
  return fields.some(field => field.name?.endsWith(`/collectionGroups/${collection}/fields/purgeAt`) && field.ttlConfig?.state === 'ACTIVE');
}
export function replayProgress(text, expected, cursor) {
  requireThat(expected.length > 0 && !expected.some(event => event.id === cursor), 'replay_suffix_required');
  const frames = text.split(/\r?\n\r?\n/); frames.pop();
  const events = [];
  for (const frame of frames) {
    const lines = frame.split(/\r?\n/);
    const values = name => lines.filter(line => line.startsWith(`${name}:`)).map(line => line.slice(name.length + 1).replace(/^ /, ''));
    const ids = values('id'), types = values('event'), data = values('data');
    if (!ids.length && !types.length && !data.length) continue;
    requireThat(ids.length === 1 && types.length === 1 && data.length > 0, 'invalid_sse_event');
    let event; try { event = JSON.parse(data.join('\n')); } catch { throw new Error('invalid_sse_event'); }
    requireThat(event.id === ids[0] && event.type === types[0], 'invalid_sse_event');
    events.push(event);
  }
  requireThat(events.length <= expected.length && events.every((event, index) => isDeepStrictEqual(event, expected[index])), 'sse_replay_order_mismatch');
  return events.length === expected.length;
}
export async function proveCancellation(requestId, cancel, inspect, events) {
  const cancelled = await cancel();
  requireThat(cancelled.requestId === requestId && cancelled.status === 'cancelled', 'mcp_cancel_failed');
  requireThat((await inspect()).status === 'cancelled' && (await events()).some(event => event.requestId === requestId && event.type === 'request.cancelled'), 'mcp_cancellation_not_observed');
}
export async function settlePairings(userCodes, decide) {
  let complete = true;
  for (const userCode of userCodes) {
    try {
      const connection = await decide(userCode);
      requireThat(['approved', 'denied'].includes(connection.status), 'pairing_cleanup_not_owned');
    } catch { complete = false; }
  }
  return complete;
}
export async function stagingDocumentReader(cfg) {
  const { stdout } = await execute('gcloud', ['auth', 'print-access-token', `--account=${cfg.account}`, `--project=${cfg.projectId}`, '--quiet'], { timeout: 30_000, maxBuffer: 64 * 1024, signal: cfg.signal });
  const token = stdout.trim();
  return async (collection, id) => {
    requireThat(['results', 'deliveryOutbox'].includes(collection) && /^[a-f0-9]{64}$/.test(id), 'invalid_fixture_document');
    const endpoint = `https://firestore.googleapis.com/v1/projects/${cfg.projectId}/databases/(default)/documents/${collection}/${id}`;
    const response = await fetch(endpoint, { headers: { authorization: `Bearer ${token}` }, signal: deadline(20_000, cfg.signal), redirect: 'error' });
    if (response.status === 404) return null;
    requireThat(response.ok, 'fixture_read_failed'); return response.json();
  };
}
export function callbackJobId(eventId, hookId) { return createHash('sha256').update(`${eventId}:webhook:${hookId}`).digest('hex'); }
export function winnerAgreement(responses, devices) {
  const winner = responses[0]?.completedByDeviceId;
  requireThat(devices.includes(winner) && responses.every(r => r.status === 'submitted' && r.completedByDeviceId === winner), 'inconsistent_submission_winners');
  return winner;
}
export function expiryFixtureState(document, cfg, expired, now = Date.now()) {
  requireThat(document.fields?.ownerId?.stringValue === cfg.disposableOwnerUid, 'expiry_fixture_owner_mismatch');
  const expiresAt = Number(document.fields?.expiresAt?.integerValue);
  requireThat(Number.isSafeInteger(expiresAt) && (expired ? expiresAt <= now : expiresAt > now), 'expiry_fixture_deadline_mismatch');
  if (expired) requireThat(Date.parse(document.fields?.purgeAt?.timestampValue) > now, 'expired_result_not_retained');
}
export async function checkedScenario(results, scenario, fn) {
  const begin = Date.now();
  try { const facts = await fn(); results.push({ scenario, status: 'passed', durationMs: Date.now() - begin, ...facts }); }
  catch { results.push({ scenario, status: 'failed', durationMs: Date.now() - begin }); throw new Error('scenario_failed'); }
}
export async function preserveExpiryFixture(cfg, requestId) {
  requireThat(/^[a-f0-9]{64}$/.test(requestId), 'invalid_fixture_id');
  const { stdout } = await execute('gcloud', ['auth', 'print-access-token', `--account=${cfg.account}`, `--project=${cfg.projectId}`, '--quiet'], { timeout: 30_000, maxBuffer: 64 * 1024, signal: cfg.signal });
  const endpoint = `https://firestore.googleapis.com/v1/projects/${cfg.projectId}/databases/(default)/documents/results/${requestId}`;
  const token = stdout.trim();
  const read = async () => {
    const response = await fetch(endpoint, { headers: { authorization: `Bearer ${token}` }, signal: deadline(20_000, cfg.signal), redirect: 'error' });
    requireThat(response.ok, 'expiry_fixture_missing'); return response.json();
  };
  const before = await read();
  expiryFixtureState(before, cfg, false);
  const purgeAt = new Date(Date.now() + 20 * 60_000).toISOString();
  const response = await fetch(`${endpoint}?updateMask.fieldPaths=purgeAt`, { method: 'PATCH', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, signal: deadline(20_000, cfg.signal), redirect: 'error', body: JSON.stringify({ fields: { purgeAt: { timestampValue: purgeAt } } }) });
  requireThat(response.ok, 'expiry_fixture_ttl_extension_failed');
  return async () => {
    const result = await read();
    expiryFixtureState(result, cfg, true);
  };
}
export function ownerClaims(token, uid, project, now = Date.now()) {
  let claims;
  try { claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')); } catch { throw new Error('invalid_owner_token'); }
  // This is a destructive-test guard only. The deployed service must verify JWT signatures.
  requireThat(claims.sub === uid && claims.aud === project && claims.iss === `https://securetoken.google.com/${project}` && claims.firebase?.sign_in_provider === 'google.com', 'wrong_disposable_owner');
  requireThat(claims.exp * 1000 > now + 30_000, 'owner_token_expiring');
  return claims;
}
export async function cloud(cfg, args) {
  const { stdout } = await execute('gcloud', [...args, `--account=${cfg.account}`, `--project=${cfg.projectId}`, '--format=json', '--quiet'], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024, signal: cfg.signal });
  return JSON.parse(stdout);
}
export async function preflight(cfg, inspect = cloud, recordContext = () => {}) {
  requireThat(!process.env.FIRESTORE_EMULATOR_HOST && !process.env.FIREBASE_AUTH_EMULATOR_HOST, 'emulators_forbidden');
  const project = await inspect(cfg, ['projects', 'describe', cfg.projectId]);
  requireThat(project.projectId === cfg.projectId && project.lifecycleState === 'ACTIVE' && project.labels?.environment === 'staging', 'staging_project_label_required');
  const service = await inspect(cfg, ['run', 'services', 'describe', cfg.service, `--region=${cfg.region}`]);
  requireThat(service.metadata?.labels?.environment === 'staging', 'staging_service_label_required');
  requireThat(service.status?.url === cfg.serviceUrl, 'service_origin_mismatch');
  const active = service.status.traffic?.find(t => t.percent === 100);
  requireThat(active?.revisionName && service.status.traffic.filter(t => t.percent > 0).length === 1, 'single_active_revision_required');
  const context = { revision: active.revisionName, projectId: cfg.projectId };
  const checkRevision = async (name, ledger = true) => {
    const revision = await inspect(cfg, ['run', 'revisions', 'describe', name, `--region=${cfg.region}`]);
    requireThat(revision.metadata?.name === name, 'revision_mismatch');
    const env = revision.spec?.containers?.[0]?.env ?? [];
    requireThat(env.find(v => v.name === 'GOOGLE_CLOUD_PROJECT')?.value === cfg.projectId, 'runtime_project_mismatch');
    if (ledger) requireThat(env.find(v => v.name === 'SECURITY_LEDGER_BUCKET')?.value === cfg.securityLedgerBucket, 'staging_ledger_mismatch');
    requireThat(!env.some(v => /EMULATOR_HOST/.test(v.name)), 'deployed_emulators_forbidden');
    if (!ledger) return;
    if (name === active.revisionName) recordContext(context);
    const startup = revision.spec?.containers?.[0]?.startupProbe;
    requireThat(startup?.httpGet?.path === '/startup' && startup.httpGet.port === 8080 && !startup.tcpSocket && !startup.grpc, 'runtime_startup_probe_required');
    requireThat(env.find(v => v.name === 'SERVICE_URL')?.value === cfg.serviceUrl, 'runtime_service_origin_mismatch');
    const schedulerEmail = env.find(v => v.name === 'SCHEDULER_EMAIL')?.value;
    requireThat(typeof schedulerEmail === 'string' && /^[a-zA-Z0-9_-]+@/.test(schedulerEmail) && schedulerEmail.endsWith(`@${cfg.projectId}.iam.gserviceaccount.com`), 'staging_scheduler_identity_required');
    const queue = env.find(v => v.name === 'DELIVERY_QUEUE')?.value;
    const prefix = `projects/${cfg.projectId}/locations/${cfg.region}/queues/`;
    requireThat(typeof queue === 'string' && queue.startsWith(prefix) && /^[A-Za-z0-9_-]+$/.test(queue.slice(prefix.length)), 'staging_delivery_queue_required');
    return { queue, queueId: queue.slice(prefix.length), schedulerEmail };
  };
  const delivery = await checkRevision(active.revisionName);
  if (cfg.replayUrl) {
    const replay = service.status.traffic.find(t => t.url === cfg.replayUrl && t.revisionName !== active.revisionName);
    requireThat(replay, 'distinct_tagged_revision_required');
    requireThat(isDeepStrictEqual(await checkRevision(replay.revisionName), delivery), 'replay_delivery_configuration_mismatch');
  }
  if (cfg.callbackUrl) {
    const receiver = await inspect(cfg, ['run', 'services', 'describe', cfg.callbackService, `--region=${cfg.region}`]);
    requireThat(receiver.metadata?.labels?.environment === 'staging' && receiver.status?.url === cfg.callbackUrl, 'callback_staging_origin_mismatch');
    const receiverTraffic = receiver.status?.traffic?.filter(t => t.percent > 0) ?? [];
    requireThat(receiverTraffic.length === 1 && receiverTraffic[0].percent === 100 && receiverTraffic[0].revisionName, 'single_callback_revision_required');
    await checkRevision(receiverTraffic[0].revisionName, false);
  }
  const billing = await inspect(cfg, ['billing', 'projects', 'describe', cfg.projectId]);
  requireThat(billing.billingEnabled === true, 'staging_billing_not_enabled');
  const queue = await inspect(cfg, ['tasks', 'queues', 'describe', delivery.queueId, `--location=${cfg.region}`]);
  const scheduler = await inspect(cfg, ['scheduler', 'jobs', 'describe', 'sms-relay-maintenance', `--location=${cfg.region}`]);
  requireThat(queue.name === delivery.queue, 'delivery_queue_mismatch');
  requireThat(queue.state === 'RUNNING' && scheduler.state === 'ENABLED', 'delivery_resources_disabled');
  const target = scheduler.httpTarget;
  requireThat(target?.httpMethod === 'POST' && target.uri === `${cfg.serviceUrl}/internal/maintenance` && target.oidcToken?.audience === cfg.serviceUrl && target.oidcToken.serviceAccountEmail === delivery.schedulerEmail, 'scheduler_target_mismatch');
  return context;
}
export function verifySignature(secret, timestamp, rawBody, signature, now = Date.now()) {
  if (!/^\d+$/.test(timestamp ?? '') || Math.abs(now / 1000 - Number(timestamp)) > 300 || !/^v1=[a-f0-9]{64}$/.test(signature ?? '')) return false;
  const expected = createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(signature.slice(3), 'hex'));
}
const eventKeys = new Set(['id', 'type', 'requestId', 'sequence', 'requestSequence', 'at', 'deviceId', 'fieldId', 'observedAt']);
export function eventMetadata(event) {
  requireThat(event && !Array.isArray(event) && Object.keys(event).every(key => eventKeys.has(key)), 'unexpected_callback_payload');
  requireThat(typeof event.id === 'string' && event.id.length <= 200 && /^[a-z][a-z.]+$/.test(event.type) && Number.isSafeInteger(event.sequence) && typeof event.requestId === 'string', 'invalid_callback_event');
  return { id: event.id, type: event.type, sequence: event.sequence, requestId: event.requestId };
}
export async function request(origin, path, token, body, method = body === undefined ? 'GET' : 'POST', signal) {
  const response = await fetch(`${origin}${path}`, { method, redirect: 'error', signal: deadline(20_000, signal), headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  let value; try { value = await response.json(); } catch { value = null; }
  return { status: response.status, value };
}
export function report(results, context) {
  requireThat(results.every(r => scenarios.includes(r.scenario) && ['passed', 'failed', 'pending'].includes(r.status)), 'invalid_result');
  requireThat(new Set(results.map(r => r.scenario)).size === results.length, 'duplicate_result');
  const complete = !context.interrupted && scenarios.every(name => results.some(r => r.scenario === name && r.status === 'passed'));
  return { schemaVersion: 1, ...context, complete, results };
}
export async function writeReport(path, result) { await writeFile(path, JSON.stringify(result, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); }
