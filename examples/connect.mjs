/** Pair one app/bot with one user, then use its credential with caller.mjs or MCP. */
export async function connectSmsRelay({ baseUrl, callerName, purpose, saveCredential, showConnection, signal }) {
  const base = baseUrl.replace(/\/$/, '');
  const response = await fetch(base + '/v1/connections', {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal,
    body: JSON.stringify({ callerName, purpose }),
  });
  const pending = await response.json();
  if (!response.ok) throw new Error(pending.error ?? 'connection_failed');
  // Keep this credential only in the caller's private vault. It is unusable before approval.
  // Persist before showing the link so process/network retries do not lose the connection.
  await saveCredential({ token: pending.connectionToken, status: 'pending' });
  await showConnection({ url: pending.verificationUri, userCode: pending.userCode, expiresAt: pending.expiresAt });
  let interval = pending.interval * 1_000;
  const pause = () => new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, interval);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
  for (;;) {
    await pause();
    const poll = await fetch(base + '/v1/connections/poll', {
      method: 'POST', headers: { authorization: 'Bearer ' + pending.connectionToken }, signal,
    });
    if (poll.status === 429) { interval += 5_000; continue; }
    const status = await poll.json();
    if (!poll.ok) throw new Error(status.error ?? 'connection_failed');
    if (status.status === 'approved') {
      await saveCredential({ token: pending.connectionToken, status: 'approved', expiresAt: status.grantExpiresAt });
      return pending.connectionToken;
    }
    if (status.status !== 'pending') throw new Error('connection_' + status.status);
    if (Date.now() >= pending.expiresAt) throw new Error('connection_expired');
  }
}

// CLI demonstration: prints the owner link/code, never the credential.
if (process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {
  const { open } = await import('node:fs/promises');
  const path = process.env.RELAY_CREDENTIAL_FILE;
  if (!path || !process.env.RELAY_URL || !process.env.CALLER_NAME) {
    throw new Error('Set RELAY_URL, CALLER_NAME and a new private RELAY_CREDENTIAL_FILE path.');
  }
  const file = await open(path, 'wx', 0o600); // Refuse to replace an existing credential.
  try {
    await connectSmsRelay({ baseUrl: process.env.RELAY_URL, callerName: process.env.CALLER_NAME,
      purpose: process.env.CONNECTION_PURPOSE ?? 'Request upcoming SMS codes with your approval',
      signal: AbortSignal.timeout(11 * 60_000),
      saveCredential: async value => { await file.truncate(0); await file.write(JSON.stringify(value) + '\n', 0, 'utf8'); await file.sync(); },
      showConnection: async ({ url, userCode }) => { console.log('Open on your phone: ' + url); console.log('Compare connection code: ' + userCode); },
    });
    console.log('Connected. Credential saved privately to ' + path);
  } finally { await file.close(); }
}
