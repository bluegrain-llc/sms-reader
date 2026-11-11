#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import QRCode from 'qrcode';
import { PrivateStore } from './store.mjs';
import { credential, deliveryKey, hash, RelayClient } from './client.mjs';
const usage = `relay service register --name "My agent" --relay https://RELAY [--purpose TEXT] [--sms]
relay service connect | link | hosted-link | manage | deliveries | rotate-credential | rotate-key [--retire-key ID]
relay status | resume
Use --profile NAME for each service; --store DIR selects private storage. --no-open keeps the browser closed.
Only public links and status are printed. Use relay-mcp --profile NAME --connection ID for model tools.`;
export async function main(args = process.argv.slice(2)) {
  const { values: v, positionals: p } = parseArgs({ args, allowPositionals: true, options: {
    name: { type: 'string' }, purpose: { type: 'string' }, relay: { type: 'string' }, profile: { type: 'string', default: 'default' }, store: { type: 'string' }, sms: { type: 'boolean' }, 'no-open': { type: 'boolean' }, 'new-session': { type: 'boolean' }, 'retire-key': { type: 'string' }, 'external-account-ref': { type: 'string' }, 'expires-in-days': { type: 'string' }, help: { type: 'boolean' }, 'allow-http-loopback': { type: 'boolean' } } });
  if (v.help || !p.length) { console.log(usage); return; }
  const store = new PrivateStore(v.store, v.profile), unlock = await store.lock();
  const abort = new AbortController(); const stop = () => abort.abort(); process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    let state = await store.read();
    let command = p[0] === 'service' ? p[1] : p[0];
    const save = async () => store.write(state);
    if (command === 'resume' && state?.nextServiceToken) command = 'rotate-credential';
    else if (command === 'resume' && state?.nextKey) command = 'rotate-key';
    if (command === 'register') {
      if (!state) {
        if (!v.name || !(v.relay || process.env.RELAY_URL)) throw Error('Registration needs --name and --relay.');
        const client = new RelayClient(v.relay || process.env.RELAY_URL, { allowHttpLoopback: v['allow-http-loopback'] });
        state = { version: 1, baseUrl: client.baseUrl, serviceToken: credential('smss'), registrationToken: credential('smsreg'), keys: [await deliveryKey()], name: v.name, purpose: v.purpose || `Information and decisions requested by ${v.name}.`, capabilities: v.sms ? ['forms', 'sms'] : ['forms'], connections: {} };
        await save();
      } else if (state.registered) throw Error('This profile already has a service. Choose a different --profile.');
      if (v['new-session']) { state.registrationToken = credential('smsreg'); state.registration = null; await save(); }
    }
    if (!state) throw Error('No profile found. Run relay service register first.');
    if (v.relay && new URL(v.relay).origin !== state.baseUrl) throw Error('The relay origin cannot change for an existing profile.');
    const client = new RelayClient(state.baseUrl, { signal: abort.signal, allowHttpLoopback: v['allow-http-loopback'] });
    const show = async path => {
      const link = new URL(path, client.baseUrl).href; if (new URL(link).origin !== client.baseUrl) throw Error('Invalid public link.');
      console.log(link); console.log(await QRCode.toString(link, { type: 'terminal', small: true, errorCorrectionLevel: 'M' }));
      if (!v['no-open']) { const child = spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [link], { stdio: 'ignore', detached: true }); child.on('error', () => {}); child.unref(); }
    };
    const consume = () => client.consume(state, () => save());
    const registration = async () => {
      const key = state.keys[0];
      state.registration = await client.request('/v3/registration-sessions', state.registrationToken, { name: state.name, purpose: state.purpose, capabilities: state.capabilities, credentialHash: hash(state.serviceToken), deliveryPublicKey: key.publicKey });
      await save(); await show(state.registration.registrationPath);
      const result = await client.poll(() => client.request('/v3/registration-sessions/current', state.registrationToken), r => r.status === 'approved');
      state.serviceId = result.serviceId; state.servicePath = result.servicePath; state.registered = true; await save();
      await consume(); console.log('Service registered. Permanent connection link:'); await show(state.servicePath);
    };
    const pairing = async () => {
      if (!state.pairingInput || v['new-session']) {
        const days = v['expires-in-days'] ? Number(v['expires-in-days']) : null;
        if (days !== null && (!Number.isInteger(days) || days < 1 || days > 365)) throw Error('Expiry must be 1–365 days.');
        state.pairingInput = { capabilities: state.capabilities, expiresInDays: days, idempotencyKey: randomUUID(), ...(v['external-account-ref'] ? { externalAccountRef: v['external-account-ref'] } : {}) }; await save();
      }
      state.pairing = await client.request('/v3/service/pairing-sessions', state.serviceToken, state.pairingInput); await save();
      console.log(`Compare code ${state.pairing.comparisonCode}`); await show(state.pairing.connectionPath);
      const result = await client.poll(() => client.request(`/v3/service/pairing-sessions/${state.pairing.sessionId}`, state.serviceToken), r => r.status === 'approved');
      await consume(); state.pairingInput = null; state.pairing = null; await save();
      console.log(`Access granted. Connection ${result.connectionId}`);
      const connection = state.connections[result.connectionId];
      if (connection) console.log((await client.request('/v3/connection', connection.token)).setup);
    };
    if (command === 'register' || (command === 'resume' && !state.registered)) await registration();
    else if (command === 'connect' || (command === 'resume' && state.pairingInput)) await pairing();
    else if (command === 'hosted-link') { if (!state.registered) throw Error('Register this service first.'); console.log(new URL(`/mcp/services/${state.serviceId}`, state.baseUrl).href); }
    else if (command === 'manage') await show('/owned-services');
    else if (command === 'link') await show(state.servicePath);
    else if (command === 'deliveries' || command === 'resume') { console.log(`Stored ${await consume()} delivery(s).`); }
    else if (command === 'rotate-credential') {
      state.nextServiceToken ??= credential('smss'); await save();
      try { await client.request('/v3/service', state.serviceToken, { credentialHash: hash(state.nextServiceToken) }, 'PATCH'); }
      catch (e) { if (e.status !== 401) throw e; await client.request('/v3/service/deliveries', state.nextServiceToken); }
      state.serviceToken = state.nextServiceToken; delete state.nextServiceToken; await save(); console.log('Service credential rotated.');
    } else if (command === 'rotate-key') {
      state.nextKey ??= await deliveryKey(); await save();
      await client.request('/v3/service', state.serviceToken, { deliveryPublicKey: state.nextKey.publicKey, ...(v['retire-key'] ? { retireKeyId: v['retire-key'] } : {}) }, 'PATCH');
      if (!state.keys.some(k => k.id === state.nextKey.id)) state.keys.push(state.nextKey);
      delete state.nextKey; await save(); console.log('Delivery key rotated; previous private keys retained for outstanding deliveries.');
    } else if (command === 'status') {
      console.log(state.registered ? `Registered service ${state.serviceId}` : 'Registration pending');
      for (const [id, connection] of Object.entries(state.connections)) {
        try { const status = await client.request('/v3/connection', connection.token); console.log(`${id}: ${status.setup}; ${status.capabilities.join(', ')}; ${status.expiresAt === null ? 'until disconnected' : new Date(status.expiresAt).toISOString()}`); }
        catch (e) { if (e.status === 401) console.log(`${id}: disconnected`); else throw e; }
      }
    } else throw Error(usage);
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); await unlock(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e => { console.error(e.name === 'AbortError' ? 'Interrupted. Run relay resume.' : e.message); process.exitCode = 1; });
