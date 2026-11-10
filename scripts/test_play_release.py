"""Readiness-gate unit tests: synthetic tools/evidence, no live acceptance claims."""

from datetime import datetime, timedelta, timezone
import importlib.util
import json
import os
from pathlib import Path
import struct
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import zipfile

SPEC = importlib.util.spec_from_file_location("play_release", Path(__file__).with_name("check-play-release.py"))
gate = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gate)
NOW = datetime(2026, 11, 9, tzinfo=timezone.utc)
PILOT, UPLOAD = "A" * 64, "B" * 64


class GateTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.record = json.loads((Path(__file__).parents[1] / "docs/play/candidate.example.json").read_text())
        self.record.update(commit="c" * 40, versionCode=11, policyCheckedAt=NOW.isoformat())
        self.record["operator"] = {"legalName": "Synthetic Test Operator", "privacyEmail": "privacy@fixture.test", "supportEmail": "support@fixture.test"}
        self.record["urls"] = {"privacy": "https://fixture.test/privacy", "deletion": "https://fixture.test/account/delete", "support": "https://fixture.test/support"}
        self.record["signing"] = {"pilotSha256": PILOT, "uploadSha256": UPLOAD, "playSha256": [PILOT]}
        self.record["play"] = {"accountType": "personal", "newPersonalAccount": True, "developerAccountVerified": True, "productionAccessGranted": True, "noConsoleBlockers": True}
        self.record["cohort"] = {"startedAt": (NOW - timedelta(days=14)).isoformat(), "endedAt": NOW.isoformat(), "continuousTesters": 12, "noReleaseBlockers": True}
        for kind in ("aab", "playApk"):
            path = self.base / kind
            with zipfile.ZipFile(path, "w") as archive:
                archive.writestr("fixture.txt", "synthetic artifact")
            self.record["artifacts"][kind] = {"path": path.name, "sha256": gate.sha256(path)}
        evidence = {"result": "passed", "commit": self.record["commit"], "aabSha256": self.record["artifacts"]["aab"]["sha256"], "apkSha256": self.record["artifacts"]["playApk"]["sha256"], "splitSha256": [], "reviewCycles": [{"head": str(index) * 40, "findingsAddressed": True} for index in range(5)], "checks": {name: True for name in (*gate.RECOVERY_CHECKS, *gate.CLOUD_CHECKS)}}
        for label in gate.EVIDENCE:
            path = self.base / (label + ".json")
            path.write_text(json.dumps(evidence))
            self.record["evidence"][label] = {"path": path.name, "sha256": gate.sha256(path)}
        self.manifest = "package: name='com.bluegrain.smsrelay' versionCode='11'\ntargetSdkVersion:'36'"
        self.aab_manifest = '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.bluegrain.smsrelay" android:versionCode="11"><uses-sdk android:targetSdkVersion="36"/></manifest>'
        self.bad_ci = None
        self.open_issue = None

    def tools(self, args):
        if args[0] == "jarsigner":
            return "jar verified."
        if args[0] == "keytool":
            return "SHA256: " + UPLOAD
        if args[0] == "apksigner":
            return "Signer #1 certificate SHA-256 digest: " + PILOT
        if args[0] == "aapt":
            return self.manifest
        if args[0] == "java":
            return self.aab_manifest if "dump" in args else ""
        if args[1] == "issue":
            return json.dumps({"state": "OPEN" if args[3] == self.open_issue else "CLOSED"})
        return "\n".join(json.dumps({"id": i + 1, "name": name, "status": "completed", "conclusion": "failure" if name == self.bad_ci else "success"}) for i, name in enumerate(sorted(gate.REQUIRED_CI)))

    def check(self, offline=False, run=None):
        class Response:
            status = 200
            def __init__(self, url):
                self.url = url
            def read(self, _limit):
                return b'Synthetic Test Operator privacy@fixture.test <input id="confirm"><button id="remove">delete</button> reauthenticateWithPopup'
            def __enter__(self):
                return self
            def __exit__(self, *_):
                pass
        with patch.dict(os.environ, {"BUNDLETOOL_JAR": "synthetic-bundletool.jar"}), patch.object(gate.urllib.request, "urlopen", side_effect=lambda url, timeout: Response(url)):
            return gate.check_record(self.record, self.base, offline, run or self.tools, NOW)

    def test_complete_synthetic_record_passes(self):
        self.assertEqual(self.check()["blockers"], [])

    def test_offline_never_authorizes_publication(self):
        result = self.check(offline=True)
        self.assertFalse(result["ready"])
        self.assertFalse(result["publicationPerformed"])

    def test_example_cannot_pass(self):
        self.record = json.loads((Path(__file__).parents[1] / "docs/play/candidate.example.json").read_text())
        self.assertFalse(self.check()["ready"])

    def test_template_uses_exact_confirmed_public_identity_and_account(self):
        record = json.loads((Path(__file__).parents[1] / "docs/play/candidate.example.json").read_text())
        self.assertEqual(record["operator"], {"legalName": "Dmitry Kropachev", "privacyEmail": "bluegrain.llc@gmail.com", "supportEmail": "bluegrain.llc@gmail.com"})
        self.assertEqual(record["play"]["accountType"], "personal")
        self.assertIs(record["play"]["newPersonalAccount"], True)
        self.assertIs(record["play"]["productionAccessGranted"], False)
        self.assertTrue(all(value is None for value in record["urls"].values()))

    def test_artifact_change_invalidates_hash(self):
        (self.base / "aab").write_bytes(b"replacement")
        self.assertIn("aab: missing file or hash mismatch", self.check()["blockers"])

    def test_encrypted_and_unsupported_native_entries_produce_artifact_blockers(self):
        originals = {kind: ((self.base / kind).read_bytes(), dict(self.record["artifacts"][kind]))
                     for kind in ("aab", "playApk")}
        for kind in ("aab", "playApk"):
            for mode in ("encrypted", "unsupported-compression"):
                with self.subTest(artifact=kind, mode=mode):
                    for name, (original, reference) in originals.items():
                        (self.base / name).write_bytes(original)
                        self.record["artifacts"][name] = dict(reference)
                    path = self.base / kind
                    with zipfile.ZipFile(path, "w") as archive:
                        archive.writestr("lib/arm64-v8a/fixture.so", b"synthetic native entry")
                    data = bytearray(path.read_bytes())
                    central = data.index(b"PK\x01\x02")
                    if mode == "encrypted":
                        struct.pack_into("<H", data, 6, 1)
                        struct.pack_into("<H", data, central + 8, 1)
                    else:
                        struct.pack_into("<H", data, 8, 99)
                        struct.pack_into("<H", data, central + 10, 99)
                    path.write_bytes(data)
                    self.record["artifacts"][kind]["sha256"] = gate.sha256(path)
                    result = self.check()
                    self.assertFalse(result["ready"])
                    self.assertIn(kind + ": required artifact tool or structural verification failed", result["blockers"])

    def test_evidence_for_other_candidate_rejected(self):
        self.record["commit"] = "d" * 40
        self.assertTrue(any("exact candidate" in blocker for blocker in self.check()["blockers"]))

    def test_evidence_content_change_rejected(self):
        (self.base / "physicalAcceptance.json").write_text('{}')
        self.assertIn("physicalAcceptance: missing file or hash mismatch", self.check()["blockers"])

    def test_four_review_cycles_rejected(self):
        path = self.base / "finalCiAndReviews.json"
        data = json.loads(path.read_text())
        data["reviewCycles"].pop()
        path.write_text(json.dumps(data))
        self.record["evidence"]["finalCiAndReviews"]["sha256"] = gate.sha256(path)
        self.assertIn("five completed review/fix cycles missing", self.check()["blockers"])

    def test_recovery_requires_every_live_drill_and_control(self):
        path = self.base / "capacityCostRestore.json"
        complete = json.loads(path.read_text())
        for checks in ({}, None, *({**complete["checks"], name: False} for name in gate.RECOVERY_CHECKS)):
            with self.subTest(checks=checks):
                path.write_text(json.dumps({**complete, "checks": checks}))
                self.record["evidence"]["capacityCostRestore"]["sha256"] = gate.sha256(path)
                self.assertIn("capacityCostRestore: capacity, backup, ledger and live restore checks incomplete", self.check()["blockers"])

    def test_cloud_baseline_alone_cannot_satisfy_fault_acceptance(self):
        path = self.base / "cloudAcceptance.json"
        complete = json.loads(path.read_text())
        for checks in ({"baseline": True}, None, *({**complete["checks"], name: False} for name in gate.CLOUD_CHECKS)):
            with self.subTest(checks=checks):
                path.write_text(json.dumps({**complete, "checks": checks}))
                self.record["evidence"]["cloudAcceptance"]["sha256"] = gate.sha256(path)
                self.assertIn("cloudAcceptance: baseline, fault drills and cleanup incomplete", self.check()["blockers"])

    def test_new_personal_account_requires_fourteen_days_and_twelve_testers(self):
        self.record["cohort"].update(startedAt=(NOW - timedelta(days=7)).isoformat(), continuousTesters=11)
        blockers = self.check()["blockers"]
        self.assertIn("closed cohort has not completed its required duration", blockers)
        self.assertIn("new personal account needs at least 12 continuous testers", blockers)
        self.record["cohort"].update(startedAt=(NOW - timedelta(days=14)).isoformat(), continuousTesters=12)
        self.assertTrue(self.check()["ready"])

    def test_account_reclassification_cannot_bypass_mandatory_cohort(self):
        self.record["play"].update(accountType="organization", newPersonalAccount=False)
        self.record["cohort"].update(startedAt=(NOW - timedelta(days=7)).isoformat(), continuousTesters=11)
        blockers = self.check()["blockers"]
        self.assertIn("confirmed Play account is personal and created after 2023-11-13", blockers)
        self.assertIn("closed cohort has not completed its required duration", blockers)
        self.assertIn("new personal account needs at least 12 continuous testers", blockers)

    def test_future_cohort_and_old_policy_rejected(self):
        self.record["cohort"]["endedAt"] = (NOW + timedelta(days=1)).isoformat()
        self.record["policyCheckedAt"] = (NOW - timedelta(days=8)).isoformat()
        self.assertFalse(self.check()["ready"])

    def test_unknown_account_and_unverified_contacts_rejected(self):
        self.record["play"]["accountType"] = None
        self.record["operator"]["privacyEmail"] = "privacy@example.com"
        self.assertFalse(self.check()["ready"])

    def test_signature_failure_blocks(self):
        def run(args):
            if args[0] == "apksigner":
                raise subprocess.CalledProcessError(1, args)
            return self.tools(args)
        self.assertFalse(self.check(run=run)["ready"])

    def test_source_stamp_is_separate_from_numbered_or_rotated_app_signers(self):
        rotated, unknown = "D" * 64, "E" * 64
        self.record["signing"]["playSha256"].append(rotated)
        numbered = "Signer #1 certificate SHA-256 digest: " + PILOT
        stamp = "Source Stamp Signer certificate SHA-256 digest: " + unknown
        rotation = ("Signer (minSdkVersion=28, maxSdkVersion=32) certificate SHA-256 digest: " + PILOT +
                    "\nSigner (minSdkVersion=33, maxSdkVersion=2147483647) certificate SHA-256 digest: " + rotated)
        for output, accepted in (
            (numbered + "\n" + stamp, True),
            (rotation + "\n" + stamp, True),
            (stamp.replace(unknown, PILOT), False),
            (numbered.replace(PILOT, unknown) + "\n" + stamp.replace(unknown, PILOT), False),
            (numbered + "\nSigner #2 certificate SHA-256 digest: " + unknown, False),
        ):
            with self.subTest(output=output):
                def run(args):
                    return output if args[0] == "apksigner" else self.tools(args)
                result = self.check(run=run)
                self.assertEqual(result["ready"], accepted)
                if not accepted:
                    self.assertIn("Play APK signer mismatch", result["blockers"])

    def test_upload_key_must_differ_from_pilot_and_play_signers(self):
        other_app_signer = "D" * 64
        self.record["signing"]["playSha256"] = [PILOT, other_app_signer]
        for upload in (PILOT, other_app_signer):
            with self.subTest(upload=upload):
                self.record["signing"]["uploadSha256"] = upload
                def matching_artifacts(args):
                    return "SHA256: " + upload if args[0] == "keytool" else self.tools(args)
                self.assertEqual(self.check(run=matching_artifacts)["blockers"],
                                 ["upload key must differ from app signing keys"])

    def test_missing_pilot_continuity_blocks_otherwise_matching_artifacts(self):
        self.record["signing"]["pilotSha256"] = "D" * 64
        self.assertEqual(self.check()["blockers"],
                         ["pilot signing identity absent from Play signing inventory"])

    def test_wrong_sdk_version_debug_and_sms_permission_block(self):
        self.manifest = "package: name='com.bluegrain.smsrelay' versionCode='12'\ntargetSdkVersion:'35'\napplication-debuggable\nuses-permission: name='android.permission.READ_SMS'"
        blockers = self.check()["blockers"]
        self.assertIn("APK target API below requirement", blockers)
        self.assertIn("APK versionCode mismatch", blockers)
        self.assertIn("APK is debuggable", blockers)
        self.assertIn("APK requests forbidden broad permissions", blockers)

    def test_aab_manifest_cannot_differ_from_candidate(self):
        self.aab_manifest = self.aab_manifest.replace('versionCode="11"', 'versionCode="12"')
        self.assertIn("AAB versionCode mismatch", self.check()["blockers"])

    def test_config_split_can_omit_sdk_but_must_match_package_version_and_signer(self):
        path = self.base / "split.apk"
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr("fixture.txt", "synthetic config split")
        self.record["artifacts"]["playSplits"] = [{"path": path.name, "sha256": gate.sha256(path)}]
        for label in gate.EVIDENCE:
            report = self.base / (label + ".json")
            data = json.loads(report.read_text())
            data["splitSha256"] = [gate.sha256(path)]
            report.write_text(json.dumps(data))
            self.record["evidence"][label]["sha256"] = gate.sha256(report)
        def run(args):
            if args[0] == "aapt" and args[-1] == str(path):
                return "package: name='com.bluegrain.smsrelay' versionCode='11' split='config.en'"
            return self.tools(args)
        self.assertTrue(self.check(run=run)["ready"])
        matching_manifest = "package: name='com.bluegrain.smsrelay' versionCode='11' split='config.en'"
        for manifest, signer, blocker in (
            (matching_manifest.replace("com.bluegrain.smsrelay", "other.package"), PILOT, "APK package mismatch"),
            (matching_manifest.replace("versionCode='11'", "versionCode='12'"), PILOT, "APK versionCode mismatch"),
            (matching_manifest, "D" * 64, "Play APK signer mismatch"),
        ):
            with self.subTest(blocker=blocker):
                def mismatched_split(args):
                    if args[-1] == str(path):
                        if args[0] == "aapt":
                            return manifest
                        if args[0] == "apksigner":
                            return "Signer #1 certificate SHA-256 digest: " + signer
                    return self.tools(args)
                self.assertIn(blocker, self.check(run=mismatched_split)["blockers"])

    def test_open_prerequisite_blocks(self):
        self.open_issue = "9"
        self.assertIn("production prerequisite issue #9 remains open", self.check()["blockers"])

    def test_failing_or_missing_ci_blocks(self):
        self.bad_ci = next(iter(gate.REQUIRED_CI))
        self.assertIn("candidate CI is not green", self.check()["blockers"])
        def run(args):
            return "" if args[:2] == ["gh", "api"] else self.tools(args)
        self.assertIn("required CI checks missing on candidate commit", self.check(run=run)["blockers"])

    def test_github_tool_failure_blocks(self):
        def run(args):
            if args[0] == "gh":
                raise FileNotFoundError()
            return self.tools(args)
        self.assertIn("live GitHub prerequisite/CI verification failed", self.check(run=run)["blockers"])

    def test_staging_callback_container_check_is_required(self):
        def run(args):
            output = self.tools(args)
            if args[:2] == ["gh", "api"]:
                return "\n".join(line for line in output.splitlines()
                                 if json.loads(line)["name"] != "Staging callback probe container")
            return output
        self.assertIn("required CI checks missing on candidate commit", self.check(run=run)["blockers"])

    def test_every_android_api_variant_is_required_despite_legacy_ui_success(self):
        for api in (26, 33, 36):
            name = f"Android UI integration (API {api})"
            for conclusion in (None, "skipped", "failure"):
                with self.subTest(api=api, conclusion=conclusion):
                    def run(args):
                        output = self.tools(args)
                        if args[:2] != ["gh", "api"]:
                            return output
                        checks = [json.loads(line) for line in output.splitlines()]
                        if conclusion is None:
                            checks = [check for check in checks if check["name"] != name]
                        else:
                            for check in checks:
                                if check["name"] == name:
                                    check["conclusion"] = conclusion
                        checks.append({"id": 1000, "name": "Android emulator UI integration tests",
                                       "status": "completed", "conclusion": "success"})
                        return "\n".join(json.dumps(check) for check in checks)
                    blockers = self.check(run=run)["blockers"]
                    expected = "required CI checks missing on candidate commit" if conclusion is None else "candidate CI is not green"
                    self.assertIn(expected, blockers)

    def test_url_200_with_pilot_or_unconfigured_page_does_not_pass(self):
        class Response:
            status = 200
            def __init__(self, url):
                self.url = url
            def read(self, _limit):
                return b'Public operator contact and final backup disclosures have not yet been published. Web sign-in is not configured yet.'
            def __enter__(self):
                return self
            def __exit__(self, *_):
                pass
        with patch.dict(os.environ, {"BUNDLETOOL_JAR": "synthetic-bundletool.jar"}), patch.object(gate.urllib.request, "urlopen", side_effect=lambda url, timeout: Response(url)):
            blockers = gate.check_record(self.record, self.base, False, self.tools, NOW)["blockers"]
        self.assertIn("privacy page lacks verified legal operator/contact disclosures", blockers)
        self.assertIn("web deletion page is not configured for self-service confirmation", blockers)

    def test_deletion_url_must_use_actual_same_origin_route(self):
        self.record["urls"]["deletion"] = "https://other.test/account/delete"
        self.assertIn("privacy/deletion URLs must use canonical same-origin account routes", self.check()["blockers"])

    def test_partially_unsigned_aab_rejected(self):
        def run(args):
            return "jar verified. This jar contains unsigned entries" if args[0] == "jarsigner" else self.tools(args)
        self.assertIn("AAB JAR signature missing or invalid", self.check(run=run)["blockers"])


