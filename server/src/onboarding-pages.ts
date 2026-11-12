import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Express } from 'express';
import type { WebConfig } from './account-pages.js';
import { idSchema } from './model.js';
const document = readFileSync(new URL('../public/onboarding.html', import.meta.url), 'utf8');
const script = readFileSync(new URL('../public/onboarding.js', import.meta.url), 'utf8');
export function mountOnboardingPages(app: Express, config?: WebConfig) {
  app.get('/owned-services.js', (_r,s)=>{s.type('application/javascript').send(readFileSync(new URL('../public/owned-services.js',import.meta.url),'utf8'));});
  app.get('/onboarding-qr.js', (_r, s) => { s.type('application/javascript').send(readFileSync(new URL('../public/onboarding-qr.js', import.meta.url), 'utf8')); });
  app.get('/onboarding.js', (_r, s) => { s.type('application/javascript').send(script); });
  for (const route of ['/register/:id', '/pair/:id', '/services/:id', '/connections/:id', '/oauth/consent/:id', '/owned-services']) app.get(route, (r, s) => {
    if (r.params.id !== undefined) idSchema.parse(r.params.id);
    const nonce = randomBytes(18).toString('base64');
    s.set('Content-Security-Policy', `default-src 'none'; script-src 'self' 'nonce-${nonce}' https://www.gstatic.com https://apis.google.com; style-src 'unsafe-inline'; connect-src 'self' https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://*.firebaseapp.com; frame-src https://*.firebaseapp.com https://accounts.google.com; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`);
    s.set('Referrer-Policy', 'no-referrer'); s.set('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
    const valid = config && config.apiKey && config.appId && /^[a-z0-9-]+$/.test(config.projectId) && config.authDomain === `${config.projectId}.firebaseapp.com`;
    const json = JSON.stringify(valid ? config : null).replace(/</g, '\\u003c');
    const template = r.path === '/owned-services' ? readFileSync(new URL('../public/owned-services.html', import.meta.url), 'utf8') : document;
    s.status(valid ? 200 : 503).type('html').send(template.replaceAll('__NONCE__', nonce).replace('__CONFIG__', json));
  });
}
