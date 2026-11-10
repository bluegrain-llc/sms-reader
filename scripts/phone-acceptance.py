#!/usr/bin/env python3
"""Record operator-observed release acceptance without reading SMS or app data."""
import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

# These IDs are also the checklist: no free-text notes or payloads enter the record.
CASES = {
    'google_sign_in': 1, 'pairing_approval_revocation': 1, 'generic_notification': 1,
    'ready_before_sms': 1, 'consent_approval': 1, 'consent_denial_manual_entry': 1,
    'multiple_candidates': 1, 'leading_zero_numeric': 1, 'alphanumeric_code': 1,
    'unsupported_format': 1, 'sender_filter': 1, 'contacts_exclusion': 1,
    'pre_ready_sms': 1, 'no_inbox_access': 1, 'result_expiry_cleanup': 1,
    'cancel_upload_race': 1, 'revoke_completed_result': 1, 'background_locked': 1,
    'notification_permission': 1, 'offline_before_after_deadline': 1,
    'rotation_during_consent': 1, 'process_death': 1, 'listener_cooldown': 1,
    'two_phone_first_wins': 2, 'two_phone_withdrawal': 2,
    'two_callers_isolation_queue': 2, 'forms_wizards_with_sms': 2,
    'offline_observation_replay': 1,
}
REASONS = ('observed_expected_behavior', 'unexpected_behavior', 'device_unavailable',
           'owner_action_required', 'service_unavailable', 'not_run')


def now():
    return datetime.now(timezone.utc).isoformat()


def run(args):
    # Capture subprocess diagnostics: they may contain private local paths or serials.
    try:
        return subprocess.run(args, check=True, capture_output=True, text=True, timeout=30).stdout
    except (subprocess.SubprocessError, OSError) as exc:
        raise ValueError('Metadata command failed; verify selected device/tools locally') from exc


def device_metadata(adb, serial):
    def prop(name):
        return run([adb, '-s', serial, 'shell', 'getprop', name]).strip()
    if serial.startswith('emulator-') or prop('ro.kernel.qemu') == '1':
        raise ValueError('Physical acceptance refuses emulator devices')
    play = run([adb, '-s', serial, 'shell', 'dumpsys', 'package', 'com.google.android.gms'])
    version = re.search(r'^\s*versionName=([^\s]+)', play, re.MULTILINE)
    if not version:
        raise ValueError('Google Play services version unavailable')
    return {'deviceHash': hashlib.sha256(serial.encode()).hexdigest(),
            'model': prop('ro.product.model'), 'android': prop('ro.build.version.release'),
            'api': prop('ro.build.version.sdk'), 'playServices': version.group(1)}


def initial_record(apk, commit, signer, aapt, devices, project, region, revision):
    if not re.fullmatch(r'[0-9a-f]{40}', commit):
        raise ValueError('Commit must be a full Git SHA')
    manifest = run([aapt, 'dump', 'badging', str(apk)])
    if "package: name='com.bluegrain.smsrelay'" not in manifest or 'application-debuggable' in manifest:
        raise ValueError('Expected non-debuggable relay APK')
    certificate = run([signer, 'verify', '--print-certs', str(apk)])
    digests = re.findall(r'^Signer #\d+ certificate SHA-256 digest: ([0-9a-fA-F]{64})$', certificate, re.MULTILINE)
    if not digests:
        raise ValueError('APK signer certificate not verified')
    return {'schemaVersion': 1, 'createdAt': now(), 'commit': commit,
            'apkSha256': hashlib.sha256(apk.read_bytes()).hexdigest(),
            'project': project, 'region': region, 'backendRevision': revision,
            'signerSha256': [value.lower() for value in digests], 'devices': devices,
            'cases': {case: {'status': 'pending', 'reason': 'not_run'} for case in CASES}}


