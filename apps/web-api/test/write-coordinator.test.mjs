import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, rm, link, symlink } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { WriteCoordinator } from '../dist/write-coordinator.js';
import { checkedRecoverySubject, recoveryDigest } from '../dist/recovery-subject.js';

const repo=fileURLToPath(new URL('../../../',import.meta.url));
const reply=(outcome='claimed',recoveryRequired=false)=>({schema:'lmti.web.broker.guard.v1',outcome,recoveryRequired});
const domainId='a'.repeat(64);
const subject=(project='project',target={original:'fixture'})=>checkedRecoverySubject({version:1,kind:'legacy',action:'profile_save',projectId:project,grantId:domainId,target});
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
// Coordinator tests use a typed in-memory marker adapter. Real fixed-helper
// Win32 process/lock tests live with broker-guard; no OS claim is made here.
function fakeGuard(library,run=async()=>reply(),hooks={}) {
  let stopped=false,admitted=false;
  let state=hooks.initialState===undefined?{generation:1,domainId,coverage:'complete',entries:[]}:hooks.initialState;
  const events=[];
  const change=entries=>{state={...state,generation:state.generation+1,entries};};
  const mutate=async(action,body)=>{
    assert.equal(stopped,false,'guard stopped before metadata drained');
    try { assert.equal(admitted,true,'metadata mutation requires a current claim');await hooks[`before_${action}`]?.();body();events.push(action);await hooks[`after_${action}`]?.();return state; }
    catch(error){admitted=false;throw error;}
  };
  return {
    config:{library,domainId},events,
    isAdmitted:()=>admitted&&!stopped,recoveryState:()=>state,
    async claim(){const result=await run();if(!stopped)admitted=result.outcome==='claimed';return result;},
    retain:entry=>mutate('retain',()=>{assert.ok(!state.entries.some(e=>e.id===entry.id));change([...state.entries,entry]);}),
    forgetKnown:entry=>mutate('forget',()=>change(state.entries.filter(e=>e.id!==entry.id))),
    acknowledge:expected=>mutate('ack',()=>{
      assert.equal(expected.generation,state.generation);
      assert.equal(recoveryDigest(expected.entries),recoveryDigest(state.entries));
      change([]);
    }),
    stop(){stopped=true;events.push('stop');},async waitForIdle(){},
  };
}
async function fixture(t) {
  await mkdir(join(repo,'build'),{recursive:true});
  const root=await mkdtemp(join(repo,'build/write-coordinator-'));
  const library=join(root,'library.sqlite'),python=join(root,'python.exe'),helper=join(root,'web-broker-guard.py');
  const baseline=Buffer.from('controlled domain bytes, never interpreted by coordinator');
  await Promise.all([writeFile(library,baseline),writeFile(python,'fixture'),writeFile(helper,'fixture')]);
  const coordinators=[],leases=[],unblock=[];
  t.after(async()=>{
    for(const release of unblock)release();
    for(const lease of leases)lease.release('known');
    await Promise.all(coordinators.map(c=>c.close()));
    assert.deepEqual(await readFile(library),baseline);
    assert.ok(resolve(root).startsWith(resolve(repo,'build')+sep));
    await rm(root,{recursive:true,force:true});
  });
  return {
    root,library,
    async create(guard,clock,options={domainId}){const c=await WriteCoordinator.create(library,guard,clock,options);coordinators.push(c);return c;},
    lease(c,mode='shared',project='project',epoch=c.snapshot().epoch,custom){const s=custom??(project===null?checkedRecoverySubject({version:1,kind:'project_operations',action:'library-upgrade-v1',projectId:null,grantId:domainId,target:{library:'fixture'}}):subject(project));const l=c.acquire(mode,project,epoch,s);leases.push(l);return l;},
    guard(run){return fakeGuard(library,run);},
    unblock(callback){unblock.push(callback);},
  };
}
test('shared project leases and exclusive library lease refuse contention synchronously',async t=>{
  const f=await fixture(t),c=await f.create(),epoch=c.snapshot().epoch;
  const a=f.lease(c,'shared','one'),b=f.lease(c,'shared','two');
  assert.equal(c.snapshot().activeLeases,2);
  for(const [mode,project] of [['shared','one'],['exclusive','three'],['exclusive',null]])
    assert.throws(()=>c.acquire(mode,project,epoch),{code:'BUSY'});
  assert.throws(()=>c.acquire('shared',null,epoch),{code:'INVALID_INPUT'});
  a.release('known');b.release('known');
  const exclusive=f.lease(c,'exclusive',null);
  assert.throws(()=>c.acquire('shared','three',epoch),{code:'BUSY'});
  assert.equal(c.snapshot().activeLeases,1);
  exclusive.release('known');
  assert.equal(c.snapshot().activeLeases,0);assert.equal(c.snapshot().epoch,epoch);
});
test('same canonical parent refuses duplicate service scopes until explicit close',async t=>{
  const f=await fixture(t),c=await f.create();
  await assert.rejects(WriteCoordinator.create(f.library),{code:'BUSY'});
  const sibling=join(f.root,'other-library.sqlite');await writeFile(sibling,'other controlled fixture');
  await assert.rejects(WriteCoordinator.create(sibling),{code:'BUSY'});
  if(process.platform==='win32')
    await assert.rejects(WriteCoordinator.create(f.library.toUpperCase()),{code:'BUSY'});
  await c.close();
  const reopened=await f.create();assert.equal(reopened.snapshot().admitted,true);
});
test('scope validation failure does not reserve a scope and hardlink aliases are refused',async t=>{
  const f=await fixture(t);
  await assert.rejects(WriteCoordinator.create(`${f.root}${sep}..${sep}outside.sqlite`),{code:'OWNER_UNAVAILABLE'});
  const alias=join(f.root,'alias.sqlite');await link(f.library,alias);
  try { await assert.rejects(WriteCoordinator.create(f.library),{code:'OWNER_UNAVAILABLE'}); }
  finally { await rm(alias); }
  assert.equal((await f.create()).snapshot().admitted,true);
});
test('scope paths refuse raw special components and redirected parents before admission',async t=>{
  const f=await fixture(t);
  for(const leaf of ['NUL.sqlite','com1.db','trailing.','space ','stream:extra','wild*.sqlite','q?.sqlite','pipe|.sqlite']) {
    await assert.rejects(WriteCoordinator.create(`${f.root}${sep}${leaf}`),{code:'OWNER_UNAVAILABLE'});
  }
  const redirected=join(f.root,'redirected'),target=join(f.root,'real-parent');
  await mkdir(target);await writeFile(join(target,'library.sqlite'),'unchanged target');
  await symlink(target,redirected,process.platform==='win32'?'junction':'dir');
  try {
    await assert.rejects(WriteCoordinator.create(join(redirected,'library.sqlite')),{code:'OWNER_UNAVAILABLE'});
    assert.equal(await readFile(join(target,'library.sqlite'),'utf8'),'unchanged target');
  } finally { await rm(redirected); }
  const c=await f.create();assert.equal(c.snapshot().admitted,true);
});
test('lease count is bounded and duplicate release cannot change a latched outcome',async t=>{
  const f=await fixture(t),c=await f.create(),epoch=c.snapshot().epoch;
  const held=Array.from({length:32},(_,i)=>f.lease(c,'shared','project-'+i));
  assert.throws(()=>c.acquire('shared','extra',epoch),{code:'BUSY'});
  for(const lease of held)lease.release('known');
  held[0].release('unknown');
  assert.equal(c.snapshot().recoveryRequired,false);assert.equal(c.snapshot().activeLeases,0);
});
test('unknown survives session cleanup and waits for every existing lease before recovery',async t=>{
  const f=await fixture(t),c=await f.create(),epoch=c.snapshot().epoch;
  const sessions=new Map([['session',{previewEpoch:epoch}]]);
  const first=f.lease(c,'shared','one'),second=f.lease(c,'shared','two');
  first.release('unknown');sessions.clear();
  assert.equal(c.snapshot().recoveryRequired,true);assert.ok(c.snapshot().epoch>epoch);
  assert.throws(()=>c.acquire('shared','three',epoch),{code:'RECOVERY_REQUIRED'});
  assert.throws(()=>c.beginReconciliation(),{code:'BUSY'});
  second.release('known');first.release('known');
  assert.equal(c.snapshot().recoveryRequired,true);
  const token=c.beginReconciliation();
  // This explicit fixture read stands in for strict owner reconciliation.
  assert.ok((await readFile(f.library)).length>0);
  await c.acknowledge(token);
  assert.equal(c.snapshot().recoveryRequired,false);
  assert.throws(()=>c.acquire('shared','one',epoch),{code:'CONFIG_CHANGED'});
  f.lease(c,'shared','one').release('known');
});
test('reconciliation requires exact fresh token and explicit acknowledgment, never a read alone',async t=>{
  let now=1000;
  const f=await fixture(t),c=await f.create(undefined,()=>now);
  f.lease(c).release('unknown');
  const first=c.beginReconciliation();
  assert.ok(Object.isFrozen(first));
  await assert.rejects(()=>c.acknowledge({...first}),{code:'CONFIG_CHANGED'});
  await assert.rejects(()=>c.acknowledge(null),{code:'CONFIG_CHANGED'});
  const second=c.beginReconciliation();
  await assert.rejects(()=>c.acknowledge(first),{code:'CONFIG_CHANGED'});
  now=second.expiresAt;
  await assert.rejects(()=>c.acknowledge(second),{code:'PREVIEW_EXPIRED'});
  assert.equal(c.snapshot().recoveryRequired,true);
  const current=c.beginReconciliation();
  assert.ok((await readFile(f.library)).length>0); // Observation cannot clear the gate.
  assert.equal(c.snapshot().recoveryRequired,true);
  await c.acknowledge(current);
  await assert.rejects(()=>c.acknowledge(current),{code:'CONFIG_CHANGED'});
  f.lease(c).release('unknown');
  await assert.rejects(()=>c.acknowledge(current),{code:'CONFIG_CHANGED'});
  await c.acknowledge(c.beginReconciliation());
});
test('close fences admission, retains registry and drains live leases before returning',async t=>{
  const f=await fixture(t),c=await f.create(),lease=f.lease(c);
  let finished=false;
  const closing=c.close();assert.equal(c.close(),closing);
  void closing.then(()=>{finished=true;});
  await delay(20);
  assert.equal(finished,false);
  assert.equal(c.snapshot().stopped,true);
  assert.throws(()=>c.acquire('shared','next',c.snapshot().epoch),{code:'OWNER_UNAVAILABLE'});
  await assert.rejects(WriteCoordinator.create(f.library),{code:'BUSY'});
  lease.release('known');await closing;
  assert.equal(finished,true);assert.equal((await f.create()).snapshot().admitted,true);
});
test('same-process recreation inherits unknown barrier even without an optional restart guard',async t=>{
  const f=await fixture(t),first=await f.create();
  f.lease(first).release('unknown');const oldEpoch=first.snapshot().epoch;
  await first.close();
  const second=await f.create();
  assert.equal(second.snapshot().admitted,true);assert.equal(second.snapshot().recoveryRequired,true);
  assert.ok(second.snapshot().epoch>oldEpoch);
  assert.throws(()=>second.acquire('exclusive',null,second.snapshot().epoch),{code:'RECOVERY_REQUIRED'});
  await second.acknowledge(second.beginReconciliation());
  await second.close();
  assert.equal((await f.create()).snapshot().recoveryRequired,false);
});
test('stop invalidates a reconciliation token and cannot be reset by acknowledge',async t=>{
  const f=await fixture(t),c=await f.create();f.lease(c).release('unknown');
  const token=c.beginReconciliation();c.stop();
  await assert.rejects(()=>c.acknowledge(token),{code:'OWNER_UNAVAILABLE'});
  assert.deepEqual(await c.claim(),reply('unavailable',true));
  await c.close();
  const next=await f.create();await next.acknowledge(next.beginReconciliation());
});
test('guard busy/unavailable stays closed until an explicit claim succeeds',async t=>{
  const f=await fixture(t);let calls=0;
  const responses=[reply('busy',true),reply('unavailable',true),reply('claimed',true)];
  const c=await f.create(f.guard(async()=>responses[calls++]));
  assert.equal(calls,1);assert.equal(c.snapshot().admitted,false);
  assert.throws(()=>c.acquire('exclusive',null,c.snapshot().epoch),{code:'RECOVERY_REQUIRED'});
  await delay(20);assert.equal(calls,1);
  assert.deepEqual(await c.claim(),reply('unavailable',true));assert.equal(c.snapshot().admitted,false);
  assert.deepEqual(await c.claim(),reply('claimed',true));
  assert.equal(c.snapshot().recoveryRequired,true);
  await c.acknowledge(c.beginReconciliation());
  f.lease(c).release('known');
});

