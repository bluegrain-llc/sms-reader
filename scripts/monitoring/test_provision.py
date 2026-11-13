import contextlib
import importlib.util
import io
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('provision', Path(__file__).with_name('provision.py'))
provision = importlib.util.module_from_spec(spec)
spec.loader.exec_module(provision)


class ProvisionTest(unittest.TestCase):
    def config(self):
        return provision.resources('demo-sms-relay', 'sms-code-relay', ['projects/demo-sms-relay/notificationChannels/1'], '1234', 'ABCDEF-ABCDEF-ABCDEF')

    def test_retention_and_backlog_alerts_use_fixed_payload_fields(self):
        config = self.config()
        filters = {m['name']: m['filter'] for m in config['metrics']}
        self.assertIn('jsonPayload.event="deletion_failed"', filters['sms_relay/sms-code-relay/worker_failures'])
        self.assertIn('oldest_due_age_s>180', filters['sms_relay/sms-code-relay/delivery_overdue'])
        self.assertIn('oldest_due_age_s>300', filters['sms_relay/sms-code-relay/results_overdue'])
        self.assertTrue(all('resource.labels.project_id="demo-sms-relay"' in f for f in filters.values()))
        self.assertEqual(config['budget']['amount']['specifiedAmount'], {'currencyCode': 'USD', 'units': '100'})
        self.assertEqual([r['thresholdPercent'] for r in config['budget']['thresholdRules']], [0.5, 0.8, 1.0])
        self.assertEqual(config['budget']['budgetFilter']['projects'], ['projects/1234'])
        self.assertNotIn('spendCap', config['budget'])
        absence = config['policies'][0]['conditions'][0]['conditionAbsent']
        self.assertEqual(absence['duration'], '180s')

    def test_services_have_disjoint_metric_names(self):
        first = self.config()
        second = provision.resources('demo-sms-relay', 'other-service', [], '1234', 'ABCDEF-ABCDEF-ABCDEF')
        self.assertTrue(set(m['name'] for m in first['metrics']).isdisjoint(m['name'] for m in second['metrics']))

    def test_startup_probes_do_not_count_as_user_errors_or_latency(self):
        metrics = {m['name'].rsplit('/', 1)[-1]: m for m in self.config()['metrics']}
        for name in ['http_requests', 'http_latency_ms']:
            self.assertIn('jsonPayload.route!="/startup"', metrics[name]['filter'])
            self.assertIn('jsonPayload.route!="/health"', metrics[name]['filter'])
            self.assertNotIn('jsonPayload.status_class!="5xx"', metrics[name]['filter'])
            self.assertNotIn('jsonPayload.route!="/v1/devices"', metrics[name]['filter'])
        self.assertIn('jsonPayload.event="deletion_failed"', metrics['worker_failures']['filter'])

    def test_unusable_channels_fail_before_writes(self):
        valid = {'type': 'email', 'verificationStatus': 'VERIFIED', 'enabled': True}
        for channel in [
            {**valid, 'enabled': False},
            {'type': 'email', 'verificationStatus': 'VERIFIED'},
            {**valid, 'type': 'sms'},
            {**valid, 'verificationStatus': 'UNVERIFIED'},
            {**valid, 'verificationStatus': 'unknown'},
            {**valid, 'verificationStatus': None},
        ]:
            with self.subTest(channel=channel):
                calls = []
                def api(token, method, url, body=None):
                    calls.append(method)
                    if 'cloudresourcemanager' in url:
                        return {'projectNumber': '1234'}
                    if '/billingInfo' in url:
                        return {'billingEnabled': True, 'billingAccountName': 'billingAccounts/ABCDEF-ABCDEF-ABCDEF'}
                    return channel
                with patch.object(provision, 'api', api), patch.object(provision.subprocess, 'check_output', return_value='token'), self.assertRaises(ValueError):
                    provision.apply(self.config(), 'operator@example.test')
                self.assertTrue(all(method == 'GET' for method in calls))

    def test_usable_email_verification_states_provision_alerts_and_budget(self):
        for status in ['VERIFIED', 'VERIFICATION_STATUS_UNSPECIFIED', None]:
            with self.subTest(status=status):
                config = self.config()
                channel = {'type': 'email', 'enabled': True}
                if status is not None:
                    channel['verificationStatus'] = status
                writes = []
                def api(token, method, url, body=None):
                    if method != 'GET':
                        writes.append((method, url, body))
                        return {}
                    if 'cloudresourcemanager' in url:
                        return {'projectNumber': '1234'}
                    if '/billingInfo' in url:
                        return {'billingEnabled': True, 'billingAccountName': 'billingAccounts/ABCDEF-ABCDEF-ABCDEF'}
                    if '/notificationChannels/' in url:
                        return channel
                    return {}
                with patch.object(provision, 'api', api), patch.object(provision.subprocess, 'check_output', return_value='token'), contextlib.redirect_stdout(io.StringIO()):
                    provision.apply(config, 'operator@example.test')
                self.assertEqual([body for method, _, body in writes if method == 'PUT'], config['metrics'])
                self.assertEqual([body for method, _, body in writes if method == 'POST'], [*config['policies'], config['budget']])

    def test_render_does_not_authenticate_or_write(self):
        args = ['provision.py', '--project', 'demo-sms-relay', '--project-number', '1234', '--billing-account', 'ABCDEF-ABCDEF-ABCDEF', '--channel', 'projects/demo-sms-relay/notificationChannels/1']
        with patch('sys.argv', args), patch.object(provision, 'apply') as apply, contextlib.redirect_stdout(io.StringIO()):
            provision.main()
        apply.assert_not_called()

    def test_apply_requires_explicit_account_and_same_project_channels(self):
        args = ['provision.py', '--project', 'demo-sms-relay', '--project-number', '1234', '--billing-account', 'ABCDEF-ABCDEF-ABCDEF', '--channel', 'projects/demo-sms-relay/notificationChannels/1', '--apply']
        for arguments in [args, [*args[:-2], 'projects/other-project/notificationChannels/1']]:
            with patch('sys.argv', arguments), contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                provision.main()

    def test_upsert_uses_existing_policy_and_budget_receipts(self):
        config = self.config()
        calls = []
        policies = [{**p, 'name': f'projects/demo-sms-relay/alertPolicies/{n}'} for n, p in enumerate(config['policies'])]
        def api(token, method, url, body=None):
            calls.append((method, url, body))
            self.assertEqual(token, 'private-access-token')
            if method == 'GET':
                if 'cloudresourcemanager' in url:
                    return {'projectNumber': '1234'}
                if '/billingInfo' in url:
                    return {'billingEnabled': True, 'billingAccountName': 'billingAccounts/ABCDEF-ABCDEF-ABCDEF'}
                if '/notificationChannels/' in url:
                    return {'type': 'email', 'verificationStatus': 'VERIFIED', 'enabled': True}
                if '/alertPolicies' in url:
                    return {'alertPolicies': policies}
                return {'budgets': [{**config['budget'], 'name': 'billingAccounts/ABCDEF-ABCDEF-ABCDEF/budgets/1', 'etag': 'version-one'}]}
            return {}
        with patch.object(provision, 'api', api), patch.object(provision.subprocess, 'check_output', return_value='private-access-token\n') as command, contextlib.redirect_stdout(io.StringIO()):
            provision.apply(config, 'operator@example.test')
        self.assertEqual(command.call_args.args[0][-2:], ['--account', 'operator@example.test'])
        self.assertFalse(any(method == 'POST' for method, _, _ in calls))
        patches = [call for call in calls if call[0] == 'PATCH']
        self.assertEqual(len(patches), len(config['policies']) + 1)
        self.assertEqual(patches[-1][2]['etag'], 'version-one')


if __name__ == '__main__':
    unittest.main()
