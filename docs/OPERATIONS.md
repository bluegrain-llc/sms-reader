# Production operations

The service keeps scale-to-zero hosting. The operator receives alerts and owns recovery; there is no 24/7 response promise. Production readiness requires the staging drills below. Checked-in policies and local tests are not evidence that alerts have been installed or delivered.

## Signals and targets

Application telemetry emits fixed-schema JSON with `component: relay`. It never emits raw errors, request URLs, query strings, headers, credentials, owner/device/request IDs, caller text, answers, SMS content or webhook addresses. HTTP logs contain registered route templates and coarse status classes. Unknown paths become `unmatched`. Provider failures map to quota, timeout, destination, rejected, unavailable or internal; unknown SDK details remain internal. Existing Cloud Run infrastructure request logs have their own retention and may contain paths; do not pass credentials in URLs, and do not enable payload/APM capture.

| Signal | Target / alert | Interpretation |
| --- | --- | --- |
| Valid routed HTTP availability | Internal target 99.5% over 30 days; alert on server-error ratio >1% for 5 minutes | Excludes expected 4xx, health, internal jobs, unmatched paths and SSE. Low-volume ratio alerts can be noisy. |
| Warm API latency | p95 <2 seconds; alert after any revision p95 stays above target for 5 minutes | The alert uses maximum revision p95, not fleet p95; even a low-traffic canary can alert. Application timing excludes platform cold-start time. Cloud Run request latency supplies that separate view. |
| Maintenance completion | Completion every minute; absence for 3 minutes | Bootstrap a successful completion after provisioning. An absence alert cannot establish initial installation health without a series. Allow additional Monitoring ingestion/notification delay. |
| Due delivery | Oldest due job <=3 minutes | Samples after cleanup/maintenance; does not promise notification display. |
| Sensitive-result cleanup | Nothing remains >5 minutes past purge deadline | API retrieval deadlines remain strict even when physical deletion is delayed. |
| Deletion backlog | No due deletion job >5 minutes overdue | Pending/running jobs use `nextAt`; completed jobs must move `nextAt` beyond current time. |
| Provider acceptance | v2 notification p95 <30 seconds; SMS p95 <120 seconds | Age is measured from request creation at each accepted attempt, including queue wait; this target includes queueing. Alert aggregation uses maximum revision p95, deliberately stricter than fleet p95 during rollouts. FCM acceptance proves neither delivery, display nor owner action. |
| Worker/tool failures | Any maintenance, sampling, task-wakeup or unexpected MCP tool failure | Wakeup failure is recoverable through Scheduler but should remain visible. |
| Production budget | USD 100/month; email at 50/80/100% actual spend | Alerts-only budget; no automatic billing/service shutdown. Cost projection and capacity acceptance belong to the load/recovery gate. |

`sms_relay/SERVICE/http_requests`, `http_latency_ms`, `delivery_attempts`, `delivery_acceptance_age_ms`, `backlog_depth` and `backlog_oldest_due_age_s` are log-based metrics. Backlog depth/age are distributions of minute samples, not instantaneous gauges. Chart count/maximum/percentiles with that sampling interval. Delivery attempts include retries; they are not unique delivered notifications. `delivery_attempts` labels distinguish SMS, forms and webhooks, accepted/failed and bounded failure category. Failed callbacks and duplicate accepted transports remain part of the delivery contract. MCP tool errors can use HTTP 200; unexpected tool failures therefore emit a separate `mcp_tool_failed` event and trigger the worker/tool failure policy rather than relying on the HTTP status ratio.

Backlog collection reads aggregate counts and one oldest due document for each existing SMS status, v2 outbox, sensitive-result collection and deletion tracking. The account-delete route commits a tombstone and `deletionJobs` record before acknowledging. Workers resume bounded cleanup and identity removal through both Tasks and Scheduler. Each invocation adopts up to 100 temporary legacy `deletionAttempts` markers into durable jobs atomically; only markers with a proven legacy completion flag are cleared without another job. Attempts made before this instrumentation have no marker and require manual reconciliation. No payload is logged. A v2 outbox sample includes webhook and form notification jobs and therefore uses the `form` queue label; attempt labels distinguish transport. `nextAt` measures how long work is overdue, not time since original creation. A job in backoff is not due; its failed attempts still appear in delivery metrics. Backlog sampling failure emits a separate error and does not undo successful maintenance or suppress its completion signal.

## Provision alerts and budget

Enable Logging, Monitoring and Billing Budgets APIs in the explicitly selected project. Use an operator identity with log-metric, alert-policy and budget administration permissions. Application runtime needs no new monitoring/billing role: Cloud Run collects stdout. Keep the ordinary runtime least-privilege role set.

Create, enable and verify an email notification channel first. The script checks it belongs to the selected project and is enabled and verified. The billing account must actually be linked to that project. Set these public resource identifiers in a private operator environment:

```sh
python3 scripts/monitoring/provision.py \
  --project "$PROJECT_ID" --project-number "$PROJECT_NUMBER" \
  --service sms-code-relay --billing-account "$BILLING_ACCOUNT_ID" \
  --channel "$NOTIFICATION_CHANNEL" > /tmp/sms-monitoring-plan.json
```

Default behavior only renders resources. Inspect the project filter, recipient, metric filters, policy thresholds and project-scoped USD 100 budget. Apply the same inputs with `--apply --account "$OPERATOR_ACCOUNT"`. The script uses a short-lived gcloud token in memory, never command arguments or output. It upserts metrics, reconciles policies and budgets by exact display name, and refuses duplicate matches rather than creating another copy. Partial API failure may leave earlier resources installed; rerun the unchanged command after reconciliation. Do not rename the service/display names casually: different names intentionally identify different resource sets. Existing email channels are not created or modified.

