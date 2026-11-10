import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signingFingerprints } from '../src/signing.js';

const pilot = Array(32).fill('aa').join(':');
const play = Array(32).fill('BB').join(':');
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
