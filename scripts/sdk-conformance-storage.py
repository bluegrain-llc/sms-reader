#!/usr/bin/env python3
"""Synthetic private storage hook used only by the emulator conformance harness."""
import json, os, sys, tempfile
from pathlib import Path
r=json.load(sys.stdin)
p=Path(os.environ['RELAY_TEST_STORAGE_DIR'])/(r['profile']+'.json')
if r['operation']=='load':
 print(json.dumps({'ok':True,'state':json.loads(p.read_text()) if p.exists() else None}))
elif r['operation']=='save':
 if os.environ.get('RELAY_TEST_FAIL_SAVE')=='1':sys.exit(1)
 fd,name=tempfile.mkstemp(dir=p.parent)
 try:
  with os.fdopen(fd,'w') as f:
   json.dump(r['state'],f);f.flush();os.fsync(f.fileno())
  os.replace(name,p)
  fd=os.open(p.parent,os.O_RDONLY)
  try:os.fsync(fd)
  finally:os.close(fd)
 finally:
  if os.path.exists(name):os.unlink(name)
 print('{"ok":true}')
else:
 sys.exit(2)
