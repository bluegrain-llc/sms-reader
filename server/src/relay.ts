import { dueSmsQueries } from './delivery-queries.js';
import { telemetry } from './telemetry.js';
import { randomUUID } from 'node:crypto';
import { MaintenancePages } from './maintenance-pages.js';
import type { RecordSecurity } from './security-ledger.js';
import { Deletions } from './deletions.js';
import { Access } from './access.js';
import { Forms } from './forms.js';
import { Connections } from './connections.js';
import { Firestore, Transaction } from 'firebase-admin/firestore';
import { active, Account, bump, CodeRequest, codeSchema, deadline, Device, ensure, Grant, hash, HISTORY, MINUTE, newSecret, PhoneState, RequestInput, requestSchema, Status, view } from './model.js';

export type Notify = (token: string, requestId: string, ttl: number, kind?: 'form') => Promise<void>;
type Context = { request: CodeRequest; account: Account; devices: Device[]; device?: Device; grant: Grant; valid: boolean };
const phonePending = (): PhoneState => ({ status: 'pending_phone', reason: null, listeningDeadline: null, sent: false, lease: 0, attempts: 0, nextAt: 0 });
export class Relay {
  readonly connections: Connections;
  readonly forms: Forms;
  readonly pages: MaintenancePages;
  readonly deletions: Deletions;
  readonly access: Access;
  constructor(readonly db: Firestore, readonly notify: Notify, readonly now = Date.now, wake?: () => Promise<void>, readonly recordSecurity: RecordSecurity = async () => {}) {
    this.pages = new MaintenancePages(db); this.connections = new Connections(this); this.forms = new Forms(this, wake);
    this.deletions = new Deletions(db, now, wake ?? (async () => {}), recordSecurity); this.access = new Access(db, now);
  }
  ref(collection: string, id: string) { return this.db.collection(collection).doc(id); }
  async account(tx: Transaction, uid: string): Promise<Account> {
    const a = (await tx.get(this.ref('accounts', uid))).data() as Account | undefined;
    ensure(!a?.deleting, 403, 'account_deleted'); return a ?? {};
  }
  async device(tx: Transaction, uid: string, id: string) {
    const d = (await tx.get(this.ref('devices', id))).data() as Device | undefined;
    ensure(d && d.ownerId === uid && !d.deleted, 404, 'device_not_found'); return d;
  }
  async devices(tx: Transaction, uid: string) {
    return (await tx.get(this.db.collection('devices').where('ownerId', '==', uid))).docs.map(x => x.data() as Device).filter(d => !d.deleted && !d.paused);
  }
  async validGrant(tx: Transaction, g?: Grant) {
    if (!g || g.revoked || g.expiresAt <= this.now()) return false;
    // Retired manager-issued credentials cannot bypass direct owner approval.
    return !g.managerId;
  }

