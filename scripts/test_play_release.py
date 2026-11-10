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
        self.record["play"] = {"accountType": "organization", "newPersonalAccount": False, "developerAccountVerified": True, "productionAccessGranted": True, "noConsoleBlockers": True}
        self.record["cohort"] = {"startedAt": (NOW - timedelta(days=7)).isoformat(), "endedAt": NOW.isoformat(), "noReleaseBlockers": True}
        for kind in ("aab", "playApk"):
            path = self.base / kind
            with zipfile.ZipFile(path, "w") as archive:
                archive.writestr("fixture.txt", "synthetic artifact")
            self.record["artifacts"][kind] = {"path": path.name, "sha256": gate.sha256(path)}
        evidence = {"result": "passed", "commit": self.record["commit"], "aabSha256": self.record["artifacts"]["aab"]["sha256"], "apkSha256": self.record["artifacts"]["playApk"]["sha256"], "splitSha256": [], "reviewCycles": [{"head": str(index) * 40, "findingsAddressed": True} for index in range(5)]}
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

    def test_artifact_change_invalidates_hash(self):
        (self.base / "aab").write_bytes(b"replacement")
        self.assertIn("aab: missing file or hash mismatch", self.check()["blockers"])

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

    def test_new_personal_account_requires_fourteen_days_and_twelve_testers(self):
        self.record["play"].update(accountType="personal", newPersonalAccount=True)
        blockers = self.check()["blockers"]
        self.assertIn("closed cohort has not completed its required duration", blockers)
        self.assertIn("new personal account needs at least 12 continuous testers", blockers)
        self.record["cohort"].update(startedAt=(NOW - timedelta(days=14)).isoformat(), continuousTesters=12)
        self.assertTrue(self.check()["ready"])

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

    def test_wrong_upload_key_or_pilot_discontinuity_blocks(self):
        self.record["signing"]["uploadSha256"] = PILOT
        self.record["signing"]["playSha256"] = ["D" * 64]
        self.assertFalse(self.check()["ready"])

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
        self.assertTrue(self.inspect(self.elf(4096)))
        self.assertTrue(self.inspect(self.elf(16384, virtual=1)))

    def test_invalid_elf_and_unaligned_apk_rejected(self):
        self.assertEqual(self.inspect(b"not ELF"), ["invalid native library"])
        self.assertIn("uncompressed APK native library is not ZIP aligned to 16 KiB", self.inspect(self.elf(16384), apk=True))


if __name__ == "__main__":
    unittest.main()
