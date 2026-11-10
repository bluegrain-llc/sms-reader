/** Capture the TypeScript source contracts consumed by Rust. No credentials needed. */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getParseErrorMessage } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import { CallToolRequestSchema, TaskAugmentedRequestParamsSchema, JSONRPCRequestSchema, JSONRPCMessageSchema, InitializeRequestSchema, ListToolsRequestSchema, PingRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { app } from '../server/src/http.js';
import type { Relay } from '../server/src/relay.js';
import { requestSchema, idSchema } from '../server/src/model.js';
import { formSchema, submissionSchema, observationSchema, webhookSchema } from '../server/src/forms-model.js';
const root = new URL('../', import.meta.url), directory = new URL('server-rust/compat/', root);
const save = (name: string, value: unknown) => writeFileSync(new URL(name, directory), JSON.stringify(value, null, 2) + '\n');
for (const [name, schema] of Object.entries({ form: formSchema, submission: submissionSchema, observation: observationSchema, webhook: webhookSchema, sms: requestSchema })) save(`${name}.schema.json`, z.toJSONSchema(schema));
// Preserve the SDK's Zod preprocessing and issue order independently of REST.
function toolParser(schema: z.ZodType): unknown {
  const d = schema._zod.def as any;
  const out: any = { type: d.type };
  if (d.checks) out.checks = d.checks.filter((c: any) => c._zod.def.check !== 'custom').map((c: any) => {
    const check = c._zod.def;
    return JSON.parse(JSON.stringify(check, (_key, value) => value instanceof RegExp ? { source: value.source, display: String(value) } : value));
  });
  if (d.shape) out.shape = Object.fromEntries(Object.entries(d.shape).map(([k, s]) => [k, toolParser(s as z.ZodType)]));
  if (d.catchall) out.strict = d.catchall._zod.def.type === 'never';
  if (d.innerType) out.inner = toolParser(d.innerType);
  if (d.type === 'default') out.default = d.defaultValue;
  if (d.element) out.element = toolParser(d.element);
  if (d.keyType) out.key = toolParser(d.keyType);
  if (d.valueType) out.value = toolParser(d.valueType);
  if (d.options) out.options = d.options.map(toolParser);
  if (d.discriminator) out.discriminator = d.discriminator;
  if (d.values) out.values = d.values;
  if (d.entries) out.values = Object.values(d.entries);
  return out;
}
const toolSchemas = { request_sms_code: z.object(requestSchema.shape), create_request: z.object(formSchema.shape),
  get_sms_code_request: z.object({ requestId: idSchema }), cancel_sms_code_request: z.object({ requestId: idSchema }),
  inspect_request: z.object({ requestId: idSchema }), cancel_request: z.object({ requestId: idSchema }), get_request_result: z.object({ requestId: idSchema }),
  poll_request_events: z.object({ cursor: z.string().max(128).optional() }),
};
save('tool-parsers.json', Object.fromEntries(Object.entries(toolSchemas).map(([name, schema]) => [name, toolParser(schema)])));
save('tool-envelope.json', { call: toolParser(CallToolRequestSchema), task: toolParser(TaskAugmentedRequestParamsSchema), request: toolParser(JSONRPCRequestSchema), message: toolParser(JSONRPCMessageSchema), initialize: toolParser(InitializeRequestSchema), list: toolParser(ListToolsRequestSchema), ping: toolParser(PingRequestSchema) });
const basicForm = { title: ' Test ', body: 'Body', idempotencyKey: 'tool-input', actions: [{ id: 'ok', label: ' OK ', type: 'submit' }] };
const toolCases: { name: keyof typeof toolSchemas; input: unknown }[] = [
  ...[{}, { requestId: 1 }, { requestId: '?' }, { requestId: 'valid', extra: true }].map(input => ({ name: 'get_sms_code_request' as const, input })),
  ...[{ purpose: '  ', idempotencyKey: 'short' }, { purpose: ' Text ', idempotencyKey: 'valid-key', extra: true }].map(input => ({ name: 'request_sms_code' as const, input })),
  ...[basicForm, { ...basicForm, expiresInSeconds: 1.1 }, { ...basicForm, expiresInSeconds: 1e20 }, { ...basicForm, expiresInSeconds: 1 },
    { ...basicForm, actions: [] }, { ...basicForm, fields: [{ type: 'invalid' }] }, { ...basicForm, fields: [null] },
    { ...basicForm, fields: [{ id: 'f', label: ' F ', type: 'text', extra: 1 }] },
    { ...basicForm, steps: [{ id: 'one', title: 'One', fieldIds: [], when: { fieldId: 'f', equals: null } }] },
  ].map(input => ({ name: 'create_request' as const, input })),
  { name: 'poll_request_events', input: { cursor: '😀'.repeat(65) } },
];
save('tool-validation.json', toolCases.map(({ name, input }) => {
  const result = toolSchemas[name].safeParse(input);
  return { name, input, ...(result.success ? { value: result.data } : { error: `MCP error -32602: Input validation error: Invalid arguments for tool ${name}: ${getParseErrorMessage(result.error)}` }) };
}));
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
save('js-strings.json', ['\ud800', '\udfff', '\ud800\ud800', '😀', '\u{f0000}\ue000', '\\ud800'].map(input => ({
  input, json: JSON.stringify(input), units: input.length, points: Array.from(input).length,
  utf8: Buffer.from(input).toString('utf8'), jsonHash: createHash('sha256').update(JSON.stringify(input)).digest('hex'),
})));
const source = readFileSync(new URL('server/src/http.ts', root), 'utf8');
const start = source.indexOf('<!doctype html>'), end = source.indexOf('`);', start);
if (start < 0 || end < 0) throw Error('Pairing HTML source moved; update its capture');
writeFileSync(new URL('connect.html', directory), source.slice(start, end).replaceAll('${formatted}', '{{CODE}}'));
