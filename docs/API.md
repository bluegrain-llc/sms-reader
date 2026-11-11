# API and lifecycle

## Interactive requests

The additive `/v2` interface supports native forms and multi-step wizards, separate opening observations, authenticated answer retrieval, event polling/SSE and signed webhooks. See the [v2 API and delivery contract](REQUEST_INBOX.md). Wizard definitions use `steps` with field IDs and optional predicates on earlier answers; Android advertises `wizardVersion: 1` during device registration. Existing routes and SMS tools below preserve the legacy compatibility path.


Production uses HTTPS with `Cache-Control: no-store`. JSON bodies are limited to 256 KiB. Errors contain only `{ "error": "machine_readable_reason" }`. Owner Firebase sessions and individual caller credentials have separate authority.

## Connect an app or bot to a user

The Android app's **Admin** area manages connections directly. No external manager, master credential, or copying secrets on the phone is needed.

1. The bot calls unauthenticated `POST /v1/connections` with `{callerName,purpose,expiresInDays?:1..90}`. Default access duration is 30 days.
2. It securely saves the returned private `connectionToken` and shows the user `verificationUri` and `userCode`.
3. The user opens the link on their phone. A verified HTTPS App Link opens **Admin → Access**. A browser fallback opens the custom app link, or the user enters the comparison code manually.
4. Admin fetches the named app, purpose, duration, and code using the user's Google/Firebase session. The owner explicitly approves or declines. Names/purposes are supplied by the requesting bot; they are not verified publisher identities.
5. The bot polls `POST /v1/connections/poll` with `Authorization: Bearer <connectionToken>` every five seconds. Approval activates this same private credential for that one owner's account. It can then use the three REST/MCP SMS operations below.

Creation returns HTTP 201:

```json
{"connectionToken":"smsr_PRIVATE_VALUE","userCode":"ABCDE-FG234","verificationUri":"https://SERVICE/connect?code=ABCDE-FG234","expiresAt":1800000600000,"interval":5}
```

The private value never appears in the URL, phone UI, or server storage. Its SHA-256 digest identifies the pending connection and eventual grant. Before approval it is unusable with SMS/MCP endpoints. The public comparison code is ten random characters (50 bits), grouped for reading; pending approval expires after ten minutes. The owner account is selected by the authenticated approval, not by a bot-supplied account or phone ID.

Poll returns `{status,expiresAt,grantExpiresAt,interval}`. Status is `pending`, `approved`, `denied`, `expired`, or `revoked`. Polls before the returned interval receive HTTP 429 `slow_down`; increase the interval by five seconds. Approved access expires at `grantExpiresAt` (Unix milliseconds). Pending expiry cannot be extended/revived. Concurrent account approvals have one owner/grant winner. Duplicate approval by that owner is idempotent; another owner cannot inspect the decided connection. Revocation blocks use and result retrieval immediately.

Store a separate credential for every **user × app/bot connection** in a private credential vault. An app serving Alice and Bob has two credentials. Preserve pending credentials before showing links; after a network/process interruption, resume polling with the saved credential. A lost credential cannot be recovered from the hash-only server; start a new connection and revoke any old approved grant in Admin. Never log credential-bearing responses.

Creation is limited to 60 per network source and 600 globally per ten-minute window. Production trusts one Cloud Run ingress proxy hop for source limiting; the global limit also applies. Owner review/decision attempts, including valid-format wrong-code guesses, are limited to 30 per owner per ten-minute window. These are private-pilot defaults. There is no unauthenticated account-directory lookup or connection-notification spam to arbitrary users.

See [connection helper and CLI](../examples/connect.mjs). The helper gives the integration callbacks for saving a credential and showing its link. For a CLI pilot:

```sh
RELAY_URL=https://SERVICE CALLER_NAME='Invoice bot' \
  RELAY_CREDENTIAL_FILE=/private/new-invoice-bot.json node examples/connect.mjs
```

It prints only the link/comparison code and stores the credential in a new mode-0600 file. It refuses to overwrite existing credentials. The credential can subsequently be configured as the bot's REST/MCP bearer token. This is a direct pairing protocol inspired by device authorization, not a full OAuth authorization server or automatic MCP OAuth discovery.

## Caller REST and MCP

| REST | MCP tool | Input |
| --- | --- | --- |
| `POST /v1/requests` | `request_sms_code` | `purpose` (Markdown, 1–4,000 chars), optional `title` (1–80 chars), optional `senderPhone` (E.164), `idempotencyKey` (8–128 chars) |
| `GET /v1/requests/:requestId` | `get_sms_code_request` | `requestId` |
| `POST /v1/requests/:requestId/cancel` | `cancel_sms_code_request` | `requestId` |

Use `Authorization: Bearer <approved-caller-token>` on every call. The token determines owner and caller identity. Callers cannot choose another owner or phone, register devices, approve connections, or upload results. Only the originating credential can retrieve its own requests, including after a replacement connection is approved.

