#!/usr/bin/env python3
"""Render recovery infrastructure commands. Apply requires explicit immutable retention acknowledgement."""
import argparse,json,re,subprocess,sys
from pathlib import Path
from urllib.request import Request, urlopen

def lock_ledger(bucket):
    if not re.fullmatch(r'[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]',bucket): raise ValueError('invalid bucket')
    token=subprocess.run(['gcloud','auth','print-access-token'],check=True,capture_output=True,text=True,timeout=30).stdout.strip()
    if not token: raise ValueError('cloud_access_token_missing')
    url='https://storage.googleapis.com/storage/v1/b/'+bucket
    def request(method, endpoint):
        with urlopen(Request(endpoint,method=method,headers={'Authorization':'Bearer '+token},
                             data=b'' if method=='POST' else None),timeout=30) as response:
            return json.load(response)
    def private_policy(value):
        iam=value.get('iamConfiguration',{})
        if iam.get('uniformBucketLevelAccess',{}).get('enabled') is not True or iam.get('publicAccessPrevention')!='enforced':
            raise ValueError('ledger_access_policy_unsafe')
        return value.get('retentionPolicy',{})
    metadata=request('GET',url);policy=private_policy(metadata)
    if policy.get('isLocked') is True:
        if not re.fullmatch(r'[0-9]+',str(policy.get('retentionPeriod',''))) or int(policy['retentionPeriod'])<604800:
            raise ValueError('ledger_retention_lock_unverified')
        return
    # The explicit provisioning acknowledgement covers the planned seven-day
    # lock only. Never permanently lock an unexpected policy after a race.
    if policy.get('retentionPeriod')!='604800' or not re.fullmatch(r'[1-9][0-9]*',str(metadata.get('metageneration',''))):
        raise ValueError('ledger_retention_policy_unexpected')
    request('POST',url+'/lockRetentionPolicy?ifMetagenerationMatch='+str(metadata['metageneration']))
    policy=private_policy(request('GET',url))
    if policy.get('isLocked') is not True or policy.get('retentionPeriod')!='604800':
        raise ValueError('ledger_retention_lock_unverified')

