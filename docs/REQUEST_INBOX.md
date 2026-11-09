# Interactive request inbox (v2)

Apps and agents can request information or a decision from their paired owner. Pairing, caller bearer credentials, Google sign-in, and SMS-only permissions remain compatible with v1. In **Settings → Access**, the owner must explicitly choose **Allow interactive requests** for each connection before it can use v2. Revoking form access cancels its pending forms while preserving SMS access. Revoking the connection blocks both.

General forms are independent pending items; they do not occupy the serialized SMS queue. The owner can answer in any order, leave a form pending with Back, or end it using a declared Decline action. Every form uses an immutable definition, an explicit action, and values keyed by field ID. The first valid phone submission wins. Another phone sees the accepted outcome without receiving the answers. Identical retries from the winning phone use the same submission ID; reusing that ID with changed contents returns a conflict.

## Sender REST

Use `Authorization: Bearer smsr_…` for these routes:

| Route | Purpose |
| --- | --- |
| `POST /v2/requests` | Create an immutable request, or replay its idempotency key |
| `GET /v2/requests/:id` | Inspect definition, outcome and earliest opening |
| `POST /v2/requests/:id/cancel` | End a pending request |
| `GET /v2/requests/:id/result` | Retrieve `{requestId, status, result: {action, values, submittedAt}}`, or `result: null` |
| `GET /v2/events?cursor=…` | Poll at most 100 durable events and the next cursor |
| `GET /v2/events/stream` | SSE stream; replay with `Last-Event-ID` or `cursor` |
| `POST /v2/webhooks` | Register an HTTPS destination and event subscriptions |
| `GET /v2/webhooks` | List destinations without signing secrets |
| `DELETE /v2/webhooks/:id` | Remove a destination and stop its queued deliveries |

Creation example:

```json
{
  "title": "Review invoice",
  "body": "## Business lunch\n\nPlease categorize and review the invoice.",
  "idempotencyKey": "invoice-2026-001",
  "expiresInSeconds": 86400,
  "fields": [
    {"id": "category", "type": "single_choice", "label": "Category", "required": true,
      "options": [{"id": "meals", "label": "Meals"}, {"id": "travel", "label": "Travel"}]},
    {"id": "comment", "type": "multiline", "label": "Comment", "maxLength": 2000}
  ],
  "actions": [
    {"id": "approve", "label": "Approve", "type": "approve"},
    {"id": "decline", "label": "Decline", "type": "decline"}
  ]
}
```

The default expiry is 24 hours; accepted values are 60 seconds through seven days. Titles allow 80 characters, Markdown bodies 16,000 characters, and definitions up to 30 fields and eight actions. Requests are limited to 256 KiB. IDs use letters, numbers, `_`, or `-`, up to 128 characters. Field and action IDs must be unique. Choice option IDs must be unique within their field.

Supported fields: `text` and `multiline` (`maxLength`, default 1000, maximum 4000), `number` (optional finite `min`/`max`), `checkbox`, `single_choice` and `multiple_choice` (`options: [{id,label}]`), and `date` (valid ISO `YYYY-MM-DD`). A required checkbox must be true. Multiple choices are an array of unique allowed IDs. A missing optional field is omitted. Actions are `submit`, `approve`, `decline`, or `acknowledge`; decline sends no field values and bypasses required-field checks. The server validates every submission against the stored definition.

Creation keys are connection-scoped. Replaying a key with a changed definition returns `409 idempotency_conflict`; the key is retained for the request's metadata lifetime. Answers remain retrievable for exactly 24 hours after submission. Outcomes, definitions, and events remain available for seven days after termination. API deadlines do not rely on asynchronous TTL deletion. Forms are limited to 100 pending per owner, 30 creations per caller and 100 per owner per ten-minute window. SMS retains its existing shorter deadlines and quotas.

## Owner REST and Android

Owner routes require a Firebase Google ID token and an owned registered device:

