import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config, eventMetadata, httpsOrigin, ownerClaims, preflight, privateValue, report, scenarios, verifySignature, writeReport } from './core.mjs';

const base = { projectId: 'relay-staging-123', productionProjectId: 'relay-production-123', account: 'operator@example.com', region: 'us-central1', service: 'relay-service', serviceUrl: 'https://relay.run.app', ownerTokenFile: '/private/owner', disposableOwnerUid: 'disposable', fcmTokenFiles: ['/private/one', '/private/two'], budgetUsd: 10 };
test('destructive staging guard rejects production, implicit account, unsafe URLs and missing budget', () => {
  assert.equal(config(base).projectId, base.projectId);
  for (const patch of [{ projectId: base.productionProjectId }, { productionProjectId: undefined }, { projectId: 'live-relay-project' }, { account: '' }, { budgetUsd: 0 }, { budgetUsd: 101 }, { serviceUrl: 'http://relay.run.app' }, { serviceUrl: 'https://private@relay.run.app' }, { serviceUrl: 'https://relay.run.app/?credential=secret' }, { fcmTokenFiles: [] }, { callbackUrl: 'https://receiver.run.app' }]) assert.throws(() => config({ ...base, ...patch }));
  assert.throws(() => httpsOrigin('https://relay.run.app/path'));
});
test('owner guard rejects another identity/project/provider and expiring tokens before mutation', () => {
  const now = 1800000000000;
  const claims = { sub: 'disposable', aud: base.projectId, iss: `https://securetoken.google.com/${base.projectId}`, exp: now / 1000 + 300, firebase: { sign_in_provider: 'google.com' } };
  const token = value => `header.${Buffer.from(JSON.stringify(value)).toString('base64url')}.signature`;
  assert.equal(ownerClaims(token(claims), 'disposable', base.projectId, now).sub, 'disposable');
  for (const patch of [{ sub: 'production-owner' }, { aud: 'wrong-project' }, { iss: 'untrusted' }, { exp: now / 1000 + 29 }, { firebase: { sign_in_provider: 'custom' } }]) assert.throws(() => ownerClaims(token({ ...claims, ...patch }), 'disposable', base.projectId, now));
  assert.throws(() => ownerClaims('not-a-jwt', 'disposable', base.projectId, now));
});
test('cloud preflight verifies project labels, runtime project, billing and tagged replay origin', async () => {
  const cfg = config({ ...base, replayUrl: 'https://previous---relay.run.app' });
  const project = { projectId: cfg.projectId, lifecycleState: 'ACTIVE', labels: { environment: 'staging' } };
  const service = { metadata: { labels: { environment: 'staging' } }, status: { url: cfg.serviceUrl, traffic: [{ revisionName: 'current', percent: 100 }, { revisionName: 'previous', url: cfg.replayUrl }] }, spec: { template: { spec: { containers: [{ env: [{ name: 'GOOGLE_CLOUD_PROJECT', value: cfg.projectId }] }] } } } };
  const inspect = (p = project, s = service, b = { billingEnabled: true }) => async (_cfg, args) => structuredClone(args[0] === 'projects' ? p : args[0] === 'run' ? s : b);
  assert.deepEqual(await preflight(cfg, inspect()), { revision: 'current', projectId: cfg.projectId });
  await assert.rejects(preflight(cfg, inspect({ ...project, labels: {} })));
  await assert.rejects(preflight(cfg, inspect(project, { ...service, metadata: { labels: { environment: 'production' } } })));
  await assert.rejects(preflight(cfg, inspect(project, { ...service, status: { ...service.status, url: 'https://foreign.run.app' } })));
  await assert.rejects(preflight({ ...cfg, replayUrl: 'https://untrusted.run.app' }, inspect()));
  await assert.rejects(preflight(cfg, inspect(project, service, { billingEnabled: false })));
  const wrongRuntime = structuredClone(service); wrongRuntime.spec.template.spec.containers[0].env[0].value = 'production-project';
  await assert.rejects(preflight(cfg, inspect(project, wrongRuntime)));
  const emulatorRuntime = structuredClone(service); emulatorRuntime.spec.template.spec.containers[0].env.push({ name: 'FIRESTORE_EMULATOR_HOST', value: 'localhost:8080' });
  await assert.rejects(preflight(cfg, inspect(project, emulatorRuntime)));
});
test('callback verification binds exact body and timestamp and refuses stale or malformed signatures', () => {
  const secret = 'private-test-secret', now = 1800000000000, timestamp = String(now / 1000), body = '{"id":"event"}';
  const signature = `v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
  assert.equal(verifySignature(secret, timestamp, body, signature, now), true);
  assert.equal(verifySignature(secret, timestamp, body + ' ', signature, now), false);
  assert.equal(verifySignature(secret, timestamp, body, signature, now + 301000), false);
  assert.equal(verifySignature(secret, timestamp, body, 'v1=bad', now), false);
  assert.equal(verifySignature(secret, 'NaN', body, signature, now), false);
});
test('callback evidence refuses answers, owner IDs and arbitrary payload keys', () => {
  const event = { id: 'event', type: 'request.created', sequence: 1, requestId: 'request', at: 1800000000000 };
  assert.deepEqual(eventMetadata(event), { id: 'event', type: 'request.created', sequence: 1, requestId: 'request' });
  for (const patch of [{ answers: 'synthetic' }, { values: {} }, { ownerId: 'owner' }, { code: 'T123456' }, { sequence: 1.5 }, { type: 'arbitrary value' }]) assert.throws(() => eventMetadata({ ...event, ...patch }));
});
test('pending or missing live scenarios never count as complete acceptance', () => {
  const passed = scenarios.map(scenario => ({ scenario, status: 'passed' }));
  assert.equal(report(passed, {}).complete, true);
  assert.equal(report(passed.slice(1), {}).complete, false);
  assert.equal(report([{ scenario: scenarios[0], status: 'pending' }], {}).complete, false);
  assert.throws(() => report([...passed, passed[0]], {}));
  assert.throws(() => report([{ scenario: 'invented', status: 'passed' }], {}));
});
test('credentials require private permissions and evidence is exclusive and private', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-cloud-probe-'));
  try {
    const credentials = join(dir, 'credential'), evidence = join(dir, 'evidence.json');
    await writeFile(credentials, 'private', { mode: 0o600 });
    assert.equal(await privateValue(credentials), 'private');
    await chmod(credentials, 0o644); await assert.rejects(privateValue(credentials));
    await writeReport(evidence, { complete: false });
    await assert.rejects(writeReport(evidence, { complete: true }));
    assert.equal(JSON.parse(await readFile(evidence, 'utf8')).complete, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
