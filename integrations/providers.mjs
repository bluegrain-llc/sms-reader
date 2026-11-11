/** Function-calling adapters over the existing remote MCP endpoint. Auth never enters tool schemas/arguments. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { PrivateStore } from '@sms-relay/cli/store';
import { RelayClient } from '@sms-relay/cli/client';
export function providerTools(tools, call) {
  const allowed = new Set(tools.map(t => t.name));
  const execute = async (name, args) => {
    if (!allowed.has(name)) throw Error('capability_not_approved');
    return call(name, args);
  };
  return {
    openai: tools.map(t => ({ type:'function',name:t.name,description:t.description,parameters:t.inputSchema,strict:false })),
    anthropic: tools.map(t => ({name:t.name,description:t.description,input_schema:t.inputSchema})),
    google: [{functionDeclarations:tools.map(t => ({name:t.name,description:t.description,parametersJsonSchema:t.inputSchema}))}],
    execute,
  };
}
export async function connectProviderTools({directory,profile='default',connectionId,signal}) {
  const state = await new PrivateStore(directory,profile).read();
  const connection = state?.connections?.[connectionId];
  if (!connection) return {status:'setup_needed',...(state?.servicePath?{link:new URL(state.servicePath,state.baseUrl).href}:{})};
  const relay = new RelayClient(state.baseUrl,{signal});
  const status = await relay.request('/v3/connection',connection.token);
  const remote = new Client({name:'request-relay-provider-adapter',version:'0.1.0'});
  await remote.connect(new StreamableHTTPClientTransport(new URL('/mcp',relay.baseUrl),{requestInit:{headers:{Authorization:`Bearer ${connection.token}`}}}));
  try {
    const all = (await remote.listTools()).tools;
    const sms = new Set(['request_sms_code','get_sms_code_request','cancel_sms_code_request']);
    const tools = all.filter(t => status.capabilities?.includes(sms.has(t.name)?'sms':'forms'));
    return {...providerTools(tools,async(name,args)=>{
      // Reauthorization happens on every MCP call; a saved tool declaration cannot expand a grant.
      return remote.callTool({name,arguments:args});
    }),status:status.setup,close:()=>remote.close()};
  } catch(error) {await remote.close();throw error;}
}
