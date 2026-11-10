import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export const scenarios = ['infrastructure', 'pairing', 'sms-api', 'forms-wizard', 'events-replay', 'webhook-tls-retry', 'webhook-timeout', 'enqueue-recovery', 'worker-recovery', 'duplicate-delivery', 'provider-outage', 'storage-outage', 'deletion'];
export function requireThat(condition, code) { if (!condition) throw new Error(code); }
export function httpsOrigin(raw) {
  const url = new URL(raw);
  requireThat(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/', 'invalid_service_origin');
  return url.origin;
}
export function config(raw) {
  requireThat(raw && typeof raw.projectId === 'string' && /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(raw.projectId), 'invalid_project');
  requireThat(typeof raw.productionProjectId === 'string' && raw.projectId !== raw.productionProjectId && /^[a-z][a-z0-9-]+$/.test(raw.productionProjectId), 'production_project_required');
  requireThat(raw.projectId.includes('staging') || raw.projectId.includes('-stg'), 'staging_project_name_required');
  requireThat(typeof raw.region === 'string' && typeof raw.service === 'string' && /^[a-z][a-z0-9-]+$/.test(raw.region) && /^[a-z][a-z0-9-]+$/.test(raw.service), 'invalid_resource_name');
  requireThat(typeof raw.account === 'string' && /^[^\s@]+@[^\s@]+$/.test(raw.account), 'explicit_cloud_account_required');
  requireThat(raw.disposableOwnerUid && raw.ownerTokenFile && raw.fcmTokenFiles?.length === 2, 'disposable_owner_and_two_phones_required');
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
export function ownerClaims(token, uid, project, now = Date.now()) {
  let claims;
  try { claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')); } catch { throw new Error('invalid_owner_token'); }
  // This is a destructive-test guard only. The deployed service must verify JWT signatures.
  requireThat(claims.sub === uid && claims.aud === project && claims.iss === `https://securetoken.google.com/${project}` && claims.firebase?.sign_in_provider === 'google.com', 'wrong_disposable_owner');
  requireThat(claims.exp * 1000 > now + 30_000, 'owner_token_expiring');
  return claims;
}
export async function cloud(cfg, args) {
  const { stdout } = await execute('gcloud', [...args, `--account=${cfg.account}`, `--project=${cfg.projectId}`, '--format=json', '--quiet'], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
  return JSON.parse(stdout);
}
export async function preflight(cfg, inspect = cloud) {
  requireThat(!process.env.FIRESTORE_EMULATOR_HOST && !process.env.FIREBASE_AUTH_EMULATOR_HOST, 'emulators_forbidden');
  const project = await inspect(cfg, ['projects', 'describe', cfg.projectId]);
  requireThat(project.projectId === cfg.projectId && project.lifecycleState === 'ACTIVE' && project.labels?.environment === 'staging', 'staging_project_label_required');
  const service = await inspect(cfg, ['run', 'services', 'describe', cfg.service, `--region=${cfg.region}`]);
  requireThat(service.metadata?.labels?.environment === 'staging', 'staging_service_label_required');
  requireThat(service.status?.url === cfg.serviceUrl, 'service_origin_mismatch');
  const env = service.spec?.template?.spec?.containers?.[0]?.env ?? [];
  requireThat(env.find(v => v.name === 'GOOGLE_CLOUD_PROJECT')?.value === cfg.projectId, 'runtime_project_mismatch');
  requireThat(!env.some(v => /EMULATOR_HOST/.test(v.name)), 'deployed_emulators_forbidden');
  const active = service.status.traffic?.find(t => t.percent === 100);
  requireThat(active?.revisionName, 'single_active_revision_required');
  if (cfg.replayUrl) requireThat(service.status.traffic.some(t => t.url === cfg.replayUrl && t.revisionName !== active.revisionName), 'distinct_tagged_revision_required');
  if (cfg.callbackUrl) {
    const receiver = await inspect(cfg, ['run', 'services', 'describe', cfg.callbackService, `--region=${cfg.region}`]);
    requireThat(receiver.metadata?.labels?.environment === 'staging' && receiver.status?.url === cfg.callbackUrl, 'callback_staging_origin_mismatch');
    requireThat(receiver.spec?.template?.spec?.containers?.[0]?.env?.find(v => v.name === 'GOOGLE_CLOUD_PROJECT')?.value === cfg.projectId, 'callback_project_mismatch');
  }
  const billing = await inspect(cfg, ['billing', 'projects', 'describe', cfg.projectId]);
  requireThat(billing.billingEnabled === true, 'staging_billing_not_enabled');
  return { revision: active.revisionName, projectId: cfg.projectId };
}
export function verifySignature(secret, timestamp, rawBody, signature, now = Date.now()) {
  if (!/^\d+$/.test(timestamp ?? '') || Math.abs(now / 1000 - Number(timestamp)) > 300 || !/^v1=[a-f0-9]{64}$/.test(signature ?? '')) return false;
  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest();
  return timingSafeEqual(expected, Buffer.from(signature.slice(3), 'hex'));
}
const eventKeys = new Set(['id', 'type', 'requestId', 'sequence', 'requestSequence', 'at', 'deviceId', 'fieldId', 'observedAt']);
export function eventMetadata(event) {
  requireThat(event && !Array.isArray(event) && Object.keys(event).every(key => eventKeys.has(key)), 'unexpected_callback_payload');
  requireThat(typeof event.id === 'string' && event.id.length <= 200 && /^[a-z][a-z.]+$/.test(event.type) && Number.isSafeInteger(event.sequence) && typeof event.requestId === 'string', 'invalid_callback_event');
  return { id: event.id, type: event.type, sequence: event.sequence, requestId: event.requestId };
}
export async function request(origin, path, token, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(`${origin}${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(20_000), headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  let value; try { value = await response.json(); } catch { value = null; }
  return { status: response.status, value };
}
export function report(results, context) {
  requireThat(results.every(r => scenarios.includes(r.scenario) && ['passed', 'failed', 'pending'].includes(r.status)), 'invalid_result');
  requireThat(new Set(results.map(r => r.scenario)).size === results.length, 'duplicate_result');
  const complete = scenarios.every(name => results.some(r => r.scenario === name && r.status === 'passed'));
  return { schemaVersion: 1, ...context, complete, results };
}
export async function writeReport(path, result) { await writeFile(path, JSON.stringify(result, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); }
