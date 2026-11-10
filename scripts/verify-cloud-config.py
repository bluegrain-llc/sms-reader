#!/usr/bin/env python3
"""Bind release public configuration to Firebase's registered Android app."""
import base64
import importlib.util
import json
import os
from pathlib import Path
import subprocess
from urllib.parse import quote
from urllib.request import Request, urlopen

spec = importlib.util.spec_from_file_location('release_config', Path(__file__).with_name('release-config.py'))
config = importlib.util.module_from_spec(spec)
spec.loader.exec_module(config)


def matches(env, sdk, canonical):
    config.validate(env)
    if env['RELAY_URL'].rstrip('/') != canonical.rstrip('/'):
        raise ValueError('Release URL must match the selected Cloud Run service')
    project = sdk['project_info']
    if project['project_id'] != env['FIREBASE_PROJECT_ID'] or str(project['project_number']) != env['FIREBASE_SENDER_ID']:
        raise ValueError('Firebase project mismatch')
    client = next(c for c in sdk['client'] if c['client_info']['mobilesdk_app_id'] == env['FIREBASE_APP_ID'])
    if client['client_info']['android_client_info']['package_name'] != 'com.bluegrain.smsrelay':
        raise ValueError('Android package mismatch')
    if env['FIREBASE_API_KEY'] not in [k['current_key'] for k in client['api_key']]:
        raise ValueError('API key is not registered for this Android app')
    if env['GOOGLE_WEB_CLIENT_ID'] not in [c['client_id'] for c in client.get('oauth_client', []) if c['client_type'] == 3]:
        raise ValueError('OAuth web client is not registered for this Android app')


if __name__ == '__main__':
    try:
        env = os.environ
        config.validate(env)
        project = env['FIREBASE_PROJECT_ID']
        token = subprocess.run(['gcloud', 'auth', 'print-access-token'], check=True, capture_output=True, text=True).stdout.strip()
        url = 'https://firebase.googleapis.com/v1beta1/projects/' + quote(project, safe='') + '/androidApps/' + quote(env['FIREBASE_APP_ID'], safe='') + '/config'
        with urlopen(Request(url, headers={'Authorization': 'Bearer ' + token}), timeout=30) as response:
            sdk = json.loads(base64.b64decode(json.load(response)['configFileContents']))
        canonical = subprocess.run(['gcloud', 'run', 'services', 'describe', env['SERVICE'], '--project', project, '--region', env['REGION'], '--format=value(status.url)'], check=True, capture_output=True, text=True).stdout.strip()
        matches(env, sdk, canonical)
    except Exception:
        raise SystemExit('Cloud-backed Android configuration verification failed') from None
    print('registered_android_config_verified')
