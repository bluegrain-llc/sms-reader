import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
let server: Server, origin: string;
const config = { apiKey: 'public', authDomain: 'demo.firebaseapp.com', projectId: 'demo', appId: 'public' };
test.beforeAll(async () => {
  server = createServer((req,res) => {
    if (req.url === '/ticket-browser.js') { res.setHeader('Content-Type','application/javascript'); res.end(readFileSync(new URL('../public/ticket-browser.js',import.meta.url))); }
    else if (req.url === '/owned-services.js') { res.setHeader('Content-Type','application/javascript'); res.end(readFileSync(new URL('../public/owned-services.js',import.meta.url))); }
    else if (req.url?.startsWith('/owned-services')) { res.setHeader('Content-Type','text/html'); res.end(readFileSync(new URL('../public/owned-services.html',import.meta.url),'utf8').replaceAll('__NONCE__','testnonce').replace('__CONFIG__',JSON.stringify(config))); }
    else if (req.url === '/onboarding-qr.js') { res.setHeader('Content-Type','application/javascript'); res.end(readFileSync(new URL('../public/onboarding-qr.js',import.meta.url))); }
    else if (req.url === '/onboarding.js') { res.setHeader('Content-Type','application/javascript'); res.end(readFileSync(new URL('../public/onboarding.js',import.meta.url))); }
    else { res.setHeader('Content-Type','text/html'); res.end(readFileSync(new URL('../public/onboarding.html',import.meta.url),'utf8').replaceAll('__NONCE__','testnonce').replace('__CONFIG__',JSON.stringify(config))); }
  }).listen(0,'127.0.0.1'); await once(server,'listening'); origin = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
});
test.afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve())); });
test.beforeEach(async ({ context }) => {
  await context.route('https://www.gstatic.com/firebasejs/**/firebase-app.js',r=>r.fulfill({contentType:'application/javascript',body:'export const initializeApp=()=>({});'}));
  await context.route('https://www.gstatic.com/firebasejs/**/firebase-auth.js',r=>r.fulfill({contentType:'application/javascript',body:`const user={uid:'browser-owner',email:'my-own-account@example.test',getIdToken:async()=> 'owner-session'}; const auth={currentUser:user};export const getAuth=()=>auth;export const signOut=async()=>{};export class GoogleAuthProvider{};export class OAuthProvider{constructor(id){this.providerId=id;}};export const linkWithPopup=async()=>({user});export const signInWithPopup=async()=>({});export const signInWithRedirect=async()=>({});export const getRedirectResult=async()=>({});export const onAuthStateChanged=(a,fn)=>{queueMicrotask(()=>fn(user));};export const setPersistence=async()=>{};export const browserLocalPersistence={};`}));
});
const review = { sessionId:'public-session', serviceId:'public-service', name:'My personal agent', purpose:'Ask for decisions', capabilities:['forms','sms'], status:'pending', expiresAt:Date.now()+600000, expiresInDays:null, comparisonCode:'123456',connectionId:null };
test('registration offers no owner-access control, needs one confirmation, no phone setup', async ({page})=>{
  let approvals=0;
  await page.route('**/v3/**',async r=>{
    if(r.request().url().endsWith('/decision')){approvals++;const body=r.request().postDataJSON();expect(body.selfAccess).toBe(false);await r.fulfill({json:{...review,status:'approved',connectionId:null}});}
    else await r.fulfill({json:review});
  });
  await page.goto(origin+'/register/public-session'); await expect(page.locator('#review')).toBeVisible();
  await expect(page.locator('#operator')).toBeVisible();
  await page.screenshot({path:'artifacts/onboarding-desktop.png',fullPage:true});
  await expect(page.locator('#self')).toHaveCount(0);await expect(page.locator('#permissions')).toBeHidden();
  await page.locator('#confirm').click();await expect(page.locator('#status')).toContainText('Service registered');await expect(page.locator('#phone')).toBeHidden();expect(approvals).toBe(1);
});
test('recipient can narrow permissions; failed decisions preserve selection and retry safely',async({page})=>{
  let approvals=0;
  await page.route('**/v3/**',async r=>{
    const url=r.request().url();
    if(url.endsWith('/decision')){approvals++;expect(r.request().postDataJSON().capabilities).toEqual(['forms']);if(approvals===1)await r.fulfill({status:503,json:{error:'unavailable'}});else await r.fulfill({json:{...review,status:'approved',connectionId:'connection'}});}
    else if(url.endsWith('/connections/connection'))await r.fulfill({json:{setup:'setup_complete',receivingDeviceAvailable:true,revoked:false}});
    else await r.fulfill({json:review});
  });
  await page.setViewportSize({width:390,height:844});await page.goto(origin+'/pair/public-session');await expect(page.locator('#review')).toBeVisible();await page.locator('#sms').uncheck();await page.screenshot({path:'artifacts/onboarding-mobile.png',fullPage:true});
  await page.locator('#confirm').click();await expect(page.locator('#retry')).toBeVisible();await expect(page.locator('#sms')).not.toBeChecked();await page.locator('#retry').click();
  await expect(page.locator('#status')).toContainText('Setup complete');expect(approvals).toBe(2);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
test('owner connects separately after registration before phone handoff',async({page})=>{
  const approvals:string[]=[];
  await page.route('**/v3/**',async r=>{
    const url=r.request().url();
    if(url.endsWith('/decision')){
      const registering=url.includes('/registration-sessions/');
      approvals.push(registering?'register':'pair');
      expect(r.request().postDataJSON().selfAccess).toBe(registering?false:undefined);
      await r.fulfill({json:{...review,status:'approved',connectionId:registering?null:'connection'}});
    } else if(url.endsWith('/connections/connection'))await r.fulfill({json:{setup:'phone_setup_needed',receivingDeviceAvailable:false,revoked:false}});
    else await r.fulfill({json:review});
  });
  await page.goto(origin+'/register/public-session');await expect(page.locator('#review')).toBeVisible();
  await expect(page.getByText('Also allow this service to send requests to me')).toHaveCount(0);
  await page.locator('#confirm').click();await expect(page.locator('#status')).toContainText('Service registered');
  await expect(page.locator('#phone')).toBeHidden();expect(approvals).toEqual(['register']);
  await page.goto(origin+'/pair/public-session');await expect(page.locator('#permissions')).toBeVisible();
  expect(approvals).toEqual(['register']);await page.locator('#confirm').click();
  await expect(page.locator('#phone')).toBeVisible();expect(approvals).toEqual(['register','pair']);
});
test('permanent link resumes one approval attempt through reopening',async({page})=>{
  const attempts:string[]=[];let approvals=0;
  await page.route('**/v3/**',async r=>{
    const url=r.request().url();
    if(url.endsWith('/services/public-service'))await r.fulfill({json:{serviceId:'public-service',name:review.name,purpose:review.purpose,capabilities:review.capabilities}});
    else if(url.endsWith('/services/public-service/connections')){attempts.push(r.request().postDataJSON().idempotencyKey);await r.fulfill({json:{...review,comparisonCode:null}});}
    else if(url.endsWith('/decision')){approvals++;await r.fulfill({json:{...review,status:'approved',connectionId:'connection'}});}
    else await r.fulfill({json:{setup:'setup_complete',revoked:false,receivingDeviceAvailable:true}});
  });
  await page.goto(origin+'/services/public-service');await expect(page.locator('#review')).toBeVisible();await page.reload();await expect(page.locator('#review')).toBeVisible();
  expect(attempts.length).toBe(2);expect(attempts[0]).toBe(attempts[1]);expect(approvals).toBe(0);await expect(page.locator('#comparison')).toBeHidden();
  await page.locator('#confirm').click();await expect(page.locator('#status')).toContainText('Setup complete');expect(approvals).toBe(1);
});
test('connection management expands permission only with explicit Save',async({page})=>{
  let saved=0;
  await page.route('**/v3/**',async r=>{
    if(r.request().method()==='PATCH'){saved++;expect(r.request().postDataJSON()).toEqual({capabilities:['forms','sms'],expiresAt:null});await r.fulfill({json:{ok:true}});}
    else await r.fulfill({json:{connectionId:'connection',serviceId:'public-service',name:review.name,purpose:review.purpose,availableCapabilities:['forms','sms'],capabilities:['forms'],expiresAt:null,revoked:false}});
  });
  await page.goto(origin+'/connections/connection');await expect(page.locator('#review')).toBeVisible();await expect(page.locator('#sms')).not.toBeChecked();await page.locator('#sms').check();expect(saved).toBe(0);
  await page.locator('#confirm').click();await expect(page.locator('#status')).toContainText('Permissions saved');expect(saved).toBe(1);
});
test('hosted approval names the service and requesting app; QR contains only the public session link',async({page})=>{
  let approvals=0;
  await page.route('**/callback?**',r=>r.fulfill({contentType:'text/html',body:'Returned to requesting app'}));
  await page.route('**/v3/**',async r=>{
    if(r.request().url().endsWith('/decision')){approvals++;expect(r.request().postDataJSON()).toEqual({decision:'approved',capabilities:['forms'],expiresInDays:null});await r.fulfill({json:{status:'approved',connectionId:'connection'}});}
    else if(r.request().url().endsWith('/response'))await r.fulfill({json:{redirect:origin+'/callback?code=one-use-code&state=opaque'}});
    else if(r.request().url().endsWith('/connections/connection'))await r.fulfill({json:{setup:'setup_complete',receivingDeviceAvailable:true,revoked:false}});
    else await r.fulfill({json:{...review,sessionId:'oauth-public',comparisonCode:null,clientName:'Hosted assistant',clientOrigin:'https://assistant.example'}});
  });
  await page.goto(origin+'/oauth/consent/oauth-public');await expect(page.locator('#review')).toBeVisible();
  await expect(page.locator('#client')).toContainText('Hosted assistant (https://assistant.example)');
  expect(approvals).toBe(0);await page.locator('#handoff summary').click();
  expect(await page.locator('#handoff-link').getAttribute('href')).toBe(origin+'/oauth/consent/oauth-public');
  const {createRequire}=await import('node:module');const require=createRequire(import.meta.url);
  const png=require('pngjs').PNG.sync.read(await page.locator('#handoff-qr').screenshot());
  const jsQR=require('jsqr');
  expect(jsQR(new Uint8ClampedArray(png.data),png.width,png.height).data).toBe(origin+'/oauth/consent/oauth-public');
  await page.locator('#sms').uncheck();await page.locator('#confirm').click();
  await expect(page).toHaveURL(origin+'/callback?code=one-use-code&state=opaque');expect(approvals).toBe(1);
});
test('desktop resumes a phone approval with one decision across the devices',async({page})=>{
  let reviews=0,decisions=0;
  await page.route('**/callback?**',r=>r.fulfill({contentType:'text/html',body:'Returned'}));
  await page.route('**/v3/**',async r=>{
    if(r.request().url().endsWith('/response'))await r.fulfill({json:{redirect:origin+'/callback?code=phone-approved'}});
    else if(r.request().url().endsWith('/decision')){decisions++;await r.fulfill({status:500,json:{error:'unexpected_second_confirmation'}});}
    else if(r.request().url().endsWith('/connections/connection'))await r.fulfill({json:{setup:'setup_complete',receivingDeviceAvailable:true,revoked:false}});
    else {reviews++;await r.fulfill({json:{...review,connectionId:'connection',sessionId:'handoff',status:reviews===1?'pending':'approved',clientName:'Hosted assistant',clientOrigin:'https://assistant.example'}});}
  });
  await page.goto(origin+'/oauth/consent/handoff');await expect(page.locator('#review')).toBeVisible();
  await expect(page).toHaveURL(origin+'/callback?code=phone-approved',{timeout:10000});expect(decisions).toBe(0);
});
test('hosted approval reports a missing phone before issuing the provider authorization code',async({page})=>{
  let responses=0;
  await page.route('**/callback?**',r=>r.fulfill({contentType:'text/html',body:'Returned'}));
  await page.route('**/v3/**',async r=>{
    const path=new URL(r.request().url()).pathname;
    if(path.endsWith('/decision'))await r.fulfill({json:{status:'approved',connectionId:'connection'}});
    else if(path.endsWith('/response')){responses++;await r.fulfill({json:{redirect:origin+'/callback?code=issued-on-return'}});}
    else if(path.endsWith('/connections/connection'))await r.fulfill({json:{setup:'phone_setup_needed',receivingDeviceAvailable:false,revoked:false}});
    else await r.fulfill({json:{...review,clientName:'Hosted assistant',clientOrigin:'https://assistant.example'}});
  });
  await page.goto(origin+'/oauth/consent/phone-needed');await expect(page.locator('#review')).toBeVisible();
  await page.locator('#confirm').click();await expect(page.locator('#phone')).toBeVisible();
  await expect(page.locator('#status')).toContainText('Access granted — connect a phone');expect(responses).toBe(0);
  await page.locator('#continue-to-app').click();await expect(page).toHaveURL(origin+'/callback?code=issued-on-return');expect(responses).toBe(1);
});
test('owner service management requires explicit enable and confirmed deletion without displaying credentials',async({page})=>{
  let active=false,deleted=false,updates=0,deletes=0;
  await page.route('**/v3/**',async r=>{
    if(r.request().method()==='PATCH'){updates++;expect(r.request().postDataJSON()).toEqual({active:true});active=true;await r.fulfill({json:{ok:true}});}
    else if(r.request().method()==='DELETE'){deletes++;deleted=true;await r.fulfill({json:{ok:true}});}
    else await r.fulfill({json:deleted?[]:[{serviceId:'owned',name:'My agent',purpose:'Ask for decisions',capabilities:['forms'],active,servicePath:'/services/owned',credentialHash:'never-render-this'}]});
  });
  await page.goto(origin+'/owned-services?service=owned');await expect(page.locator('#detail')).toBeVisible();
  await expect(page.locator('#status')).toContainText('Disabled');expect(updates).toBe(0);
  await page.screenshot({path:'artifacts/owned-services.png',fullPage:true});
  await expect(page.locator('body')).not.toContainText('never-render-this');
  await page.locator('#toggle').click();await expect(page.locator('#status')).toContainText('Enabled');expect(updates).toBe(1);
  page.once('dialog',dialog=>dialog.dismiss());await page.locator('#delete').click();expect(deletes).toBe(0);
  page.once('dialog',dialog=>dialog.accept());await page.locator('#delete').click();
  await expect(page.locator('#status')).toContainText('Service deleted');expect(deletes).toBe(1);
});

test('cancelled and disconnected permanent links allow a fresh explicit confirmation',async({page})=>{
  let nonce='',status='pending',revoked=false,approvals=0;
  const attempts:string[]=[];
  await page.route('**/v3/**',async r=>{
    const url=r.request().url();
    if(url.endsWith('/services/public-service'))return r.fulfill({json:{name:review.name,purpose:review.purpose,capabilities:review.capabilities}});
    if(url.endsWith('/services/public-service/connections')){
      const attempt=r.request().postDataJSON().idempotencyKey;attempts.push(attempt);
      if(attempt!==nonce){nonce=attempt;status='pending';}
      return r.fulfill({json:{...review,status,connectionId:status==='approved'?'connection':null}});
    }
    if(url.endsWith('/decision')){status=r.request().postDataJSON().decision;if(status==='approved')approvals++;return r.fulfill({json:{...review,status,connectionId:status==='approved'?'connection':null}});}
    return r.fulfill({json:{setup:revoked?'disconnected':'setup_complete',revoked,receivingDeviceAvailable:!revoked}});
  });
  await page.goto(origin+'/services/public-service');await expect(page.locator('#review')).toBeVisible();
  await page.locator('#cancel').click();await expect(page.locator('#status')).toContainText('Cancelled');
  await page.reload();await expect(page.locator('#review')).toBeVisible();expect(attempts[1]).not.toBe(attempts[0]);expect(approvals).toBe(0);
  await page.locator('#confirm').click();await expect(page.locator('#status')).toContainText('Setup complete');
  revoked=true;await page.reload();await expect(page.locator('#review')).toBeVisible();expect(attempts[2]).not.toBe(attempts[1]);expect(approvals).toBe(1);
});

test('manual creation retains one private ticket across interrupted provisioning and reload',async({page})=>{
  const attempts:any[]=[];let fail=true;
  await page.route('**/v3/services',async r=>{
    if(r.request().method()==='POST'){
      const body=r.request().postDataJSON();attempts.push(body);
      expect(body).not.toHaveProperty('serviceCredential');expect(body.deliveryPublicKey).not.toHaveProperty('d');
      await r.fulfill(fail?{status:503,json:{error:'unavailable'}}:{status:201,json:{serviceId:'new-agent'}});
    } else await r.fulfill({json:[]});
  });
  await page.goto(origin+'/owned-services');await expect(page.locator('#list')).toBeVisible();
  await page.locator('#create-agent').click();await page.locator('#agent-name').fill('Portable agent');await page.locator('#agent-purpose').fill('Ask for decisions');
  await page.getByRole('button',{name:'Create agent and save ticket',exact:true}).click();await expect(page.locator('#retry')).toBeVisible();
  await page.reload();await expect(page.locator('#save-ticket')).toBeVisible();fail=false;
  const download=page.waitForEvent('download');await page.locator('#save-ticket').click();await download;
  expect(attempts).toHaveLength(2);expect(attempts[0]).toEqual(attempts[1]);
  await expect(page.locator('body')).not.toContainText('smss_');await expect(page.locator('body')).not.toContainText('privateKey');
});

test('a failed private storage write is retried before any provisioning request',async({page})=>{
  await page.addInitScript(()=>{
    const put=IDBObjectStore.prototype.put;let fail=true;
    IDBObjectStore.prototype.put=function(this:IDBObjectStore,value:unknown,key?:IDBValidKey){
      if(fail){fail=false;throw new DOMException('Synthetic storage failure','QuotaExceededError');}
      return key===undefined ? put.call(this,value) : put.call(this,value,key);
    };
  });
  let provisions=0;
  await page.route('**/v3/services',async r=>{
    if(r.request().method()==='POST'){provisions++;await r.fulfill({status:201,json:{serviceId:'agent'}});}
    else await r.fulfill({json:[]});
  });
  await page.goto(origin+'/owned-services');await expect(page.locator('#list')).toBeVisible();
  await page.locator('#create-agent').click();await page.locator('#agent-name').fill('Retry agent');await page.locator('#agent-purpose').fill('Decisions');
  const submit=page.getByRole('button',{name:'Create agent and save ticket',exact:true});
  await submit.click();await expect(page.locator('#retry')).toBeVisible();expect(provisions).toBe(0);
  const download=page.waitForEvent('download');await submit.click();await download;expect(provisions).toBe(1);
});

test('unavailable private ticket storage preserves existing agent management and prevents provisioning',async({page})=>{
  await page.addInitScript(()=>{
    indexedDB.open=()=>{throw new DOMException('Synthetic database failure','SecurityError');};
  });
  let active=true,deleted=false,provisions=0,updates=0;
  await page.route('**/v3/**',async r=>{
    if(r.request().method()==='POST'){provisions++;await r.fulfill({status:201,json:{serviceId:'new-agent'}});}
    else if(r.request().method()==='PATCH'){updates++;active=false;await r.fulfill({json:{ok:true}});}
    else if(r.request().method()==='DELETE'){deleted=true;await r.fulfill({json:{ok:true}});}
    else await r.fulfill({json:deleted?[]:[{serviceId:'owned',name:'Existing agent',purpose:'Decisions',capabilities:['forms'],active,servicePath:'/services/owned'}]});
  });
  await page.goto(origin+'/owned-services');await expect(page.locator('#list')).toBeVisible();
  await page.locator('#create-agent').click();await page.locator('#agent-name').fill('New agent');await page.locator('#agent-purpose').fill('Decisions');
  await page.getByRole('button',{name:'Create agent and save ticket',exact:true}).click();
  await expect(page.locator('#retry')).toBeVisible();expect(provisions).toBe(0);
  await page.locator('#cancel-create').click();await page.getByRole('button',{name:'Existing agent · Enabled',exact:true}).click();
  await expect(page.locator('#detail')).toBeVisible();await page.locator('#toggle').click();
  await expect(page.locator('#toggle')).toHaveText('Enable service');expect(updates).toBe(1);
  page.once('dialog',dialog=>dialog.accept());await page.locator('#delete').click();
  await expect(page.locator('#list')).toBeVisible();expect(deleted).toBe(true);expect(provisions).toBe(0);
});


test('two already-open tabs cannot replace another retained private ticket',async({page,context})=>{
  const declarations:any[]=[];
  await context.route('**/v3/services',async r=>{
    if(r.request().method()==='POST'){
      declarations.push(r.request().postDataJSON());
      await r.fulfill({status:503,json:{error:'interrupted'}});
    }else await r.fulfill({json:[]});
  });
  const other=await context.newPage();
  await Promise.all([page.goto(origin+'/owned-services'),other.goto(origin+'/owned-services')]);
  for(const tab of [page,other])await expect(tab.locator('#list')).toBeVisible();
  async function create(tab:typeof page,name:string){
    await tab.locator('#create-agent').click();await tab.locator('#agent-name').fill(name);await tab.locator('#agent-purpose').fill('Decisions');
    await tab.getByRole('button',{name:'Create agent and save ticket',exact:true}).click();await expect(tab.locator('#retry')).toBeVisible();
  }
  await create(page,'First agent');await create(other,'Second agent');
  expect(declarations).toHaveLength(1);
  await other.reload();await expect(other.locator('#ticket-state')).toBeVisible();
  await other.locator('#save-ticket').click();
  await expect.poll(()=>declarations.length).toBe(2);
  expect(declarations[1]).toEqual(declarations[0]);
});

test('a delayed retained-ticket read cannot cross an account change',async({page})=>{
  await page.route('https://www.gstatic.com/firebasejs/**/firebase-auth.js',r=>r.fulfill({contentType:'application/javascript',body:`
    const user=uid=>({uid,email:uid+'@example.test',getIdToken:async()=>uid});
    const auth={currentUser:user('owner-a')};let listener;
    window.switchRelayOwner=uid=>{auth.currentUser=user(uid);listener(auth.currentUser);};
    export const getAuth=()=>auth;export const signOut=async()=>{};export class GoogleAuthProvider{};export class OAuthProvider{constructor(id){this.providerId=id;}};export const linkWithPopup=async()=>({user:auth.currentUser});
    export const signInWithPopup=async()=>({});export const signInWithRedirect=async()=>({});export const getRedirectResult=async()=>({});
    export const onAuthStateChanged=(a,fn)=>{listener=fn;queueMicrotask(()=>fn(a.currentUser));};export const setPersistence=async()=>{};export const browserLocalPersistence={};
  `}));
  await page.route('**/ticket-browser-real.js',r=>r.fulfill({contentType:'application/javascript',body:readFileSync(new URL('../public/ticket-browser.js',import.meta.url),'utf8')}));
  await page.route('**/ticket-browser.js',r=>r.fulfill({contentType:'application/javascript',body:`
    import * as real from '/ticket-browser-real.js';
    export const {createTicket,declaration,downloadTicket}=real;
    export async function retained(uid,...args){
      const value=await real.retained(uid,...args);
      if(args.length===0&&sessionStorage.getItem('gate-owner-reads')){
        await new Promise(resolve=>{window[uid==='owner-a'?'releaseOwnerA':'releaseOwnerB']=resolve;});
        if(uid==='owner-a')setTimeout(()=>{window.ownerAReadFlushed=true;},0);
      }
      return value;
    }
  `}));
  let ownerBPosts=0;
  await page.route('**/v3/services',async r=>{
    if(r.request().method()==='POST'){
      if(r.request().headers().authorization==='Bearer owner-b')ownerBPosts++;
      await r.fulfill({status:503,json:{error:'interrupted'}});
    }else await r.fulfill({json:[]});
  });
  await page.goto(origin+'/owned-services');await expect(page.locator('#list')).toBeVisible();
  await page.locator('#create-agent').click();await page.locator('#agent-name').fill('Owner A agent');await page.locator('#agent-purpose').fill('Decisions');
  await page.getByRole('button',{name:'Create agent and save ticket',exact:true}).click();await expect(page.locator('#retry')).toBeVisible();
  await page.evaluate(()=>sessionStorage.setItem('gate-owner-reads','yes'));await page.reload();
  await page.waitForFunction(()=>typeof (window as any).releaseOwnerA==='function');
  await page.evaluate(()=>(window as any).switchRelayOwner('owner-b'));
  await page.waitForFunction(()=>typeof (window as any).releaseOwnerB==='function');
  await expect(page.locator('#identity')).toContainText('owner-b@example.test');
  await page.evaluate(()=>(window as any).releaseOwnerA());await page.waitForFunction(()=>(window as any).ownerAReadFlushed);
  if(await page.locator('#ticket-state').isVisible()){
    await page.locator('#save-ticket').click();await expect(page.locator('#retry')).toBeVisible();
  }
  const ownerBHasTicket=await page.evaluate(async()=>!!await (await import(location.origin+'/ticket-browser-real.js')).retained('owner-b'));
  await page.evaluate(()=>(window as any).releaseOwnerB());
  expect(ownerBPosts).toBe(0);expect(ownerBHasTicket).toBe(false);
  await expect(page.locator('#ticket-state')).toBeHidden();
});