def validate(record):
    if set(record) != {'schemaVersion', 'createdAt', 'commit', 'apkSha256', 'signerSha256', 'devices', 'cases', 'project', 'region', 'backendRevision'}:
        raise ValueError('Unexpected record fields')
    if record['schemaVersion'] != 1 or not re.fullmatch(r'[0-9a-f]{40}', record['commit']):
        raise ValueError('Invalid record identity')
    if not re.fullmatch(r'[0-9a-f]{64}', record['apkSha256']):
        raise ValueError('Invalid artifact hash')
    if not record['signerSha256'] or any(not re.fullmatch(r'[0-9a-f]{64}', value) for value in record['signerSha256']):
        raise ValueError('Invalid signing certificate')
    if not re.fullmatch(r'[a-z][a-z0-9-]{4,28}[a-z0-9]', record['project']):
        raise ValueError('Invalid project ID')
    if not re.fullmatch(r'[a-z]+-[a-z]+[0-9]', record['region']):
        raise ValueError('Invalid region')
    if not re.fullmatch(r'[a-z][a-z0-9-]{0,61}[a-z0-9]', record['backendRevision']):
        raise ValueError('Invalid backend revision')
    datetime.fromisoformat(record['createdAt'])
    identities = set()
    for device in record['devices']:
        if set(device) != {'deviceHash', 'model', 'android', 'api', 'playServices'}:
            raise ValueError('Unexpected device fields')
        if not re.fullmatch(r'[0-9a-f]{64}', device['deviceHash']) or device['deviceHash'] in identities:
            raise ValueError('Invalid or duplicate physical device')
        identities.add(device['deviceHash'])
        if not all(isinstance(device[key], str) and 0 < len(device[key]) <= 120 for key in device):
            raise ValueError('Invalid device metadata')
        if not device['api'].isdigit() or int(device['api']) < 26:
            raise ValueError('Unsupported device API')
    if set(record['cases']) != set(CASES):
        raise ValueError('Acceptance matrix does not match this tool version')
    for case, result in record['cases'].items():
        if set(result) not in ({'status', 'reason'}, {'status', 'reason', 'observedAt'}):
            raise ValueError('Unexpected observation fields')
        if result['status'] not in ('pending', 'pass', 'fail', 'blocked') or result['reason'] not in REASONS:
            raise ValueError('Invalid observation')
        if result['status'] != 'pending':
            datetime.fromisoformat(result['observedAt'])
        if result['status'] == 'pass' and (len(identities) < CASES[case] or result['reason'] != 'observed_expected_behavior'):
            raise ValueError('Passing case requires physical device metadata and expected behavior')


@contextmanager
def locked(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.with_suffix(path.suffix + '.lock').open('a') as lock:
        os.chmod(lock.name, 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield


def save(path, record):
    validate(record)
    descriptor, temporary = tempfile.mkstemp(prefix='.acceptance-', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'w') as output:
            json.dump(record, output, indent=2)
            output.write('\n')
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    init = commands.add_parser('init', help='Create pending matrix for one signed release artifact')
    init.add_argument('--apk', type=Path, required=True)
    init.add_argument('--commit', required=True)
    init.add_argument('--project', required=True)
    init.add_argument('--region', required=True)
    init.add_argument('--backend-revision', required=True)
    init.add_argument('--apksigner', required=True)
    init.add_argument('--aapt', required=True)
    init.add_argument('--adb', default='adb')
    init.add_argument('--serial', action='append', default=[])
    record = commands.add_parser('record', help='Record an explicit operator observation')
    record.add_argument('--case', choices=CASES, required=True)
    record.add_argument('--outcome', choices=('pass', 'fail', 'blocked'), required=True)
    record.add_argument('--reason', choices=REASONS, required=True)
    summary = commands.add_parser('summary', help='List statuses; never print device metadata')
    summary.add_argument('--require-pass', action='store_true')
    for command in (init, record, summary):
        command.add_argument('--file', type=Path, required=True)
    args = parser.parse_args()
    try:
        with locked(args.file):
            if args.command == 'init':
                if args.file.exists():
                    raise ValueError('Record already exists; use a new file for a new candidate')
                devices = [device_metadata(args.adb, serial) for serial in args.serial]
                value = initial_record(args.apk, args.commit, args.apksigner, args.aapt, devices, args.project, args.region, args.backend_revision)
                save(args.file, value)
                print('Pending release matrix created; no physical outcomes claimed')
            else:
                value = json.loads(args.file.read_text())
                validate(value)
                if args.command == 'record':
                    if args.outcome == 'pass' and args.reason != 'observed_expected_behavior':
                        raise ValueError('Passing observation requires expected behavior')
                    if args.outcome != 'pass' and args.reason == 'observed_expected_behavior':
                        raise ValueError('Expected behavior is reserved for passing observations')
                    value['cases'][args.case] = {'status': args.outcome, 'reason': args.reason, 'observedAt': now()}
                    save(args.file, value)
                    print(f'{args.case}: {args.outcome}')
                else:
                    for case, result in value['cases'].items():
                        print(f"{case}: {result['status']}")
                    passed = all(result['status'] == 'pass' for result in value['cases'].values())
                    print('Operator acceptance complete' if passed else 'Physical acceptance incomplete')
                    if args.require_pass and not passed:
                        return 1
    except (ValueError, KeyError, TypeError, OSError) as exc:
        # Do not echo arbitrary input, subprocess output or secret-bearing paths.
        parser.exit(2, f'Acceptance record rejected ({type(exc).__name__}); check command and metadata\n')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
