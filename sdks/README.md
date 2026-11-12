# Request Relay SDKs

The HTTP contract is [onboarding.openapi.json](../contracts/onboarding.openapi.json). Regenerate it with `npm run contracts:onboarding`. The TypeScript/Rust contract suite tests the same shared Firestore records, permission boundaries, approval races, JWE deliveries and revocation in both directions.

| Family | Client | Runtime |
| --- | --- | --- |
| TypeScript/JavaScript | `javascript/` | Node 22+, direct HTTPS client and maintained lifecycle layer |
| Python | `python/` | Python 3.10+, cryptography, direct HTTPS client |
| Go | `go/` | Go 1.22+, installed `relay-broker` |
| Java/Kotlin | `java/` | Java 17+, Jackson, installed `relay-broker` |
| C#/.NET | `dotnet/` | .NET 8+, installed `relay-broker` |
| Rust | `rust/` | Rust, serde_json, installed `relay-broker` |
| PHP | `php/` | PHP 8.1+, installed `relay-broker` |
| Ruby | `ruby/` | Ruby with JSON/Open3, installed `relay-broker` |

The six broker bindings share the maintained Node lifecycle implementation, crypto, backoff, private credential store and durable acknowledgement code. They are process transports, and **require Node and the CLI on the service machine**. They are not standalone generated HTTP clients. Java's public class is directly usable from Kotlin. These packages are development artifacts, not published registry releases.

Install the CLI from the repository with `npm ci`, then `npm link --workspace cli` to make `relay`, `relay-broker`, and `relay-mcp` available. The bindings accept an explicit broker executable path so deployments can pin that installation. They launch it without a shell; only public settings and request definitions enter stdin. Credentials stay in the helper's private store. The helper returns links, status, connection IDs and authorized request results. Do not log request results or make lifecycle methods available as model tools.

All eight families accept storage hooks. JavaScript and Python accept native `load`/`save` objects. The six broker bindings accept an absolute executable path (`StorageCommand` in Go, `storageCommand` in Java/.NET/PHP, `storage_command` in Rust/Ruby). The hook receives a JSON object on stdin: `{"operation":"load","profile":"NAME"}` or `{"operation":"save","profile":"NAME","state":PRIVATE_STATE}`. It returns `{"ok":true,"state":PRIVATE_STATE_OR_NULL}` for load and `{"ok":true}` after a durable save. It must never log its private input/output. The broker invokes it without a shell, bounds output/time, hides its errors, and retains local per-profile locking. Use separate profiles or implement cross-machine concurrency in the storage provider. This hook is software configuration, never a model tool.

 `save(state)` must atomically and durably persist the complete private state before returning; `load()` returns it for resume. Use the CLI store in Node, or a secret manager with equivalent durability. Serialize access to a profile. Do not store this state in model-visible configuration. Keep old delivery keys through the seven-day delivery retention window; retiring a compromised key invalidates its unacknowledged deliveries.

```js
import { ServiceSession } from './javascript/index.mjs';
import { PrivateStore } from '@sms-relay/cli/store';
const storage = new PrivateStore(undefined, 'my-agent');
const service = await ServiceSession.create({
  baseUrl: 'https://RELAY', name: 'My agent', purpose: 'Ask for decisions',
}, storage);
const registration = await service.startRegistration();
// Present registration.link as a link/locally generated QR; it contains no credential.
await service.waitForRegistration();
// service.permanentLink() can be used while this process is offline.
await service.consumeDeliveries();
// Stored connection IDs are available after a recipient approves and delivery is consumed:
const connectionIds = Object.keys(service.state.connections);
// Choose an ID from connectionIds, then call service.connection(id).requestForm(definition).
```

For a particular external account, call `startPairing` with a cryptographically random opaque `externalAccountRef` produced by its authenticated backend. Repeated calls resume the saved attempt. `restartPairing` deliberately creates a fresh attempt and requires approval again. No email, Firebase UID or external username belongs in that reference.

Broker clients expose the same camelCase operations (snake_case in Rust/Ruby). Call `startRegistration` with `name`, `purpose`, and optional `capabilities`, then poll or wait for registration. `permanentLink` returns a reusable URL. `startPairing`, `pollPairing`, `waitForPairing`, `restartPairing`, `consumeDeliveries`, `listConnections`, `resume`, `rotateCredential` and `rotateKey` manage lifecycle. `status`, form/SMS request, get/result/cancel, event and webhook methods take a selected connection ID. The server remains authoritative for capabilities, expiry and revocation.

Regenerate these process transports with `python3 scripts/generate-sdk-transports.py`. They deliberately keep polling, key handling and storage in the shared maintained helper. Validate language builds plus the common broker, SDK crypto and backend conformance tests before packaging. Run `python3 scripts/build-sdk-conformance.py`, then the SDK-family contract tests with `RELAY_SDK_CONFORMANCE=artifacts/sdk-conformance/commands.json`. The shared scenarios run every family against both backends, covering durable hooks, storage failure, registration, JWE acknowledgement, pairing/resume/rotation, capability restrictions, request/results/events, webhooks and disconnection. Independent native HTTP transports and registry publication remain release work.


Private session tickets can be imported/exported by the JavaScript and Python SDKs. For Go, Java, .NET, Rust, PHP and Ruby, use the generated `importTicket` / `exportTicket` operation (language-appropriate casing) with `{file: PATH}`. Files stay on the SDK host; the broker prints only a registration/export status. Import requires an empty profile and validates the relay’s authoritative credential/key binding before durable storage. These operations must never be registered as model tools. See [ticket format and lifecycle](../docs/ONBOARDING.md#portable-agent-session-tickets).
