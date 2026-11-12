import { ensure } from './model.js';
/** Called only after Firebase signature, audience, expiry and revocation verification. */
export function ownerIdentity(identity: { uid: string; auth_time: number; firebase: { sign_in_provider: string } }) {
  ensure(['google.com','apple.com'].includes(identity.firebase.sign_in_provider), 401, 'supported_sign_in_required');
  return { uid: identity.uid, authTime: identity.auth_time };
}