test('two concurrent unknown subjects survive session cleanup and recreation as a full immutable union',async t=>{
  const f=await fixture(t),c=await f.create();
  const raw={version:1,kind:'legacy',action:'client_apply',projectId:'one',grantId:domainId,
    target:{root:'original-root',client:'codex',identity:{store:'original'}}};
  const a=f.lease(c,'shared','one',c.snapshot().epoch,raw);
  const b=f.lease(c,'shared','two',c.snapshot().epoch,subject('two',{root:'second-root'}));
  raw.target.root='substituted';raw.target.identity.store='different';
  a.release('unknown');b.release('unknown');
  const first=c.recovery();
  assert.equal(first.subjects.length,2);assert.equal(first.coverage,'complete');
  assert.equal(first.subjects.find(e=>e.subject.projectId==='one').subject.target.root,'original-root');
  assert.ok(Object.isFrozen(first.subjects[0].subject.target));
  await c.close();
  const reopened=await f.create(),second=reopened.recovery();
  assert.equal(second.digest,first.digest);assert.deepEqual(second.subjects,first.subjects);
  assert.ok(second.generation>first.generation);
  const token=reopened.beginReconciliation();
  await assert.rejects(()=>reopened.acknowledge({...token,digest:recoveryDigest([second.subjects[0]])}),{code:'CONFIG_CHANGED'});
  assert.equal(reopened.recovery().subjects.length,2);
  await reopened.acknowledge(token);assert.equal(reopened.recovery().subjects.length,0);
});

