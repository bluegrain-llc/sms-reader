import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import type { Relay } from '../src/relay.js';
import { MINUTE } from '../src/model.js';
import { RustRelay, rustApp } from './rust-adapter.js';

if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) throw Error('Native runtime contracts require emulators');
const firebase = initializeApp({ projectId: 'demo-sms-relay' }, 'native-runtime-contract');
const db = getFirestore(firebase), uid = 'native-owner', did = 'native-device';
let time: number, bridge: RustRelay, relay: Relay;
const form = (key: string) => ({ title: 'Review', body: 'Synthetic request', idempotencyKey: key,
  actions: [{ id: 'submit', label: 'Send', type: 'submit' as const }] });
type Subscription = { subscriptionId: string; activeFeeds: number };
type Snapshot = { failed: boolean; revision: number; oldest: number | null; events: { id: string; sequence: number; type: string }[]; activeFeeds: number };

beforeEach(async () => {
  const response = await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-sms-relay/databases/(default)/documents`, { method: 'DELETE', signal: AbortSignal.timeout(10_000) });
  assert.equal(response.status, 200);
  time = 1_800_000_000_000;
  bridge = new RustRelay(db, async () => {}, () => time);
  relay = bridge as unknown as Relay;
  await relay.register(uid, did, 'Phone', 'synthetic-fcm');
});
after(async () => { await deleteApp(firebase); });
async function readyGrant() {
  const grant = await relay.createGrant(uid, did, 'Caller', 30);
  await relay.forms.approve(uid, grant.grantId, true);
  return grant;
}
async function until<T>(read: () => Promise<T>, predicate: (value: T) => boolean, signal: AbortSignal): Promise<T> {
  let last: T | undefined;
  for (let attempt = 0; attempt < 100; attempt++) {
    signal.throwIfAborted();
    const value = await read(); last = value;
    if (predicate(value)) return value;
    await delay(25, undefined, { signal });
  }
  throw Error('Native watch did not deliver the expected state: ' + JSON.stringify(last));
}

test('native grant feed shares watches, bounds its tail, delivers changes and closes all clients on revocation', { timeout: 30_000 }, async t => {
  const grant = await readyGrant(), subscriptions: string[] = [];
  const snapshot = (id: string) => bridge.call('streamSnapshot', [id]) as Promise<Snapshot>;
  try {
    const first = await bridge.call('streamSubscribe', [grant.token]) as Subscription; subscriptions.push(first.subscriptionId);
    const second = await bridge.call('streamSubscribe', [grant.token]) as Subscription; subscriptions.push(second.subscriptionId);
    assert.equal(first.activeFeeds, 1); assert.equal(second.activeFeeds, 1);
    const request = await relay.forms.create(grant.token, form('native-watch-created'));
    for (const id of subscriptions) {
      const state = await until(() => snapshot(id), state => state.events.some(event => event.type === 'request.created'), t.signal);
      assert.equal(state.activeFeeds, 1); assert.ok(!JSON.stringify(state.events).includes(uid));
      assert.ok(state.events.some(event => event.id.startsWith(grant.grantId + '_')));
    }
    const batch = db.batch();
    for (let sequence = 2; sequence <= 151; sequence++) {
      const id = `${grant.grantId}_${String(sequence).padStart(16, '0')}`;
      batch.set(db.collection('requestEvents').doc(id), { id, ownerId: uid, grantId: grant.grantId, requestId: request.requestId,
        type: 'request.opened', sequence, requestSequence: sequence, at: time, purgeAt: new Date(time + MINUTE) });
    }
    batch.update(db.collection('grants').doc(grant.grantId), { eventSequence: 151 }); await batch.commit();
    const tail = await until(() => snapshot(first.subscriptionId), state => state.events.at(-1)?.sequence === 151, t.signal);
    assert.equal(tail.events.length, 100); assert.equal(tail.oldest, 52);
    assert.deepEqual(tail.events.map(event => event.sequence), Array.from({ length: 100 }, (_, i) => i + 52));
    const stop = await bridge.call('streamStop', [first.subscriptionId]) as { activeFeeds: number };
    subscriptions.splice(subscriptions.indexOf(first.subscriptionId), 1); assert.equal(stop.activeFeeds, 1);
    await relay.revoke(uid, grant.grantId);
    await until(() => snapshot(second.subscriptionId), state => state.failed, t.signal);
    const final = await bridge.call('streamStop', [second.subscriptionId]) as { activeFeeds: number };
    subscriptions.splice(subscriptions.indexOf(second.subscriptionId), 1); assert.equal(final.activeFeeds, 0);
  } finally { for (const id of subscriptions) await bridge.call('streamStop', [id]); }
});

test('native account deletion closes every subscriber sharing its authorization watches', { timeout: 30_000 }, async t => {
  const grant = await readyGrant(), subscriptions: string[] = [];
  try {
    for (let client = 0; client < 2; client++) {
      const subscription = await bridge.call('streamSubscribe', [grant.token]) as Subscription;
      subscriptions.push(subscription.subscriptionId); assert.equal(subscription.activeFeeds, 1);
    }
    await relay.deletions.request(uid);
    for (const id of subscriptions) {
      await until(() => bridge.call('streamSnapshot', [id]) as Promise<Snapshot>, state => state.failed, t.signal);
    }
    assert.equal((await db.collection('accounts').doc(uid).get()).data()?.deleting, true);
  } finally {
    for (const [index, id] of subscriptions.entries()) {
      const state = await bridge.call('streamStop', [id]) as { activeFeeds: number };
      assert.equal(state.activeFeeds, index === subscriptions.length - 1 ? 0 : 1);
    }
  }
});

test('native SSE replays a durable gap larger than the shared tail without losing its cursor order', { timeout: 30_000 }, async t => {
  const grant = await readyGrant();
  const batch = db.batch();
  for (let sequence = 1; sequence <= 151; sequence++) {
    const id = `${grant.grantId}_${String(sequence).padStart(16, '0')}`;
    batch.set(db.collection('requestEvents').doc(id), { id, ownerId: uid, grantId: grant.grantId, requestId: 'synthetic-replay',
      type: 'request.created', sequence, requestSequence: sequence, at: time, purgeAt: new Date(time + MINUTE) });
  }
  batch.update(db.collection('grants').doc(grant.grantId), { eventSequence: 151 }); await batch.commit();
  const server = rustApp(relay, { verifyOwner: async () => ({ uid, authTime: time / 1000 }), verifyScheduler: async () => {}, deleteIdentity: async () => {}, sseDurationMs: 1500 }).listen();
  try {
    await once(server, 'listening');
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v2/events/stream`, {
      headers: { authorization: `Bearer ${grant.token}` }, signal: AbortSignal.any([t.signal, AbortSignal.timeout(10_000)]),
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    const sequences = Array.from(text.matchAll(/^id: .*_(\d{16})$/gm), match => Number(match[1]));
    assert.deepEqual(sequences, Array.from({ length: 151 }, (_, i) => i + 1));
    assert.ok(text.includes(': heartbeat'));
  } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test('native denial callbacks must acknowledge independently before any protected mutation', { timeout: 30_000 }, async () => {
  const grant = await readyGrant();
  const hook = await relay.forms.registerWebhook(grant.token, { url: 'https://8.8.8.8/synthetic', events: ['request.created'] });
  const attempted: string[] = [];
  const guarded = new RustRelay(db, async () => {}, () => time, undefined, async action => { attempted.push(action.kind); throw Error('synthetic ledger unavailable'); }) as unknown as Relay;
  await assert.rejects(guarded.revoke(uid, grant.grantId));
  await assert.rejects(guarded.forms.approve(uid, grant.grantId, false));
  await assert.rejects(guarded.changeDevice(uid, did, true));
  await assert.rejects(guarded.changeDevice(uid, did, true, true));
  await assert.rejects(guarded.forms.webhooks(grant.token, hook.id));
  await assert.rejects(guarded.deletions.request(uid));
  assert.deepEqual(attempted, ['grant.revoke', 'forms.deny', 'device.pause', 'device.delete', 'webhook.delete', 'account.delete']);
  const rawGrant = (await db.collection('grants').doc(grant.grantId).get()).data()!;
  assert.equal(rawGrant.revoked, false); assert.equal(rawGrant.formsApproved, true); assert.equal(rawGrant.webhooks.length, 1);
  const device = (await db.collection('devices').doc(did).get()).data()!;
  assert.equal(device.paused, false); assert.equal(device.deleted, false);
  assert.equal((await db.collection('accounts').doc(uid).get()).data()?.deleting, undefined);
  assert.equal((await db.collection('deletionJobs').get()).size, 0);
});
