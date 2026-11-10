import type { Firestore } from 'firebase-admin/firestore';

/** Worker and monitoring share the same due SMS populations. Queued requests are not deliverable. */
export function dueSmsQueries(db: Firestore, now: number, orderByDue = true) {
  return ['pending_phone', 'ready', 'awaiting_consent'].map(status => db.collection('requests')
    .where('status', '==', status).where('notificationSent', '==', false)
    .where('nextNotificationAt', '<=', now))
    .map(query => orderByDue ? query.orderBy('nextNotificationAt') : query);
}
