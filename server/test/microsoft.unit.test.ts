import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capabilityTools, hostedProviderConfig, providerTools } from '../../integrations/providers.mjs';
import { credential } from '../../cli/client.mjs';

test('Microsoft Responses functions keep approved schemas and execution authority separate', async () => {
  const schema={type:'object',properties:{title:{type:'string'}},required:['title']};
  const tools=[
    {name:'create_request',description:'Ask',inputSchema:schema,_meta:{'com.bluegrain.smsrelay/capability':'forms'}},
    {name:'request_sms_code',description:'Code',inputSchema:{type:'object'},_meta:{'com.bluegrain.smsrelay/capability':'sms'}},
    {name:'register_service',description:'Private lifecycle',inputSchema:{type:'object'}},
  ];
  const calls: unknown[]=[];
  const adapter=providerTools(capabilityTools(tools,['forms']),async(name:string,args:unknown)=>{calls.push([name,args]);return {status:'pending'};});
  assert.deepEqual(adapter.microsoft,[{type:'function',name:'create_request',description:'Ask',parameters:schema,strict:false}]);
  for(const name of ['request_sms_code','register_service'])await assert.rejects(adapter.execute(name,{}),/capability_not_approved/);
  assert.deepEqual(calls,[]);
  assert.deepEqual(await adapter.execute('create_request',{title:'Review'}),{status:'pending'});
  assert.deepEqual(calls,[['create_request',{title:'Review'}]]);
  assert.deepEqual(providerTools(capabilityTools(tools,[]),async()=>{}).microsoft,[]);
  assert.deepEqual(providerTools(capabilityTools(tools,['sms']),async()=>{}).microsoft.map((tool:{name:string})=>tool.name),['request_sms_code']);
});

test('Microsoft remote MCP uses private OAuth headers and requires tool approval', () => {
  const resource='https://relay.example/mcp/services/public-service',accessToken=credential('smsa');
  assert.deepEqual(hostedProviderConfig('microsoft',{resource,accessToken}),{
    type:'mcp',server_label:'relay',server_url:resource,headers:{Authorization:`Bearer ${accessToken}`},require_approval:'always',
  });
  for(const prefix of ['smsr','smss','smsreg'])assert.throws(()=>hostedProviderConfig('microsoft',{resource,accessToken:credential(prefix)}),/oauth_access_token_required/);
  for(const invalid of ['http://relay.example/mcp/services/public-service','https://relay.example/mcp',resource+'?token=private',resource+'#private','https://user:private@relay.example/mcp/services/public-service'])assert.throws(()=>hostedProviderConfig('microsoft',{resource:invalid,accessToken}),/invalid_mcp_resource/);
});
