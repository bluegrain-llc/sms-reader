import { createServer } from 'node:http';
import { timingSafeEqual, createHash } from 'node:crypto';
import { initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { callbackOutcome, clientDisconnectedBeforeResponse, eventMetadata, verifySignature } from './core.mjs';

if (!process.env.GOOGLE_CLOUD_PROJECT || !/^[A-Za-z0-9_-]{43}$/.test(process.env.CALLBACK_ADMIN_SECRET ?? '') || !process.env.GOOGLE_CLOUD_PROJECT.match(/staging|-stg/) || process.env.FIRESTORE_EMULATOR_HOST) throw new Error('staging_receiver_configuration_required');
initializeApp({ projectId: process.env.GOOGLE_CLOUD_PROJECT });
const db = getFirestore();
const digest = v => createHash('sha256').update(v).digest();
const authenticated = req => timingSafeEqual(digest(req.headers.authorization ?? ''), digest(`Bearer ${process.env.CALLBACK_ADMIN_SECRET}`));
const allowedModes = new Set(['success', 'fail-once', 'timeout-once']);
const json = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
const server = createServer(async (req, res) => {
  try {
    const match = /^\/(admin|hooks)\/([a-f0-9-]{36})$/.exec(req.url ?? '');
    if (!match) return json(res, 404, { error: 'not_found' });
    const [, kind, id] = match, ref = db.collection('acceptanceCallbacks').doc(id);
    if (kind === 'admin' && !authenticated(req)) return json(res, 401, { error: 'unauthorized' });
    if (kind === 'admin' && req.method === 'GET') {
      const run = (await ref.get()).data();
      return run ? json(res, 200, { receipts: run.receipts ?? [] }) : json(res, 404, { error: 'not_found' });
    }
    if (kind === 'admin' && req.method === 'DELETE') { await ref.delete(); return json(res, 200, { ok: true }); }
    if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 32_768) { req.destroy(); return; } chunks.push(chunk); }
    const body = Buffer.concat(chunks);
    if (kind === 'admin') {
      const input = JSON.parse(body);
      if (typeof input.secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.secret) || !allowedModes.has(input.mode)) return json(res, 400, { error: 'invalid_input' });
      await ref.create({ secret: input.secret, mode: input.mode, receipts: [], purgeAt: new Date(Date.now() + 86_400_000) });
      return json(res, 201, { ok: true });
    }
    const run = (await ref.get()).data();
    if (!run || run.purgeAt.toMillis() <= Date.now()) return json(res, 404, { error: 'not_found' });
    if (!verifySignature(run.secret, req.headers['relay-timestamp'], body, req.headers['relay-signature'])) return json(res, 401, { error: 'invalid_signature' });
    const event = eventMetadata(JSON.parse(body));
    if (req.headers['relay-event-id'] !== event.id) return json(res, 400, { error: 'event_id_mismatch' });
    const outcome = await db.runTransaction(async tx => {
      const fresh = (await tx.get(ref)).data();
      if (!fresh || fresh.purgeAt.toMillis() <= Date.now()) return null;
      const receipts = fresh.receipts ?? [];
      if (receipts.length >= 100) return null;
      const attempt = receipts.filter(r => r.id === event.id).length + 1;
      const mode = fresh.mode;
      const { status, timeout } = callbackOutcome(mode, attempt);
      tx.update(ref, { receipts: FieldValue.arrayUnion({ ...event, attempt, status, at: Date.now() }) });
      return { status, timeout, attempt };
    });
    if (!outcome) return json(res, 410, { error: 'fixture_expired_or_full' });
    if (outcome.timeout) {
      const clientClosedBeforeResponse = await clientDisconnectedBeforeResponse(res);
      await db.runTransaction(async tx => {
        const latest = (await tx.get(ref)).data();
        if (latest) tx.update(ref, { receipts: latest.receipts.map(r => r.id === event.id && r.attempt === 1 ? { ...r, clientClosedBeforeResponse } : r) });
      });
      if (clientClosedBeforeResponse) return;
    }
    const responseFinished = await new Promise(resolve => {
      const done = finished => { clearTimeout(timer); res.removeListener('finish', finish); res.removeListener('close', close); resolve(finished); };
      const finish = () => done(true), close = () => done(res.writableFinished);
      const timer = setTimeout(() => done(false), 1000);
      res.once('finish', finish); res.once('close', close);
      if (res.destroyed) close(); else { res.writeHead(outcome.status); res.end(); }
    });
    await db.runTransaction(async tx => {
      const latest = (await tx.get(ref)).data();
      if (latest) tx.update(ref, { receipts: latest.receipts.map(r => r.id === event.id && r.attempt === outcome.attempt ? { ...r, responseFinished } : r) });
    });
  } catch { if (!res.headersSent) json(res, 500, { error: 'probe_failed' }); }
});
server.requestTimeout = 20_000;
server.listen(Number(process.env.PORT ?? 8080), '0.0.0.0');
process.on('SIGTERM', () => server.close());
