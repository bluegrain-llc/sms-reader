#!/usr/bin/env python3
"""Keep an older tested candidate from downgrading the release safety checks."""
import argparse
import hashlib
import json
from pathlib import Path
import stat


RELEASE_TOOLS = (
    'scripts/check-release-prerequisites.py',
    'scripts/build-pilot.sh',
    'scripts/verify-cloud-config.py',
    'scripts/release-config.py',
    'scripts/verify-release.py',
    'scripts/deploy.sh',
    'scripts/deploy.py',
    'scripts/check-security-ledger.ts',
    'server/src/security-ledger.ts',
    'server/src/model.ts',
    'scripts/release-smoke.mjs',
)


def hashes(root):
    result = {}
    for name in RELEASE_TOOLS:
        path = root / name
        if any((root / parent).is_symlink() for parent in Path(name).parents) or path.is_symlink():
            raise ValueError('Release tooling must not use symlinks: ' + name)
        if not path.exists() or not stat.S_ISREG(path.stat().st_mode):
            raise ValueError('Missing regular release tool: ' + name)
        result[name] = hashlib.sha256(path.read_bytes()).hexdigest()
    return result


def verify(root, expected):
    if not isinstance(expected, dict) or set(expected) != set(RELEASE_TOOLS):
        raise ValueError('Invalid release tooling manifest')
    actual = hashes(root)
    changed = [name for name in RELEASE_TOOLS if actual[name] != expected[name]]
    if changed:
        raise ValueError('Candidate release tooling differs from the workflow revision: '
                         + ', '.join(changed) + '. Select a successful CI run on current main.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=('snapshot', 'verify'))
    parser.add_argument('manifest', type=Path)
    parser.add_argument('--root', type=Path, default=Path.cwd())
    args = parser.parse_args()
    if args.operation == 'snapshot':
        args.manifest.write_text(json.dumps(hashes(args.root), indent=2) + '\n')
    else:
        verify(args.root, json.loads(args.manifest.read_text()))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError) as error:
        raise SystemExit(str(error)) from None