- `PUT /v2/grants/:grantId/forms` with `{"approved":true}` grants form access in Settings.
- `GET /v2/devices/:deviceId/inbox` lists pending request summaries, newest first; open a request to fetch its body and controls.
- `GET /v2/devices/:deviceId/requests/:requestId` fetches a definition without emitting an opening event.
- `POST …/events` reports a notification tap, foreground rendering, or SMS helper readiness.
- `POST …/submissions` sends `{"submissionId":"uuid", "action":"approve", "values":{"category":"meals"}}`.

Markdown uses the existing native CommonMark renderer; HTML stays inert and external images/links do not fetch resources. Controls are native Material components. Back and **Close** preserve pending requests, drafts and active SMS reception. An Inbox entry returns to Inbox; a notification entry returns to the previous app.

A text field with `"input":"sms_code"` offers manual entry and SMS User Consent autofill. There is at most one helper per request. The user explicitly starts listening; readiness is reported only after Play services starts the listener. Its five-minute deadline and timeout do not end the form. An owner-level helper lease serializes SMS capture across phones and the v1 SMS queue. Multiple phones may listen for the same form; another SMS request waits until those listeners end, even if the form is submitted first. Per-device leases also preserve Android cooldowns. After consent, the app extracts code candidates in memory; selecting or filling a candidate does not submit a v2 form. Legacy SMS automatic submission after Android consent is preserved. Process death loses drafts and consent state; the pending form remains available, and manual entry works during the prior listener's cooldown.

## Wizards

A request can include `steps` to group its existing `fields` into a wizard. Android shows one step at a time, validates the current step before Next, and provides Previous navigation and a final review screen. Submit/Approve/Acknowledge actions appear only on review; Decline remains available at every step. Next and Previous do not upload answers or end the request. One final response contains all visible field values in the existing result format, with the same first-phone-wins and upload-idempotency rules.

```json
{
  "title": "Review a trip expense",
  "body": "Complete the steps, then review and submit your response.",
  "idempotencyKey": "trip-wizard-001",
  "fields": [
    {"id":"travel","type":"checkbox","label":"Travel expense"},
    {"id":"city","type":"text","label":"Destination","required":true},
    {"id":"confirmed","type":"checkbox","label":"Details are correct","required":true}
  ],
  "steps": [
    {"id":"kind","title":"Expense type","fieldIds":["travel"]},
    {"id":"trip","title":"Trip details","body":"Where did you travel?","fieldIds":["city"],
      "when":{"fieldId":"travel","equals":true}},
    {"id":"confirm","title":"Confirmation","fieldIds":["confirmed"]}
  ],
  "actions": [
    {"id":"approve","type":"approve","label":"Approve"},
    {"id":"decline","type":"decline","label":"Decline"}
  ]
}
```

Definitions allow 2–12 steps. Each step has a unique ID, a title (120 characters), optional Markdown body (4,000 characters), and `fieldIds`. Every field must belong to exactly one step; an empty step can present instructions. Conditions reference a compatible field from an earlier step: `when: {fieldId, equals: string|number|boolean}`, or `when: {fieldId, contains: optionId}` for multiple choices. There are no executable expressions or loops. Missing values do not match, except an untouched checkbox has the value false. A field in a hidden step cannot activate a later step. The server validates the entire selected path and rejects answers for hidden fields. Changing an earlier answer discards answers from branches that become hidden.

Draft values and the current step stay in the Android ViewModel across rotation, Previous/Next, and Close, isolated by request and signed-in owner. They are not uploaded, written to disk, saved state, or background jobs. Expiry, termination, or a change of owner clears drafts. Process death starts the wizard again. The review screen shows the selected path's answers before the explicit final action. Opening events still observe foreground message rendering; they do not prove that every wizard step was viewed. Step progress is local and emits no sender events.

Wizard-capable phones advertise `wizardVersion: 1` during authenticated `PUT /v1/devices/:deviceId` registration. Android 0.6.0 advertises this automatically for an existing registration. Only capable phones receive wizard pushes or see them in the inbox; direct access from an old client returns `409 wizard_app_update_required`. Creation without an available capable phone returns `409 wizard_devices_unavailable`. Single-page forms and SMS continue to work on earlier clients. Deploy the compatible backend before updating Android. REST and the existing `create_request` MCP tool accept the same definition.

## Durable events and delivery