test('missing compatibility subject and null restart provenance cannot acknowledge an empty set',async t=>{
  const f=await fixture(t),c=await f.create();
  c.acquire('shared','project',c.snapshot().epoch).release('unknown');
  assert.equal(c.recovery().coverage,'missing');
  assert.throws(()=>c.beginReconciliation(),{code:'RECOVERY_REQUIRED'});
  await c.close();
  const reopened=await f.create();
  assert.equal(reopened.recovery().coverage,'missing');
  assert.throws(()=>reopened.beginReconciliation(),{code:'RECOVERY_REQUIRED'});
  await reopened.close();
  const separate=await fixture(t),guard=fakeGuard(separate.library,async()=>reply('claimed',true),{initialState:null});
  const blocked=await separate.create(guard);
  assert.equal(blocked.recovery().coverage,'missing');
  assert.throws(()=>blocked.beginReconciliation(),{code:'RECOVERY_REQUIRED'});
});

test('changed explicit domain cannot acknowledge retained originals; correct domain can recover later',async t=>{
  const f=await fixture(t),c=await f.create();f.lease(c).release('unknown');
  const original=c.recovery();await c.close();
  const changed=await f.create(undefined,undefined,{domainId:'b'.repeat(64)});
  assert.equal(changed.recovery().coverage,'unverifiable');
  assert.equal(changed.recovery().digest,original.digest);
  assert.throws(()=>changed.beginReconciliation(),{code:'RECOVERY_REQUIRED'});
  await changed.close();
  const restored=await f.create();assert.equal(restored.recovery().coverage,'complete');
  await restored.acknowledge(restored.beginReconciliation());
});

