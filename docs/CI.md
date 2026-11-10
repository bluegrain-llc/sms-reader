# CI and delivery

[CI and delivery](../.github/workflows/check.yml) runs on pushes, pull requests and manual dispatches. It uses Node 24, JDK 21 and Android SDK 36 without production credentials.

The required jobs check:

- Server TypeScript compilation, unit tests and production dependency audit.
- Firestore and Firebase Auth Emulator integration tests, including transactional lifecycle, races, expiry, caller isolation, REST authentication and MCP client requests. Missing emulators fail this suite.
- A production Docker build with startup, health and unauthenticated-request smoke checks.
- Cloud-acceptance guard/signature/evidence tests and a separate staging callback
  probe container build, syntax check and fail-closed unconfigured startup check.
- Android unit tests, lint, debug APK and instrumentation APK builds.
- Connected Compose UI tests on an API 36 Android emulator. These cover approval, manual entry, automatic submission, cancellation, expiry and navigation. The separate opt-in `SmsInjectionTest` needs the telephony/Play-services runner in `scripts/test-sms-injection.py` and is not included in this UI suite.

Each run retains Android test/lint reports, debug APKs and the tested container archive as private workflow artifacts. Failed backend integration runs also retain emulator logs. Debug APKs have no production configuration and show the setup screen.

The `staging-callback-probe-container` artifact retains the tested callback image
for seven days. It is separate from the production relay image and is deployed
only in an explicitly selected staging project; see [cloud acceptance](CLOUD_ACCEPTANCE.md).

After all jobs pass on a push to `main`, delivery loads the exact container archive that passed its smoke test and publishes it to GitHub Container Registry:

```text
ghcr.io/bluegrain-llc/sms-reader:<full-commit-sha>
ghcr.io/bluegrain-llc/sms-reader:latest
```

Publishing uses the repository's temporary `GITHUB_TOKEN` with `packages: write`; no registry secret is required. New container packages are private by default. The image's source label links package access to this repository. Keep package visibility private in the organization's package settings.

Delivery publishes installable/build artifacts; deploying to the existing Cloud Run service uses the explicit project and signing fingerprint procedure in [DEPLOYMENT.md](DEPLOYMENT.md). Signed pilot APKs require the private signing key and release configuration described there. These credentials are never needed by CI.

The Android UI job removes unused .NET and Android NDK installations from its disposable hosted runner before starting the emulator. API 36 images can require over 7 GiB for userdata despite the requested 2 GiB data-partition setting; a low-space runner can exit before ADB starts. This cleanup preserves the Java/Kotlin toolchain and Android SDK packages used by the tests.
