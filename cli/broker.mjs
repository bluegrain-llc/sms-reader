#!/usr/bin/env node
/** SDK process transport. Lifecycle credentials never cross stdout or process arguments. */
import { PrivateStore } from './store.mjs';
import { ServiceSession } from './service.mjs';
import { credential } from './client.mjs';
const abort = new AbortController();
for (const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>abort.abort());
let unlock;
try {
  const chunks=[];let size=0;
  for await(const chunk of process.stdin){size+=chunk.length;if(size>262144)throw Error('input_too_large');chunks.push(chunk);}
  const request=JSON.parse(Buffer.concat(chunks).toString());
  const {operation,connectionId}=request;const input=request.input??{};
  const store=new PrivateStore(request.directory??undefined,request.profile||undefined);
  unlock=await store.lock();
  const timeout=Math.min(700000,Math.max(1000,Number(request.timeoutMs)||(operation?.startsWith('waitFor')?700000:120000)));
  const options={signal:AbortSignal.any([abort.signal,AbortSignal.timeout(timeout)]),allowHttpLoopback:request.allowHttpLoopback===true};
  let state=await store.read(), service;
  if(operation==='startRegistration'&&!state)service=await ServiceSession.create({baseUrl:request.relayUrl,...input},store,options);
  else {if(!state)throw Error('registration_required');service=await ServiceSession.resume(store,options);}
  const methods=new Set(['startRegistration','waitForRegistration','startPairing','waitForPairing','restartPairing','permanentLink','consumeDeliveries','rotateCredential','rotateKey']);
  let value;
  if(methods.has(operation))value=await service[operation](operation==='rotateKey'?input.retireKeyId:input);
  else if(operation==='pollRegistration') {
    value=await service.client.request('/v3/registration-sessions/current',service.state.registrationToken);
    if(value.status==='approved'){service.state.serviceId=value.serviceId;service.state.servicePath=value.servicePath;service.state.registered=true;await service.save();await service.consumeDeliveries();}
  } else if(operation==='pollPairing') {
    if(!service.state.pairing)throw Error('pairing_required');
    value=await service.client.request(`/v3/service/pairing-sessions/${service.state.pairing.sessionId}`,service.state.serviceToken);
    if(value.status==='approved')await service.consumeDeliveries();
  } else if(operation==='listConnections') value=Object.keys(service.state.connections);
  else if(operation==='restartRegistration') {
    if(service.state.registered)throw Error('service_already_registered');
    service.state.registrationToken=credential('smsreg');delete service.state.registration;await service.save();value=await service.startRegistration();
  } else if(operation==='resume') {
    if(service.state.nextServiceToken){await service.rotateCredential();value={status:'credential_rotated'};}
    else if(service.state.nextKey){await service.rotateKey();value={status:'key_rotated'};}
    else if(!service.state.registered)value=await service.startRegistration();
    else if(service.state.pairingInput)value=await service.startPairing();
    else {await service.consumeDeliveries();value={status:'registered',link:service.permanentLink(),connectionIds:Object.keys(service.state.connections)};}
  } else {
    const connectionMethods=new Set(['status','requestForm','getForm','formResult','cancelForm','requestSms','getSms','cancelSms','events','registerWebhook','webhooks','deleteWebhook']);
    if(!connectionMethods.has(operation))throw Error('unknown_operation');
    const connection=service.connection(connectionId);
    value=await connection[operation](['getForm','formResult','cancelForm','getSms','cancelSms','deleteWebhook'].includes(operation)?input.id:operation==='events'?input.cursor:input);
  }
  process.stdout.write(JSON.stringify({ok:true,value:value??null})+'\n');
} catch(error) {
  // Fixed error categories avoid echoing input, URLs, keys, answers or native exception details.
  process.stdout.write(JSON.stringify({ok:false,error:typeof error.code==='string'&&/^[a-z_]{1,80}$/.test(error.code)?error.code:error.name==='AbortError'?'interrupted':'relay_operation_failed'})+'\n');
  process.exitCode=1;
} finally {await unlock?.();}