test('same-parent different library never substitutes for retained original scope',async t=>{
  const f=await fixture(t),c=await f.create();f.lease(c).release('unknown');await c.close();
  const sibling=join(f.root,'replacement-library.sqlite');await writeFile(sibling,'separate fixture');
  const changed=await WriteCoordinator.create(sibling,undefined,Date.now,{domainId});
  try {
    assert.equal(changed.recovery().coverage,'unverifiable');
    assert.throws(()=>changed.beginReconciliation(),{code:'RECOVERY_REQUIRED'});
  } finally {await changed.close();}
  const restored=await f.create();await restored.acknowledge(restored.beginReconciliation());
});

test('full subject byte budget is reserved before admission and never evicts a retained entry',async t=>{
  const f=await fixture(t),c=await f.create(),held=[];
  // 30 KiB metadata per subject; aggregate framing, not only count, is bounded.
  for(let i=0;i<7;i++)held.push(f.lease(c,'shared',`p${i}`,c.snapshot().epoch,
    subject(`p${i}`,{a:'a'.repeat(7900),b:'b'.repeat(7900),c:'c'.repeat(7900),d:'d'.repeat(7000)})));
  const before=c.recovery();
  assert.throws(()=>c.acquire('shared','extra',c.snapshot().epoch,
    subject('extra',{a:'a'.repeat(7900),b:'b'.repeat(7900),c:'c'.repeat(7900),d:'d'.repeat(7900)})),{code:'LIMIT_EXCEEDED'});
  assert.equal(c.snapshot().activeLeases,7);assert.equal(c.recovery().digest,before.digest);
  held[0].release('unknown');for(const lease of held.slice(1))lease.release('known');
  assert.equal(c.recovery().subjects.length,1);
  await c.acknowledge(c.beginReconciliation());
});

