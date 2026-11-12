import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-app.js';
import { getAuth, signOut, GoogleAuthProvider, signInWithPopup, getRedirectResult, signInWithRedirect, onAuthStateChanged, setPersistence, browserLocalPersistence } from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-auth.js';
const $ = id => document.getElementById(id);
const parts = location.pathname.split('/').filter(Boolean);
const kind = parts[0], oauth = kind === 'oauth' && parts[1] === 'consent';
const destination = oauth ? parts[2] : parts[1];
const registration = kind === 'register', management = kind === 'connections';
let auth, session, service, busy = false, retry = load, monitor;
const status = text => { $('status').textContent = text; };
async function api(path, body, method = body === undefined ? 'GET' : 'POST') {
  const token = await auth.currentUser.getIdToken();
  const response = await fetch(path, { method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'omit' });
  const value = await response.json();
  if (!response.ok) throw Object.assign(new Error(value.error), { code: value.error });
  return value;
}
function fail(error) {
  const expired = ['session_expired','authorization_finished'].includes(error.code);
  status(expired ? 'This session expired. Start again and review access again.' : error.code === 'service_unavailable' ? 'This service is unavailable.' : 'Could not complete this step. Try again to check the current state.');
  $('retry').hidden = expired; $('restart').hidden = kind !== 'services' || !expired;
}
function lock(value) { busy = value; for (const id of ['confirm', 'cancel', 'signout', 'signin', 'self', 'forms', 'sms', 'duration', 'retry', 'restart', 'continue-to-app', 'check-phone']) $(id).disabled = value; }
async function run(fn) { if (busy) return; lock(true); $('retry').hidden = true; try { await fn(); } catch (e) { retry = fn; fail(e); } finally { lock(false); } }
const days = () => $('duration').value === '' ? null : Number($('duration').value);
const selection = () => ['forms', 'sms'].filter(c => $(c).checked && (session.availableCapabilities || session.capabilities).includes(c));
function permissions() { $('permissions').hidden = registration; }
async function completed() {
  $('review').hidden = true;
  if (kind === 'services') { localStorage.removeItem(`relay-onboarding:${auth.currentUser.uid}:${destination}`); $('restart').hidden = false; }
  if (oauth && session.status === 'denied') { await returnToClient(); return; }
  if (session.status === 'expired') {
    status('This ten-minute session has expired. Ask the service for a fresh link and approve it again.');
    $('restart').hidden = kind !== 'services'; return;
  }
  if (session.status === 'denied') { status('Cancelled. No new access was granted.'); return; }
  if (registration && !session.connectionId) { status('Service registered. Return to the CLI to finish saving its credentials. A phone is not required.'); return; }
  $('manage').hidden = false; $('manage').href = `/connections/${session.connectionId}`;
  status('Access granted. Waiting for service…');
  const check = async () => {
    if (!session.connectionId) return;
    const state = await api(`/v3/connections/${encodeURIComponent(session.connectionId)}`);
    $('phone').hidden = state.receivingDeviceAvailable || state.revoked;
    $('continue-to-app').hidden = !oauth || state.revoked;
    if (oauth && !state.revoked && state.receivingDeviceAvailable) { await returnToClient(); return; }
    status(state.revoked ? 'This connection is disconnected.' : state.setup === 'phone_setup_needed' ? 'Access granted — connect a phone to receive requests' : state.setup === 'waiting_for_service' ? 'Access granted. Waiting for service to store the connection…' : 'Setup complete. The service can request your approval.');
    clearTimeout(monitor);
    if (!state.revoked && state.setup !== 'setup_complete') monitor = setTimeout(() => check().catch(() => { retry = check; fail({}); }), 5000);
  };
  retry = check; $('check-phone').onclick = () => run(check); await check();
}
async function load() {
  clearTimeout(monitor);
  if (!auth.currentUser) return;
  $('signin').hidden = true;$('signout').hidden=false; $('identity').textContent = `Signed in as ${auth.currentUser.email || 'your account'}`;
  if (management) {
    session = await api(`/v3/connections/${encodeURIComponent(destination)}`);
    session = { ...session, sessionId: destination, status: session.revoked ? 'denied' : 'pending', expiresInDays: session.expiresAt === null ? null : Math.max(1, Math.ceil((session.expiresAt - Date.now()) / 86400000)) };
  } else if (oauth) {
    session = await api(`/v3/oauth/sessions/${encodeURIComponent(destination)}`);
  } else if (kind === 'services') {
    service = await api(`/v3/services/${encodeURIComponent(destination)}`);
    const key = `relay-onboarding:${auth.currentUser.uid}:${destination}`;
    let attempt = localStorage.getItem(key);
    if (!attempt) { attempt = crypto.randomUUID(); localStorage.setItem(key, attempt); }
    session = await api(`/v3/services/${encodeURIComponent(destination)}/connections`, { capabilities: service.capabilities, expiresInDays: null, idempotencyKey: attempt });
  } else session = await api(`/v3/${registration ? 'registration' : 'pairing'}-sessions/${encodeURIComponent(destination)}`);
  $('title').textContent = registration ? `Register agent · ${session.name}` : management ? `Manage ${session.name}` : `Connect to agent · ${session.name}`;
  $('purpose').textContent = session.purpose; $('operator').hidden = false;
  $('client').hidden = !oauth;
  $('handoff').hidden = !oauth;
  if (oauth) {
    const publicLink = location.origin + location.pathname;
    $('handoff-link').href = publicLink;
    const { default: qr } = await import('/onboarding-qr.js');
    await qr.toCanvas($('handoff-qr'), publicLink, { width: 256, errorCorrectionLevel: 'M' });
  }
  if (oauth) $('client').textContent = `Requested by ${session.clientName} (${session.clientOrigin}). These app details are supplied by the app operator.`;
  $('open-app').href = location.origin + location.pathname;
  if (session.status !== 'pending') { await completed(); return; }
  $('review').hidden = false; $('self-label').hidden = true; $('confirm').textContent = registration ? 'Register agent' : management ? 'Save permissions' : 'Connect'; $('cancel').textContent = management ? 'Disconnect' : 'Cancel';
  for (const cap of ['forms', 'sms']) { $(cap).checked = session.capabilities.includes(cap); $(cap).disabled = !(session.availableCapabilities || session.capabilities).includes(cap); $(cap).parentElement.hidden = !(session.availableCapabilities || session.capabilities).includes(cap); }
  for (const option of [...$('duration').options]) option.hidden = !management && session.expiresInDays != null && (option.value === '' || Number(option.value) > session.expiresInDays);
  if (session.expiresInDays != null && ![...$('duration').options].some(o => Number(o.value) === session.expiresInDays && o.value !== '')) $('duration').add(new Option(`${session.expiresInDays} days`, String(session.expiresInDays)));
  $('duration').value = session.expiresInDays == null ? '' : String(session.expiresInDays);
  $('comparison').hidden = registration || !session.comparisonCode; $('comparison-label').hidden = registration || !session.comparisonCode; $('comparison').textContent = session.comparisonCode || '';
  if (oauth) {
    clearTimeout(monitor);
    const check = async () => {
      const current = await api(`/v3/oauth/sessions/${destination}`);
      if (current.status !== 'pending') { session = current; await completed(); }
      else monitor = setTimeout(() => check().catch(() => { retry = load; fail({}); }), 5000);
    };
    monitor = setTimeout(() => check().catch(() => { retry = load; fail({}); }), 5000);
  }
  permissions(); status(registration ? 'Registration gives this agent no account access. Connect separately to share responses.' : 'Review the permissions. Every response still needs your approval.');
}
let returning = false;
async function returnToClient() {
  if (returning) return;
  returning = true;
  try { const result = await api(`/v3/oauth/sessions/${destination}/response`, {}); clearTimeout(monitor); status('Returning to the requesting app…'); location.assign(result.redirect); }
  catch (error) { returning = false; throw error; }
}
$('continue-to-app').onclick = () => run(returnToClient);
$('self').onchange = permissions;
$('confirm').onclick = () => run(async () => {
  const capabilities = selection();
  if (!registration && !capabilities.length) { status('Select at least one permission.'); return; }
  if (management) {
    await api(`/v3/connections/${destination}`, { capabilities, expiresAt: days() === null ? null : Date.now() + days() * 86400000 }, 'PATCH'); status('Permissions saved.'); return;
  }
  if (oauth) {
    const result = await api(`/v3/oauth/sessions/${destination}/decision`, { decision: 'approved', capabilities, expiresInDays: days() });
    clearTimeout(monitor); session = { ...session, ...result }; await completed(); return;
  }
  session = await api(`/v3/${registration ? 'registration' : 'pairing'}-sessions/${session.sessionId}/decision`, { decision: 'approved', ...(registration ? { selfAccess: false } : {}), capabilities: capabilities.length ? capabilities : session.capabilities, expiresInDays: days() });
  await completed();
});
$('cancel').onclick = () => run(async () => { if (oauth) { const result = await api(`/v3/oauth/sessions/${destination}/decision`, { decision: 'denied', capabilities: session.capabilities, expiresInDays: null }); clearTimeout(monitor); session = {...session,...result}; await returnToClient(); return; } if (management) { await api(`/v3/connections/${destination}`, undefined, 'DELETE'); $('review').hidden = true; status('Disconnected.'); return; } session = await api(`/v3/${registration ? 'registration' : 'pairing'}-sessions/${session.sessionId}/decision`, { decision: 'denied', ...(registration ? { selfAccess: false } : {}), capabilities: session.capabilities, expiresInDays: session.expiresInDays ?? null }); await completed(); });
$('retry').onclick = () => run(retry);
$('restart').onclick = () => run(async () => { localStorage.removeItem(`relay-onboarding:${auth.currentUser.uid}:${destination}`); $('restart').hidden = true; await load(); });
window.relayOnboardingReady = true;
try {
  const install = new URL(window.relayWebConfig?.androidInstallUrl);
  if (install.protocol === 'https:' && !install.username && !install.password && !install.hash) { $('install').href = install.href; $('install').hidden = false; }
} catch { /* The relay operator may distribute a private pilot installation separately. */ }

try { const install = new URL(window.relayWebConfig?.iosInstallUrl); if (install.protocol === 'https:' && !install.username && !install.password && !install.hash) { $('install-ios').href=install.href; $('install-ios').hidden=false; } } catch {}
if (!window.relayWebConfig) status('Web sign-in is not configured on this relay. Ask its operator to configure onboarding.');
else {
  auth = getAuth(initializeApp(window.relayWebConfig)); await setPersistence(auth, browserLocalPersistence);
  async function signIn(provider) { try { await signInWithPopup(auth, provider); } catch (e) { if (e.code === 'auth/popup-blocked') await signInWithRedirect(auth, provider); else throw e; } }
  $('signin').onclick=()=>run(()=>signIn(new GoogleAuthProvider()));
  await getRedirectResult(auth).catch(fail);
  onAuthStateChanged(auth, user => { if (user) { if (!busy) void run(load); else void load().catch(fail); } else { clearTimeout(monitor); $('identity').textContent = ''; $('review').hidden = true; $('phone').hidden = true; $('manage').hidden = true; $('handoff').hidden = true; $('signin').hidden = false;$('signout').hidden=true; status('Sign in to review this link. Opening it grants no access.'); } });
}

$('signout').onclick=()=>run(()=>signOut(auth));
