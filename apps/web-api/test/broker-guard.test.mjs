import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { BrokerRestartGuard, checkedBrokerClaim, checkedBrokerRecoveryState } from '../dist/broker-guard.js';
import { ProcessPool } from '../dist/process.js';
import { canonicalRecoveryJson, recoveryDigest } from '../dist/recovery-subject.js';

const reply = (outcome='claimed',recoveryRequired=false) =>
  ({schema:'lmti.web.broker.guard.v1',outcome,recoveryRequired});
test('broker claim rejects extra process details and inconsistent admission',() => {
  assert.deepEqual(checkedBrokerClaim(reply()),reply());
  assert.ok(Object.isFrozen(checkedBrokerClaim(reply())));
  assert.deepEqual(checkedBrokerClaim(reply('claimed',true)),reply('claimed',true));
  for (const bad of [null,[],{},reply('ready'),reply('busy',false),reply('unavailable',false),
    {...reply(),pid:123},{...reply(),recoveryRequired:'false'},{...reply(),schema:'other'},
    {...reply('claimed',true),outcome:['claimed']},{...reply('claimed',true),outcome:{}}])
    assert.throws(() => checkedBrokerClaim(bad));
});

test('stopped guard never dispatches and copies its private configuration',async() => {
  let calls=0;
  const config={python:'unused',helper:'unused',library:'unused',domainId:'a'.repeat(64)};
  const guard=new BrokerRestartGuard(config,{runWrite:async()=>{calls++;return reply();},waitForIdle:async()=>{}});
  config.helper='changed'; assert.equal(guard.config.helper,'unused'); assert.ok(Object.isFrozen(guard.config));
  guard.stop();
  assert.deepEqual(await guard.claim(),reply('unavailable',true));
  await guard.waitForIdle(); assert.equal(calls,0); assert.equal(guard.isAdmitted(),false);
});

const domainId='a'.repeat(64);
const python=process.env.LMTI_WEB_TEST_PYTHON;
const helper=process.env.LMTI_WEB_TEST_BROKER_GUARD;
const entry=(number=1,projectId='factory-monitor')=>({
  id:`00000000-0000-4000-8000-${String(number).padStart(12,'0')}`,
  subject:{version:1,kind:'legacy',action:'profile_save',projectId,grantId:'b'.repeat(64),
    target:{originalDatabase:'D:/synthetic/never-open.sqlite',identity:'fixture',label:'Việt 😀'}},
});
const nativeOptions={skip:process.platform!=='win32'||!python||!helper,timeout:20000};
async function fixture(run){
  const parent=resolve(tmpdir()),root=await mkdtemp(join(parent,'lmti-broker-provenance-'));
  const library=join(root,'library.sqlite'),bytes=Buffer.from('domain bytes unchanged');
  await writeFile(library,bytes);
  const guards=[];
  const create=(pool,domain=domainId)=>{
    const guard=new BrokerRestartGuard({python,helper,library,domainId:domain},pool);
    guards.push(guard);return guard;
  };
  try {await run({root,library,create,marker:()=>readFile(join(root,'.lmti-web-broker.json'),'utf8').then(JSON.parse)});}
  finally {
    await Promise.all(guards.map(g=>g.waitForIdle()));
    assert.deepEqual(await readFile(library),bytes);
    const location=resolve(root);assert.ok(location.startsWith(parent+sep)&&location!==parent);
    await rm(location,{recursive:true,force:true});
  }
}

test('private recovery state freezes exact entries and rejects malformed or reordered metadata',()=>{
  const input={generation:1,domainId,coverage:'complete',entries:[entry(),entry(2)]};
  const state=checkedBrokerRecoveryState(input);
  input.entries[0].subject.target.identity='caller-mutated';
  assert.equal(state.entries[0].subject.target.identity,'fixture');
  assert.ok(Object.isFrozen(state)&&Object.isFrozen(state.entries)&&Object.isFrozen(state.entries[0].subject.target));
  for(const bad of [{...state,generation:0},{...state,generation:1.5},{...state,domainId:'x'},
    {...state,coverage:'unknown'},{...state,extra:true},{...state,entries:[entry(2),entry()]},
    {...state,entries:[entry(),entry()]},{...state,entries:[{...entry(),id:'00000000-0000-0000-0000-000000000000'}]}])
    assert.throws(()=>checkedBrokerRecoveryState(bad));
});

test('real marker serializes concurrent retain CAS and removes only exact known reservation',nativeOptions,async()=>{
  await fixture(async({create,marker})=>{
    const guard=create();assert.deepEqual(await guard.claim(),reply());
    const one=entry(),two=entry(2,'second-project');
    const pending=guard.retain(one);one.subject.target.identity='caller-mutated';
    const [a,b]=await Promise.all([pending,guard.retain(two)]);
    assert.equal(a.generation,2);assert.equal(b.generation,3);
    assert.equal(b.entries[0].subject.target.identity,'fixture');
    assert.equal(canonicalRecoveryJson((await marker()).entries),canonicalRecoveryJson(b.entries));
    const after=await guard.forgetKnown(two);
    assert.deepEqual(after.entries.map(e=>e.id),[entry().id]);
    assert.equal(recoveryDigest(after.entries),recoveryDigest([entry()]));
    const acknowledged=await guard.acknowledge(after);
    assert.equal(acknowledged.entries.length,0);
    assert.equal(guard.isAdmitted(),true);
  });
});

