import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { initializeApp, deleteApp, getApps } from 'firebase-admin/app';
import { getFirestore, Firestore } from 'firebase-admin/firestore';
import { Relay as TsRelay } from '../src/relay.js';
import { app as tsApp } from '../src/http.js';
import { telemetry } from '../src/telemetry.js';
const rust = process.env.RELAY_BACKEND === 'rust' ? await import('./rust-adapter.js') : undefined;
const Relay: typeof TsRelay = rust ? rust.RustRelay as unknown as typeof TsRelay : TsRelay;
const app: typeof tsApp = rust ? rust.rustApp as unknown as typeof tsApp : tsApp;

async function cleanupAll(actions: (() => unknown | Promise<unknown>)[], primary: unknown[] = []) {
  const failures = [...primary];
  for (const action of actions) {
    try { await action(); } catch (error) { failures.push(error); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Scenario and fixture cleanup failures');
}

test('authenticated concurrent workers bind actual committed claims and clear context on untraced retry', { timeout: 30000 }, async t => {
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST, 'local emulator required');
  const firebase = initializeApp({ projectId: 'demo-worker-context' }, 'worker-context'); const db = getFirestore(firebase);
  let httpDone!: () => void; const completed = new Promise<void>(resolve => { httpDone = resolve; });
  const records: any[] = [], original = telemetry.emit; telemetry.emit = (e, context) => { records.push({ ...e, ...(context ? { 'logging.googleapis.com/trace': context.trace } : {}) }); if(records.filter(r=>r.event==='http_completed'&&r.route==='/internal/delivery').length===4)httpDone(); };
  let time = 1_800_000_000_000, calls = 0, entered!: () => void, release!: () => void;
  const both = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const id = '1234567890abcdef1234567890abcdef', other = 'fedcba0987654321fedcba0987654321';
  const trace = `projects/demo-worker-context/traces/${id}`, cleared: unknown[] = [];
  const relay = new Relay(db, async token => {
    calls++; if (calls <= 2) { if (calls === 2) entered(); await held; throw Error('synthetic failed send'); }
    const jobs = await db.collection('deliveryOutbox').get(); const doc = jobs.docs.find(d => d.get('deviceId') === (token === 'fcm-a' ? 'phone-a' : 'phone-b'));
    assert.ok(doc); cleared.push(doc.get('claimTrace')); assert.equal(doc.get('claimTrace'), null);
  }, () => time);
  const collections = ['maintenancePages','deletionAttempts','deletionJobs','deletionReceipts','accounts','devices','grants','formRequests','requestEvents','deliveryOutbox'];
  let server: ReturnType<ReturnType<typeof app>['listen']> | undefined, first: Promise<Response> | undefined;
  const failures: unknown[] = [];
  try {
    assert.equal(firebase.options.projectId, 'demo-worker-context'); // Separate from relay.integration.test.ts recursive cleanup.
    for (const c of collections) await db.recursiveDelete(db.collection(c));
    await relay.register('owner', 'phone-a', 'A', 'fcm-a'); await relay.register('owner', 'phone-b', 'B', 'fcm-b');
    const grant = await relay.createGrant('owner', 'phone-a', 'Caller', 30); await relay.forms.approve('owner', grant.grantId, true);
    const form = await relay.forms.create(grant.token, { title: 'Trace contract', body: 'Local test.', fields: [], actions: [{id:'ok',label:'OK',type:'acknowledge'}], expiresInSeconds:60,idempotencyKey:'worker-trace-contract' });
    assert.ok(!JSON.stringify(form).includes('claimTrace'));
    server = app(relay, { projectId:'demo-worker-context', verifyOwner:async()=>({uid:'owner',authTime:time/1000}), verifyScheduler:async token=>{ if(token!=='worker')throw Error('reject'); }, deleteIdentity:async()=>{} }).listen(0,'127.0.0.1');
    await once(server,'listening'); const address=server.address();assert.ok(address&&typeof address!=='string');const url=`http://127.0.0.1:${address.port}/internal/delivery`;
    const request=(header?:string,token='worker')=>fetch(url,{method:'POST',headers:{authorization:`Bearer ${token}`,...(header?{traceparent:header}:{})},signal:AbortSignal.any([t.signal,AbortSignal.timeout(10000)])});
    const rejected=await request(`00-${id}-0000000000000001-00`,'bad');assert.equal(rejected.status,401);await rejected.text();
    first=request(`00-${id}-0000000000000001-00`);first.catch(()=>{});await Promise.race([both,new Promise<never>((_,reject)=>{const timer=setTimeout(()=>reject(Error('worker callbacks not reached')),8000);timer.unref();})]);
    const claimed=await db.collection('deliveryOutbox').get();assert.equal(claimed.size,2);for(const d of claimed.docs){assert.equal(d.get('claimTrace'),trace);assert.equal(d.get('attempts'),1);assert.equal(typeof d.get('lease'),'string');}
    const second=await request(`00-${other}-0000000000000001-00`);assert.equal(second.status,200);await second.text();
    const stable=await db.collection('deliveryOutbox').get();for(const d of stable.docs){assert.equal(d.get('claimTrace'),trace);assert.equal(d.get('lease'),claimed.docs.find(a=>a.id===d.id)!.get('lease'));assert.equal(d.get('attempts'),1);}
    release();const finished=await first;assert.equal(finished.status,200);await finished.text();
    time+=5000;const retry=await request('invalid-private-header');assert.equal(retry.status,200);await retry.text();assert.deepEqual(cleared,[null,null]);assert.equal((await db.collection('deliveryOutbox').get()).size,0);
    await Promise.race([completed,new Promise<never>((_,reject)=>{const timer=setTimeout(()=>reject(Error('HTTP completion records missing')),3000);timer.unref();})]);
    const http=records.filter(r=>r.event==='http_completed'&&r.route==='/internal/delivery');assert.equal(http.length,4);assert.equal(http.find(r=>r.status_class==='4xx')['logging.googleapis.com/trace'],undefined);assert.deepEqual(new Set(http.filter(r=>r['logging.googleapis.com/trace']).map(r=>r['logging.googleapis.com/trace'])),new Set([trace,`projects/demo-worker-context/traces/${other}`]));
    const claims=records.filter(r=>r.event==='delivery_lease_claimed');assert.equal(claims.length,4);assert.ok(claims.slice(0,2).every(r=>r['logging.googleapis.com/trace']===trace));assert.ok(claims.slice(2).every(r=>r['logging.googleapis.com/trace']===undefined));
    assert.ok(!JSON.stringify(claims).includes('owner'));assert.ok(!JSON.stringify(claims).includes('fcm-'));assert.ok(!JSON.stringify(claims).includes('private'));
  } catch (error) { failures.push(error); }
  finally {
    await cleanupAll([
      () => release(),
      () => first?.then(async response => { if (!response.bodyUsed) await response.text(); }),
      () => server?.closeAllConnections(),
      () => server && new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve())),
      () => { telemetry.emit = original; },
      ...collections.map(c => () => db.recursiveDelete(db.collection(c))),
      () => deleteApp(firebase),
    ], failures);
  }
});

