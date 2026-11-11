# Service onboarding

This is the implementation and rollout record for QR/link service onboarding. It preserves `/v1` SMS and `/v2` forms operations. It also implements a separate OAuth authorization layer for named-service MCP connections. Every flow uses the configured relay server; “hosted” describes where the requesting agent’s connector runs.

## Register and connect

From a repository installation:

```sh
npm ci
npm link --workspace cli
relay service register --profile my-agent --name "My agent" --relay https://RELAY
relay service link --profile my-agent
relay service hosted-link --profile my-agent
relay service manage --profile my-agent
relay service connect --profile my-agent
relay service deliveries --profile my-agent
relay status --profile my-agent
relay resume --profile my-agent
```

Forms are the default. `--sms` explicitly declares forms and SMS. `--expires-in-days N` requests an optional 1–365 day duration for a temporary connection; the default is until disconnected. Use a separate profile for each named service. `--no-open` leaves the browser closed; the usable HTTPS link and local QR are always displayed. `--external-account-ref` must be a random opaque reference supplied by the service's authenticated backend, never an email or account name.

Registration saves local credentials and a P-256 delivery key before starting its ten-minute session. Google sign-in and one confirmation register the service. “Also allow this service to send requests to me” starts off. Selecting it creates a separate recipient grant in the same transaction and confirmation. Registration alone needs neither a receiving phone nor notifications.

Temporary links show a comparison code. Permanent service links contain only a stable service ID; after sign-in they start an owner-bound approval session. Opening either never approves access, opens SMS reception, or sends a request notification. A recipient may narrow permissions and duration. Approval is transactional and idempotent. Another recipient cannot take over an already decided or owner-bound session.

After approval, Android/browser show access granted, waiting for service, phone setup needed, or setup complete. A suitable unpaused registered phone on the account is sufficient; the current phone need not be registered. A browser provides an Android intent handoff and installation guidance from the relay operator. Management links at `/connections/ID` permit an explicit permission change, expiry change, or disconnect; Android Administration links new scoped grants to this focused screen. Code entry remains a secondary legacy troubleshooting path.

On Android, `/register/ID`, `/pair/ID`, `/services/ID` and `/connections/ID` open a dedicated task and validate the configured HTTPS host/path. Inbox drafts and Administration navigation remain independent. The camera app scans QR codes; no camera permission is added. Pending public destinations/attempt IDs survive rotation and task recreation. Approval retry checks the same server session. Expired attempts require a fresh session and approval.

## Authority and storage

- `smsreg_`: pending registration authentication, no request authority.
- `smss_`: service credential, pairing and encrypted delivery management only.
- `smsr_`: one recipient connection, only its effective capabilities and results.
- Firebase owner sessions: review/decide and private owner management. They never enter the service's payloads.

Stable service IDs are independent of rotation. Credentials are stored hashed by the relay. The CLI store defaults to `~/.local/share/request-relay/PROFILE.json`, with a 0700 owned directory, 0600 files, atomic rename/fsync, symlink rejection on reads, and an exclusive recoverable profile lock. Store the directory outside application logs, backups exposed to models, and source control. SDK storage hooks must provide the same durable commit semantics.

The separate `/owned-services` browser page (opened by `relay service manage`) lists the operator’s services and offers explicit enable/disable/delete controls. Deletion needs confirmation. It shows public permanent links/QR codes and no credentials; key and credential rotation stays in the service software. It is not part of focused recipient approval.

Connection credentials are generated on approval and atomically queued as compact JWE using P-256, ECDH-ES and A256GCM. The protected header authenticates service, connection, delivery and key IDs; the encrypted payload repeats the service, connection and delivery IDs. The key ID is authenticated in the protected header. Clients verify all bindings. Only public delivery keys reach the relay. Software saves decrypted credentials durably before acknowledgement; a failed acknowledgement replays the same delivery. Unacknowledged delivery expires after seven days and leaves its grant unusable until fresh approval. Old private keys remain available through rotation. Retiring an old compromised key invalidates its outstanding deliveries, without invalidating previously acknowledged connections.

