import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { activeTtl, callbackOutcome, callbackReceipts, checkedScenario, clientDisconnectedBeforeResponse, config, eventMetadata, expiryFixtureState, fixtureCredentials, httpsOrigin, ownerClaims, preflight, privateValue, proveCancellation, readyIndexes, replayProgress, report, scenarios, settlePairings, verifySignature, winnerAgreement, writeReport } from './core.mjs';

const base = { projectId: 'relay-staging-123', productionProjectId: 'relay-production-123', securityLedgerBucket: 'relay-staging-ledger', account: 'operator@example.com', region: 'us-central1', service: 'relay-service', serviceUrl: 'https://relay.run.app', ownerTokenFile: '/private/owner', disposableOwnerUid: 'disposable', fcmTokenFiles: ['/private/one', '/private/two'], budgetUsd: 10 };
test('destructive staging guard rejects production, implicit account, unsafe URLs and missing budget', () => {
  assert.equal(config(base).projectId, base.projectId);
  for (const patch of [{ projectId: base.productionProjectId }, { productionProjectId: undefined }, { projectId: 'live-relay-project' }, { securityLedgerBucket: undefined }, { securityLedgerBucket: 'prod-ledger' }, { account: '' }, { budgetUsd: 0 }, { budgetUsd: 101 }, { serviceUrl: 'http://relay.run.app' }, { serviceUrl: 'https://private@relay.run.app' }, { serviceUrl: 'https://relay.run.app/?credential=secret' }, { fcmTokenFiles: [] }, { callbackUrl: 'https://receiver.run.app' }]) assert.throws(() => config({ ...base, ...patch }));
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
test('cloud preflight verifies actual active and tagged revisions rather than a candidate template', async () => {
  const cfg = config({ ...base, replayUrl: 'https://previous---relay.run.app' });
  const project = { projectId: cfg.projectId, lifecycleState: 'ACTIVE', labels: { environment: 'staging' } };
  const queue = `projects/${cfg.projectId}/locations/${cfg.region}/queues/relay-delivery`, schedulerEmail = `scheduler@${cfg.projectId}.iam.gserviceaccount.com`;
  const env = [{ name: 'GOOGLE_CLOUD_PROJECT', value: cfg.projectId }, { name: 'SECURITY_LEDGER_BUCKET', value: cfg.securityLedgerBucket }, { name: 'SERVICE_URL', value: cfg.serviceUrl }, { name: 'DELIVERY_QUEUE', value: queue }, { name: 'SCHEDULER_EMAIL', value: schedulerEmail }];
  const service = { metadata: { labels: { environment: 'staging' } }, status: { url: cfg.serviceUrl, traffic: [{ revisionName: 'current', percent: 100 }, { revisionName: 'previous', url: cfg.replayUrl }] }, spec: { template: { spec: { containers: [{ env }] } } } };
  const revisions = Object.fromEntries(['current', 'previous'].map(name => [name, { metadata: { name }, spec: { containers: [{ env: structuredClone(env) }] } }]));
  const inspect = (p = project, s = service, r = revisions, billing = true) => async (_cfg, args) => structuredClone(args[0] === 'projects' ? p : args[0] === 'run' ? args[1] === 'revisions' ? r[args[3]] : s : args[0] === 'tasks' ? { name: queue, state: 'RUNNING' } : args[0] === 'scheduler' ? { state: 'ENABLED', httpTarget: { httpMethod: 'POST', uri: `${cfg.serviceUrl}/internal/maintenance`, oidcToken: { audience: cfg.serviceUrl, serviceAccountEmail: schedulerEmail } } } : { billingEnabled: billing });
  assert.deepEqual(await preflight(cfg, inspect()), { revision: 'current', projectId: cfg.projectId });
  await assert.rejects(preflight(cfg, inspect({ ...project, labels: {} })));
  await assert.rejects(preflight(cfg, inspect(project, { ...service, metadata: { labels: { environment: 'production' } } })));
  await assert.rejects(preflight(cfg, inspect(project, { ...service, status: { ...service.status, url: 'https://foreign.run.app' } })));
  await assert.rejects(preflight({ ...cfg, replayUrl: 'https://untrusted.run.app' }, inspect()));
  await assert.rejects(preflight(cfg, inspect(project, service, revisions, false)));
  for (const name of ['current', 'previous']) {
    const wrongRuntime = structuredClone(revisions); wrongRuntime[name].spec.containers[0].env[0].value = 'production-project';
    await assert.rejects(preflight(cfg, inspect(project, service, wrongRuntime)), /runtime_project_mismatch/);
  }
  const wrongLedger = structuredClone(revisions); wrongLedger.current.spec.containers[0].env[1].value = 'prod-ledger';
  await assert.rejects(preflight(cfg, inspect(project, service, wrongLedger)), /staging_ledger_mismatch/);
  const emulator = structuredClone(revisions); emulator.current.spec.containers[0].env.push({ name: 'FIRESTORE_EMULATOR_HOST', value: 'localhost:8080' });
  await assert.rejects(preflight(cfg, inspect(project, service, emulator)));
});
test('cloud preflight binds delivery readiness to each serving revision and Scheduler signer', async () => {
  const cfg = config({ ...base, replayUrl: 'https://previous---relay.run.app' });
  const queueName = `projects/${cfg.projectId}/locations/${cfg.region}/queues/custom-delivery`;
  const schedulerEmail = `scheduler@${cfg.projectId}.iam.gserviceaccount.com`;
  const env = [{ name: 'GOOGLE_CLOUD_PROJECT', value: cfg.projectId }, { name: 'SECURITY_LEDGER_BUCKET', value: cfg.securityLedgerBucket }, { name: 'SERVICE_URL', value: cfg.serviceUrl }, { name: 'DELIVERY_QUEUE', value: queueName }, { name: 'SCHEDULER_EMAIL', value: schedulerEmail }];
  const project = { projectId: cfg.projectId, lifecycleState: 'ACTIVE', labels: { environment: 'staging' } };
  const service = { metadata: { labels: { environment: 'staging' } }, status: { url: cfg.serviceUrl, traffic: [{ revisionName: 'current', percent: 100 }, { revisionName: 'previous', url: cfg.replayUrl }] } };
  const revisions = Object.fromEntries(['current', 'previous'].map(name => [name, { metadata: { name }, spec: { containers: [{ env: structuredClone(env) }] } }]));
  const queue = { name: queueName, state: 'RUNNING' };
  const scheduler = { state: 'ENABLED', httpTarget: { httpMethod: 'POST', uri: `${cfg.serviceUrl}/internal/maintenance`, oidcToken: { audience: cfg.serviceUrl, serviceAccountEmail: schedulerEmail } } };
  const inspect = (r = revisions, q = queue, s = scheduler, calls = []) => async (_cfg, args) => {
    calls.push(args);
    return structuredClone(args[0] === 'projects' ? project : args[0] === 'run' ? args[1] === 'revisions' ? r[args[3]] : service : args[0] === 'tasks' ? q : args[0] === 'scheduler' ? s : { billingEnabled: true });
  };
  const calls = [];
  await preflight(cfg, inspect(revisions, queue, scheduler, calls));
  assert.ok(calls.some(args => args[0] === 'tasks' && args[3] === 'custom-delivery'), 'inspect the active runtime queue rather than relay-delivery');
  await assert.rejects(preflight(cfg, inspect(revisions, { ...queue, state: 'PAUSED' })), /delivery_resources_disabled/);
  await assert.rejects(preflight(cfg, inspect(revisions, { ...queue, name: queueName.replace('custom-delivery', 'relay-delivery') })), /delivery_queue_mismatch/);
  for (const patch of [{ state: 'PAUSED' }, { httpTarget: { ...scheduler.httpTarget, httpMethod: 'GET' } }, { httpTarget: { ...scheduler.httpTarget, oidcToken: { ...scheduler.httpTarget.oidcToken, serviceAccountEmail: `other@${cfg.projectId}.iam.gserviceaccount.com` } } }]) {
    await assert.rejects(preflight(cfg, inspect(revisions, queue, { ...scheduler, ...patch })));
  }
  for (const name of ['current', 'previous']) {
    for (const [key, value] of [['SERVICE_URL', 'https://wrong.run.app'], ['DELIVERY_QUEUE', `projects/production-project/locations/${cfg.region}/queues/delivery`], ['SCHEDULER_EMAIL', undefined]]) {
      const wrong = structuredClone(revisions);
      wrong[name].spec.containers[0].env.find(v => v.name === key).value = value;
      await assert.rejects(preflight(cfg, inspect(wrong)));
    }
  }
  for (const [key, value] of [['DELIVERY_QUEUE', `projects/${cfg.projectId}/locations/${cfg.region}/queues/replay-delivery`], ['SCHEDULER_EMAIL', `replay@${cfg.projectId}.iam.gserviceaccount.com`]]) {
    const mismatched = structuredClone(revisions);
    mismatched.previous.spec.containers[0].env.find(v => v.name === key).value = value;
    await assert.rejects(preflight(cfg, inspect(mismatched)), /replay_delivery_configuration_mismatch/);
  }
});
test('callback verification binds exact body and timestamp and refuses stale or malformed signatures', () => {
  const secret = 'private-test-secret', now = 1800000000000, timestamp = String(now / 1000), body = '{"id":"event"}';
  const signature = `v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
  assert.equal(verifySignature(secret, timestamp, body, signature, now), true);
  assert.equal(verifySignature(secret, timestamp, body + ' ', signature, now), false);
  assert.equal(verifySignature(secret, timestamp, body, signature, now + 301000), false);
  assert.equal(verifySignature(secret, timestamp, body, 'v1=bad', now), false);
  assert.equal(verifySignature(secret, 'NaN', body, signature, now), false);
  const bytes = Buffer.from('{"id":"event","fieldId":"�"}');
  const signedBytes = `v1=${createHmac('sha256', secret).update(`${timestamp}.`).update(bytes).digest('hex')}`;
  const altered = Buffer.concat([bytes.subarray(0, bytes.indexOf(Buffer.from('�'))), Buffer.from([0xff]), bytes.subarray(bytes.indexOf(Buffer.from('�')) + 3)]);
  assert.equal(altered.toString('utf8'), bytes.toString('utf8'));
  assert.equal(verifySignature(secret, timestamp, bytes, signedBytes, now), true);
  assert.equal(verifySignature(secret, timestamp, altered, signedBytes, now), false);
});
test('timeout evidence requires an observed client abort, not delayed rejection or success', async () => {
  assert.deepEqual(callbackOutcome('timeout-once', 1), { status: 204, timeout: true });
  assert.deepEqual(callbackOutcome('fail-once', 1), { status: 503, timeout: false });
  const first = { id: 'same-event', attempt: 1, status: 204, clientClosedBeforeResponse: true }, retry = { id: 'same-event', attempt: 2, status: 204, responseFinished: true };
  callbackReceipts('timeout-once', [first, retry]);
  assert.throws(() => callbackReceipts('timeout-once', [{ ...first, status: 503 }, retry]));
  assert.throws(() => callbackReceipts('timeout-once', [{ ...first, clientClosedBeforeResponse: false }, retry]));
  assert.throws(() => callbackReceipts('timeout-once', [first]));
  assert.throws(() => callbackReceipts('timeout-once', [first, { ...retry, responseFinished: undefined }]));
  assert.throws(() => callbackReceipts('timeout-once', [first, { ...retry, responseFinished: false }]));
  callbackReceipts('fail-once', [{ ...first, status: 503, responseFinished: true }, retry]);
  for (const responseFinished of [false, undefined]) assert.throws(() => callbackReceipts('fail-once', [{ ...first, status: 503, responseFinished }, retry]), /callback_rejection_not_observed/);
  const closed = new EventEmitter(); closed.writableFinished = false;
  const observed = clientDisconnectedBeforeResponse(closed, 1000); closed.emit('close');
  assert.equal(await observed, true); assert.equal(closed.listenerCount('close'), 0);
  const finished = new EventEmitter(); finished.writableFinished = true;
  const successful = clientDisconnectedBeforeResponse(finished, 1000); finished.emit('close');
  assert.equal(await successful, false);
  assert.equal(await clientDisconnectedBeforeResponse(new EventEmitter(), 1), false);
});
test('winner evidence rejects last-writer-wins responses and missing winner identity', () => {
  const first = { status: 'submitted', completedByDeviceId: 'phone-one' };
  assert.equal(winnerAgreement([first, first], ['phone-one', 'phone-two']), 'phone-one');
  assert.throws(() => winnerAgreement([first, { ...first, completedByDeviceId: 'phone-two' }], ['phone-one', 'phone-two']));
  assert.throws(() => winnerAgreement([{ status: 'submitted' }], ['phone-one', 'phone-two']));
  assert.throws(() => winnerAgreement([{ ...first, status: 'pending' }], ['phone-one', 'phone-two']));
});
test('expiry evidence requires an owned, still-retained document beyond API expiry', () => {
  const now = 1800000000000, cfg = { disposableOwnerUid: 'test-owner' };
  const doc = { fields: { ownerId: { stringValue: cfg.disposableOwnerUid }, expiresAt: { integerValue: String(now - 1000) }, purgeAt: { timestampValue: new Date(now + 1200000).toISOString() } } };
  expiryFixtureState(doc, cfg, true, now);
  assert.throws(() => expiryFixtureState({}, cfg, true, now));
  assert.throws(() => expiryFixtureState(doc, { disposableOwnerUid: 'other-owner' }, true, now));
  assert.throws(() => expiryFixtureState(doc, cfg, false, now));
  const purged = structuredClone(doc); purged.fields.purgeAt.timestampValue = new Date(now - 1).toISOString();
  assert.throws(() => expiryFixtureState(purged, cfg, true, now));
});
test('device setup exceptions are failed scenarios, never merely pending acceptance', async () => {
  const results = [];
  await assert.rejects(checkedScenario(results, 'device-setup', async () => { throw new Error('provider body must stay private'); }), /scenario_failed/);
  assert.equal(results[0].status, 'failed');
  assert.equal(JSON.stringify(report(results, {})).includes('provider body'), false);
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
test('all fixture credentials fail validation before callers can begin setup mutations', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-credential-preflight-'));
  try {
    const ownerFile = join(dir, 'owner'), first = join(dir, 'first'), second = join(dir, 'second'), admin = join(dir, 'admin');
    const claims = { sub: 'disposable', aud: base.projectId, iss: `https://securetoken.google.com/${base.projectId}`, exp: Math.floor(Date.now() / 1000) + 3600, firebase: { sign_in_provider: 'google.com' } };
    await writeFile(ownerFile, `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`, { mode: 0o600 });
    await writeFile(first, 'first-token', { mode: 0o600 });
    const cfg = { ...base, ownerTokenFile: ownerFile, fcmTokenFiles: [first, second] };
    let mutationStarted = false;
    await assert.rejects(async () => { await fixtureCredentials(cfg); mutationStarted = true; });
    assert.equal(mutationStarted, false);
    await writeFile(second, 'second-token', { mode: 0o600 }); await chmod(second, 0o644);
    await assert.rejects(fixtureCredentials(cfg));
    await chmod(second, 0o600);
    const withCallback = { ...cfg, callbackUrl: 'https://receiver.run.app', callbackAdminTokenFile: admin };
    await assert.rejects(fixtureCredentials(withCallback));
    await writeFile(admin, 'admin-secret', { mode: 0o600 });
    await assert.rejects(fixtureCredentials(withCallback), /invalid_callback_admin_secret/);
    await writeFile(admin, 'a'.repeat(43), { mode: 0o600 });
    const result = await fixtureCredentials(withCallback);
    assert.deepEqual(result.phones, ['first-token', 'second-token']); assert.equal(result.callbackAdmin, 'a'.repeat(43));
    for (const invalid of ['x'.repeat(4097), 'bad token', 'first-token']) {
      await writeFile(second, invalid, { mode: 0o600 });
      await assert.rejects(fixtureCredentials(cfg));
    }
    await assert.rejects(fixtureCredentials({ ...cfg, fcmTokenFiles: [first, first] }), /distinct_fcm_tokens_required/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('replay evidence requires ordered event types and complete matching JSON metadata', () => {
  const event = id => ({ id, type: 'request.created', requestId: 'request', sequence: Number(id.slice(-4)) });
  const frame = id => `id: ${id}\nevent: request.created\ndata: ${JSON.stringify(event(id))}\n\n`;
  const expected = [event('grant_0002'), event('grant_0003')], cursor = 'grant_0001';
  assert.equal(replayProgress(frame(expected[0].id), expected, cursor), false);
  assert.equal(replayProgress(expected.map(e => frame(e.id)).join(''), expected, cursor), true);
  for (const ids of [[cursor, ...expected.map(e => e.id)], ['grant_0002', 'grant_0002', 'grant_0003'], ['grant_0003', 'grant_0002']]) {
    assert.throws(() => replayProgress(ids.map(frame).join(''), expected, cursor), /sse_replay_order_mismatch/);
  }
  for (const invalid of [`id: grant_0002\n\n`, frame('grant_0002').replace('request.created', 'request.cancelled'), frame('grant_0002').replace(JSON.stringify(expected[0]), '{}'), frame('grant_0002').replace(JSON.stringify(expected[0]), '{bad')]) {
    assert.throws(() => replayProgress(invalid, expected, cursor));
  }
  assert.throws(() => replayProgress('', [], cursor), /replay_suffix_required/);
});
test('TTL readiness requires the actual purgeAt field in the intended collection', () => {
  const field = name => ({ name: `projects/p/databases/(default)/collectionGroups/requests/fields/${name}`, ttlConfig: { state: 'ACTIVE' } });
  assert.equal(activeTtl([field('otherDeadline')], 'requests'), false);
  assert.equal(activeTtl([field('purgeAt')], 'requests'), true);
  assert.equal(activeTtl([field('purgeAt')], 'results'), false);
  assert.equal(activeTtl([{ ...field('purgeAt'), ttlConfig: { state: 'CREATING' } }], 'requests'), false);
});
test('cleanup assigns known pending pairings to the disposable owner before deletion', async () => {
  const seen = [], pending = new Map([['first', 'pending'], ['second', 'approved']]);
  assert.equal(await settlePairings([...pending.keys()], async code => {
    seen.push(code); if (pending.get(code) === 'pending') pending.set(code, 'denied');
    return { status: pending.get(code) };
  }), true);
  assert.deepEqual(seen, ['first', 'second']); assert.equal(pending.get('first'), 'denied');
  assert.equal(await settlePairings(['expired'], async () => ({ status: 'expired' })), false);
  const attempted = [];
  assert.equal(await settlePairings(['failed', 'later'], async code => { attempted.push(code); throw new Error('unavailable'); }), false);
  assert.deepEqual(attempted, ['failed', 'later']);
});
test('infrastructure requires every configured composite index, including field order', () => {
  const required = [{ collectionGroup: 'requests', queryScope: 'COLLECTION', fields: [{ fieldPath: 'ownerId', order: 'ASCENDING' }, { fieldPath: 'createdAt', order: 'DESCENDING' }] }];
  const actual = [{ name: 'projects/p/databases/(default)/collectionGroups/requests/indexes/one', state: 'READY', queryScope: 'COLLECTION', fields: [...required[0].fields, { fieldPath: '__name__', order: 'DESCENDING' }] }];
  readyIndexes(actual, required);
  assert.throws(() => readyIndexes([], required));
  assert.throws(() => readyIndexes([{ ...actual[0], fields: [...required[0].fields].reverse() }], required));
  assert.throws(() => readyIndexes([{ ...actual[0], queryScope: 'COLLECTION_GROUP' }], required));
  assert.throws(() => readyIndexes([{ ...actual[0], state: 'CREATING' }], required));
});
test('MCP cancellation proof rejects a successful no-op and requires persisted cancellation event', async () => {
  const cancelled = { requestId: 'fixture', status: 'cancelled' };
  const events = async () => [{ requestId: 'fixture', type: 'request.cancelled' }];
  await proveCancellation('fixture', async () => cancelled, async () => cancelled, events);
  await assert.rejects(proveCancellation('fixture', async () => ({ ...cancelled, status: 'pending' }), async () => cancelled, events));
  await assert.rejects(proveCancellation('fixture', async () => cancelled, async () => ({ status: 'pending' }), events));
  await assert.rejects(proveCancellation('fixture', async () => cancelled, async () => cancelled, async () => []));
});
test('native SIGINT and SIGTERM abort an in-flight wait through cleanup before exit', async () => {
  const core = new URL('./core.mjs', import.meta.url).href;
  const script = `import { runInterrupts } from ${JSON.stringify(core)}; import { setTimeout } from 'node:timers/promises'; const run = runInterrupts(); let cleaned = false; try { process.kill(process.pid, process.argv[1]); await setTimeout(121000, undefined, {signal:run.signal}); } catch { if (!run.signal.aborted) throw Error('not interrupted'); } finally { cleaned = true; console.log(JSON.stringify({cleaned,interrupted:run.signal.aborted})); run.dispose(); }`;
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, signal], { timeout: 5000 });
    assert.deepEqual(JSON.parse(stdout), { cleaned: true, interrupted: true });
  }
  assert.equal(report(scenarios.map(scenario => ({ scenario, status: 'passed' })), { interrupted: true }).complete, false);
});
