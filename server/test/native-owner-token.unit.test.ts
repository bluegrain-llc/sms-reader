import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { initializeApp, deleteApp } from 'firebase-admin/app';

// Exercise the installed Admin verifier with fixture keys, avoiding network key
// fetching. Rust's signed-token tests use this same test-only RSA key pair.
const require = createRequire(import.meta.url);
const adminLib = resolve(dirname(require.resolve('firebase-admin/app')), '..');
const { createIdTokenVerifier } = require(resolve(adminLib, 'auth/token-verifier.js'));
const { PublicKeySignatureVerifier } = require(resolve(adminLib, 'utils/jwt.js'));
const firebase = initializeApp({ projectId: 'demo-sms-relay' }, 'native-owner-clock-reference');
const verifier = createIdTokenVerifier(firebase);
const privateKey = createPrivateKey({ key: readFileSync(new URL('../../server-rust/tests/fixtures/test-only-rsa.der', import.meta.url)), format: 'der', type: 'pkcs1' });
const publicKey = createPublicKey(privateKey).export({ format: 'pem', type: 'spki' });
verifier.signatureVerifier = new PublicKeySignatureVerifier({ fetchPublicKeys: async () => ({ 'test-key': publicKey }) });
after(async () => { await deleteApp(firebase); });
function token(claims: Record<string, unknown>) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-key' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const body = `${header}.${payload}`;
  return `${body}.${sign('RSA-SHA256', Buffer.from(body), privateKey).toString('base64url')}`;
}

test('Admin reference accepts future owner iat/auth_time while enforcing signed-token boundaries', async () => {
  const now = Math.floor(Date.now() / 1000);
  const claims = { sub: 'owner', iss: 'https://securetoken.google.com/demo-sms-relay', aud: 'demo-sms-relay', iat: now - 1, exp: now + 3600, auth_time: now - 1, firebase: { sign_in_provider: 'google.com' } };
  for (const skew of [1, 30, 31, 300]) {
    const verified = await verifier.verifyJWT(token({ ...claims, iat: now + skew, auth_time: now + skew }));
    assert.equal(verified.uid, 'owner');
    assert.equal(verified.auth_time, now + skew);
  }
  for (const [key, value] of [['exp', now], ['exp', now - 30], ['aud', 'other-project'], ['iss', 'https://evil.test'], ['nbf', now + 30]]) {
    await assert.rejects(verifier.verifyJWT(token({ ...claims, [key as string]: value })));
  }
  const signed = token(claims), segments = signed.split('.');
  segments[1] = Buffer.from(JSON.stringify({ ...claims, sub: 'tampered-owner' })).toString('base64url');
  await assert.rejects(verifier.verifyJWT(segments.join('.')));
});
