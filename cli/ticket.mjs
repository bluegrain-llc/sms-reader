import { createECDH } from 'node:crypto';
import { hash, RelayClient } from './client.mjs';
const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(k => fields.includes(k));
/** Private transport format. Never expose this value as a model tool result. */
export function validateTicket(ticket, options) {
  if (!exact(ticket, ['version','relayOrigin','agent','serviceCredential','deliveryKeys']) || ticket.version !== 1 ||
      !exact(ticket.agent, ['name','purpose','capabilities']) ||
      !/^smss_[A-Za-z0-9_-]{43}$/.test(ticket.serviceCredential) ||
      typeof ticket.agent.name !== 'string' || !ticket.agent.name.trim() || ticket.agent.name.length > 80 ||
      typeof ticket.agent.purpose !== 'string' || !ticket.agent.purpose.trim() || ticket.agent.purpose.length > 240 ||
      !Array.isArray(ticket.agent.capabilities) || !ticket.agent.capabilities.length || ticket.agent.capabilities.length > 2 ||
      new Set(ticket.agent.capabilities).size !== ticket.agent.capabilities.length || ticket.agent.capabilities.some(c => !['forms','sms'].includes(c)) ||
      !Array.isArray(ticket.deliveryKeys) || !ticket.deliveryKeys.length || ticket.deliveryKeys.length > 100) throw Error('Invalid session ticket.');
  const client = new RelayClient(ticket.relayOrigin, options);
  const ids = new Set();
  for (const key of ticket.deliveryKeys) {
    const p = key?.publicKey, q = key?.privateKey;
    if (!exact(key,['id','publicKey','privateKey']) || !exact(p,['kty','crv','x','y']) || !exact(q,['kty','crv','x','y','d']) ||
        p.kty !== 'EC' || p.crv !== 'P-256' || ![p.x,p.y,q.d].every(v => typeof v === 'string' && /^[A-Za-z0-9_-]{43}$/.test(v)) ||
        ['kty','crv','x','y'].some(k => p[k] !== q[k])) throw Error('Invalid ticket delivery key.');
    const ec = createECDH('prime256v1'); ec.setPrivateKey(Buffer.from(q.d,'base64url'));
    const raw = ec.getPublicKey();
    const id = hash(JSON.stringify({kty:p.kty,crv:p.crv,x:p.x,y:p.y}));
    if (raw.subarray(1,33).toString('base64url') !== p.x || raw.subarray(33).toString('base64url') !== p.y || id !== key.id || ids.has(id)) throw Error('Ticket key binding does not match.');
    ids.add(id);
  }
  return client;
}
export async function verifyTicket(ticket, options) {
  const client = validateTicket(ticket, options);
  const service = await client.request('/v3/service', ticket.serviceCredential);
  const a = ticket.agent;
  if (!service.active || service.name !== a.name || service.purpose !== a.purpose ||
      JSON.stringify([...service.capabilities].sort()) !== JSON.stringify([...a.capabilities].sort()) ||
      !ticket.deliveryKeys.some(k => k.id === service.deliveryKeyId)) throw Error('Ticket does not match the active agent.');
  return {client, service};
}
