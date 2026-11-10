#!/usr/bin/env python3
"""Render or apply project-scoped monitoring. Rendering is the default; --apply writes Google Cloud."""
import argparse
import json
import re
import subprocess
import urllib.error
import urllib.parse
import urllib.request


def resources(project, service, channels, number, billing):
    scope = f'resource.type="cloud_run_revision" resource.labels.project_id="{project}" resource.labels.service_name="{service}" jsonPayload.component="relay"'
    valid_http = 'jsonPayload.event="http_completed" jsonPayload.route!~"^/internal/" jsonPayload.route!="/health" jsonPayload.route!="/healthz" jsonPayload.route!="/v2/events/stream" jsonPayload.route!="unmatched" jsonPayload.status_class!="4xx"'
    definitions = [
        ('http_requests', valid_http, None, ['status_class']),
        ('http_latency_ms', valid_http, 'duration_ms', []),
        ('maintenance_completed', 'jsonPayload.event="maintenance_completed"', None, []),
        ('worker_failures', '(jsonPayload.event="maintenance_failed" OR jsonPayload.event="backlog_sampling_failed" OR jsonPayload.event="wakeup_failed" OR jsonPayload.event="mcp_tool_failed")', None, []),
        ('delivery_attempts', 'jsonPayload.event="delivery_attempt"', None, ['kind', 'outcome', 'category']),
        ('delivery_acceptance_age_ms', 'jsonPayload.event="delivery_attempt" jsonPayload.outcome="accepted" jsonPayload.kind!="webhook"', 'age_ms', ['kind']),
        ('delivery_overdue', 'jsonPayload.event="backlog_snapshot" (jsonPayload.kind="sms" OR jsonPayload.kind="form") jsonPayload.oldest_due_age_s>180', None, []),
        ('results_overdue', 'jsonPayload.event="backlog_snapshot" (jsonPayload.kind="results" OR jsonPayload.kind="form_results") jsonPayload.oldest_due_age_s>300', None, []),
        ('backlog_depth', 'jsonPayload.event="backlog_snapshot"', 'count', ['kind']),
        ('backlog_oldest_due_age_s', 'jsonPayload.event="backlog_snapshot"', 'oldest_due_age_s', ['kind']),
        ('deletion_overdue', 'jsonPayload.event="backlog_snapshot" (jsonPayload.kind="deletion" OR jsonPayload.kind="legacy_deletion") jsonPayload.oldest_due_age_s>300', None, []),
    ]
    metrics = []
    for name, condition, value, labels in definitions:
        descriptor = {'metricKind': 'DELTA', 'valueType': 'DISTRIBUTION' if value else 'INT64', 'unit': 's' if value == 'oldest_due_age_s' else 'ms' if value in ['duration_ms', 'age_ms'] else '1',
                      'labels': [{'key': label, 'valueType': 'STRING'} for label in labels]}
        metric = {'name': f'sms_relay/{service}/{name}', 'description': f'SMS relay {name}; fixed-schema application logs only.',
                  'filter': f'{scope} {condition}', 'metricDescriptor': descriptor,
                  'labelExtractors': {label: f'EXTRACT(jsonPayload.{label})' for label in labels}}
        if value:
            metric.update(valueExtractor=f'EXTRACT(jsonPayload.{value})', bucketOptions={'explicitBuckets': {'bounds': [1, 10, 50, 100, 250, 500, 1000, 2000, 5000, 10000, 30000, 60000, 120000, 180000]}})
        metrics.append(metric)
    def metric_filter(name):
        return f'resource.type="cloud_run_revision" resource.labels.project_id="{project}" resource.labels.service_name="{service}" metric.type="logging.googleapis.com/user/sms_relay/{service}/{name}"'
    def aggregation(aligner='ALIGN_DELTA', reducer='REDUCE_SUM'):
        return [{'alignmentPeriod': '60s', 'perSeriesAligner': aligner, 'crossSeriesReducer': reducer}]
    policies = []
    def policy(name, condition, advice):
        policies.append({'displayName': f'SMS relay {service}: {name}', 'combiner': 'OR', 'enabled': True,
                         'notificationChannels': channels, 'conditions': [{'displayName': name, **condition}],
                         'documentation': {'content': advice + '\nFollow docs/OPERATIONS.md. Never attach payloads, tokens or raw provider exceptions.', 'mimeType': 'text/markdown'},
                         'alertStrategy': {'autoClose': '1800s'}})
    policy('maintenance missing', {'conditionAbsent': {'filter': metric_filter('maintenance_completed'), 'duration': '180s', 'aggregations': aggregation(), 'trigger': {'count': 1}}},
           'Maintenance has no completion signal for three minutes. Check Scheduler OIDC, service health and indexes. Bootstrap one real completion before relying on this absence policy.')
    for name in ['worker_failures', 'delivery_overdue', 'results_overdue', 'deletion_overdue']:
        policy(name, {'conditionThreshold': {'filter': metric_filter(name), 'comparison': 'COMPARISON_GT', 'thresholdValue': 0,
                                            'duration': '0s', 'aggregations': aggregation(), 'trigger': {'count': 1}}},
               'Inspect sanitized event categories and oldest-due backlog. Recover the worker; do not extend API expiry or bypass authorization.')
    policy('API error ratio above 1 percent', {'conditionThreshold': {'filter': metric_filter('http_requests') + ' metric.labels.status_class="5xx"',
           'denominatorFilter': metric_filter('http_requests'), 'aggregations': aggregation(), 'denominatorAggregations': aggregation(),
           'comparison': 'COMPARISON_GT', 'thresholdValue': 0.01, 'duration': '300s', 'trigger': {'count': 1}}},
           'Server errors exceed 1% for five minutes among valid routed requests. Compare revision and dependency health; consider rollback. Low traffic can make this ratio noisy.')
    for name, metric_name, threshold, extra in [('API p95 latency', 'http_latency_ms', 2000, ''),
                                               ('form notification p95 acceptance', 'delivery_acceptance_age_ms', 30000, ' metric.labels.kind="form"'),
                                               ('SMS notification p95 acceptance', 'delivery_acceptance_age_ms', 120000, ' metric.labels.kind="sms"')]:
        policy(name, {'conditionThreshold': {'filter': metric_filter(metric_name) + extra, 'comparison': 'COMPARISON_GT', 'thresholdValue': threshold,
               'duration': '300s', 'aggregations': aggregation('ALIGN_PERCENTILE_95', 'REDUCE_MAX'), 'trigger': {'count': 1}}},
               'Latency target exceeded. Provider acceptance is not device display, opening or user approval. Check backlog, cold starts and provider failures.')
    budget = {'displayName': f'SMS relay {project}: monthly budget',
              'budgetFilter': {'projects': [f'projects/{number}'], 'calendarPeriod': 'MONTH'},
              'amount': {'specifiedAmount': {'currencyCode': 'USD', 'units': '100'}},
              'thresholdRules': [{'thresholdPercent': n, 'spendBasis': 'CURRENT_SPEND'} for n in [0.5, 0.8, 1.0]],
              'notificationsRule': {'monitoringNotificationChannels': channels, 'disableDefaultIamRecipients': False}}
    return {'project': project, 'project_number': str(number), 'service': service, 'billing_account': billing, 'metrics': metrics, 'policies': policies, 'budget': budget}


