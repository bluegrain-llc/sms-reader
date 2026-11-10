import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('release_config', Path(__file__).parents[1] / 'release-config.py')
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)


class ReleaseConfiguration(unittest.TestCase):
    def setUp(self):
        self.env = {'RELAY_URL': 'https://relay-abc-uc.a.run.app', 'FIREBASE_PROJECT_ID': 'relay-production', 'FIREBASE_SENDER_ID': '123456789012', 'FIREBASE_APP_ID': '1:123456789012:android:abcdef0123456789', 'FIREBASE_API_KEY': 'AIza' + 'A' * 35, 'GOOGLE_WEB_CLIENT_ID': '123456789012-abc123.apps.googleusercontent.com'}

    def test_structurally_valid_config(self):
        c.validate(self.env)

    def test_example_values_and_project_mismatches_rejected(self):
        for key, value in [('RELAY_URL', 'https://your-cloud-run-service.run.app'), ('FIREBASE_APP_ID', '1:1234567890:android:your-app-id'), ('FIREBASE_API_KEY', 'your-android-firebase-api-key'), ('GOOGLE_WEB_CLIENT_ID', '1234567890-example.apps.googleusercontent.com'), ('FIREBASE_SENDER_ID', '987654321012'), ('RELAY_URL', 'https://relay.example/path')]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                c.validate({**self.env, key: value})

class RegisteredConfiguration(unittest.TestCase):
    def test_unregistered_api_key_cannot_pass_cloud_binding(self):
        spec = importlib.util.spec_from_file_location('cloud_config', Path(__file__).parents[1] / 'verify-cloud-config.py')
        cloud = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cloud)
        fixture = ReleaseConfiguration()
        fixture.setUp()
        env = fixture.env
        sdk = {'project_info': {'project_id': env['FIREBASE_PROJECT_ID'], 'project_number': env['FIREBASE_SENDER_ID']}, 'client': [{'client_info': {'mobilesdk_app_id': env['FIREBASE_APP_ID'], 'android_client_info': {'package_name': 'com.bluegrain.smsrelay'}}, 'api_key': [{'current_key': env['FIREBASE_API_KEY']}], 'oauth_client': [{'client_type': 3, 'client_id': env['GOOGLE_WEB_CLIENT_ID']}]}]}
        cloud.matches(env, sdk, env['RELAY_URL'])
        with self.assertRaises(ValueError):
            cloud.matches({**env, 'FIREBASE_API_KEY': 'AIza' + 'B' * 35}, sdk, env['RELAY_URL'])
