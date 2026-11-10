import { Express, Request } from 'express';
import { z } from 'zod';
import { Forms } from './forms.js';
import { formSchema, observationSchema, submissionSchema, webhookSchema } from './forms-model.js';
import { idSchema } from './model.js';
import { EventStreams } from './event-streams.js';

export function mountForms(app: Express, forms: Forms, owner: (req: Request) => Promise<{ uid: string }>, bearer: (req: Request) => string, sseDurationMs = 100_000) {
  const streams = new EventStreams(forms);
  const id = (req: Request) => idSchema.parse(req.params.requestId);
  const phone = async (req: Request) => ({ uid: (await owner(req)).uid, deviceId: idSchema.parse(req.params.deviceId) });
  app.post('/v2/requests', async (req, res) => { res.status(201).json(await forms.create(bearer(req), formSchema.parse(req.body))); });
  app.get('/v2/requests/:requestId', async (req, res) => { res.json(await forms.get({ secret: bearer(req) }, id(req))); });
  app.get('/v2/requests/:requestId/result', async (req, res) => { res.json(await forms.result(bearer(req), id(req))); });
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
  app.get('/v2/webhooks', async (req, res) => { res.json(await forms.webhooks(bearer(req))); });
  app.delete('/v2/webhooks/:hookId', async (req, res) => { res.json(await forms.webhooks(bearer(req), idSchema.parse(req.params.hookId))); });
  const cursor = (req: Request) => z.string().max(128).optional().parse(req.query.cursor ?? req.get('Last-Event-ID'));
  app.get('/v2/events', async (req, res) => { res.json(await forms.events(bearer(req), cursor(req))); });
  app.get('/v2/events/stream', async (req, res) => {
    let closed = res.destroyed, resume: (() => void) | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    const close = () => { closed = true; clearTimeout(timer); resume?.(); };
    res.on('close', close);
    const secret = bearer(req); let next = cursor(req);
    let page = await forms.events(secret, next);
    const feed = await streams.subscribe(secret, { changed: () => resume?.(), closed: close });
    const tail = async () => {
      const sequence = next ? Number(next.slice(-16)) : 0;
      const events = feed.tail(sequence), oldest = feed.oldest();
      return events.length && oldest !== undefined && sequence < oldest - 1
        ? forms.events(secret, next) : { events, cursor: next ?? null };
    };
    try {
      if (closed || feed.failed()) return;
      res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-store', 'X-Accel-Buffering': 'no' }); res.flushHeaders();
      res.write('retry: 1000\n\n');
      const end = Date.now() + Math.min(sseDurationMs, 100_000);
      while (!closed && !feed.failed() && Date.now() < end) {
        const revision = feed.revision();
        for (const e of page.events) {
          if (closed || feed.failed()) break;
          if (!res.write(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)) { close(); break; }
          next = e.id;
        }
        if (closed || feed.failed()) break;
        // Replay is paginated from durable storage; the bounded tail handles steady-state delivery.
        if (page.events.length === 100) { page = await forms.events(secret, next); continue; }
        page = await tail();
        if (page.events.length) continue;
        if (!res.write(': heartbeat\n\n')) { close(); break; }
        await new Promise<void>(resolve => {
          const done = () => { clearTimeout(timer); resume = undefined; resolve(); };
          resume = done;
          timer = setTimeout(done, Math.min(1000, Math.max(1, end - Date.now())));
          if (closed || feed.failed() || feed.revision() !== revision) done();
        });
        page = await tail();
      }
    } finally { clearTimeout(timer); feed.stop(); res.end(); }
  });
}
