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

const wizard = () => formSchema.parse({ title: 'Travel approval', body: 'Complete the steps', idempotencyKey: 'wizard-001',
  fields: [{ id: 'travel', type: 'checkbox', label: 'Travel expense' },
    { id: 'city', type: 'text', label: 'Destination', required: true },
    { id: 'receipt', type: 'checkbox', label: 'Receipt available' },
    { id: 'reference', type: 'text', label: 'Receipt reference', required: true }],
  steps: [{ id: 'kind', title: 'Expense type', fieldIds: ['travel'] },
    { id: 'trip', title: 'Trip', fieldIds: ['city', 'receipt'], when: { fieldId: 'travel', equals: true } },
    { id: 'evidence', title: 'Receipt', fieldIds: ['reference'], when: { fieldId: 'receipt', equals: true } }],
  actions: [{ id: 'submit', type: 'submit', label: 'Submit' }, { id: 'decline', type: 'decline', label: 'Decline' }] });
test('wizard definitions reject ambiguous ownership, duplicate steps, forward references and incompatible predicates', () => {
  const d = wizard();
  for (const steps of [[d.steps![0]], [d.steps![0], d.steps![0]],
    [d.steps![0], { ...d.steps![1], fieldIds: ['city'] }],
    [{ ...d.steps![0], fieldIds: ['travel', 'missing'] }, ...d.steps!.slice(1)],
    [{ ...d.steps![0], when: { fieldId: 'travel', equals: true } }, ...d.steps!.slice(1)],
    [d.steps![0], { ...d.steps![1], when: { fieldId: 'reference', equals: 'x' } }, d.steps![2]],
    [d.steps![0], { ...d.steps![1], when: { fieldId: 'travel', equals: 'true' } }, d.steps![2]],
    [d.steps![0], { ...d.steps![1], when: { fieldId: 'travel', contains: 'x' } }, d.steps![2]]]) {
    assert.equal(formSchema.safeParse({ ...d, steps }).success, false);
  }
});
test('wizard submission validates only its reachable path and rejects stale answers in hidden branches', () => {
  const def = wizard(); const upload = (values: Record<string, string | boolean>) => ({ submissionId: 'wizard-upload', action: 'submit', values });
  assert.equal(validateSubmission(def, upload({})), 'submitted'); // An untouched optional checkbox is false.
  assert.equal(validateSubmission(def, upload({ travel: false })), 'submitted');
  assert.throws(() => validateSubmission(def, upload({ travel: true })), /required_field/);
  assert.equal(validateSubmission(def, upload({ travel: true, city: 'Santo Domingo', receipt: false })), 'submitted');
  assert.throws(() => validateSubmission(def, upload({ travel: true, city: 'Santo Domingo', receipt: true })), /required_field/);
  assert.equal(validateSubmission(def, upload({ travel: true, city: 'Santo Domingo', receipt: true, reference: 'DEMO' })), 'submitted');
  assert.throws(() => validateSubmission(def, upload({ travel: false, city: 'Stale', receipt: true, reference: 'Stale' })), /hidden_field/);
  assert.throws(() => validateSubmission(def, upload({ travel: false, reference: 'Stale' })), /hidden_field/);
  assert.equal(validateSubmission(def, { ...upload({}), action: 'decline' }), 'declined');
});
test('wizard conditions compare choice membership and numbers without coercing strings', () => {
  const d = formSchema.parse({ ...wizard(), fields: [
    { id: 'tags', type: 'multiple_choice', label: 'Tags', options: [{ id: 'tax', label: 'Tax' }] },
    { id: 'amount', type: 'number', label: 'Amount', required: true },
    { id: 'note', type: 'text', label: 'Note', required: true }],
    steps: [{ id: 'tags', title: 'Tags', fieldIds: ['tags'] },
      { id: 'tax', title: 'Tax', fieldIds: ['amount'], when: { fieldId: 'tags', contains: 'tax' } },
      { id: 'note', title: 'Note', fieldIds: ['note'], when: { fieldId: 'amount', equals: 10 } }] });
  const upload = (values: Record<string, string | number | string[]>) => ({ submissionId: 'choice-wizard', action: 'submit', values });
  assert.equal(validateSubmission(d, upload({ tags: [] })), 'submitted');
  assert.throws(() => validateSubmission(d, upload({ tags: ['tax'] })), /required_field/);
  assert.throws(() => validateSubmission(d, upload({ tags: ['tax'], amount: 10 })), /required_field/);
  assert.equal(validateSubmission(d, upload({ tags: ['tax'], amount: 11 })), 'submitted');
  assert.equal(validateSubmission(d, upload({ tags: ['tax'], amount: 10, note: 'Test' })), 'submitted');
  assert.throws(() => validateSubmission(d, upload({ tags: ['tax'], amount: '10', note: 'Test' })));
});
