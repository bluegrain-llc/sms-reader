#!/usr/bin/env python3
"""Reject incomplete production release configuration before signing or cloud access."""
import os


REQUIRED_VARIABLES = (
    'GCP_PROJECT_ID', 'GCP_WORKLOAD_IDENTITY_PROVIDER', 'GCP_RELEASE_SERVICE_ACCOUNT',
    'SECURITY_LEDGER_BUCKET', 'ANDROID_SIGNING_SHA256S', 'ANDROID_UPLOAD_SHA256',
    'RELAY_KEY_ALIAS', 'RELAY_URL', 'FIREBASE_APP_ID', 'FIREBASE_API_KEY',
    'FIREBASE_SENDER_ID', 'GOOGLE_WEB_CLIENT_ID',
)
REQUIRED_SECRETS = (
    'RELAY_KEYSTORE_BASE64', 'RELAY_STORE_PASSWORD', 'RELAY_KEY_PASSWORD', 'RELAY_SMOKE_TOKEN',
)


def validate(env):
    missing = [name for name in (*REQUIRED_VARIABLES, *REQUIRED_SECRETS)
               if not env.get(name, '').strip()]
    if missing:
        raise ValueError('Missing production release configuration: ' + ', '.join(missing))


if __name__ == '__main__':
    try:
        validate(os.environ)
    except ValueError as error:
        raise SystemExit(str(error)) from None
