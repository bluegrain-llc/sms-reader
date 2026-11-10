import { FieldPath, Firestore, Query } from 'firebase-admin/firestore';
import { telemetry, category } from './telemetry.js';

/** Persisted cursors advance past failed items, wrapping each scan so retries cannot starve later owners. */
export class MaintenancePages {
  constructor(readonly db: Firestore) {}
  async run(name: string, query: Query, field: string | null, size: number, handle: (id: string) => Promise<unknown>, concurrency = 8) {
    const ref = this.db.collection('maintenancePages').doc(name);
    const state = (await ref.get()).data();
    const ordered = field ? query.orderBy(field).orderBy(FieldPath.documentId()) : query.orderBy(FieldPath.documentId());
    const start = state?.id ? ordered.startAfter(...(field ? [state.value, state.id] : [state.id])) : ordered;
    let page = await start.limit(size).get();
    if (page.empty && state?.id) page = await ordered.limit(size).get();
    for (let offset = 0; offset < page.size; offset += concurrency) {
      // Each item owns its transactional correctness. One malformed record cannot stop another owner.
      const settled = await Promise.allSettled(page.docs.slice(offset, offset + concurrency).map(doc => handle(doc.id)));
      for (const result of settled) if (result.status === 'rejected') telemetry.emit({ event: 'maintenance_failed', category: category(result.reason) });
    }
    const last = page.docs.at(-1);
    await this.db.runTransaction(async tx => {
      const live = (await tx.get(ref)).data();
      if ((live?.version ?? 0) !== (state?.version ?? 0)) return;
      tx.set(ref, { version: (state?.version ?? 0) + 1, id: last?.id ?? null,
        ...(field && last ? { value: last.get(field) } : {}) });
    });
    return page.size;
  }
  async purge(collection: string, now: number) {
    return this.run(`purge-${collection}`, this.db.collection(collection).where('purgeAt', '<=', new Date(now)), 'purgeAt', 400,
      async id => {
        const ref = this.db.collection(collection).doc(id);
        await this.db.runTransaction(async tx => {
          const doc = await tx.get(ref), until = doc.data()?.purgeAt;
          if (until && (until.toMillis?.() ?? new Date(until).getTime()) <= now) tx.delete(ref);
        });
      });
  }
}
