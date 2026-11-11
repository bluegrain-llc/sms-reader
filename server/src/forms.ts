import { telemetry, category } from './telemetry.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { Transaction } from 'firebase-admin/firestore';
import { z } from 'zod';
import type { Relay } from './relay.js';
import { Account, hasCapability, bump, ensure, Grant, hash, HISTORY, MINUTE } from './model.js';
import { DAY, FormRequest, formSchema, formView, observationSchema, RelayEvent, Submission, submissionSchema, validateSubmission, webhookSchema } from './forms-model.js';
import { sendWebhook, validateDestination } from './webhooks.js';

type Hook = { id: string; url: string; secret: string; events: RelayEvent['type'][] };
type FormGrant = Grant & { formsApproved?: boolean; formsCancellationPending?: boolean; eventSequence?: number; webhooks?: Hook[] };
type Job = { id: string; ownerId: string; grantId: string; requestId: string; eventId: string; kind: 'push' | 'webhook'; deviceId?: string; hookId?: string; nextAt: number; lease: string | null; attempts: number; purgeAt: Date };
export const publicEvent = ({ ownerId: _o, grantId: _g, purgeAt: _p, ...event }: RelayEvent) => event;
const canonical = (v: unknown): string => JSON.stringify(v, (_key, value) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.keys(value).sort().map(k => [k, value[k]])) : value);
const requiresSms = (definition: FormRequest['definition']) => definition.fields.some(f => 'input' in f && f.input === 'sms_code');
const allowed = (g: FormGrant, definition: FormRequest['definition']) => hasCapability(g, 'forms') && (!requiresSms(definition) || hasCapability(g, 'sms'));
export class Forms {
  constructor(readonly relay: Relay, readonly wake: () => Promise<void> = async () => {}, readonly callback = sendWebhook) {}
  get db() { return this.relay.db; }
  now() { return this.relay.now(); }
  ref(c: string, id: string) { return this.relay.ref(c, id); }
  retained(value: Date) {
    return ((value as unknown as { toMillis?: () => number }).toMillis?.() ?? new Date(value).getTime()) > this.now();
  }
  async kick() { try { await this.wake(); } catch (error) { telemetry.emit({ event: 'wakeup_failed', category: category(error) }); } }
  async agent(tx: Transaction, secret: string) {
    const { grant, account } = await this.relay.agent(tx, secret);
    ensure(hasCapability(grant as FormGrant, 'forms'), 403, 'forms_approval_required'); return { grant: grant as FormGrant, account };
  }
  async approve(uid: string, id: string, approved: boolean) {
    if (!approved) {
      await this.db.runTransaction(async tx => {
        await this.relay.account(tx, uid);
        const g = (await tx.get(this.ref('grants', id))).data();
        ensure(g?.ownerId === uid, 404, 'grant_not_found');
      });
      await this.relay.recordSecurity({ ownerId: uid, kind: 'forms.deny', target: id });
    }
    await this.db.runTransaction(async tx => {
      await this.relay.account(tx, uid);
      const g = (await tx.get(this.ref('grants', id))).data() as FormGrant | undefined;
      ensure(g && g.ownerId === uid && await this.relay.validGrant(tx, g), 404, 'grant_not_found');
      ensure(!g.capabilities, 409, 'use_v3_connection_management');
      tx.update(this.ref('grants', id), { formsApproved: approved, formsCancellationPending: !approved });
    });
    if (!approved) await this.cancelGrant(id);
  }
  async context(tx: Transaction, id: string, auth: { secret: string } | { uid: string; deviceId: string }) {
    let g: FormGrant, device;
    let account: Account;
    if ('secret' in auth) {
      const identity = await this.agent(tx, auth.secret); g = identity.grant; account = identity.account;
    } else {
      account = await this.relay.account(tx, auth.uid); device = await this.relay.device(tx, auth.uid, auth.deviceId);
    }
    const r = (await tx.get(this.ref('formRequests', id))).data() as FormRequest | undefined;
    ensure(r && ('secret' in auth ? r.grantId === g!.id && r.ownerId === g!.ownerId : r.ownerId === auth.uid), 404, 'request_not_found');
    ensure(!r.definition.steps || !device || device.wizardVersion === 1, 409, 'wizard_app_update_required');
    ensure(this.retained(r.purgeAt), 404, 'request_not_found');
    if (!('secret' in auth)) g = (await tx.get(this.ref('grants', r.grantId))).data() as FormGrant;
    ensure(g!, 409, 'grant_unavailable');
    if ('secret' in auth) ensure(!requiresSms(r.definition) || hasCapability(g!, 'sms'), 403, 'sms_approval_required');
    const valid = !!g! && allowed(g!, r.definition) && await this.relay.validGrant(tx, g!);
    return { r, g: g!, device, valid, account };
  }
  event(tx: Transaction, r: FormRequest, g: FormGrant, type: RelayEvent['type'], extra: { deviceId?: string; fieldId?: string; observedAt?: number } = {}) {
    const sequence = (g.eventSequence ?? 0) + 1; g.eventSequence = sequence; r.sequence++;
    const id = `${g.id}_${String(sequence).padStart(16, '0')}`;
    const event: RelayEvent = { id, type, requestId: r.id, sequence, requestSequence: r.sequence,
      ownerId: r.ownerId, grantId: g.id, at: this.now(), ...extra, purgeAt: r.purgeAt };
    tx.create(this.ref('requestEvents', id), event);
    tx.update(this.ref('grants', g.id), { eventSequence: sequence });
    for (const hook of g.webhooks ?? []) if (hook.events.includes(type)) this.job(tx, r, id, 'webhook', hook.id);
    tx.set(this.ref('formRequests', r.id), r);
    return event;
  }
  job(tx: Transaction, r: FormRequest, eventId: string, kind: Job['kind'], target: string) {
    const id = hash(`${eventId}:${kind}:${target}`);
    tx.create(this.ref('deliveryOutbox', id), { id, requestId: r.id, ownerId: r.ownerId, grantId: r.grantId, eventId, kind,
      ...(kind === 'push' ? { deviceId: target } : { hookId: target }), nextAt: this.now(), lease: null, attempts: 0, purgeAt: r.purgeAt } satisfies Job);
  }
  async end(tx: Transaction, r: FormRequest, g: FormGrant, status: Exclude<FormRequest['status'], 'pending'>, terminatedAt = this.now()) {
    const [events, jobs] = await Promise.all([tx.get(this.db.collection('requestEvents').where('requestId', '==', r.id)), tx.get(this.db.collection('deliveryOutbox').where('requestId', '==', r.id))]);
    r.status = status; r.terminatedAt = terminatedAt; r.purgeAt = new Date(terminatedAt + HISTORY);
    for (const doc of [...events.docs, ...jobs.docs]) tx.update(doc.ref, { purgeAt: r.purgeAt });
    this.event(tx, r, g, `request.${status}`);
  }
  async expire(tx: Transaction, r: FormRequest, g: FormGrant, valid: boolean) {
    if (r.status === 'pending' && (!valid || r.expiresAt <= this.now())) await this.end(tx, r, g, valid ? 'expired' : 'cancelled', valid ? r.expiresAt : this.now());
  }
  async create(secret: string, raw: z.input<typeof formSchema>) {
    const definition = formSchema.parse(raw);
    const output = await this.db.runTransaction(async tx => {
      const { grant: g, account } = await this.agent(tx, secret);
      ensure(!requiresSms(definition) || hasCapability(g, 'sms'), 403, 'sms_approval_required');
      const id = hash(`v2:${g.id}:${definition.idempotencyKey}`), fingerprint = hash(canonical(definition));
      const old = (await tx.get(this.ref('formRequests', id))).data() as FormRequest | undefined;
      if (old) { ensure(this.retained(old.purgeAt), 410, 'request_retention_ended'); ensure(old.fingerprint === fingerprint, 409, 'idempotency_conflict'); await this.expire(tx, old, g, true); return formView(old); }
      const devices = (await this.relay.devices(tx, g.ownerId)).filter(d => !definition.steps || d.wizardVersion === 1);
      const pending = await tx.get(this.db.collection('formRequests').where('ownerId', '==', g.ownerId).where('status', '==', 'pending').limit(101));
      ensure(devices.length, 409, definition.steps ? 'wizard_devices_unavailable' : 'devices_unavailable'); ensure(pending.size < 100, 429, 'inbox_full');
      const rate = bump(g.formRate ?? { start: this.now(), count: 0 }, this.now(), 30), ownerRate = bump(account.formRate ?? { start: this.now(), count: 0 }, this.now(), 100);
      const r: FormRequest = { id, grantId: g.id, ownerId: g.ownerId, callerName: g.callerName, definition, fingerprint, status: 'pending',
        createdAt: this.now(), expiresAt: this.now() + definition.expiresInSeconds * 1000, nextCheckAt: Math.min(g.expiresAt, this.now() + definition.expiresInSeconds * 1000), terminatedAt: null, resultExpiresAt: null,
        sequence: 0, firstOpenedAt: null, taps: {}, opens: {}, helpers: {}, purgeAt: new Date(this.now() + definition.expiresInSeconds * 1000 + HISTORY) };
      const e = this.event(tx, r, g, 'request.created');
      for (const device of devices) this.job(tx, r, e.id, 'push', device.id);
      tx.update(this.ref('grants', g.id), { formRate: rate }); tx.set(this.ref('accounts', g.ownerId), { formRate: ownerRate }, { merge: true });
      return formView(r);
    });
    await this.kick(); return output;
  }
  async get(auth: { secret: string } | { uid: string; deviceId: string }, id: string) {
    return this.db.runTransaction(async tx => { const { r, g, valid } = await this.context(tx, id, auth); await this.expire(tx, r, g, valid); return formView(r); });
  }
  async inbox(uid: string, deviceId: string) {
    const ids = await this.db.runTransaction(async tx => {
      await this.relay.account(tx, uid); const device = await this.relay.device(tx, uid, deviceId);
      return (await tx.get(this.db.collection('formRequests').where('ownerId', '==', uid).where('status', '==', 'pending').limit(100))).docs
        .filter(d => !d.data().definition.steps || device.wizardVersion === 1).map(d => d.id);
    });
    return (await Promise.all(ids.map(id => this.get({ uid, deviceId }, id)))).filter(r => r.status === 'pending')
      .sort((a, b) => b.createdAt - a.createdAt).map(r => ({ requestId: r.requestId, callerName: r.callerName, title: r.title, status: r.status, expiresAt: r.expiresAt, createdAt: r.createdAt }));
  }
  async cancel(secret: string, id: string) {
    const result = await this.db.runTransaction(async tx => {
      const { r, g } = await this.context(tx, id, { secret }); await this.expire(tx, r, g, true);
      if (r.status === 'pending') await this.end(tx, r, g, 'cancelled'); return formView(r);
    }); await this.kick(); return result;
  }
  async observe(uid: string, deviceId: string, id: string, input: z.infer<typeof observationSchema>) {
    const data = observationSchema.parse(input);
    const result = await this.db.runTransaction(async tx => {
      const { r, g, device, valid, account } = await this.context(tx, id, { uid, deviceId });
      const devices = data.type === 'input.ready' ? await this.relay.devices(tx, uid) : [];
      await this.expire(tx, r, g, valid);
      if (data.type === 'input.ready') {
        if (r.status !== 'pending') return formView(r);
        ensure(!device!.paused, 409, 'device_paused');
        const field = r.definition.fields.find(f => f.id === data.fieldId);
        ensure(field && 'input' in field && field.input === 'sms_code', 400, 'unknown_input');
        const old = r.helpers[deviceId];
        if (old) { ensure(old.startedAt === data.listenerStartedAt, 409, 'input_already_started'); return formView(r); }
        ensure(data.listenerStartedAt <= this.now() + 5000 && data.listenerStartedAt > this.now() - MINUTE, 409, 'listener_start_stale');
        const held = (account.formListenerUntil ?? 0) > this.now();
        ensure(!account.activeRequestId && (held ? account.formListenerRequestId === r.id : !(account.queueIds?.length) && devices.every(d => (d.listenerUntil ?? 0) <= this.now())), 409, 'sms_listener_busy');
        ensure((device!.listenerUntil ?? 0) <= this.now(), 409, 'sms_listener_busy');
        // Form expiry cannot cancel Android's five-minute platform listener.
        const until = Math.min(data.listenerStartedAt + 5 * MINUTE, this.now() + 5 * MINUTE);
        r.helpers[deviceId] = { fieldId: data.fieldId, readyAt: this.now(), startedAt: data.listenerStartedAt, until };
        tx.update(this.ref('devices', deviceId), { listenerUntil: until, formListenerUntil: until });
        tx.set(this.ref('accounts', uid), { formListenerRequestId: r.id, formListenerUntil: Math.max(account.formListenerUntil ?? 0, until) }, { merge: true });
        r.helperNextAt = Math.min(r.helperNextAt ?? until, until);
        this.event(tx, r, g, data.type, { deviceId, fieldId: data.fieldId });
      } else {
        const reports = data.type === 'notification.tapped' ? r.taps : r.opens;
        if (reports[deviceId] !== undefined) return formView(r);
        // Phone clocks can drift; preserve offline times within the request's lifetime.
        const observedAt = Math.max(r.createdAt, Math.min(data.occurredAt ?? this.now(), this.now()));
        reports[deviceId] = observedAt;
        if (data.type === 'request.opened') r.firstOpenedAt = Math.min(r.firstOpenedAt ?? observedAt, observedAt);
        this.event(tx, r, g, data.type, { deviceId, observedAt });
      }
      return formView(r);
    }); await this.kick(); return result;
  }
  async submit(uid: string, deviceId: string, id: string, raw: Submission) {
    const input = submissionSchema.parse(raw), fingerprint = hash(canonical(input));
    const output = await this.db.runTransaction(async tx => {
      const { r, g, device, valid } = await this.context(tx, id, { uid, deviceId });
      await this.expire(tx, r, g, valid);
      if (r.winner?.deviceId === deviceId && r.winner.submissionId === input.submissionId) {
        ensure(r.winner.fingerprint === fingerprint, 409, 'submission_conflict'); return formView(r);
      }
      // Return a competing phone's accepted outcome; never overwrite its answers.
      if (r.status !== 'pending') return formView(r);
      ensure(!device!.paused, 409, 'device_paused');
      const status = validateSubmission(r.definition, input);
      r.winner = { deviceId, submissionId: input.submissionId, fingerprint };
      let result: Record<string, unknown> | undefined;
      if (status === 'submitted') {
        r.resultExpiresAt = this.now() + DAY;
        result = { ownerId: uid, grantId: g.id, action: input.action, values: input.values,
          submittedAt: this.now(), expiresAt: r.resultExpiresAt, purgeAt: new Date(r.resultExpiresAt) };
      }
      await this.end(tx, r, g, status);
      if (result) tx.create(this.ref('formResults', id), result);
      return formView(r);
    }); await this.kick(); return output;
  }
  async result(secret: string, id: string) {
    return this.db.runTransaction(async tx => {
      const { r, g } = await this.context(tx, id, { secret });
      const result = (await tx.get(this.ref('formResults', id))).data(); await this.expire(tx, r, g, true);
      return { requestId: id, status: r.status, result: r.status === 'submitted' && result && result.expiresAt > this.now() ? { action: result.action, values: result.values, submittedAt: result.submittedAt } : null };
    });
  }
  async events(secret: string, cursor?: string) {
    const { grant: g } = await this.db.runTransaction(tx => this.agent(tx, secret));
    let sequence = 0;
    if (cursor) { ensure(new RegExp(`^${g.id}_[0-9]{16}$`).test(cursor), 400, 'invalid_cursor'); sequence = Number(cursor.slice(-16)); ensure(sequence <= (g.eventSequence ?? 0), 400, 'invalid_cursor'); }
    const snap = await this.db.collection('requestEvents').where('grantId', '==', g.id).where('sequence', '>', sequence).where('purgeAt', '>', new Date(this.now())).orderBy('sequence').orderBy('purgeAt').limit(100).get();
    const events = snap.docs.map(d => publicEvent(d.data() as RelayEvent));
    return { events, cursor: events.at(-1)?.id ?? cursor ?? null };
  }
  async registerWebhook(secret: string, raw: z.infer<typeof webhookSchema>) {
    const input = webhookSchema.parse(raw);
    await this.db.runTransaction(tx => this.agent(tx, secret));
    await validateDestination(input.url);
    const hook: Hook = { id: randomUUID(), ...input, secret: randomBytes(32).toString('base64url') };
    await this.db.runTransaction(async tx => { const { grant: g } = await this.agent(tx, secret);
      ensure((g.webhooks ?? []).length < 5, 409, 'webhook_limit'); tx.update(this.ref('grants', g.id), { webhooks: [...g.webhooks ?? [], hook] }); });
    return hook;
  }
  async webhooks(secret: string, remove?: string) {
    if (remove) {
      const { grant } = await this.db.runTransaction(tx => this.agent(tx, secret));
      await this.relay.recordSecurity({ ownerId: grant.ownerId, kind: 'webhook.delete', target: remove, grantId: grant.id });
    }
    return this.db.runTransaction(async tx => { const { grant: g } = await this.agent(tx, secret);
      if (remove) tx.update(this.ref('grants', g.id), { webhooks: (g.webhooks ?? []).filter(h => h.id !== remove) });
      return (g.webhooks ?? []).filter(h => h.id !== remove).map(({ secret: _secret, ...h }) => h);
    });
  }
  async deliver(id: string) {
    const lease = randomUUID();
    const claim = await this.db.runTransaction(async tx => {
      const j = (await tx.get(this.ref('deliveryOutbox', id))).data() as Job | undefined;
      if (!j || j.nextAt > this.now()) return null;
      const g = (await tx.get(this.ref('grants', j.grantId))).data() as FormGrant | undefined;
      const r = (await tx.get(this.ref('formRequests', j.requestId))).data() as FormRequest | undefined;
      const account = (await tx.get(this.ref('accounts', j.ownerId))).data();
      const e = (await tx.get(this.ref('requestEvents', j.eventId))).data() as RelayEvent | undefined;
      const d = j.deviceId ? (await tx.get(this.ref('devices', j.deviceId))).data() : null;
      const hook = g?.webhooks?.find(h => h.id === j.hookId);
      if (!r || !e || !this.retained(j.purgeAt) || account?.deleting || !(g && allowed(g, r.definition)) || !await this.relay.validGrant(tx, g) || (j.kind === 'push' && (r.status !== 'pending' || r.expiresAt <= this.now() || !d || d.deleted || d.paused || d.ownerId !== j.ownerId || (r.definition.steps && d.wizardVersion !== 1))) || (j.kind === 'webhook' && !hook)) {
        tx.delete(this.ref('deliveryOutbox', id)); return null;
      }
      tx.update(this.ref('deliveryOutbox', id), { lease, nextAt: this.now() + MINUTE, attempts: j.attempts + 1 });
      return { j, r, e, token: d?.fcmToken as string | undefined, hook };
    });
    if (!claim) return;
    let sent = false;
    try {
      if (claim.j.kind === 'push') await this.relay.notify(claim.token!, claim.r.id, claim.r.expiresAt - this.now(), 'form');
      else await this.callback(claim.hook!.url, claim.hook!.secret, publicEvent(claim.e));
      sent = true;
    } catch (error) { telemetry.delivery(claim.j.kind === 'push' ? 'form' : 'webhook', claim.r.createdAt, 'failed', error); }
    if (sent) telemetry.delivery(claim.j.kind === 'push' ? 'form' : 'webhook', claim.r.createdAt, 'accepted');
    await this.db.runTransaction(async tx => {
      const j = (await tx.get(this.ref('deliveryOutbox', id))).data() as Job | undefined;
      if (!j || j.lease !== lease) return;
      const r = (await tx.get(this.ref('formRequests', j.requestId))).data() as FormRequest | undefined;
      const g = (await tx.get(this.ref('grants', j.grantId))).data() as FormGrant | undefined;
      if (sent) {
        tx.delete(this.ref('deliveryOutbox', id));
        if (j.kind === 'push' && r && g) this.event(tx, r, g, 'notification.accepted', { deviceId: j.deviceId! });
      } else tx.update(this.ref('deliveryOutbox', id), { lease: null, nextAt: this.now() + Math.min(60 * MINUTE, 1000 * 2 ** Math.min(j.attempts + 1, 12)) });
    });
    if (sent && claim.j.kind === 'push') await this.kick();
  }
  async cancelGrant(grantId: string) {
    const snap = await this.db.collection('formRequests').where('grantId', '==', grantId).where('status', '==', 'pending').get();
    for (const doc of snap.docs) await this.db.runTransaction(async tx => {
      const r = (await tx.get(doc.ref)).data() as FormRequest;
      const g = (await tx.get(this.ref('grants', grantId))).data() as FormGrant;
      if (r?.status === 'pending' && g && (!allowed(g, r.definition) || !await this.relay.validGrant(tx, g))) await this.end(tx, r, g, 'cancelled');
    });
    await this.db.runTransaction(async tx => {
      const g = (await tx.get(this.ref('grants', grantId))).data() as FormGrant | undefined;
      if (g?.formsCancellationPending) tx.update(this.ref('grants', grantId), { formsCancellationPending: false });
    });
    if (!snap.empty) await this.kick();
  }
  async dispatch() {
    const count = await this.relay.pages.run('form-delivery', this.db.collection('deliveryOutbox').where('nextAt', '<=', this.now()),
      'nextAt', 50, id => this.deliver(id), 10);
    if (count === 50) await this.kick();
  }
  async maintenance() {
    await this.relay.pages.run('revoked-forms', this.db.collection('grants').where('formsCancellationPending', '==', true),
      null, 250, id => this.cancelGrant(id));
    await this.relay.pages.run('helper-timeouts', this.db.collection('formRequests').where('status', '==', 'pending').where('helperNextAt', '<=', this.now()),
      'helperNextAt', 250, id => this.db.runTransaction(async tx => {
      const ref = this.ref('formRequests', id), r = (await tx.get(ref)).data() as FormRequest | undefined;
      if (!r) return;
      const g = (await tx.get(this.ref('grants', r.grantId))).data() as FormGrant;
      if (!g || r.status !== 'pending') return;
      for (const [deviceId, helper] of Object.entries(r.helpers)) if (helper.until <= this.now() && !helper.timedOut) {
        helper.timedOut = true; this.event(tx, r, g, 'input.timeout', { deviceId, fieldId: helper.fieldId });
      }
      tx.update(ref, { helperNextAt: Math.min(...Object.values(r.helpers).filter(h => !h.timedOut).map(h => h.until), Number.MAX_SAFE_INTEGER) });
    }));
    await this.relay.pages.run('form-expiry', this.db.collection('formRequests').where('status', '==', 'pending').where('nextCheckAt', '<=', this.now()),
      'nextCheckAt', 250, id => this.db.runTransaction(async tx => {
      const r = (await tx.get(this.ref('formRequests', id))).data() as FormRequest | undefined;
      if (!r) return;
      const g = (await tx.get(this.ref('grants', r.grantId))).data() as FormGrant;
      if (r.status === 'pending' && g) await this.expire(tx, r, g, allowed(g, r.definition) && await this.relay.validGrant(tx, g));
    }));
    await this.dispatch();
    for (const collection of ['formResults', 'formRequests', 'requestEvents', 'deliveryOutbox']) await this.relay.pages.purge(collection, this.now());
  }
}
