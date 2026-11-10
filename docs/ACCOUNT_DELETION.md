# Account deletion and access limits

`DELETE /v1/account` accepts a Firebase Google ID token authenticated within five minutes. It atomically tombstones the account and creates a durable job before returning HTTP 202:

```json
{"ok":true,"status":"pending","receipt":"smsd_…","receiptExpiresAt":1800000000000}
```

The receipt is a random 256-bit secret, returned only in the response. Only its SHA-256 digest is stored. `GET /v1/account-deletion` uses `Authorization: Bearer smsd_…` and returns `{"status":"pending"}`, `running`, or `completed`. Receipts expire after 24 hours independently of deletion cleanup; they authorize no account or result operations. Keep them in memory and out of URLs, logs and telemetry. Repeating deletion for the same owner returns a new receipt for the same job. An expired owner session must reauthenticate first.

Workers process at most 100 documents per transaction. Each job has a one-minute lease, per-collection progress, and a scheduled retry time. A worker killed between batches loses its lease; another worker continues after expiry. Already absent records and Firebase `auth/user-not-found` are successful cleanup. Identity deletion happens after all application collections. Both authenticated `/internal/delivery` and `/internal/maintenance` drain jobs; a failed Cloud Tasks wakeup leaves scheduled recovery intact. A dispatch round has a 40-second wall-clock admission budget, with up to ten jobs per round and forty rounds. Individual provider/database operations still depend on SDK deadlines.

The account tombstone remains after cleanup to prevent stale installation access. Completed deletion-job metadata expires after seven days; status receipt hashes expire after 24 hours. Pending jobs have no TTL. The maintenance worker deletes expired job/receipt records; Firestore TTL policies provide a backstop. Data already delivered to an authorized caller cannot be recalled.

## Web and Android

Android confirms deletion, asks Google to reauthenticate the same Firebase account, refreshes the ID token, then requests deletion and clears local installation/session state after acceptance. Choosing a different account cannot delete the existing owner. Account access is blocked immediately while cleanup continues.

The public `/account/delete` page offers the same flow without an installed app. Sign-in and receipts stay in page memory. `/privacy` explains current processing and retention. The pages have no analytics, use native accessible controls, prevent framing and disable referrer transmission. The deletion page uses pinned Firebase browser modules from Google's CDN and a per-response script nonce; OAuth opens a popup. No form answers are loaded on this page.

Configure `FIREBASE_WEB_CONFIG` as JSON containing the public Firebase web app's `apiKey`, `authDomain`, `projectId`, and `appId`. The supported authDomain is `<projectId>.firebaseapp.com`. Add the canonical HTTPS service host to Firebase Authentication's authorized domains. Set `PRIVACY_CONTACT` to verified operator/contact text. These values are public configuration, not service-account credentials. Incomplete web configuration returns HTTP 503 rather than showing an unusable sign-in control. Publish final operator and backup disclosures before public distribution.

Only the exact canonical service origin may use the account endpoints by default. Other browser endpoints retain the configured explicit origin allowlist; no wildcard CORS behavior is added. Same-origin requests use bearer tokens, not ambient cookies. The receipt status route requires the receipt even when an owner is signed in.

## Distributed admission limits

Read endpoints enforce fixed one-minute windows: 120 reads per caller and 600 per owner, shared between instances in Firestore. Android owner reads and caller REST/MCP result/event reads count toward these windows. Existing request-creation and pairing quotas remain separate. Responses use HTTP 429 and `Retry-After: 60` when a window is exhausted.

SSE admission permits two streams per caller and four per owner, using transactional leases shared across instances. Streams last at most 100 seconds. Disconnect releases leases; process death is recovered by lease expiry after at most 110 seconds. Expired rate/lease documents are cleaned up by maintenance and TTL. Stream leases contain only random lease IDs and deadlines; scope IDs are hashed. Firestore direct-client access remains denied.

## Security review boundaries

- Firebase ID-token revocation checks and Google provider verification remain server-side. The account tombstone now also guards owner list endpoints and all HTTP owner operations other than repeat deletion.
- Direct pairing binds credentials to an owner only after explicit approval; its existing source/global creation and owner-decision quotas remain unchanged. Production trusts exactly the Cloud Run proxy hop; direct local apps default to zero trusted hops. Do not add proxy hops without verifying the ingress chain.
- Existing webhook validation rejects non-public destinations at registration and delivery, pins validated DNS addresses, validates TLS and refuses redirects. This change does not widen that boundary.
- Device registration retains the server's paused state when refreshing an FCM token; unregistered installation IDs remain unusable. Caller and owner data boundaries are unchanged.
- Runtime IAM still needs Firestore access, Firebase user get/delete operations and FCM send. Separate build/scheduler identities and keyless credentials remain required. The deployment's broader built-in Firebase Auth admin role remains an operational least-privilege follow-up until a narrower custom role is provisioned.
- Independent backup/revocation-ledger recovery is tracked separately. No backup or disaster-recovery guarantees are established by this change alone.

## Acceptance evidence

Automated integration tests cover tombstone timing, lost-lease recovery, bounded batches, transient identity failures, already-deleted identities, receipt hashing/expiry, cross-instance quotas, stream admission/release, stale owner sessions and browser origins. They use Firestore/Auth emulators and synthetic credentials.

Live Cloud Tasks/IAM/Scheduler recovery, web Google popup sign-in, physical Android reauthentication, and verified public operator disclosures remain release gates until recorded against a deployed release. Automated fixture results do not establish those live outcomes.
