import { test } from 'node:test';
import assert from 'node:assert/strict';
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
