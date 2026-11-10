import { Express, Request } from 'express';
import { z } from 'zod';
import { Forms } from './forms.js';
import { formSchema, observationSchema, submissionSchema, webhookSchema } from './forms-model.js';
import { idSchema } from './model.js';

export function mountForms(app: Express, forms: Forms, owner: (req: Request) => Promise<{ uid: string }>, bearer: (req: Request) => string, sseDurationMs = 100_000) {
  const id = (req: Request) => idSchema.parse(req.params.requestId);
  const phone = async (req: Request) => ({ uid: (await owner(req)).uid, deviceId: idSchema.parse(req.params.deviceId) });
  app.post('/v2/requests', async (req, res) => { res.status(201).json(await forms.create(bearer(req), formSchema.parse(req.body))); });
  app.get('/v2/requests/:requestId', async (req, res) => { res.json(await forms.get({ secret: await agentRead(req) }, id(req))); });
  app.get('/v2/requests/:requestId/result', async (req, res) => { res.json(await forms.result(await agentRead(req), id(req))); });
  app.post('/v2/requests/:requestId/cancel', async (req, res) => { res.json(await forms.cancel(bearer(req), id(req))); });
  app.get('/v2/devices/:deviceId/inbox', async (req, res) => { const p = await phone(req); res.json(await forms.inbox(p.uid, p.deviceId)); });
  app.get('/v2/devices/:deviceId/requests/:requestId', async (req, res) => { res.json(await forms.get(await phone(req), id(req))); });
  app.post('/v2/devices/:deviceId/requests/:requestId/events', async (req, res) => { const p = await phone(req); res.json(await forms.observe(p.uid, p.deviceId, id(req), observationSchema.parse(req.body))); });
  app.post('/v2/devices/:deviceId/requests/:requestId/submissions', async (req, res) => { const p = await phone(req); res.json(await forms.submit(p.uid, p.deviceId, id(req), submissionSchema.parse(req.body))); });
  app.put('/v2/grants/:grantId/forms', async (req, res) => {
    const { approved } = z.object({ approved: z.boolean() }).strict().parse(req.body);
    await forms.approve((await owner(req)).uid, idSchema.parse(req.params.grantId), approved); res.json({ ok: true });
  });
  app.post('/v2/webhooks', async (req, res) => { res.status(201).json(await forms.registerWebhook(bearer(req), webhookSchema.parse(req.body))); });
  app.get('/v2/webhooks', async (req, res) => { res.json(await forms.webhooks(await agentRead(req))); });
  app.delete('/v2/webhooks/:hookId', async (req, res) => { res.json(await forms.webhooks(bearer(req), idSchema.parse(req.params.hookId))); });
  const agentRead = async (req: Request) => {
    const secret = bearer(req), { grant } = await forms.db.runTransaction(tx => forms.relay.agent(tx, secret));
    await forms.relay.access.read(grant.ownerId, grant.id); return secret;
  };
  const cursor = (req: Request) => z.string().max(128).optional().parse(req.query.cursor ?? req.get('Last-Event-ID'));
  app.get('/v2/events', async (req, res) => { res.json(await forms.events(await agentRead(req), cursor(req))); });
  app.get('/v2/events/stream', async (req, res) => {
    let closed = res.destroyed, timer: ReturnType<typeof setTimeout> | undefined, resume: (() => void) | undefined;
    res.on('close', () => { closed = true; clearTimeout(timer); resume?.(); });
    const secret = await agentRead(req); let next = cursor(req);
    let page = await forms.events(secret, next);
    const { grant } = await forms.db.runTransaction(tx => forms.relay.agent(tx, secret));
    const release = await forms.relay.access.stream(grant.ownerId, grant.id, sseDurationMs);
    if (closed) { await release(); return; }
    try {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-store', 'X-Accel-Buffering': 'no' }); res.flushHeaders();
    res.write('retry: 1000\n\n');
    const end = Date.now() + Math.min(sseDurationMs, 100_000);
      while (!closed && Date.now() < end) {
        for (const e of page.events) {
          if (closed) break;
          if (!res.write(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)) {
            // A slow consumer reconnects using its last received event ID.
            res.end(); closed = true; break;
          }
          next = e.id;
        }
        if (closed) break;
        res.write(': heartbeat\n\n');
        await new Promise<void>(resolve => { resume = resolve; timer = setTimeout(resolve, Math.min(1000, Math.max(1, end - Date.now()))); });
        if (!closed) page = await forms.events(secret, next);
      }
    } catch { /* revoked credentials or unavailable storage: reconnect and authenticate again */ }
    finally { clearTimeout(timer); res.end(); try { await release(); } catch { /* lease expiry recovers an unavailable store */ } }
  });
}
