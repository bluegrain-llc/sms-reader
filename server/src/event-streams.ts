import type { Firestore } from 'firebase-admin/firestore';
import type { Forms } from './forms.js';
import { publicEvent } from './forms.js';
import type { RelayEvent } from './forms-model.js';
import { ensure, hasCapability, hash } from './model.js';

type Subscriber = { changed: () => void; closed: () => void };
type Feed = { subscribers: Set<Subscriber>; stops: (() => void)[]; events: RelayEvent[]; revision: number; failed: boolean; ready: Promise<void> };

/** One bounded event tail and authorization watch per active grant, never per heartbeat. */
export class EventStreams {
  private feeds = new Map<string, Feed>();
  constructor(readonly forms: Forms, readonly db: Firestore = forms.db) {}
  get activeFeeds() { return this.feeds.size; }
  async subscribe(secret: string, subscriber: Subscriber, signal?: AbortSignal) {
    ensure(!signal?.aborted, 499, 'stream_closed');
    const { grant } = await this.db.runTransaction(tx => this.forms.agent(tx, secret));
    ensure(!signal?.aborted, 499, 'stream_closed');
    const key = hash(secret);
    let feed = this.feeds.get(key);
    if (!feed) {
      let resolve!: () => void, reject!: (e: Error) => void;
      const ready = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
      feed = { subscribers: new Set(), stops: [], events: [], revision: 0, failed: false, ready };
      this.feeds.set(key, feed);
      const current = feed;
      const seen = new Set<string>();
      const loaded = (name: string) => { seen.add(name); if (seen.size === (grant.serviceId ? 5 + (grant.deliveryAcknowledged ? 0 : 1) : 3)) resolve(); };
      const fail = () => {
        if (current.failed) return;
        current.failed = true; reject(Error('event_watch_unavailable'));
        for (const s of current.subscribers) s.closed();
        for (const stop of current.stops.splice(0)) stop();
      };
      const startup = setTimeout(fail, 10_000);
      current.stops.push(() => clearTimeout(startup));
      let latest = grant;
      let expiry: ReturnType<typeof setTimeout> | undefined;
      let stopDelivery: (() => void) | undefined;
      const scheduleExpiry = () => {
        clearTimeout(expiry);
        if (current.failed) return;
        const until = latest.serviceId && !latest.deliveryAcknowledged
          ? Math.min(latest.expiresAt, latest.deliveryExpiresAt ?? 0) : latest.expiresAt;
        const remaining = until - this.forms.now();
        if (remaining <= 0) { fail(); return; }
        expiry = setTimeout(scheduleExpiry, Math.min(2_147_483_647, remaining));
      };
      scheduleExpiry();
      current.stops.push(() => { clearTimeout(expiry); stopDelivery?.(); });
      current.stops.push(this.db.collection('grants').doc(grant.id).onSnapshot(doc => {
        const g = doc.data();
        if (current.failed) return;
        if (!g || g.ownerId !== grant.ownerId || g.serviceId !== grant.serviceId || g.revoked || g.managerId || !hasCapability(g as typeof grant, 'forms') || g.expiresAt <= this.forms.now()) return fail();
        latest = g as typeof grant;
        if (latest.deliveryAcknowledged) { stopDelivery?.(); stopDelivery = undefined; if (grant.serviceId && !grant.deliveryAcknowledged) loaded('deliveryKey'); }
        scheduleExpiry(); loaded('grant');
      }, fail));
      current.stops.push(this.db.collection('accounts').doc(grant.ownerId).onSnapshot(doc => {
        if (doc.data()?.deleting) return fail();
        loaded('account');
      }, fail));
      if (grant.serviceId) {
        let watchingOperator = false;
        current.stops.push(this.db.collection('services').doc(grant.serviceId).onSnapshot(doc => {
          const service = doc.data();
          if (!service?.active || service.deleted) return fail();
          if (!watchingOperator) {
            watchingOperator = true;
            current.stops.push(this.db.collection('accounts').doc(service.ownerId).onSnapshot(owner => {
              if (owner.data()?.deleting) return fail();
              loaded('operator');
            }, fail));
          }
          loaded('service');
        }, fail));
        if (!grant.deliveryAcknowledged && !latest.deliveryAcknowledged) {
          stopDelivery = this.db.collection('serviceDeliveryKeys').doc(`${grant.serviceId}_${grant.deliveryKeyId}`).onSnapshot(key => {
            if (!latest.deliveryAcknowledged && (!key.exists || key.data()?.retired)) return fail();
            loaded('deliveryKey');
          }, () => { if (!latest.deliveryAcknowledged) fail(); });
        }
      }
      current.stops.push(this.db.collection('requestEvents').where('grantId', '==', grant.id)
        .orderBy('sequence', 'desc').limit(100).onSnapshot(snapshot => {
          current.events = snapshot.docs.map(d => d.data() as RelayEvent).reverse();
          current.revision++; loaded('events');
          for (const s of current.subscribers) s.changed();
        }, fail));
      void ready.then(() => clearTimeout(startup), () => {});
    }
    const current = feed;
    current.subscribers.add(subscriber);
    let stopped = false;
    let abort: () => void = () => {};
    const stop = () => {
      if (stopped) return; stopped = true;
      signal?.removeEventListener('abort', abort);
      current.subscribers.delete(subscriber);
      if (!current.subscribers.size) {
        for (const unsubscribe of current.stops.splice(0)) unsubscribe();
        if (this.feeds.get(key) === current) this.feeds.delete(key);
      }
    };
    const aborted = new Promise<never>((_resolve, reject) => {
      abort = () => { stop(); reject(Error('stream_closed')); };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
    try { await Promise.race([current.ready, aborted]); ensure(!current.failed, 503, 'event_watch_unavailable'); }
    catch (e) { stop(); throw e; }
    return {
      stop, revision: () => current.revision,
      failed: () => current.failed,
      tail: (sequence: number) => current.events.filter(e => e.sequence > sequence && this.forms.retained(e.purgeAt)).map(publicEvent),
      oldest: () => current.events[0]?.sequence,
    };
  }
}