The phone header is **caller name — title**. Caller name comes from the server-side credential grant; `title` comes from the request and defaults to “Verification code”. `purpose` is the Markdown message rendered underneath. Integrations read their `.md` file and pass its UTF-8 contents as `purpose`; the server never reads a caller-local path or fetches a file URL. Headings, emphasis, lists, quotes and code blocks render as native text. HTML is inert; links/images do not initiate navigation or remote fetches. These fields are retained as request metadata, so never put an SMS message or code in them. Title changes affect idempotency; requests without a title retain the original idempotency fingerprint format.

The focused request screen has an editable SMS code field and an explicit **Send** button. Android approval automatically submits a single extracted code; multiple candidates require choosing the code to send. Declining Android message access leaves manual entry available with Send. Automatic submission rechecks request binding and the approved candidate after any in-flight refresh, and stops if cancellation or editing invalidated it. Codes and drafts stay in ViewModel memory and clear on completion, cancellation, expiry or process death.

Creation returns HTTP 201 with `{requestId,status,reason,expiresAt,listeningDeadline,resultExpiresAt}`. An approved result adds `code` only while `completed` and before its exact two-minute result deadline. All times are Unix milliseconds. MCP returns JSON in text and structured content; tool errors set `isError:true` and include JSON error text.

One SMS request is active per owner. Up to 20 subsequent requests queue in transaction order, with the ten-minute lifetime including queue time. Activation snapshots all unpaused registered phones (up to 20 per account). If all phones remain in earlier Android listening windows, activation waits until one window ends. A minute-by-minute outbox sends generic notifications to each participating phone; failed deliveries retry independently without repeating successful phones.

Poll every two seconds through `queued` and `pending_phone`. Only after `ready` should a separate external system trigger the SMS. Neither relay nor Android app sends it. Each participating phone has its own five-minute listener and consent gate. First approved upload wins; other phones see “Handled on another phone” without the code. Registering multiple phones does not make the external sender deliver SMS to every phone.

Idempotency is scoped to the caller credential for seven days. Same key/payload returns the original request without added quota/delivery. Changed payload returns 409 `idempotency_conflict`. New SMS requests are limited to three per caller and five per owner per ten-minute fixed window, including queued/cancelled requests.

`queued → pending_phone → ready → awaiting_consent → completed` for Android-assisted filling. Manual entry can complete directly from `ready` after explicit Send. `denied`, `cancelled`, `expired`, `failed` are terminal. Stop/decline/pause/remove on one phone leaves the others available. Caller cancellation affects the entire request. Same winning-phone/code retries succeed; conflicting uploads return 409 `upload_conflict`. Cancellation/completion races have one winner. To block a completed result immediately, revoke the credential.

MCP uses stateless Streamable HTTP at `POST /mcp` with the bearer header on every request; GET/DELETE return 405. Configured browser origins only; native callers send no Origin. MCP never carries the owner Google session.

## Owner and phone APIs

Authenticate with a Google-sign-in Firebase ID token. Revocation/provider/ownership are verified.

| Method/path | Body/result |
| --- | --- |
| `POST /v1/connections/review` | `{userCode}` → named connection, purpose, expiry and status, never private credential |
| `POST /v1/connections/decision` | `{userCode,decision:"approved"\|"denied"}` → decision metadata, never private credential |
| `GET /v1/callers` | Caller metadata and effective revocation/expiry |
| `DELETE /v1/grants/:grantId` | Revoke one connection immediately |
| `GET /v1/devices` | Names, IDs, pause state, active SMS request ID; no FCM secrets |
| `PUT /v1/devices/:deviceId` | `{name,fcmToken}` → register/refresh installation |
| `PATCH /v1/devices/:deviceId` | `{paused:boolean}` → withdraw only this phone |
| `DELETE /v1/devices/:deviceId` | Tombstone this phone; other phones/credentials remain |
| `GET /v1/history` | Latest 30 account SMS outcomes within seven days; no codes/messages/purposes |
| `DELETE /v1/account` | Recent sign-in within five minutes; delete owned devices, connections, grants, requests/results/audits and identity |

Legacy manual-grant/history routes under `/v1/devices/:deviceId` remain for the existing pilot. Retired manager creation/provisioning routes return 404, and previously manager-issued credentials cannot authorize requests. Ordinary existing pilot caller credentials remain valid.

Phone endpoints require the owner's session and a participating installation:

- `GET /v1/devices/:deviceId/requests/:requestId`: local phase/global final status, caller, purpose, sender; never result code.
- `POST .../events`: `{status:"ready",listenerStartedAt:unixMs}`, `{status:"awaiting_consent"}`, `{status:"completed",code:"A1B234",source?:"android_consent"|"manual"}`, `{status:"denied"}`, `{status:"cancelled"}`, or `{status:"failed",reason:approvedPhoneReason}`.

