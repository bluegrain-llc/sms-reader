import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import type { Firestore } from 'firebase-admin/firestore';
import type { Forms } from '../src/forms.js';
import { EventStreams } from '../src/event-streams.js';

function fixture(transaction: () => Promise<unknown> = async () => ({ grant: { id: 'grant', ownerId: 'owner', expiresAt: 100_000 } })) {
  let starts = 0, stops = 0;
  const snapshots = new Map<string, (value: unknown) => void>();
  const db = { runTransaction: transaction, collection: (collection: string) => {
    const watch = {
      doc: () => watch, where: () => watch, orderBy: () => watch, limit: () => watch,
      onSnapshot: (next: (value: unknown) => void) => { starts++; snapshots.set(collection, next); return () => { stops++; }; },
    };
    return watch;
  } } as unknown as Firestore;
  const forms = { db, now: () => 0, retained: () => true } as unknown as Forms;
  const streams = new EventStreams(forms);
  return { streams, starts: () => starts, stops: () => stops,
    ready: () => {
      snapshots.get('grants')!({ data: () => ({ ownerId: 'owner', formsApproved: true, expiresAt: 100_000 }) });
      snapshots.get('accounts')!({ data: () => ({}) });
      snapshots.get('requestEvents')!({ docs: [] });
    } };
}
const subscriber = () => ({ changed: () => {}, closed: () => {} });

test('aborting watch startup detaches every listener and removes its shared feed', async () => {
  const f = fixture(), controller = new AbortController();
  const pending = f.streams.subscribe('synthetic', subscriber(), controller.signal);
  const rejected = assert.rejects(pending, /stream_closed/);
  try {
    await setImmediate(); assert.equal(f.starts(), 3);
    controller.abort(); await rejected;
    assert.equal(f.stops(), 3); assert.equal(f.streams.activeFeeds, 0);
  } finally { controller.abort(); await rejected; }
});
test('an abort during authorization cannot start listeners after the deadline', async () => {
  let authorize: (value: unknown) => void = () => {};
  const f = fixture(() => new Promise(resolve => { authorize = resolve; })), controller = new AbortController();
  const pending = f.streams.subscribe('synthetic', subscriber(), controller.signal);
  const rejected = assert.rejects(pending, /stream_closed/);
  controller.abort(); authorize({ grant: { id: 'grant', ownerId: 'owner', expiresAt: 100_000 } });
  await rejected; assert.equal(f.starts(), 0); assert.equal(f.streams.activeFeeds, 0);
});
test('one stream deadline preserves another subscriber and the final abort detaches shared listeners', async () => {
  const f = fixture(), first = new AbortController(), second = new AbortController();
  const a = f.streams.subscribe('synthetic', subscriber(), first.signal);
  const b = f.streams.subscribe('synthetic', subscriber(), second.signal);
  try {
    await setImmediate(); f.ready(); await Promise.all([a, b]);
    assert.equal(f.starts(), 3); assert.equal(f.streams.activeFeeds, 1);
    first.abort(); assert.equal(f.stops(), 0); assert.equal(f.streams.activeFeeds, 1);
    second.abort(); assert.equal(f.stops(), 3); assert.equal(f.streams.activeFeeds, 0);
  } finally { first.abort(); second.abort(); await Promise.allSettled([a, b]); }
});
