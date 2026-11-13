#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
tasks=(testDebugUnitTest testStagingUnitTest lintStaging assembleStaging bundleStaging)
if [[ $# == 1 && "$1" == --with-setup ]]; then
  tasks+=(assembleStagingSetup)
elif [[ $# != 0 ]]; then
  echo 'Usage: build-staging.sh [--with-setup]' >&2
  exit 1
fi
: "${STAGING_RELAY_KEYSTORE:?Set a private staging-only signing keystore}"
: "${STAGING_RELAY_STORE_PASSWORD:?Set the staging keystore password privately}"
: "${STAGING_RELAY_KEY_PASSWORD:?Set the staging key password privately}"
: "${STAGING_RELAY_KEY_ALIAS:?Set the staging key alias}"
[[ "$STAGING_RELAY_KEYSTORE" = /* && -f "$STAGING_RELAY_KEYSTORE" ]] || {
  echo 'Set an existing absolute STAGING_RELAY_KEYSTORE path' >&2
  exit 1
}
android/gradlew -p android "${tasks[@]}"
mkdir -p artifacts/staging
cp android/app/build/outputs/apk/staging/app-staging.apk artifacts/staging/sms-code-relay-staging.apk
cp android/app/build/outputs/bundle/staging/app-staging.aab artifacts/staging/sms-code-relay-staging.aab
sha256sum artifacts/staging/sms-code-relay-staging.apk artifacts/staging/sms-code-relay-staging.aab > artifacts/staging/SHA256SUMS
if [[ $# == 1 ]]; then
  cp android/app/build/outputs/apk/stagingSetup/app-stagingSetup.apk artifacts/staging/sms-code-relay-staging-setup.apk
fi
