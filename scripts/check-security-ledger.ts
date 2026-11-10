import { RecoveryObjects, validateLedger } from '../server/src/security-ledger.js';

// Read-only preflight: the release identity needs bucket metadata and manifest
// read access, never append/delete permission. No intents or account data read.
async function check() {
  const bucket = process.env.SECURITY_LEDGER_BUCKET, project = process.env.GOOGLE_CLOUD_PROJECT;
  if (!bucket || !project) throw Error('missing_security_ledger_configuration');
  await validateLedger(new RecoveryObjects(bucket), project);
}
void check().catch(() => {
  console.error('security_ledger_preflight_failed');
  process.exitCode = 1;
});
