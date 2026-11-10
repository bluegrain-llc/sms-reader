import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const base = new URL(process.env.RELAY_URL);
assert.equal(base.protocol, 'https:');
const token = process.env.RELAY_SMOKE_TOKEN;
assert.ok(token, 'A dedicated paired smoke caller is required');
const expected = JSON.parse(process.env.ANDROID_SIGNING_SHA256S);
const call = (path, options = {}) => fetch(new URL(path, base), { ...options, signal: AbortSignal.timeout(15_000), redirect: 'error' });
assert.equal((await call('/health')).status, 200);
assert.equal((await call('/v1/devices')).status, 401);
assert.equal((await call('/internal/maintenance', { method: 'POST' })).status, 401);
assert.equal((await call('/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
const links = await call('/.well-known/assetlinks.json');
assert.equal(links.status, 200);
assert.deepEqual((await links.json())[0].target.sha256_cert_fingerprints.slice().sort(), expected.slice().sort());
// An impossible ID verifies caller auth without creating a phone notification.
assert.equal((await call('/v1/requests/' + '0'.repeat(64), { headers: { authorization: `Bearer ${token}` } })).status, 404);
const client = new Client({ name: 'release-smoke', version: '1' });
const transport = new StreamableHTTPClientTransport(new URL('/mcp', base), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
try {
  await client.connect(transport, { timeout: 15_000 });
  const tools = await client.listTools({}, { timeout: 15_000 });
  assert.deepEqual(tools.tools.map(t => t.name).sort(), ['request_sms_code', 'get_sms_code_request', 'cancel_sms_code_request', 'create_request', 'inspect_request', 'cancel_request', 'get_request_result', 'poll_request_events'].sort());
} finally { await client.close(); }
console.info('release_smoke_passed');
