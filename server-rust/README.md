# Rust backend

Rust replacement for the existing `server/` application. Both implementations use the same Firestore collections, credentials, REST routes, MCP tools, and Android payloads. The TypeScript image remains the default during staging and the seven-day observation period.

```sh
cd server-rust
cargo run --locked
```

Set `GOOGLE_CLOUD_PROJECT` and use Google Application Default Credentials, or explicitly set both emulator hosts for local work. Configuration names match `server/src/index.ts`: `PORT`, `SERVICE_URL`, `SCHEDULER_EMAIL`, `DELIVERY_QUEUE`, `ANDROID_SIGNING_SHA256`, and `ALLOWED_ORIGINS`. Cloud Run rejects emulator configuration. Health checks initialize without credentials; authenticated operations initialize the Google clients on demand.

```sh
cargo fmt --manifest-path server-rust/Cargo.toml --check
cargo clippy --manifest-path server-rust/Cargo.toml --locked --all-targets -- -D warnings
npm run test:rust
npm run test:contract
cargo audit --file server-rust/Cargo.lock
docker build -f server-rust/Dockerfile -t sms-code-relay:rust .
IMAGE=sms-code-relay:rust scripts/container-smoke.sh
```

Run the npm commands from the repository root with JDK 21 on `PATH`. The contract command builds the emulator-only test host, runs the same 36 integration scenarios against each backend, then checks documents in both directions and compares HTTP/MCP responses. The test host injects clocks, authentication, push, wakeup and callback adapters. Production builds contain none of its routes. Firebase signature verification and live IAM/FCM/Tasks/Scheduler acceptance require the separate staging checks in [the migration record](../docs/RUST_MIGRATION.md).

`compat/` contains schemas, tool declarations, SDK parser fixtures, hashing fixtures, reserved-address ranges and pairing HTML captured from the TypeScript implementation. Changes to those contracts must update both backends. Zod schema string bounds count Unicode code points; custom form-answer bounds count UTF-16 units. Fingerprints use ECMAScript number formatting, key ordering and default expansion.

The Firestore adapter preserves timestamp values for `purgeAt`, transactional reads and queries, create preconditions, field masks, and bounded transaction retries. Domain callbacks queue writes; notification and webhook calls run after their claim commits. Codes and form answers live in their separate result collections. Logs contain static failure labels only.

Deploy a candidate using `BACKEND=rust TRAFFIC_MODE=stage scripts/deploy.sh` after explicitly choosing `PROJECT_ID` and the public signing fingerprint. Staging uses a tagged revision with no traffic. Promote only the exact revision that passed acceptance; retain the prior TypeScript revision and source through observation.

Regenerate the baseline fixtures with `node --import tsx scripts/capture-compat.mts` from the repository root. CI checks that regeneration leaves the fixtures unchanged.
