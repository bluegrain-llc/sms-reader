#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { PrivateStore } from './store.mjs';
import { RelayClient } from './client.mjs';
const { values: v } = parseArgs({ options: { profile: { type: 'string', default: 'default' }, store: { type: 'string' }, connection: { type: 'string' } } });
const store = new PrivateStore(v.store, v.profile);
const server = new Server({ name: 'request-relay-local', version: '0.1.0' }, { capabilities: { tools: {} } });
let remote, connectedToken, allowed = new Set();
const setupTool = { name: 'relay_setup_status', description: 'Show a public link and setup status. Approval and registration happen outside model tools.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } };
async function session() {
  const state = await store.read();
  if (!state) return { status: 'setup_needed', instruction: 'Run relay service register in your terminal.' };
  const connection = v.connection && state.connections?.[v.connection];
  const client = new RelayClient(state.baseUrl);
  const path = state.registered ? state.servicePath : state.registration?.registrationPath;
  const fallback = { status: 'setup_needed', ...(path ? { link: new URL(path, client.baseUrl).href } : {}), instruction: state.registered ? 'Approve the public link, then run relay service deliveries. Select its connection ID in the private MCP launch configuration.' : 'Run relay resume in your terminal.' };
  if (!state.registered || !connection) return fallback;
  let status;
  try { status = await client.request('/v3/connection', connection.token); } catch { return fallback; }
  if (connectedToken !== connection.token) {
    await remote?.close();
    remote = new Client({ name: 'request-relay-local', version: '0.1.0' });
    await remote.connect(new StreamableHTTPClientTransport(new URL('/mcp', client.baseUrl), { requestInit: { headers: { Authorization: `Bearer ${connection.token}` } } }));
    connectedToken = connection.token;
  }
  return { status: status.setup, capabilities: status.capabilities, expiresAt: status.expiresAt };
}
const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
server.setRequestHandler(ListToolsRequestSchema, async () => {
  try {
    const state = await session();
    const tools = state.status !== 'setup_needed' ? (await remote.listTools()).tools : [];
    allowed = new Set(tools.map(t => t.name)); return { tools: [setupTool, ...tools] };
  } catch { allowed.clear(); return { tools: [setupTool] }; }
});
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  try {
    const state = await session();
    if (params.name === setupTool.name) return result(state);
    if (state.status === 'setup_needed') return { ...result(state), isError: true };
    const tools = (await remote.listTools()).tools; allowed = new Set(tools.map(t => t.name));
    if (!allowed.has(params.name)) return { ...result({ error: 'capability_not_approved' }), isError: true };
    return await remote.callTool({ name: params.name, arguments: params.arguments });
  } catch { return { ...result({ error: 'relay_unavailable', instruction: 'Check relay status in your terminal.' }), isError: true }; }
});
await server.connect(new StdioServerTransport());
