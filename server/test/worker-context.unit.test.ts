import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { app } from '../src/http.js';
import { Forms } from '../src/forms.js';
import { Relay } from '../src/relay.js';
import { telemetry, Telemetry } from '../src/telemetry.js';
import { WorkerContext } from '../src/worker-context.js';
const project = 'demo-sms-relay', id = '1234567890abcdef1234567890abcdef', other = 'fedcba0987654321fedcba0987654321';
const parent = (trace = id) => `00-${trace}-0000000000000001-00`;
const context = (trace = id) => WorkerContext.fromHeaders(project, parent(trace))!;

test('standard context is immutable, bounded and never takes a project from a header', () => {
  const c = WorkerContext.fromHeaders(project, parent(), `${id}/1;o=0`)!;
  assert.equal(c.trace, `projects/${project}/traces/${id}`); assert.ok(Object.isFrozen(c));
  for (const p of [undefined, 'projects/other', 'demo-project/private', 'ABCDEF']) assert.equal(WorkerContext.fromHeaders(p, parent()), undefined);
  for (const h of ['private-token', `${id}/0`, `${id}/18446744073709551616`, `${id}/1;o=0;secret=private`, `${'0'.repeat(32)}/1`]) assert.equal(WorkerContext.fromHeaders(project, undefined, h), undefined);
  for (const h of [parent().replace('00-', 'ff-'), parent().replace('0000000000000001', '0000000000000000'), parent() + '/private']) assert.equal(WorkerContext.fromHeaders(project, h), undefined);
  assert.equal(WorkerContext.fromHeaders(project, parent(), `${other}/1`), undefined);
  assert.equal(WorkerContext.fromHeaders(project, parent(), `${id}/2`), undefined);
  assert.equal(WorkerContext.fromHeaders(project, 'bad', `${id}/1`), undefined);
});
function harness({ retry = false, abort = false, future = false } = {}) {
  let now = 10000, txCalls = 0, callbacks = 0, inTransaction = false; const records: any[] = [];
  const claimStates: { inTransaction: boolean; lease: unknown; claimTrace: unknown; attempts: unknown }[] = [];
  const data = new Map<string, any>([
    ['deliveryOutbox/job', { id: 'job', kind: 'webhook', requestId: 'private-form', ownerId: 'private-owner', grantId: 'grant', eventId: 'private-event', hookId: 'hook', nextAt: future ? 999999 : 0, lease: null, attempts: 0, claimTrace: 'old-private-trace', purgeAt: new Date(999999) }],
    ['grants/grant', { formsApproved: true, webhooks: [{ id: 'hook', url: 'https://example.invalid', secret: 'private-token' }] }],
    ['formRequests/private-form', { id: 'private-form', status: 'pending', definition: { fields: [] }, createdAt: 0, purgeAt: new Date(999999) }],
    ['accounts/private-owner', {}], ['requestEvents/private-event', { id: 'private-event' }],
  ]);
  const db = { collection: (c: string) => ({ doc: (id: string) => ({ path: `${c}/${id}` }) }), runTransaction: async (fn: any) => {
    txCalls++; const execute = async () => {
      const writes: (() => void)[] = [];
      const tx = { get: async (ref: any) => ({ data: () => structuredClone(data.get(ref.path)) }), update: (ref: any, fields: any) => writes.push(() => data.set(ref.path, { ...data.get(ref.path), ...fields })), delete: (ref: any) => writes.push(() => data.delete(ref.path)) };
      inTransaction = true;
      try { return { result: await fn(tx), writes }; }
      finally { inTransaction = false; }
    };
    if (txCalls === 1 && retry) await execute(); // SDK retries without committing the first attempt.
    const run = await execute(); if (txCalls === 1 && abort) throw Error('synthetic transaction abort'); run.writes.forEach(f => f()); return run.result;
  } };
  const relay = { db, now: () => now, ref: (c: string, id: string) => db.collection(c).doc(id), validGrant: async () => true } as unknown as Relay;
  const forms = new Forms(relay, async () => {}, async () => { callbacks++; throw Error('webhook_timeout'); });
  const original = telemetry.emit; const logger = new Telemetry(entry => {
    records.push(entry);
    if (entry.event === 'delivery_lease_claimed') {
      const job = data.get('deliveryOutbox/job');
      claimStates.push({ inTransaction, lease: job?.lease, claimTrace: job?.claimTrace, attempts: job?.attempts });
    }
  });
  telemetry.emit = logger.emit.bind(logger);
  return { forms, data, records, claimStates, callbacks: () => callbacks, advance: () => { now += 5000; }, close: () => { telemetry.emit = original; } };
}
test('actual successful transaction joins claim trace atomically and emits once despite a transaction retry', async () => {
  const h = harness({ retry: true }); try {
    await h.forms.deliver('job', context());
    assert.equal(h.data.get('deliveryOutbox/job').claimTrace, context().trace);
    assert.equal(h.data.get('deliveryOutbox/job').attempts, 1); assert.equal(h.callbacks(), 1);
    const claims = h.records.filter(r => r.event === 'delivery_lease_claimed'); assert.equal(claims.length, 1);
    assert.equal(claims[0]['logging.googleapis.com/trace'], context().trace);
    assert.equal(h.claimStates.length, 1);
    assert.equal(h.claimStates[0]!.inTransaction, false);
    assert.equal(typeof h.claimStates[0]!.lease, 'string'); assert.ok(h.claimStates[0]!.lease);
    assert.equal(h.claimStates[0]!.claimTrace, context().trace); assert.equal(h.claimStates[0]!.attempts, 1);
    assert.ok(!JSON.stringify(h.records).includes('private'));
  } finally { h.close(); }
});
test('later untraced claim clears old trace in the same lease update', async () => {
  const h = harness(); try { await h.forms.deliver('job', context()); h.advance(); await h.forms.deliver('job');
    assert.equal(h.data.get('deliveryOutbox/job').claimTrace, null); assert.equal(h.data.get('deliveryOutbox/job').attempts, 2);
    assert.equal(h.records.filter(r => r.event === 'delivery_lease_claimed')[1]['logging.googleapis.com/trace'], undefined);
  } finally { h.close(); }
});
test('skipped or aborted claim does not write context or emit a claimed record', async () => {
  for (const setup of [{ future: true }, { abort: true }]) { const h = harness(setup); try {
    if (setup.abort) await assert.rejects(h.forms.deliver('job', context())); else await h.forms.deliver('job', context());
    assert.equal(h.data.get('deliveryOutbox/job').claimTrace, 'old-private-trace'); assert.equal(h.data.get('deliveryOutbox/job').attempts, 0);
    assert.equal(h.callbacks(), 0); assert.equal(h.records.length, 0); assert.equal(h.claimStates.length, 0);
  } finally { h.close(); } }
});

