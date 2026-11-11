import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
let server: Server, origin: string;
const config = { apiKey: 'public', authDomain: 'demo.firebaseapp.com', projectId: 'demo', appId: 'public' };
test.beforeAll(async () => {
  server = createServer((req,res) => {
    if (req.url === '/owned-services.js') { res.setHeader('Content-Type','application/javascript'); res.end(readFileSync(new URL('../public/owned-services.js',import.meta.url))); }
    else if (req.url?.startsWith('/owned-services')) { res.setHeader('Content-Type','text/html'); res.end(readFileSync(new URL('../public/owned-services.html',import.meta.url),'utf8').replaceAll('__NONCE__','testnonce').replace('__CONFIG__',JSON.stringify(config))); }
    else if (req.url === '/onboarding-qr.js') { res.setHeader('Content-Type','application/javascript'); res.end(readFileSync(new URL('../public/onboarding-qr.js',import.meta.url))); }
    else if (req.url === '/onboarding.js') { res.setHeader('Content-Type','application/javascript'); res.end(readFileSync(new URL('../public/onboarding.js',import.meta.url))); }
    else { res.setHeader('Content-Type','text/html'); res.end(readFileSync(new URL('../public/onboarding.html',import.meta.url),'utf8').replaceAll('__NONCE__','testnonce').replace('__CONFIG__',JSON.stringify(config))); }
  }).listen(0,'127.0.0.1'); await once(server,'listening'); origin = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
});
test.afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve())); });
test.beforeEach(async ({ page }) => {
  await page.route('https://www.gstatic.com/firebasejs/**/firebase-app.js',r=>r.fulfill({contentType:'application/javascript',body:'export const initializeApp=()=>({});'}));
  await page.route('https://www.gstatic.com/firebasejs/**/firebase-auth.js',r=>r.fulfill({contentType:'application/javascript',body:`const user={email:'my-own-account@example.test',getIdToken:async()=> 'owner-session'}; const auth={currentUser:user};export const getAuth=()=>auth;export class GoogleAuthProvider{};export const signInWithPopup=async()=>({});export const signInWithRedirect=async()=>({});export const getRedirectResult=async()=>({});export const onAuthStateChanged=(a,fn)=>{queueMicrotask(()=>fn(user));};export const setPersistence=async()=>{};export const browserLocalPersistence={};`}));
});
const review = { sessionId:'public-session', serviceId:'public-service', name:'My personal agent', purpose:'Ask for decisions', capabilities:['forms','sms'], status:'pending', expiresAt:Date.now()+600000, expiresInDays:null, comparisonCode:'123456',connectionId:null };
test('registration defaults owner access off, needs one confirmation, no phone setup', async ({page})=>{
  let approvals=0;
  await page.route('**/v3/**',async r=>{
    if(r.request().url().endsWith('/decision')){approvals++;const body=r.request().postDataJSON();expect(body.selfAccess).toBe(false);await r.fulfill({json:{...review,status:'approved',connectionId:null}});}
    else await r.fulfill({json:review});
  });
  await page.goto(origin+'/register/public-session'); await expect(page.locator('#review')).toBeVisible();
  await page.screenshot({path:'artifacts/onboarding-desktop.png',fullPage:true});
  await expect(page.locator('#self')).not.toBeChecked();await expect(page.locator('#permissions')).toBeHidden();
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
test('owner self access and phone handoff occur after explicit approval',async({page})=>{
  let approvals=0;
  await page.route('**/v3/**',async r=>{
    if(r.request().url().endsWith('/decision')){approvals++;expect(r.request().postDataJSON().selfAccess).toBe(true);await r.fulfill({json:{...review,status:'approved',connectionId:'connection'}});}
    else if(r.request().url().endsWith('/connections/connection'))await r.fulfill({json:{setup:'phone_setup_needed',receivingDeviceAvailable:false,revoked:false}});
    else await r.fulfill({json:review});
  });
  await page.goto(origin+'/register/public-session');await expect(page.locator('#review')).toBeVisible();await page.locator('#self').check();await expect(page.locator('#permissions')).toBeVisible();expect(approvals).toBe(0);
  await page.locator('#confirm').click();await expect(page.locator('#phone')).toBeVisible();expect(approvals).toBe(1);
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
