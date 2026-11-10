"""Acceptance records must fail closed without physical release observations."""
import copy
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
        return {'schemaVersion': 1, 'createdAt': acceptance.now(), 'commit': 'a' * 40,
                'project': 'relay-staging', 'region': 'us-central1', 'backendRevision': 'relay-00001-abc',
                'apkSha256': 'b' * 64, 'signerSha256': ['c' * 64],
                'devices': [{'deviceHash': str(index) * 64, 'model': 'Test device',
                             'android': '15', 'api': '35', 'playServices': '25.0'} for index in range(devices)],
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
        with patch.object(acceptance, 'run', side_effect=metadata):
            devices = [acceptance.device_metadata('adb', selector)
                       for selector in ('usb-serial', '192.0.2.1:5555', 'model:Test_phone')]
        self.assertEqual(len({device['deviceHash'] for device in devices}), 1)
        value = self.pending()
        value['devices'] = devices[:2]
        value['cases']['two_phone_first_wins'] = self.passed()
        with self.assertRaises(ValueError):
            acceptance.validate(value)
        with patch.object(acceptance, 'run', side_effect=lambda args: 'hardware-two' if args[-1] == 'ro.serialno' else metadata(args)):
            value['devices'][1] = acceptance.device_metadata('adb', 'second-phone')
        acceptance.validate(value)

    def test_missing_device_identity_fails_closed_and_boot_serial_is_fallback(self):
        def metadata(args):
            if args[-1] == 'com.google.android.gms':
                return 'versionName=25.0'
            return {'ro.kernel.qemu': '0', 'ro.serialno': 'unknown',
                    'ro.boot.serialno': 'hardware-one', 'ro.product.model': 'Test phone',
                    'ro.build.version.release': '15', 'ro.build.version.sdk': '35'}[args[-1]]
        with patch.object(acceptance, 'run', side_effect=metadata):
            self.assertEqual(len(acceptance.device_metadata('adb', 'usb-serial')['deviceHash']), 64)
        for unavailable in ('', 'unknown', 'null', 'none', '0', 'not an identity'):
            with self.subTest(identity=unavailable), patch.object(acceptance, 'run', return_value=unavailable):
                with self.assertRaises(ValueError):
                    acceptance.device_metadata('adb', 'usb-serial')

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
                acceptance.device_metadata('adb', 'emulator-5554')
            run.assert_not_called()
        with patch.object(acceptance, 'run', return_value='1') as run:
            with self.assertRaises(ValueError):
                acceptance.device_metadata('adb', 'physical-looking-serial')
            self.assertEqual(run.call_count, 1)

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
