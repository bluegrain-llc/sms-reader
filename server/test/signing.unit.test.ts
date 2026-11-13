import { test } from 'node:test';
import assert from 'node:assert/strict';
import { androidLinkTarget, signingFingerprints } from '../src/signing.js';

const pilot = Array(32).fill('aa').join(':');
const play = Array(32).fill('BB').join(':');
test('staging links use a separate package and fallback scheme while production stays default', () => {
  assert.deepEqual(androidLinkTarget(), {packageName:'com.bluegrain.smsrelay',scheme:'smsrelay'});
  assert.deepEqual(androidLinkTarget('com.bluegrain.smsrelay.staging'), {packageName:'com.bluegrain.smsrelay.staging',scheme:'smsrelay-staging'});
  for (const invalid of ['', 'com.bluegrain.smsrelay.other', 'com.bluegrain.smsrelay\n', '<script>']) {
    assert.throws(() => androidLinkTarget(invalid), {status:503,reason:'app_links_not_configured'});
  }
});
test('legacy single signer remains associated without new configuration', () => {
  assert.deepEqual(signingFingerprints(pilot), [pilot.toUpperCase()]);
});
test('Play signer adds to legacy association without duplicate case variants', () => {
  assert.deepEqual(signingFingerprints(pilot, [play, pilot.toUpperCase()]), [play, pilot.toUpperCase()]);
});
test('missing and malformed signer configuration fails closed', () => {
  for (const bad of [undefined, [], ['bad'], [play, 1], 'not-an-array', {}]) {
    assert.throws(() => signingFingerprints(undefined, bad), { status: 503, reason: 'app_links_not_configured' });
  }
});
