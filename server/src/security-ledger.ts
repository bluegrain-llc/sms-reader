import { randomUUID } from 'node:crypto';
import { GoogleAuth } from 'google-auth-library';
import { z } from 'zod';
import { ensure } from './model.js';

export const securityIntentSchema = z.object({ version: z.literal(1), id: z.string().uuid(), at: z.number().int().nonnegative(),
  ownerId: z.string().min(1).max(128), kind: z.enum(['account.delete', 'grant.revoke', 'forms.deny', 'device.pause', 'device.delete', 'webhook.delete']),
  target: z.string().min(1).max(128), grantId: z.string().max(128).optional() }).strict();
export type SecurityIntent = z.infer<typeof securityIntentSchema>;
export type SecurityAction = Omit<SecurityIntent, 'version' | 'id' | 'at'>;
export type RecordSecurity = (action: SecurityAction, signal?: AbortSignal) => Promise<void>;

/** GCS is independent of Firestore; create-only writes prevent overwrite of acknowledged denials. */
export class RecoveryObjects {
  private auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/devstorage.read_write'] });
  constructor(readonly bucket: string) { ensure(/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(bucket), 500, 'invalid_recovery_bucket'); }
  async put(name: string, data: unknown, signal?: AbortSignal) {
    const client = await this.auth.getClient();
    const response = await client.request<{ generation?: string }>({ method: 'POST',
      url: `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(this.bucket)}/o`,
      params: { uploadType: 'media', name, ifGenerationMatch: 0 }, data: JSON.stringify(data),
      headers: { 'Content-Type': 'application/json' }, timeout: 10_000, retry: false, signal });
    ensure(response.data.generation, 503, 'recovery_write_unconfirmed');
  }
  async get(name: string, signal?: AbortSignal) {
    const client = await this.auth.getClient();
    return (await client.request<unknown>({ url: `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(this.bucket)}/o/${encodeURIComponent(name)}`,
      params: { alt: 'media' }, timeout: 10_000, retry: false, signal })).data;
  }
  async info(signal?: AbortSignal) {
    const client = await this.auth.getClient();
    return (await client.request<{ retentionPolicy?: { isLocked?: boolean; retentionPeriod?: string }; iamConfiguration?: {
      uniformBucketLevelAccess?: { enabled?: boolean }; publicAccessPrevention?: string } }>({
      url: `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(this.bucket)}`, timeout: 10_000, retry: false, signal })).data;
  }
  async list(prefix: string) {
    const client = await this.auth.getClient(); let pageToken: string | undefined;
    const names: string[] = [];
    do {
      const response = await client.request<{ items?: { name: string }[]; nextPageToken?: string }>({
        url: `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(this.bucket)}/o`,
        params: { prefix, pageToken }, timeout: 10_000, retry: false });
      names.push(...(response.data.items ?? []).map(item => item.name)); pageToken = response.data.nextPageToken;
    } while (pageToken);
    return names.sort();
  }
}
export async function validateLedger(objects: RecoveryObjects, project: string, signal?: AbortSignal) {
  const marker = z.object({ version: z.literal(1), project: z.string(), createdAt: z.number().int() }).strict().parse(await objects.get('manifest.json', signal));
  ensure(marker.project === project, 503, 'ledger_project_mismatch');
  const info = await objects.info(signal);
  ensure(info.retentionPolicy?.isLocked && Number(info.retentionPolicy.retentionPeriod) >= 7 * 86400,
    503, 'ledger_retention_not_locked');
  ensure(info.iamConfiguration?.uniformBucketLevelAccess?.enabled && info.iamConfiguration?.publicAccessPrevention === 'enforced',
    503, 'ledger_access_policy_unsafe');
  return marker;
}
export function securityLedger(bucket: string | undefined, now = Date.now, project = process.env.GOOGLE_CLOUD_PROJECT): RecordSecurity {
  const objects = bucket ? new RecoveryObjects(bucket) : null;
  return async (action, signal) => {
    ensure(objects, 503, 'security_ledger_not_configured');
    ensure(project, 503, 'security_ledger_project_missing');
    await validateLedger(objects, project, signal);
    const intent = securityIntentSchema.parse({ ...action, version: 1, id: randomUUID(), at: now() });
    // Failed or uncertain writes never acknowledge the live mutation. Extra denial intents are conservative on restore.
    await objects.put(`intents/${intent.at.toString().padStart(16, '0')}-${intent.id}.json`, intent, signal);
  };
}
