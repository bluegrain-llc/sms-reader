import { createHash, randomBytes } from 'node:crypto';
import { compactDecrypt, exportJWK, generateKeyPair, importJWK } from 'jose';
import { setTimeout as sleep } from 'node:timers/promises';
export const credential = prefix => `${prefix}_${randomBytes(32).toString('base64url')}`;
export const hash = value => createHash('sha256').update(value).digest('hex');
export async function deliveryKey() {
  const pair = await generateKeyPair('ECDH-ES', { crv: 'P-256', extractable: true });
  const publicKey = await exportJWK(pair.publicKey), privateKey = await exportJWK(pair.privateKey);
  const id = hash(JSON.stringify({ kty: publicKey.kty, crv: publicKey.crv, x: publicKey.x, y: publicKey.y }));
  return { id, publicKey, privateKey };
}
export class RelayClient {
  constructor(baseUrl, { signal, fetch: fetcher = fetch, allowHttpLoopback = false } = {}) {
    const url = new URL(baseUrl);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || (url.protocol !== 'https:' && !(allowHttpLoopback && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw Error('Use the configured relay HTTPS origin.');
    this.baseUrl = url.origin; this.signal = signal; this.fetch = fetcher;
  }
  async request(path, token, body, method = body === undefined ? 'GET' : 'POST') {
    if (!path.startsWith('/') || path.startsWith('//')) throw Error('Invalid relay route.');
    for (let attempt = 0; ; attempt++) {
      this.signal?.throwIfAborted(); let response;
      try { response = await this.fetch(this.baseUrl + path, { method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: this.signal ? AbortSignal.any([this.signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000) }); }
      catch (error) { if (this.signal?.aborted || attempt >= 5) throw Error('Relay unavailable. Run relay resume to retry.'); await sleep(Math.min(30_000, 1000 * 2 ** attempt), undefined, { signal: this.signal }); continue; }
      if ((response.status === 429 || response.status >= 500) && attempt < 5) {
        const delay = Math.min(300_000, Math.max(1000 * 2 ** attempt, Number(response.headers.get('Retry-After') || 0) * 1000));
        await response.body?.cancel(); await sleep(delay, undefined, { signal: this.signal }); continue;
      }
      const value = await response.json();
      if (!response.ok) throw Object.assign(Error(value.error || 'relay_error'), { code: value.error, status: response.status }); return value;
    }
  }
  async poll(read, done) {
    let value;
    for (;;) {
      value = await read();
      if (done(value)) return value;
      if (['expired', 'denied', 'revoked'].includes(value.status)) throw Error(`Session ${value.status}. Start a new session and approve it again.`);
      await sleep(Math.max(1, value.interval ?? 5) * 1000, undefined, { signal: this.signal });
    }
  }
  async consume(state, save) {
    let count = 0;
    for (let batch = 0; batch < 10; batch++) {
    const page = await this.request('/v3/service/deliveries', state.serviceToken);
    for (const d of page.deliveries) {
      const key = [...state.keys, ...(state.nextKey ? [state.nextKey] : [])].find(k => k.id === d.keyId);
      if (!key) throw Error('An outstanding delivery needs a retained private key. Restore that key before retrying.');
      const { plaintext, protectedHeader: h } = await compactDecrypt(d.envelope, await importJWK(key.privateKey, 'ECDH-ES'), { keyManagementAlgorithms: ['ECDH-ES'], contentEncryptionAlgorithms: ['A256GCM'] });
      const p = JSON.parse(new TextDecoder().decode(plaintext));
      if (h.kid !== d.keyId || p.version !== 1 || !/^smsr_[A-Za-z0-9_-]{43}$/.test(p.token) || [h, p].some(v => v.serviceId !== state.serviceId || v.connectionId !== d.connectionId || v.deliveryId !== d.deliveryId)) throw Error('Delivery identifiers do not match the authenticated envelope.');
      state.connections ??= {};
      const existing = state.connections[d.connectionId];
      if (existing && existing.token !== p.token) throw Error('Delivery conflicts with a stored connection.');
      state.connections[d.connectionId] = { token: p.token, externalAccountRef: p.externalAccountRef, deliveryId: d.deliveryId };
      // The storage hook must durably commit before resolving. An interrupted acknowledgement replays safely.
      await save(state);
      await this.request(`/v3/service/deliveries/${d.deliveryId}/acknowledgement`, state.serviceToken, {});
    }
    count += page.deliveries.length;
    if (!page.hasMore) break;
    }
    return count;
  }
}