def commands(c, root):
    required=['project','recovery_project','region','backup_bucket','ledger_bucket','runtime_account','backup_account','scheduler_account','image_digest']
    if any(not isinstance(c.get(k),str) or not c[k] for k in required): raise ValueError('missing configuration')
    for k in ['project','recovery_project']:
        if not re.fullmatch(r'[a-z][a-z0-9-]{4,61}[a-z0-9]',c[k]): raise ValueError('invalid project')
    if c['project']==c['recovery_project']: raise ValueError('ledger must use independent recovery project')
    for k in ['backup_bucket','ledger_bucket']:
        if not re.fullmatch(r'[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]',c[k]): raise ValueError('invalid bucket')
    if not re.fullmatch(r'[a-z0-9.-]+/[a-zA-Z0-9_./-]+@sha256:[a-f0-9]{64}',c['image_digest']): raise ValueError('tested digest required')
    for k in ['runtime_account','backup_account','scheduler_account']:
        if not re.fullmatch(r'[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com',c[k]): raise ValueError('invalid account')
    rows=[]
    for key in ['backup_bucket','ledger_bucket']:
        bucket='gs://'+c[key]
        rows += [['gcloud','storage','buckets','create',bucket,'--project='+c['recovery_project'],'--location='+c['region'],'--uniform-bucket-level-access'],
                 ['gcloud','storage','buckets','update',bucket,'--public-access-prevention','--soft-delete-duration=0'],
                 ['gcloud','storage','buckets','update',bucket,'--lifecycle-file='+str(root/('ledger-lifecycle.json' if key=='ledger_bucket' else 'lifecycle.json'))]]
        if key=='ledger_bucket': rows += [['gcloud','storage','buckets','update',bucket,'--retention-period=7d'],
            [sys.executable,str(Path(__file__).resolve()),'--lock-ledger-bucket',c[key],'--acknowledge-irreversible-ledger-lock']]
    rows += [['gcloud','storage','cp',str(root/'manifest.json'),'gs://'+c['ledger_bucket']+'/manifest.json','--if-generation-match=0']]
    for account, key, role in [(c['runtime_account'],'ledger_bucket','roles/storage.objectCreator'),(c['runtime_account'],'ledger_bucket','roles/storage.legacyBucketReader'),(c['runtime_account'],'ledger_bucket','roles/storage.objectViewer'),(c['backup_account'],'backup_bucket','roles/storage.objectCreator'),(c['backup_account'],'ledger_bucket','roles/storage.objectViewer'),(c['backup_account'],'ledger_bucket','roles/storage.legacyBucketReader')]:
        rows += [['gcloud','storage','buckets','add-iam-policy-binding','gs://'+c[key],'--member=serviceAccount:'+account,'--role='+role]]
    # Backup identity is dedicated; runtime cannot read snapshots or delete ledger objects.
    rows += [['gcloud','projects','add-iam-policy-binding',c['project'],'--member=serviceAccount:'+c['backup_account'],'--role=roles/datastore.viewer','--condition=None'],
        ['gcloud','run','jobs','deploy','relay-metadata-backup','--project='+c['project'],'--region='+c['region'],'--image='+c['image_digest'],'--service-account='+c['backup_account'],'--tasks=1','--max-retries=2','--task-timeout=1800s','--command=node','--args=server/dist/recovery-cli.js,backup,--project,'+c['project']+',--backup-bucket,'+c['backup_bucket']+',--ledger-bucket,'+c['ledger_bucket']],
        ['gcloud','run','jobs','add-iam-policy-binding','relay-metadata-backup','--project='+c['project'],'--region='+c['region'],'--member=serviceAccount:'+c['scheduler_account'],'--role=roles/run.invoker'],
        ['gcloud','scheduler','jobs','create','http','relay-metadata-backup','--project='+c['project'],'--location='+c['region'],'--schedule=0 3 * * *','--time-zone=UTC','--http-method=POST','--uri=https://run.googleapis.com/v2/projects/'+c['project']+'/locations/'+c['region']+'/jobs/relay-metadata-backup:run','--oauth-service-account-email='+c['scheduler_account']]]
    return rows

def main():
    p=argparse.ArgumentParser();p.add_argument('--config',type=Path);p.add_argument('--output',type=Path);p.add_argument('--apply',action='store_true');p.add_argument('--acknowledge-irreversible-ledger-lock',action='store_true');p.add_argument('--lock-ledger-bucket');a=p.parse_args()
    if a.lock_ledger_bucket:
        if not a.acknowledge_irreversible_ledger_lock: p.error('immutable bucket retention lock acknowledgement required')
        if a.config or a.output or a.apply: p.error('ledger locking cannot be combined with provisioning options')
        lock_ledger(a.lock_ledger_bucket)
        print(json.dumps({'ledgerBucket':a.lock_ledger_bucket,'retentionLocked':True}));return
    if not a.config or not a.output: p.error('--config and --output are required for provisioning')
    c=json.loads(a.config.read_text());a.output.mkdir(parents=True,exist_ok=True)
    import time
    (a.output/'manifest.json').write_text(json.dumps({'version':1,'project':c['project'],'createdAt':int(time.time()*1000)}))
    (a.output/'ledger-lifecycle.json').write_text(json.dumps({'rule':[{'action':{'type':'Delete'},'condition':{'age':7,'matchesPrefix':['intents/']}}]}))
    (a.output/'lifecycle.json').write_text(json.dumps({'rule':[{'action':{'type':'Delete'},'condition':{'age':7}}]}))
    rows=commands(c,a.output.resolve());(a.output/'commands.json').write_text(json.dumps(rows,indent=2)+'\n')
    if a.apply:
        if not a.acknowledge_irreversible_ledger_lock: p.error('immutable bucket retention lock acknowledgement required')
        for cmd in rows: subprocess.run(cmd,check=True)
    print(json.dumps({'commands':len(rows),'applied':a.apply}))
if __name__=='__main__': main()