class NativeTest(unittest.TestCase):
    def elf(self, alignment, virtual=0, headers=1):
        ident = b"\x7fELF" + bytes([2, 1, 1]) + b"\0" * 9
        header = struct.pack("<HHIQQQIHHHHHH", 3, 183, 1, 0, 64, 0, 0, 64, 56, headers, 0, 0, 0)
        ph = struct.pack("<IIQQQQQQ", 1, 5, 0, virtual, 0, 0, 0, alignment)
        return ident + header + ph * headers

    def inspect(self, data, apk=False):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "candidate.zip"
            with zipfile.ZipFile(path, "w") as archive:
                archive.writestr("base/lib/arm64-v8a/test.so", data)
            return gate.native_alignment(path, apk)

    def test_native_alignment_and_multi_header_walk(self):
        self.assertEqual(self.inspect(self.elf(16384, headers=2)), [])
        mixed = bytearray(self.elf(16384, headers=2))
        # Only the second PT_LOAD segment is misaligned.
        struct.pack_into("<Q", mixed, len(mixed) - 8, 4096)
        self.assertEqual(self.inspect(mixed), ["native load alignment below or incompatible with 16 KiB"])
        self.assertTrue(self.inspect(self.elf(4096)))
        self.assertTrue(self.inspect(self.elf(16384, virtual=1)))

    def test_invalid_elf_and_unaligned_apk_rejected(self):
        self.assertEqual(self.inspect(b"not ELF"), ["invalid native library"])
        self.assertIn("uncompressed APK native library is not ZIP aligned to 16 KiB", self.inspect(self.elf(16384), apk=True))


if __name__ == "__main__":
    unittest.main()
