import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Relay } from './relay.js';
import { bump, ensure, Grant, hash, HISTORY, MINUTE, newSecret } from './model.js';

export const connectionSchema = z.object({
  callerName: z.string().trim().min(1).max(80),
  purpose: z.string().trim().min(1).max(240),
  expiresInDays: z.number().int().min(1).max(90).default(30),
}).strict();
export const userCodeSchema = z.string().max(32).transform(s => s.toUpperCase().replace(/[ -]/g, ''))
  .pipe(z.string().regex(/^[A-HJ-NP-Z2-9]{10}$/));
export interface Connection {
  id: string; callerName: string; purpose: string; days: number; codeHash: string;
  status: 'pending' | 'approved' | 'denied' | 'expired'; ownerId: string | null;
  createdAt: number; expiresAt: number; grantExpiresAt: number | null; pollAfter: number; purgeAt: Date;
}
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const formatted = (code: string) => code.slice(0, 5) + '-' + code.slice(5);
export class Connections {
  constructor(readonly relay: Relay) {}
  ref(collection: string, id: string) { return this.relay.ref(collection, id); }
  now() { return this.relay.now(); }
  view(c: Connection) {
    return { connectionId: c.id, callerName: c.callerName, purpose: c.purpose,
      status: c.status, expiresAt: c.expiresAt, expiresInDays: c.days, grantExpiresAt: c.grantExpiresAt };
  }
  async start(source: string, raw: z.input<typeof connectionSchema>) {
    const input = connectionSchema.parse(raw), token = newSecret(), id = hash(token);
    const code = [...randomBytes(10)].map(n => alphabet[n % 32]).join('');
    await this.relay.db.runTransaction(async tx => {
      const window = Math.floor(this.now() / (10 * MINUTE));
      const limits = [{ id: hash(`source:${source}:${window}`), max: 60 }, { id: `global-${window}`, max: 600 }];
      const rates = await Promise.all(limits.map(x => tx.get(this.ref('connectionRates', x.id))));
      const codeRef = this.ref('connectionCodes', hash(code));
      const old = await tx.get(codeRef); ensure(!old.exists, 409, 'connection_code_collision');
      const c: Connection = { id, callerName: input.callerName, purpose: input.purpose, days: input.expiresInDays,
        codeHash: hash(code), status: 'pending', ownerId: null, createdAt: this.now(), expiresAt: this.now() + 10 * MINUTE,
        grantExpiresAt: null, pollAfter: 0, purgeAt: new Date(this.now() + HISTORY) };
      limits.forEach((limit, i) => tx.set(this.ref('connectionRates', limit.id), {
        ...bump(rates[i]!.data() as { start: number; count: number } | undefined ?? { start: this.now(), count: 0 }, this.now(), limit.max),
        purgeAt: new Date((window + 1) * 10 * MINUTE),
      }));
      tx.create(this.ref('connections', id), c);
      tx.create(codeRef, { connectionId: id, purgeAt: new Date(c.expiresAt), ownerId: null });
    });
    return { connectionToken: token, userCode: formatted(code), expiresAt: this.now() + 10 * MINUTE, interval: 5 };
  }
  async poll(token: string) {
    ensure(/^smsr_[A-Za-z0-9_-]{43}$/.test(token), 401, 'invalid_connection_token');
    return this.relay.db.runTransaction(async tx => {
      const ref = this.ref('connections', hash(token));
      const c = (await tx.get(ref)).data() as Connection | undefined;
      ensure(c, 401, 'invalid_connection_token');
      const g = c.status === 'approved' ? (await tx.get(this.ref('grants', c.id))).data() as Grant | undefined : undefined;
      const valid = g ? await this.relay.validGrant(tx, g) : false;
      if (c.ownerId) await this.relay.account(tx, c.ownerId);
      if (c.status === 'pending' && c.expiresAt <= this.now()) c.status = 'expired';
      ensure(c.pollAfter <= this.now(), 429, 'slow_down');
      c.pollAfter = this.now() + 5_000; tx.set(ref, c);
      return { status: c.status === 'approved' && !valid ? 'revoked' : c.status,
        expiresAt: c.expiresAt, grantExpiresAt: c.grantExpiresAt, interval: 5 };
    });
  }
  async owner(uid: string, userCode: string, decision?: 'approved' | 'denied') {
    const code = userCodeSchema.parse(userCode);
    return this.relay.db.runTransaction(async tx => {
      const account = await this.relay.account(tx, uid);
      const codeRef = this.ref('connectionCodes', hash(code)), link = (await tx.get(codeRef)).data();
      const ref = link ? this.ref('connections', link.connectionId as string) : undefined;
      const c = ref ? (await tx.get(ref)).data() as Connection | undefined : undefined;
      const grant = c?.status === 'approved' && c.ownerId === uid
        ? (await tx.get(this.ref('grants', c.id))).data() as Grant | undefined : undefined;
      const revoked = c?.status === 'approved' && !(grant && await this.relay.validGrant(tx, grant));
      const rate = bump(account.connectionRate ?? { start: this.now(), count: 0 }, this.now(), 30);
      // Count invalid lookups too: return an error after committing the counter.
      tx.set(this.ref('accounts', uid), { connectionRate: rate }, { merge: true });
      if (!c || (c.ownerId && c.ownerId !== uid)) return { error: 'connection_not_found' as const };
      if (c.status === 'pending' && c.expiresAt <= this.now()) { c.status = 'expired'; tx.set(ref!, c); }
      if (decision && c.status === 'pending') {
        c.status = decision; c.ownerId = uid;
        if (decision === 'approved') {
          c.grantExpiresAt = this.now() + c.days * 24 * 60 * MINUTE;
          tx.create(this.ref('grants', c.id), { id: c.id, ownerId: uid, deviceId: '', callerName: c.callerName, callerId: c.id,
            revoked: false, createdAt: this.now(), expiresAt: c.grantExpiresAt,
            rate: { start: this.now(), count: 0 } } satisfies Grant);
        }
        tx.set(ref!, c); tx.update(codeRef, { ownerId: uid });
      }
      return { ...this.view(c), ...(revoked ? { status: 'revoked' as const } : {}), userCode: formatted(code) };
    }).then(result => { ensure(!('error' in result), 404, 'connection_not_found'); return result; });
  }
}