test('lost retain ACK closes admission while exact published provenance is recovered on explicit claim',nativeOptions,async()=>{
  await fixture(async({create,marker})=>{
    const pool=new ProcessPool(1);let writes=0;
    const proxy={runWrite:async(...args)=>{
      const result=await pool.runWrite(...args);
      if(JSON.parse(args[2]).action==='retain'){writes++;return {...result,bytes:Buffer.from('invalid\\n')};}
      return result;
    },waitForIdle:()=>pool.waitForIdle()};
    const guard=create(proxy);await guard.claim();
    await assert.rejects(guard.retain(entry()),{code:'RECOVERY_REQUIRED'});
    assert.equal(writes,1);assert.equal(guard.isAdmitted(),false);
    assert.deepEqual((await marker()).entries.map(e=>e.id),[entry().id]);
    assert.equal(guard.recoveryState().entries.length,0); // Last confirmed marker snapshot.
    const recovered=create();
    assert.deepEqual(await recovered.claim(),reply('claimed',true));
    assert.equal(recovered.recoveryState().entries[0].id,entry().id);
    await recovered.acknowledge(recovered.recoveryState());
    assert.equal((await marker()).entries.length,0);
  });
});

test('lost known cleanup and acknowledgment ACK retain private provenance and never reopen admission',nativeOptions,async()=>{
  for(const action of ['forget_known','acknowledge'])await fixture(async({create,marker})=>{
    const pool=new ProcessPool(1);let dispatched=0;
    const proxy={runWrite:async(...args)=>{
      const result=await pool.runWrite(...args);
      if(JSON.parse(args[2]).action===action){dispatched++;return {...result,transportOk:false};}
      return result;
    },waitForIdle:()=>pool.waitForIdle()};
    const guard=create(proxy);await guard.claim();const before=await guard.retain(entry());
    await assert.rejects(action==='forget_known'?guard.forgetKnown(entry()):guard.acknowledge(before),{code:'RECOVERY_REQUIRED'});
    assert.equal(dispatched,1);assert.equal(guard.isAdmitted(),false);
    assert.equal(guard.recoveryState(),before);
    assert.equal((await marker()).entries.length,0); // Publication happened; historical domain result is not inferred here.
    await assert.rejects(guard.retain(entry(2)),{code:'RECOVERY_REQUIRED'});
    assert.equal(dispatched,1);
  });
});

test('stale complete-state acknowledgment refuses without erasing concurrent retained entry',nativeOptions,async()=>{
  await fixture(async({create,marker})=>{
    const guard=create();await guard.claim();const old=await guard.retain(entry());
    await guard.retain(entry(2));
    await assert.rejects(guard.acknowledge(old),{code:'RECOVERY_REQUIRED'});
    assert.equal((await marker()).entries.length,2);
    assert.equal(guard.isAdmitted(),false);
  });
});

test('v1 marker and narrowed recovery domain remain unchanged and unavailable',nativeOptions,async()=>{
  await fixture(async({root,create,marker})=>{
    const guard=create();await guard.claim();await guard.retain(entry());
    const before=await readFile(join(root,'.lmti-web-broker.json'));
    const different=create(undefined,'c'.repeat(64));
    assert.deepEqual(await different.claim(),reply('unavailable',true));
    assert.equal(different.recoveryState(),null);
    assert.deepEqual(await readFile(join(root,'.lmti-web-broker.json')),before);
    const current=await marker();
    const old={schema:'lmti.web.broker.marker.v1',scopeHash:current.scopeHash,
      brokerPid:process.pid,creationTime:current.creationTime,recoveryRequired:false};
    await writeFile(join(root,'.lmti-web-broker.json'),JSON.stringify(old));
    await writeFile(join(root,'.lmti-web-broker.lock'),'LMTI-WEB-BROKER-GUARD-1\n');
    const legacy=create();assert.deepEqual(await legacy.claim(),reply('unavailable',true));
    assert.equal(legacy.recoveryState(),null);
    assert.equal(await readFile(join(root,'.lmti-web-broker.json'),'utf8'),JSON.stringify(old));
    assert.equal(await readFile(join(root,'.lmti-web-broker.lock'),'utf8'),'LMTI-WEB-BROKER-GUARD-1\n');
  });
});

