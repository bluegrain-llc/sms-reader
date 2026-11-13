"""Acceptance records must fail closed without physical release observations."""
import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('phone_acceptance', Path(__file__).parents[1] / 'phone-acceptance.py')
acceptance = importlib.util.module_from_spec(spec)
spec.loader.exec_module(acceptance)


class PhoneAcceptanceTest(unittest.TestCase):
    def pending(self, devices=0):
        return {'schemaVersion': 2, 'createdAt': acceptance.now(), 'commit': 'a' * 40,
                'project': 'relay-staging', 'region': 'us-central1', 'backendRevision': 'relay-00001-abc',
                'apkSha256': 'b' * 64, 'signerSha256': ['c' * 64],
                'devices': [{'deviceHash': str(index) * 64, 'model': 'Test device',
                             'android': '15', 'api': '35', 'playServices': '25.0',
                             'installedApkSha256': 'b' * 64} for index in range(devices)],
                'cases': {case: {'status': 'pending', 'reason': 'not_run'} for case in acceptance.CASES}}

    def passed(self):
        return {'status': 'pass', 'reason': 'observed_expected_behavior', 'observedAt': acceptance.now()}

    def test_pending_matrix_cannot_claim_physical_pass_without_device(self):
        value = self.pending()
        acceptance.validate(value)
        value['cases']['consent_approval'] = self.passed()
        with self.assertRaises(ValueError):
            acceptance.validate(value)

    def test_two_phone_race_needs_distinct_physical_devices(self):
        value = self.pending(1)
        value['cases']['two_phone_first_wins'] = self.passed()
        with self.assertRaises(ValueError):
            acceptance.validate(value)
        value['devices'].append(copy.deepcopy(value['devices'][0]))
        with self.assertRaises(ValueError):
            acceptance.validate(value)
        value['devices'][1]['deviceHash'] = 'd' * 64
        acceptance.validate(value)

    def test_record_rejects_unexpected_payload_fields_and_missing_cases(self):
        value = self.pending(2)
        value['cases']['consent_approval']['sms'] = 'should never be recorded'
        with self.assertRaises(ValueError):
            acceptance.validate(value)
        value = self.pending(2)
        del value['cases']['consent_denial_manual_entry']
        with self.assertRaises(ValueError):
            acceptance.validate(value)

    def test_record_binds_full_commit_artifact_and_signer(self):
        for key in ('commit', 'apkSha256', 'signerSha256'):
            value = self.pending(2)
            value[key] = [] if key == 'signerSha256' else 'invalid'
            with self.assertRaises(ValueError):
                acceptance.validate(value)

    def test_loaded_nested_payloads_are_rejected_without_rewriting_record(self):
        for field in ('signerSha256', 'observedAt'):
            with self.subTest(field=field), tempfile.TemporaryDirectory() as directory:
                value = self.pending(2)
                if field == 'signerSha256':
                    value['cases'] = {case: self.passed() for case in acceptance.CASES}
                    value[field] = {'c' * 64: {'sms': 'private-payload-fixture'}}
                else:
                    value['cases']['consent_approval'][field] = {'sms': 'private-payload-fixture'}
                record = Path(directory) / 'record.json'
                original = json.dumps(value)
                record.write_text(original)
                for command in (['summary', '--require-pass'],
                                ['record', '--case', 'consent_approval', '--outcome', 'pass',
                                 '--reason', 'observed_expected_behavior']):
                    errors = io.StringIO()
                    with patch('sys.argv', ['phone-acceptance', *command, '--file', str(record)]), patch('sys.stderr', errors):
                        with self.assertRaises(SystemExit) as caught:
                            acceptance.main()
                    self.assertEqual(caught.exception.code, 2)
                    self.assertNotIn('private-payload-fixture', errors.getvalue())
                    self.assertEqual(record.read_text(), original)

    def test_record_requires_expected_container_types(self):
        replacements = {'signerSha256': ['c' * 64, {'sms': 'fixture'}],
                        'devices': {}, 'cases': list(acceptance.CASES), 'createdAt': {}}
        for key, replacement in replacements.items():
            with self.subTest(key=key):
                value = self.pending(2)
                value[key] = replacement
                with self.assertRaises(ValueError):
                    acceptance.validate(value)
        for replacement in (None, [], 'record'):
            with self.assertRaises(ValueError):
                acceptance.validate(replacement)

    def test_observation_reason_and_timestamp_match_status(self):
        for status, reason in (('pending', 'unexpected_behavior'), ('fail', 'not_run'),
                               ('blocked', 'observed_expected_behavior')):
            value = self.pending(2)
            value['cases']['consent_approval'] = {'status': status, 'reason': reason,
                                                 'observedAt': acceptance.now()}
            with self.assertRaises(ValueError):
                acceptance.validate(value)
        value = self.pending(2)
        value['cases']['consent_approval'] = self.passed()
        value['cases']['consent_approval']['observedAt'] = {'sms': 'fixture'}
        with self.assertRaises(ValueError):
            acceptance.validate(value)

    def test_adb_aliases_share_device_reported_identity(self):
        def metadata(args):
            if args[-1] == 'com.google.android.gms':
                return 'versionName=25.0'
            return {'ro.kernel.qemu': '0', 'ro.serialno': 'hardware-one',
                    'ro.product.model': 'Test phone', 'ro.build.version.release': '15',
                    'ro.build.version.sdk': '35'}[args[-1]]
        with patch.object(acceptance, 'run', side_effect=metadata), patch.object(acceptance, 'installed_apk_hash', return_value='b' * 64):
            devices = [acceptance.device_metadata('adb', selector, 'b' * 64)
                       for selector in ('usb-serial', '192.0.2.1:5555', 'model:Test_phone')]
        self.assertEqual(len({device['deviceHash'] for device in devices}), 1)
        value = self.pending()
        value['devices'] = devices[:2]
        value['cases']['two_phone_first_wins'] = self.passed()
        with self.assertRaises(ValueError):
            acceptance.validate(value)
        with patch.object(acceptance, 'run', side_effect=lambda args: 'hardware-two' if args[-1] == 'ro.serialno' else metadata(args)), patch.object(acceptance, 'installed_apk_hash', return_value='b' * 64):
            value['devices'][1] = acceptance.device_metadata('adb', 'second-phone', 'b' * 64)
        acceptance.validate(value)

    def test_missing_device_identity_fails_closed_and_boot_serial_is_fallback(self):
        def metadata(args):
            if args[-1] == 'com.google.android.gms':
                return 'versionName=25.0'
            return {'ro.kernel.qemu': '0', 'ro.serialno': 'unknown',
                    'ro.boot.serialno': 'hardware-one', 'ro.product.model': 'Test phone',
                    'ro.build.version.release': '15', 'ro.build.version.sdk': '35'}[args[-1]]
        with patch.object(acceptance, 'run', side_effect=metadata), patch.object(acceptance, 'installed_apk_hash', return_value='b' * 64):
            self.assertEqual(len(acceptance.device_metadata('adb', 'usb-serial', 'b' * 64)['deviceHash']), 64)
        for unavailable in ('', 'unknown', 'null', 'none', '0', 'not an identity'):
            with self.subTest(identity=unavailable), patch.object(acceptance, 'run', return_value=unavailable):
                with self.assertRaises(ValueError):
                    acceptance.device_metadata('adb', 'usb-serial', 'b' * 64)

    def test_record_binds_explicit_deployment_target(self):
        for key in ('project', 'region', 'backendRevision'):
            value = self.pending(2)
            del value[key]
            with self.assertRaises(ValueError):
                acceptance.validate(value)
            value = self.pending(2)
            value[key] = 'not a deployment identifier'
            with self.assertRaises(ValueError):
                acceptance.validate(value)

    def test_multi_digit_cloud_run_regions_round_trip_through_gate(self):
        with tempfile.TemporaryDirectory() as directory:
            record = Path(directory) / 'record.json'
            for region in ('us-central1', 'europe-west10', 'europe-west12'):
                with self.subTest(region=region):
                    value = self.pending(2)
                    value['region'] = region
                    value['cases'] = {case: self.passed() for case in acceptance.CASES}
                    acceptance.save(record, value)
                    with patch('sys.argv', ['phone-acceptance', 'summary', '--file', str(record), '--require-pass']), patch('builtins.print'):
                        self.assertEqual(acceptance.main(), 0)
                    self.assertEqual(json.loads(record.read_text())['region'], region)
            for region in ('europe-west', 'europe-west10x', 'europe--west10', '../europe-west10'):
                with self.subTest(region=region):
                    value['region'] = region
                    with self.assertRaises(ValueError):
                        acceptance.validate(value)

    def test_emulator_refused_before_package_inspection(self):
        with patch.object(acceptance, 'run') as run:
            with self.assertRaises(ValueError):
                acceptance.device_metadata('adb', 'emulator-5554', 'b' * 64)
            run.assert_not_called()
        with patch.object(acceptance, 'run', return_value='1') as run:
            with self.assertRaises(ValueError):
                acceptance.device_metadata('adb', 'physical-looking-serial', 'b' * 64)
            self.assertEqual(run.call_count, 1)

    def test_installed_apk_is_hashed_and_temporary_copy_removed(self):
        copied = []

        def adb(args):
            if args[3:6] == ['shell', 'pm', 'path']:
                self.assertEqual(args[-1], 'com.bluegrain.smsrelay')
                return 'package:/data/app/~~install-id/com.bluegrain.smsrelay-id/base.apk\n'
            self.assertEqual(args[3], 'pull')
            path = Path(args[-1])
            self.assertEqual(path.parent.stat().st_mode & 0o777, 0o700)
            path.write_bytes(b'installed candidate')
            copied.append(path)
            return ''

        with patch.object(acceptance, 'run', side_effect=adb):
            self.assertEqual(acceptance.installed_apk_hash('adb', 'phone'),
                             hashlib.sha256(b'installed candidate').hexdigest())
        self.assertEqual(len(copied), 1)
        self.assertFalse(copied[0].parent.exists())

    def test_missing_split_or_malformed_installation_is_refused_before_pull(self):
        for paths in ('', 'package:/data/app/example/base.apk\npackage:/data/app/example/split_config.apk\n',
                      'package:/data/app/../private/base.apk', 'package:/data/app/app/base.apk; private-payload',
                      'unexpected package metadata'):
            with self.subTest(paths=paths), patch.object(acceptance, 'run', return_value=paths) as run:
                with self.assertRaises(ValueError):
                    acceptance.installed_apk_hash('adb', 'phone')
                self.assertEqual(run.call_count, 1)

    def test_failed_installed_apk_pull_removes_temporary_copy(self):
        copied = []

        def adb(args):
            if args[3] == 'shell':
                return 'package:/data/app/app/base.apk\n'
            path = Path(args[-1])
            path.write_bytes(b'partial APK')
            copied.append(path)
            raise ValueError('Metadata command failed')

        with patch.object(acceptance, 'run', side_effect=adb), self.assertRaises(ValueError):
            acceptance.installed_apk_hash('adb', 'phone')
        self.assertFalse(copied[0].parent.exists())

    def test_init_binds_each_phone_to_the_selected_apk_and_rejects_old_install(self):
        for second_apk in (b'new candidate', b'old candidate'):
            with self.subTest(second_apk=second_apk), tempfile.TemporaryDirectory() as directory:
                apk = Path(directory) / 'candidate.apk'
                apk.write_bytes(b'new candidate')
                record = Path(directory) / 'record.json'
                copied = []

                def tools(args):
                    if args[0] == 'aapt':
                        return "package: name='com.bluegrain.smsrelay' versionCode='11'"
                    if args[0] == 'signer':
                        return 'Signer #1 certificate SHA-256 digest: ' + 'c' * 64
                    if args[3] == 'pull':
                        path = Path(args[-1])
                        path.write_bytes(second_apk if args[2] == 'second-phone' else apk.read_bytes())
                        copied.append(path)
                        return ''
                    if args[4:6] == ['pm', 'path']:
                        return 'package:/data/app/app/base.apk\n'
                    if args[-1] == 'com.google.android.gms':
                        return 'versionName=25.0'
                    return {'ro.kernel.qemu': '0', 'ro.serialno': args[2],
                            'ro.product.model': 'Test phone', 'ro.build.version.release': '15',
                            'ro.build.version.sdk': '35'}[args[-1]]

                argv = ['phone-acceptance', 'init', '--file', str(record), '--apk', str(apk),
                        '--commit', 'a' * 40, '--project', 'relay-staging', '--region', 'us-central1',
                        '--backend-revision', 'relay-00001-abc', '--apksigner', 'signer', '--aapt', 'aapt',
                        '--serial', 'first-phone', '--serial', 'second-phone']
                errors = io.StringIO()
                with patch('sys.argv', argv), patch.object(acceptance, 'run', side_effect=tools), \
                        patch('builtins.print'), patch('sys.stderr', errors):
                    if second_apk == apk.read_bytes():
                        self.assertEqual(acceptance.main(), 0)
                        value = json.loads(record.read_text())
                        self.assertEqual(value['schemaVersion'], 2)
                        self.assertEqual(len(value['devices']), 2)
                        self.assertTrue(all(device['installedApkSha256'] == value['apkSha256']
                                            for device in value['devices']))
                        self.assertTrue(all(case['status'] == 'pending' for case in value['cases'].values()))
                    else:
                        with self.assertRaises(SystemExit) as caught:
                            acceptance.main()
                        self.assertEqual(caught.exception.code, 2)
                        self.assertFalse(record.exists())
                        self.assertNotIn('second-phone', errors.getvalue())
                self.assertEqual(len(copied), 2)
                self.assertTrue(all(not path.parent.exists() for path in copied))

    def test_old_or_unbound_device_records_cannot_pass(self):
        for invalid in ('old_schema', 'missing_installed_hash', 'different_installed_hash'):
            with self.subTest(invalid=invalid):
                value = self.pending(2)
                value['cases'] = {case: self.passed() for case in acceptance.CASES}
                if invalid == 'old_schema':
                    value['schemaVersion'] = 1
                elif invalid == 'missing_installed_hash':
                    del value['devices'][1]['installedApkSha256']
                else:
                    value['devices'][1]['installedApkSha256'] = 'd' * 64
                with self.assertRaises(ValueError):
                    acceptance.validate(value)

    def test_debug_or_unsigned_artifact_is_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            apk = Path(directory) / 'app.apk'
            apk.write_bytes(b'test fixture')
            with patch.object(acceptance, 'run', return_value="package: name='com.bluegrain.smsrelay'\napplication-debuggable"):
                with self.assertRaises(ValueError):
                    acceptance.initial_record(apk, 'a' * 40, 'signer', 'aapt', [], 'relay-staging', 'us-central1', 'relay-00001-abc')
            with patch.object(acceptance, 'run', side_effect=["package: name='com.bluegrain.smsrelay'", '']):
                with self.assertRaises(ValueError):
                    acceptance.initial_record(apk, 'a' * 40, 'signer', 'aapt', [], 'relay-staging', 'us-central1', 'relay-00001-abc')

    def test_artifact_identity_uses_package_header_not_application_labels(self):
        with tempfile.TemporaryDirectory() as directory:
            apk = Path(directory) / 'app.apk'
            apk.write_bytes(b'test fixture')
            signer = 'Signer #1 certificate SHA-256 digest: ' + 'c' * 64
            misleading_label = "application-label:'package: name='com.bluegrain.smsrelay''"
            for badging in ("package: name='example.other'\n" + misleading_label,
                            misleading_label,
                            "package: name='com.bluegrain.smsrelay.other'\n" + misleading_label,
                            "package: name='com.bluegrain.smsrelay'\npackage: name='example.other'"):
                with self.subTest(badging=badging), patch.object(acceptance, 'run', side_effect=[badging, signer]) as run:
                    with self.assertRaises(ValueError):
                        acceptance.initial_record(apk, 'a' * 40, 'signer', 'aapt', [], 'relay-staging', 'us-central1', 'relay-00001-abc')
                    self.assertEqual(run.call_count, 1)
            badging = "package: name='com.bluegrain.smsrelay' versionCode='1'\napplication-label:'application-debuggable'"
            with patch.object(acceptance, 'run', side_effect=[badging, signer]):
                value = acceptance.initial_record(apk, 'a' * 40, 'signer', 'aapt', [], 'relay-staging', 'us-central1', 'relay-00001-abc')
            acceptance.validate(value)

    def test_summary_gate_fails_until_all_required_observations_pass(self):
        with tempfile.TemporaryDirectory() as directory:
            record = Path(directory) / 'record.json'
            with patch('sys.argv', ['phone-acceptance', 'summary', '--file', str(record), '--require-pass']), patch('builtins.print'):
                acceptance.save(record, self.pending(2))
                self.assertEqual(acceptance.main(), 1)
                value = self.pending(2)
                value['cases'] = {case: self.passed() for case in acceptance.CASES}
                acceptance.save(record, value)
                self.assertEqual(acceptance.main(), 0)
            self.assertEqual(record.stat().st_mode & 0o777, 0o600)
            self.assertEqual(json.loads(record.read_text()), value)

    def test_failed_validation_preserves_previous_record(self):
        with tempfile.TemporaryDirectory() as directory:
            record = Path(directory) / 'record.json'
            value = self.pending()
            acceptance.save(record, value)
            changed = copy.deepcopy(value)
            changed['cases']['consent_approval'] = self.passed()
            with self.assertRaises(ValueError):
                acceptance.save(record, changed)
            self.assertEqual(json.loads(record.read_text()), value)


if __name__ == '__main__':
    unittest.main()
