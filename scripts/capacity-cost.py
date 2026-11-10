#!/usr/bin/env python3
"""Project measured staging usage at the accepted production workload. Prices are explicit dated inputs."""
import argparse,json,math
from pathlib import Path
UNITS=('compute_vcpu_seconds','compute_gib_seconds','http_requests','firestore_reads','firestore_writes','firestore_deletes','storage_gib_month','storage_operations','egress_gib','monitoring_usd','backup_usd')
def finite_quantity(value):
    try:
        return not isinstance(value,bool) and isinstance(value,(int,float)) and math.isfinite(value) and value>=0
    except OverflowError:
        return False
def project_cost(m):
    if any(not finite_quantity(m.get(key)) for key in ('request_count','duration_seconds','average_streams','peak_streams','peak_seconds')): raise ValueError('invalid workload measurement')
    if m.get('environment')!='staging' or m.get('request_count',0)!=10000 or m.get('duration_seconds')!=86400 or m.get('average_streams')!=20 or m.get('peak_streams')!=200 or not 1800<=m['peak_seconds']<=m['duration_seconds']: raise ValueError('one exact measured workload day required')
    if not m.get('pricing_date') or not m.get('pricing_sources') or not m.get('usage_evidence'): raise ValueError('dated primary prices and measured evidence required')
    usage=m['usage'];prices=m['unit_prices'];out={}
    for unit in UNITS:
        u=usage[unit];p=prices[unit]
        if any(not finite_quantity(x) for x in (u,p)): raise ValueError('invalid quantity')
        # storage is already monthly; daily metered traffic/compute extrapolates to 30 days.
        try: out[unit]=u*p*(1 if unit.endswith('_month') or unit.endswith('_usd') else 30)
        except OverflowError as error: raise ValueError('invalid projected quantity') from error
        if not finite_quantity(out[unit]): raise ValueError('invalid projected quantity')
    total=sum(out.values())
    if not finite_quantity(total): raise ValueError('invalid projected total')
    return {'version':1,'projected_monthly_usd':round(total,2),'target_usd':100,'gate':'PASS' if total<=100 else 'BLOCKED','components':out,'pricing_date':m['pricing_date'],'usage_evidence':m['usage_evidence']}
def main():
    p=argparse.ArgumentParser();p.add_argument('--measurements',required=True,type=Path);p.add_argument('--output',required=True,type=Path);a=p.parse_args()
    try:
        r=project_cost(json.loads(a.measurements.read_text()));a.output.write_text(json.dumps(r,indent=2)+'\n');print(json.dumps({'gate':r['gate'],'projected_monthly_usd':r['projected_monthly_usd']}));return 0 if r['gate']=='PASS' else 1
    except (ValueError,KeyError,TypeError): print('cost_projection_requires_complete_measurements');return 1
if __name__=='__main__': raise SystemExit(main())
