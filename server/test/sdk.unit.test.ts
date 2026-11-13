import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { CompactEncrypt, importJWK } from 'jose';
import QRCode from 'qrcode';
import { createRequire } from 'node:module';
const jsQR = createRequire(import.meta.url)('jsqr') as (data: Uint8ClampedArray, width: number, height: number) => { data: string } | null;
import { providerTools, capabilityTools, hostedProviderConfig } from '../../integrations/providers.mjs';
import { deliveryKey, credential } from '../../cli/client.mjs';
import { ServiceSession } from '../../sdks/javascript/index.mjs';
test('locally generated QR decodes to the public HTTPS link', async () => {
  const link = 'https://relay.example/services/ed2e17c3-a365-4855-a7b8-e13b15a69412';
  const qr = QRCode.create(link,{errorCorrectionLevel:'M'}), scale=8, width=(qr.modules.size+8)*scale;
  const data = new Uint8ClampedArray(width*width*4).fill(255);
  for(let y=0;y<qr.modules.size;y++)for(let x=0;x<qr.modules.size;x++)if(qr.modules.get(y,x))for(let dy=0;dy<scale;dy++)for(let dx=0;dx<scale;dx++){
    const i=(((y+4)*scale+dy)*width+(x+4)*scale+dx)*4;data[i]=data[i+1]=data[i+2]=0;
  }
  assert.equal(jsQR(data,width,width)?.data,link);
});
test('JavaScript SDK saves pending credentials before starting registration', async () => {
  let saved: any;
  const storage={load:async()=>saved,save:async(state: any)=>{saved=structuredClone(state);}};
  const service=await ServiceSession.create({baseUrl:'https://relay.example',name:'Agent',purpose:'Decisions'},storage,{fetch:async(_url:any,request:any)=>{
    assert.ok(saved.serviceToken);assert.ok(saved.keys[0].privateKey.d);
    assert.ok(!request.body.includes(saved.serviceToken));assert.ok(!request.body.includes(saved.keys[0].privateKey.d));
    return Response.json({status:'pending',registrationPath:'/register/public-id'});
  }});
  const started=await service.startRegistration();assert.equal(started.link,'https://relay.example/register/public-id');assert.ok(!JSON.stringify(started).includes(saved.serviceToken));
  assert.deepEqual(Object.keys(service.state.connections),[]);
});
test('registered JavaScript and Python sessions do not depend on purged registration records', async () => {
  const state={baseUrl:'https://relay.example',registered:true,serviceId:'service',servicePath:'/services/service',serviceToken:credential('smss'),keys:[],connections:{}};
  const storage={load:async()=>state,save:async()=>{}};
  const service=await ServiceSession.resume(storage,{fetch:async(url: string|URL|Request)=>{
    assert.equal(String(url),'https://relay.example/v3/service/deliveries');return Response.json({deliveries:[],hasMore:false});
  }});
  assert.deepEqual(await service.waitForRegistration(),{serviceId:'service',link:'https://relay.example/services/service'});
  const program=`from request_relay import ServiceSession\nclass Store:\n def load(self):return {'baseUrl':'https://relay.example','registered':True,'serviceId':'service','servicePath':'/services/service','serviceToken':'software-only','keys':[],'connections':{}}\n def save(self,state):pass\ns=ServiceSession.resume(Store())\ndef request(path,token,*args):\n assert path=='/v3/service/deliveries'\n return {'deliveries':[],'hasMore':False}\ns.client.request=request\nassert s.wait_for_registration()=={'serviceId':'service','link':'https://relay.example/services/service'}\n`;
  const result=spawnSync('python3',['-c',program],{env:{...process.env,PYTHONPATH:new URL('../../sdks/python',import.meta.url).pathname},timeout:10000,encoding:'utf8'});assert.equal(result.status,0,result.stderr);
});
test('Python SDK decrypts JOSE delivery fixtures and rejects changed identifiers', async () => {
  const key=await deliveryKey(),payload={version:1,serviceId:'service',connectionId:'connection',deliveryId:'delivery',token:credential('smsr'),externalAccountRef:null};
  const envelope=await new CompactEncrypt(Buffer.from(JSON.stringify(payload))).setProtectedHeader({alg:'ECDH-ES',enc:'A256GCM',kid:key.id,serviceId:payload.serviceId,connectionId:payload.connectionId,deliveryId:payload.deliveryId}).encrypt(await importJWK(key.publicKey,'ECDH-ES'));
  const program=`import json,sys\nfrom request_relay import decrypt_delivery\nv=json.load(sys.stdin)\np=decrypt_delivery(v['delivery'],'service',v['key'])\nassert p['token']==v['token']\nv['delivery']['connectionId']='wrong'\ntry:\n decrypt_delivery(v['delivery'],'service',v['key'])\n raise AssertionError('changed identifier accepted')\nexcept ValueError:\n pass\n`;
  const result=spawnSync('python3',['-c',program],{env:{...process.env,PYTHONPATH:new URL('../../sdks/python',import.meta.url).pathname},input:JSON.stringify({delivery:{envelope,keyId:key.id,connectionId:'connection',deliveryId:'delivery'},key,token:payload.token}),timeout:10000,encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,'');
});
test('provider declarations expose only caller tools and never lifecycle authority', async () => {
  const calls: unknown[]=[];
  const t=providerTools([{name:'request_form',description:'Ask',inputSchema:{type:'object',properties:{title:{type:'string'}}}}],async(name: string,args: unknown)=>{calls.push([name,args]);return {status:'pending'};});
  assert.ok(!JSON.stringify([t.openai,t.anthropic,t.google,t.xai]).includes('token'));
  await assert.rejects(t.execute('register_service',{}));assert.equal(calls.length,0);
  assert.deepEqual(await t.execute('request_form',{title:'Review'}),{status:'pending'});assert.equal(calls.length,1);
});
test('xAI Responses declarations preserve approved schemas and reject unapproved execution', async () => {
  const schema={type:'object',properties:{title:{type:'string'}},required:['title']};
  const tools=[
    {name:'request_form',description:'Ask',inputSchema:schema,_meta:{'com.bluegrain.smsrelay/capability':'forms'}},
    {name:'request_sms',description:'Code',inputSchema:{type:'object'},_meta:{'com.bluegrain.smsrelay/capability':'sms'}},
    {name:'register_service',description:'Private lifecycle',inputSchema:{type:'object'}},
  ];
  const calls: unknown[]=[];
  const adapter=providerTools(capabilityTools(tools,['forms']),async(name: string,args: unknown)=>{calls.push([name,args]);return {status:'pending'};});
  assert.deepEqual(adapter.xai,[{type:'function',name:'request_form',description:'Ask',parameters:schema}]);
  for(const name of ['request_sms','register_service'])await assert.rejects(adapter.execute(name,{}),/capability_not_approved/);
  assert.deepEqual(calls,[]);
  assert.deepEqual(await adapter.execute('request_form',{title:'Review'}),{status:'pending'});
  assert.deepEqual(calls,[['request_form',{title:'Review'}]]);
});
test('xAI remote MCP configuration keeps OAuth authority in private software fields', () => {
  const resource='https://relay.example/mcp/services/public-service',accessToken=credential('smsa');
  assert.deepEqual(hostedProviderConfig('xai',{resource,accessToken}),{type:'mcp',server_label:'relay',server_url:resource,authorization:accessToken});
  for(const prefix of ['smsr','smss','smsreg'])assert.throws(()=>hostedProviderConfig('xai',{resource,accessToken:credential(prefix)}),/oauth_access_token_required/);
  for(const invalid of ['http://relay.example/mcp/services/public-service','https://relay.example/mcp',resource+'?token=private',resource+'#private','https://user:private@relay.example/mcp/services/public-service'])assert.throws(()=>hostedProviderConfig('xai',{resource:invalid,accessToken}),/invalid_mcp_resource/);
});
test('hosted API configuration requires a named resource and OAuth access authority', () => {
  const resource='https://relay.example/mcp/services/public-service',accessToken=credential('smsa');
  for(const prefix of ['smsr','smss','smsreg'])assert.throws(()=>hostedProviderConfig('openai',{resource,accessToken:credential(prefix)}),/oauth_access_token_required/);
  for(const invalid of ['https://relay.example/mcp',resource+'?token=private',resource+'#private','https://user:private@relay.example/mcp/services/public-service'])assert.throws(()=>hostedProviderConfig('openai',{resource:invalid,accessToken}),/invalid_mcp_resource/);
  const config=hostedProviderConfig('anthropic',{resource,accessToken});assert.ok(config.mcp_servers);
  assert.equal(config.mcp_servers[0]!.authorization_token,accessToken);assert.ok(!JSON.stringify(config.tools).includes(accessToken));
  assert.throws(()=>hostedProviderConfig('google',{resource,accessToken}),/hosted_provider_not_supported/);
});
test('provider discovery fails closed for missing or unknown capability metadata', () => {
  const tool = (name: string, cap?: string) => ({name,...(cap ? {_meta:{'com.bluegrain.smsrelay/capability':cap}} : {})});
  const tools=[tool('new_tool'),tool('unknown','admin'),tool('a_form','forms'),tool('a_code','sms')];
  assert.deepEqual(capabilityTools(tools,['forms']).map((t: {name:string})=>t.name),['a_form']);
  assert.deepEqual(capabilityTools(tools,['sms']).map((t: {name:string})=>t.name),['a_code']);
});

test('Python key rotation resumes the saved retirement intent',()=>{
  const program=`import copy\nfrom request_relay import ServiceSession\nclass Store:\n state=None\n def load(self):return copy.deepcopy(self.state)\n def save(self,state):self.state=copy.deepcopy(state)\nstore=Store()\ns=ServiceSession.create('https://relay.example','Agent','Decisions',store)\ndef interrupted(path,token,body,method=None):\n assert store.state['nextRetireKeyId']=='compromised'\n assert body['retireKeyId']=='compromised'\n raise RuntimeError('interrupted')\ns.client.request=interrupted\ntry:\n s.rotate_key('compromised')\n raise AssertionError('interruption expected')\nexcept RuntimeError:pass\nr=ServiceSession.resume(store)\ndef completed(path,token,body,method=None):\n assert body['retireKeyId']=='compromised'\n return {}\nr.client.request=completed\nr.rotate_key()\nassert 'nextKey' not in store.state and 'nextRetireKeyId' not in store.state\nassert len(store.state['keys'])==2\n`;
  const r=spawnSync('python3',['-c',program],{env:{...process.env,PYTHONPATH:new URL('../../sdks/python',import.meta.url).pathname},encoding:'utf8',timeout:10000});assert.equal(r.status,0,r.stderr);
});

test('Python imports portable JS tickets, persists before pairing, and rejects tampered keys and occupied profiles',async()=>{
  const key=await deliveryKey(),ticket={version:1,relayOrigin:'https://relay.example',agent:{name:'Agent',purpose:'Decisions',capabilities:['forms']},serviceCredential:credential('smss'),deliveryKeys:[key]};
  const program=`import copy,json,sys
import request_relay as relay
ticket=json.load(sys.stdin)
class Store:
 state=None
 fail=False
 def load(self):return copy.deepcopy(self.state)
 def save(self,state):
  if self.fail:raise RuntimeError('storage unavailable')
  self.state=copy.deepcopy(state)
store=Store()
def request(self,path,token,*args,**kwargs):
 assert path=='/v3/service' and token==ticket['serviceCredential']
 return {'serviceId':'agent','name':'Agent','purpose':'Decisions','capabilities':['forms'],'active':True,'deliveryKeyId':ticket['deliveryKeys'][0]['id'],'servicePath':'/services/agent'}
relay.RelayClient.request=request
store.fail=True
try:relay.ServiceSession.import_ticket(ticket,store);raise AssertionError('storage failure ignored')
except RuntimeError:pass
assert store.state is None
store.fail=False
service=relay.ServiceSession.import_ticket(ticket,store)
assert store.state['registered'] and store.state['connections']=={}
assert service.export_ticket()==ticket
try:relay.ServiceSession.import_ticket(ticket,store);raise AssertionError('occupied profile overwritten')
except ValueError:pass
bad=copy.deepcopy(ticket);bad['deliveryKeys'][0]['privateKey']['d']='A'*43
try:relay.ServiceSession.import_ticket(bad,Store());raise AssertionError('tampered private key accepted')
except ValueError:pass
`;
  const result=spawnSync('python3',['-c',program],{env:{...process.env,PYTHONPATH:new URL('../../sdks/python',import.meta.url).pathname},input:JSON.stringify(ticket),timeout:10000,encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,'');
});

test('Python exports legacy whitespace declarations after 100 completed rotations',()=>{
  const program=`import copy
import request_relay as relay
class Store:
 state=None
 def load(self):return copy.deepcopy(self.state)
 def save(self,state):self.state=copy.deepcopy(state)
store=Store()
s=relay.ServiceSession.create('https://relay.example','Agent','Decisions',store)
s.state.update(registered=True,serviceId='agent',servicePath='/services/agent',name=' Agent ',purpose=' Decisions ')
active=s.state['keys'][0]['id']
def request(path,token,body=None,method=None):
 global active
 if method=='PATCH':
  active=relay._hash(relay._json(body['deliveryPublicKey']))
  return {}
 return {'serviceId':'agent','servicePath':'/services/agent','name':'Agent','purpose':'Decisions','capabilities':['forms'],'active':True,'deliveryKeyId':active}
s.client.request=request
assert s.export_ticket()['agent']=={'name':'Agent','purpose':'Decisions','capabilities':['forms']}
for _ in range(100):s.rotate_key()
assert len(s.state['keys'])==101
ticket=s.export_ticket()
assert len(ticket['deliveryKeys'])==101
assert len(relay._verify_ticket(s.client,ticket))>0
assert s.state['name']==' Agent '
`;
  const result=spawnSync('python3',['-c',program],{env:{...process.env,PYTHONPATH:new URL('../../sdks/python',import.meta.url).pathname},timeout:15000,encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,'');
});
