import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bedrockTools, connectBedrockTools } from '../../integrations/aws.mjs';
import { capabilityTools, providerTools } from '../../integrations/providers.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const schema = {type:'object', properties:{title:{type:'string'}}, required:['title']};
const declarations = [
  {name:'create_request', description:'Ask', inputSchema:schema, _meta:{'com.bluegrain.smsrelay/capability':'forms'}},
  {name:'request_sms_code', inputSchema:{type:'object'}, _meta:{'com.bluegrain.smsrelay/capability':'sms'}},
  {name:'register_service', inputSchema:{type:'object'}},
];
test('Bedrock Converse preserves approved schemas and binds results to tool use IDs', async () => {
  const calls: unknown[] = [];
  const relay = providerTools(capabilityTools(declarations,['forms']), async (name: string,input: unknown) => {
    calls.push([name,input]);
    return {content:[{type:'text',text:'pending'}], structuredContent:{requestId:'opaque'}, _meta:{private:'software-only'}};
  });
  const adapter = bedrockTools(relay);
  assert.deepEqual(adapter.toolConfig, {tools:[{toolSpec:{name:'create_request',description:'Ask',inputSchema:{json:schema}}}]});
  const result = await adapter.executeToolUse({toolUseId:'provider:opaque.1',name:'create_request',input:{title:'Review'}});
  assert.deepEqual(result,{toolResult:{toolUseId:'provider:opaque.1',content:[{json:{content:[{type:'text',text:'pending'}],structuredContent:{requestId:'opaque'}}}]}});
  assert.deepEqual(calls,[['create_request',{title:'Review'}]]);
  assert.ok(!JSON.stringify([adapter.toolConfig,result]).includes('software-only'));
  assert.equal('status' in result.toolResult,false); // Optional status is unsupported by some Converse models.
});
test('Bedrock rejects unapproved lifecycle/SMS calls and malformed tool uses before dispatch', async () => {
  let calls = 0;
  const adapter = bedrockTools(providerTools(capabilityTools(declarations,['forms']),async () => {calls++;return {content:[]};}));
  const valid = {toolUseId:'opaque',name:'create_request',input:{title:'Review'}};
  for (const change of [{name:'request_sms_code'},{name:'register_service'},{name:'toString'},{input:null},{input:[]},{input:'{}'},{toolUseId:''},{toolUseId:'private\nvalue'},{toolUseId:'x'.repeat(65)}]) {
    await assert.rejects(adapter.executeToolUse({...valid,...change}),/invalid_or_unapproved_tool_use/);
  }
  assert.equal(calls,0);
});
test('Bedrock preserves MCP tool failures while transport errors remain outside model results', async () => {
  const tool = {toolUseId:'opaque',name:'create_request',input:{}};
  const failed = bedrockTools(providerTools(capabilityTools(declarations,['forms']),async () => ({content:[{type:'text',text:'forms_approval_required'}],isError:true})));
  assert.equal((await failed.executeToolUse(tool)).toolResult.content[0]!.json.isError,true);
  const unavailable = bedrockTools(providerTools(capabilityTools(declarations,['forms']),async () => {throw Error('private transport diagnostic');}));
  await assert.rejects(unavailable.executeToolUse(tool),/private transport diagnostic/);
});
test('Bedrock connection with no selected credential returns setup without tools', async () => {
  const directory = await mkdtemp(join(tmpdir(),'relay-bedrock-unit-'));
  try {
    const result = await connectBedrockTools({directory,profile:'aws',connectionId:'missing'});
    assert.deepEqual(result,{status:'setup_needed'});
  } finally {await rm(directory,{recursive:true,force:true});}
});
