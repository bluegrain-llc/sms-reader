import { ensure } from './model.js';

export function androidLinkTarget(packageName = 'com.bluegrain.smsrelay') {
  ensure(['com.bluegrain.smsrelay', 'com.bluegrain.smsrelay.staging'].includes(packageName), 503, 'app_links_not_configured');
  return { packageName, scheme: packageName.endsWith('.staging') ? 'smsrelay-staging' : 'smsrelay' };
}

/** Keep legacy installed APKs associated while Play adds signing identities. */
export function signingFingerprints(legacy?: string, additional?: unknown): string[] {
  ensure(additional === undefined || Array.isArray(additional), 503, 'app_links_not_configured');
  const values: unknown[] = [...(additional as unknown[] | undefined ?? []), ...(legacy ? [legacy] : [])];
  ensure(values.length > 0 && values.every(f => typeof f === 'string' && /^(?:[A-Fa-f0-9]{2}:){31}[A-Fa-f0-9]{2}$/.test(f)), 503, 'app_links_not_configured');
  return [...new Set((values as string[]).map(f => f.toUpperCase()))];
}
