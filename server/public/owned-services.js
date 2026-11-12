import { createTicket, declaration, retained, downloadTicket } from '/ticket-browser.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-app.js';
import { getAuth, signOut, GoogleAuthProvider, signInWithPopup, getRedirectResult, signInWithRedirect, onAuthStateChanged, setPersistence, browserLocalPersistence } from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-auth.js';
const $ = id => document.getElementById(id);
let auth, busy = false, services = [], pendingTicket;
const status = text => { $('status').textContent = text; };
const selected = () => new URL(location.href).searchParams.get('service');
async function api(path, method = 'GET', body) {
  const token = await auth.currentUser.getIdToken();
  const response = await fetch(path, {method,credentials:'omit',headers:{Authorization:`Bearer ${token}`,...(body ? {'Content-Type':'application/json'} : {})},...(body ? {body:JSON.stringify(body)} : {})});
  const value = await response.json(); if (!response.ok) throw Error('Could not update your services. Try again to check the current state.'); return value;
}
async function run(work) {
  if (busy) return; busy = true; document.querySelectorAll('button').forEach(b=>b.disabled=true);
  try { await work(); } catch(e) { status(e.message); $('retry').hidden=false; }
  finally {busy=false;document.querySelectorAll('button').forEach(b=>b.disabled=false);}
}
function choose(id) { history.replaceState({},'', id ? `/owned-services?service=${encodeURIComponent(id)}` : '/owned-services'); return render(); }
async function render() {
  const service = services.find(s=>s.serviceId===selected());
  $('detail').hidden = !service; $('list').hidden = !!service;
  if (!service) {
    $('title').textContent='Your services'; $('services').replaceChildren();
    for(const s of services) {
      const item=document.createElement('li'),button=document.createElement('button');button.className='secondary';
      button.textContent=`${s.name} · ${s.active ? 'Enabled' : 'Disabled'}`;button.onclick=()=>run(()=>choose(s.serviceId));item.append(button);$('services').append(item);
    }
    status(services.length ? 'Choose a service to manage its access.' : 'No agents registered. Create an agent or scan its registration link.');return;
  }
  $('title').textContent=service.name;$('purpose').textContent=service.purpose;
  $('capabilities').textContent=service.capabilities.map(c=>c==='forms'?'Forms and decisions':'SMS codes with your approval').join(' · ');
  $('toggle').textContent=service.active?'Disable service':'Enable service';
  const link=new URL(service.servicePath,location.origin);if(link.origin!==location.origin)throw Error('Invalid service link.');
  $('link').href=link.href;$('link').textContent=link.href;
  const {default:qr}=await import('/onboarding-qr.js');await qr.toCanvas($('qr'),link.href,{width:256,errorCorrectionLevel:'M'});
  status(service.active?'Enabled. Each recipient controls their own permissions.':'Disabled. Its connections cannot send requests or read results.');
}
async function load() {
  if(!auth.currentUser)return;$('signin').hidden=true;$('signout').hidden=false;$('identity').textContent=`Signed in as ${auth.currentUser.email || 'your account'}`;
  pendingTicket=await retained(auth.currentUser.uid);$('ticket-state').hidden=!pendingTicket;
  services=await api('/v3/services');$('retry').hidden=true;await render();
}
$('create-agent').onclick=()=>{$('create-form').hidden=false;};
$('cancel-create').onclick=()=>{$('create-form').hidden=true;};
$('create-form').onsubmit=e=>{e.preventDefault();void run(async()=>{
  const agent={name:$('agent-name').value.trim(),purpose:$('agent-purpose').value.trim(),capabilities:['forms','sms'].filter(c=>$(c==='forms'?'agent-forms':'agent-sms').checked)};
  if(!agent.name||!agent.purpose||!agent.capabilities.length)throw Error('Enter a name, description and at least one capability.');
  if(!pendingTicket){pendingTicket=await createTicket(agent);}
  else if(JSON.stringify(pendingTicket.agent)!==JSON.stringify(agent))throw Error('Save or clear the previous ticket before creating a different agent.');
  await retained(auth.currentUser.uid,pendingTicket);
  await api('/v3/services','POST',await declaration(pendingTicket));
  downloadTicket(pendingTicket);$('create-form').hidden=true;await load();status('Agent created. Save its private ticket. Connecting requires a separate approval.');
});};
$('save-ticket').onclick=()=>run(async()=>{if(!pendingTicket)return;await retained(auth.currentUser.uid,pendingTicket);await api('/v3/services','POST',await declaration(pendingTicket));downloadTicket(pendingTicket);});
$('forget-ticket').onclick=()=>run(async()=>{if(!confirm('Confirm the ticket is safely saved or the agent is no longer needed. Clear this browser’s retained ticket?'))return;await retained(auth.currentUser.uid,null);pendingTicket=null;$('ticket-state').hidden=true;});
$('back').onclick=()=>run(()=>choose(null));$('retry').onclick=()=>run(load);
$('toggle').onclick=()=>run(async()=>{const s=services.find(s=>s.serviceId===selected());if(!s)return;await api(`/v3/services/${s.serviceId}`,'PATCH',{active:!s.active});await load();});
$('delete').onclick=()=>run(async()=>{const s=services.find(s=>s.serviceId===selected());if(!s||!confirm(`Delete ${s.name}? Every connection to this service will lose access. Recipients keep their unrelated history.`))return;await api(`/v3/services/${s.serviceId}`,'DELETE');await choose(null);await load();status('Service deleted. Its connections no longer have access.');});
if(!window.relayWebConfig)status('Web sign-in is not configured on this relay.');
else {
  auth=getAuth(initializeApp(window.relayWebConfig));await setPersistence(auth,browserLocalPersistence);
  async function signIn(provider) { try { await signInWithPopup(auth, provider); } catch (e) { if (e.code === 'auth/popup-blocked') await signInWithRedirect(auth, provider); else throw e; } }
  $('signin').onclick=()=>run(()=>signIn(new GoogleAuthProvider()));
  await getRedirectResult(auth).catch(()=>status('Could not sign in. Try again.'));
  onAuthStateChanged(auth,user=>{if(user)void load().catch(e=>{status(e.message);$('retry').hidden=false;});else{pendingTicket=undefined;services=[];$('list').hidden=true;$('detail').hidden=true;$('identity').textContent='';$('signin').hidden=false;$('signout').hidden=true;status('Sign in to manage the services you own.');}});
}

$('signout').onclick=()=>run(()=>signOut(auth));
