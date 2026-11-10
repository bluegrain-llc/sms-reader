#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
: "${RELAY_KEYSTORE:?Set an absolute private path to the signing keystore}"
: "${RELAY_STORE_PASSWORD:?Set the keystore password privately}"
: "${RELAY_KEY_PASSWORD:?Set the key password privately}"
: "${RELAY_KEY_ALIAS:=pilot}"
export RELAY_KEY_ALIAS
if [[ ! -e "$RELAY_KEYSTORE" ]]; then
  umask 077
  mkdir -p "$(dirname "$RELAY_KEYSTORE")"
  keytool -genkeypair -keystore "$RELAY_KEYSTORE" -alias "$RELAY_KEY_ALIAS" \
    -storepass:env RELAY_STORE_PASSWORD -keypass:env RELAY_KEY_PASSWORD \
    -storetype JKS -keyalg RSA -keysize 3072 -validity 10000 \
    -dname 'CN=SMS Code Relay Pilot'
fi
android/gradlew -p android testDebugUnitTest lintRelease assembleRelease bundleRelease
mkdir -p artifacts
cp android/app/build/outputs/apk/release/app-release.apk artifacts/sms-code-relay-pilot.apk
cp android/app/build/outputs/bundle/release/app-release.aab artifacts/sms-code-relay-release.aab
sha256sum artifacts/sms-code-relay-pilot.apk artifacts/sms-code-relay-release.aab > artifacts/SHA256SUMS
