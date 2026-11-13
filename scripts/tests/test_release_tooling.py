import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).parents[1] / 'check-release-tooling.py'
spec = importlib.util.spec_from_file_location('release_tooling', SCRIPT)
tooling = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tooling)


class ReleaseTooling(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.root = Path(self.folder.name) / 'candidate'
        for name in tooling.RELEASE_TOOLS:
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('current release safety tool\n')
        self.expected = tooling.hashes(self.root)

    def test_older_application_with_unchanged_release_tools_is_allowed(self):
        (self.root / 'old-application-version.txt').write_text('older tested application')
        tooling.verify(self.root, self.expected)

    def test_each_changed_or_missing_release_tool_blocks_candidate(self):
        for name in tooling.RELEASE_TOOLS:
            path = self.root / name
            original = path.read_bytes()
            with self.subTest(name=name):
                path.write_text('unsafe older release tool\n')
                with self.assertRaisesRegex(ValueError, name):
                    tooling.verify(self.root, self.expected)
                path.unlink()
                with self.assertRaisesRegex(ValueError, name):
                    tooling.verify(self.root, self.expected)
                path.write_bytes(original)

    def test_ledger_validator_and_assertion_dependencies_cannot_drift_independently(self):
        dependencies = ('server/src/security-ledger.ts', 'server/src/model.ts')
        for name in dependencies:
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('current ledger validation implementation\n')
        expected = tooling.hashes(self.root)
        for name in dependencies:
            path = self.root / name
            original = path.read_bytes()
            with self.subTest(name=name):
                try:
                    path.write_text('older implementation without the ledger checks\n')
                    with self.assertRaisesRegex(ValueError, name):
                        tooling.verify(self.root, expected)
                finally:
                    path.write_bytes(original)

    def test_matching_symlinked_file_or_directory_is_refused(self):
        path = self.root / tooling.RELEASE_TOOLS[0]
        outside = Path(self.folder.name) / 'outside-tool'
        outside.write_bytes(path.read_bytes())
        path.unlink()
        path.symlink_to(outside)
        with self.assertRaisesRegex(ValueError, 'symlinks'):
            tooling.verify(self.root, self.expected)
        path.unlink()
        path.write_bytes(outside.read_bytes())
        (self.root / 'scripts').rename(self.root / 'actual-scripts')
        (self.root / 'scripts').symlink_to(self.root / 'actual-scripts', target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'symlinks'):
            tooling.verify(self.root, self.expected)

    def test_incomplete_or_invalid_manifest_cannot_skip_release_tool_checks(self):
        for bad in ({}, [], {k: v for k, v in self.expected.items() if k != tooling.RELEASE_TOOLS[0]}):
            with self.subTest(manifest=bad), self.assertRaises(ValueError):
                tooling.verify(self.root, bad)

    def test_retained_verifier_survives_candidate_checkout_and_rejects_downgrade(self):
        retained = Path(self.folder.name) / 'check-release-tooling.py'
        manifest = Path(self.folder.name) / 'release-tooling.json'
        shutil.copyfile(SCRIPT, retained)
        subprocess.run([sys.executable, str(retained), 'snapshot', str(manifest), '--root', str(self.root)], check=True)
        self.assertEqual(json.loads(manifest.read_text()), self.expected)
        # The checked-out candidate cannot replace the verifier retained outside it.
        (self.root / 'scripts/check-release-tooling.py').write_text('raise SystemExit(0)\n')
        (self.root / 'scripts/deploy.sh').write_text('gcloud run services update-traffic --to-latest\n')
        result = subprocess.run([sys.executable, str(retained), 'verify', str(manifest)],
                                cwd=self.root, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('scripts/deploy.sh', result.stderr)
        self.assertIn('successful CI run on current main', result.stderr)
