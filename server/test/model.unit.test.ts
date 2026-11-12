import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { bump, codeSchema, hash, MINUTE, newSecret, requestSchema } from '../src/model.js';
test('256-bit secrets, deterministic one-way identifier and strict request validation', () => {
  const token = newSecret();
  assert.match(token, /^smsr_[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(token.slice(5), 'base64url').length, 32);
  assert.notEqual(token, newSecret()); assert.equal(hash(token).length, 64);
  assert.equal(requestSchema.safeParse({ purpose: 'Sign in', idempotencyKey: 'test-key-1', deviceId: 'arbitrary' }).success, false);
  assert.equal(requestSchema.safeParse({ purpose: '', idempotencyKey: 'test-key-1' }).success, false);
  assert.equal(requestSchema.safeParse({ purpose: 'Sign in', idempotencyKey: 'test-key-1', senderPhone: 'local number' }).success, false);
});
test('approved codes conform to Android eligibility, including leading zeros', () => {
  for (const code of ['0000', '123456', 'A1b2C3', 'AB12345678']) assert.equal(codeSchema.parse(code), code);
  for (const code of ['123', '12345678901', 'letters', 'A1-234', ' 1234', '１２３４']) assert.equal(codeSchema.safeParse(code).success, false);
});
test('fixed rate window resets only at its boundary', () => {
  const rate = { start: 1000, count: 3 };
  assert.throws(() => bump(rate, 1000 + 10 * MINUTE - 1, 3));
  assert.deepEqual(bump(rate, 1000 + 10 * MINUTE, 3), { start: 1000 + 10 * MINUTE, count: 1 });
});

test('device and SMS event schemas keep legacy Android clients compatible and manual windows server-timed', async () => {
  const {deviceRegistrationSchema,smsEventSchema} = await import('../src/model.js');
  assert.equal(deviceRegistrationSchema.parse({name:'Phone',fcmToken:'synthetic'}).platform,'android');
  assert.equal(deviceRegistrationSchema.parse({name:'iPhone',fcmToken:'synthetic',platform:'ios'}).platform,'ios');
  assert.equal(deviceRegistrationSchema.safeParse({name:'Other',fcmToken:'synthetic',platform:'web'}).success,false);
  assert.equal(smsEventSchema.parse({status:'ready',mode:'manual'}).status,'ready');
  for(const input of [{status:'ready'},{status:'ready',mode:'manual',listenerStartedAt:1},{status:'ready',mode:'manual',manualEntryDeadline:9999999}]) assert.equal(smsEventSchema.safeParse(input).success,false);
  assert.equal(smsEventSchema.parse({status:'ready',listenerStartedAt:1}).status,'ready');
});

test('published SMS readiness contracts enforce the runtime input alternatives', async () => {
  const { smsEventSchema } = await import('../src/model.js');
  const exported = JSON.parse(readFileSync(new URL('../../contracts/onboarding.schemas.json', import.meta.url), 'utf8'));
  const openapi = JSON.parse(readFileSync(new URL('../../contracts/onboarding.openapi.json', import.meta.url), 'utf8'));
  const inputs: [unknown, boolean][] = [
    [{ status: 'ready', listenerStartedAt: 1 }, true],
    [{ status: 'ready', mode: 'listener', listenerStartedAt: 1 }, true],
    [{ status: 'ready', mode: 'manual' }, true],
    [{ status: 'ready' }, false],
    [{ status: 'ready', mode: 'listener' }, false],
    [{ status: 'ready', mode: 'manual', listenerStartedAt: 1 }, false],
    [{ status: 'ready', mode: 'manual', manualEntryDeadline: 9999999 }, false],
    [{ status: 'ready', listenerStartedAt: 0 }, false],
  ];
  for (const schema of [smsEventSchema, z.fromJSONSchema(exported.SmsDeviceEvent), z.fromJSONSchema(openapi.components.schemas.SmsDeviceEvent)]) {
    for (const [input, valid] of inputs) assert.equal(schema.safeParse(input).success, valid, JSON.stringify(input));
  }
});
