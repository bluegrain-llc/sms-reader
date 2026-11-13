import importlib.util
import json
import re
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('deploy', Path(__file__).parents[1] / 'deploy.py')
d = importlib.util.module_from_spec(spec)
spec.loader.exec_module(d)


class DeploymentSafety(unittest.TestCase):
    def setUp(self):
        self.env = {'PROJECT_ID': 'demo-sms-relay', 'COMMIT_SHA': 'a' * 40,
                    'IMAGE_URI': 'us-central1-docker.pkg.dev/demo-sms-relay/relay/app@sha256:' + 'b' * 64,
                    'RELAY_SMOKE_TOKEN': 'private-fixture', 'ANDROID_SIGNING_SHA256': ':'.join(['AA'] * 32),
                    'SECURITY_LEDGER_BUCKET': 'independent-test-ledger'}

    def test_refuses_mutable_or_cross_project_images_before_cloud_calls(self):
        for bad in ['app:latest', self.env['IMAGE_URI'].replace('demo-sms-relay', 'other-project')]:
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                d.config({**self.env, 'IMAGE_URI': bad})
        with self.assertRaises(ValueError):
            d.config({**self.env, 'ANDROID_SIGNING_SHA256S': '["bad"]'})
        for bucket in ['', 'gs://invalid', 'unsafe|injection']:
            with self.subTest(bucket=bucket), self.assertRaises(ValueError):
                d.config({**self.env, 'SECURITY_LEDGER_BUCKET': bucket})
        with self.assertRaises(ValueError):
            d.config({**self.env, 'ANDROID_PACKAGE_NAME': 'other.package'})

    def test_staging_package_reaches_each_backend_and_production_remains_default(self):
        for backend in ('typescript', 'rust'):
            for package in ('com.bluegrain.smsrelay', 'com.bluegrain.smsrelay.staging'):
                with self.subTest(backend=backend, package=package):
                    options = {'BACKEND':backend}
                    if package.endswith('.staging'):
                        options['ANDROID_PACKAGE_NAME'] = package
                    calls, _, _, _ = self.exercise(**options)
                    deploy = next(c for c in calls if c[:3] == ['gcloud', 'run', 'deploy'])
                    self.assertIn('ANDROID_PACKAGE_NAME=' + package, deploy[deploy.index('--update-env-vars') + 1])
                    self.assertEqual(deploy[deploy.index('--startup-probe') + 1], 'httpGet.path=/startup,httpGet.port=8080,periodSeconds=2,timeoutSeconds=1,failureThreshold=60')

    def exercise(self, failure=None, **options):
        calls = []
        smoke_calls = []
        revision = 'sms-code-relay-' + 'a' * 12 + '-1000'
        before = {'status': {'url': 'https://service.example', 'traffic': [{'revisionName': 'old-a', 'percent': 70}, {'revisionName': 'old-b', 'percent': 30}]}}
        after = {'status': {'traffic': [{'revisionName': revision, 'tag': 'candidate', 'url': 'https://candidate.example'}]}}
        describes = 0
        promotions = 0
        def fake_run(args, **kwargs):
            nonlocal describes, promotions
            calls.append(args)
            if args[:4] == ['gcloud', 'run', 'services', 'describe']:
                describes += 1
                return json.dumps(before if describes == 1 else after)
            if args[:4] == ['gcloud', 'firestore', 'indexes', 'composite']:
                return 'NEEDS_REPAIR' if failure == 'index' else 'READY'
            if args[:4] == ['gcloud', 'run', 'revisions', 'describe']:
                return self.env['IMAGE_URI'] if failure != 'digest' or args[4] != revision else 'wrong@sha256:wrong'
            if args[:4] == ['gcloud', 'run', 'services', 'update-traffic']:
                promotions += 1
                if failure == 'lost-ack' and promotions == 1:
                    raise RuntimeError('RPC acknowledgement lost')
            if args[:3] == ['gcloud', 'logging', 'read']:
                return 'error-log' if failure == 'canary' else ''
            return ''
        def fake_smoke(*args, **kwargs):
            smoke_calls.append(args)
            if failure == 'ledger' and args[0][-1] == 'scripts/check-security-ledger.ts':
                raise RuntimeError('ledger unavailable')
            if failure == 'smoke':
                if args[0][-1] == 'scripts/release-smoke.mjs':
                    raise RuntimeError('failed')
        with tempfile.TemporaryDirectory() as folder:
            cfg = d.config({**self.env, **options, 'DEPLOYMENT_MANIFEST_PATH': str(Path(folder) / 'manifest.json')})
            with patch.object(d, 'run', side_effect=fake_run), patch.object(d.subprocess, 'run', side_effect=fake_smoke), patch.object(d.time, 'time', return_value=1000), patch.object(d.time, 'sleep'):
                try:
                    d.deploy(cfg)
                except (RuntimeError, ValueError):
                    pass
            manifest = json.loads(Path(cfg['MANIFEST']).read_text())
        traffic = [c for c in calls if c[:4] == ['gcloud', 'run', 'services', 'update-traffic']]
        return calls, traffic, manifest, smoke_calls

    def test_bad_indexes_digest_or_smoke_never_change_traffic(self):
        for failure in ['ledger', 'index', 'digest', 'smoke']:
            with self.subTest(failure=failure):
                calls, traffic, manifest, _ = self.exercise(failure)
                self.assertEqual(traffic, [])
                self.assertEqual(manifest['status'], 'failed-before-promotion')
                if failure == 'ledger':
                    self.assertFalse(any(c[:3] == ['gcloud', 'run', 'deploy'] or c[:2] == ['npx', 'firebase'] for c in calls))

    def test_canary_failure_restores_exact_original_split(self):
        _, traffic, manifest, _ = self.exercise('canary')
        self.assertEqual(len(traffic), 2)
        self.assertEqual(traffic[-1][traffic[-1].index('--to-revisions') + 1], 'old-a=70,old-b=30')
        self.assertEqual(manifest['status'], 'rolled-back')

    def test_lost_traffic_acknowledgement_still_triggers_rollback(self):
        _, traffic, manifest, _ = self.exercise('lost-ack')
        self.assertEqual(len(traffic), 2)
        self.assertEqual(traffic[-1][traffic[-1].index('--to-revisions') + 1], 'old-a=70,old-b=30')
        self.assertEqual(manifest['status'], 'rolled-back')

    def test_promotes_only_configured_digest_after_smoke(self):
        calls, traffic, manifest, smokes = self.exercise()
        deploy = next(c for c in calls if c[:3] == ['gcloud', 'run', 'deploy'])
        self.assertIn('--no-traffic', deploy)
        self.assertIn('SERVICE_URL=https://service.example', deploy[deploy.index('--update-env-vars') + 1])
        self.assertIn('SECURITY_LEDGER_BUCKET=independent-test-ledger', deploy[deploy.index('--update-env-vars') + 1])
        self.assertEqual([int(c[c.index('--to-revisions') + 1].split(',')[-1].split('=')[1]) for c in traffic], [5, 25, 100])
        self.assertEqual(len(smokes), 5)
        self.assertEqual(smokes[0][0], ['node', '--import', 'tsx', 'scripts/check-security-ledger.ts'])
        self.assertEqual(manifest['status'], 'promoted')
        self.assertNotIn('private-fixture', json.dumps(manifest))
        self.assertEqual(set(manifest['previousImages']), {'old-a', 'old-b'})
        error_reads = [c for c in calls if c[:3] == ['gcloud', 'logging', 'read']]
        self.assertTrue(error_reads)
        self.assertTrue(all('httpRequest.status>=500' in c[3] and 'NOT httpRequest.requestUrl=~"^https?://[^/?#]+/startup/?([?].*)?$"' in c[3] for c in error_reads))
        probe_pattern = re.search(r'NOT httpRequest.requestUrl=~"([^"]+)"', error_reads[0][3]).group(1)
        for url in ['https://relay.example/startup', 'http://relay.example:8080/startup/', 'https://relay.example/startup?probe=1']:
            self.assertRegex(url, probe_pattern)
        for url in ['https://relay.example/v2/foo?x=/startup', 'https://relay.example/v2/startup', 'https://relay.example/startup-more', 'https://relay.example?x=/startup']:
            self.assertNotRegex(url, probe_pattern)

    def test_rust_defaults_to_zero_traffic_after_verified_smoke(self):
        _, traffic, manifest, smokes = self.exercise(BACKEND='rust')
        self.assertEqual(traffic, [])
        self.assertEqual(len(smokes), 2)
        self.assertEqual(manifest['status'], 'staged')
        self.assertEqual(manifest['backend'], 'rust')

    def test_apple_identifiers_reach_each_backend_without_overwriting_unset_configuration(self):
        identifiers = 'ABCDEFGHIJ.com.bluegrain.smsrelay,0123456789.com.example.companion'
        for backend in ['typescript', 'rust']:
            with self.subTest(backend=backend):
                calls, _, _, _ = self.exercise(BACKEND=backend, APPLE_APP_IDS=identifiers)
                deploy = next(c for c in calls if c[:3] == ['gcloud', 'run', 'deploy'])
                values = deploy[deploy.index('--update-env-vars') + 1].removeprefix('^|^').split('|')
                self.assertIn('APPLE_APP_IDS=' + identifiers, values)
        calls, _, _, _ = self.exercise(APPLE_APP_IDS='')
        deploy = next(c for c in calls if c[:3] == ['gcloud', 'run', 'deploy'])
        self.assertNotIn('APPLE_APP_IDS=', deploy[deploy.index('--update-env-vars') + 1])
        for invalid in ['invalid', identifiers + '|INJECTED=value', identifiers + ',']:
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                d.config({**self.env, 'APPLE_APP_IDS': invalid})

    def test_explicit_rust_promotion_keeps_guarded_canary_steps(self):
        _, traffic, manifest, smokes = self.exercise(BACKEND='rust', TRAFFIC_MODE='live')
        self.assertEqual(len(traffic), 3)
        self.assertEqual(len(smokes), 5)
        self.assertEqual(manifest['status'], 'promoted')

    def test_invalid_migration_selection_fails_before_cloud_calls(self):
        for options in [{'BACKEND': 'unknown'}, {'TRAFFIC_MODE': 'latest'}]:
            with self.subTest(options=options), self.assertRaises(ValueError):
                d.config({**self.env, **options})
