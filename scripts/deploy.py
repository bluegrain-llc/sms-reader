#!/usr/bin/env python3
"""Deploy an already tested image, smoke a tagged revision, and promote safely."""
import datetime
import json
import os
from pathlib import Path
import re
import subprocess
import signal
import time


def run(args, *, capture=True):
    result = subprocess.run(args, check=True, text=True, stdout=subprocess.PIPE if capture else None)
    return result.stdout.strip() if capture else ''


def config(env):
    c = {key: env.get(key, '') for key in ['PROJECT_ID', 'IMAGE_URI', 'COMMIT_SHA', 'RELAY_SMOKE_TOKEN', 'SECURITY_LEDGER_BUCKET']}
    for key, value in c.items():
        if not value:
            raise ValueError(f'Set {key}')
    if not re.fullmatch(r'[a-z][a-z0-9-]{4,61}[a-z0-9]', c['PROJECT_ID']):
        raise ValueError('Invalid project ID')
    if not re.fullmatch(r'[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]', c['SECURITY_LEDGER_BUCKET']):
        raise ValueError('Invalid security ledger bucket')
    if not re.fullmatch(r'[a-f0-9]{40}', c['COMMIT_SHA']):
        raise ValueError('COMMIT_SHA must be a full lowercase Git SHA')
    if not re.fullmatch(r'[a-z0-9-]+-docker\.pkg\.dev/' + re.escape(c['PROJECT_ID']) + r'/[a-z0-9_./-]+@sha256:[a-f0-9]{64}', c['IMAGE_URI']):
        raise ValueError('IMAGE_URI must be an Artifact Registry digest in PROJECT_ID')
    certs = json.loads(env.get('ANDROID_SIGNING_SHA256S', '[]'))
    legacy = env.get('ANDROID_SIGNING_SHA256')
    if legacy:
        certs = [*certs, legacy]
    if not isinstance(certs, list) or not certs or not all(isinstance(f, str) and re.fullmatch(r'(?:[A-Fa-f0-9]{2}:){31}[A-Fa-f0-9]{2}', f) for f in certs):
        raise ValueError('Supply valid Android signing fingerprints')
    c.update(REGION=env.get('REGION', 'us-central1'), SERVICE=env.get('SERVICE', 'sms-code-relay'), CERTS=list(dict.fromkeys(f.upper() for f in certs)))
    if not all(re.fullmatch(r'[a-z][a-z0-9-]*', c[k]) for k in ['REGION', 'SERVICE']):
        raise ValueError('Invalid region or service')
    c['MANIFEST'] = env.get('DEPLOYMENT_MANIFEST_PATH', 'artifacts/deployment.json')
    c['HOLD'] = int(env.get('PROMOTION_HOLD_SECONDS', '60'))
    if c['HOLD'] < 60:
        raise ValueError('Promotion observation window must be at least 60 seconds')
    return c


