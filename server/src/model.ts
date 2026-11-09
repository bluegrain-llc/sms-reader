import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';

export const MINUTE = 60_000;
export const HISTORY = 7 * 24 * 60 * MINUTE;
export const statuses = ['queued', 'pending_phone', 'ready', 'awaiting_consent', 'completed', 'denied', 'cancelled', 'expired', 'failed'] as const;
export type Status = typeof statuses[number];
export const active = (s: Status) => ['queued', 'pending_phone', 'ready', 'awaiting_consent'].includes(s);
export const idSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
export const codeSchema = z.string().regex(/^(?=[A-Za-z0-9]{4,10}$)(?=.*[0-9])[A-Za-z0-9]+$/);
export const requestSchema = z.object({
  purpose: z.string().trim().min(1).max(4000).describe("Markdown explanation shown on the phone; pass the contents of your .md file"),
  title: z.string().trim().min(1).max(80).optional().describe("Short request title shown after the bot name"),
  senderPhone: z.string().regex(/^\+[1-9][0-9]{5,14}$/).optional(),
  idempotencyKey: z.string().min(8).max(128),
}).strict();
export type RequestInput = z.infer<typeof requestSchema>;
export interface Rate { start: number; count: number }
export interface Device {
  id: string; ownerId: string; name: string; fcmToken: string;
  paused: boolean; deleted: boolean; activeRequestId: string | null;
  rate: Rate; updatedAt: number;
  listenerUntil?: number; formListenerUntil?: number; wizardVersion?: 1 | null;
}
export interface Grant {
  id: string; ownerId: string; deviceId: string; callerName: string;
  revoked: boolean; expiresAt: number; createdAt: number; rate: Rate;
  managerId?: string; callerId?: string; formRate?: Rate;
}
export interface Account { formListenerRequestId?: string; formListenerUntil?: number; deleting?: boolean; activeRequestId?: string | null; queueIds?: string[]; hasWork?: boolean; formRate?: Rate; rate?: Rate; connectionRate?: Rate }
export interface PhoneState {
  status: Status; reason: string | null; listeningDeadline: number | null;
  sent: boolean; lease: number; attempts: number; nextAt: number;
}
export interface CodeRequest {
  id: string; ownerId: string; deviceId: string; grantId: string; callerName: string;
  purpose: string; title?: string; submissionSource?: 'android_consent' | 'manual'; senderPhone: string | null; fingerprint: string;
  status: Status; reason: string | null; createdAt: number; expiresAt: number;
  listeningDeadline: number | null; resultExpiresAt: number | null;
  notificationSent: boolean; notificationLease: number; notificationAttempts: number;
  nextNotificationAt: number; purgeAt: Date;
  deviceIds?: string[]; phones?: Record<string, PhoneState>; completedByDeviceId?: string;
}
export class RelayError extends Error {
  constructor(public status: number, public reason: string) { super(reason); }
}
export function ensure(ok: unknown, status: number, reason: string): asserts ok {
  if (!ok) throw new RelayError(status, reason);
}
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const newSecret = () => `smsr_${randomBytes(32).toString('base64url')}`;
export function bump(rate: Rate, now: number, max: number): Rate {
  const next = now - rate.start >= 10 * MINUTE ? { start: now, count: 1 } : { start: rate.start, count: rate.count + 1 };
  ensure(next.count <= max, 429, 'rate_limited');
  return next;
}
export function deadline(r: CodeRequest): number {
  return Math.min(r.expiresAt, r.listeningDeadline ?? r.expiresAt);
}
export function view(r: CodeRequest) {
  return { requestId: r.id, status: r.status, reason: r.reason, expiresAt: r.expiresAt,
    listeningDeadline: r.listeningDeadline, resultExpiresAt: r.resultExpiresAt };
}