Use `rotate-credential` and `rotate-key`, optionally `--retire-key ID`. A staged new credential/key is saved before the remote change. `resume` recovers interrupted rotations. Secrets are absent from QR codes, links and normal CLI output.

New grants store explicit independent forms/SMS capabilities. An SMS helper field inside a form also requires SMS permission; removing that permission blocks its results and cancels pending helper forms. New approval sessions live in separate collections, so legacy approval endpoints cannot bypass their permission display. Request creation, retrieval, events, callbacks and MCP operations reauthorize the grant and active parent service/operator. Live event feeds also watch parent authorization. Legacy grants without capability data retain their prior semantics and legacy MCP discovery behavior. New interfaces expose null expiry; old responses keep the valid numeric indefinite-expiry sentinel 8640000000000000.

Service deletion leaves an inactive service tombstone and queues bounded child-record cleanup without deleting recipients' unrelated history. Operator account deletion similarly queues service cleanup; its account tombstone blocks access immediately. Recipient deletion blocks its own grants/deliveries. Session/delivery/rate cleanup is bounded, with matching Firestore TTL/index configuration. A compact registration receipt remains with the original current service credential, allowing an interrupted client to recover an already approved registration after session cleanup. Recovery requires the original registration secret and unchanged declaration; it does not renew expired recipient access or bypass service/account revocation. Existing account-deletion collection indexes are preserved by appending new collections.

## Contracts, SDKs and integrations

[OpenAPI](../contracts/onboarding.openapi.json) and [schema publication](../contracts/onboarding.schemas.json) are generated from TypeScript inputs. The [SDK guide](../sdks/README.md) records all eight language families, storage hooks and the shared Node helper dependency for six process bindings. These are repository development packages; registry publication and standalone generated HTTP clients remain outstanding.