test('authenticated HTTP context is request-local, absent on auth rejection, retained on actual failed response finish', { timeout: 10000 }, async () => {
  const records: any[] = [], received: (WorkerContext | undefined)[] = []; const original = telemetry.emit;
  const logger = new Telemetry(e => records.push(e)); telemetry.emit = logger.emit.bind(logger);
  let rejectWork = false;
  const relay = { db: {}, deletions: { dispatch: async () => { if (rejectWork) throw Error('private failure'); } }, forms: { dispatch: async (c?: WorkerContext) => { received.push(c); await new Promise(resolve => setImmediate(resolve)); } } } as unknown as Relay;
  const server = app(relay, { projectId: project, verifyOwner: async () => { throw Error(); }, verifyScheduler: async token => { if (token !== 'worker') throw Error('private token'); }, deleteIdentity: async () => {} }).listen(0, '127.0.0.1');
  try { await once(server, 'listening'); const a = server.address(); assert.ok(a && typeof a !== 'string'); const url = `http://127.0.0.1:${a.port}/internal/delivery?private=answer`;
    const request = (header: string, token = 'worker') => fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, traceparent: header }, signal: AbortSignal.timeout(3000) }).then(async r => { await r.text(); return r.status; });
    assert.equal(await request(parent(), 'bad'), 401); assert.equal(received.length, 0);
    assert.deepEqual(await Promise.all([request(parent()), request(parent(other))]), [200, 200]);
    assert.deepEqual(new Set(received.map(c => c?.trace)), new Set([context().trace, context(other).trace]));
    assert.equal(await request('malformed-private'), 200); assert.equal(received.at(-1), undefined);
    rejectWork = true; assert.equal(await request(parent()), 500);
    const http = records.filter(e => e.event === 'http_completed'); assert.equal(http[0]['logging.googleapis.com/trace'], undefined);
    assert.equal(http.at(-1).status_class, '5xx'); assert.equal(http.at(-1)['logging.googleapis.com/trace'], context().trace);
    assert.ok(!JSON.stringify(records).includes('private'));
  } finally { telemetry.emit = original; server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
