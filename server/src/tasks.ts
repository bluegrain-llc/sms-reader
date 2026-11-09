import { CloudTasksClient } from '@google-cloud/tasks';

/** A wakeup is advisory; the durable Firestore outbox remains the source of work. */
export function taskWakeup() {
  const queue = process.env.DELIVERY_QUEUE, url = process.env.SERVICE_URL, email = process.env.SCHEDULER_EMAIL;
  const client = queue ? new CloudTasksClient() : null;
  return async () => {
    if (!client || !queue || !url || !email) return;
    await client.createTask({ parent: queue, task: { httpRequest: {
      httpMethod: 'POST', url: `${url}/internal/delivery`, oidcToken: { serviceAccountEmail: email, audience: url },
      headers: { 'Content-Type': 'application/json' }, body: Buffer.from('{}').toString('base64'),
    } } }, { timeout: 3000, retry: null });
  };
}
