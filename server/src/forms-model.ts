import { z } from 'zod';
import { ensure, idSchema } from './model.js';

export const DAY = 86_400_000;
const option = z.object({ id: idSchema, label: z.string().trim().min(1).max(160) }).strict();
const base = { id: idSchema, label: z.string().trim().min(1).max(160), required: z.boolean().default(false) };
export const fieldSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.enum(['text', 'multiline']), maxLength: z.number().int().min(1).max(4000).default(1000), input: z.literal('sms_code').optional() }).strict(),
  z.object({ ...base, type: z.literal('number'), min: z.number().finite().optional(), max: z.number().finite().optional() }).strict(),
  z.object({ ...base, type: z.literal('checkbox') }).strict(),
  z.object({ ...base, type: z.enum(['single_choice', 'multiple_choice']), options: z.array(option).min(1).max(40) }).strict(),
  z.object({ ...base, type: z.literal('date') }).strict(),
]);
export const actionSchema = z.object({ id: idSchema, label: z.string().trim().min(1).max(80), type: z.enum(['submit', 'approve', 'decline', 'acknowledge']) }).strict();
export const formSchema = z.object({
  title: z.string().trim().min(1).max(80), body: z.string().min(1).max(16000),
  fields: z.array(fieldSchema).max(30).default([]), actions: z.array(actionSchema).min(1).max(8),
  expiresInSeconds: z.number().int().min(60).max(7 * 86400).default(86400),
  idempotencyKey: z.string().min(8).max(128),
}).strict().superRefine((form, ctx) => {
  const unique = (ids: string[]) => new Set(ids).size === ids.length;
  if (!unique(form.fields.map(f => f.id)) || !unique(form.actions.map(a => a.id))) ctx.addIssue({ code: 'custom', message: 'Duplicate IDs' });
  for (const f of form.fields) {
    if ('options' in f && !unique(f.options.map(o => o.id))) ctx.addIssue({ code: 'custom', message: 'Duplicate option IDs' });
    if (f.type === 'number' && f.min !== undefined && f.max !== undefined && f.min > f.max) ctx.addIssue({ code: 'custom', message: 'Invalid number bounds' });
  }
  if (form.fields.filter(f => 'input' in f && f.input === 'sms_code').length > 1) ctx.addIssue({ code: 'custom', message: 'Only one SMS helper per request' });
});
export type Definition = z.infer<typeof formSchema>;
export type Values = Record<string, string | number | boolean | string[]>;
export const submissionSchema = z.object({ submissionId: idSchema, action: idSchema,
  values: z.record(idSchema, z.union([z.string().max(4000), z.number().finite(), z.boolean(), z.array(idSchema).max(40)])) }).strict();
export type Submission = z.infer<typeof submissionSchema>;
export const eventTypes = ['request.created', 'notification.accepted', 'notification.tapped', 'request.opened', 'input.ready', 'input.timeout', 'request.submitted', 'request.declined', 'request.cancelled', 'request.expired'] as const;
export const observationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.enum(['notification.tapped', 'request.opened']), occurredAt: z.number().int().positive().optional() }).strict(),
  z.object({ type: z.literal('input.ready'), fieldId: idSchema, listenerStartedAt: z.number().int().positive() }).strict(),
]);
export const webhookSchema = z.object({ url: z.string().url().max(2048), events: z.array(z.enum(eventTypes)).min(1).max(eventTypes.length) }).strict();
export interface FormRequest {
  id: string; ownerId: string; grantId: string; callerName: string; definition: Definition; fingerprint: string;
  status: 'pending' | 'submitted' | 'declined' | 'cancelled' | 'expired'; createdAt: number; expiresAt: number; nextCheckAt: number;
  terminatedAt: number | null; resultExpiresAt: number | null; sequence: number;
  firstOpenedAt: number | null; taps: Record<string, number>; opens: Record<string, number>;
  helpers: Record<string, { fieldId: string; readyAt: number; startedAt: number; until: number; timedOut?: boolean }>;
  helperNextAt?: number; purgeAt: Date; winner?: { deviceId: string; submissionId: string; fingerprint: string };
}
export interface RelayEvent {
  id: string; type: typeof eventTypes[number]; requestId: string; sequence: number; requestSequence: number;
  ownerId: string; grantId: string; at: number; observedAt?: number; deviceId?: string; fieldId?: string; purgeAt: Date;
}
export function validateSubmission(def: Definition, input: Submission): 'submitted' | 'declined' {
  const action = def.actions.find(a => a.id === input.action); ensure(action, 400, 'unknown_action');
  if (action.type === 'decline') { ensure(!Object.keys(input.values).length, 400, 'decline_has_values'); return 'declined'; }
  ensure(Object.keys(input.values).every(id => def.fields.some(f => f.id === id)), 400, 'unknown_field');
  for (const f of def.fields) {
    const v = input.values[f.id], missing = v === undefined || v === '' || (Array.isArray(v) && !v.length);
    ensure(!f.required || !missing, 400, 'required_field');
    if (v === undefined) continue;
    if (f.type === 'text' || f.type === 'multiline') {
      ensure(typeof v === 'string' && v.length <= f.maxLength, 400, 'invalid_text');
      if (f.input === 'sms_code' && v !== '') ensure(/^(?=[A-Za-z0-9]{4,10}$)(?=.*[0-9])[A-Za-z0-9]+$/.test(v), 400, 'invalid_code');
    } else if (f.type === 'number') ensure(typeof v === 'number' && Number.isFinite(v) && (f.min === undefined || v >= f.min) && (f.max === undefined || v <= f.max), 400, 'invalid_number');
    else if (f.type === 'checkbox') ensure(typeof v === 'boolean' && (!f.required || v), 400, 'invalid_checkbox');
    else if (f.type === 'single_choice') ensure(typeof v === 'string' && f.options.some(o => o.id === v), 400, 'invalid_choice');
    else if (f.type === 'multiple_choice') ensure(Array.isArray(v) && new Set(v).size === v.length && v.every(id => f.options.some(o => o.id === id)), 400, 'invalid_choices');
    else if (f.type === 'date') ensure(typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v, 400, 'invalid_date');
  }
  return 'submitted';
}
export const formView = (r: FormRequest) => ({ requestId: r.id, callerName: r.callerName, ...r.definition,
  idempotencyKey: undefined, status: r.status, createdAt: r.createdAt, expiresAt: r.expiresAt,
  terminatedAt: r.terminatedAt, resultExpiresAt: r.resultExpiresAt, firstOpenedAt: r.firstOpenedAt, completedByDeviceId: r.winner?.deviceId ?? null, helpers: r.helpers });