Readiness requires a recent listener start. Android-assisted completion (the default `source`) requires that phone's own consent phase and unexpired listening deadline. Explicit manual Send uses `source:manual` and requires that participating phone to be `ready` or `awaiting_consent`, with an unexpired listening deadline. Agent credentials cannot submit either kind of result. Codes are 4–10 ASCII alphanumeric characters with a digit. Unknown fields/arbitrary failure reasons are rejected. Owner identity is not cryptographic proof of Android consent; see [security](SECURITY.md).

## Links and maintenance

`GET /connect?code=…` is a public, script-free app-opening fallback without credentials. `GET /.well-known/assetlinks.json` publishes the Android package/signing certificate for verified App Links; configure the public `ANDROID_SIGNING_SHA256` colon-separated certificate fingerprint. Android uses the configured relay host; unsupported link hosts/paths and malformed/duplicate code parameters are rejected locally.

`POST /internal/maintenance` accepts only the configured scheduler OIDC identity/audience. It promotes/expires SMS work, retries per-phone FCM, and cleans expired results and metadata. Connections retain seven days; comparison-code/rate records expire after their short windows. Firestore TTL is an asynchronous backstop; authorization expiry is immediate.

Android v0.4.1 closes its task after server-confirmed submission on this phone. It does not close for another phone’s winning result or failed uploads.


## Resumable account deletion

`DELETE /v1/account` returns HTTP 202 after a durable account tombstone/job is committed, with `{ok:true,status,receipt,receiptExpiresAt}`. It requires Google authentication within five minutes. The opaque receipt authorizes only `GET /v1/account-deletion` through its Bearer header for 24 hours. Status is `pending`, `running` or `completed`. Existing Android clients accept the successful 2xx response and sign out. Workers and Scheduler continue cleanup across crashes. See [complete deletion and rate-limit contract](ACCOUNT_DELETION.md). Read routes may return HTTP 429 with `Retry-After: 60`; creation quotas retain their existing contracts.

## Version 3 onboarding

See the generated [OpenAPI contract](../contracts/onboarding.openapi.json) and [onboarding lifecycle](ONBOARDING.md). These additive interfaces separate `smsreg_` registration credentials, `smss_` service credentials and existing-format `smsr_` recipient credentials. New connection status uses nullable expiry and explicit capabilities. Existing `/v1` and `/v2` request contracts remain supported, with capability checks for new scoped grants.

## Hosted OAuth MCP

The public named-service MCP resource is `/mcp/services/{serviceId}`. Get its URL with `relay service hosted-link`. Its `WWW-Authenticate` challenge identifies `/.well-known/oauth-protected-resource/mcp/services/{serviceId}`; `/.well-known/oauth-authorization-server` describes the root issuer. Configure the private `OAUTH_CODE_KEY` before authorization.

`POST /oauth/register` accepts RFC 7591 metadata with HTTPS public redirect URIs and `token_endpoint_auth_method` of `none` or `client_secret_post`. `GET /oauth/authorize` requires `response_type=code`, `client_id`, the exact `redirect_uri`, exact named MCP `resource`, `scope` (`forms`, `sms`, or both), `code_challenge`, and `code_challenge_method=S256`; `state` is preserved. It redirects to focused consent without granting access. HTTPS Client ID Metadata Documents are also supported.

Owner-authenticated `/v3/oauth/sessions/{id}` reviews the immutable attempt; `POST .../decision` accepts the same capabilities/duration decision as pairing; `POST .../response` issues or resumes the one-minute code for an already decided authorization, so time spent connecting a phone does not consume its code lifetime. No opposite-party email or Firebase identity is exposed. The browser and Android approval screen remain separate from Inbox work.

`POST /oauth/token` accepts form encoding. Code exchange requires `grant_type=authorization_code`, `code`, `code_verifier`, `client_id`, `redirect_uri` and `resource`. Refresh requires `grant_type=refresh_token`, `refresh_token`, `client_id` and `resource`; optional `scope` can only narrow the grant. Confidential clients also supply `client_secret`. Access tokens expire after ten minutes or earlier grant expiry; refresh tokens rotate and last until grant expiry/disconnection. Replays revoke the family. `POST /oauth/revoke` accepts client authentication and `token`, revokes its family and ignores unknown tokens.

OAuth access credentials work only on the exact named MCP resource, with tools and results checked against current connection capabilities and service/account state. They cannot authorize REST calls, `/mcp`, service management or owner operations, including on revisions without `SERVICE_URL`. Named-resource tool descriptors include OAuth security schemes for their required scopes. A valid individual `tools/call` whose credential check fails with 401 returns an MCP error result with `_meta["mcp/www_authenticate"]` so the host can start linking; unauthorized discovery retains HTTP 401 and its resource-metadata challenge. Direct bearer tools at `/mcp` do not advertise OAuth. Hosted connections do not need a software process to consume an encrypted delivery. OAuth uses a separate client binding under the same recipient/service grant lifecycle.
