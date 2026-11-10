"""Acceptance records must fail closed without physical release observations."""
import copy
import importlib.util
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
