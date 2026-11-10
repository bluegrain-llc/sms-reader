#!/usr/bin/env python3
"""Read-only Play release gate. No enrollment, upload or publication operations."""

import argparse
import hashlib
import html
import json
import os
from pathlib import Path
import re
import struct
import subprocess
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from datetime import datetime, timedelta, timezone

REPO = "bluegrain-llc/sms-reader"
EVIDENCE = (
    "physicalAcceptance", "cloudAcceptance", "deploymentRollback", "monitoringDrill",
    "accountDeletion", "capacityCostRestore", "playInstalledSmoke", "pageSizeRuntime",
    "signingContinuity", "dataSafetyApproval", "reviewerAccess", "storeAssets",
    "consoleEligibility", "finalCiAndReviews",
)
RECOVERY_CHECKS = (
    "capacityRun24Hours", "monthlyCostWithin100Usd", "isolatedMetadataBackup",
    "lockedIndependentLedger", "denialsReplayed", "servingGateFailClosed",
    "metadataRestoreDrill", "signingRestoreDrill", "infrastructureRestoreDrill",
)
REQUIRED_CI = {
    "Server unit tests and type check", "Firestore, Auth, REST and MCP integration tests",
    "Container build and HTTP smoke test", "Android unit tests, lint and build",
    "Android emulator UI integration tests", "Play release gate unit tests",
}


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def fingerprint(value):
    value = re.sub(":", "", value or "").upper()
    return value if re.fullmatch(r"[0-9A-F]{64}", value) else None


def timestamp(value):
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed if parsed.tzinfo else None
    except (AttributeError, TypeError, ValueError):
        return None


def https_url(value):
    if not isinstance(value, str):
        return False
    try:
        url = urllib.parse.urlsplit(value)
        return bool(url.scheme == "https" and url.hostname and not url.username and
                    not url.password and not url.fragment and not url.query and
                    url.hostname not in {"localhost", "example.com", "example.org"} and
                    not url.hostname.endswith((".invalid", ".example")))
    except ValueError:
        return False


def command(args):
    return subprocess.run(args, capture_output=True, text=True, timeout=60,
                          env={**os.environ, "LC_ALL": "C", "LANG": "C"}, check=True).stdout


def native_alignment(path, apk):
    """Check ELF PT_LOAD alignment and direct-mapped APK ZIP entries, not runtime support."""
    errors = []
    with zipfile.ZipFile(path) as archive, path.open("rb") as source:
        for member in archive.infolist():
            if not member.filename.endswith(".so"):
                continue
            data = archive.read(member)
            if len(data) < 52 or data[:4] != b"\x7fELF" or data[4] not in (1, 2) or data[5] not in (1, 2):
                errors.append("invalid native library")
                continue
            endian = "<" if data[5] == 1 else ">"
            is64 = data[4] == 2
            header = struct.unpack_from(endian + ("HHIQQQIHHHHHH" if is64 else "HHIIIIIHHHHHH"), data, 16)
            offset, size, count = header[4], header[8], header[9]
            expected = 56 if is64 else 32
            if size < expected or not count or offset + size * count > len(data):
                errors.append("invalid native program headers")
                continue
            for index in range(count):
                ph = struct.unpack_from(endian + ("IIQQQQQQ" if is64 else "IIIIIIII"), data, offset + index * size)
                if ph[0] == 1:
                    load_offset, virtual = (ph[2], ph[3]) if is64 else (ph[1], ph[2])
                    if ph[-1] < 16384 or ph[-1] & (ph[-1] - 1) or load_offset % 16384 != virtual % 16384:
                        errors.append("native load alignment below or incompatible with 16 KiB")
            if apk and member.compress_type == zipfile.ZIP_STORED:
                source.seek(member.header_offset)
                local = source.read(30)
                if len(local) != 30 or local[:4] != b"PK\x03\x04":
                    errors.append("invalid APK local header")
                else:
                    name_size, extra_size = struct.unpack_from("<HH", local, 26)
                    if (member.header_offset + 30 + name_size + extra_size) % 16384:
                        errors.append("uncompressed APK native library is not ZIP aligned to 16 KiB")
    return errors


