import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

def load(name):
    spec=importlib.util.spec_from_file_location(name,Path(__file__).with_name(name+'.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
cost=load('capacity-cost');provision=load('recovery-provision')
class CapacityTools(unittest.TestCase):
    def measured(self):
        return dict(environment='staging',request_count=10000,duration_seconds=86400,average_streams=20,peak_streams=200,peak_seconds=1800,pricing_date='2026-11-10',pricing_sources=['https://cloud.google.com/run/pricing'],usage_evidence=['synthetic-fixture'],usage={k:1 for k in cost.UNITS},unit_prices={k:.01 for k in cost.UNITS})
    def test_cost_requires_full_measurement(self):
        for duration in [600, 86401, 172800]:
            m=self.measured();m['duration_seconds']=duration
            with self.subTest(duration=duration), self.assertRaises(ValueError):cost.project_cost(m)
    def test_cost_extrapolates_metered_usage_but_not_monthly_storage(self):
        r=cost.project_cost(self.measured());self.assertEqual(r['components']['compute_vcpu_seconds'],.3);self.assertEqual(r['components']['storage_gib_month'],.01);self.assertEqual(r['gate'],'PASS')
    def test_cost_blocks_budget_or_nonfinite(self):
        m=self.measured();m['usage']['firestore_reads']=100000;self.assertEqual(cost.project_cost(m)['gate'],'BLOCKED')
        m=self.measured();m['usage']['compute_vcpu_seconds']=float('nan')
        with self.assertRaises(ValueError):cost.project_cost(m)
    def test_cost_rejects_undefined_or_impossible_peak_measurements(self):
        for value in [float('nan'), float('inf'), -float('inf'), None, True, '1800', [], -1, 1799, 86401, 10**1000]:
            m=self.measured();m['peak_seconds']=value
            with self.subTest(peak_seconds=repr(value)), self.assertRaises(ValueError):cost.project_cost(m)
        for value in [1800, 86400]:
            m=self.measured();m['peak_seconds']=value;self.assertEqual(cost.project_cost(m)['gate'],'PASS')
    def test_cost_rejects_arithmetic_overflow_in_components_or_total(self):
        m=self.measured();m['usage']['compute_vcpu_seconds']=1e308;m['unit_prices']['compute_vcpu_seconds']=1
        with self.assertRaises(ValueError):cost.project_cost(m)
        m=self.measured()
        for key in cost.UNITS:m['usage'][key]=1e307;m['unit_prices'][key]=.1
        with self.assertRaises(ValueError):cost.project_cost(m)
    def test_provision_rejects_shared_project_or_untested_image(self):
        c=dict(project='source-project',recovery_project='source-project',region='us-central1',backup_bucket='backup-bucket',ledger_bucket='ledger-bucket',runtime_account='runtime@source-project.iam.gserviceaccount.com',backup_account='backup@source-project.iam.gserviceaccount.com',scheduler_account='scheduler@source-project.iam.gserviceaccount.com',image_digest='region-docker.pkg.dev/project/repo/image@sha256:'+'a'*64)
        with self.assertRaises(ValueError):provision.commands(c,Path('/tmp'))
        c['recovery_project']='recovery-project';rows=provision.commands(c,Path('/tmp'));self.assertTrue(any('--lock-ledger-bucket' in r for r in rows));self.assertFalse(any('--lock-retention-period' in r for r in rows));self.assertTrue(any('--schedule=0 3 * * *' in r for r in rows))
        c['image_digest']='image:latest'
        with self.assertRaises(ValueError):provision.commands(c,Path('/tmp'))

class RetentionLock(unittest.TestCase):
    def metadata(self, locked=False, generation='17', period='604800'):
        return {'metageneration':generation,'retentionPolicy':{'retentionPeriod':period,'isLocked':locked},
                'iamConfiguration':{'uniformBucketLevelAccess':{'enabled':True},'publicAccessPrevention':'enforced'}}
    def run_lock(self, responses):
        calls=[]
        def request(req, timeout):
            calls.append(req)
            value=responses.pop(0)
            if isinstance(value,Exception):raise value
            return io.BytesIO(json.dumps(value).encode())
        with patch.dict(os.environ,{'CLOUDSDK_CORE_DISABLE_PROMPTS':'1'}), \
             patch.object(provision.subprocess,'run',return_value=subprocess.CompletedProcess([],0,'private-token\n','')) as auth, \
             patch.object(provision,'urlopen',side_effect=request):
            provision.lock_ledger('recovery-ledger')
        self.assertEqual(auth.call_count,1)
        self.assertEqual(auth.call_args.args[0],['gcloud','auth','print-access-token'])
        return calls
    def test_noninteractive_lock_uses_exact_metageneration_and_verified_readback(self):
        calls=self.run_lock([self.metadata(),{},self.metadata(locked=True,generation='18')])
        self.assertEqual([r.get_method() for r in calls],['GET','POST','GET'])
        self.assertEqual(calls[1].full_url,'https://storage.googleapis.com/storage/v1/b/recovery-ledger/lockRetentionPolicy?ifMetagenerationMatch=17')
        self.assertEqual(calls[1].get_header('Authorization'),'Bearer private-token')
    def test_success_response_without_locked_readback_fails(self):
        with self.assertRaisesRegex(ValueError,'ledger_retention_lock_unverified'):
            self.run_lock([self.metadata(),{},self.metadata(generation='18')])
    def test_already_locked_policy_is_verified_without_mutation(self):
        calls=self.run_lock([self.metadata(locked=True)])
        self.assertEqual([r.get_method() for r in calls],['GET'])
    def test_unsafe_or_unexpected_policy_cannot_be_locked(self):
        for metadata in [self.metadata(period='0'),self.metadata(period='1209600'),self.metadata(generation=''),self.metadata(locked=True,period='0'),
                         {**self.metadata(),'iamConfiguration':{}}]:
            with self.subTest(metadata=metadata),self.assertRaises(ValueError):self.run_lock([metadata])
    def test_changed_metageneration_is_not_retried_without_precondition(self):
        from urllib.error import HTTPError
        error=HTTPError('https://storage.googleapis.com/',412,'Precondition Failed',{},None)
        try:
            with self.assertRaises(HTTPError):self.run_lock([self.metadata(),error])
        finally:error.close()
    def test_standalone_helper_requires_acknowledgement_before_cloud_access(self):
        with patch.object(sys,'argv',['recovery-provision.py','--lock-ledger-bucket','recovery-ledger']), \
             patch.object(provision.subprocess,'run') as cloud,patch.object(sys,'stderr',io.StringIO()):
            with self.assertRaises(SystemExit):provision.main()
        cloud.assert_not_called()
    def test_apply_stops_before_manifest_when_lock_is_not_verified(self):
        config=dict(project='source-project',recovery_project='recovery-project',region='us-central1',backup_bucket='backup-bucket',ledger_bucket='recovery-ledger',runtime_account='runtime@source-project.iam.gserviceaccount.com',backup_account='backup@source-project.iam.gserviceaccount.com',scheduler_account='scheduler@source-project.iam.gserviceaccount.com',image_digest='region-docker.pkg.dev/project/repo/image@sha256:'+'a'*64)
        calls=[];responses=[self.metadata(),{},self.metadata()]
        def run(cmd,**kwargs):
            calls.append(cmd)
            if '--lock-ledger-bucket' in cmd:provision.lock_ledger('recovery-ledger')
            # gcloud may report an aborted interactive lock with exit zero.
            return subprocess.CompletedProcess(cmd,0,'private-token\n','ERROR: Abort locking retention policy')
        with tempfile.TemporaryDirectory() as root:
            config_path=Path(root)/'config.json';config_path.write_text(json.dumps(config))
            argv=['recovery-provision.py','--config',str(config_path),'--output',str(Path(root)/'plan'),'--apply','--acknowledge-irreversible-ledger-lock']
            with patch.object(sys,'argv',argv),patch.object(provision.subprocess,'run',side_effect=run), \
                 patch.object(provision,'urlopen',side_effect=lambda req,timeout:io.BytesIO(json.dumps(responses.pop(0)).encode())):
                with self.assertRaisesRegex(ValueError,'ledger_retention_lock_unverified'):provision.main()
        self.assertFalse(any(cmd[:3]==['gcloud','storage','cp'] for cmd in calls))
if __name__=='__main__':unittest.main()
