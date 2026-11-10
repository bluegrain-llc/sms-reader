# Rust migration compatibility and rollout

The current TypeScript source is the behavioral baseline. The Rust application lives alongside it in `server-rust/`. Android, collection names, credentials, indexes, retention policy and public service URL remain shared. Deployment defaults to TypeScript; selecting Rust defaults to a tagged revision with no traffic.

## Compatibility baseline

| Surface | Existing behavior to preserve |
| --- | --- |
| Common HTTP | 256 KiB JSON limit, strict object/array JSON parsing, no-store and nosniff headers, exact origin allowlist, one trusted proxy hop in Cloud Run |
| Public routes | `/health`, `/healthz`, `/connect`, `/privacy`, `/account/delete`, `/.well-known/assetlinks.json`, connection creation |
| Pairing | Ten-minute pending window, source/global creation quotas, owner lookup quota including invalid codes, five-second polling, owner approval creates the grant atomically |
| Owner v1 | Device registration/pause/removal, callers and per-device grants, history, request inspection/events, durable account deletion with sign-in newer than five minutes and receipt-based status |
| Caller v1 | SMS creation/status/cancellation; owner-wide serialized queue, per-phone consent, first accepted response wins, five-minute listener cooldown, two-minute code retention |
| Owner v2 | Inbox, form inspection/events/submissions, separate forms approval |
| Caller v2 | Forms and conditional wizards, results, cancellation, webhooks, event polling and SSE |
| MCP | Stateless POST `/mcp`, eight tools; negotiation for 2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05 and 2024-10-07; unknown versions select 2025-11-25 |
| Maintenance | Verified worker audience/email; SMS leases, form outbox leases, durable deletion jobs, callback retry and expiry cleanup, advisory Tasks wakeups plus Scheduler recovery |
| Access and monitoring | Shared owner/caller read budgets, distributed SSE leases, shared event watches, fair maintenance cursors, the independent denial ledger and recovery traffic guard, safe structured route/delivery/error logs and aggregated backlog metrics |

MCP tools: `request_sms_code`, `get_sms_code_request`, `cancel_sms_code_request`, `create_request`, `inspect_request`, `cancel_request`, `get_request_result`, `poll_request_events`.

Collections: `accounts`, `devices`, `grants`, legacy `managers` and `managerCallers`, `connections`, `connectionCodes`, `connectionRates`, `requests`, `results`, `audit`, `formRequests`, `formResults`, `requestEvents`, `deliveryOutbox`, `accessRates`, `streamLimits`, `deletionJobs`, `deletionReceipts`, legacy `deletionAttempts`, `maintenancePages` and `recoveryControl`. Numeric lifecycle times remain Unix milliseconds; `purgeAt` remains a Firestore timestamp. Account deletion retains its deleting tombstone and removes owner documents. Legacy manager credentials remain invalid.

Captured fixtures live in `server-rust/compat`. Unit tests cover normalized defaults, omitted/null values, Unicode, numeric object keys and floating-point formatting. The shared emulator suite exercises both implementations with injectable clocks and delivery adapters. Migration contracts pass active requests, pending connections, credentials, event cursors and claimed jobs between implementations. These tests do not substitute for real Google-signed tokens, IAM, FCM, Cloud Tasks or public TLS acceptance.

## Acceptance record

Local verification on 2026-11-10:

| Check | Result |
| --- | --- |
| TypeScript compilation and unit tests | Passed; 32 unit tests |
| Rust formatting, Clippy with warnings denied, unit tests | Passed; 35 tests |
| Shared emulator scenarios | Passed; 59 scenarios per backend selection; TypeScript-specific method-injection tests are named explicitly |
| Migration contracts | Both document directions, HTTP/MCP parity, durable deletion/read-limit/stream-lease handoff, raw JSON/clock lifecycle cases, UTF-16 edge cases, native worker telemetry and Firebase emulator checks; six additional native watch/denial-ledger/maintenance contracts passed |
| Dependency audits | npm production audit and Cargo audit passed |
| Rust production container | CI builds the current image and runs the HTTP/auth smoke; runtime UID 10001 |
| Deployment script | Shell syntax passed; cloud deployment not performed |

Production cutover and the observation window are separate release gates; these local checks do not establish either.

Before promoting a Rust revision:

1. Use a separate Firebase/GCP staging project with isolated credentials, phones and callback destinations. Deploy its indexes and confirm READY.
2. Verify real Google sign-in, JWT key rollover/cache expiry, disabled/deleted users and session revocation. Verify recent-sign-in deletion and its retries.
3. Verify worker OIDC audience, verified email and service-account identity; real FCM data/TTL/collapse keys; Tasks wakeups; and minute-by-minute Scheduler recovery.
4. Verify callbacks against public TLS endpoints, signatures over exact bytes, redirect refusal, DNS changes and private/reserved-address rejection. Exercise dead workers, duplicates and overlapping workers.
5. Verify Android registration, pairing, notification entry, SMS consent/manual submission, multi-phone races, forms and wizards without changing the APK.
6. Deploy Rust with `BACKEND=rust TRAFFIC_MODE=stage` to the existing production service. Use its tagged URL for health and authenticated contracts while preserving canonical `SERVICE_URL` as worker audience.
7. Record the old and candidate revision names, then move 100% of traffic to the accepted exact Rust revision using `gcloud run services update-traffic --to-revisions REVISION=100` with explicit project, service and region.
8. Monitor errors, maintenance completion, delivery backlog and expired-result cleanup. Roll back to the recorded TypeScript revision for a confirmed compatibility, authorization or delivery regression.
9. After seven successful days, remove the TypeScript runtime and change the default build. Keep Node emulator, contract and metadata-recovery tooling.

No database migration, credential rotation, Android release or retention change is required.
