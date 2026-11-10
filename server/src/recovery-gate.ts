import type { Firestore } from 'firebase-admin/firestore';
import { ensure } from './model.js';

/** A failed/uninitialized watch denies traffic. Health remains available for operational probes. */
export class RecoveryGate {
  private blocked = true;
  private stop: () => void;
  constructor(db: Firestore) {
    this.stop = db.collection('recoveryControl').doc('state').onSnapshot(
      doc => { this.blocked = doc.data()?.blocked === true; }, () => { this.blocked = true; });
  }
  assertServing() { ensure(!this.blocked, 503, 'recovery_in_progress'); }
  close() { this.blocked = true; this.stop(); }
}
