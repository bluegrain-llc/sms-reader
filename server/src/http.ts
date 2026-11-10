import { telemetry, category } from './telemetry.js';
import express, { Request, Response, NextFunction } from 'express';
import { z, ZodError } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mountAccountPages, WebConfig } from './account-pages.js';
import { mountForms } from './forms-http.js';
import { signingFingerprints } from './signing.js';
import { formSchema } from './forms-model.js';
import { Relay } from './relay.js';
import { connectionSchema, userCodeSchema } from './connections.js';
import { codeSchema, ensure, idSchema, RelayError, requestSchema } from './model.js';

export interface Identity { uid: string; authTime: number }
export interface HttpOptions {
  verifyOwner: (token: string) => Promise<Identity>;
  verifyScheduler: (token: string) => Promise<void>;
  deleteIdentity: (uid: string) => Promise<void>;
  origins?: string[];
  publicUrl?: string;
  androidCertSha256?: string;
  androidCertSha256s?: string[];
  trustProxyHops?: number;
  sseDurationMs?: number;
  firebaseWebConfig?: WebConfig;
  privacyContact?: string;
}
function bearer(req: Request) {
  const m = /^Bearer ([^\s]+)$/.exec(req.get('authorization') ?? '');
  ensure(m, 401, 'authentication_required'); return m[1]!;
}
export function app(relay: Relay, options: HttpOptions) {
  const app = express();
  app.disable('x-powered-by');
  app.use(telemetry.http);
  app.set('trust proxy', options.trustProxyHops ?? 0);
  app.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); res.set('X-Content-Type-Options', 'nosniff'); next(); });
  app.use((req, _res, next) => {
    const origin = req.get('origin');
    const accountOrigin = options.publicUrl ? new URL(options.publicUrl).origin : undefined;
    const accountRoute = /^\/v1\/account(?:-deletion)?\/?$/i.test(req.path);
    ensure(!origin || (accountRoute && origin === accountOrigin) || (options.origins ?? []).includes(origin), 403, 'origin_not_allowed'); next();
  });
  app.use(express.json({ limit: '256kb', strict: true }));
  app.get(['/health', '/healthz'], (_req, res) => { res.json({ ok: true }); });
  const owner = async (req: Request, allowDeleted = false) => {
    let identity: Identity;
    try { identity = await options.verifyOwner(bearer(req)); } catch { throw new RelayError(401, 'invalid_owner_session'); }
    if (!allowDeleted) await relay.db.runTransaction(tx => relay.account(tx, identity.uid));
    if (req.method === 'GET' || req.method === 'HEAD') await relay.access.read(identity.uid);
    return identity;
  };
  const agentRead = async (req: Request) => {
    const secret = bearer(req), { grant } = await relay.db.runTransaction(tx => relay.agent(tx, secret));
    await relay.access.read(grant.ownerId, grant.id); return secret;
  };
  mountAccountPages(app, options.firebaseWebConfig, options.privacyContact);
  app.get('/v1/account-deletion', async (req, res) => { res.json(await relay.deletions.status(bearer(req))); });
  const device = (req: Request) => idSchema.parse(req.params.deviceId);
  const request = (req: Request) => idSchema.parse(req.params.requestId);
  const body = <T extends z.ZodTypeAny>(req: Request, schema: T): z.infer<T> => schema.parse(req.body);
  mountForms(app, relay.forms, owner, bearer, options.sseDurationMs);
  app.get('/v1/devices', async (req, res) => { res.json(await relay.listDevices((await owner(req)).uid)); });
  app.put('/v1/devices/:deviceId', async (req, res) => {
    const { uid } = await owner(req);
    const b = body(req, z.object({ name: z.string().trim().min(1).max(80), fcmToken: z.string().min(1).max(4096), wizardVersion: z.literal(1).optional() }).strict());
    res.json(await relay.register(uid, device(req), b.name, b.fcmToken, b.wizardVersion));
  });
  app.patch('/v1/devices/:deviceId', async (req, res) => {
    const { uid } = await owner(req); const b = body(req, z.object({ paused: z.boolean() }).strict());
    await relay.changeDevice(uid, device(req), b.paused); res.json({ ok: true });
  });
  app.delete('/v1/devices/:deviceId', async (req, res) => {
    await relay.changeDevice((await owner(req)).uid, device(req), true, true); res.json({ ok: true });
  });
  app.get('/.well-known/assetlinks.json', (_req, res) => {
    const fingerprints = signingFingerprints(options.androidCertSha256, options.androidCertSha256s);
    res.json([{ relation: ['delegate_permission/common.handle_all_urls'], target: {
      namespace: 'android_app', package_name: 'com.bluegrain.smsrelay', sha256_cert_fingerprints: fingerprints,
    } }]);
  });
  app.get('/connect', (req, res) => {
    const code = userCodeSchema.parse(req.query.code), formatted = code.slice(0, 5) + '-' + code.slice(5);
    res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'");
    res.set('Referrer-Policy', 'no-referrer');
    res.type('html').send(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Connect SMS Code Relay</title>
      <style>body{margin:0;background:#f5f8f7;color:#142d29;font:18px/1.5 system-ui,sans-serif}main{max-width:480px;margin:12vh auto;padding:24px}small{color:#006b5e}h1{font-size:32px;line-height:1.15}code{display:block;font-size:28px;margin:24px 0}a{display:block;background:#006b5e;color:white;padding:16px;border-radius:12px;text-align:center;text-decoration:none}p{color:#4b625d}</style>
      <main><small>SMS CODE RELAY</small><h1>Connect your app.</h1><p>Open SMS Code Relay and review this connection in Admin. Compare the code with the one your app or bot shows.</p><code>${formatted}</code>
      <a href="smsrelay://connect?code=${formatted}">Open SMS Code Relay</a><p>If the app does not open, enter this code in Admin → Access. No credential needs copying.</p></main></html>`);
  });
  app.post('/v1/connections', async (req, res) => {
    ensure(options.publicUrl, 503, 'pairing_not_configured');
    const result = await relay.connections.start(req.ip ?? 'unknown', connectionSchema.parse(req.body));
    res.status(201).json({ ...result, verificationUri: options.publicUrl.replace(/\/$/, '') + '/connect?code=' + result.userCode });
  });
  app.post('/v1/connections/poll', async (req, res) => { res.json(await relay.connections.poll(bearer(req))); });
  app.post('/v1/connections/review', async (req, res) => {
    const { uid } = await owner(req);
    const b = body(req, z.object({ userCode: userCodeSchema }).strict());
    res.json(await relay.connections.owner(uid, b.userCode));
  });
  app.post('/v1/connections/decision', async (req, res) => {
    const { uid } = await owner(req);
    const b = body(req, z.object({ userCode: userCodeSchema, decision: z.enum(['approved', 'denied']) }).strict());
    res.json(await relay.connections.owner(uid, b.userCode, b.decision));
  });
  app.get('/v1/callers', async (req, res) => { res.json(await relay.listGrants((await owner(req)).uid)); });
  app.get('/v1/history', async (req, res) => { res.json(await relay.history((await owner(req)).uid)); });
  app.get('/v1/devices/:deviceId/grants', async (req, res) => {
    res.json(await relay.listGrants((await owner(req)).uid, device(req)));
  });
  app.post('/v1/devices/:deviceId/grants', async (req, res) => {
    const { uid } = await owner(req);
    const b = body(req, z.object({ callerName: z.string().trim().min(1).max(80), expiresInDays: z.number().int().min(1).max(90).default(30) }).strict());
    res.status(201).json(await relay.createGrant(uid, device(req), b.callerName, b.expiresInDays));
  });
  app.delete('/v1/grants/:grantId', async (req, res) => {
    await relay.revoke((await owner(req)).uid, idSchema.parse(req.params.grantId)); res.json({ ok: true });
  });
  app.delete('/v1/account', async (req, res) => {
    const identity = await owner(req, true);
    ensure(relay.now() / 1000 - identity.authTime < 300 && identity.authTime <= relay.now() / 1000 + 30, 401, 'recent_sign_in_required');
    await relay.access.read(identity.uid);
    res.status(202).json(await relay.deletions.request(identity.uid));
  });
  app.get('/v1/devices/:deviceId/history', async (req, res) => {
    res.json(await relay.history((await owner(req)).uid, device(req)));
  });
  app.get('/v1/devices/:deviceId/requests/:requestId', async (req, res) => {
    res.json(await relay.phoneGet((await owner(req)).uid, device(req), request(req)));
  });
  app.post('/v1/devices/:deviceId/requests/:requestId/events', async (req, res) => {
    const { uid } = await owner(req);
    const b = body(req, z.discriminatedUnion('status', [
      z.object({ status: z.literal('ready'), listenerStartedAt: z.number().int().positive() }).strict(),
      z.object({ status: z.literal('awaiting_consent') }).strict(),
      z.object({ status: z.literal('completed'), code: codeSchema, source: z.enum(['android_consent', 'manual']).optional() }).strict(),
      z.object({ status: z.literal('denied') }).strict(),
      z.object({ status: z.literal('cancelled') }).strict(),
      z.object({ status: z.literal('failed'), reason: z.enum(['play_services_unavailable', 'listener_failed', 'process_restarted', 'code_extraction_failed', 'consent_unavailable', 'notifications_disabled', 'listener_timeout']) }).strict(),
    ]));
    res.json(await relay.transition({ uid, deviceId: device(req) }, request(req), b.status,
      'reason' in b ? b.reason : null, 'code' in b ? b.code : undefined, 'listenerStartedAt' in b ? b.listenerStartedAt : undefined, 'source' in b ? b.source : undefined));
  });
  app.post('/v1/requests', async (req, res) => { res.status(201).json(await relay.create(bearer(req), requestSchema.parse(req.body))); });
  app.get('/v1/requests/:requestId', async (req, res) => { res.json(await relay.get(await agentRead(req), request(req))); });
  app.post('/v1/requests/:requestId/cancel', async (req, res) => {
    res.json(await relay.transition({ secret: bearer(req) }, request(req), 'cancelled'));
  });
  app.post('/internal/delivery', async (req, res) => {
    try { await options.verifyScheduler(bearer(req)); } catch { throw new RelayError(401, 'invalid_worker_identity'); }
    await relay.deletions.dispatch(options.deleteIdentity);
    await relay.forms.dispatch(); res.json({ ok: true });
  });
  app.post('/internal/maintenance', async (req, res) => {
    try { await options.verifyScheduler(bearer(req)); } catch { throw new RelayError(401, 'invalid_scheduler_identity'); }
    await telemetry.maintenance(async () => {
      await relay.deletions.dispatch(options.deleteIdentity);
      await relay.maintenance();
    }, relay.db); res.json({ ok: true });
  });
  app.post('/mcp', async (req, res) => {
    const secret = bearer(req); await relay.checkAgent(secret);
    // New stateless server per HTTP request; identity is never shared between clients.
    const server = new McpServer({ name: 'sms-code-relay', version: '0.6.0' });
    const readTools = new Set<string>();
    const readToolName = (name: string) => { readTools.add(name); return name; };
    const tool = (fn: () => Promise<unknown>) => fn().then(result => ({
      content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result as Record<string, unknown>,
    })).catch(error => {
      if (!(error instanceof RelayError)) telemetry.emit({ event: 'mcp_tool_failed', category: category(error) });
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: error instanceof RelayError ? error.reason : 'internal_error' }) }] };
    });
    server.registerTool('request_sms_code', {
      description: 'Notify the owner’s registered phones about an upcoming SMS, queuing behind another caller if needed. Wait for ready before triggering SMS in a separate system. First approved response wins. Never triggers SMS.',
      inputSchema: requestSchema.shape,
    }, input => tool(() => relay.create(secret, input)));
    server.registerTool(readToolName('get_sms_code_request'), {
      description: 'Poll status. Code is available only after owner approval, for two minutes.', inputSchema: { requestId: idSchema },
    }, input => tool(() => relay.get(secret, input.requestId)));
    server.registerTool('cancel_sms_code_request', {
      description: 'Cancel this token’s request.', inputSchema: { requestId: idSchema },
    }, input => tool(() => relay.transition({ secret }, input.requestId, 'cancelled')));
    server.registerTool('create_request', { description: 'Create a form or multi-step wizard with optional conditional steps and one final submission. Requires owner approval for forms in Admin.', inputSchema: formSchema.shape }, input => tool(() => relay.forms.create(secret, input)));
    server.registerTool(readToolName('inspect_request'), { description: 'Inspect your request without marking it opened.', inputSchema: { requestId: idSchema } }, input => tool(() => relay.forms.get({ secret }, input.requestId)));
    server.registerTool('cancel_request', { description: 'Cancel your pending request.', inputSchema: { requestId: idSchema } }, input => tool(() => relay.forms.cancel(secret, input.requestId)));
    server.registerTool(readToolName('get_request_result'), { description: 'Retrieve accepted answers, retained for 24 hours.', inputSchema: { requestId: idSchema } }, input => tool(() => relay.forms.result(secret, input.requestId)));
    server.registerTool(readToolName('poll_request_events'), { description: 'Poll durable events for your connection. Answers are retrieved separately.', inputSchema: { cursor: z.string().max(128).optional() } }, input => tool(() => relay.forms.events(secret, input.cursor)));
    for (const message of Array.isArray(req.body) ? req.body : [req.body]) {
      if (message?.method === 'tools/call' && readTools.has(message?.params?.name)) await agentRead(req);
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void transport.close(); void server.close(); });
    await server.connect(transport); await transport.handleRequest(req, res, req.body);
  });
  app.all('/mcp', (_req, res) => { res.status(405).json({ error: 'method_not_allowed' }); });
  app.use((_req, res) => { res.status(404).json({ error: 'not_found' }); });
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;
    if (err instanceof RelayError) { if (err.status === 429) res.set('Retry-After', '60'); res.status(err.status).json({ error: err.reason }); }
    else if (err instanceof ZodError || err instanceof SyntaxError) res.status(400).json({ error: 'invalid_input' });
    else if ((err as { type?: string })?.type === 'entity.too.large') res.status(413).json({ error: 'payload_too_large' });
    else { telemetry.emit({ event: 'request_failed', category: category(err) }); res.status(500).json({ error: 'internal_error' }); }
  });
  return app;
}
