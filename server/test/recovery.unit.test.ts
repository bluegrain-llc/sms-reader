import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { applyDenials, digestRows, selectMetadata, type Snapshot } from '../src/recovery.js';
import { securityLedger, validateLedger, type RecoveryObjects } from '../src/security-ledger.js';
const now = 1800000000000;
function snapshot(): Snapshot {
 const rows: Snapshot['rows'] = [
  { collection: 'accounts', id: 'owner', value: {} },
  { collection: 'devices', id: 'phone', value: { id: 'phone', ownerId: 'owner', fcmToken: 'synthetic', activeRequestId: 'stale', listenerUntil: 999, paused: false } },
  { collection: 'grants', id: 'caller', value: { id: 'caller', ownerId: 'owner', expiresAt: now+1000, revoked: false, formsApproved: true, webhooks: [{id:'hook',url:'https://example.test',secret:'synthetic',events:[]}] } },
 ];
 return { version:1, project:'test', ledgerBucket:'test-ledger', startedAt:now-1000, completedAt:now, rows, sha256:digestRows(rows) };
}
const intent = (kind: string, target: string, extra={}) => ({version:1,id:randomUUID(),at:now,ownerId:'owner',kind,target,...extra});
test('snapshot allowlist excludes transient SMS answers, request pointers, and injected nested webhook payloads', () => {
 assert.deepEqual(selectMetadata('accounts',{deleting:true,code:'123456',queueIds:['request'],formListenerUntil:999}),{deleting:true});
 const g=selectMetadata('grants',{id:'caller',answers:{code:'123456'},webhooks:[{id:'hook',secret:'synthetic',body:'secret'}]});
 assert.deepEqual(g,{id:'caller',webhooks:[{id:'hook',secret:'synthetic'}]});
});
test('restore applies denials after snapshot and clears live-session pointers', () => {
 const s=snapshot(); const output=applyDenials(s,[intent('grant.revoke','caller'),intent('device.pause','phone'),intent('webhook.delete','hook',{grantId:'caller'})],now);
 const g=output.rows.find(r=>r.id==='caller')!.value, d=output.rows.find(r=>r.id==='phone')!.value;
 assert.equal(g.revoked,true);assert.deepEqual(g.webhooks,[]);assert.equal(g.eventSequence,0);assert.equal(d.paused,true);assert.equal(d.activeRequestId,null);assert.equal(d.listenerUntil,0);
});
test('deletion wins regardless of intent order and produces identity cleanup list', () => {
 const output=applyDenials(snapshot(),[intent('account.delete','owner'),intent('grant.revoke','caller')],now);
 assert.deepEqual(output.rows,[{collection:'accounts',id:'owner',value:{deleting:true}}]);assert.deepEqual(output.deleted,['owner']);
});
test('restore rejects malformed ledger, corrupt snapshots and orphan owner metadata', () => {
 assert.throws(()=>applyDenials(snapshot(),[{}],now));
 assert.throws(()=>applyDenials({...snapshot(),sha256:'0'.repeat(64)},[],now));
 const s=snapshot();s.rows=s.rows.filter(r=>r.collection!=='accounts');s.sha256=digestRows(s.rows);assert.throws(()=>applyDenials(s,[],now));
});
test('missing independent ledger configuration fails closed', async () => {
 await assert.rejects(securityLedger(undefined)({ownerId:'owner',kind:'account.delete',target:'owner'}), /security_ledger_not_configured/);
});
test('ledger preflight requires source binding, locked retention, and private bucket access', async () => {
 const marker={version:1,project:'synthetic-source',createdAt:now};
 const policy={retentionPolicy:{isLocked:true,retentionPeriod:'604800'},iamConfiguration:{uniformBucketLevelAccess:{enabled:true},publicAccessPrevention:'enforced'}};
 const objects=(m:unknown,p:unknown)=>({get:async()=>m,info:async()=>p}) as unknown as RecoveryObjects;
 await validateLedger(objects(marker,policy),'synthetic-source');
 await assert.rejects(validateLedger(objects({...marker,project:'other-source'},policy),'synthetic-source'),/ledger_project_mismatch/);
 for(const invalid of [
   {...policy,retentionPolicy:{isLocked:false,retentionPeriod:'604800'}},
   {...policy,retentionPolicy:{isLocked:true,retentionPeriod:'86400'}},
   {...policy,iamConfiguration:{...policy.iamConfiguration,publicAccessPrevention:'inherited'}},
   {...policy,iamConfiguration:{...policy.iamConfiguration,uniformBucketLevelAccess:{enabled:false}}},
 ]) await assert.rejects(validateLedger(objects(marker,invalid),'synthetic-source'));
});