  async agent(tx: Transaction, secret: string) {
    ensure(/^smsr_[A-Za-z0-9_-]{43}$/.test(secret), 401, 'invalid_token');
    const g = (await tx.get(this.ref('grants', hash(secret)))).data() as Grant | undefined;
    ensure(g && await this.validGrant(tx, g), 401, 'invalid_token');
    return { grant: g, account: await this.account(tx, g.ownerId) };
  }
  async checkAgent(secret: string) { await this.db.runTransaction(tx => this.agent(tx, secret)); }
  audit(tx: Transaction, r: CodeRequest, status: Status) {
    tx.set(this.ref('audit', randomUUID()), { ownerId: r.ownerId, deviceId: r.deviceId,
      requestId: r.id, status, at: this.now(), purgeAt: new Date(this.now() + HISTORY) });
  }
  ids(r: CodeRequest) { return r.deviceIds ?? [r.deviceId]; }
  phones(r: CodeRequest) {
    return r.phones ?? Object.fromEntries(this.ids(r).map(id => [id, { ...phonePending(), status: r.status,
      listeningDeadline: r.listeningDeadline, sent: r.notificationSent, lease: 0, nextAt: 0 }]));
  }
  finish(tx: Transaction, r: CodeRequest, a: Account, status: Status, reason: string | null) {
    r.status = status; r.reason = reason;
    tx.set(this.ref('requests', r.id), r);
    if (a.activeRequestId === r.id) tx.set(this.ref('accounts', r.ownerId), {
      activeRequestId: null, hasWork: !!a.queueIds?.length,
    }, { merge: true });
    if (status !== 'completed') tx.delete(this.ref('results', r.id));
    this.audit(tx, r, status);
  }
  expire(tx: Transaction, r: CodeRequest, a: Account, valid: boolean, devices: Device[]) {
    if (active(r.status) && (deadline(r) <= this.now() || !valid || !(r.status === 'queued' ? devices.length : devices.some(d => this.ids(r).includes(d.id))))) {
      this.finish(tx, r, a, 'expired', deadline(r) <= this.now() ? 'request_timeout' : 'grant_or_device_unavailable');
    } else if (r.status === 'completed' && (r.resultExpiresAt ?? 0) <= this.now()) this.finish(tx, r, a, 'expired', 'result_expired');
    return r;
  }
  async register(uid: string, id: string, name: string, fcmToken: string, wizardVersion?: 1) {
    return this.db.runTransaction(async tx => {
      await this.account(tx, uid);
      const old = (await tx.get(this.ref('devices', id))).data() as Device | undefined;
      const registered = await tx.get(this.db.collection('devices').where('ownerId', '==', uid));
      ensure(!old || (old.ownerId === uid && !old.deleted), 409, 'installation_id_unavailable');
      ensure(old || registered.docs.filter(d => !d.data().deleted).length < 20, 409, 'device_limit_reached');
      const d: Device = old ? { ...old, name, fcmToken, updatedAt: this.now() } : {
        id, ownerId: uid, name, fcmToken, paused: false, deleted: false, activeRequestId: null,
        rate: { start: this.now(), count: 0 }, updatedAt: this.now(),
      };
      d.wizardVersion = wizardVersion ?? null;
      tx.set(this.ref('devices', id), d);
      return { deviceId: id, name, paused: d.paused, activeRequestId: null };
    });
  }
  async createGrant(uid: string, deviceId: string, callerName: string, days: number) {
    const token = newSecret(), id = hash(token);
    await this.db.runTransaction(async tx => {
      await this.account(tx, uid);
      if (deviceId) await this.device(tx, uid, deviceId);
      tx.create(this.ref('grants', id), { id, ownerId: uid, deviceId, callerName, revoked: false,
        createdAt: this.now(), expiresAt: this.now() + days * 24 * 60 * MINUTE,
        rate: { start: this.now(), count: 0 } } satisfies Grant);
    });
    return { grantId: id, token };
  }
  async listDevices(uid: string) {
    await this.db.runTransaction(tx => this.account(tx, uid));
    const [snap, account] = await Promise.all([this.db.collection('devices').where('ownerId', '==', uid).get(), this.ref('accounts', uid).get()]);
    const id = account.data()?.activeRequestId as string | undefined;
    const r = id ? (await this.ref('requests', id).get()).data() as CodeRequest | undefined : undefined;
    return snap.docs.map(s => s.data() as Device).filter(d => !d.deleted).map(d => ({
      deviceId: d.id, name: d.name, paused: d.paused, wizardVersion: d.wizardVersion ?? null,
      activeRequestId: r && active(r.status) && !d.paused && this.ids(r).includes(d.id) && active(this.phones(r)[d.id]?.status ?? 'failed') ? r.id : null,
    }));
  }
  async listGrants(uid: string, deviceId?: string) {
    await this.db.runTransaction(tx => this.account(tx, uid));
    if (deviceId) await this.db.runTransaction(tx => this.device(tx, uid, deviceId));
    const s = await this.db.collection('grants').where('ownerId', '==', uid).get();
    return s.docs.map(s => { const g = s.data() as Grant;
      return { grantId: g.id, callerName: g.callerName, callerId: g.callerId ?? null,
        formsApproved: !!(g as Grant & { formsApproved?: boolean }).formsApproved, revoked: g.revoked || !!g.managerId, expiresAt: g.expiresAt };
    });
  }

