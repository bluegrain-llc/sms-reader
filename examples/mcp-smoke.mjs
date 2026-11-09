import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const base = process.env.RELAY_URL, token = process.env.RELAY_TOKEN;
if (!base || !token) throw Error('Set RELAY_URL and RELAY_TOKEN');
const client = new Client({ name: 'sms-relay-smoke', version: '1' });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base.replace(/\/$/, '')}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }));
  const tools = await client.listTools();
  if (tools.tools.length !== 3) throw Error('Unexpected tool list');
  const result = await client.callTool({ name: 'request_sms_code', arguments: { purpose: 'MCP connection smoke test — no SMS needed', idempotencyKey: crypto.randomUUID() } });
  if (result.isError) throw Error('Request failed');
  const { requestId } = JSON.parse(result.content[0].text);
  await client.callTool({ name: 'cancel_sms_code_request', arguments: { requestId } });
  console.info('Authenticated MCP create/cancel passed; no SMS triggered.');
} finally { await client.close(); }
