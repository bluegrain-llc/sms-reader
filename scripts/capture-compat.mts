/** Capture the TypeScript source contracts consumed by Rust. No credentials needed. */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { app } from '../server/src/http.js';
import type { Relay } from '../server/src/relay.js';
import { requestSchema } from '../server/src/model.js';
import { formSchema, submissionSchema, observationSchema, webhookSchema } from '../server/src/forms-model.js';
const root = new URL('../', import.meta.url), directory = new URL('server-rust/compat/', root);
const save = (name: string, value: unknown) => writeFileSync(new URL(name, directory), JSON.stringify(value, null, 2) + '\n');
for (const [name, schema] of Object.entries({ form: formSchema, submission: submissionSchema, observation: observationSchema, webhook: webhookSchema, sms: requestSchema })) save(`${name}.schema.json`, z.toJSONSchema(schema));
const server = app({ forms: {}, checkAgent: async () => {} } as unknown as Relay, { verifyOwner: async () => ({ uid: 'fixture', authTime: 0 }), verifyScheduler: async () => {}, deleteIdentity: async () => {} }).listen(0, '127.0.0.1');
const client = new Client({ name: 'schema-export', version: '1' });
try {
  await once(server, 'listening', { signal: AbortSignal.timeout(15_000) });
  const port = (server.address() as { port: number }).port;
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: 'Bearer fixture' } } }), { timeout: 15_000 });
  save('tools.json', (await client.listTools()).tools);
} finally { await client.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
const require = createRequire(new URL('server/package.json', root));
const ip = require('ipaddr.js'), ranges: string[] = [];
for (const type of [ip.IPv4, ip.IPv6]) for (const value of Object.values(type.prototype.SpecialRanges) as any[]) {
  for (const [address, prefix] of Array.isArray(value[0]) ? value : [value]) ranges.push(`${address}/${prefix}`);
}
save('non-unicast.json', ranges);
const canonical = (v: unknown) => JSON.stringify(v, (_key, value) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.keys(value).sort().map(k => [k, value[k]])) : value);
const inputs: unknown[] = [null, ['Sign in', null], ['Sign in', null, 'Title'], { é: '😀', z: 1.0, '10': 1e-7, '2': 1e21, '01': 1e-6, '4294967294': -0, '4294967295': 1.2345678901234567 }, [1e-7, 1e-6, 1e20, 1e21, -0, 333333333.3333333], { a: null }, {}];
inputs.push(formSchema.parse({ title: '  Test  ', body: 'Body', idempotencyKey: 'hash-fixture', fields: [{ id: 'code', type: 'text', label: ' Code ', input: 'sms_code' }], actions: [{ id: 'yes', type: 'submit', label: ' Yes ' }] }));
save('hashes.json', inputs.flatMap(input => [false, true].map(sorted => { const text = sorted ? canonical(input) : JSON.stringify(input); return { input, canonical: sorted, json: text, hash: createHash('sha256').update(text).digest('hex') }; })));
const source = readFileSync(new URL('server/src/http.ts', root), 'utf8');
const start = source.indexOf('<!doctype html>'), end = source.indexOf('`);', start);
if (start < 0 || end < 0) throw Error('Pairing HTML source moved; update its capture');
writeFileSync(new URL('connect.html', directory), source.slice(start, end).replaceAll('${formatted}', '{{CODE}}'));
