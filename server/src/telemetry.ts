import { dueSmsQueries } from './delivery-queries.js';
import type { Request, Response, NextFunction } from 'express';
import type { Firestore, Query } from 'firebase-admin/firestore';

export type Kind = 'sms' | 'form' | 'webhook';
export type Category = 'quota' | 'timeout' | 'destination' | 'rejected' | 'unavailable' | 'internal';
type Event =
  | { event: 'onboarding_outcome'; phase: 'registration' | 'approval' | 'delivery' | 'setup'; outcome: string; count: number }
  | { event: 'http_completed'; method: string; route: string; status_class: string; duration_ms: number }
  | { event: 'delivery_attempt'; kind: Kind; outcome: 'accepted' | 'failed'; category?: Category; age_ms: number }
  | { event: 'wakeup_failed'; category: Category }
  | { event: 'maintenance_completed'; duration_ms: number }
  | { event: 'deletion_failed' | 'maintenance_failed' | 'backlog_sampling_failed' | 'request_failed' | 'mcp_tool_failed'; category: Category }
  | { event: 'backlog_snapshot'; kind: Kind | 'results' | 'form_results' | 'deletion' | 'legacy_deletion'; count: number; oldest_due_age_s: number };
export type Sink = (entry: Readonly<Event & { severity: 'INFO' | 'WARNING' | 'ERROR'; component: 'relay' }>) => void;
const defaultSink: Sink = entry => console.info(JSON.stringify(entry));
/** Only fixed-schema fields reach logs. Never include raw errors, URLs, headers or document identities. */
export class Telemetry {
  constructor(readonly sink: Sink = defaultSink, readonly now = Date.now) {}
  emit(event: Event) {
    const severity = event.event.endsWith('_failed') ? 'ERROR' : event.event === 'delivery_attempt' && event.outcome === 'failed' ? 'WARNING' : 'INFO';
    try { this.sink({ ...event, component: 'relay', severity }); } catch { /* Logging failure must not change committed outcomes. */ }
  }
  http = (req: Request, res: Response, next: NextFunction) => {
    const started = this.now();
    let lifecycle: Extract<Event, {event:'onboarding_outcome'}> | undefined;
    const originalJson = res.json.bind(res);
    res.json = body => {
      lifecycle = onboardingOutcome(typeof req.route?.path === 'string' ? req.route.path : '', req.method, res.statusCode, body);
      return originalJson(body);
    };
    res.once('finish', () => {
      // Route templates come from Express registration, never the caller's path/query.
      const registered: unknown = req.route?.path;
      const route = typeof registered === 'string' ? registered : Array.isArray(registered) ? (req.path.startsWith('/mcp/services/') ? '/mcp/services/:serviceId' : req.path === '/mcp' ? '/mcp' : '/health') : 'unmatched';
      const method = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(req.method) ? req.method : 'OTHER';
      if (lifecycle) this.emit(lifecycle);
      this.emit({ event: 'http_completed', method, route, status_class: `${Math.floor(res.statusCode / 100)}xx`, duration_ms: Math.max(0, this.now() - started) });
    });
    next();
  };
  delivery(kind: Kind, createdAt: number, outcome: 'accepted' | 'failed', error?: unknown) {
    this.emit({ event: 'delivery_attempt', kind, outcome,
      ...(outcome === 'accepted' ? {} : { category: category(error) }), age_ms: Math.max(0, this.now() - createdAt) });
  }
  async maintenance(work: () => Promise<void>, db: Firestore) {
    const started = this.now();
    try { await work(); }
    catch (error) { this.emit({ event: 'maintenance_failed', category: category(error) }); throw error; }
    try { await this.backlogs(db); }
    catch (error) { this.emit({ event: 'backlog_sampling_failed', category: category(error) }); }
    this.emit({ event: 'maintenance_completed', duration_ms: Math.max(0, this.now() - started) });
  }
  async backlogs(db: Firestore) {
    const now = this.now();
    const sample = async (kind: Extract<Event, { event: 'backlog_snapshot' }>['kind'], query: Query, field: string) => {
      query = kind === 'sms' ? query : query.orderBy(field);
      const [count, first] = await Promise.all([query.count().get(), query.limit(1).get()]);
      const value = first.docs[0]?.get(field);
      const time = typeof value === 'number' ? value : value?.toMillis?.();
      return { kind, count: count.data().count, oldest_due_age_s: Number.isFinite(time) ? Math.max(0, Math.floor((now - time) / 1000)) : 0 };
    };
    const samples = await Promise.all([
      sample('form', db.collection('deliveryOutbox').where('nextAt', '<=', now), 'nextAt'),
      sample('results', db.collection('results').where('purgeAt', '<=', new Date(now)), 'purgeAt'),
      sample('form_results', db.collection('formResults').where('purgeAt', '<=', new Date(now)), 'purgeAt'),
      sample('legacy_deletion', db.collection('deletionAttempts').where('nextAt', '<=', now), 'nextAt'),
      sample('deletion', db.collection('deletionJobs').where('backlogAt', '<=', now), 'backlogAt'),
      ...dueSmsQueries(db, now).map(query => sample('sms', query, 'nextNotificationAt')),
    ]);
    const combined = new Map<string, typeof samples[number]>();
    for (const sample of samples) {
      const previous = combined.get(sample.kind);
      combined.set(sample.kind, { ...sample, count: sample.count + (previous?.count ?? 0),
        oldest_due_age_s: Math.max(sample.oldest_due_age_s, previous?.oldest_due_age_s ?? 0) });
    }
    for (const sample of combined.values()) this.emit({ event: 'backlog_snapshot', ...sample });
  }
}
export function category(error: unknown): Category {
  const message = error instanceof Error ? error.message : undefined;
  const reason = error && typeof error === 'object' ? (error as { reason?: unknown }).reason : undefined;
  if (message === 'webhook_timeout' || message === 'webhook_dns_timeout') return 'timeout';
  if (message === 'webhook_rejected') return 'rejected';
  if (reason === 'private_webhook_destination' || reason === 'invalid_webhook_url') return 'destination';
  const code: unknown = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  if (['resource-exhausted', 'messaging/quota-exceeded', 'messaging/message-rate-exceeded', 'messaging/device-message-rate-exceeded', 'messaging/topics-message-rate-exceeded', 8, 429].includes(code as string | number)) return 'quota';
  if (['ETIMEDOUT', 'deadline-exceeded', 4].includes(code as string | number)) return 'timeout';
  if (['messaging/registration-token-not-registered', 'messaging/invalid-registration-token'].includes(code as string)) return 'destination';
  if (['unavailable', 'messaging/server-unavailable', 'ECONNRESET', 'ECONNREFUSED', 14, 503].includes(code as string | number)) return 'unavailable';
  return 'internal';
}
export const telemetry = new Telemetry();

