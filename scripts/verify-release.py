#!/usr/bin/env python3
"""Verify artifact signatures without printing signing material."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess

apk = Path('artifacts/sms-code-relay-pilot.apk')
aab = Path('artifacts/sms-code-relay-release.aab')
expected = os.environ.get('ANDROID_UPLOAD_SHA256', '').replace(':', '').upper()
if not re.fullmatch('[A-F0-9]{64}', expected):
    raise SystemExit('Set ANDROID_UPLOAD_SHA256 to the public upload certificate fingerprint')
tool = Path(os.environ['ANDROID_HOME']) / 'build-tools/36.0.0/apksigner'
cert = subprocess.run([str(tool), 'verify', '--print-certs', str(apk)], check=True, capture_output=True, text=True).stdout
actual = re.search(r'Signer #1 certificate SHA-256 digest: ([a-fA-F0-9]+)', cert)
if not actual or actual[1].upper() != expected:
    raise SystemExit('APK signer mismatch')
jar = subprocess.run(['jarsigner', '-verify', str(aab)], check=True, capture_output=True, text=True).stdout
if 'jar verified.' not in jar or 'jar is unsigned' in jar or 'unsigned entries' in jar.lower():
    raise SystemExit('AAB signature verification failed')
# Verify the AAB uses the same upload identity; integrity alone does not bind its signer.
key = subprocess.run(['keytool', '-printcert', '-jarfile', str(aab)], check=True, capture_output=True, text=True).stdout
fingerprint = re.search(r'SHA256:\s*([A-Fa-f0-9:]+)', key)
if not fingerprint or fingerprint[1].replace(':', '').upper() != expected:
    raise SystemExit('AAB signer mismatch')
record = {'uploadCertificateSha256': expected, 'artifacts': {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in (apk, aab)}}
Path('artifacts/release-verification.json').write_text(json.dumps(record, indent=2) + '\n')
print('release_signatures_verified')
