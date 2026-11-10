import importlib.util
import json
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
                    'RELAY_SMOKE_TOKEN': 'private-fixture', 'ANDROID_SIGNING_SHA256': ':'.join(['AA'] * 32)}

    def test_refuses_mutable_or_cross_project_images_before_cloud_calls(self):
        for bad in ['app:latest', self.env['IMAGE_URI'].replace('demo-sms-relay', 'other-project')]:
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                d.config({**self.env, 'IMAGE_URI': bad})
        with self.assertRaises(ValueError):
            d.config({**self.env, 'ANDROID_SIGNING_SHA256S': '["bad"]'})

    def exercise(self, failure=None):
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
            if failure == 'smoke':
                raise RuntimeError('failed')
        with tempfile.TemporaryDirectory() as folder:
            cfg = d.config({**self.env, 'DEPLOYMENT_MANIFEST_PATH': str(Path(folder) / 'manifest.json')})
            with patch.object(d, 'run', side_effect=fake_run), patch.object(d.subprocess, 'run', side_effect=fake_smoke), patch.object(d.time, 'time', return_value=1000), patch.object(d.time, 'sleep'):
                try:
                    d.deploy(cfg)
                except (RuntimeError, ValueError):
                    pass
            manifest = json.loads(Path(cfg['MANIFEST']).read_text())
        traffic = [c for c in calls if c[:4] == ['gcloud', 'run', 'services', 'update-traffic']]
        return calls, traffic, manifest, smoke_calls

    def test_bad_indexes_digest_or_smoke_never_change_traffic(self):
        for failure in ['index', 'digest', 'smoke']:
            with self.subTest(failure=failure):
                _, traffic, manifest, _ = self.exercise(failure)
                self.assertEqual(traffic, [])
                self.assertEqual(manifest['status'], 'failed-before-promotion')

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
        self.assertEqual([int(c[c.index('--to-revisions') + 1].split(',')[-1].split('=')[1]) for c in traffic], [5, 25, 100])
        self.assertEqual(len(smokes), 4)
        self.assertEqual(manifest['status'], 'promoted')
        self.assertNotIn('private-fixture', json.dumps(manifest))
        self.assertEqual(set(manifest['previousImages']), {'old-a', 'old-b'})
