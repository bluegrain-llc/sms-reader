import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { request } from 'node:https';
import { z } from 'zod';
import type { Transaction } from 'firebase-admin/firestore';
import type { Relay } from './relay.js';
import { ensure, Grant, hash, HISTORY, MINUTE, RelayError } from './model.js';
import { capabilitiesSchema, decisionSchema, FOREVER } from './onboarding.js';
import { validateDestination } from './webhooks.js';

const secret = (prefix: string) => `${prefix}_${randomBytes(32).toString('base64url')}`;
const challenge = (value: string) => createHash('sha256').update(value).digest('base64url');
export const clientSchema = z.object({ client_name: z.string().trim().min(1).max(80),
  redirect_uris: z.array(z.string().url().max(2048)).min(1).max(8),
  token_endpoint_auth_method: z.enum(['none', 'client_secret_post']).default('none'),
  grant_types: z.array(z.enum(['authorization_code', 'refresh_token'])).default(['authorization_code', 'refresh_token']),
  response_types: z.array(z.literal('code')).default(['code']), client_uri: z.string().url().optional(),
  client_id: z.string().max(2048).optional(), scope: z.string().max(80).optional(),
}).strip();
export const authorizationSchema = z.object({ response_type: z.literal('code'), client_id: z.string().min(1).max(2048),
  redirect_uri: z.string().max(2048), resource: z.string().max(2048), code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  code_challenge_method: z.literal('S256'), scope: z.string().max(80), state: z.string().max(1024).optional() }).strict();
export const oauthDecisionSchema = decisionSchema;
type Client = z.infer<typeof clientSchema> & { id: string; secretHash: string | null; expiresAt: number; purgeAt?: unknown };
type Session = z.infer<typeof authorizationSchema> & { id: string; serviceId: string; clientName: string;
  capabilities: ('forms' | 'sms')[]; status: string; ownerId: string | null; expiresAt: number; connectionId: string | null;
  decisionHash?: string; codeHash?: string; grantId?: string; selectedCapabilities?: ('forms' | 'sms')[] };
type Family = { id: string; ownerId: string; serviceId: string; grantId: string; clientId: string; resource: string;
  capabilities: ('forms' | 'sms')[]; revoked: boolean; expiresAt: number; purgeAt?: unknown };

/** Public HTTPS metadata is fetched at a pinned address, with no redirects or environment proxy. */
export async function fetchClientDocument(raw: string): Promise<unknown> {
  const { url, address } = await validateDestination(raw);
  return new Promise((resolve, reject) => {
    const req = request(url, { agent: false, family: address.family, headers: { Accept: 'application/json' },
      lookup: (_hostname, options, cb) => options.all ? cb(null, [address]) : cb(null, address.address, address.family) }, res => {
      if (res.statusCode !== 200 || !/^application\/(?:[a-z.+-]*\+)?json(?:;|$)/i.test(res.headers['content-type'] ?? '')) {
        res.resume(); reject(new RelayError(400, 'invalid_client_metadata')); return;
      }
      const chunks: Buffer[] = []; let size = 0;
      res.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 32768) req.destroy(new RelayError(400, 'invalid_client_metadata')); else chunks.push(chunk); });
      res.on('error', reject); res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new RelayError(400, 'invalid_client_metadata')); } });
    });
    const timer = setTimeout(() => req.destroy(new RelayError(503, 'client_metadata_unavailable')), 5000);
    req.on('close', () => clearTimeout(timer)); req.on('error', reject); req.end();
  });
}

