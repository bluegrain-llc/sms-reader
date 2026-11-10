# Google Play release preparation

This package prepares a release; it does not publish one. Issue [#11](https://github.com/bluegrain-llc/sms-reader/issues/11) stays open until the actual Play-installed candidate and closed cohort pass. Prior pilot SMS results are historical evidence, not acceptance for a new candidate.

## Release order

1. Complete issues #5–#10, including physical phones, real cloud failure recovery, safe deployment, monitoring, deletion and disaster recovery.
2. Fill the private candidate record from `candidate.example.json`. Keep it in ignored `artifacts/play/`, never commit contacts, tester identities, credentials, signing keys or private evidence.
3. Follow [signing and testing](release-checklist.md), review the [disclosure inventory](data-safety.md), and finish the [listing and reviewer package](listing.md).
4. Run `python3 scripts/check-play-release.py --record artifacts/play/candidate.json --output artifacts/play/readiness.json`. Supply `apksigner`, `aapt`, `jarsigner`, `keytool`, `java` and a read-only authenticated `gh` on PATH, plus a pinned `BUNDLETOOL_JAR`. Obtain bundletool from its [official releases](https://github.com/google/bundletool/releases) and verify the selected release's provenance. A successful report verifies local evidence integrity and gates; it is not proof that operator attestations are true. Review every referenced report separately.
5. Publish only after all blockers are cleared and the exact candidate has final green CI and five completed review/fix cycles. The tool has no upload, enrollment or publication operation.

`--offline` checks local records without querying GitHub or public URLs and always reports **not ready**. Exit 0 means readiness checks passed, 1 means blockers, 2 means invalid CLI input. Reports omit contact values, evidence contents, tool output and credentials. Required tool failures are blockers, never skipped passes.

Privacy and deletion URLs must use the canonical same-origin `/privacy` and `/account/delete` routes. The tool also rejects an HTTP 200 pilot privacy page without the supplied legal name/privacy email, and a deletion page without the configured confirmation flow. These read-only HTML checks do not prove Google popup sign-in, reauthentication or backend cleanup; their actual acceptance reports remain required. Support can use a separate HTTPS page.

## Current external gates

Verified legal/operator contacts, Play Console account ownership/verification, signing enrollment, public privacy/deletion endpoints, reviewer access, Play-installed physical acceptance and the closed cohort are not established by this package. The example record deliberately contains nulls and empty evidence references so it cannot pass.

Keep the canonical HTTPS service origin for policy and deletion links; a custom domain is optional. Recheck policy requirements within seven days of submission. Resolve legal/Data safety classifications with the operator before submitting; repository notes are not legal approval.

## Candidate and evidence records

Artifact and evidence paths resolve relative to the candidate JSON directory. Include the installed base APK as `playApk` and **every** additional installed APK as `playSplits`; obtain the complete list from `adb shell pm path com.bluegrain.smsrelay` on the Play-installed test phone. An empty split list is valid only for a verified single-APK install. Keep the install-source and complete package inventory in `playInstalledSmoke` evidence. AAB structural checks cover all bundled native libraries; APK checks cover the delivered ZIP alignment and signers. The validator cannot independently prove installation source or the completeness of an operator-supplied APK list.

Each evidence reference has `path` and lowercase `sha256`. Its JSON must contain `result: "passed"`, the full candidate `commit`, `aabSha256`, `apkSha256` and ordered `splitSha256` list. Include the actual test/drill/approval report and timestamp, not only these envelope fields. `finalCiAndReviews` additionally contains `reviewCycles`, with at least five records containing full `head` SHA and `findingsAddressed: true`; keep each review/fix report alongside that record. These are operator attestations, not cryptographic attestations. Rebind only reports actually rerun or verified applicable to the final candidate. Live GitHub checks separately require prerequisite issues #5–#10 closed and the candidate's required check runs successful. Update the required CI name set deliberately if the repository renames its checks.

For `accountDeletion`, verify the current HTTP 202 acceptance followed by receipt-authenticated pending/running/completed status, interrupted-worker recovery, the same-account recent-login Android flow, and web popup sign-in/reauthentication. Receipt hashes expire after 24 hours; completed-job metadata after seven days; the account tombstone remains. The browser polls for at most ten minutes and cleanup continues if that polling ends. Never attach receipts, ID tokens or raw account data to reports. See [the actual contract](../ACCOUNT_DELETION.md).

## Validation

Run `python3 -m unittest discover -s scripts -p 'test_play_release.py'`. Tests use temporary synthetic evidence only; they do not establish live Play eligibility or artifact signatures.
