#!/usr/bin/env node
// Staging-only REST workload. No credentials, form values, or response bodies enter output.
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { performance } from 'node:perf_hooks';
const { values } = parseArgs({ options: { config: { type:'string' }, output: {type:'string'}, quick: {type:'boolean',default:false} } });
const abort = new AbortController(); let running=true;
process.on('SIGTERM',()=>{running=false;abort.abort();});process.on('SIGINT',()=>{running=false;abort.abort();});
const sleep=ms=>new Promise(resolve=>{const done=()=>{clearTimeout(t);abort.signal.removeEventListener('abort',done);resolve();};const t=setTimeout(done,ms);abort.signal.addEventListener('abort',done,{once:true});if(abort.signal.aborted)done();});
try {
 const c=JSON.parse(await readFile(values.config,'utf8'));
 const url=new URL(c.baseUrl);
 if (url.protocol!=='https:' || c.environment!=='staging' || c.project===c.productionProject || !c.project || !c.productionProject || !Array.isArray(c.callers) || c.callers.length!==200 || new Set(c.callers.map(x=>x.owner)).size!==100 || c.callers.some(x=>!/^smsr_[A-Za-z0-9_-]{43}$/.test(x.token))) throw Error('invalid staging fixture');
 if (!/^[a-z][a-z0-9-]*$/.test(c.service??'') || !/^[a-z][a-z0-9-]*$/.test(c.region??'')) throw Error('invalid service');
 const verified=JSON.parse((await promisify(execFile)('gcloud',['run','services','describe',c.service,'--project='+c.project,'--region='+c.region,'--format=json'],{timeout:15000})).stdout);
 if(verified.status?.url!==url.origin || verified.metadata?.labels?.environment!=='staging')throw Error('unverified staging service');
 const health=await fetch(new URL('/health',url),{signal:AbortSignal.timeout(10000)});if(!health.ok)throw Error('staging unavailable');
 const started=Date.now(), duration=values.quick?60000:86400000, requests=values.quick?20:10000;
 const metrics={requestOk:0,requestFailed:0,cancelOk:0,streamConnections:0,streamFailures:0,eventFrames:0,latencyMs:[],streamSeconds:0};
 async function request(caller,path,body){const t=performance.now();try {const r=await fetch(new URL(path,url),{method:body?'POST':'GET',headers:{Authorization:`Bearer ${caller.token}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});metrics.latencyMs.push(performance.now()-t);if(!r.ok)throw Error('request rejected');return await r.json();}catch{return null;}}
 async function stream(caller,index){while(running&&Date.now()-started<duration){const local=new AbortController(),t=Date.now(),timeout=setTimeout(()=>local.abort(),110000);const stop=()=>local.abort();abort.signal.addEventListener('abort',stop,{once:true});try{const r=await fetch(new URL('/v2/events/stream',url),{headers:{Authorization:`Bearer ${caller.token}`},signal:local.signal});if(!r.ok)throw Error('stream rejected');metrics.streamConnections++;const reader=r.body.getReader();while(running){const chunk=await reader.read();if(chunk.done)break;metrics.eventFrames+=(new TextDecoder().decode(chunk.value).match(/^id:/gm)||[]).length;}}catch{if(running)metrics.streamFailures++;}finally{metrics.streamSeconds+=(Date.now()-t)/1000;clearTimeout(timeout);abort.signal.removeEventListener('abort',stop);}const peak=Date.now()-started<(values.quick?30000:1800000);if(index>=20&&!peak)return;await sleep(250+Math.random()*750);}}
 const streams=c.callers.map(stream);
 for(let i=0;i<requests&&running;i++){const due=started+i*duration/requests;await sleep(Math.max(0,due-Date.now()));if(!running)break;const caller=c.callers[i%c.callers.length];const r=await request(caller,'/v2/requests',{title:'Synthetic capacity request',body:'Synthetic capacity fixture',fields:[],actions:[{id:'ack',label:'Acknowledge',type:'acknowledge'}],idempotencyKey:`capacity-${started}-${i}`,expiresInSeconds:60});if(r?.requestId){metrics.requestOk++;const cancelled=await request(caller,`/v2/requests/${r.requestId}/cancel`,{});if(cancelled?.status==='cancelled')metrics.cancelOk++;}else metrics.requestFailed++;}
 await sleep(Math.max(0,started+duration-Date.now()));running=false;abort.abort();await Promise.allSettled(streams);
 const samples=metrics.latencyMs.sort((a,b)=>a-b);delete metrics.latencyMs;
 const report={version:1,kind:values.quick?'smoke':'24h',project:c.project,startedAt:started,completedAt:Date.now(),...metrics,p95Ms:samples[Math.floor(samples.length*.95)]??null,expectedRequests:requests,physicalDeliveryProven:false,costProven:false};
 await writeFile(values.output,JSON.stringify(report,null,2)+'\n',{mode:0o600});
 if(report.requestOk!==requests||report.cancelOk!==requests||report.requestFailed||report.streamFailures)process.exitCode=1;
 console.log(JSON.stringify({report:values.output,requests:report.requestOk,failures:report.requestFailed,complete:!process.exitCode}));
}catch{console.error('capacity_run_failed');process.exitCode=1;}
