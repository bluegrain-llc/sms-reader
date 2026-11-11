import type { Express, Request } from 'express';
import { idSchema } from './model.js';
import type { Onboarding } from './onboarding.js';
export function mountOnboarding(app: Express, o: Onboarding, owner: (r: Request) => Promise<{ uid: string }>, bearer: (r: Request) => string) {
  const id = (r: Request) => idSchema.parse(r.params.id);
  app.post('/v3/registration-sessions', async (r, s) => { s.status(201).json(await o.register(bearer(r), r.ip ?? 'unknown', r.body)); });
  app.get('/v3/registration-sessions/current', async (r, s) => { s.json(await o.registrationPoll(bearer(r))); });
  app.get('/v3/registration-sessions/:id', async (r, s) => { s.json(await o.registrationReview((await owner(r)).uid, id(r))); });
  app.post('/v3/registration-sessions/:id/decision', async (r, s) => { s.json(await o.registrationDecide((await owner(r)).uid, id(r), r.body)); });
  app.get('/v3/services', async (r, s) => { s.json(await o.listServices((await owner(r)).uid)); });
  app.get('/v3/services/:id', async (r, s) => { await owner(r); s.json(await o.publicService(id(r))); });
  app.patch('/v3/services/:id', async (r, s) => { s.json(await o.manageService((await owner(r)).uid, null, id(r), r.body)); });
  app.delete('/v3/services/:id', async (r, s) => { s.json(await o.manageService((await owner(r)).uid, null, id(r), { delete: true })); });
  app.post('/v3/services/:id/connections', async (r, s) => { s.status(201).json(await o.pairing(null, (await owner(r)).uid, id(r), r.body)); });
  app.patch('/v3/service', async (r, s) => { s.json(await o.manageService(null, bearer(r), null, r.body)); });
  app.post('/v3/service/pairing-sessions', async (r, s) => { s.status(201).json(await o.pairing(bearer(r), null, null, r.body)); });
  app.get('/v3/service/pairing-sessions/:id', async (r, s) => { s.json(await o.pairingPoll(bearer(r), id(r))); });
  app.get('/v3/pairing-sessions/:id', async (r, s) => { s.json(await o.pairingReview((await owner(r)).uid, id(r))); });
  app.post('/v3/pairing-sessions/:id/decision', async (r, s) => { s.json(await o.pairingDecide((await owner(r)).uid, id(r), r.body)); });
  app.get('/v3/service/deliveries', async (r, s) => { s.json(await o.deliveries(bearer(r))); });
  app.post('/v3/service/deliveries/:id/acknowledgement', async (r, s) => { s.json(await o.acknowledge(bearer(r), id(r))); });
  app.get('/v3/service/connections/:id', async (r, s) => { s.json(await o.connectionStatus(null, null, id(r), bearer(r))); });
  app.get('/v3/connection', async (r, s) => { s.json(await o.connectionStatus(bearer(r), null, null)); });
  app.get('/v3/connections/:id', async (r, s) => { s.json(await o.connectionStatus(null, (await owner(r)).uid, id(r))); });
  app.patch('/v3/connections/:id', async (r, s) => { s.json(await o.manageConnection((await owner(r)).uid, id(r), r.body)); });
  app.delete('/v3/connections/:id', async (r, s) => { s.json(await o.disconnect((await owner(r)).uid, id(r))); });
}
