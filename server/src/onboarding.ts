import { randomBytes, randomUUID } from 'node:crypto';
import { CompactEncrypt, importJWK } from 'jose';
import { Transaction } from 'firebase-admin/firestore';
import { z } from 'zod';
import { cleanupOAuth } from './oauth-cleanup.js';
import type { Relay } from './relay.js';
import { bump, Device, ensure, Grant, hash, HISTORY, MINUTE, newSecret } from './model.js';

// A numeric expiry that legacy JavaScript Date clients can still represent.
export const FOREVER = 8_640_000_000_000_000;
export const capabilitiesSchema = z.array(z.enum(['forms', 'sms'])).min(1).max(2).refine(a => new Set(a).size === a.length);
export const publicKeySchema = z.object({ kty: z.literal('EC'), crv: z.literal('P-256'),
  x: z.string().regex(/^[A-Za-z0-9_-]{43}$/), y: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
export const serviceSchema = z.object({ name: z.string().trim().min(1).max(80), purpose: z.string().trim().min(1).max(240),
  capabilities: capabilitiesSchema.default(['forms']), deliveryPublicKey: publicKeySchema,
  credentialHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const pairingSchema = z.object({ capabilities: capabilitiesSchema, expiresInDays: z.number().int().min(1).max(365).nullable().default(null),
  externalAccountRef: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/).optional(), idempotencyKey: z.string().min(16).max(128) }).strict();
export const decisionSchema = z.object({ decision: z.enum(['approved', 'denied']), capabilities: capabilitiesSchema,
  expiresInDays: z.number().int().min(1).max(365).nullable() }).strict();
export const registrationDecisionSchema = z.object({ decision: z.enum(['approved', 'denied']), selfAccess: z.boolean(),
  capabilities: capabilitiesSchema, expiresInDays: z.number().int().min(1).max(365).nullable() }).strict();
type Capability = 'forms' | 'sms';
type PublicKey = z.infer<typeof publicKeySchema>;
export interface Service { id: string; ownerId: string; name: string; purpose: string; capabilities: Capability[];
  credentialHash: string; deliveryKeyId: string; active: boolean; deleted: boolean; createdAt: number }
interface Key { id: string; serviceId: string; ownerId: string; publicKey: PublicKey; retired: boolean }
interface Session { id: string; serviceId: string; ownerId: string | null; status: 'pending' | 'approved' | 'denied';
  capabilities: Capability[]; expiresInDays: number | null; expiresAt: number; createdAt: number;
  comparisonCode: string | null; externalAccountRef: string | null; connectionId: string | null; pollAfter: number; purgeAt: Date }
interface Registration extends Omit<Session, 'comparisonCode' | 'externalAccountRef' | 'expiresInDays'> {
  name: string; purpose: string; credentialHash: string; deliveryPublicKey: PublicKey;
}
interface Delivery { id: string; serviceId: string; ownerId: string; connectionId: string; grantId: string; keyId: string;
  envelope: string; expiresAt: number; acknowledged: boolean; purgeAt: Date }
const sorted = (a: Capability[]) => [...a].sort();
export const keyId = (key: PublicKey) => hash(JSON.stringify({ kty: key.kty, crv: key.crv, x: key.x, y: key.y }));
export async function validateKey(key: PublicKey) {
  try { await importJWK(key, 'ECDH-ES'); } catch { ensure(false, 400, 'invalid_delivery_key'); }
}
export class Onboarding {
  constructor(readonly relay: Relay) {}
  get db() { return this.relay.db; }
  ref(c: string, id: string) { return this.relay.ref(c, id); }
  now() { return this.relay.now(); }
  async rate(tx: Transaction, scope: string, max: number) {
    const window = Math.floor(this.now() / (10 * MINUTE)), ref = this.ref('onboardingRates', hash(`${scope}:${window}`));
    const previous = (await tx.get(ref)).data() as { start: number; count: number } | undefined;
    const value = { ...bump(previous ?? { start: this.now(), count: 0 }, this.now(), max), purgeAt: new Date((window + 1) * 10 * MINUTE) };
    return () => tx.set(ref, value);
  }
  async activeService(tx: Transaction, id: string) {
    const s = (await tx.get(this.ref('services', id))).data() as Service | undefined;
    ensure(s && s.active && !s.deleted, 404, 'service_unavailable');
    await this.relay.account(tx, s.ownerId); return s;
  }
  async service(tx: Transaction, token: string) {
    ensure(/^smss_[A-Za-z0-9_-]{43}$/.test(token), 401, 'invalid_service_credential');
    const credential = hash(token), record = (await tx.get(this.ref('serviceCredentials', credential))).data();
    ensure(record, 401, 'invalid_service_credential');
    const s = await this.activeService(tx, record.serviceId);
    ensure(s.credentialHash === credential, 401, 'invalid_service_credential'); return s;
  }
  serviceView(s: Service) { return { serviceId: s.id, name: s.name, purpose: s.purpose, capabilities: s.capabilities,
    active: s.active && !s.deleted, nameIsOperatorSupplied: true, servicePath: `/services/${s.id}` }; }
  async publicService(id: string) {
    return this.db.runTransaction(async tx => this.serviceView(await this.activeService(tx, id)));
  }
  async register(token: string, source: string, raw: unknown) {
    ensure(/^smsreg_[A-Za-z0-9_-]{43}$/.test(token), 401, 'invalid_registration_credential');
    const input = serviceSchema.parse(raw); await validateKey(input.deliveryPublicKey);
    const id = hash(token), serviceId = randomUUID();
    return this.db.runTransaction(async tx => {
      const old = (await tx.get(this.ref('registrationSessions', id))).data() as Registration | undefined;
      if (old) {
        ensure(old.name === input.name && old.purpose === input.purpose && old.credentialHash === input.credentialHash &&
          keyId(old.deliveryPublicKey) === keyId(input.deliveryPublicKey) && JSON.stringify(sorted(old.capabilities)) === JSON.stringify(sorted(input.capabilities)), 409, 'idempotency_conflict');
        return this.registrationView(old);
      }
      const receipt = (await tx.get(this.ref('serviceCredentials', input.credentialHash))).data();
      if (receipt) {
        ensure(receipt.registrationId === id && receipt.registrationKeyId === keyId(input.deliveryPublicKey), 409, 'idempotency_conflict');
        const s = await this.activeService(tx, receipt.serviceId);
        ensure(s.credentialHash === input.credentialHash && s.name === input.name && s.purpose === input.purpose &&
          JSON.stringify(sorted(s.capabilities)) === JSON.stringify(sorted(input.capabilities)), 409, 'idempotency_conflict');
        const recovered: Registration = { id, serviceId: s.id, ownerId: s.ownerId, ...input, status: 'approved',
          createdAt: s.createdAt, expiresAt: s.createdAt + 10 * MINUTE, connectionId: receipt.registrationConnectionId ?? null,
          pollAfter: 0, purgeAt: new Date(this.now() + HISTORY) };
        tx.create(this.ref('registrationSessions', id), recovered);
        return this.registrationView(recovered);
      }
      const rate = await this.rate(tx, `registration:${source}`, 30), global = await this.rate(tx, 'registration:global', 600);
      const session: Registration = { id, serviceId, ownerId: null, ...input, status: 'pending', createdAt: this.now(),
        expiresAt: this.now() + 10 * MINUTE, connectionId: null, pollAfter: 0, purgeAt: new Date(this.now() + HISTORY) };
      rate(); global(); tx.create(this.ref('registrationSessions', id), session);
      return this.registrationView(session);
    });
  }
  registrationView(r: Registration) { return { sessionId: r.id, serviceId: r.serviceId, name: r.name, purpose: r.purpose,
    capabilities: r.capabilities, status: r.status === 'pending' && r.expiresAt <= this.now() ? 'expired' : r.status,
    expiresAt: r.expiresAt, connectionId: r.connectionId, registrationPath: `/register/${r.id}`, servicePath: `/services/${r.serviceId}`, interval: 5 }; }
  async registrationPoll(token: string) {
    ensure(/^smsreg_[A-Za-z0-9_-]{43}$/.test(token), 401, 'invalid_registration_credential');
    return this.db.runTransaction(async tx => {
      const ref = this.ref('registrationSessions', hash(token)), r = (await tx.get(ref)).data() as Registration | undefined;
      ensure(r, 401, 'invalid_registration_credential'); ensure(r.pollAfter <= this.now(), 429, 'slow_down');
      if (r.ownerId) await this.relay.account(tx, r.ownerId);
      tx.update(ref, { pollAfter: this.now() + 5000 }); return this.registrationView(r);
    });
  }
  async registrationReview(uid: string, id: string) {
    return this.db.runTransaction(async tx => {
      await this.relay.account(tx, uid);
      const r = (await tx.get(this.ref('registrationSessions', id))).data() as Registration | undefined;
      ensure(r && (!r.ownerId || r.ownerId === uid), 404, 'registration_not_found'); return this.registrationView(r);
    });
  }
  select(requested: Capability[], selected: Capability[], requestedDays: number | null, days: number | null) {
    ensure(selected.every(c => requested.includes(c)), 400, 'capability_not_requested');
    ensure(requestedDays === null || (days !== null && days <= requestedDays), 400, 'duration_not_requested');
  }
  /** All reads happen before the returned commit function, including encryption-key and binding checks. */
  async prepareGrant(tx: Transaction, uid: string, s: Service, publicKey: PublicKey, capabilities: Capability[], days: number | null, external: string | null) {
    const bindingId = hash(JSON.stringify([uid, s.id, external])), bindingRef = this.ref('connectionBindings', bindingId);
    const binding = (await tx.get(bindingRef)).data(), old = binding ? (await tx.get(this.ref('grants', binding.grantId))).data() as Grant | undefined : undefined;
    const valid = old && await this.relay.validGrant(tx, old);
    const expiresAt = days === null ? FOREVER : this.now() + days * 24 * 60 * MINUTE;
    if (valid && old) return { connectionId: old.connectionId!, commit: () => {
      tx.update(this.ref('grants', old.id), { capabilities, formsApproved: capabilities.includes('forms'), expiresAt });
    } };
    const token = newSecret(), grantId = hash(token), connectionId = randomUUID(), deliveryId = randomUUID();
    const envelope = await new CompactEncrypt(Buffer.from(JSON.stringify({ version: 1, serviceId: s.id, connectionId, deliveryId, token, externalAccountRef: external })))
      .setProtectedHeader({ alg: 'ECDH-ES', enc: 'A256GCM', kid: s.deliveryKeyId, serviceId: s.id, connectionId, deliveryId })
      .encrypt(await importJWK(publicKey, 'ECDH-ES'));
    const grant: Grant & { formsApproved: boolean } = { id: grantId, connectionId, serviceId: s.id, ownerId: uid, deviceId: '', callerId: s.id,
      callerName: s.name, capabilities, formsApproved: capabilities.includes('forms'), revoked: false, createdAt: this.now(), expiresAt,
      deliveryId, deliveryAcknowledged: false, deliveryExpiresAt: this.now() + HISTORY, deliveryKeyId: s.deliveryKeyId, rate: { start: this.now(), count: 0 } };
    const delivery: Delivery = { id: deliveryId, ownerId: uid, serviceId: s.id, connectionId, grantId, keyId: s.deliveryKeyId, envelope,
      expiresAt: this.now() + HISTORY, acknowledged: false, purgeAt: new Date(this.now() + HISTORY) };
    return { connectionId, commit: () => {
      tx.create(this.ref('grants', grantId), grant); tx.create(this.ref('credentialDeliveries', deliveryId), delivery);
      tx.set(bindingRef, { ownerId: uid, serviceId: s.id, grantId, connectionId });
      tx.create(this.ref('serviceConnections', connectionId), { ownerId: uid, serviceId: s.id, grantId, connectionId });
    } };
  }
  async registrationDecide(uid: string, id: string, raw: unknown) {
    const input = registrationDecisionSchema.parse(raw);
    return this.db.runTransaction(async tx => {
      await this.relay.account(tx, uid);
      const ref = this.ref('registrationSessions', id), r = (await tx.get(ref)).data() as Registration | undefined;
      ensure(r && (!r.ownerId || r.ownerId === uid), 404, 'registration_not_found');
      if (r.status !== 'pending') return this.registrationView(r);
      ensure(r.expiresAt > this.now(), 410, 'session_expired'); this.select(r.capabilities, input.capabilities, null, input.expiresInDays);
      if (input.decision === 'approved') {
        const owned = await tx.get(this.db.collection('services').where('ownerId', '==', uid).where('deleted', '==', false).limit(100));
        ensure(owned.size < 100, 409, 'service_limit_reached');
      }
      const s: Service = { id: r.serviceId, ownerId: uid, name: r.name, purpose: r.purpose, capabilities: r.capabilities,
        active: true, deleted: false, credentialHash: r.credentialHash, deliveryKeyId: keyId(r.deliveryPublicKey), createdAt: this.now() };
      const grant = input.decision === 'approved' && input.selfAccess
        ? await this.prepareGrant(tx, uid, s, r.deliveryPublicKey, input.capabilities, input.expiresInDays, null) : undefined;
      if (input.decision === 'approved') {
        tx.create(this.ref('services', s.id), s);
        tx.create(this.ref('serviceCredentials', s.credentialHash), { serviceId: s.id, ownerId: uid,
          registrationId: r.id, registrationKeyId: s.deliveryKeyId, registrationConnectionId: grant?.connectionId ?? null });
        tx.create(this.ref('serviceDeliveryKeys', `${s.id}_${s.deliveryKeyId}`), { id: s.deliveryKeyId, serviceId: s.id, ownerId: uid, publicKey: r.deliveryPublicKey, retired: false } satisfies Key);
        grant?.commit();
      }
      r.status = input.decision; r.ownerId = uid; r.connectionId = grant?.connectionId ?? null;
      tx.set(ref, r); return this.registrationView(r);
    });
  }
  async pairing(token: string | null, uid: string | null, serviceId: string | null, raw: unknown) {
    const input = pairingSchema.parse(raw);
    return this.db.runTransaction(async tx => {
      if (uid) await this.relay.account(tx, uid);
      const s = token ? await this.service(tx, token) : await this.activeService(tx, serviceId!);
      // A reusable public link cannot bind an external-service account.
      ensure(token || !input.externalAccountRef, 400, 'external_binding_requires_service');
      this.select(s.capabilities, input.capabilities, null, input.expiresInDays);
      const id = hash(JSON.stringify([s.id, uid, input.idempotencyKey]));
      const ref = this.ref('pairingSessions', id), old = (await tx.get(ref)).data() as Session | undefined;
      if (old) {
        ensure(old.externalAccountRef === (input.externalAccountRef ?? null) && old.expiresInDays === input.expiresInDays &&
          JSON.stringify(sorted(old.capabilities)) === JSON.stringify(sorted(input.capabilities)), 409, 'idempotency_conflict');
        return this.sessionView(old, s);
      }
      const rate = await this.rate(tx, `pairing:${uid ?? s.id}`, 60);
      const session: Session = { id, serviceId: s.id, ownerId: uid, status: 'pending', capabilities: input.capabilities,
        expiresInDays: input.expiresInDays, createdAt: this.now(), expiresAt: this.now() + 10 * MINUTE, pollAfter: 0,
        comparisonCode: token ? randomBytes(4).readUInt32BE().toString().slice(-6).padStart(6, '0') : null,
        externalAccountRef: input.externalAccountRef ?? null, connectionId: null, purgeAt: new Date(this.now() + HISTORY) };
      rate(); tx.create(ref, session); return this.sessionView(session, s);
    });
  }
  sessionView(p: Session, s: Service) { return { sessionId: p.id, serviceId: s.id, name: s.name, purpose: s.purpose, nameIsOperatorSupplied: true,
    capabilities: p.capabilities, expiresInDays: p.expiresInDays, expiresAt: p.expiresAt, comparisonCode: p.comparisonCode,
    status: p.status === 'pending' && p.expiresAt <= this.now() ? 'expired' : p.status, connectionId: p.connectionId,
    connectionPath: `/pair/${p.id}`, interval: 5 }; }
  async pairingReview(uid: string, id: string) {
    return this.db.runTransaction(async tx => {
      await this.relay.account(tx, uid);
      const p = (await tx.get(this.ref('pairingSessions', id))).data() as Session | undefined;
      ensure(p && (!p.ownerId || p.ownerId === uid), 404, 'session_not_found');
      return this.sessionView(p, await this.activeService(tx, p.serviceId));
    });
  }
  async pairingPoll(token: string, id: string) {
    return this.db.runTransaction(async tx => {
      const s = await this.service(tx, token), ref = this.ref('pairingSessions', id), p = (await tx.get(ref)).data() as Session | undefined;
      ensure(p && p.serviceId === s.id, 404, 'session_not_found'); ensure(p.pollAfter <= this.now(), 429, 'slow_down');
      tx.update(ref, { pollAfter: this.now() + 5000 }); return this.sessionView(p, s);
    });
  }
  async pairingDecide(uid: string, id: string, raw: unknown) {
    const input = decisionSchema.parse(raw);
    return this.db.runTransaction(async tx => {
      await this.relay.account(tx, uid);
      const ref = this.ref('pairingSessions', id), p = (await tx.get(ref)).data() as Session | undefined;
      ensure(p && (!p.ownerId || p.ownerId === uid), 404, 'session_not_found');
      const s = await this.activeService(tx, p.serviceId);
      if (p.status !== 'pending') return this.sessionView(p, s);
      ensure(p.expiresAt > this.now(), 410, 'session_expired'); this.select(p.capabilities, input.capabilities, p.expiresInDays, input.expiresInDays);
      const key = (await tx.get(this.ref('serviceDeliveryKeys', `${s.id}_${s.deliveryKeyId}`))).data() as Key | undefined;
      ensure(key && !key.retired, 409, 'delivery_key_unavailable');
      const grant = input.decision === 'approved'
        ? await this.prepareGrant(tx, uid, s, key.publicKey, input.capabilities, input.expiresInDays, p.externalAccountRef) : undefined;
      grant?.commit(); p.ownerId = uid; p.status = input.decision; p.connectionId = grant?.connectionId ?? null;
      tx.set(ref, p); return this.sessionView(p, s);
    });
  }
  async deliveries(token: string) {
    return this.db.runTransaction(async tx => {
      const s = await this.service(tx, token);
      const rows = await tx.get(this.db.collection('credentialDeliveries').where('serviceId', '==', s.id).where('acknowledged', '==', false).limit(100));
      const deliveries = [], discarded = [];
      for (const row of rows.docs) {
        const d = row.data() as Delivery, g = (await tx.get(this.ref('grants', d.grantId))).data() as Grant | undefined;
        if (d.expiresAt > this.now() && g && await this.relay.validGrant(tx, g) && !(await tx.get(this.ref('accounts', d.ownerId))).data()?.deleting)
          deliveries.push({ deliveryId: d.id, connectionId: d.connectionId, keyId: d.keyId, envelope: d.envelope, expiresAt: d.expiresAt });
        else discarded.push(row.ref);
      }
      for (const ref of discarded) tx.update(ref, { acknowledged: true, envelope: '' });
      return { deliveries, hasMore: rows.size === 100, interval: 5 };
    });
  }
  async acknowledge(token: string, id: string) {
    return this.db.runTransaction(async tx => {
      const s = await this.service(tx, token), ref = this.ref('credentialDeliveries', id), d = (await tx.get(ref)).data() as Delivery | undefined;
      ensure(d && d.serviceId === s.id, 404, 'delivery_not_found');
      const g = (await tx.get(this.ref('grants', d.grantId))).data() as Grant | undefined;
      ensure(g && await this.relay.validGrant(tx, g), 410, 'delivery_expired'); await this.relay.account(tx, d.ownerId);
      ensure(d.acknowledged || d.expiresAt > this.now(), 410, 'delivery_expired');
      tx.update(ref, { acknowledged: true, envelope: '' }); tx.update(this.ref('grants', d.grantId), { deliveryAcknowledged: true });
      return { ok: true };
    });
  }
  async listServices(uid: string) {
    return this.db.runTransaction(async tx => {
      await this.relay.account(tx, uid);
      return (await tx.get(this.db.collection('services').where('ownerId', '==', uid).where('deleted', '==', false).limit(100))).docs
        .map(d => d.data() as Service).filter(s => !s.deleted).map(s => this.serviceView(s));
    });
  }
  async manageService(uid: string | null, token: string | null, id: string | null, raw: unknown) {
    const input = z.object({ credentialHash: z.string().regex(/^[a-f0-9]{64}$/).optional(), deliveryPublicKey: publicKeySchema.optional(),
      retireKeyId: z.string().regex(/^[a-f0-9]{64}$/).optional(), active: z.boolean().optional(), delete: z.literal(true).optional() }).strict().parse(raw);
    if (input.deliveryPublicKey) await validateKey(input.deliveryPublicKey);
    // Security denials are recorded before acknowledging the mutation, using the existing recovery ledger.
    const owner = await this.db.runTransaction(async tx => {
      if (uid) await this.relay.account(tx, uid);
      const s = token ? await this.service(tx, token) : (await tx.get(this.ref('services', id!))).data() as Service | undefined;
      ensure(s && (!uid || s.ownerId === uid) && !s.deleted, 404, 'service_not_found');
      ensure(!token || (input.active === undefined && !input.delete), 403, 'owner_required'); return s;
    });
    if (input.active === false || input.delete || input.retireKeyId || input.credentialHash)
      await this.relay.recordSecurity({ ownerId: owner.ownerId, kind: 'service.invalidate', target: owner.id });
    return this.db.runTransaction(async tx => {
      await this.relay.account(tx, owner.ownerId);
      const s = token ? await this.service(tx, token) : (await tx.get(this.ref('services', owner.id))).data() as Service | undefined;
      ensure(s && s.ownerId === owner.ownerId && !s.deleted, 404, 'service_not_found');
      const retiredRef = input.retireKeyId ? this.ref('serviceDeliveryKeys', `${s.id}_${input.retireKeyId}`) : null;
      const retired = retiredRef ? (await tx.get(retiredRef)).data() as Key | undefined : undefined;
      ensure(!retiredRef || retired, 404, 'delivery_key_not_found');
      if (input.deliveryPublicKey) {
        const key = keyId(input.deliveryPublicKey), keyRef = this.ref('serviceDeliveryKeys', `${s.id}_${key}`);
        const oldKey = (await tx.get(keyRef)).data() as Key | undefined;
        ensure(!oldKey?.retired, 409, 'delivery_key_retired');
        s.deliveryKeyId = key;
      }
      ensure(!input.retireKeyId || input.retireKeyId !== s.deliveryKeyId, 409, 'cannot_retire_current_key');
      if (input.credentialHash) {
        const old = (await tx.get(this.ref('serviceCredentials', input.credentialHash))).data();
        ensure(!old || old.serviceId === s.id, 409, 'credential_already_used');
      }
      if (input.credentialHash) { s.credentialHash = input.credentialHash; tx.set(this.ref('serviceCredentials', s.credentialHash), { ownerId: s.ownerId, serviceId: s.id }); }
      if (input.deliveryPublicKey) tx.set(this.ref('serviceDeliveryKeys', `${s.id}_${s.deliveryKeyId}`), { id: s.deliveryKeyId, serviceId: s.id, ownerId: s.ownerId, publicKey: input.deliveryPublicKey, retired: false } satisfies Key);
      if (retiredRef) tx.update(retiredRef, { retired: true });
      if (input.active !== undefined) s.active = input.active;
      if (input.delete) { tx.set(this.ref('serviceCleanup', s.id), { serviceId: s.id, ownerId: s.ownerId, collectionIndex: 0 }); s.active = false; s.deleted = true; s.name = ''; s.purpose = ''; }
      tx.set(this.ref('services', s.id), s); return this.serviceView(s);
    });
  }
  async connectionStatus(token: string | null, uid: string | null, id: string | null, serviceToken?: string) {
    return this.db.runTransaction(async tx => {
      if (uid) await this.relay.account(tx, uid);
      let g: Grant | undefined;
      if (token) g = (await this.relay.agent(tx, token)).grant;
      else {
        const link = (await tx.get(this.ref('serviceConnections', id!))).data();
        g = link ? (await tx.get(this.ref('grants', link.grantId))).data() as Grant | undefined : undefined;
        const s = serviceToken ? await this.service(tx, serviceToken) : null;
        ensure(g && (s ? g.serviceId === s.id : g.ownerId === uid), 404, 'connection_not_found');
      }
      const service = g!.serviceId ? (await tx.get(this.ref('services', g!.serviceId))).data() as Service | undefined : undefined;
      const recipient = (await tx.get(this.ref('accounts', g!.ownerId))).data();
      const valid = !recipient?.deleting && await this.relay.validGrant(tx, g), devices = recipient?.deleting ? [] : await this.relay.devices(tx, g!.ownerId);
      const available = devices.some((d: Device) => !!d.fcmToken && (!(g!.capabilities?.includes('forms')) || d.wizardVersion === 1));
      return { connectionId: g!.connectionId, serviceId: g!.serviceId, name: service?.name ?? g!.callerName, purpose: service?.purpose ?? '', availableCapabilities: service?.capabilities ?? g!.capabilities, capabilities: g!.capabilities,
        expiresAt: g!.expiresAt === FOREVER ? null : g!.expiresAt, revoked: !valid,
        receivingDeviceAvailable: available, setup: !valid ? 'disconnected' : !available ? 'phone_setup_needed' : g!.deliveryAcknowledged ? 'setup_complete' : 'waiting_for_service' };
    });
  }
  async manageConnection(uid: string, id: string, raw: unknown) {
    const input = z.object({ capabilities: capabilitiesSchema, expiresAt: z.number().int().positive().max(FOREVER).nullable() }).strict().parse(raw);
    const link = (await this.ref('serviceConnections', id).get()).data();
    ensure(link && link.ownerId === uid, 404, 'connection_not_found');
    await this.relay.recordSecurity({ ownerId: uid, kind: 'grant.restrict', target: link.grantId });
    await this.db.runTransaction(async tx => {
      await this.relay.account(tx, uid);
      const ref = this.ref('grants', link.grantId), g = (await tx.get(ref)).data() as Grant | undefined;
      ensure(g && g.ownerId === uid && await this.relay.validGrant(tx, g), 404, 'connection_not_found');
      const s = await this.activeService(tx, g.serviceId!); this.select(s.capabilities, input.capabilities, null, null);
      ensure(input.expiresAt === null || input.expiresAt > this.now(), 400, 'expiry_in_past');
      tx.update(ref, { capabilities: input.capabilities, formsApproved: input.capabilities.includes('forms'), expiresAt: input.expiresAt ?? FOREVER });
    });
    return this.connectionStatus(null, uid, id);
  }
  async disconnect(uid: string, id: string) {
    const link = (await this.ref('serviceConnections', id).get()).data();
    ensure(link && link.ownerId === uid, 404, 'connection_not_found'); await this.relay.revoke(uid, link.grantId); return { ok: true };
  }
  async cleanup() {
    await cleanupOAuth(this.relay);
    const jobs = await this.db.collection('serviceCleanup').limit(20).get();
    for (const job of jobs.docs) await this.db.runTransaction(async tx => {
      const current = (await tx.get(job.ref)).data(); if (!current) return;
      const collections = ['serviceCredentials', 'serviceDeliveryKeys', 'credentialDeliveries', 'registrationSessions', 'pairingSessions', 'connectionBindings', 'serviceConnections', 'oauthSessions', 'oauthBindings', 'oauthCodes', 'oauthFamilies', 'oauthAccess', 'oauthRefresh', 'oauthCleanup', 'oauthGrantCleanup'];
      const collection = collections[current.collectionIndex];
      if (!collection) { tx.delete(job.ref); return; }
      const rows = await tx.get(this.db.collection(collection).where('serviceId', '==', current.serviceId).limit(100));
      for (const row of rows.docs) tx.delete(row.ref);
      tx.update(job.ref, { collectionIndex: current.collectionIndex + (rows.size < 100 ? 1 : 0) });
    });
    for (const c of ['registrationSessions', 'pairingSessions', 'credentialDeliveries', 'onboardingRates', 'oauthClients', 'oauthSessions', 'oauthCodes', 'oauthFamilies', 'oauthAccess', 'oauthRefresh']) {
      const rows = await this.db.collection(c).where('purgeAt', '<=', new Date(this.now())).limit(100).get();
      if (rows.empty) continue; const batch = this.db.batch(); for (const row of rows.docs) batch.delete(row.ref); await batch.commit();
    }
  }
}
