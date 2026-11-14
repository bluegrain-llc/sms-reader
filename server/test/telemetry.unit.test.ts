import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { Telemetry, category } from '../src/telemetry.js';

test('provider errors produce bounded categories without serializing payloads or credentials', () => {
  const records: unknown[] = [];
  const telemetry = new Telemetry(entry => records.push(entry), () => 20_000);
  const secret = 'smsr_private-provider-value';
  telemetry.delivery('webhook', 1000, 'failed', { code: 'ECONNREFUSED', message: secret, url: 'https://private.example?token=' + secret });
  telemetry.delivery('form', 5000, 'accepted');
  telemetry.delivery('sms', 1000, 'failed', undefined);
  assert.deepEqual(records, [
    { event: 'delivery_attempt', kind: 'webhook', outcome: 'failed', category: 'unavailable', age_ms: 19_000, component: 'relay', severity: 'WARNING' },
    { event: 'delivery_attempt', kind: 'form', outcome: 'accepted', age_ms: 15_000, component: 'relay', severity: 'INFO' },
    { event: 'delivery_attempt', kind: 'sms', outcome: 'failed', category: 'internal', age_ms: 19_000, component: 'relay', severity: 'WARNING' },
  ]);
  assert.ok(!JSON.stringify(records).includes(secret));
  assert.equal(category({ code: 'messaging/message-rate-exceeded' }), 'quota');
  assert.equal(category({ code: 'messaging/server-unavailable' }), 'unavailable');
  assert.equal(category({ code: 4 }), 'timeout');
  assert.equal(category(Error('webhook_timeout')), 'timeout');
  assert.equal(category(Error('webhook_rejected')), 'rejected');
  assert.equal(category({ code: 'messaging/registration-token-not-registered' }), 'destination');
  assert.doesNotThrow(() => new Telemetry(() => { throw Error(secret); }).delivery('sms', 0, 'accepted'));
});

test('recovery diagnostics allow only canonical error codes and never serialize error context', () => {
  const records: unknown[] = [];
  const telemetry = new Telemetry(entry => records.push(entry));
  const secret = 'Bearer private-token owner@example.test https://private.example/?code=private-code';
  const errors: [unknown, number | string | undefined, string][] = [
    [Object.assign(new Error(secret), { code: 7 }), 7, 'internal'],
    [{ code: '14' }, 14, 'unavailable'],
    [{ code: 'DEADLINE_EXCEEDED' }, 4, 'timeout'],
    [{ code: 'resource-exhausted' }, 8, 'quota'],
    [{ code: 'app/invalid-credential' }, 'app/invalid-credential', 'internal'],
    [{ code: 'ERR_BAD_REQUEST', response: { status: 403, data: { error: secret }, headers: { authorization: secret } } }, 403, 'internal'],
    [{ status: '503' }, 503, 'unavailable'],
    [{ code: secret, status: secret }, undefined, 'internal'],
    [{ code: { toString: () => { throw Error(secret); } } }, undefined, 'internal'],
    [{ code: Infinity }, undefined, 'internal'],
    [{ code: 7.5 }, undefined, 'internal'],
    [{ code: 200 }, undefined, 'internal'],
    [{ code: 600 }, undefined, 'internal'],
    [undefined, undefined, 'internal'],
    [new Proxy({}, { get: () => { throw Error(secret); } }), undefined, 'internal'],
  ];
  for (const [error] of errors) {
    if (error && typeof error === 'object') {
      Object.assign(error, { message: secret, cause: { code: 7, token: secret }, stack: secret,
        metadata: { authorization: secret }, toJSON: () => { throw Error('raw error must never be serialized'); } });
    }
    telemetry.recoveryGateUnavailable('credential', error);
  }
  assert.deepEqual(records, errors.map(([, code, category]) => ({ event: 'recovery_gate_unavailable', phase: 'credential', category,
    ...(code === undefined ? {} : { error_code: code }), component: 'relay', severity: 'ERROR' })));
  assert.ok(!JSON.stringify(records).includes('private'));
  assert.doesNotThrow(() => new Telemetry(() => { throw Error(secret); }).recoveryGateUnavailable('watch', { code: 14 }));
});

test('HTTP metrics retain route templates while excluding caller paths queries and headers', { timeout: 5000 }, async () => {
  const records: unknown[] = [];
  const api = express();
  const telemetry = new Telemetry(entry => records.push(entry));
  api.use(telemetry.http);
  api.get('/requests/:requestId', (_req, res) => { res.json({ ok: true }); });
  api.use((_req, res) => { res.sendStatus(404); });
  const server = api.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    await (await fetch(base + '/requests/private-id?code=private-answer', { headers: { authorization: 'Bearer private-token' }, signal: AbortSignal.timeout(2000) })).text();
    await (await fetch(base + '/private-unmatched-path', { signal: AbortSignal.timeout(2000) })).text();
    const http = records as { route: string; status_class: string; duration_ms: number }[];
    assert.deepEqual(http.map(r => [r.route, r.status_class]), [['/requests/:requestId', '2xx'], ['unmatched', '4xx']]);
    assert.ok(http.every(r => r.duration_ms >= 0));
    assert.ok(!JSON.stringify(records).includes('private'));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test('failed maintenance emits failure, never completion, and retains original error', async () => {
  const records: unknown[] = [];
  const telemetry = new Telemetry(entry => records.push(entry));
  const error = { code: 14, message: 'sensitive dependency context' };
  await assert.rejects(telemetry.maintenance(async () => { throw error; }, {} as never), actual => actual === error);
  assert.deepEqual(records, [{ event: 'maintenance_failed', category: 'unavailable', component: 'relay', severity: 'ERROR' }]);
});

test('successful maintenance retains completion even if read-only backlog sampling fails', async () => {
  const records: { event?: string }[] = [];
  const telemetry = new Telemetry(entry => records.push(entry));
  let completed = false;
  await telemetry.maintenance(async () => { completed = true; }, {} as never);
  assert.equal(completed, true);
  assert.deepEqual(records.map(r => r.event), ['backlog_sampling_failed', 'maintenance_completed']);
});

test('onboarding outcome counts exclude payloads, private identities and credentials', async () => {
  const { onboardingOutcome } = await import('../src/telemetry.js');
  const privateValue = { status: 'approved', ownerId: 'private-owner', redirect: 'https://example.test?code=private-code' };
  assert.deepEqual(onboardingOutcome('/v3/oauth/sessions/:id/decision','POST',200,privateValue),{event:'onboarding_outcome',phase:'approval',outcome:'approved',count:1});
  assert.deepEqual(onboardingOutcome('/v3/connection','GET',200,{setup:'phone_setup_needed',email:'private-email'}),{event:'onboarding_outcome',phase:'setup',outcome:'phone_setup_needed',count:1});
  assert.deepEqual(onboardingOutcome('/v3/pairing-sessions/:id','GET',410,{error:'session_expired'}),{event:'onboarding_outcome',phase:'approval',outcome:'expired',count:1});
  const value=onboardingOutcome('/v3/service/deliveries','GET',200,{deliveries:[{envelope:'private-envelope'}]});
  assert.equal(value?.count,1);assert.ok(!JSON.stringify(value).includes('private'));
  assert.equal(onboardingOutcome('/mcp','POST',200,privateValue),undefined);
});