export class OAuth {
  constructor(readonly relay: Relay, readonly base: string) {
    const url = new URL(base); ensure(url.protocol === 'https:' && url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password, 503, 'oauth_not_configured');
    this.base = url.origin;
  }
  ref(c: string, id: string) { return this.relay.ref(c, id); }
  resource(id: string) { return `${this.base}/mcp/services/${id}`; }
  metadata() { return { issuer: this.base, authorization_endpoint: `${this.base}/oauth/authorize`, token_endpoint: `${this.base}/oauth/token`,
    registration_endpoint: `${this.base}/oauth/register`, revocation_endpoint: `${this.base}/oauth/revoke`,
    response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
    scopes_supported: ['forms', 'sms'], client_id_metadata_document_supported: true }; }
  async register(raw: unknown, source: string, metadataId?: string) {
    const input = clientSchema.parse(raw);
    ensure(new Set(input.redirect_uris).size === input.redirect_uris.length && input.grant_types.includes('authorization_code') && input.response_types.includes('code'), 400, 'invalid_client_metadata');
    if (metadataId) ensure(input.client_id === metadataId && input.token_endpoint_auth_method === 'none', 400, 'invalid_client_metadata');
    for (const uri of input.redirect_uris) { ensure(!uri.includes("#"), 400, "invalid_client_metadata"); await validateDestination(uri); }
    if (input.client_uri) await validateDestination(input.client_uri);
    const id = metadataId ?? `relay-client-${randomUUID()}`, credential = input.token_endpoint_auth_method === 'none' ? null : secret('smscs');
    const client: Client = { ...input, id, secretHash: credential ? hash(credential) : null, expiresAt: metadataId ? this.relay.now() + 60 * MINUTE : FOREVER };
    await this.relay.db.runTransaction(async tx => {
      const rate = await this.relay.onboarding.rate(tx, `oauth-register:${source}`, 20), global = await this.relay.onboarding.rate(tx, 'oauth-register:global', 200);
      rate(); global(); tx.set(this.ref('oauthClients', hash(id)), { ...client, purgeAt: null });
    });
    return { client_id: id, client_name: input.client_name, redirect_uris: input.redirect_uris,
      token_endpoint_auth_method: input.token_endpoint_auth_method, grant_types: input.grant_types, response_types: input.response_types,
      ...(credential ? { client_secret: credential, client_secret_expires_at: 0 } : {}) };
  }
  code(id: string, uid: string) {
    const key = process.env.OAUTH_CODE_KEY ?? "";
    ensure(/^[a-f0-9]{64}$/.test(key), 503, "oauth_not_configured");
    return `smsc_${createHmac("sha256", Buffer.from(key, "hex")).update(`${id}\n${uid}`).digest("base64url")}`;
  }
  async start(raw: unknown, source: string) {
    this.code("configuration", "check");
    const input = authorizationSchema.parse(raw);
    ensure(URL.canParse(input.resource), 400, 'invalid_target');
    const url = new URL(input.resource);
    const match = /^\/mcp\/services\/([A-Za-z0-9_-]{1,128})$/.exec(url.pathname);
    ensure(match && input.resource === this.resource(match[1]!), 400, 'invalid_target');
    if (input.client_id.startsWith('https://')) {
      const existing = (await this.ref('oauthClients', hash(input.client_id)).get()).data() as Client | undefined;
      if (!existing || existing.expiresAt <= this.relay.now()) await this.register(await fetchClientDocument(input.client_id), source, input.client_id);
    }
    const capabilities = capabilitiesSchema.parse(input.scope.split(' '));
    const sessionId = randomUUID();
    await this.relay.db.runTransaction(async tx => {
      const c = (await tx.get(this.ref('oauthClients', hash(input.client_id)))).data() as Client | undefined;
      ensure(c && c.redirect_uris.includes(input.redirect_uri), 400, 'invalid_client');
      const s = await this.relay.onboarding.activeService(tx, match![1]!);
      this.relay.onboarding.select(s.capabilities, capabilities, null, null);
      const rate = await this.relay.onboarding.rate(tx, `oauth-authorize:${source}`, 60), global = await this.relay.onboarding.rate(tx, 'oauth-authorize:global', 600);
      rate(); global(); tx.create(this.ref('oauthSessions', sessionId), { ...input, id: sessionId, serviceId: s.id,
        clientName: c.client_name, capabilities, status: 'pending', ownerId: null, connectionId: null,
        expiresAt: this.relay.now() + 10 * MINUTE, purgeAt: new Date(this.relay.now() + HISTORY) } satisfies Session & { purgeAt: Date });
    });
    return `/oauth/consent/${sessionId}`;
  }
  async review(uid: string, id: string) {
    return this.relay.db.runTransaction(async tx => {
      await this.relay.account(tx, uid);
      const p = (await tx.get(this.ref('oauthSessions', id))).data() as Session | undefined;
      ensure(p && (!p.ownerId || p.ownerId === uid), 404, 'session_not_found');
      const s = await this.relay.onboarding.activeService(tx, p.serviceId);
      return { sessionId: id, ...this.relay.onboarding.serviceView(s), clientName: p.clientName, clientOrigin: new URL(p.redirect_uri).origin,
        capabilities: p.capabilities, expiresInDays: null, connectionId: p.connectionId,
        status: p.status === 'pending' && p.expiresAt <= this.relay.now() ? 'expired' : p.status, expiresAt: p.expiresAt };
    });
  }
  async decide(uid: string, id: string, raw: unknown) {
    const input = oauthDecisionSchema.parse(raw);
    return this.relay.db.runTransaction(async tx => {
      await this.relay.account(tx, uid);
      const ref = this.ref('oauthSessions', id), p = (await tx.get(ref)).data() as Session | undefined;
      ensure(p && (!p.ownerId || p.ownerId === uid), 404, 'session_not_found');
      const s = await this.relay.onboarding.activeService(tx, p.serviceId);
      ensure(p.expiresAt > this.relay.now(), 410, 'session_expired');
      this.relay.onboarding.select(p.capabilities, input.capabilities, null, input.expiresInDays);
      const fingerprint = hash(JSON.stringify([input.decision, input.capabilities.slice().sort(), input.expiresInDays]));
      const code = this.code(id, uid);
      if (p.status !== 'pending') ensure(p.decisionHash === fingerprint, 409, 'decision_already_made');
      else {
        let grant: Grant | undefined;
        if (input.decision === 'approved') {
          // Hosted clients have their own binding and never receive the software delivery credential.
          const binding = hash(JSON.stringify([uid, s.id, 'oauth', p.client_id]));
          const old = (await tx.get(this.ref('oauthBindings', binding))).data();
          grant = old ? (await tx.get(this.ref('grants', old.grantId))).data() as Grant | undefined : undefined;
          const valid = grant && await this.relay.validGrant(tx, grant);
          const expiresAt = input.expiresInDays === null ? FOREVER : this.relay.now() + input.expiresInDays * 24 * 60 * MINUTE;
          if (!valid) grant = { id: hash(secret('smsr')), connectionId: randomUUID(), serviceId: s.id, ownerId: uid, deviceId: '',
            callerName: s.name, callerId: s.id, revoked: false, createdAt: this.relay.now(), expiresAt,
            capabilities: input.capabilities, deliveryAcknowledged: true, rate: { start: this.relay.now(), count: 0 } };
          grant!.capabilities = input.capabilities; grant!.expiresAt = expiresAt;
          tx.set(this.ref('grants', grant!.id), { ...grant!, formsApproved: input.capabilities.includes('forms') });
          tx.set(this.ref('oauthBindings', binding), { ownerId: uid, serviceId: s.id, grantId: grant!.id });
          tx.set(this.ref('serviceConnections', grant!.connectionId!), { ownerId: uid, serviceId: s.id, grantId: grant!.id, connectionId: grant!.connectionId });

        }
        p.connectionId = grant?.connectionId ?? null;
        tx.update(ref, { ownerId: uid, status: input.decision, decisionHash: fingerprint, connectionId: grant?.connectionId ?? null, codeHash: hash(code), grantId: grant?.id ?? null, selectedCapabilities: input.capabilities });
      }
      return { status: input.decision, connectionId: p.connectionId };
    });
  }
  async response(uid: string, id: string) {
    return this.relay.db.runTransaction(async tx => {
      await this.relay.account(tx, uid);
      const p = (await tx.get(this.ref('oauthSessions', id))).data() as Session | undefined;
      ensure(p && p.ownerId === uid && p.status !== 'pending', 404, 'session_not_found');
      await this.relay.onboarding.activeService(tx, p.serviceId);
      ensure(p.expiresAt > this.relay.now(), 410, 'session_expired');
      const redirect = new URL(p.redirect_uri);
      for (const name of ['state', 'code', 'error']) redirect.searchParams.delete(name);
      if (p.state !== undefined) redirect.searchParams.set('state', p.state);
      if (p.status === 'approved') {
        const code = this.code(id, uid), codeRef = this.ref('oauthCodes', hash(code)), record = (await tx.get(codeRef)).data();
        const grant = p.grantId ? (await tx.get(this.ref('grants', p.grantId))).data() as Grant | undefined : undefined;
        ensure(p.codeHash === hash(code) && grant && await this.relay.validGrant(tx, grant), 410, 'authorization_finished');
        ensure(!record || (record.expiresAt > this.relay.now() && !record.consumed), 410, 'authorization_finished');
        if (!record) tx.create(codeRef, { ownerId: uid, serviceId: p.serviceId, grantId: p.grantId, clientId: p.client_id,
          resource: p.resource, redirectUri: p.redirect_uri, challenge: p.code_challenge, capabilities: p.selectedCapabilities,
          expiresAt: Math.min(p.expiresAt, this.relay.now() + MINUTE), consumed: false, familyId: null, purgeAt: new Date(this.relay.now() + HISTORY) });
        redirect.searchParams.set('code', code);
      } else redirect.searchParams.set('error', 'access_denied');
      return { redirect: redirect.href, status: p.status };
    });
  }
  async client(tx: Transaction, input: Record<string, string>) {
    const c = (await tx.get(this.ref('oauthClients', hash(input.client_id ?? '')))).data() as Client | undefined;
    ensure(c && (c.secretHash ? hash(input.client_secret ?? '') === c.secretHash : !input.client_secret), 401, 'invalid_client');
    return c;
  }
  async token(input: Record<string, string>) {
    const refresh = input.grant_type === 'refresh_token' ? input.refresh_token ?? '' : secret('smsf');
    // Derive the stable access credential from static client credentials, never a deployment key.
    const access = `smsa_${createHmac('sha256', refresh).update(`relay-oauth-access-v1\n${input.client_secret ?? ''}`).digest('base64url')}`, familyId = randomUUID();
    const result = await this.relay.db.runTransaction(async tx => {
      const c = await this.client(tx, input);
      const codeFlow = input.grant_type === 'authorization_code';
      ensure(codeFlow || input.grant_type === 'refresh_token', 400, 'unsupported_grant_type');
      ensure(c.grant_types.includes(input.grant_type as 'authorization_code' | 'refresh_token'), 400, 'unauthorized_client');
      const ref = this.ref(codeFlow ? 'oauthCodes' : 'oauthRefresh', hash((codeFlow ? input.code : input.refresh_token) ?? ''));
      const record = (await tx.get(ref)).data();
      ensure(record && record.clientId === c.id && record.resource === input.resource, 400, 'invalid_grant');
      if (codeFlow) ensure(input.redirect_uri === record.redirectUri && /^[A-Za-z0-9._~-]{43,128}$/.test(input.code_verifier ?? '') && challenge(input.code_verifier!) === record.challenge, 400, 'invalid_grant');
      let family: Family;
      if (codeFlow) family = { id: familyId, ownerId: record.ownerId, serviceId: record.serviceId, grantId: record.grantId,
        clientId: c.id, resource: record.resource, capabilities: record.capabilities, expiresAt: FOREVER, revoked: false };
      else {
        family = (await tx.get(this.ref('oauthFamilies', record.familyId))).data() as Family;
        ensure(family && !family.revoked && family.expiresAt > this.relay.now(), 400, 'invalid_grant');
      }
      ensure(!record.consumed, 400, 'invalid_grant');
      ensure(record.expiresAt > this.relay.now(), 400, 'invalid_grant');
      const g = (await tx.get(this.ref('grants', family.grantId))).data() as Grant | undefined;
      ensure(g && await this.relay.validGrant(tx, g), 400, 'invalid_grant'); await this.relay.account(tx, g.ownerId);
      const selected = input.scope === undefined ? family.capabilities : capabilitiesSchema.parse(input.scope.split(' '));
      ensure(selected.every(cap => family.capabilities.includes(cap) && g.capabilities?.includes(cap)), 400, 'invalid_scope');
      const accessRef = this.ref('oauthAccess', hash(access)), accessRecord = { ownerId: g.ownerId, serviceId: g.serviceId, grantId: g.id, clientId: c.id,
        familyId: family.id, resource: family.resource, capabilities: selected, expiresAt: FOREVER, purgeAt: null };
      const existingAccess = codeFlow ? undefined : (await tx.get(accessRef)).data();
      const response = { access_token: access, token_type: 'Bearer', ...(c.grant_types.includes('refresh_token') ? { refresh_token: refresh } : {}), scope: selected.join(' ') };
      // Unchanged static refreshes need no writes; concurrent retries can share the same records.
      if (!codeFlow && family.expiresAt === FOREVER && family.purgeAt === null && c.purgeAt === null
        && record.expiresAt === FOREVER && record.purgeAt === null && JSON.stringify(family.capabilities) === JSON.stringify(selected)
        && existingAccess && Object.entries(accessRecord).every(([key, value]) => key === 'capabilities'
          ? JSON.stringify(existingAccess[key]) === JSON.stringify(value) : existingAccess[key] === value)) return response;
      family.capabilities = selected; family.expiresAt = FOREVER;
      if (codeFlow) tx.update(ref, { consumed: true, familyId: family.id });
      tx.set(this.ref('oauthFamilies', family.id), { ...family, purgeAt: null });
      tx.set(accessRef, accessRecord);
      tx.update(this.ref('oauthClients', hash(c.id)), { purgeAt: null });
      if (c.grant_types.includes('refresh_token')) tx.set(this.ref('oauthRefresh', hash(refresh)), { ownerId: g.ownerId, serviceId: g.serviceId, clientId: c.id, resource: family.resource,
        familyId: family.id, expiresAt: FOREVER, consumed: false, purgeAt: null });
      return response;
    });
    return result;
  }
  async revoke(input: Record<string, string>) {
    await this.relay.db.runTransaction(async tx => {
      const c = await this.client(tx, input), token = input.token ?? '';
      const r = (await tx.get(this.ref(token.startsWith('smsf_') ? 'oauthRefresh' : 'oauthAccess', hash(token)))).data();
      if (r?.clientId === c.id) { tx.update(this.ref('oauthFamilies', r.familyId), { revoked: true }); tx.set(this.ref('oauthCleanup', r.familyId), {familyId:r.familyId,ownerId:r.ownerId,serviceId:r.serviceId,collectionIndex:0}); }
    }); return {};
  }
}

/** Only HTTP MCP resource routes may admit these credentials. Each operation rechecks the family and parent. */
export async function oauthGrant(relay: Relay, tx: Transaction, token: string): Promise<Grant> {
  ensure(/^smsa_[A-Za-z0-9_-]{43}$/.test(token), 401, 'invalid_token');
  const access = (await tx.get(relay.ref('oauthAccess', hash(token)))).data();
  ensure(access && access.expiresAt > relay.now(), 401, 'invalid_token');
  const family = (await tx.get(relay.ref('oauthFamilies', access.familyId))).data() as Family | undefined;
  ensure(family && !family.revoked && family.expiresAt > relay.now() && family.clientId === access.clientId && family.resource === access.resource, 401, 'invalid_token');
  const g = (await tx.get(relay.ref('grants', access.grantId))).data() as Grant | undefined;
  ensure(g && g.serviceId === access.serviceId && await relay.validGrant(tx, g), 401, 'invalid_token');
  return { ...g, capabilities: g.capabilities!.filter(c => access.capabilities.includes(c) && family.capabilities.includes(c)) };
}