def api(token, method, url, body=None):
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(url, data=data, method=method, headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        # Avoid dumping provider response bodies or authorization material.
        raise RuntimeError(f'{method} {urllib.parse.urlsplit(url).path}: HTTP {error.code}') from None


def apply(config, account):
    token = subprocess.check_output(['gcloud', 'auth', 'print-access-token', '--account', account], text=True).strip()
    project = config['project']
    identity = api(token, 'GET', f'https://cloudresourcemanager.googleapis.com/v1/projects/{project}')
    billing = api(token, 'GET', f'https://cloudbilling.googleapis.com/v1/projects/{project}/billingInfo')
    if str(identity.get('projectNumber')) != config['project_number']:
        raise ValueError('Project number does not match selected project.')
    if not billing.get('billingEnabled') or billing.get('billingAccountName') != 'billingAccounts/' + config['billing_account']:
        raise ValueError('Selected billing account is not enabled and linked to this project.')
    for channel in config['policies'][0]['notificationChannels']:
        resource = api(token, 'GET', 'https://monitoring.googleapis.com/v3/' + channel)
        if resource.get('type') != 'email' or resource.get('verificationStatus') != 'VERIFIED' or resource.get('enabled') is not True:
            raise ValueError('Use enabled verified email channels; billing budget notification channels must be email.')
    logging = f'https://logging.googleapis.com/v2/projects/{project}/metrics'
    for metric in config['metrics']:
        # PUT is an upsert, so reruns do not create duplicate metrics.
        api(token, 'PUT', logging + '/' + urllib.parse.quote(metric['name'], safe=''), metric)
    monitoring = f'https://monitoring.googleapis.com/v3/projects/{project}/alertPolicies'
    existing = []
    page = monitoring
    while page:
        result = api(token, 'GET', page)
        existing.extend(result.get('alertPolicies', []))
        page = monitoring + '?pageToken=' + urllib.parse.quote(result['nextPageToken'], safe='') if result.get('nextPageToken') else None
    for policy in config['policies']:
        matches = [p for p in existing if p['displayName'] == policy['displayName']]
        if len(matches) > 1:
            raise ValueError('Duplicate alert display names require operator reconciliation.')
        if matches:
            api(token, 'PATCH', 'https://monitoring.googleapis.com/v3/' + matches[0]['name'] + '?updateMask=displayName,combiner,enabled,notificationChannels,conditions,documentation,alertStrategy', policy)
        else:
            api(token, 'POST', monitoring, policy)
    budgets = f'https://billingbudgets.googleapis.com/v1/billingAccounts/{config["billing_account"]}/budgets'
    existing = []
    page = budgets
    while page:
        result = api(token, 'GET', page)
        existing.extend(result.get('budgets', []))
        page = budgets + '?pageToken=' + urllib.parse.quote(result['nextPageToken'], safe='') if result.get('nextPageToken') else None
    matches = [b for b in existing if b['displayName'] == config['budget']['displayName']]
    if len(matches) > 1:
        raise ValueError('Duplicate budget display names require operator reconciliation.')
    if matches:
        body = {**config['budget'], 'name': matches[0]['name'], 'etag': matches[0]['etag']}
        api(token, 'PATCH', 'https://billingbudgets.googleapis.com/v1/' + body['name'] + '?updateMask=displayName,budgetFilter,amount,thresholdRules,notificationsRule', body)
    else:
        api(token, 'POST', budgets, config['budget'])
    print('Monitoring resources applied. Live alert and recovery drills are still required.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', required=True)
    parser.add_argument('--project-number', required=True)
    parser.add_argument('--service', default='sms-code-relay')
    parser.add_argument('--billing-account', required=True)
    parser.add_argument('--channel', action='append', required=True, help='Verified email channel resource; repeat for multiple channels.')
    parser.add_argument('--account', help='Explicit gcloud account, mandatory with --apply.')
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    if not re.fullmatch(r'[a-z][a-z0-9-]{4,28}[a-z0-9]', args.project) or not re.fullmatch(r'[0-9]+', args.project_number):
        parser.error('Invalid project ID or project number.')
    if not re.fullmatch(r'[a-z][a-z0-9-]{0,62}', args.service) or not re.fullmatch(r'[A-Z0-9]{6}-[A-Z0-9]{6}-[A-Z0-9]{6}', args.billing_account):
        parser.error('Invalid service or billing account.')
    if len(args.channel) > 5:
        parser.error('Billing supports at most five email channels.')
    if any(not re.fullmatch(r'projects/' + re.escape(args.project) + r'/notificationChannels/[0-9]+', channel) for channel in args.channel):
        parser.error('Each channel must belong to the selected project.')
    if args.apply and not args.account:
        parser.error('--apply requires an explicit --account.')
    config = resources(args.project, args.service, args.channel, args.project_number, args.billing_account)
    if args.apply:
        apply(config, args.account)
    else:
        print(json.dumps(config, indent=2))


if __name__ == '__main__':
    main()