Events contain an `id`, `type`, `requestId`, connection-wide `sequence`, per-request `requestSequence`, and server timestamp `at`. Observations can include `deviceId`, `observedAt` and `fieldId`. Polling, SSE and webhooks use the same persisted event documents. Answers never enter event or notification payloads; retrieve them separately through REST or MCP.

| Event | Meaning |
| --- | --- |
| `request.created` | Definition accepted |
| `notification.accepted` | FCM accepted a push for one device; delivery/display is not proven |
| `notification.tapped` | Android handled the notification PendingIntent |
| `request.opened` | The authenticated app rendered the full body and form in the foreground |
| `input.ready`, `input.timeout` | SMS helper started or its listening window ended |
| `request.submitted` | The first valid response was accepted |
| `request.declined`, `request.cancelled`, `request.expired` | A terminal outcome without answers |

Opening is an observation, not agreement or proof that the message was read. First tap/open reports dedupe per device. The earliest observed foreground opening is exposed as `firstOpenedAt`. Android queues observation metadata in owner-bound, network-constrained WorkManager jobs, preserving retries across process restarts. Reports arriving after submission still dedupe and update the opening observation while retained. Response drafts and SMS content are never put into WorkManager or saved state.

SSE uses bearer authentication, a heartbeat each second, and a 100-second lifetime before reconnecting under the deployment's 120-second timeout. Each poll reads persisted Firestore events, so replay works across instances. Revocation or storage failure closes the stream. Slow consumers reconnect and replay using their last received event ID. Cursors belong to one connection. Events may have gaps after retention cleanup; retain the returned cursor and deduplicate by event ID.

Register a webhook with `{"url":"https://receiver.example/relay", "events":["request.submitted","request.declined"]}`. Registration returns a random signing `secret` once. Store it securely. Headers are `Relay-Event-ID`, `Relay-Timestamp` (Unix seconds), and `Relay-Signature: v1=HEX_HMAC_SHA256`. Verify the exact raw body using `HMAC_SHA256(secret, timestamp + "." + rawBody)`, compare in constant time, enforce a timestamp tolerance, and deduplicate by event ID. Each retry uses a fresh timestamp/signature but the same event ID. Any 2xx acknowledges delivery. Callbacks can duplicate or arrive out of order; use sequence to reconcile. Registration and each delivery resolve DNS, reject non-public destinations, and pin the validated address for certificate-verified TLS. Credentials, fragments, redirects and non-443 ports are disallowed. Failed callbacks retry with exponential backoff capped at one hour until metadata expiry.

Request mutations, events, notification jobs and webhook jobs are committed in the same Firestore transaction. A Cloud Tasks OIDC-authenticated wakeup calls `/internal/delivery`; worker leases tolerate duplicate execution and crashes. A failed enqueue does not undo the accepted request: the durable outbox remains for scheduled recovery. Minute-by-minute maintenance also expires requests/helpers and removes retained data. Account deletion tombstones the account, then removes v1/v2 requests, answers, events, delivery jobs, pairing records and grants (including webhook secrets).

## MCP and rollout

The existing `/mcp` endpoint adds `create_request`, `inspect_request`, `cancel_request`, `get_request_result`, and `poll_request_events`. Its three SMS tools and all v1 endpoints continue to use the original SMS lifecycle as the compatibility path. V2 events cover v2 requests. The old SMS result still expires after two minutes and its Android consent flow can still submit automatically.

Deploy Firestore indexes and the compatible backend before distributing the new Android build. `scripts/deploy.sh` provisions the Cloud Tasks queue, enqueue/act-as permissions and environment setting, and waits for indexes before starting the revision. Distribute the new Android inbox next; enable form access per connection explicitly. Browser forms, executable layouts, attachments and arbitrary conditional expressions are outside this version.

Physical-phone acceptance remains a release gate: pair a caller; approve form access; create two forms plus an SMS request; tap a notification; open another through the inbox; verify tap versus rendered events; decline one; submit the other from competing phones; verify one result; test manual entry and SMS autofill with explicit submit; go offline and restart before observation upload; verify replay and callback retries; check cancellation/expiry. Automated tests cannot prove carrier, notification-permission or physical Play-services behavior.