def deploy(c):
    project, region, service = c['PROJECT_ID'], c['REGION'], c['SERVICE']
    scope = ['--project', project, '--region', region]
    manifest = {'projectId': project, 'region': region, 'service': service, 'image': c['IMAGE_URI'], 'commit': c['COMMIT_SHA'], 'status': 'preflight'}
    target = Path(c['MANIFEST'])
    target.parent.mkdir(parents=True, exist_ok=True)

    def save(status):
        manifest['status'] = status
        target.write_text(json.dumps(manifest, indent=2) + '\n')

    # Pin all pre-existing traffic to named revisions. Never roll back to LATEST.
    previous = json.loads(run(['gcloud', 'run', 'services', 'describe', service, *scope, '--format=json']))
    url = previous['status']['url'].rstrip('/')
    traffic = {t['revisionName']: t['percent'] for t in previous['status'].get('traffic', []) if t.get('percent', 0)}
    if not traffic or sum(traffic.values()) != 100:
        raise ValueError('An existing healthy service with 100% pinned traffic is required; bootstrap staging separately')
    if not url.startswith('https://'):
        raise ValueError('Canonical service URL must be HTTPS')
    previous_images = {revision: run(['gcloud', 'run', 'revisions', 'describe', revision, *scope, '--format=value(status.imageDigest)']) for revision in traffic}
    if not all(re.search(r'@sha256:[a-f0-9]{64}$', image) for image in previous_images.values()):
        raise ValueError('Previous revision image digests must be available before deployment')
    manifest.update(serviceUrl=url, previousTraffic=traffic, previousImages=previous_images)
    scheduler = f'sms-relay-scheduler@{project}.iam.gserviceaccount.com'
    queue = f'projects/{project}/locations/{region}/queues/relay-delivery'
    manifest.update(schedulerEmail=scheduler, deliveryQueue=queue)
    save('preflight')
    changed = False
    try:
        # Verify source binding and actual locked retention/access policy before
        # creating a revision. A missing ledger must never reach promotion.
        ledger_env = os.environ.copy()
        ledger_env.update(SECURITY_LEDGER_BUCKET=c['SECURITY_LEDGER_BUCKET'], GOOGLE_CLOUD_PROJECT=project)
        subprocess.run(['node', '--import', 'tsx', 'scripts/check-security-ledger.ts'], env=ledger_env,
                       check=True, capture_output=True)
        # An index deployment is additive; destructive schema changes require a separate migration.
        run(['npx', 'firebase', 'deploy', '--only', 'firestore', '--project', project], capture=False)
        for attempt in range(120):
            states = run(['gcloud', 'firestore', 'indexes', 'composite', 'list', '--project', project, '--format=value(state)']).splitlines()
            if not states or any(s not in ('READY', 'CREATING') for s in states):
                raise RuntimeError('Firestore index preflight failed')
            if all(s == 'READY' for s in states):
                break
            if attempt == 119:
                raise RuntimeError('Indexes did not become READY')
            time.sleep(5)
        # One deploy creates the final configured revision; no follow-up config revision.
        runtime = {'GOOGLE_CLOUD_PROJECT': project, 'SERVICE_URL': url, 'SCHEDULER_EMAIL': scheduler,
                   'DELIVERY_QUEUE': queue, 'ANDROID_SIGNING_SHA256S': json.dumps(c['CERTS']),
                   'SECURITY_LEDGER_BUCKET': c['SECURITY_LEDGER_BUCKET']}
        # Preserve unrelated runtime settings, including secrets and approved origins.
        # update-env-vars supports custom separators; values here cannot contain this sentinel.
        values = '^|^' + '|'.join(f'{k}={v}' for k, v in runtime.items())
        revision = f'{service}-{c["COMMIT_SHA"][:12]}-{int(time.time())}'
        if len(revision) > 63:
            raise ValueError('SERVICE is too long for a pinned revision name')
        manifest['revision'] = revision
        save('deploying')
        run(['gcloud', 'run', 'deploy', service, *scope, '--image', c['IMAGE_URI'], '--revision-suffix', revision[len(service)+1:],
             '--service-account', f'sms-relay-server@{project}.iam.gserviceaccount.com', '--allow-unauthenticated',
             '--port', '8080', '--memory', '512Mi', '--timeout', '120', '--max-instances', '10', '--min-instances', '0',
             '--update-env-vars', values, '--no-traffic', '--tag', 'candidate', '--quiet'], capture=False)
        live = json.loads(run(['gcloud', 'run', 'services', 'describe', service, *scope, '--format=json']))
        candidate = next(t['url'] for t in live['status']['traffic'] if t.get('tag') == 'candidate' and t.get('revisionName') == revision)
        manifest['candidateUrl'] = candidate
        actual = run(['gcloud', 'run', 'revisions', 'describe', revision, *scope, '--format=value(status.imageDigest)'])
        if actual.rsplit('@', 1)[-1] != c['IMAGE_URI'].rsplit('@', 1)[-1]:
            raise RuntimeError('Revision digest does not match tested artifact')
        smoke_env = os.environ.copy()
        smoke_env.update(RELAY_URL=candidate, RELAY_SMOKE_TOKEN=c['RELAY_SMOKE_TOKEN'], ANDROID_SIGNING_SHA256S=json.dumps(c['CERTS']))
        def smoke():
            subprocess.run(['node', 'scripts/release-smoke.mjs'], env=smoke_env, check=True)
        smoke()
        for percent in (5, 25, 100):
            allocation = {rev: p * (100 - percent) // 100 for rev, p in traffic.items()}
            # Preserve exact total with rounding allocated to the first previous revision.
            first = next(iter(allocation))
            allocation[first] += 100 - percent - sum(allocation.values())
            allocation[revision] = percent
            started = datetime.datetime.now(datetime.timezone.utc).isoformat()
            changed = True  # RPC acknowledgement can be lost after traffic changed.
            run(['gcloud', 'run', 'services', 'update-traffic', service, *scope, '--to-revisions', ','.join(f'{r}={p}' for r, p in allocation.items() if p), '--quiet'], capture=False)
            save(f'observing-{percent}')
            time.sleep(c['HOLD'])
            smoke()
            errors = run(['gcloud', 'logging', 'read', f'resource.type="cloud_run_revision" AND resource.labels.service_name="{service}" AND resource.labels.revision_name="{revision}" AND httpRequest.status>=500 AND timestamp>="{started}"', '--project', project, '--limit=1', '--format=value(insertId)'])
            if errors:
                raise RuntimeError('Candidate recorded HTTP 5xx during observation')
        save('promoted')
    except BaseException:
        if changed:
            try:
                run(['gcloud', 'run', 'services', 'update-traffic', service, *scope, '--to-revisions', ','.join(f'{r}={p}' for r, p in traffic.items()), '--quiet'], capture=False)
                save('rolled-back')
            except BaseException:
                save('rollback-required')
                raise RuntimeError('Automatic rollback failed; use previousTraffic in deployment manifest') from None
        else:
            save('failed-before-promotion')
        raise
    return manifest


if __name__ == '__main__':
    try:
        def interrupted(_number, _frame):
            raise RuntimeError('Deployment interrupted')
        signal.signal(signal.SIGTERM, interrupted)
        deploy(config(os.environ))
    except (ValueError, RuntimeError, subprocess.CalledProcessError, KeyError, StopIteration) as error:
        # Do not print command arguments, configuration or credentials.
        raise SystemExit(f'Deployment stopped: {type(error).__name__}. Inspect deployment manifest and cloud status.') from None
