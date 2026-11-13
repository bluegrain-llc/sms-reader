import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deliveryKey, credential } from '../client.mjs';
import { ServiceSession } from '../service.mjs';
import { exportPrivateFile } from '../store.mjs';
const memory = () => ({value:null,async load(){return structuredClone(this.value);},async save(v){this.value=structuredClone(v);}});
async function fixture() {
  const key=await deliveryKey();
  const ticket={version:1,relayOrigin:'https://relay.example',agent:{name:'Agent',purpose:'Decisions',capabilities:['forms']},serviceCredential:credential('smss'),deliveryKeys:[key]};
  const service={serviceId:'agent',name:'Agent',purpose:'Decisions',capabilities:['forms'],active:true,deliveryKeyId:key.id,servicePath:'/services/agent'};
  const options={fetch:async(url,init)=>{assert.equal(url,'https://relay.example/v3/service');assert.equal(init.headers.Authorization,'Bearer '+ticket.serviceCredential);return Response.json(service);}};
  return {ticket,service,options};
}
test('ticket import validates active key and credential, then commits an isolated profile',async()=>{
  const {ticket,options}=await fixture(),store=memory();
  const service=await ServiceSession.importTicket(ticket,store,options);
  assert.equal(store.value.registered,true);assert.deepEqual(store.value.connections,{});
  assert.equal(store.value.registrationToken,undefined);
  assert.deepEqual(await service.exportTicket(),ticket);
  service.state.connections.recipient={token:credential('smsr')};
  assert.ok(!JSON.stringify(await service.exportTicket()).includes('smsr_'));
  await assert.rejects(ServiceSession.importTicket(ticket,store,options),/occupied/);
});
test('tampered keys, mismatched metadata, missing active key and recipient credentials fail closed',async()=>{
  for(const alter of [t=>t.deliveryKeys[0].privateKey.d='A'.repeat(43),t=>t.agent.name='Other',t=>t.recipientToken='smsr_private',t=>t.relayOrigin='https://relay.example/redirect']){
    const {ticket,options}=await fixture(),store=memory();alter(ticket);
    await assert.rejects(ServiceSession.importTicket(ticket,store,options));assert.equal(store.value,null);
  }
  const {ticket,service,options}=await fixture();service.deliveryKeyId='retired';
  await assert.rejects(ServiceSession.importTicket(ticket,memory(),options),/active agent/);
});
test('failed durable import can be retried and revoked credentials never reach storage',async()=>{
  const {ticket,options}=await fixture(),store=memory();let fail=true;
  const original=store.save;store.save=async function(value){if(fail)throw Error('disk full');await original.call(this,value);};
  await assert.rejects(ServiceSession.importTicket(ticket,store,options),/disk full/);assert.equal(store.value,null);
  fail=false;await ServiceSession.importTicket(ticket,store,options);assert.equal(store.value.registered,true);
  const empty=memory();await assert.rejects(ServiceSession.importTicket(ticket,empty,{fetch:async()=>Response.json({error:'invalid_service_credential'},{status:401})}));assert.equal(empty.value,null);
});
test('ticket export is private, complete, retryable and cannot overwrite other files',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'relay-ticket-'));
  try {
    const {ticket}=await fixture(),path=join(directory,'ticket.json');
    await exportPrivateFile(path,ticket);assert.deepEqual(JSON.parse(await readFile(path,'utf8')),ticket);
    assert.equal((await stat(path)).mode & 0o777,0o600);
    await exportPrivateFile(path,ticket);
    await assert.rejects(exportPrivateFile(path,{version:2}),/occupied/);
    const other=join(directory,'other');await writeFile(other,'unrelated',{mode:0o600});
    await assert.rejects(exportPrivateFile(other,ticket),/occupied/);assert.equal(await readFile(other,'utf8'),'unrelated');
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('ticket export supports registered legacy declarations with surrounding whitespace',async()=>{
  const {ticket,options}=await fixture(),store=memory();
  const imported=await ServiceSession.importTicket(ticket,store,options);
  imported.state.name=' Agent ';imported.state.purpose=' Decisions ';
  await imported.save();
  const resumed=await ServiceSession.resume(store,options);
  assert.deepEqual((await resumed.exportTicket()).agent,ticket.agent);
  assert.equal(store.value.name,' Agent ');
});

test('ticket export and import retain every key after 100 completed rotations',async()=>{
  const {ticket,service,options}=await fixture(),store=memory();
  const session=await ServiceSession.importTicket(ticket,store,options);
  const {hash}=await import('../client.mjs');
  const fetch=options.fetch;
  session.client.fetch=async(url,init)=>{
    if(init.method==='PATCH'){
      const {kty,crv,x,y}=JSON.parse(init.body).deliveryPublicKey;service.deliveryKeyId=hash(JSON.stringify({kty,crv,x,y}));
      return Response.json({ok:true});
    }
    return fetch(url,init);
  };
  for(let i=0;i<100;i++)await session.rotateKey();
  assert.equal(session.state.keys.length,101);
  const exported=await session.exportTicket();
  assert.equal(exported.deliveryKeys.length,101);
  const restored=await ServiceSession.importTicket(exported,memory(),options);
  assert.equal(restored.state.keys.length,101);
});
