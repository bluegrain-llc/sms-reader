import express, { type Express, type Request } from 'express';
import { z, ZodError } from 'zod';
import { ensure, hash, idSchema, RelayError } from './model.js';
import type { Relay } from './relay.js';
import { OAuth } from './oauth.js';
import { telemetry, category } from './telemetry.js';

export function mountOAuth(app: Express, relay: Relay, base: string | undefined, owner: (r: Request) => Promise<{ uid: string }>) {
  if (!base) return;
  const o = new OAuth(relay, base);
  app.get('/.well-known/oauth-authorization-server', (_r, s) => { s.json(o.metadata()); });
  app.get('/.well-known/oauth-protected-resource/mcp/services/:id', async (r, s) => {
    const id = idSchema.parse(r.params.id), service = await relay.onboarding.publicService(id);
    s.json({ resource: o.resource(id), authorization_servers: [o.base], bearer_methods_supported: ['header'], scopes_supported: service.capabilities });
  });
  app.post('/oauth/register', async (r, s) => { try { s.status(201).json(await o.register(r.body, r.ip ?? 'unknown')); } catch(error) { oauthError(s,error,true); } });
  app.get('/oauth/authorize', async (r, s) => { try { s.redirect(303, await o.start(r.query, r.ip ?? 'unknown')); } catch(error) { oauthError(s,error,false); } });
  const form = express.urlencoded({ extended: false, limit: '16kb', parameterLimit: 12 });
  for (const operation of ['token', 'revoke'] as const) app.post(`/oauth/${operation}`, form, async (r, s) => {
    try {
      const input = z.record(z.string(), z.string().max(4096)).parse(r.body);
      s.json(await o[operation](input));
    } catch (error) {
      oauthError(s,error,false);
    }
  });
  app.get('/v3/oauth/sessions/:id', async (r, s) => { s.json(await o.review((await owner(r)).uid, idSchema.parse(r.params.id))); });
  app.post('/v3/oauth/sessions/:id/response', async (r, s) => { s.json(await o.response((await owner(r)).uid, idSchema.parse(r.params.id))); });
  app.post('/v3/oauth/sessions/:id/decision', async (r, s) => { s.json(await o.decide((await owner(r)).uid, idSchema.parse(r.params.id), r.body)); });
  // Resource-bound credentials cannot be used on REST, a different service, or the legacy MCP URL.
  app.use(async (r, s, next) => {
    const token = /^Bearer (smsa_[^\s]+)$/.exec(r.get('authorization') ?? '')?.[1];
    const resource = /^\/mcp\/services\/([A-Za-z0-9_-]{1,128})$/.exec(r.path);
    if (resource) {
      const challenge = `Bearer resource_metadata="${o.base}/.well-known/oauth-protected-resource/mcp/services/${resource[1]}"`;
      s.set('WWW-Authenticate', challenge);
      ensure(token, 401, 'authentication_required');
    }
    if (token) {
      ensure(resource, 401, 'invalid_token');
      await relay.db.runTransaction(async tx => {
        const access = (await tx.get(relay.ref('oauthAccess', hash(token)))).data();
        ensure(access?.resource === o.resource(resource[1]!), 401, 'invalid_token');
        await relay.agent(tx, token);
      });
    }
    next();
  });
}

function oauthError(response: express.Response, error: unknown, registration: boolean) {
  const status = error instanceof RelayError ? error.status : error instanceof ZodError ? 400 : 500;
  const reason = error instanceof RelayError ? error.reason : '';
  const standard = ['invalid_client','invalid_grant','invalid_scope','unauthorized_client','unsupported_grant_type','invalid_target','invalid_client_metadata'];
  const name = status >= 500 ? 'server_error' : status === 429 ? 'temporarily_unavailable' : standard.includes(reason) ? reason
    : reason === 'capability_not_requested' ? 'invalid_scope' : registration ? 'invalid_client_metadata' : 'invalid_request';
  if (status >= 500) telemetry.emit({event:'request_failed',category:category(error)});
  if (status === 429) response.set('Retry-After','60');
  response.status(status).json({error:name});
}
