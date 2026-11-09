#!/usr/bin/env python3
"""Opt-in emulator SMS feasibility check. Uses no owner account or production API.

Build first: cd android && ./gradlew assembleDebug assembleDebugAndroidTest
Run: ANDROID_SERIAL=emulator-5584 ANDROID_HOME=/path/to/sdk python3 scripts/test-sms-injection.py
"""
import json
import os
from pathlib import Path
import queue
import subprocess
import threading
import time

root = Path(__file__).resolve().parent.parent
serial = os.environ.get('ANDROID_SERIAL', '')
if not serial.startswith('emulator-'):
    raise SystemExit('Set ANDROID_SERIAL to an isolated Android emulator; physical phones are refused')
adb = str(Path(os.environ['ANDROID_HOME']) / 'platform-tools/adb')


def command(*args):
    return subprocess.run([adb, '-s', serial, *args], capture_output=True, text=True, timeout=30, check=True).stdout


if command('shell', 'getprop', 'ro.kernel.qemu').strip() != '1':
    raise SystemExit('Refusing device without emulator hardware')
for apk in ['debug/app-debug.apk', 'androidTest/debug/app-debug-androidTest.apk']:
    command('install', '-r', str(root / 'android/app/build/outputs/apk' / apk))
process = subprocess.Popen([adb, '-s', serial, 'shell', 'am', 'instrument', '-w', '-r',
    '-e', 'class', 'com.bluegrain.smsrelay.SmsInjectionTest', '-e', 'smsInjection', 'true',
    'com.bluegrain.smsrelay.test/androidx.test.runner.AndroidJUnitRunner'],
    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
lines = queue.Queue()


def read_output():
    for line in process.stdout:
        lines.put(line.rstrip())
    lines.put(None)


threading.Thread(target=read_output, daemon=True).start()
result = {'simulatedSms': True, 'productionRelayUsed': False, 'physicalPhoneTest': False,
          'realPlayServicesApi': True,
          'listenerReady': False, 'smsInjected': False, 'systemConsentOpened': False,
          'approvedCodeExtracted': False, 'passed': False}
output = []
deadline = time.monotonic() + 140
try:
    while time.monotonic() < deadline:
        try:
            line = lines.get(timeout=1)
        except queue.Empty:
            continue
        if line is None:
            break
        output.append(line)
        if 'smsProbeStage=ready_for_injection' in line:
            result['listenerReady'] = True
            command('emu', 'sms', 'send', '+16505550123', 'Your relay verification code is 482619.')
            result['smsInjected'] = True
            print('Listener ready; synthetic SMS injected', flush=True)
        elif 'smsProbeStage=consent_opened' in line:
            result['systemConsentOpened'] = True
            print('System consent opened', flush=True)
        elif 'smsProbeStage=approved_code_extracted' in line:
            result['approvedCodeExtracted'] = True
            print('Approved synthetic code extracted', flush=True)
    if process.poll() is None:
        process.terminate()
        command('shell', 'am', 'force-stop', 'com.bluegrain.smsrelay')
    result['passed'] = result['approvedCodeExtracted'] and any('OK (1 test)' in line for line in output)
    record = root / 'artifacts/sms-injection-verification.json'
    record.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))
    if not result['passed']:
        # The probe never logs the message, code, credentials or owner data.
        for line in output:
            if 'AssertionError:' in line or 'Exception:' in line:
                print(line)
        raise SystemExit(1)
finally:
    if process.poll() is None:
        process.terminate()
