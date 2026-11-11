import { createHash, randomUUID } from 'node:crypto';
import { Firestore } from 'firebase-admin/firestore';
import { z } from 'zod';
import { ensure } from './model.js';
import { RecoveryObjects, securityIntentSchema, validateLedger } from './security-ledger.js';

const collections = ['accounts', 'devices', 'grants'] as const;
const keys = {
  accounts: ['deleting'],
  devices: ['id', 'ownerId', 'name', 'fcmToken', 'paused', 'deleted', 'wizardVersion', 'updatedAt'],
  grants: ['id', 'ownerId', 'deviceId', 'callerName', 'callerId', 'revoked', 'expiresAt', 'createdAt', 'managerId', 'formsApproved', 'webhooks', 'serviceId', 'connectionId', 'capabilities', 'deliveryAcknowledged', 'deliveryExpiresAt', 'deliveryKeyId'],
} as const;
const row = z.object({ collection: z.enum(collections), id: z.string().min(1).max(128), value: z.record(z.string(), z.unknown()) }).strict();
export const snapshotSchema = z.object({ version: z.literal(1), project: z.string().min(1), startedAt: z.number().int(),
  completedAt: z.number().int(), ledgerBucket: z.string().min(1), rows: z.array(row), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type Snapshot = z.infer<typeof snapshotSchema>;
export const digestRows = (rows: Snapshot['rows']) => createHash('sha256').update(JSON.stringify(rows)).digest('hex');
function materializeAccounts(rows: Snapshot['rows']) {
  const owners = new Set(rows.filter(item => item.collection === 'accounts').map(item => item.id));
  for (const item of rows) {
    if (item.collection === 'accounts') continue;
    const owner = item.value.ownerId;
    ensure(typeof owner === 'string' && owner.length > 0 && owner.length <= 128 && !owner.includes('/'), 400, 'invalid_owner_metadata');
    // Live registration permits an absent account document, which means {}.
    // Materialize that same state; ledger replay still supplies every denial.
    if (!owners.has(owner)) { owners.add(owner); rows.push({ collection: 'accounts', id: owner, value: {} }); }
  }
}
export function selectMetadata(collection: typeof collections[number], value: Record<string, unknown>) {
  const selected = Object.fromEntries(keys[collection].filter(key => value[key] !== undefined).map(key => [key, value[key]]));
  if (collection === 'grants' && selected.webhooks) {
    ensure(Array.isArray(selected.webhooks), 500, 'invalid_backup_metadata');
    selected.webhooks = selected.webhooks.map((hook: Record<string, unknown>) => Object.fromEntries(
      ['id', 'url', 'secret', 'events'].filter(key => hook[key] !== undefined).map(key => [key, hook[key]])));
  }
  return selected;
}
export async function snapshotMetadata(db: Firestore, project: string, backup: RecoveryObjects, ledger: RecoveryObjects) {
  const startedAt = Date.now(), marker = await validateLedger(ledger, project);
  ensure(marker.createdAt <= startedAt, 503, 'ledger_marker_invalid');
  const rows: Snapshot['rows'] = [];
  for (const collection of collections) {
    let last: string | undefined;
    for (;;) {
      const query = db.collection(collection).orderBy('__name__').limit(200);
      const page = await (last ? query.startAfter(last) : query).get();
      for (const doc of page.docs) rows.push({ collection, id: doc.id, value: selectMetadata(collection, doc.data()) });
      if (page.size < 200) break;
      last = page.docs.at(-1)!.id;
    }
  }
  materializeAccounts(rows);
  const snapshot = snapshotSchema.parse({ version: 1, project, ledgerBucket: ledger.bucket, startedAt,
    completedAt: Date.now(), rows, sha256: digestRows(rows) });
  const name = `snapshots/${startedAt}-${randomUUID()}.json`;
  await backup.put(name, snapshot);
  return { name, rows: rows.length, startedAt, completedAt: snapshot.completedAt };
}
export function applyDenials(snapshot: Snapshot, raw: unknown[], now: number) {
  ensure(snapshot.sha256 === digestRows(snapshot.rows), 400, 'snapshot_checksum_mismatch');
  const rows = snapshot.rows.map(item => ({ ...item, value: selectMetadata(item.collection, item.value) }));
  const deleted = new Set<string>();
  const intents = raw.map(value => securityIntentSchema.parse(value));
  for (const intent of intents) {
    if (intent.kind === 'account.delete') deleted.add(intent.ownerId);
    for (const item of rows) {
      if (item.collection === 'accounts' || item.value.ownerId !== intent.ownerId) continue;
      if (item.id === intent.target && item.collection === 'grants') {
        if (intent.kind === 'grant.revoke' || intent.kind === 'grant.restrict') item.value.revoked = true;
        if (intent.kind === 'forms.deny') item.value.formsApproved = false;
      }
      if (item.id === intent.target && item.collection === 'devices') {
        if (intent.kind === 'device.pause') item.value.paused = true;
        if (intent.kind === 'device.delete') { item.value.deleted = true; item.value.fcmToken = ''; item.value.name = ''; }
      }
      if (item.collection === 'grants' && intent.kind === 'webhook.delete' && item.id === intent.grantId) {
        item.value.webhooks = (item.value.webhooks as { id: string }[] | undefined)?.filter(h => h.id !== intent.target) ?? [];
      }
    }
  }
  for (const item of rows) if (item.collection === 'accounts' && item.value.deleting) deleted.add(item.id);
  const clean = rows.filter(item => item.collection === 'accounts' || !deleted.has(String(item.value.ownerId)));
  for (const owner of deleted) {
    const account = clean.find(r => r.collection === 'accounts' && r.id === owner);
    if (account) account.value = { deleting: true };
    else clean.push({ collection: 'accounts', id: owner, value: { deleting: true } });
  }
  materializeAccounts(clean);
  for (const item of clean) {
    if (item.collection === 'grants') {
      ensure(item.value.id === item.id && typeof item.value.expiresAt === 'number', 400, 'invalid_grant_metadata');
      if (item.value.expiresAt <= now || item.value.managerId || item.value.serviceId) item.value.revoked = true;
      item.value.rate = { start: now, count: 0 }; item.value.eventSequence = 0;
    }
    if (item.collection === 'devices') {
      ensure(item.value.id === item.id, 400, 'invalid_device_metadata');
      item.value.activeRequestId = null; item.value.listenerUntil = 0; item.value.formListenerUntil = 0;
      item.value.rate = { start: now, count: 0 };
    }
  }
  return { rows: clean, deleted: [...deleted] };
}
export async function restoreMetadata(db: Firestore, sourceProject: string, backup: RecoveryObjects, name: string, ledger: RecoveryObjects,
  deleteIdentity: (uid: string) => Promise<void>) {
  const gate = db.collection('recoveryControl').doc('state');
  await gate.set({ blocked: true, startedAt: Date.now() });
  const snapshot = snapshotSchema.parse(await backup.get(name));
  ensure(snapshot.project === sourceProject && snapshot.ledgerBucket === ledger.bucket, 400, 'snapshot_source_mismatch');
  ensure(snapshot.startedAt <= snapshot.completedAt && snapshot.completedAt <= Date.now() && Date.now() - snapshot.startedAt <= 86400_000,
    400, 'snapshot_outside_rpo');
  const marker = await validateLedger(ledger, sourceProject);
  ensure(marker.createdAt <= snapshot.startedAt, 503, 'ledger_does_not_cover_snapshot');
  // GCS strongly consistent listing plus locked retention covers every acknowledged denial in the recovery window.
  const names = await ledger.list('intents/');
  const raw = [];
  for (const object of names) raw.push(await ledger.get(object));
  const restored = applyDenials(snapshot, raw, Date.now());
  // Restores require offline traffic and an empty database except the fail-closed gate.
  for (const collection of await db.listCollections()) {
    if (collection.id !== 'recoveryControl') ensure((await collection.limit(1).get()).empty, 409, 'restore_destination_not_empty');
  }
  for (let offset = 0; offset < restored.rows.length; offset += 200) {
    const batch = db.batch();
    for (const item of restored.rows.slice(offset, offset + 200)) batch.set(db.collection(item.collection).doc(item.id), item.value);
    await batch.commit();
  }
  for (const uid of restored.deleted) {
    try { await deleteIdentity(uid); } catch (e) { if ((e as { code?: string }).code !== 'auth/user-not-found') throw e; }
  }
  // Never automatically reopen: operator must verify writers stopped and final ledger replay/drill evidence.
  await gate.set({ blocked: true, status: 'restored_pending_verification', sourceProject, snapshot: name,
    completedAt: Date.now(), ledgerObjectCount: names.length, rows: restored.rows.length });
  return { rows: restored.rows.length, ledgerObjects: names.length, blocked: true };
}