test('beforeStart is one attempt, publication precedes spawn, known cleanup keeps the lease active',async t=>{
  const f=await fixture(t),published=deferred(),permitPublish=deferred(),cleaning=deferred(),permitCleanup=deferred();
  f.unblock(()=>permitPublish.resolve());f.unblock(()=>permitCleanup.resolve());
  const guard=fakeGuard(f.library,async()=>reply(),{
    before_retain:async()=>{published.resolve();await permitPublish.promise;},
    before_forget:async()=>{cleaning.resolve();await permitCleanup.promise;},
  });
  const c=await f.create(guard),lease=f.lease(c);
  let spawned=false;
  const start=lease.beforeStart();assert.equal(lease.beforeStart(),start);
  void start.then(()=>{spawned=true;});
  await published.promise;assert.equal(spawned,false);
  permitPublish.resolve();await start;assert.equal(spawned,true);
  assert.equal(guard.recoveryState().entries.length,1);
  lease.release('known');await cleaning.promise;
  assert.equal(c.snapshot().activeLeases,1);
  assert.throws(()=>f.lease(c),{code:'BUSY'});
  let idle=false;void c.waitForIdle().then(()=>{idle=true;});
  await delay(10);assert.equal(idle,false);
  permitCleanup.resolve();await c.waitForIdle();
  assert.equal(c.snapshot().activeLeases,0);assert.equal(c.recovery().subjects.length,0);
  assert.deepEqual(guard.events,['retain','forget']);
});

test('lost retention acknowledgment starts no domain child and cannot retry publication',async t=>{
  const f=await fixture(t);let calls=0;
  const guard=fakeGuard(f.library,async()=>reply('claimed',calls>0),{
    after_retain:()=>{calls++;throw new Error('controlled lost metadata acknowledgment');},
  });
  const c=await f.create(guard),lease=f.lease(c);let spawned=false;
  const attempt=lease.beforeStart();
  await assert.rejects(()=>attempt.then(()=>{spawned=true;}),{code:'RECOVERY_REQUIRED'});
  assert.equal(lease.beforeStart(),attempt);assert.equal(calls,1);assert.equal(spawned,false);
  lease.release('known');await c.waitForIdle();
  assert.equal(c.snapshot().recoveryRequired,true);assert.equal(c.recovery().subjects.length,1);
  await c.claim();const token=c.beginReconciliation();
  await c.acknowledge(token);assert.equal(c.snapshot().recoveryRequired,false);
});

test('lost cleanup acknowledgment preserves original subject and does not reinterpret known domain success',async t=>{
  const f=await fixture(t);let lost=true;
  const guard=fakeGuard(f.library,async()=>reply('claimed',!lost),{
    after_forget:()=>{if(lost){lost=false;throw new Error('controlled cleanup loss');}},
  });
  const c=await f.create(guard),lease=f.lease(c);await lease.beforeStart();
  const domainOutcome='confirmed';lease.release('known');await c.waitForIdle();
  assert.equal(domainOutcome,'confirmed');assert.equal(c.snapshot().recoveryRequired,true);
  assert.equal(c.recovery().subjects.length,1);assert.equal(guard.recoveryState().entries.length,0);
  await c.claim();assert.equal(c.recovery().subjects.length,1);
  await c.acknowledge(c.beginReconciliation());
});

test('close fences admission but keeps guard mutation available through publication and cleanup',async t=>{
  const f=await fixture(t),entered=deferred(),permit=deferred();
  f.unblock(()=>permit.resolve());
  const guard=fakeGuard(f.library,async()=>reply(),{before_retain:async()=>{entered.resolve();await permit.promise;}});
  const c=await f.create(guard),lease=f.lease(c),start=lease.beforeStart();
  await entered.promise;let closed=false;void c.close().then(()=>{closed=true;});
  lease.release('known');await delay(10);
  assert.equal(closed,false);assert.equal(guard.events.includes('stop'),false);
  permit.resolve();await assert.rejects(()=>start,{code:'OWNER_UNAVAILABLE'});
  await c.close();assert.deepEqual(guard.events,['retain','forget','stop']);
});

