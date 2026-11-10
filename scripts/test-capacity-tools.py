import importlib.util
import unittest
from pathlib import Path

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
        c['recovery_project']='recovery-project';rows=provision.commands(c,Path('/tmp'));self.assertTrue(any('--lock-retention-period' in r for r in rows));self.assertTrue(any('--schedule=0 3 * * *' in r for r in rows))
        c['image_digest']='image:latest'
        with self.assertRaises(ValueError):provision.commands(c,Path('/tmp'))
if __name__=='__main__':unittest.main()
