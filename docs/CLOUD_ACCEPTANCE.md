# Staging cloud acceptance

This release gate exercises real Cloud Run, Firebase Google authentication,
Firestore queries/retention, MCP, FCM provider acceptance, and public HTTPS
callbacks. The harness never triggers an SMS or represents an authenticated manual
API submission as Android consent. Physical acceptance remains in [PILOT.md](PILOT.md).

The acceptance runner is intentionally destructive to one explicitly named,
disposable staging owner: it creates two installation records and caller grants,
then deletes that owner's data and Firebase identity. Use a dedicated Google test
identity with no personal records. No production project is accepted.

## Prerequisites

1. Finish the tested-artifact deployment work in issue #7, security/deletion in
   issue #9 and capacity changes in issue #10. Bootstrap a separate Firebase
   staging project, not a second service sharing production Firestore/Auth.
   Give both the project and relay Cloud Run service the label
   `environment=staging`; use a project ID containing `staging` or `-stg`.
2. Explicitly select project, region and cloud account for every provisioning
   command. Set an alerts-only budget for the disposable project before tests.
   The harness records a positive configured `budgetUsd` no greater than 100;
   it does not create or enforce a billing cap. Keep staging/test charges separate
   from the $100 monthly production projection.
3. Use the production-equivalent deployment manifest values `projectId`,
   `region`, `service`, `serviceUrl`, `revision`, `image`, `commit`,
   `schedulerEmail`, and `deliveryQueue`. The service must have one named
   100%-traffic revision and a zero-traffic tag targeting another compatible
   revision for replay. Set `replayUrl` to that tag's URL. The runner checks this
   association and reads the actual active/tagged revision environments before
   forwarding caller credentials; a newer no-traffic template cannot satisfy
   these guards for an older serving revision.
   Both relay revisions must configure an HTTP startup probe on `/startup`, port
   8080. This endpoint returns 503 until the recovery control watch authoritatively
   permits serving, then 200. `/health` and `/healthz` remain liveness checks and
   do not establish readiness. The deployment script sets a two-second probe
   period, one-second timeout and 60 failed attempts before startup is rejected.
   Preflight rejects missing, TCP, wrong-path and wrong-port relay startup probes;
   the separate callback receiver is excluded because it runs another server.
   Cloud Run can route requests before its first readiness probe, so the startup
   probe itself must establish readiness. See [Cloud Run health checks](https://docs.cloud.google.com/run/docs/configuring/healthchecks).
   Expected `/startup` failures are excluded from user-traffic error/latency
   metrics and canary error checks. Other API failures remain included. Reapply
   the monitoring configuration when upgrading an existing deployment.
   Both relay revisions must use the canonical `SERVICE_URL`, the same
   `SCHEDULER_EMAIL` service account in the selected staging project, and the same
   `DELIVERY_QUEUE` in the selected staging project/region. Preflight inspects
   that configured queue rather than assuming its name. It requires the queue
   running and the maintenance Scheduler enabled, with POST, matching canonical
   target/audience and that exact OIDC signer. These configuration checks do not
   establish successful authenticated task delivery or replace the live drills.
   Provision a separate staging security ledger using [the recovery runbook](recovery/README.md)
   and configure its bucket as `securityLedgerBucket`. The runtime's
   `SECURITY_LEDGER_BUCKET` must match it; the bucket name must contain `staging`
   or `-stg`. Its source manifest must name the staging relay project, with locked
   retention and runtime IAM as required by the runbook. Deletion and callback
   removal fail closed without this ledger. Never reuse a production ledger.
4. Sign the disposable owner into this staging Firebase project's Google provider.
   Save its Firebase ID token in a mode-0600 file. Configure that exact Firebase
   UID as `disposableOwnerUid`. There must be no devices or grants on the account
   before a run. JWT decoding is only an accident guard; deployed Firebase Auth
   verifies the signature and Google provider.
5. Supply two distinct real staging-installation FCM tokens in separate mode-0600 files.
   Their local bounds, whitespace and distinctness are checked before registration;
   provider validity is established by the later delivery scenario.
   These prove FCM provider acceptance, not physical display, owner recognition,
   carrier delivery or system consent. The runner creates unique installation
   IDs and submits synthetic manual values through authenticated owner APIs.
6. The selected cloud operator needs read access to staging `deliveryOutbox`,
   `logging.logEntries.list` on the staging project, and
   read/write access to the **disposable staging** `results` collection.
   The expiry check changes only its fixture's `purgeAt` to
   20 minutes ahead, leaving `expiresAt` unchanged. After 121 seconds it requires
   the expired document still exists with future `purgeAt` before checking API
   denial. A missing document fails the scenario; TTL cleanup alone cannot pass.
   Owner deletion removes the fixture even if a check fails. Do not grant these
   permissions to an API caller or production runtime for the test.
7. Google authentication must remain fresh for deletion. Reauthenticate the same
   disposable owner and update its private ID-token file while long callback
   checks run. Ordinary token refresh alone does not refresh `auth_time`.

The runner checks explicit account/project, ACTIVE staging label, service origin,
runtime project, absence of emulator configuration, billing, two phone inputs and
private token files before its first API mutation. Every cloud CLI call includes
the selected account/project; the global active configuration is never changed.

## Public callback probe

CI builds `scripts/cloud-acceptance/Dockerfile` from the repository root and
retains its tested image as `staging-callback-probe-container`. Load the archive
from the candidate commit, push it to staging Artifact Registry, resolve its
immutable digest, and deploy that digest as a separate public HTTPS Cloud Run service in the same
staging project. Use a dedicated service identity with Firestore access only in
staging. Set `GOOGLE_CLOUD_PROJECT`, label the service `environment=staging`,
and inject `CALLBACK_ADMIN_SECRET` from Secret Manager. Use a random 256-bit
admin secret; save the matching value in a mode-0600 operator file. Do not put it
in command arguments, URLs, images or source control.

Enable TTL on `acceptanceCallbacks.purgeAt`. The collection contains temporary
webhook signing secrets and sanitized event receipts; deny all direct client
access, keep it out of backup exports, and remove fixtures after each run. The
receiver rejects expired fixtures even before TTL removes them. Delete the
receiver and its temporary secret when the acceptance campaign ends.

The probe's `/admin/<run UUID>` routes require the admin secret in Authorization.
Each run registers a `/hooks/<run UUID>` destination and provisions its signing
secret over authenticated HTTPS before creating the synthetic request. Public
callback routes verify HMAC over the received byte buffer before JSON decoding,
timestamp tolerance, event
ID, and an allowlist excluding answers and owner/grant fields. Receipt counters
are transactional and survive receiver cold starts.

Two modes independently exercise a completed first-attempt 503 and an actual
11-second response withholding interval, longer than the relay's ten-second
outbound timeout. The timeout mode plans a 204, never a delayed rejection.
Cloud Run HTTP/1.1 does not propagate client disconnects to its container, so a
receiver-side close event cannot establish the sender's timeout. See
[Cloud Run troubleshooting](https://docs.cloud.google.com/run/docs/troubleshooting).

The timeout check requires independent sender evidence: its exact owned outbox
job must be observed with a first-attempt lease and then with that lease cleared
by failure. A bounded, projected query must show no other webhook jobs. The
harness requires exactly one real webhook delivery log in that revision and
attempt window, classified as a failed timeout before the receiver's measured
withholding interval ends. Missing transitions, unrelated jobs, ambiguous logs,
a delayed 204 alone or a completed 500 cannot pass. Keep the source staging
baseline exclusive; concurrent webhook work deliberately fails this gate.

Both modes also require a same-event signed retry with a completed 204 and
deletion of its exact sender outbox job while the request, event and registration
remain active. Each successful probe removes its owned hook before the next
request, and final owner cleanup still handles failed probes. Only allowlisted
counts, delay and sender-proof booleans survive in failed-check evidence before
the temporary collector is deleted. The receiver and harness use proof schema2;
an older receiver is rejected before creating a callback request. Deploy the
matching tested probe image when upgrading the harness. The probe does not proxy
destinations.

## Running the baseline

Copy `scripts/cloud-acceptance/config.example.json` outside the repository and
fill in explicit staging resources, private-file paths, disposable UID and test
budget. Install dependencies with `npm ci`.

```sh
node scripts/cloud-acceptance/run.mjs --config /private/staging.json --plan
node scripts/cloud-acceptance/run.mjs --config /private/staging.json \
  --evidence /private/new-cloud-acceptance.json
```

`--plan` validates configuration without reading credentials or contacting cloud
services. A baseline run checks infrastructure, paired versus unapproved callers,
authenticated MCP create/cancel, an independent valid caller's result isolation,
synthetic manual SMS API submission and two-minute expiry with a retained result
document, hidden wizard branch rejection, consistent winner identity across both
competing responses, losing/winning retries without overwrites, exactly one
terminal submission event, two FCM provider acceptances,
cross-revision Last-Event-ID replay with the exact ordered event types and JSON
metadata for the expected suffix,
callback retries, and receipt-based account
deletion. It never stores response values or callback secrets in evidence.

Cleanup runs on success and failure. It denies any known pending pairing before
owner deletion so its ownerless records become owned cleanup fixtures. An expired
pairing or uncertain creation response makes cleanup incomplete for operator
repair. Cleanup removes callback registrations/probe fixtures and requests
durable owner deletion with a recent token, then waits for
the read-only receipt to report completion and verifies the old owner session is
rejected. Failed cleanup is a failed run, requiring operator repair; do not discard
that evidence or rerun with a different owner to hide leftover fixtures.
SIGINT and SIGTERM abort active requests, cloud inspection and waits, then enter
the same cleanup path and write interrupted evidence with a failed exit status.
Cleanup keeps its own request deadlines after cancellation. SIGKILL, machine loss
or an unavailable provider can still require operator repair.

Output is a new mode-0600 JSON evidence file; an existing file is never overwritten.
Standard output contains only scenario counts and cleanup status. Exit 0 requires
every scenario passed; exit 1 means a failed scenario/cleanup/preflight; exit 2
means acceptance is incomplete. The baseline deliberately leaves the following
fault drills pending. Baseline success is not full issue #6 acceptance.

## Controlled fault drills

Run these only after the baseline passes its implemented scenarios. Use separate
disposable owners and explicitly pinned staging resources. Capture UTC start/end,
revision/image/commit, affected request/event/job IDs, observed HTTP statuses,
job attempts/leases and restoration. Never capture tokens, values, SMS bodies,
full environment dumps or arbitrary request bodies.

Every mutation must have a pre-recorded original configuration and a `finally`
restoration action. Never change global IAM, production roles or the default
gcloud project. Review the exact staging operation before executing it. These are
operator-assisted drills, not extra production fault-injection endpoints.

| Drill | Injection and required evidence | Restoration and pass condition |
| --- | --- | --- |
| Enqueue failure | Stage a compatible temporary revision whose `DELIVERY_QUEUE` names a nonexistent queue in the same staging project. Create a form and verify API acknowledgement plus durable outbox state despite failed enqueue. | Restore correct queue setting through guarded deployment. Leave the minute Scheduler enabled. Observe callback/FCM acceptance and outbox completion without manually invoking the worker. Record timestamps proving recovery within three minutes. |
| Worker termination | Start a slow callback, observe the claimed outbox lease, then terminate that serving worker using an explicitly controlled disposable runtime. Cloud Run traffic migration alone does not prove a worker was killed. If infrastructure cannot establish termination, keep this drill pending. | Restore a healthy worker; wait past the recorded lease and observe the same event delivered, with no replaced accepted answer. Record the termination source and recovered attempt. |
| Duplicate execution | Issue two simultaneous authenticated `/internal/delivery` calls using the dedicated staging scheduler identity while one fixture job is due. Ordinary owner/caller credentials must still fail. | Observe lease claims and one accepted result. Callback duplicates are allowed only with the same event ID; reconcile by sequence. No new idempotency key or duplicate answer may appear. |
| Provider outage | Temporarily remove only the staging runtime identity's FCM-send permission. Create a fixture and observe failed delivery retained for retry while API creation remains durable. | Restore the exact prior binding. Observe two-device provider acceptance without re-creating the request or charging creation quotas again. If FCM is allowed through another role, the injection is invalid and does not pass. |
| Storage outage | Remove only the dedicated staging runtime identity's Firestore access, after a request/event cursor exists. Observe safe API failure and SSE closure; no fabricated status/result. | Restore the exact prior binding. Reconnect with the saved cursor and verify durable replay/result isolation; pending work drains without manual data repair. Preserve the IAM audit evidence. |

Check the actual provider role grants first; a requested IAM edit is not evidence
that access was denied. Wait for observed denial before taking the failure
snapshot. Keep all unrelated permissions intact. Avoid removing operator access
or the worker's ability to restore its configuration.

Account deletion must also be exercised with interruption between batches, with
the public receipt still converging to `completed`. The security/deletion issue
owns batch correctness; this issue supplies real-service acceptance evidence.

## Acceptance record

Store each baseline JSON and fault-drill observation separately in private
artifacts. Publish only status/timing summaries. Keep issue #6 open until all
baseline checks and all five observed fault drills pass on the final image,
including real authenticated Cloud Tasks/Scheduler deliveries and Firestore
cleanup queries. A callback arriving eventually proves neither enqueue success
nor worker termination by itself.

No live staging pass, physical FCM display, carrier SMS acceptance, provider
outage or worker-termination result is established by the local harness tests.
