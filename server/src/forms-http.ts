import { Express, Request } from 'express';
import { z } from 'zod';
import { Forms } from './forms.js';
import { formSchema, observationSchema, submissionSchema, webhookSchema } from './forms-model.js';
import { idSchema } from './model.js';
import { EventStreams } from './event-streams.js';

export function mountForms(app: Express, forms: Forms, owner: (req: Request) => Promise<{ uid: string }>, bearer: (req: Request) => string, agentRead: (req: Request) => Promise<string>, sseDurationMs = 100_000) {
  const streams = new EventStreams(forms);
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
  const cursor = (req: Request) => z.string().max(128).optional().parse(req.query.cursor ?? req.get('Last-Event-ID'));
  app.get('/v2/events', async (req, res) => { res.json(await forms.events(await agentRead(req), cursor(req))); });
  app.get('/v2/events/stream', async (req, res) => {
    let closed = res.destroyed, timer: ReturnType<typeof setTimeout> | undefined, resume: (() => void) | undefined;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined, destroyTimer: ReturnType<typeof setTimeout> | undefined;
    let release: Awaited<ReturnType<typeof forms.relay.access.stream>> | undefined;
    let releasing = false;
    let feed: Awaited<ReturnType<EventStreams['subscribe']>> | undefined;
    const cancellation = new AbortController();
    const detach = () => {
      clearTimeout(timer); clearTimeout(deadlineTimer); resume?.();
      cancellation.abort(); feed?.stop();
      // Deadline and response close can both detach. Start the storage release
      // once so completion observers join its actual transaction.
      if (release && !releasing) { releasing = true; void release().catch(() => {}); } // Lease expiry recovers unavailable storage.
    };
    res.once('close', () => { closed = true; detach(); clearTimeout(destroyTimer); });
    const stop = () => {
      closed = true; detach();
      if (!res.destroyed) {
        res.end();
        // Bound a backpressured response independently of any pending database read.
        destroyTimer ??= setTimeout(() => res.destroy(), 1000);
      }
    };
    const secret = await agentRead(req); let next = cursor(req);
    let page = await forms.events(secret, next);
    const { grant } = await forms.db.runTransaction(tx => forms.relay.agent(tx, secret));
    release = await forms.relay.access.stream(grant.ownerId, grant.id, sseDurationMs);
    const remaining = Math.max(0, release.deadline - forms.relay.now());
    if (closed || !remaining) { detach(); if (!closed) res.end(); return; }
    deadlineTimer = setTimeout(stop, remaining);
    try {
      // A deadline or disconnect detaches even while the watch is initializing.
      feed = await streams.subscribe(secret, { changed: () => resume?.(), closed: stop }, cancellation.signal);
      if (closed || feed.failed()) return;
      const tail = async () => {
        const sequence = next ? Number(next.slice(-16)) : 0;
        const events = feed!.tail(sequence), oldest = feed!.oldest();
        return events.length && oldest !== undefined && sequence < oldest - 1
          ? forms.events(secret, next) : { events, cursor: next ?? null };
      };
      res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-store', 'X-Accel-Buffering': 'no' }); res.flushHeaders();
      if (!res.write('retry: 1000\n\n')) { stop(); return; }
      while (!closed && !feed.failed()) {
        const revision = feed.revision();
        for (const e of page.events) {
          if (closed || feed.failed()) break;
          if (!res.write(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)) { stop(); break; }
          next = e.id;
        }
        if (closed || feed.failed()) break;
        // Replay is paginated from durable storage; the bounded tail handles steady-state delivery.
        if (page.events.length === 100) { page = await forms.events(secret, next); continue; }
        page = await tail();
        if (closed || feed.failed()) break;
        if (page.events.length) continue;
        if (!res.write(': heartbeat\n\n')) { stop(); break; }
        await new Promise<void>(resolve => {
          const done = () => { clearTimeout(timer); resume = undefined; resolve(); };
          resume = done;
          timer = setTimeout(done, 1000);
          if (closed || feed!.failed() || feed!.revision() !== revision) done();
        });
        if (!closed && !feed.failed()) page = await tail();
      }
    } catch { /* revoked credentials or unavailable storage: reconnect and authenticate again */ }
    finally { stop(); }
  });
}
