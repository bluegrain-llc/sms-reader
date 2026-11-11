import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { CompactEncrypt, importJWK } from 'jose';
import QRCode from 'qrcode';
import { createRequire } from 'node:module';
const jsQR = createRequire(import.meta.url)('jsqr') as (data: Uint8ClampedArray, width: number, height: number) => { data: string } | null;
import { providerTools, capabilityTools } from '../../integrations/providers.mjs';
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
});
test('Python SDK decrypts JOSE delivery fixtures and rejects changed identifiers', async () => {
  const key=await deliveryKey(),payload={version:1,serviceId:'service',connectionId:'connection',deliveryId:'delivery',token:credential('smsr'),externalAccountRef:null};
  const envelope=await new CompactEncrypt(Buffer.from(JSON.stringify(payload))).setProtectedHeader({alg:'ECDH-ES',enc:'A256GCM',kid:key.id,serviceId:payload.serviceId,connectionId:payload.connectionId,deliveryId:payload.deliveryId}).encrypt(await importJWK(key.publicKey,'ECDH-ES'));
  const program=`import json,sys\nfrom request_relay import decrypt_delivery\nv=json.load(sys.stdin)\np=decrypt_delivery(v['delivery'],'service',v['key'])\nassert p['token']==v['token']\nv['delivery']['connectionId']='wrong'\ntry:\n decrypt_delivery(v['delivery'],'service',v['key'])\n raise AssertionError('changed identifier accepted')\nexcept ValueError:\n pass\n`;
  const result=spawnSync('python3',['-c',program],{env:{...process.env,PYTHONPATH:new URL('../../sdks/python',import.meta.url).pathname},input:JSON.stringify({delivery:{envelope,keyId:key.id,connectionId:'connection',deliveryId:'delivery'},key,token:payload.token}),encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,'');
});
test('provider declarations expose only caller tools and never lifecycle authority', async () => {
  const calls: unknown[]=[];
  const t=providerTools([{name:'request_form',description:'Ask',inputSchema:{type:'object',properties:{title:{type:'string'}}}}],async(name: string,args: unknown)=>{calls.push([name,args]);return {status:'pending'};});
  assert.ok(!JSON.stringify([t.openai,t.anthropic,t.google]).includes('token'));
  await assert.rejects(t.execute('register_service',{}));assert.equal(calls.length,0);
  assert.deepEqual(await t.execute('request_form',{title:'Review'}),{status:'pending'});assert.equal(calls.length,1);
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
