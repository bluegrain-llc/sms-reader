import { createHmac } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import ipaddr from 'ipaddr.js';
import { ensure } from './model.js';

export const publicAddress = (address: string) => {
  try { const ip = ipaddr.process(address); return ip.range() === 'unicast'; } catch { return false; }
};
export async function validateDestination(raw: string) {
  const url = new URL(raw);
  ensure(url.protocol === 'https:' && !url.username && !url.password && !url.hash && (!url.port || url.port === '443'), 400, 'invalid_webhook_url');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = ipaddr.isValid(hostname) ? [{ address: hostname, family: ipaddr.parse(hostname).kind() === 'ipv4' ? 4 : 6 }] : await new Promise<{ address: string; family: number }[]>((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('webhook_dns_timeout')), 3000);
    lookup(hostname, { all: true }).then(resolve, reject).finally(() => clearTimeout(timer));
  });
  ensure(addresses.length && addresses.every(a => publicAddress(a.address)), 400, 'private_webhook_destination');
  return { url, address: addresses[0]! };
}
export function signature(secret: string, timestamp: string, body: string) {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}
export async function sendWebhook(raw: string, secret: string, event: unknown) {
  // Resolve on every attempt and pin the checked address for the TLS connection.
  // Node verifies the certificate against the original hostname. Redirects are never followed.
  const { url, address } = await validateDestination(raw);
  const body = JSON.stringify(event), timestamp = String(Math.floor(Date.now() / 1000));
  await new Promise<void>((resolve, reject) => {
    const req = request(url, { method: 'POST', agent: false, family: address.family,
      lookup: (_hostname, options, cb) => {
        if (options.all) cb(null, [address]); else cb(null, address.address, address.family);
      },
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
        'Relay-Event-ID': (event as { id: string }).id, 'Relay-Timestamp': timestamp,
        'Relay-Signature': `v1=${signature(secret, timestamp, body)}` },
    }, res => { res.resume(); if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) resolve(); else reject(Error('webhook_rejected')); });
    const timer = setTimeout(() => req.destroy(Error('webhook_timeout')), 10_000);
    req.on('error', reject); req.on('close', () => clearTimeout(timer)); req.end(body);
  });
}