  async revoke(uid: string, id: string) {
    await this.db.runTransaction(async tx => {
      await this.account(tx, uid);
      const g = (await tx.get(this.ref('grants', id))).data();
      ensure(g?.ownerId === uid, 404, 'grant_not_found');
    });
    await this.recordSecurity({ ownerId: uid, kind: 'grant.revoke', target: id });
    await this.db.runTransaction(async tx => {
      const a = await this.account(tx, uid);
      const g = (await tx.get(this.ref('grants', id))).data() as Grant | undefined;
      ensure(g && g.ownerId === uid, 404, 'grant_not_found');
      const r = a.activeRequestId ? (await tx.get(this.ref('requests', a.activeRequestId))).data() as CodeRequest | undefined : undefined;
      tx.update(this.ref('grants', id), { revoked: true, formsCancellationPending: true });
      if (r && r.grantId === id && active(r.status)) this.finish(tx, r, a, 'cancelled', 'token_revoked');
    });
    await this.advance(uid);
    await this.forms.cancelGrant(id);
  }
  async changeDevice(uid: string, id: string, paused: boolean, deleted = false) {
    if (paused || deleted) {
      await this.db.runTransaction(async tx => { await this.account(tx, uid); await this.device(tx, uid, id); });
      await this.recordSecurity({ ownerId: uid, kind: deleted ? 'device.delete' : 'device.pause', target: id });
    }
    await this.db.runTransaction(async tx => {
      const a = await this.account(tx, uid);
      await this.device(tx, uid, id);
      const devices = await this.devices(tx, uid);
      const r = a.activeRequestId ? (await tx.get(this.ref('requests', a.activeRequestId))).data() as CodeRequest | undefined : undefined;
      tx.update(this.ref('devices', id), { paused, deleted, ...(deleted ? { fcmToken: '', name: '', activeRequestId: null } : {}) });
      if (r && active(r.status) && this.ids(r).includes(id) && (paused || deleted)) {
        r.phones = this.phones(r); r.phones[id] = { ...r.phones[id]!, status: 'failed', reason: deleted ? 'device_unregistered' : 'device_paused' };
        if (!devices.some(d => d.id !== id && this.ids(r).includes(d.id))) this.finish(tx, r, a, 'cancelled', 'devices_unavailable');
        else this.aggregate(tx, r, a);
      }
    });
    await this.advance(uid);
  }
  async advance(uid: string) {
    // Each transaction reads before writing; a second iteration can promote after releasing a stale lock.
    for (let i = 0; i < 22; i++) {
      const again = await this.db.runTransaction(async tx => {
        const a = await this.account(tx, uid), queue = a.queueIds ?? [];
        if (a.activeRequestId) {
          const r = (await tx.get(this.ref('requests', a.activeRequestId))).data() as CodeRequest | undefined;
          if (!r || !active(r.status)) { tx.set(this.ref('accounts', uid), { activeRequestId: null, hasWork: !!queue.length }, { merge: true }); return true; }
          const g = (await tx.get(this.ref('grants', r.grantId))).data() as Grant | undefined;
          const valid = await this.validGrant(tx, g), devices = await this.devices(tx, uid);
          this.expire(tx, r, a, valid, devices); return !active(r.status);
        }
        if (!queue.length) { if (a.hasWork) tx.set(this.ref('accounts', uid), { hasWork: false }, { merge: true }); return false; }
        const id = queue[0]!, rest = queue.slice(1);
        const r = (await tx.get(this.ref('requests', id))).data() as CodeRequest | undefined;
        const g = r ? (await tx.get(this.ref('grants', r.grantId))).data() as Grant | undefined : undefined;
        const valid = await this.validGrant(tx, g), devices = await this.devices(tx, uid);
        if (!r || !active(r.status)) { tx.set(this.ref('accounts', uid), { queueIds: rest, hasWork: !!rest.length }, { merge: true }); return true; }
        this.expire(tx, r, a, valid, devices);
        if (!active(r.status)) { tx.set(this.ref('accounts', uid), { queueIds: rest, hasWork: !!rest.length }, { merge: true }); return true; }
        // Android has no listener cancellation API. Do not activate the next caller
        // while every available phone may still be bound to a previous window.
        if ((a.formListenerUntil ?? 0) > this.now() || !devices.some(d => (d.listenerUntil ?? 0) <= this.now())) return false;
        r.status = 'pending_phone'; r.deviceIds = devices.map(d => d.id); r.phones = Object.fromEntries(devices.map(d => [d.id, phonePending()]));
        r.notificationSent = false; r.nextNotificationAt = this.now();
        tx.set(this.ref('requests', id), r); this.audit(tx, r, r.status);
        tx.set(this.ref('accounts', uid), { activeRequestId: id, queueIds: rest, hasWork: true }, { merge: true }); return false;
      });
      if (!again) return;
    }
  }
  async create(secret: string, raw: RequestInput) {
    const input = requestSchema.parse(raw);
    const identity = await this.db.runTransaction(tx => this.agent(tx, secret)); await this.advance(identity.grant.ownerId);
    return this.db.runTransaction(async tx => {
      const { grant: g, account: a } = await this.agent(tx, secret);
      const id = hash(`${g.id}:${input.idempotencyKey}`), fingerprint = hash(JSON.stringify(input.title === undefined ? [input.purpose, input.senderPhone ?? null] : [input.purpose, input.senderPhone ?? null, input.title]));
      const old = (await tx.get(this.ref('requests', id))).data() as CodeRequest | undefined;
      const devices = await this.devices(tx, g.ownerId);
      if (old) { ensure(old.fingerprint === fingerprint, 409, 'idempotency_conflict'); return view(this.expire(tx, old, a, true, devices)); }
      ensure(devices.length, 409, 'devices_unavailable');
      const queue = a.queueIds ?? []; ensure(queue.length < 20, 429, 'queue_full');
      const ownerRate = bump(a.rate ?? { start: this.now(), count: 0 }, this.now(), 5), grantRate = bump(g.rate, this.now(), 3);
      const status = a.activeRequestId || queue.length || (a.formListenerUntil ?? 0) > this.now() || !devices.some(d => (d.listenerUntil ?? 0) <= this.now()) ? 'queued' : 'pending_phone';
      const r: CodeRequest = { id, ownerId: g.ownerId, deviceId: devices[0]!.id, deviceIds: devices.map(d => d.id),
        phones: Object.fromEntries(devices.map(d => [d.id, phonePending()])), grantId: g.id, callerName: g.callerName,
        purpose: input.purpose, title: input.title ?? 'Verification code', senderPhone: input.senderPhone ?? null, fingerprint, status, reason: null,
        createdAt: this.now(), expiresAt: this.now() + 10 * MINUTE, listeningDeadline: null, resultExpiresAt: null,
        notificationSent: false, notificationLease: 0, notificationAttempts: 0, nextNotificationAt: this.now(), purgeAt: new Date(this.now() + HISTORY) };
      tx.create(this.ref('requests', id), r);
      tx.set(this.ref('accounts', g.ownerId), { rate: ownerRate, hasWork: true,
        ...(status === 'queued' ? { queueIds: [...queue, id] } : { activeRequestId: id }) }, { merge: true });
      tx.update(this.ref('grants', g.id), { rate: grantRate }); this.audit(tx, r, status); return view(r);
    });
  }
  async context(tx: Transaction, id: string, auth: { secret: string } | { uid: string; deviceId: string }): Promise<Context> {
    if ('secret' in auth) {
      const { grant: g, account: a } = await this.agent(tx, auth.secret);
      const r = (await tx.get(this.ref('requests', id))).data() as CodeRequest | undefined;
      ensure(r && r.grantId === g.id && r.ownerId === g.ownerId, 404, 'request_not_found');
      return { request: r, account: a, grant: g, valid: true, devices: await this.devices(tx, g.ownerId) };
    }
    const a = await this.account(tx, auth.uid), d = await this.device(tx, auth.uid, auth.deviceId);
    const r = (await tx.get(this.ref('requests', id))).data() as CodeRequest | undefined;
    ensure(r && r.ownerId === auth.uid && this.ids(r).includes(d.id), 404, 'request_not_found');
    const g = (await tx.get(this.ref('grants', r.grantId))).data() as Grant | undefined;
    const valid = await this.validGrant(tx, g); ensure(g && valid, 409, 'grant_unavailable');
    return { request: r, account: a, grant: g, valid, device: d, devices: await this.devices(tx, auth.uid) };
  }
  async get(secret: string, id: string) {
    const output = await this.db.runTransaction(async tx => {
      const c = await this.context(tx, id, { secret }), r = c.request;
      const result = (await tx.get(this.ref('results', id))).data(); this.expire(tx, r, c.account, c.valid, c.devices);
      return { ...view(r), ...(r.status === 'completed' && result && result.expiresAt > this.now() ? { code: result.code as string } : {}) };
    });
    return output;
  }
  phoneView(r: CodeRequest, d: Device) {
    const p = this.phones(r)[d.id];
    return { ...view(r), ...(active(r.status) && r.status !== 'queued' && p ? { status: p.status, reason: p.reason, listeningDeadline: p.listeningDeadline } : {}),
      ...(r.completedByDeviceId && r.completedByDeviceId !== d.id ? { reason: 'handled_on_another_device' } : {}),
      callerName: r.callerName, title: r.title ?? 'Verification code', purpose: r.purpose, senderPhone: r.senderPhone };
  }
  async phoneGet(uid: string, deviceId: string, id: string) {
    return this.db.runTransaction(async tx => {
      const c = await this.context(tx, id, { uid, deviceId }), r = c.request;
      this.expire(tx, r, c.account, c.valid, c.devices); return this.phoneView(r, c.device!);
    });
  }
  aggregate(tx: Transaction, r: CodeRequest, a: Account) {
    const phones = Object.values(this.phones(r)), live = phones.filter(p => active(p.status));
    if (!live.length) {
      const status = phones.some(p => p.status === 'denied') ? 'denied' : phones.every(p => p.status === 'cancelled') ? 'cancelled' : 'failed';
      this.finish(tx, r, a, status, phones.find(p => p.reason)?.reason ?? null); return;
    }
    r.status = live.some(p => p.status === 'awaiting_consent') ? 'awaiting_consent' : live.some(p => p.status === 'ready') ? 'ready' : 'pending_phone';
    const deadlines = live.flatMap(p => p.listeningDeadline ? [p.listeningDeadline] : []);
    r.listeningDeadline = deadlines.length ? Math.max(...deadlines) : null;
    tx.set(this.ref('requests', r.id), r); this.audit(tx, r, r.status);
  }
  async transition(auth: { secret: string } | { uid: string; deviceId: string }, id: string,
    target: Status, reason: string | null = null, code?: string, listenerStartedAt?: number, source: 'android_consent' | 'manual' = 'android_consent') {
    const output = await this.db.runTransaction(async tx => {
      const c = await this.context(tx, id, auth), r = c.request;
      const result = (await tx.get(this.ref('results', id))).data(); this.expire(tx, r, c.account, c.valid, c.devices);
      if (!active(r.status)) {
        if (r.status === 'completed' && target === 'completed' && 'uid' in auth && (r.completedByDeviceId ?? r.deviceId) === auth.deviceId) ensure(result?.code === code, 409, 'upload_conflict');
        return 'uid' in auth ? this.phoneView(r, c.device!) : view(r);
      }
      if ('secret' in auth) {
        ensure(target === 'cancelled', 403, 'agent_cannot_submit'); this.finish(tx, r, c.account, target, reason); return view(r);
      }
      const d = c.device!; ensure(!d.paused && r.status !== 'queued', 409, 'request_not_ready');
      r.phones = this.phones(r); const p = r.phones[d.id]!;
      if (p.status === target) return this.phoneView(r, d);
      if (!active(p.status)) return this.phoneView(r, d);
      if (target === 'ready') {
        ensure(p.status === 'pending_phone', 409, 'invalid_transition');
        ensure((d.formListenerUntil ?? 0) <= this.now(), 409, 'sms_listener_busy');
        const start = listenerStartedAt ?? this.now(); ensure(start <= this.now() + 5_000 && start > this.now() - MINUTE, 409, 'listener_start_stale');
        p.listeningDeadline = Math.min(r.expiresAt, start + 5 * MINUTE, this.now() + 5 * MINUTE);
        tx.update(this.ref('devices', d.id), { listenerUntil: p.listeningDeadline });
      } else if (target === 'awaiting_consent') ensure(p.status === 'ready' && (p.listeningDeadline ?? 0) > this.now(), 409, 'invalid_transition');
      else if (target === 'completed') {
        ensure((p.status === 'awaiting_consent' || (source === 'manual' && p.status === 'ready')) && (p.listeningDeadline ?? 0) > this.now(), 409, 'invalid_transition'); codeSchema.parse(code);
        r.submissionSource = source;
        r.resultExpiresAt = this.now() + 2 * MINUTE; r.completedByDeviceId = d.id; r.deviceId = d.id;
        tx.create(this.ref('results', id), { code, ownerId: r.ownerId, deviceId: d.id, grantId: r.grantId,
          expiresAt: r.resultExpiresAt, purgeAt: new Date(r.resultExpiresAt) });
        this.finish(tx, r, c.account, 'completed', null); return this.phoneView(r, d);
      } else ensure(['denied', 'cancelled', 'failed'].includes(target), 409, 'invalid_transition');
      p.status = target; p.reason = reason; this.aggregate(tx, r, c.account); return this.phoneView(r, d);
    });
    if (!active(output.status as Status)) {
      const owner = 'uid' in auth ? auth.uid : (await this.db.runTransaction(tx => this.agent(tx, auth.secret))).grant.ownerId;
      await this.advance(owner);
    }
    return output;
  }
  async history(uid: string, deviceId?: string) {
    await this.db.runTransaction(async tx => { await this.account(tx, uid); if (deviceId) await this.device(tx, uid, deviceId); });
    const s = await this.db.collection('requests').where('ownerId', '==', uid).orderBy('createdAt', 'desc').limit(30).get();
    return s.docs.map(s => s.data() as CodeRequest).filter(r => r.createdAt + HISTORY > this.now())
      .map(r => ({ ...view(r), callerName: r.callerName, createdAt: r.createdAt }));
  }
  async deliver(id: string) {
    const claimed = await this.db.runTransaction(async tx => {
      const r = (await tx.get(this.ref('requests', id))).data() as CodeRequest | undefined;
      if (!r || !active(r.status) || r.status === 'queued' || r.notificationSent || r.nextNotificationAt > this.now()) return [];
      const g = (await tx.get(this.ref('grants', r.grantId))).data() as Grant | undefined;
      const a = (await tx.get(this.ref('accounts', r.ownerId))).data() as Account | undefined;
      if (a?.deleting) {
        tx.update(this.ref('requests', id), { status: 'cancelled', reason: 'account_deleted', notificationSent: true });
        return [];
      }
      const valid = await this.validGrant(tx, g), devices = await this.devices(tx, r.ownerId);
      this.expire(tx, r, a ?? {}, valid, devices); if (!active(r.status)) return [];
      r.phones = this.phones(r); const plans: { deviceId: string; token: string; lease: number; attempts: number; ttl: number; createdAt: number }[] = [];
      for (const [deviceId, p] of Object.entries(r.phones)) {
        const d = devices.find(d => d.id === deviceId);
        if (!d || !active(p.status)) { p.sent = true; continue; }
        if (p.sent || p.lease > this.now() || p.nextAt > this.now()) continue;
        p.lease = this.now() + MINUTE; p.attempts++;
        plans.push({ deviceId, token: d.fcmToken, lease: p.lease, attempts: p.attempts, ttl: r.expiresAt - this.now(), createdAt: r.createdAt });
      }
      this.deliverySummary(r); tx.set(this.ref('requests', id), r); return plans;
    });
    await Promise.all(claimed.map(async claim => {
      let sent = false;
      try { await this.notify(claim.token, id, claim.ttl); sent = true; }
      catch (error) { telemetry.delivery('sms', claim.createdAt, 'failed', error); }
      if (sent) telemetry.delivery('sms', claim.createdAt, 'accepted');
      await this.db.runTransaction(async tx => {
        const r = (await tx.get(this.ref('requests', id))).data() as CodeRequest | undefined;
        if (!r?.phones || !active(r.status)) return;
        const p = r.phones[claim.deviceId]; if (!p || p.lease !== claim.lease) return;
        p.sent = sent; p.lease = 0; p.nextAt = this.now() + Math.min(5 * MINUTE, 2 ** Math.min(claim.attempts, 10) * 1_000);
        this.deliverySummary(r); tx.set(this.ref('requests', id), r);
      });
    }));
  }
  deliverySummary(r: CodeRequest) {
    const unsent = Object.values(r.phones ?? {}).filter(p => !p.sent);
    r.notificationSent = !unsent.length;
    r.nextNotificationAt = unsent.length ? Math.min(...unsent.map(p => Math.max(p.nextAt, p.lease))) : r.expiresAt;
  }
  async maintenance() {
    await this.pages.run('active-owners', this.db.collection('accounts').where('hasWork', '==', true), null, 250, async id => {
      if (!(await this.ref('accounts', id).get()).data()?.deleting) await this.advance(id);
    });
    for (const [index, query] of dueSmsQueries(this.db, this.now(), false).entries()) {
      await this.pages.run(`sms-${index}`, query, 'nextNotificationAt', 250, id => this.deliver(id), 10);
    }
    for (const collection of ['results', 'requests', 'audit', 'connections', 'connectionCodes', 'connectionRates']) await this.pages.purge(collection, this.now());
    await this.forms.maintenance();
    await this.access.cleanup();
  }
}
