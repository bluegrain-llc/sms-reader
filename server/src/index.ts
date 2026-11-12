import { applicationDefault, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';
import { OAuth2Client } from 'google-auth-library';
import { ownerIdentity } from './owner-identity.js';
import { app } from './http.js';
import { taskWakeup } from './tasks.js';
import { Relay } from './relay.js';
import { RecoveryGate } from './recovery-gate.js';
import { securityLedger } from './security-ledger.js';
import { ensure } from './model.js';

const credential = applicationDefault();
initializeApp({ credential, projectId: process.env.GOOGLE_CLOUD_PROJECT });
const auth = getAuth(), oauth = new OAuth2Client();
const relay = new Relay(getFirestore(), async (token, requestId, ttl, kind) => {
  await getMessaging().send({ token, data: { requestId, ...(kind ? { kind } : {}) }, android: { priority: 'high', ttl, collapseKey: requestId } });
}, Date.now, taskWakeup(), securityLedger(process.env.SECURITY_LEDGER_BUCKET));
const gate = new RecoveryGate(getFirestore(), () => credential.getAccessToken());
const server = app(relay, {
  assertServing: () => gate.assertServing(),
  verifyOwner: async token => {
    const identity = await auth.verifyIdToken(token, true);
    return ownerIdentity(identity);
  },
  deleteIdentity: uid => auth.deleteUser(uid),
  verifyScheduler: async token => {
    ensure(process.env.SERVICE_URL && process.env.SCHEDULER_EMAIL, 401, 'scheduler_not_configured');
    const ticket = await oauth.verifyIdToken({ idToken: token, audience: process.env.SERVICE_URL });
    const payload = ticket.getPayload();
    ensure(payload?.email_verified && payload.email === process.env.SCHEDULER_EMAIL, 401, 'scheduler_not_authorized');
  },
  publicUrl: process.env.SERVICE_URL,
  firebaseWebConfig: process.env.FIREBASE_WEB_CONFIG ? JSON.parse(process.env.FIREBASE_WEB_CONFIG) : undefined,
  privacyContact: process.env.PRIVACY_CONTACT,
  androidCertSha256: process.env.ANDROID_SIGNING_SHA256,
  androidCertSha256s: process.env.ANDROID_SIGNING_SHA256S ? JSON.parse(process.env.ANDROID_SIGNING_SHA256S) as string[] : undefined,
  trustProxyHops: 1,
  origins: (process.env.ALLOWED_ORIGINS ?? '').split(',').filter(Boolean),
}).listen(Number(process.env.PORT ?? 8080), '0.0.0.0', () => console.info('sms_relay_listening'));
process.on('SIGTERM', () => { gate.close(); server.close(); });
