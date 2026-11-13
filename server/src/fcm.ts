import { randomUUID } from 'node:crypto';
import { request, type RequestOptions } from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { TLSSocket } from 'node:tls';
import { GoogleAuth } from 'google-auth-library';
import { FirebaseMessagingError, MessagingErrorCode } from 'firebase-admin/messaging';
import type { Notify } from './relay.js';
import { category, telemetry, type Telemetry } from './telemetry.js';

export const FCM_DEADLINE_MS = 10_000; // Shorter than either delivery lease (60 seconds).
const MAX_RESPONSE_BYTES = 64 * 1024;
type Request = (url: URL, options: RequestOptions, response: (value: IncomingMessage) => void) => ClientRequest;
interface Options {
  projectId?: string;
  auth?: Pick<GoogleAuth, 'getRequestHeaders' | 'getProjectId'>;
  request?: Request;
  telemetry?: Telemetry;
  deadlineMs?: number;
}
function failure(code: MessagingErrorCode) {
  return new FirebaseMessagingError({ code, message: 'FCM delivery failed' });
}
function responseError(status: number, body: unknown) {
  const error = (body as { error?: { status?: string; details?: { '@type'?: string; errorCode?: string }[] } })?.error;
  const code = Array.isArray(error?.details)
    ? error.details.find(d => d?.['@type'] === 'type.googleapis.com/google.firebase.fcm.v1.FcmError')?.errorCode ?? error.status
    : error?.status;
  const codes: Record<string, MessagingErrorCode> = {
    UNREGISTERED: MessagingErrorCode.REGISTRATION_TOKEN_NOT_REGISTERED,
    NOT_FOUND: MessagingErrorCode.REGISTRATION_TOKEN_NOT_REGISTERED,
    QUOTA_EXCEEDED: MessagingErrorCode.MESSAGE_RATE_EXCEEDED,
    RESOURCE_EXHAUSTED: MessagingErrorCode.MESSAGE_RATE_EXCEEDED,
    UNAVAILABLE: MessagingErrorCode.SERVER_UNAVAILABLE,
    INTERNAL: MessagingErrorCode.INTERNAL_ERROR,
    INVALID_ARGUMENT: MessagingErrorCode.INVALID_ARGUMENT,
    SENDER_ID_MISMATCH: MessagingErrorCode.MISMATCHED_CREDENTIAL,
    PERMISSION_DENIED: MessagingErrorCode.MISMATCHED_CREDENTIAL,
    THIRD_PARTY_AUTH_ERROR: MessagingErrorCode.THIRD_PARTY_AUTH_ERROR,
    APNS_AUTH_ERROR: MessagingErrorCode.THIRD_PARTY_AUTH_ERROR,
    UNAUTHENTICATED: MessagingErrorCode.THIRD_PARTY_AUTH_ERROR,
  };
  return failure((code && Object.hasOwn(codes, code) ? codes[code] : undefined) ?? ({
    400: MessagingErrorCode.INVALID_ARGUMENT, 401: MessagingErrorCode.AUTHENTICATION_ERROR,
    403: MessagingErrorCode.AUTHENTICATION_ERROR, 429: MessagingErrorCode.MESSAGE_RATE_EXCEEDED,
    500: MessagingErrorCode.INTERNAL_ERROR, 503: MessagingErrorCode.SERVER_UNAVAILABLE,
  } as Record<number, MessagingErrorCode>)[status] ?? MessagingErrorCode.UNKNOWN_ERROR);
}
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    // GoogleAuth does not expose cancellation for credential discovery/refresh.
    // Observe its eventual rejection, but never attach a provider send to late auth.
    work.then(value => signal.aborted ? reject(signal.reason) : resolve(value), reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}

