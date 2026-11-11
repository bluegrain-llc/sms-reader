#!/usr/bin/env python3
"""Synthetic process-transport fixture. It never reads a credential store."""
import json
import sys
request = json.load(sys.stdin)
assert request.get('profile') == 'conformance'
assert request.get('connectionId') == 'public-connection'
assert not any(key in request for key in ('token', 'serviceToken', 'privateKey'))
operation = request['operation']
if operation == 'status':
    json.dump({'ok': True, 'value': {'capabilities': ['forms'], 'expiresAt': None, 'setup': 'setup_complete'}}, sys.stdout)
elif operation == 'requestSms':
    json.dump({'ok': False, 'error': 'sms_approval_required'}, sys.stdout)
    sys.exit(1)
else:
    sys.exit(2)
