import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formSchema, submissionSchema, validateSubmission } from '../src/forms-model.js';
import { publicAddress, signature, validateDestination } from '../src/webhooks.js';

const definition = () => formSchema.parse({ title: 'Invoice', body: '**Please review**', idempotencyKey: 'invoice-001',
  fields: [
    { id: 'note', label: 'Note', type: 'text', required: true, maxLength: 10 },
    { id: 'amount', label: 'Amount', type: 'number', min: 1, max: 100 },
    { id: 'check', label: 'Confirmed', type: 'checkbox', required: true },
    { id: 'date', label: 'Date', type: 'date' },
    { id: 'category', label: 'Category', type: 'single_choice', options: [{ id: 'food', label: 'Food' }] },
    { id: 'tags', label: 'Tags', type: 'multiple_choice', options: [{ id: 'tax', label: 'Tax' }] },
  ], actions: [{ id: 'yes', label: 'Approve', type: 'approve' }, { id: 'no', label: 'Decline', type: 'decline' }] });
const valid = () => ({ submissionId: 'upload-1', action: 'yes', values: { note: 'Okay', amount: 50, check: true, date: '2026-11-09', category: 'food', tags: ['tax'] } });
test('definitions have bounded defaults, unique identifiers, and immutable declarative layouts', () => {
  const d = definition(); assert.equal(d.expiresInSeconds, 86400);
  for (const patch of [ { fields: [d.fields[0], d.fields[0]] }, { actions: [d.actions[0], d.actions[0]] }, { expiresInSeconds: 604801 },
    { fields: [{ id: 'a', type: 'number', label: 'n', min: 5, max: 1 }] }, { script: 'alert(1)' },
    { fields: [{ id: 'a', type: 'single_choice', label: 'Choice', options: [{ id: 'a', label: 'A' }, { id: 'a', label: 'Again' }] }] } ]) {
    assert.equal(formSchema.safeParse({ ...d, ...patch }).success, false);
  }
});
test('all supported response types are validated; decline bypasses required fields without answers', () => {
  const d = definition(); assert.equal(validateSubmission(d, valid()), 'submitted');
  assert.equal(validateSubmission(d, { submissionId: 'decline-1', action: 'no', values: {} }), 'declined');
  const badValues = [{ note: '' }, { note: 'long'.repeat(5) }, { amount: '20' }, { amount: 0 }, { check: false }, { check: 'true' },
    { date: '2026-02-30' }, { date: '2026-11-09T12:00Z' }, { category: 'unknown' }, { tags: ['tax', 'tax'] }, { tags: ['unknown'] }, { surprise: 'x' }];
  for (const patch of badValues) assert.throws(() => validateSubmission(d, { ...valid(), values: { ...valid().values, ...patch } } as never));
  assert.throws(() => validateSubmission(d, { ...valid(), action: 'missing' }));
  assert.throws(() => validateSubmission(d, { ...valid(), action: 'no' }));
  assert.equal(submissionSchema.safeParse({ ...valid(), values: { amount: Infinity } }).success, false);
});
test('SMS code helpers validate codes without requiring listening or implying submission', () => {
  const d = formSchema.parse({ ...definition(), fields: [{ id: 'code', label: 'Code', type: 'text', input: 'sms_code', required: true }] });
  assert.equal(validateSubmission(d, { ...valid(), values: { code: 'A1234' } }), 'submitted');
  assert.throws(() => validateSubmission(d, { ...valid(), values: { code: 'letters' } }));
});
test('webhooks reject private, reserved, mapped, and local addresses and unsafe URLs', async () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '224.1.1.1', '::1', '::', 'fe80::1', 'fc00::1', '::ffff:127.0.0.1', '192.0.2.1', '198.18.0.1', '64:ff9b::7f00:1', '2002:7f00:1::']) assert.equal(publicAddress(ip), false, ip);
  assert.equal(publicAddress('8.8.8.8'), true); assert.equal(publicAddress('2606:4700:4700::1111'), true);
  for (const url of ['http://8.8.8.8', 'https://127.0.0.1', 'https://[::1]', 'https://user:pass@8.8.8.8', 'https://8.8.8.8:8443', 'https://8.8.8.8/#fragment']) await assert.rejects(validateDestination(url));
});
test('signatures bind the exact payload and timestamp', () => {
  assert.equal(signature('secret', '123', '{"id":"e"}'), '856bedd896a4356b4737e395fcdeb19de5fca7c3ef02a02a2c55efc28fd547bc');
  assert.notEqual(signature('secret', '124', '{"id":"e"}'), signature('secret', '123', '{"id":"e"}'));
});