`relay-mcp --profile NAME --connection ID` exposes only connection-authorized remote tools. If setup is incomplete it exposes public setup status/link. Registration and service management credentials are not tools. The [provider adapters](../integrations/README.md) supply OpenAI, Anthropic and Google function declarations over the same private MCP connection. Provider live authorization acceptance remains outstanding. Microsoft, AWS and xAI have issues [#23](https://github.com/bluegrain-llc/sms-reader/issues/23), [#24](https://github.com/bluegrain-llc/sms-reader/issues/24), [#25](https://github.com/bluegrain-llc/sms-reader/issues/25).

## Hosted ChatGPT, Claude and Google connections

Register a named service with the CLI, then run `relay service hosted-link --profile my-agent`. Configure the returned public `https://RELAY/mcp/services/SERVICE_ID` URL in the provider’s remote MCP connection. The URL chooses the service shown on the approval screen. Client names and callback origins are also shown as operator supplied information; registration is not identity verification. No user needs to choose an internal service identifier.

Enable the flow with a private `OAUTH_CODE_KEY`: 32 random bytes encoded as 64 lowercase hex characters, supplied through Secret Manager to both backends. This HMAC key allows an authenticated owner to resume a one-time authorization response across Android/browser handoff without storing plaintext codes. It is never Firebase web configuration. Changing it invalidates pending authorization responses; existing opaque access/refresh tokens keep their normal authorization checks.

The server exposes RFC 8414 authorization-server discovery and RFC 9728 metadata at `/.well-known/oauth-protected-resource/mcp/services/SERVICE_ID`. Unauthorized resource requests advertise that URL in `WWW-Authenticate`. `/oauth/register` supports public clients and `client_secret_post` confidential clients. HTTPS Client ID Metadata Documents are cached for one hour; fetches and redirect validation use the same all-address public-destination checks as webhooks, pin DNS addresses, reject redirects and enforce response size/time limits. Callback URLs match exactly. Only authorization codes with PKCE S256 are accepted.

Opening `/oauth/authorize` creates a ten-minute consent attempt and redirects to the focused Google/Firebase sign-in page. The user narrows capabilities/duration and presses Connect once. A public, locally generated QR offers Android/browser handoff; the original browser detects approval and resumes the provider callback. Android uses its separate onboarding task and preserves Inbox drafts. Callback authorization codes are the OAuth protocol’s one-time exception to the rule against putting credentials in links; they are issued when the browser returns to the requesting app, expire in one minute, require the original verifier/client/resource/redirect and are never normal CLI/model output.

Hosted grants are bound separately to the recipient, service and OAuth client. They use the same connection status, permissions and disconnection UI, but do not require a delivery consumer or give the integration operator a recipient bearer credential. Ten-minute access tokens are restricted to the exact MCP resource and effective approved capabilities; they cannot call REST or the legacy `/mcp` endpoint. Refresh tokens rotate on every exchange, remain usable until the grant expires or is disconnected, and reuse revokes the entire token family. Capability changes, service disablement and account deletion are rechecked on every operation. Durable bounded jobs remove revoked families and token records; account/service deletion also removes their associated records. Used refresh hashes remain while their family is active so reuse can be detected.

See [provider connection setup](../integrations/README.md#hosted-connections). Provider account access, live authorization and marketplace publication are separate acceptance work.

## Deployment and remaining acceptance

Deploy compatible backends and Firestore indexes before directing released Android/CLI clients to these entry points. Configure the existing Firebase web configuration, canonical HTTPS `SERVICE_URL`, Google sign-in origin, Android signing fingerprints, and verified App Links. Run staging against both backend images. Existing credentials and pairings remain valid.

Automated coverage includes cross-runtime registration, optional owner access, narrowed permissions, racing approvals, reusable links, owner binding, expiry, offline delivery, acknowledgement, rotation, service disablement, operator deletion, CLI durable storage, QR decoding, browser confirmation/retry, SDK JWE interoperability, and provider declaration isolation. Browser sign-in tests stub Firebase modules; they do not prove live Google sign-in. The eight-family emulator conformance matrix drives the maintained clients against both real backends, including private storage-hook failure, delivery acknowledgement, request/results/events, callbacks, rotation, resume and isolation. Six families use the shared Node broker; this does not claim standalone native HTTP implementations.

Remaining release gates:

- Physical signed-device App Links, installation handoff, notification permission and per-request consent against deployed v3 support.
- Live browser Google/Firebase sign-in and Android credential-manager acceptance.
- SDK registry packaging/publication and any future standalone native HTTP clients. The current eight-family lifecycle/request matrix passes against both runtimes, including PHP 8.3.
- Live OpenAI/Anthropic provider authorization and function-calling acceptance. Automated provider profiles cover their OAuth protocol surfaces; they do not prove production enrollment or live UI behavior.
- Google hosted persistent-linking compatibility: its documented stable-refresh behavior conflicts with the requested rotating-refresh policy. This provider profile remains explicitly TODO pending a compatible policy and verification.
- Hosted provider UI/authorization acceptance and external app/plugin marketplace approval against the deployed OAuth endpoints.

HTTP telemetry records fixed route templates/status classes and bounded `onboarding_outcome` phase/outcome/count records for registration, approval, delivery, expiry and setup failures or missing phones. Counts describe observed API outcomes, including retries and repeated status reads; they are not unique-user metrics. They exclude raw paths, account identities, credentials and submitted values.

## Local verification record

The checks use synthetic accounts/credentials and emulator storage. Backend contracts exercise shared Firestore records across the two actual runtimes. Browser tests stub Firebase sign-in; provider adapters make no inference calls. Android instrumentation uses an isolated API 36 emulator and never installs over the connected physical phone. QR tests decode both terminal-generation fixtures and the browser’s phone-handoff canvas. Language smoke tests cover Go, Java/Kotlin, .NET, Rust, PHP and Ruby process transports. The eight-family lifecycle/request matrix additionally exercises these clients plus JavaScript and Python against both backends, with durable storage hooks and storage-failure acknowledgement checks. JavaScript/Python tests cover interrupted key retirement and JOSE interoperability. See CI for the repeatable commands; staging acceptance remains required above.

The final focused local checks include 44 TypeScript unit tests, five CLI tests, ten browser flows and six Android onboarding instrumentation tests. The SDK matrix has 16 family/runtime cases; the native stream regression also verifies an observed future expiry before advancing its injected clock. These results do not replace the live sign-in, provider or physical-device gates above.
