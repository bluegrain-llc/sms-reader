import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import type { Firestore } from 'firebase-admin/firestore';
import { once } from 'node:events';
import { app } from '../src/http.js';
import { Relay } from '../src/relay.js';
import { RelayError } from '../src/model.js';
import { ownerIdentity } from '../src/owner-identity.js';

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

test('owner policy permits Google and Apple while preserving UID and rejecting other Firebase providers',async()=>{
  const {ownerIdentity}=await import('../src/owner-identity.js');
  for(const provider of ['google.com','apple.com']) assert.deepEqual(ownerIdentity({uid:'same-firebase-uid',auth_time:123,firebase:{sign_in_provider:provider}}),{uid:'same-firebase-uid',authTime:123});
  for(const provider of ['password','anonymous','custom','phone','']) assert.throws(()=>ownerIdentity({uid:'same-firebase-uid',auth_time:123,firebase:{sign_in_provider:provider}}),/supported_sign_in_required/);
});

test('Admin revocation verification rejects a deleted identity before the HTTP account tombstone check', {timeout:10000}, async t => {
  const auth = getAuth(firebase) as ReturnType<typeof getAuth> & { idTokenVerifier: typeof verifier };
  auth.idTokenVerifier = verifier;
  const missing = Object.assign(Error('No user record'), { code: 'auth/user-not-found' });
  const lookups: string[] = [];
  let deleted = true;
  t.mock.method(auth, 'getUser', async (uid: string) => {
    lookups.push(uid);
    if (deleted) throw missing;
    return {disabled:false};
  });
  const now = Math.floor(Date.now() / 1000);
  const cached = token({ sub: 'deleted-owner', iss: 'https://securetoken.google.com/demo-sms-relay', aud: 'demo-sms-relay',
    iat: now - 1, exp: now + 3600, auth_time: now - 1, firebase: { sign_in_provider: 'apple.com' } });
  assert.equal((await auth.verifyIdToken(cached, false)).uid, 'deleted-owner');
  await assert.rejects(auth.verifyIdToken(cached, true), error => error === missing);
  assert.deepEqual(lookups, ['deleted-owner']);
  let accountChecks = 0;
  const db = {runTransaction: async () => { accountChecks++; throw new RelayError(403, 'account_deleted'); }} as unknown as Firestore;
  const server = app(new Relay(db, async () => {}), {
    verifyOwner: async token => ownerIdentity(await auth.verifyIdToken(token, true)),
    verifyScheduler: async () => {}, deleteIdentity: async () => {},
  }).listen(0, '127.0.0.1');
  try {
    if (!server.listening) await once(server, 'listening', {signal:AbortSignal.timeout(3000)});
    const url = `http://127.0.0.1:${(server.address() as {port:number}).port}/v1/devices/deleted-installation`;
    const disconnect = () => fetch(url, {method:'DELETE', headers:{Authorization:`Bearer ${cached}`}, signal:AbortSignal.timeout(3000)});
    const absent = await disconnect();
    assert.equal(absent.status, 401); assert.deepEqual(await absent.json(), {error:'invalid_owner_session'});
    assert.equal(accountChecks, 0);
    deleted = false;
    const tombstoned = await disconnect();
    assert.equal(tombstoned.status, 403); assert.deepEqual(await tombstoned.json(), {error:'account_deleted'});
    assert.equal(accountChecks, 1);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
