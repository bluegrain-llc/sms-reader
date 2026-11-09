/** Run inside the caller's process. Keep the returned code in memory. */
export async function receiveSmsCode({ baseUrl, token, title, purpose, senderPhone, triggerSms, signal }) {
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const call = async (path, init = {}) => {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/v1${path}`, { ...init, headers, signal });
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error ?? 'relay_error'); // never log full result responses
    }
    return response.json();
  };
  const pause = () => new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, 2000);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
  // Reuse this key if retrying the same creation after a lost HTTP response.
  const key = crypto.randomUUID();
  const payload = JSON.stringify({ title, purpose, senderPhone, idempotencyKey: key });
  let created;
  try { created = await call('/requests', { method: 'POST', body: payload }); }
  catch (error) { if (signal?.aborted) throw error; created = await call('/requests', { method: 'POST', body: payload }); }
  const id = created.requestId;
  let completed = false;
  try {
    let request = created;
    while (['queued', 'pending_phone'].includes(request.status)) {
      await pause(); request = await call(`/requests/${id}`);
    }
    if (request.status !== 'ready') throw new Error(request.reason ?? request.status);
    if (request.listeningDeadline <= Date.now()) throw new Error('listener_expired');
    // Supplied by the integration. Neither relay service nor Android app implements this.
    await triggerSms({ listeningDeadline: request.listeningDeadline, signal });
    for (;;) {
      request = await call(`/requests/${id}`);
      if (request.status === 'completed' && request.code) { completed = true; return request.code; }
      if (!['ready', 'awaiting_consent'].includes(request.status)) throw new Error(request.reason ?? request.status);
      await pause();
    }
  } finally {
    // Best-effort cancellation even if the caller's main AbortSignal was already aborted.
    if (!completed) await fetch(`${baseUrl.replace(/\/$/, '')}/v1/requests/${id}/cancel`, {
      method: 'POST', headers, signal: AbortSignal.timeout(10_000),
    }).catch(() => {});
  }
}
