#!/usr/bin/env python3
"""Direct Python SDK driver for synthetic relay conformance tests."""
import json, subprocess, sys
from request_relay import ServiceSession
r=json.load(sys.stdin)
class Storage:
 def invoke(self,operation,state=None):
  value=subprocess.run([r['storageCommand']],input=json.dumps({'operation':operation,'profile':r['profile'],**({'state':state} if operation=='save' else {})}),capture_output=True,text=True,timeout=30,check=True)
  result=json.loads(value.stdout)
  assert result['ok']
  return result.get('state')
 def load(self):return self.invoke('load')
 def save(self,state):self.invoke('save',state)
def execute():
 store=Storage();state=store.load();op=r['operation'];i=r.get('input') or {}
 s=ServiceSession.create(r['relayUrl'],i['name'],i['purpose'],store,capabilities=i.get('capabilities'),allow_http_loopback=True) if op=='startRegistration' and not state else ServiceSession.resume(store,allow_http_loopback=True)
 if op=='startRegistration':return s.start_registration()
 if op=='pollRegistration':
  v=s.client.request('/v3/registration-sessions/current',s.state['registrationToken'])
  if v['status']=='approved':
   s.state.update(serviceId=v['serviceId'],servicePath=v['servicePath'],registered=True);s.save();s.consume_deliveries()
  return v
 if op=='listConnections':return list(s.state['connections'])
 if op=='permanentLink':return s.permanent_link()
 if op in ('startPairing','restartPairing'):
  f=s.start_pairing if op=='startPairing' else s.restart_pairing
  return f(capabilities=i.get('capabilities'),expires_in_days=i.get('expiresInDays'),external_account_ref=i.get('externalAccountRef'))
 if op=='pollPairing':
  v=s.client.request('/v3/service/pairing-sessions/'+s.state['pairing']['sessionId'],s.state['serviceToken'])
  if v['status']=='approved':
   s.consume_deliveries()
   if s.state['connections'].get(v.get('connectionId')):
    s.state.update(pairing=None,pairingInput=None);s.save()
  return v
 if op=='waitForRegistration':return s.wait_for_registration()
 if op=='waitForPairing':return s.wait_for_pairing()
 if op=='consumeDeliveries':return s.consume_deliveries()
 if op=='rotateCredential':s.rotate_credential();return None
 if op=='rotateKey':s.rotate_key(i.get('retireKeyId'));return None
 if op=='resume':
  if s.state.get('nextServiceToken'):s.rotate_credential()
  if s.state.get('nextKey'):s.rotate_key()
  s.consume_deliveries();return {'status':'registered','connectionIds':list(s.state['connections'])}
 c=s.connection(r['connectionId'])
 name=''.join('_'+v.lower() if v.isupper() else v for v in op)
 f=getattr(c,name)
 if op in ('status','webhooks'):return f()
 if op in ('getForm','formResult','cancelForm','getSms','cancelSms','deleteWebhook'):return f(i['id'])
 if op=='events':return f(i.get('cursor'))
 return f(i)
try:print(json.dumps({'ok':True,'value':execute()}))
except Exception:print('{"ok":false}')