/** One authenticated HTTP v1 attempt. Durable delivery jobs own retries, never Retry-After. */
export class FcmNotifier {
  private auth: Pick<GoogleAuth, 'getRequestHeaders' | 'getProjectId'>;
  private request: Request;
  private telemetry: Telemetry;
  private deadlineMs: number;
  private active = new Set<AbortController>();
  private closed = false;
  constructor(options: Options = {}) {
    // Keep Firebase's configured project/environment precedence; GoogleAuth alone prefers GCLOUD_PROJECT.
    this.auth = options.auth ?? new GoogleAuth({ projectId: options.projectId || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT,
      scopes: ['https://www.googleapis.com/auth/firebase.messaging'] });
    this.request = options.request ?? request;
    this.telemetry = options.telemetry ?? telemetry;
    this.deadlineMs = options.deadlineMs ?? FCM_DEADLINE_MS;
    if (!(this.deadlineMs > 0 && this.deadlineMs <= FCM_DEADLINE_MS)) throw Error('invalid_fcm_deadline');
  }
  close() {
    this.closed = true;
    for (const controller of this.active) controller.abort(Object.assign(Error('FCM cancelled'), { code: 'ETIMEDOUT' }));
  }
  notify: Notify = async (token, requestId, ttl, kind) => {
    const started = performance.now(), expiresAt = Date.now() + ttl, deadline = started + this.deadlineMs, controller = new AbortController();
    const timeout = Object.assign(Error('FCM deadline exceeded'), { code: 'ETIMEDOUT' });
    const check = () => {
      if (performance.now() >= deadline) controller.abort(timeout);
      if (this.closed && !controller.signal.aborted) controller.abort(timeout);
      controller.signal.throwIfAborted();
    };
    const timer = setTimeout(() => controller.abort(timeout), this.deadlineMs);
    this.active.add(controller);
    const attemptId = randomUUID(); let httpAttempts = 0, accepted = false, error: unknown;
    const emit = (phase: 'started' | 'http_started' | 'completed' | 'transport_closed') => this.telemetry.emit({ event: 'fcm_send', phase,
      attempt_id: attemptId, kind: kind ?? 'sms', duration_ms: Math.max(0, performance.now() - started), http_attempts: httpAttempts,
      ...(phase === 'completed' ? { outcome: accepted ? 'accepted' as const : 'failed' as const,
        ...(accepted ? {} : { category: category(error) }) } : {}) });
    emit('started');
    try {
      check();
      const project = await abortable(this.auth.getProjectId(), controller.signal);
      check();
      if (!project) throw failure(MessagingErrorCode.AUTHENTICATION_ERROR);
      const url = new URL(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(project)}/messages:send`);
      const authHeaders = await abortable(this.auth.getRequestHeaders(url.href), controller.signal);
      check();
      const authorization = authHeaders.get('authorization'), quotaProject = authHeaders.get('x-goog-user-project');
      if (!authorization?.startsWith('Bearer ')) throw failure(MessagingErrorCode.AUTHENTICATION_ERROR);
      if (!Number.isFinite(ttl) || ttl < 0) throw failure(MessagingErrorCode.INVALID_ARGUMENT);
      const seconds = Math.floor(ttl / 1000), nanos = Math.floor((ttl - seconds * 1000) * 1_000_000);
      const body = JSON.stringify({ message: { token, data: { requestId, ...(kind ? { kind } : {}) }, android: {
        priority: 'high', ttl: `${seconds}${nanos ? '.' + String(nanos).padStart(9, '0') : ''}s`, collapse_key: requestId,
      }, apns: { headers: { 'apns-push-type': 'alert', 'apns-priority': '10',
        'apns-expiration': String(Math.floor(expiresAt / 1000)), 'apns-collapse-id': requestId },
      payload: { aps: { alert: { title: 'Request Relay', body: 'Open Inbox to review a request.' }, sound: 'default' } } } } });
      check();
      await new Promise<void>((resolve, reject) => {
        let assignedSocket = false, closed = false;
        const transportClosed = () => { if (!closed) { closed = true; emit('transport_closed'); } };
        const req = this.request(url, {
          method: 'POST', agent: false, signal: controller.signal,
          headers: { Authorization: authorization, ...(quotaProject ? { 'x-goog-user-project': quotaProject } : {}), 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        }, res => {
          const chunks: Buffer[] = []; let size = 0;
          res.on('error', reject);
          res.on('aborted', () => reject(failure(MessagingErrorCode.SERVER_UNAVAILABLE)));
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_RESPONSE_BYTES) req.destroy(failure(MessagingErrorCode.INTERNAL_ERROR));
            else chunks.push(chunk);
          });
          res.on('end', () => {
            try {
              check(); let value: unknown;
              try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { value = null; }
              if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300 || (value as { error?: unknown } | null)?.error) throw responseError(res.statusCode ?? 0, value);
              if (typeof (value as { name?: unknown } | null)?.name !== 'string') throw failure(MessagingErrorCode.INTERNAL_ERROR);
              resolve();
            } catch (error) { reject(error); }
          });
        });
        req.on('error', reject);
        req.on('close', () => { if (!assignedSocket) transportClosed(); });
        // Do not enqueue headers/body while DNS/TLS is pending. Check the same
        // monotonic deadline at the final write, including a delayed connection.
        req.on('socket', socket => {
          assignedSocket = true; socket.once('close', transportClosed);
          const send = () => { try { check(); if (req.destroyed) throw failure(MessagingErrorCode.SERVER_UNAVAILABLE); httpAttempts = 1; emit('http_started'); check(); req.end(body); } catch (error) { req.destroy(error as Error); } };
          if (socket instanceof TLSSocket) socket.once('secureConnect', send);
          else if (socket.connecting) socket.once('connect', send);
          else send();
        });
      });
      accepted = true;
    } catch (caught) {
      if (!controller.signal.aborted) controller.abort(caught);
      error = controller.signal.reason;
      throw error;
    } finally {
      clearTimeout(timer); this.active.delete(controller); emit('completed');
    }
  };
}
