import type { Firestore } from 'firebase-admin/firestore';
import { ensure } from './model.js';

/** A failed/uninitialized watch denies traffic. Health remains available for operational probes. */
export class RecoveryGate {
  private blocked = true;
  private closed = false;
  private stop: () => void = () => {};
  constructor(db: Firestore, initialize: () => Promise<unknown> = async () => {}) {
    void this.start(db, initialize).catch(() => { this.blocked = true; console.error('recovery_gate_unavailable'); });
  }
  private async start(db: Firestore, initialize: () => Promise<unknown>) {
    // Credential lookup must finish before creating any Firestore RPC/watch:
    // gRPC stub initialization can reject outside the watch error callback.
    await initialize();
    if (this.closed) return;
    const ref = db.collection('recoveryControl').doc('state');
    // Only the subsequent watch snapshot may open the gate.
    await ref.get();
    if (this.closed) return;
    this.stop = ref.onSnapshot(
      doc => { if (!this.closed) this.blocked = doc.data()?.blocked === true; },
      () => { this.blocked = true; });
  }
  assertServing() { ensure(!this.blocked, 503, 'recovery_in_progress'); }
  close() { this.closed = true; this.blocked = true; this.stop(); }
}
