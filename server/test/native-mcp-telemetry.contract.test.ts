import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import type { Relay } from '../src/relay.js';
import { telemetry } from '../src/telemetry.js';
import { RustRelay, rustApp } from './rust-adapter.js';
if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) throw Error('Native MCP contracts require emulators');
const firebase = initializeApp({ projectId: 'demo-sms-relay' }, 'native-mcp-telemetry');
after(async () => { await deleteApp(firebase); });
test('native HTTP-200 MCP failures emit safe alert telemetry while domain errors remain quiet', { timeout: 30_000 }, async t => {
  const uid = 'private-mcp-owner', time = 1_800_000_000_000;
  const relay = new RustRelay(getFirestore(firebase), async () => {}, () => time) as unknown as Relay;
  await relay.register(uid, 'private-mcp-device', 'Phone', 'synthetic-fcm');
  const grant = await relay.createGrant(uid, 'private-mcp-device', 'Caller', 30);
  await relay.forms.approve(uid, grant.grantId, true);
  const rows: Parameters<typeof telemetry.emit>[0][] = [], original = telemetry.emit;
  telemetry.emit = row => { rows.push(row); };
  const server = rustApp(relay, { verifyOwner: async () => ({ uid, authTime: time / 1000 }), verifyScheduler: async () => {}, deleteIdentity: async () => {} }).listen();
  try {
    await once(server, 'listening', { signal: t.signal });
    const call = async (name: string, args: unknown) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/mcp`, {
        method: 'POST', headers: { authorization: `Bearer ${grant.token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }), signal: AbortSignal.any([t.signal, AbortSignal.timeout(10_000)]),
      });
      assert.equal(response.status, 200); return await response.json() as { result: { isError: boolean; content: { text: string }[] } };
    };
    // Valid schema, but Firestore cannot store an isolated UTF-16 unit.
    const failure = await call('create_request', { title: '\ud800', body: 'private-mcp-body', idempotencyKey: 'private-mcp-failure', actions: [{ id: 'ok', label: 'OK', type: 'submit' }] });
    assert.equal(failure.result.isError, true);
    assert.deepEqual(JSON.parse(failure.result.content[0]!.text), { error: 'internal_error' });
    const alerts = rows.filter(row => row.event === 'mcp_tool_failed');
    assert.equal(alerts.length, 1);
    const alert = alerts[0]!;
    assert.equal(alert.event, 'mcp_tool_failed');
    if (alert.event === 'mcp_tool_failed') assert.equal(alert.category, 'internal');
    assert.ok(!JSON.stringify(alerts).includes('private-')); assert.ok(!JSON.stringify(alerts).includes(grant.token));
    assert.equal((await call('inspect_request', { requestId: 'missing-native-request' })).result.isError, true);
    assert.equal(rows.filter(row => row.event === 'mcp_tool_failed').length, 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    telemetry.emit = original;
  }
});