test('cleanup continues through collection rejection and preserves primary and cleanup failures', { timeout: 2000 }, async () => {
  for (const primary of [undefined, Error('synthetic scenario failure')]) {
    const firebase = initializeApp({ projectId: 'demo-cleanup-failure' }, `cleanup-${Boolean(primary)}`);
    const calls: string[] = [], deletionFailure = Error('synthetic collection failure');
    try {
      await assert.rejects(cleanupAll([
        ...['first', 'rejected', 'last'].map(collection => async () => { calls.push(collection); if (collection === 'rejected') throw deletionFailure; }),
        async () => { calls.push('app'); await deleteApp(firebase); },
      ], primary ? [primary] : []), error => {
        if (primary) { assert.ok(error instanceof AggregateError); assert.deepEqual(error.errors, [primary, deletionFailure]); }
        else assert.equal(error, deletionFailure);
        return true;
      });
      assert.deepEqual(calls, ['first', 'rejected', 'last', 'app']);
      assert.ok(!getApps().includes(firebase));
    } finally { if (getApps().includes(firebase)) await deleteApp(firebase); }
  }
});

test('Rust project binding requires exact registered client identity and explicit demo configuration', { skip: !rust, timeout: 2000 }, async () => {
  if (!rust) return;
  const registered = initializeApp({ projectId: 'demo-project-binding' }, 'project-binding');
  const missing = initializeApp({}, 'project-missing');
  const invalid = initializeApp({ projectId: 'untrusted-project' }, 'project-invalid');
  const unregistered = new Firestore({ projectId: 'demo-project-binding' });
  try {
    assert.equal(rust.projectFor(getFirestore(registered)), 'demo-project-binding');
    assert.throws(() => rust.projectFor(unregistered), /explicit demo app project/);
    assert.throws(() => rust.projectFor(getFirestore(missing)), /explicit demo app project/);
    assert.throws(() => rust.projectFor(getFirestore(invalid)), /explicit demo app project/);
  } finally { await cleanupAll([() => unregistered.terminate(), ...[registered, missing, invalid].map(app => () => deleteApp(app))]); }
});
