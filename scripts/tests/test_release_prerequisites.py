import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import unittest


SCRIPT = Path(__file__).parents[1] / 'check-release-prerequisites.py'
spec = importlib.util.spec_from_file_location('release_prerequisites', SCRIPT)
prerequisites = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prerequisites)


class ReleasePrerequisites(unittest.TestCase):
    def setUp(self):
        self.env = {name: 'private-fixture-value' for name in
                    (*prerequisites.REQUIRED_VARIABLES, *prerequisites.REQUIRED_SECRETS)}

    def test_complete_configuration_allows_optional_region_and_service_defaults(self):
        prerequisites.validate(self.env)

    def test_every_missing_or_blank_setting_blocks_release_without_values(self):
        for name in self.env:
            for value in (None, '', '  \n'):
                with self.subTest(name=name, value=value):
                    env = dict(self.env)
                    if value is None:
                        del env[name]
                    else:
                        env[name] = value
                    with self.assertRaisesRegex(ValueError, name) as error:
                        prerequisites.validate(env)
                    self.assertNotIn('private-fixture-value', str(error.exception))

    def test_reports_all_missing_names_together(self):
        with self.assertRaises(ValueError) as error:
            prerequisites.validate({})
        for name in self.env:
            self.assertIn(name, str(error.exception))

    def test_command_fails_without_configuration_and_never_prints_secrets(self):
        env = {'PATH': os.environ.get('PATH', ''), **self.env}
        del env['GCP_WORKLOAD_IDENTITY_PROVIDER']
        result = subprocess.run([sys.executable, str(SCRIPT)], env=env,
                                capture_output=True, text=True, check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('GCP_WORKLOAD_IDENTITY_PROVIDER', result.stderr)
        self.assertNotIn('private-fixture-value', result.stdout + result.stderr)
        env['GCP_WORKLOAD_IDENTITY_PROVIDER'] = self.env['GCP_WORKLOAD_IDENTITY_PROVIDER']
        result = subprocess.run([sys.executable, str(SCRIPT)], env=env,
                                capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout + result.stderr, '')