Verify the deployment emits all required events, then invoke authenticated maintenance once. Wait for metric ingestion and inspect the resulting time series and policy notification routing. Record policy resource IDs, sanitized incident IDs, test times and actual recovery times privately. Do not declare this issue complete until alert delivery and recovery drills pass.

## Incident runbooks

For every alert, record UTC time, selected project/service/revision, bounded event category and incident ID. Use an explicit `--project` and `--account` on cloud operations. Never copy SMS codes, answers, bearer tokens, user-facing form bodies or provider exception dumps into issues.

**Maintenance missing or delivery stalled:** check service health, Scheduler last attempt and OIDC audience/email, worker failures and Firestore index readiness. Invoke authenticated maintenance through the configured Scheduler identity. Repair IAM/index/configuration errors, then verify a completion, decreasing overdue backlog and fresh device notification. Preserve durable jobs and original deadlines. Do not mark FCM acceptance as phone reception. Failed per-attempt provider categories differentiate quota, unreachable providers and invalid FCM destinations; quota/unavailability calls for bounded retry, while a destination failure needs phone token refresh/registration.

**Expired results or deletion backlog:** verify API reads already reject expired/revoked credentials. Inspect only metadata counts/timestamps, repair worker access, and rerun maintenance. Confirm sensitive result rows disappear. Maintenance resumes due `deletionJobs`, including expired worker leases, and adopts temporary legacy attempts. Inspect `nextAt`, `leaseUntil`, `collectionIndex` and status; confirm retries complete after access is restored. Keep legacy markers until the migration transaction has committed. Automatic recovery has emulator coverage; its staging recovery acceptance gate remains open until exercised in the deployed environment. Do not extend result retention or remove deletion tombstones to clear an alert. If backlog sampling itself failed, fix the query/index/IAM issue before trusting a zero/absent backlog chart.

**API errors or latency:** compare the onset with the active revision and dependency/quota signals. Check finite error categories and instance/concurrency saturation. Roll back to the previous tested, schema-compatible image through the staged deployment procedure. Verify authenticated API/MCP smoke tests and backlog drainage after rollback; health alone is insufficient. Do not downgrade across an incompatible data-model migration.

**Compromised caller credential:** owner revokes that connection in Administration. Confirm both pending operations and result access are blocked; revoke interactive permission separately only when SMS access should remain. Rotate the caller credential by fresh pairing, and rotate affected webhook secrets by removing/re-registering the webhook. Do not distribute a replacement secret in issue comments. Inspect only status metadata for unexpected activity. Compromised cloud identity/signing material requires disabling the affected identity and following provider recovery guidance before restoring service.

**Database unavailable:** keep requests failing closed. Restore provider access or execute the validated disaster-recovery procedure. Never re-open traffic against a snapshot before independent deletion/revocation records have been applied. Preserve strict expiry checks. Backup/restore acceptance is tracked separately; this runbook does not claim a restore drill passed.

**Budget threshold:** inspect per-service spend and the active-stream/Firestore-read profile. Stop unused staging/load resources and investigate abuse or runaway listeners. Preserve user deletion and revocation paths. Alerts do not cap charges; make any capacity reduction or temporary traffic restriction explicitly and record its service impact. Do not disable project billing as an automated reaction.

## Staging drills and acceptance evidence

Use a separate staging project and disposable identities only. Keep the production project unchanged. Run tests in this order, restore each injected fault in a `finally`/cleanup step, and keep the fixture alive only until the observed state is recorded:

1. Install policies on staging, verify email channel, run successful maintenance and wait until the completion metric exists.
2. Pause the staging Scheduler job. Wait for the three-minute absence condition plus ingestion/notification delay. Record actual alert delivery; resume Scheduler and confirm completion/recovery. Set a ten-minute local drill deadline and always resume the job on timeout.
3. Inject a provider failure using a staging-only fake receiver returning non-2xx or unavailable callback endpoint. Confirm a failed webhook attempt, bounded category and eventual retry success after restoring it. Do not use private/internal callback destinations to bypass the SSRF guard.
4. Seed disposable due delivery/deletion metadata older than thresholds and more expired result documents than one cleanup batch. Invoke maintenance and verify remaining backlog snapshots trigger the correct policies. Drain and remove fixtures afterward; no real SMS or answer values are needed. A fixture deleted in the same maintenance run correctly does not produce a persistent-backlog alert.
5. Exercise a staging revision that fails maintenance for the immediate worker-failure policy. Separately generate a bounded stream of synthetic routed API failures above 1% in every 60-second alignment window for at least six minutes to satisfy the five-minute retest period. Set a ten-minute local deadline, account for ingestion delay, and always stop the generator and restore the staging revision in cleanup. Verify both distinct policies actually deliver alerts, then return to the tested revision and verify authenticated smoke tests. Do not add an unauthenticated failure endpoint to production.
6. Complete the rollback and database-recovery drills owned by their respective release gates. Confirm notifications indicate resolution and compare observed recovery time with target.

Keep a private evidence table with case, start/end UTC, project/revision, injected failure, expected signal, actual metric/incident ID, email receipt time, recovery, cleanup and pass/fail. Local unit/emulator tests only verify instrumentation and resource generation. Live drill results are currently pending.

API references: [log-based metrics](https://docs.cloud.google.com/logging/docs/reference/v2/rest/v2/projects.metrics), [alert policies](https://docs.cloud.google.com/monitoring/api/ref_v3/rest/v3/projects.alertPolicies), [budget resources](https://docs.cloud.google.com/billing/docs/reference/budget/rest/v1/billingAccounts.budgets).