test('guard and same-process originals are unioned; same project with different original targets is retained',async t=>{
  const f=await fixture(t),c=await f.create();f.lease(c,'shared','project',c.snapshot().epoch,
    subject('project',{root:'old-root'})).release('unknown');
  const old=c.recovery().subjects[0];await c.close();
  const other={id:'22222222-2222-4222-8222-222222222222',subject:subject('project',{root:'another-original-root'})};
  const guard=fakeGuard(f.library,async()=>reply('claimed',true),
    {initialState:{generation:8,domainId,coverage:'complete',entries:[other]}});
  const reopened=await f.create(guard),recovery=reopened.recovery();
  assert.equal(recovery.subjects.length,2);assert.ok(recovery.subjects.some(e=>e.id===old.id));
  await reopened.acknowledge(reopened.beginReconciliation());
});

test('conflicting entry identity fails coverage without replacing local provenance',async t=>{
  const f=await fixture(t),c=await f.create();f.lease(c).release('unknown');
  const old=c.recovery().subjects[0];await c.close();
  const guard=fakeGuard(f.library,async()=>reply('claimed',true),
    {initialState:{generation:8,domainId,coverage:'complete',entries:[{...old,subject:subject('project',{root:'substituted'})}]}});
  const reopened=await f.create(guard);
  assert.equal(reopened.recovery().coverage,'unverifiable');
  assert.deepEqual(reopened.recovery().subjects,[old]);
  assert.throws(()=>reopened.beginReconciliation(),{code:'RECOVERY_REQUIRED'});
});

test('invalid marker generation cannot claim complete coverage',async t=>{
  const f=await fixture(t),guard=fakeGuard(f.library,async()=>reply('claimed',true),
    {initialState:{generation:0,domainId,coverage:'complete',entries:[]}});
  const c=await f.create(guard);
  assert.equal(c.recovery().coverage,'unverifiable');
  assert.throws(()=>c.beginReconciliation(),{code:'RECOVERY_REQUIRED'});
});

test('acknowledgment is persisted before local clear and late stop cannot reopen the runtime',async t=>{
  const f=await fixture(t),entered=deferred(),permit=deferred();
  f.unblock(()=>permit.resolve());
  const guard=fakeGuard(f.library,async()=>reply(),{before_ack:async()=>{entered.resolve();await permit.promise;}});
  const c=await f.create(guard),lease=f.lease(c);await lease.beforeStart();lease.release('unknown');
  await c.waitForIdle();
  const token=c.beginReconciliation(),ack=c.acknowledge(token);
  await entered.promise;assert.equal(c.recovery().subjects.length,1);
  assert.throws(()=>c.beginReconciliation(),{code:'BUSY'});
  c.stop();permit.resolve();await assert.rejects(()=>ack,{code:'OWNER_UNAVAILABLE'});
  assert.equal(c.snapshot().recoveryRequired,true);assert.equal(c.recovery().subjects.length,1);
  await c.close();
  const reopened=await f.create();await reopened.acknowledge(reopened.beginReconciliation());
});
test('complete empty v2 startup recovery still requires explicit acknowledgment',async t=>{
  const f=await fixture(t),c=await f.create(f.guard(async()=>reply('claimed',true)));
  const token=c.beginReconciliation();
  await c.claim();
  await assert.rejects(()=>c.acknowledge(token),{code:'CONFIG_CHANGED'});
  await c.acknowledge(c.beginReconciliation());
  const lease=f.lease(c);
  assert.throws(()=>c.claim(),{code:'BUSY'});lease.release('known');
});
test('late successful guard reply cannot reopen stopped coordinator and close waits for it',async t=>{
  const f=await fixture(t),entered=deferred(),permit=deferred();let calls=0;
  f.unblock(()=>permit.resolve(reply()));
  const c=await f.create(f.guard(async()=>{
    if(calls++===0)return reply();
    entered.resolve();return permit.promise;
  }));
  const pending=c.claim();await entered.promise;
  assert.equal(c.claim(),pending);
  const closing=c.close();let done=false;void closing.then(()=>{done=true;});
  await delay(20);assert.equal(done,false);
  permit.resolve(reply());
  assert.deepEqual(await pending,reply('unavailable',true));
  await closing;assert.equal(c.snapshot().admitted,false);
});
