/** Function-calling adapters over the existing remote MCP endpoint. Auth never enters tool schemas/arguments. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { PrivateStore } from '@sms-relay/cli/store';
import { RelayClient } from '@sms-relay/cli/client';
/** Private API configuration for application software; never register as a model tool or print it. */
export function hostedProviderConfig(provider, {resource, accessToken}) {
  let url;
  try { url = new URL(resource); } catch { throw Error('invalid_mcp_resource'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !/^\/mcp\/services\/[A-Za-z0-9_-]{1,128}$/.test(url.pathname)) throw Error('invalid_mcp_resource');
  if (typeof accessToken !== 'string' || !/^smsa_[A-Za-z0-9_-]{43}$/.test(accessToken)) throw Error('oauth_access_token_required');
  if (provider === 'openai' || provider === 'xai') return {type:'mcp',server_label:'relay',server_url:url.href,authorization:accessToken};
  if (provider === 'microsoft') return {type:'mcp',server_label:'relay',server_url:url.href,headers:{Authorization:`Bearer ${accessToken}`},require_approval:'always'};
  if (provider === 'anthropic') return {mcp_servers:[{type:'url',url:url.href,name:'relay',authorization_token:accessToken}],tools:[{type:'mcp_toolset',mcp_server_name:'relay'}],betas:['mcp-client-2025-11-20']};
  throw Error('hosted_provider_not_supported');
}
export function providerTools(tools, call) {
  const allowed = new Set(tools.map(t => t.name));
  const execute = async (name, args) => {
    if (!allowed.has(name)) throw Error('capability_not_approved');
    return call(name, args);
  };
  return {
    openai: tools.map(t => ({ type:'function',name:t.name,description:t.description,parameters:t.inputSchema,strict:false })),
    xai: tools.map(t => ({type:'function',name:t.name,description:t.description,parameters:t.inputSchema})),
    microsoft: tools.map(t => ({type:'function',name:t.name,description:t.description,parameters:t.inputSchema,strict:false})),
    anthropic: tools.map(t => ({name:t.name,description:t.description,input_schema:t.inputSchema})),
    google: [{functionDeclarations:tools.map(t => ({name:t.name,description:t.description,parametersJsonSchema:t.inputSchema}))}],
    execute,
  };
}
export function capabilityTools(tools, capabilities) {
  return tools.filter(t => ['forms','sms'].includes(t._meta?.['com.bluegrain.smsrelay/capability']) && capabilities?.includes(t._meta['com.bluegrain.smsrelay/capability']));
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
    const tools = capabilityTools(all, status.capabilities);
    return {...providerTools(tools,async(name,args)=>{
      // Reauthorization happens on every MCP call; a saved tool declaration cannot expand a grant.
      return remote.callTool({name,arguments:args});
    }),status:status.setup,close:()=>remote.close()};
  } catch(error) {await remote.close();throw error;}
}