/** Counts observed API outcomes, including retries; no account or payload dimensions. */
export function onboardingOutcome(route: string, method: string, status: number, value: any): Extract<Event, {event:'onboarding_outcome'}> | undefined {
  const phase = route.startsWith('/v3/registration-sessions') ? 'registration'
    : route.startsWith('/v3/pairing-sessions') || route.startsWith('/v3/service/pairing-sessions') || route.startsWith('/v3/oauth/sessions') || route === '/v3/services/:id/connections' ? 'approval'
    : route.startsWith('/v3/service/deliveries') ? 'delivery'
    : method === 'GET' && ['/v3/connection','/v3/connections/:id','/v3/service/connections/:id'].includes(route) ? 'setup' : undefined;
  if (!phase) return;
  const candidate = status >= 400 ? (['session_expired','delivery_expired'].includes(value?.error) ? 'expired' : 'failed')
    : phase === 'delivery' ? (route.endsWith('/acknowledgement') ? 'acknowledged' : 'available')
    : phase === 'setup' ? value?.setup : value?.status ?? (value?.redirect ? 'decided' : 'pending');
  const outcome = ['pending','approved','denied','expired','available','acknowledged','phone_setup_needed','waiting_for_service','setup_complete','disconnected','failed','decided'].includes(candidate) ? candidate : 'failed';
  return {event:'onboarding_outcome',phase,outcome,count:phase==='delivery' && outcome==='available' ? Math.min(100,Array.isArray(value?.deliveries)?value.deliveries.length:0) : 1};
}