test('clean complete empty marker adopts changed domain without accepting a stale guard write',nativeOptions,async()=>{
  await fixture(async({root,create,marker})=>{
    const old=create();await old.claim();
    const original=old.recoveryState();
    const fresh=create(undefined,'c'.repeat(64));
    assert.deepEqual(await fresh.claim(),reply());
    assert.equal(fresh.isAdmitted(),true);
    assert.deepEqual(fresh.recoveryState(),{...original,generation:original.generation+1,domainId:'c'.repeat(64)});
    const before=await readFile(join(root,'.lmti-web-broker.json'));
    await assert.rejects(old.retain(entry()),{code:'RECOVERY_REQUIRED'});
    assert.equal(old.isAdmitted(),false);
    assert.deepEqual(await readFile(join(root,'.lmti-web-broker.json')),before);
    await fresh.retain(entry());
    assert.equal((await marker()).entries.length,1);
    const again=create();
    assert.deepEqual(await again.claim(),reply('unavailable',true));
    assert.equal((await marker()).domainId,'c'.repeat(64));
  });
});

test('real helper claims one fixed disposable scope and preserves domain bytes',
  {skip:process.platform!=='win32'||!python||!helper},async() => {
  const parent=resolve(tmpdir()),root=await mkdtemp(join(parent,'lmti-broker-adapter-'));
  const library=join(root,'library.sqlite'),original=Buffer.from('domain fixture, never opened by guard');
  await writeFile(library,original);
  try {
    const guard=new BrokerRestartGuard({python,helper,library,domainId});
    const first=await guard.claim(); assert.deepEqual(first,reply()); assert.equal(guard.isAdmitted(),true);
    assert.deepEqual(await guard.claim(),first);
    await guard.waitForIdle(); assert.equal(guard.isAdmitted(),false);
    assert.deepEqual(await guard.claim(),reply('unavailable',true));
    assert.deepEqual(await readFile(library),original);
    const marker=JSON.parse(await readFile(join(root,'.lmti-web-broker.json'),'utf8'));
    assert.equal(marker.brokerPid,process.pid);
  } finally {
    const location=resolve(root);
    assert.ok(location.startsWith(parent+sep)&&location!==parent);
    await rm(location,{recursive:true,force:true});
  }
});

test('shutdown before a queued helper call prevents dispatch',
  {skip:process.platform!=='win32'||!python||!helper,timeout:15000},async() => {
  const parent=resolve(tmpdir()),root=await mkdtemp(join(parent,'lmti-broker-stop-'));
  const library=join(root,'library.sqlite'); await writeFile(library,'fixture');
  let entered,release;
  const begun=new Promise(r=>{entered=r;}),permit=new Promise(r=>{release=r;});
  const pool=new ProcessPool(1);
  const proxy={
    runWrite:async(...args)=>{entered();await permit;return pool.runWrite(...args);},
    waitForIdle:()=>pool.waitForIdle(),
  };
  let pending;
  try {
    const guard=new BrokerRestartGuard({python,helper,library,domainId},proxy);
    pending=guard.claim();
    await Promise.race([begun,pending.then(()=>{throw new Error('Claim ended before queued test phase.');})]);
    assert.equal(guard.claim(),pending);
    guard.stop(); release();
    assert.deepEqual(await pending,reply('unavailable',true));
    await guard.waitForIdle(); assert.equal(guard.isAdmitted(),false);
    await assert.rejects(readFile(join(root,'.lmti-web-broker.json')),{code:'ENOENT'});
  } finally {
    release(); if(pending)await pending; await pool.waitForIdle();
    const location=resolve(root); assert.ok(location.startsWith(parent+sep)&&location!==parent);
    await rm(location,{recursive:true,force:true});
  }
});

test('shutdown discards a successful real helper reply delivered late',
  {skip:process.platform!=='win32'||!python||!helper,timeout:15000},async() => {
  const parent=resolve(tmpdir()),root=await mkdtemp(join(parent,'lmti-broker-late-'));
  const library=join(root,'library.sqlite'); await writeFile(library,'fixture');
  let completed,release;
  const received=new Promise(r=>{completed=r;}),permit=new Promise(r=>{release=r;});
  const pool=new ProcessPool(1);
  const proxy={
    runWrite:async(...args)=>{const value=await pool.runWrite(...args);completed(value);await permit;return value;},
    waitForIdle:()=>pool.waitForIdle(),
  };
  let pending;
  try {
    const guard=new BrokerRestartGuard({python,helper,library,domainId},proxy);
    pending=guard.claim();
    const held=await Promise.race([received,pending.then(()=>{throw new Error('Claim ended before held-response test phase.');})]);
    assert.equal(held.kind,'closed'); assert.equal(JSON.parse(held.bytes.toString()).outcome,'claimed');
    guard.stop(); release();
    assert.deepEqual(await pending,reply('unavailable',true));
    await guard.waitForIdle(); assert.equal(guard.isAdmitted(),false);
    const marker=JSON.parse(await readFile(join(root,'.lmti-web-broker.json'),'utf8'));
    assert.equal(marker.brokerPid,process.pid);
  } finally {
    release(); if(pending)await pending; await pool.waitForIdle();
    const location=resolve(root); assert.ok(location.startsWith(parent+sep)&&location!==parent);
    await rm(location,{recursive:true,force:true});
  }
});
