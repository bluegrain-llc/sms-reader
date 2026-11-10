import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mountAccountPages } from '../src/account-pages.js';

async function pages(configured: boolean, check: (base: string) => Promise<void>) {
  const app = express();
  mountAccountPages(app, configured ? { apiKey: '</script><img src=x onerror=alert(1)>', appId: 'public', projectId: 'fixture-project', authDomain: 'fixture-project.firebaseapp.com' } : undefined, '<script>alert(1)</script>');
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>(resolve => server.once('listening', resolve));
    await check(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
test('account pages escape operator/config text, isolate scripts and fail clearly without web configuration', { timeout: 10000 }, async () => {
  await pages(true, async base => {
    const privacy = await fetch(base + '/privacy', { signal: AbortSignal.timeout(3000) }); const text = await privacy.text();
    assert.ok(text.includes('&lt;script&gt;alert(1)&lt;/script&gt;')); assert.ok(!text.includes('<script>alert(1)</script>'));
    const response = await fetch(base + '/account/delete', { signal: AbortSignal.timeout(3000) }); const html = await response.text();
    assert.equal(response.status, 200); assert.ok(!html.includes('</script><img'));
    assert.ok(html.includes('\\u003c/script>')); assert.ok(html.includes('inMemoryPersistence'));
    assert.ok(html.includes('reauthenticateWithPopup')); assert.ok(html.includes('Secure sign-in could not load'));
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    const csp = response.headers.get('content-security-policy')!;
    assert.ok(csp.includes("frame-ancestors 'none'")); assert.ok(!csp.includes("script-src 'unsafe-inline'"));
    const again = await fetch(base + '/account/delete', { signal: AbortSignal.timeout(3000) }); assert.notEqual(csp, again.headers.get('content-security-policy'));
  });
  await pages(false, async base => {
    const response = await fetch(base + '/account/delete', { signal: AbortSignal.timeout(3000) }); assert.equal(response.status, 503);
    assert.ok((await response.text()).includes('Web sign-in is not configured yet'));
  });
});
