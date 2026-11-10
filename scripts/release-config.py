#!/usr/bin/env python3
"""Fail before signing when public Android configuration is incomplete or synthetic."""
import os
import re
from urllib.parse import urlparse


def validate(env):
    values = {k: env.get(k, '') for k in ['RELAY_URL', 'FIREBASE_APP_ID', 'FIREBASE_API_KEY', 'FIREBASE_PROJECT_ID', 'FIREBASE_SENDER_ID', 'GOOGLE_WEB_CLIENT_ID']}
    if any(not v or re.search(r'your[-_]|example|placeholder|changeme|localhost|\.invalid', v, re.I) for v in values.values()):
        raise ValueError('Release configuration contains missing or placeholder values')
    url = urlparse(values['RELAY_URL'])
    if url.scheme != 'https' or not url.hostname or url.username or url.password or url.query or url.fragment or url.path not in ('', '/') or url.port not in (None, 443):
        raise ValueError('RELAY_URL must be a canonical HTTPS service origin')
    if not re.fullmatch(r'[a-z][a-z0-9-]{4,61}[a-z0-9]', values['FIREBASE_PROJECT_ID']):
        raise ValueError('Invalid Firebase project ID')
    sender = values['FIREBASE_SENDER_ID']
    if not re.fullmatch(r'[1-9][0-9]{5,19}', sender) or not re.fullmatch(r'1:' + sender + r':android:[a-f0-9]+', values['FIREBASE_APP_ID']):
        raise ValueError('Firebase app ID must match sender/project number')
    if not re.fullmatch(r'AIza[A-Za-z0-9_-]{35}', values['FIREBASE_API_KEY']):
        raise ValueError('Invalid Firebase API key format')
    if not re.fullmatch(sender + r'-[a-z0-9]+\.apps\.googleusercontent\.com', values['GOOGLE_WEB_CLIENT_ID']):
        raise ValueError('OAuth web client must belong to the Firebase project number')


if __name__ == '__main__':
    try:
        validate(os.environ)
    except ValueError as error:
        raise SystemExit(str(error)) from None
