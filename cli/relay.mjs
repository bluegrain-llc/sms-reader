#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import QRCode from 'qrcode';
import { PrivateStore, exportPrivateFile } from './store.mjs';
import { ServiceSession } from './service.mjs';
import { credential } from './client.mjs';
const usage = `relay service register --name "My agent" --relay https://RELAY [--purpose TEXT] [--sms]
relay service connect | link | hosted-link | manage | deliveries | rotate-credential | rotate-key [--retire-key ID]
relay service import-ticket --file PATH | export-ticket --file PATH
relay status | resume
Use --profile NAME for each service; --store DIR selects private storage. --no-open keeps the browser closed.
Only public links and status are printed. Use relay-mcp --profile NAME --connection ID for model tools.`;
export async function main(args = process.argv.slice(2)) {
  const { values: v, positionals: p } = parseArgs({ args, allowPositionals: true, options: {
    file: { type: 'string' }, name: { type: 'string' }, purpose: { type: 'string' }, relay: { type: 'string' }, profile: { type: 'string', default: 'default' }, store: { type: 'string' }, sms: { type: 'boolean' }, 'no-open': { type: 'boolean' }, 'new-session': { type: 'boolean' }, 'retire-key': { type: 'string' }, 'external-account-ref': { type: 'string' }, 'expires-in-days': { type: 'string' }, help: { type: 'boolean' }, 'allow-http-loopback': { type: 'boolean' } } });
  if (v.help || !p.length) { console.log(usage); return; }
  const store = new PrivateStore(v.store, v.profile), unlock = await store.lock();
  const abort = new AbortController(); const stop = () => abort.abort(); process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    let state = await store.read();
    let command = p[0] === 'service' ? p[1] : p[0];
    const save = async () => store.write(state);
    if (command === 'resume' && state?.nextServiceToken) command = 'rotate-credential';
    else if (command === 'resume' && state?.nextKey) command = 'rotate-key';
    if (command === 'import-ticket') {
      if (state) throw Error('This profile is occupied. Choose a different --profile.');
      if (!v.file) throw Error('Import needs --file PATH.');
      const imported = await ServiceSession.importTicket(JSON.parse(await readFile(v.file, 'utf8')), store,
        {signal:abort.signal,allowHttpLoopback:v['allow-http-loopback']});
      console.log(`Agent imported. ${imported.state.serviceId}`); return;
    }
    if (command === 'register') {
      if (!state) {
        if (!v.name || !(v.relay || process.env.RELAY_URL)) throw Error('Registration needs --name and --relay.');
        const created = await ServiceSession.create({ baseUrl: v.relay || process.env.RELAY_URL, name: v.name, purpose: v.purpose || `Information and decisions requested by ${v.name}.`, capabilities: v.sms ? ['forms', 'sms'] : ['forms'] }, store, { signal: abort.signal, allowHttpLoopback: v['allow-http-loopback'] });
        state = created.state;
      } else if (state.registered) throw Error('This profile already has a service. Choose a different --profile.');
      if (v['new-session']) { state.registrationToken = credential('smsreg'); state.registration = null; await save(); }
    }
    if (!state) throw Error('No profile found. Run relay service register first.');
    if (v.relay && new URL(v.relay).origin !== state.baseUrl) throw Error('The relay origin cannot change for an existing profile.');
    const service = new ServiceSession(state, store, { signal: abort.signal, allowHttpLoopback: v['allow-http-loopback'] });
    const client = service.client;
    const show = async path => {
      const link = new URL(path, client.baseUrl).href; if (new URL(link).origin !== client.baseUrl) throw Error('Invalid public link.');
      console.log(link); console.log(await QRCode.toString(link, { type: 'terminal', small: true, errorCorrectionLevel: 'M' }));
      if (!v['no-open']) { const child = spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [link], { stdio: 'ignore', detached: true }); child.on('error', () => {}); child.unref(); }
    };
    const consume = () => service.consumeDeliveries();
    const registration = async () => {
      const started = await service.startRegistration();
      console.log("Register agent"); await show(started.registrationPath);
      await service.waitForRegistration();
      console.log('Service registered. Permanent connection link:'); await show(state.servicePath);
    };
    const pairing = async () => {
      let options;
      if (!state.pairingInput || v['new-session']) {
        const days = v['expires-in-days'] ? Number(v['expires-in-days']) : null;
        if (days !== null && (!Number.isInteger(days) || days < 1 || days > 365)) throw Error('Expiry must be 1–365 days.');
        options = { capabilities: state.capabilities, expiresInDays: days, externalAccountRef: v['external-account-ref'] };
      }
      const started = v['new-session'] ? await service.restartPairing(options) : await service.startPairing(options);
      console.log(`Connect to agent · Compare code ${started.comparisonCode}`); await show(started.connectionPath);
      const connectionId = await service.waitForPairing();
      console.log(`Access granted. Connection ${connectionId}`);
      if (state.connections[connectionId]) console.log((await service.connection(connectionId).status()).setup);
    };
    if (command === 'export-ticket') {
      if (!v.file) throw Error('Export needs --file PATH.');
      const ticket = await service.exportTicket();
      await exportPrivateFile(v.file, ticket);
      console.log('Private session ticket saved. Supply it only to your agent.');
    } else if (command === 'register' || (command === 'resume' && !state.registered)) await registration();
    else if (command === 'connect' || (command === 'resume' && state.pairingInput)) await pairing();
    else if (command === 'hosted-link') { if (!state.registered) throw Error('Register this service first.'); console.log(new URL(`/mcp/services/${state.serviceId}`, state.baseUrl).href); }
    else if (command === 'manage') await show('/owned-services');
    else if (command === 'link') await show(state.servicePath);
    else if (command === 'deliveries' || command === 'resume') { console.log(`Stored ${await consume()} delivery(s).`); }
    else if (command === 'rotate-credential') {
      await service.rotateCredential(); console.log('Service credential rotated.');
    } else if (command === 'rotate-key') {
      await service.rotateKey(v['retire-key']);
      console.log('Delivery key rotated; previous private keys retained for outstanding deliveries.');
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