def check_record(record, base, offline=False, run=command, now=None):
    now = now or datetime.now(timezone.utc)
    blockers = []

    def require(condition, message):
        if not condition:
            blockers.append(message)

    def file_ref(ref, label):
        if not isinstance(ref, dict) or not isinstance(ref.get("path"), str) or not re.fullmatch(r"[0-9a-f]{64}", ref.get("sha256") or ""):
            blockers.append(label + ": missing path/hash")
            return None
        path = (base / ref["path"]).resolve()
        if not path.is_file() or sha256(path) != ref["sha256"]:
            blockers.append(label + ": missing file or hash mismatch")
            return None
        return path

    commit = record.get("commit")
    require(isinstance(commit, str) and bool(re.fullmatch(r"[0-9a-f]{40}", commit)), "candidate commit must be a full SHA")
    require(type(record.get("versionCode")) is int and record["versionCode"] > 0, "candidate versionCode missing")
    minimum = record.get("minimumTargetApi")
    require(type(minimum) is int and minimum >= 36, "current target API requirement missing or below 36")
    operator = record.get("operator", {})
    name = operator.get("legalName")
    require(isinstance(name, str) and len(name.strip()) > 2 and not re.search(r"placeholder|todo|example", name, re.I), "verified legal operator missing")
    for field in ("privacyEmail", "supportEmail"):
        email = operator.get(field)
        require(isinstance(email, str) and bool(re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email)) and not email.endswith(("@example.com", ".invalid")), "verified " + field + " missing")
    urls = record.get("urls", {})
    if https_url(urls.get("privacy")) and https_url(urls.get("deletion")):
        privacy, deletion = (urllib.parse.urlsplit(urls[key]) for key in ("privacy", "deletion"))
        require(privacy.netloc == deletion.netloc and privacy.path == "/privacy" and deletion.path == "/account/delete",
                "privacy/deletion URLs must use canonical same-origin account routes")
    for label in ("privacy", "deletion", "support"):
        valid = https_url(urls.get(label))
        require(valid, "public HTTPS " + label + " URL missing")
        if valid and not offline:
            try:
                with urllib.request.urlopen(urls[label], timeout=10) as response:
                    require(response.status == 200 and https_url(response.url) and
                            (label == "support" or response.url == urls[label]), label + " URL did not resolve to canonical HTTPS HTTP 200")
                    if label in ("privacy", "deletion"):
                        content = html.unescape(response.read(256 * 1024).decode("utf-8"))
                        if label == "privacy":
                            require(all(isinstance(operator.get(field), str) and operator[field] in content for field in ("legalName", "privacyEmail")) and
                                    "have not yet been published" not in content,
                                    "privacy page lacks verified legal operator/contact disclosures")
                        else:
                            require('id="remove"' in content and 'id="confirm"' in content and
                                    "reauthenticateWithPopup" in content and "Web sign-in is not configured yet" not in content,
                                    "web deletion page is not configured for self-service confirmation")
            except (OSError, ValueError):
                blockers.append(label + " URL verification failed")

    policy = timestamp(record.get("policyCheckedAt"))
    require(policy is not None and timedelta(0) <= now - policy <= timedelta(days=7), "policy check must be within the last seven days")
    play = record.get("play", {})
    require(play.get("accountType") == "personal" and play.get("newPersonalAccount") is True,
            "confirmed Play account is personal and created after 2023-11-13")
    for field in ("developerAccountVerified", "productionAccessGranted", "noConsoleBlockers"):
        require(play.get(field) is True, "Play " + field + " not verified")
    cohort = record.get("cohort", {})
    start, end = timestamp(cohort.get("startedAt")), timestamp(cohort.get("endedAt"))
    require(start is not None and end is not None and start <= end <= now and end - start >= timedelta(days=14), "closed cohort has not completed its required duration")
    require(type(cohort.get("continuousTesters")) is int and cohort["continuousTesters"] >= 12, "new personal account needs at least 12 continuous testers")
    require(cohort.get("noReleaseBlockers") is True, "closed cohort release blockers not cleared")

    signing = record.get("signing", {})
    pilot, upload = fingerprint(signing.get("pilotSha256")), fingerprint(signing.get("uploadSha256"))
    raw_signers = signing.get("playSha256", [])
    signers = [fingerprint(item) for item in raw_signers] if isinstance(raw_signers, list) else []
    require(pilot is not None and upload is not None and bool(signers) and all(signers), "pilot/upload/Play signing certificate inventory incomplete")
    require(upload is not None and upload != pilot and upload not in signers, "upload key must differ from app signing keys")
    require(pilot is not None and pilot in signers, "pilot signing identity absent from Play signing inventory")
    artifacts = record.get("artifacts", {})
    paths = {kind: file_ref(artifacts.get(kind), kind) for kind in ("aab", "playApk")}
    splits = artifacts.get("playSplits", [])
    require(isinstance(splits, list), "Play split APK inventory must be a list")
    if isinstance(splits, list):
        for index, ref in enumerate(splits):
            paths["split" + str(index)] = file_ref(ref, "Play split APK")
    for kind, path in paths.items():
        if not path:
            continue
        try:
            blockers.extend(kind + ": " + error for error in native_alignment(path, kind != "aab"))
            if kind == "aab":
                verified = run(["jarsigner", "-verify", str(path)])
                require("jar verified." in verified and "jar is unsigned" not in verified.lower() and
                        "unsigned entries" not in verified.lower(), "AAB JAR signature missing or invalid")
                cert = run(["keytool", "-printcert", "-jarfile", str(path)])
                digests = [fingerprint(value) for value in re.findall(r"SHA256:\s*([A-Fa-f0-9:]+)", cert)]
                require(upload is not None and upload in digests, "AAB upload signer mismatch")
                bundletool = os.environ.get("BUNDLETOOL_JAR")
                require(bool(bundletool), "BUNDLETOOL_JAR required for AAB manifest/structure validation")
                if bundletool:
                    run(["java", "-jar", bundletool, "validate", "--bundle=" + str(path)])
                    manifest = ET.fromstring(run(["java", "-jar", bundletool, "dump", "manifest", "--bundle=" + str(path), "--module=base"]))
                    ns = "{http://schemas.android.com/apk/res/android}"
                    require(manifest.get("package") == "com.bluegrain.smsrelay", "AAB package mismatch")
                    require(manifest.get(ns + "versionCode") == str(record.get("versionCode")), "AAB versionCode mismatch")
                    sdk = manifest.find("uses-sdk")
                    target = sdk.get(ns + "targetSdkVersion") if sdk is not None else None
                    require(target is not None and target.isdigit() and type(minimum) is int and int(target) >= minimum, "AAB target API below requirement")
            else:
                cert = run(["apksigner", "verify", "--verbose", "--print-certs", str(path)])
                digests = [fingerprint(value) for value in re.findall(
                    r"^Signer (?:#\d+|\([^\r\n]*\)) certificate SHA-256 digest:[ \t]*([A-Fa-f0-9]+)[ \t]*$",
                    cert, re.MULTILINE)]
                require(bool(digests) and all(value in signers for value in digests), "Play APK signer mismatch")
                manifest = run(["aapt", "dump", "badging", str(path)])
                require("package: name='com.bluegrain.smsrelay'" in manifest, "APK package mismatch")
                require("versionCode='" + str(record.get("versionCode")) + "'" in manifest, "APK versionCode mismatch")
                if kind == "playApk":
                    target = re.search(r"targetSdkVersion:'(\d+)'", manifest)
                    require(target is not None and type(minimum) is int and int(target[1]) >= minimum, "APK target API below requirement")
                require("application-debuggable" not in manifest, "APK is debuggable")
                require(not re.search(r"android.permission.(READ_SMS|RECEIVE_SMS|READ_CONTACTS|WRITE_CONTACTS|BIND_ACCESSIBILITY_SERVICE|BIND_NOTIFICATION_LISTENER_SERVICE)", manifest), "APK requests forbidden broad permissions")
        except (OSError, subprocess.SubprocessError, ValueError, zipfile.BadZipFile, struct.error, ET.ParseError):
            blockers.append(kind + ": required artifact tool or structural verification failed")

    for label in EVIDENCE:
        path = file_ref(record.get("evidence", {}).get(label), label)
        if not path:
            continue
        try:
            evidence = json.loads(path.read_text())
            require(evidence.get("result") == "passed" and evidence.get("commit") == commit and
                    evidence.get("aabSha256") == artifacts.get("aab", {}).get("sha256") and
                    evidence.get("apkSha256") == artifacts.get("playApk", {}).get("sha256") and
                    evidence.get("splitSha256") == [ref.get("sha256") for ref in splits], label + ": evidence does not attest to this exact candidate")
            if label == "finalCiAndReviews":
                cycles = evidence.get("reviewCycles", [])
                require(len(cycles) >= 5 and all(isinstance(cycle, dict) and cycle.get("findingsAddressed") is True and re.fullmatch(r"[0-9a-f]{40}", cycle.get("head") or "") for cycle in cycles), "five completed review/fix cycles missing")
            if label == "capacityCostRestore":
                checks = evidence.get("checks", {})
                require(isinstance(checks, dict) and all(checks.get(name) is True for name in RECOVERY_CHECKS),
                        "capacityCostRestore: capacity, backup, ledger and live restore checks incomplete")
        except (OSError, ValueError, AttributeError):
            blockers.append(label + ": invalid evidence JSON")

    if offline:
        blockers.append("offline mode cannot establish public URLs, issue completion or final CI")
    elif isinstance(commit, str) and re.fullmatch(r"[0-9a-f]{40}", commit):
        try:
            for number in range(5, 11):
                issue = json.loads(run(["gh", "issue", "view", str(number), "--repo", REPO, "--json", "state"]))
                require(issue.get("state") == "CLOSED", "production prerequisite issue #" + str(number) + " remains open")
            result = run(["gh", "api", "--paginate", f"repos/{REPO}/commits/{commit}/check-runs?per_page=100", "--jq", ".check_runs[] | {id,name,status,conclusion} | @json"])
            checks = {}
            for line in result.splitlines():
                check = json.loads(line)
                if check.get("id", 0) > checks.get(check.get("name"), {}).get("id", -1):
                    checks[check["name"]] = check
            require(REQUIRED_CI <= checks.keys(), "required CI checks missing on candidate commit")
            require(all(check.get("status") == "completed" and check.get("conclusion") in ("success", "skipped") for check in checks.values()) and all(checks.get(name, {}).get("conclusion") == "success" for name in REQUIRED_CI), "candidate CI is not green")
        except (OSError, subprocess.SubprocessError, ValueError, AttributeError, KeyError):
            blockers.append("live GitHub prerequisite/CI verification failed")
    return {"ready": not blockers, "commit": commit, "blockers": blockers,
            "checkedAt": now.isoformat(), "publicationPerformed": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--record", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--offline", action="store_true")
    args = parser.parse_args()
    try:
        record = json.loads(args.record.read_text())
        if not isinstance(record, dict):
            raise ValueError("record must be an object")
        report = check_record(record, args.record.resolve().parent, args.offline)
    except (OSError, ValueError, TypeError, AttributeError):
        parser.error("candidate record is unreadable or invalid")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print("Play readiness: " + ("READY" if report["ready"] else "BLOCKED") + "; " + str(len(report["blockers"])) + " blocker(s)")
    return 0 if report["ready"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
