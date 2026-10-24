import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { ProjectOperationOwner, decodeProjectOperationRead } from '../dist/project-operations-owner.js';
import { checkedUpgradeRecoveryExpected, checkedUpgradeRecoveryResult, decodeUpgradeRecovery,
  upgradeRecoveryEvidence } from '../dist/upgrade-recovery-owner.js';
import { ProjectOperationRecovery } from '../dist/project-operations-recovery.js';
import { WriteCoordinator } from '../dist/write-coordinator.js';
import { collectOriginalTargets } from '../dist/recovery-collection.js';
import { canonicalRecoveryJson } from '../dist/recovery-subject.js';
import { ApiError } from '../dist/security.js';

// Codec/collector fixtures, not evidence of native backup creation or SQLite atomicity.
const sha=v=>createHash('sha256').update(String(v)).digest('hex');
const uuid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const clone=v=>structuredClone(v),bytes=v=>Buffer.from(JSON.stringify(v)+'\n');
const base=process.platform==='win32'?'C:/upgrade-codec':'/upgrade-codec';
const lib1={schema:1,canonicalPath:base+'/library.sqlite',uuid:null,generation:null,digest:sha('rows')};
const lib2={schema:2,canonicalPath:lib1.canonicalPath,uuid:uuid(1),generation:4,digest:sha('bindings')};
const expected1={source:lib1,fullSnapshotDigest:lib1.digest};
const expected2={source:lib2,fullSnapshotDigest:sha('full-v2')};
const code=name=>e=>e instanceof ApiError&&e.code===name;
const artifact=(n,expected,receiptMatch='none')=>({
  artifactKey:n.toString(16).padStart(64,'0'),operationId:uuid(n),schema:expected.source.schema,
  fullSnapshotDigest:expected.fullSnapshotDigest,state:'verified',receiptMatch,matchesExpected:true,
});
function original(expected,artifacts=[]) {
  return {ok:true,schema:'lmti.project.upgrade-recovery.v1',action:'library-upgrade-recovery',data:{
    condition:'original_state_verified',code:'NONE',complete:true,examinedEntries:artifacts.length,
    unresolvedEntries:0,current:clone(expected.source),currentSnapshotDigest:sha('native framed source evidence'),
    parentSnapshotDigest:sha(JSON.stringify(artifacts)),committedOperationId:null,artifacts,
  }};
}
function committed(expected) {
  const value=original(expected,[artifact(10,expected,expected.source.schema===1?'upgrade_v1':'upgrade_v2')]);
  Object.assign(value.data,{condition:'committed_state_verified',committedOperationId:uuid(10),
    current:expected.source.schema===1?{...lib2,canonicalPath:expected.source.canonicalPath,generation:1}:
      {...expected.source,schema:3}});
  return value;
}
function unresolved(expected,state='incomplete') {
  const value=original(expected);
  Object.assign(value.data,{condition:'unresolved',complete:false,code:'RECOVERY_REQUIRED',examinedEntries:1,
    unresolvedEntries:1,parentSnapshotDigest:null,artifacts:[{
      artifactKey:'0'.repeat(64),operationId:uuid(10),schema:null,fullSnapshotDigest:null,
      state,receiptMatch:'none',matchesExpected:false,
    }]});
  return value;
}

test('original full-state evidence accepts no artifact or multiple independent matches without lost-ID attribution',()=>{
  for(const expected of [expected1,expected2])for(const rows of [[],[artifact(2,expected),artifact(7,expected)]]) {
    const value=original(expected,rows),decoded=decodeUpgradeRecovery(bytes(value),expected);
    assert.deepEqual(decoded,value);assert.equal(decoded.data.committedOperationId,null);
    assert.notEqual(decoded.data.currentSnapshotDigest,expected.fullSnapshotDigest);
    assert.ok(Object.isFrozen(decoded.data.current));assert.ok(Object.isFrozen(decoded.data.artifacts));
    assert.equal(upgradeRecoveryEvidence(decoded),upgradeRecoveryEvidence(checkedUpgradeRecoveryResult(clone(value),expected)));
    const changed=clone(value);changed.data.currentSnapshotDigest=sha('later source evidence');
    assert.notEqual(upgradeRecoveryEvidence(decoded),upgradeRecoveryEvidence(checkedUpgradeRecoveryResult(changed,expected)));
  }
});

test('committed transitions require exact expected backup and durable receipt; format preserves generation',()=>{
  for(const expected of [expected1,expected2]) {
    const value=committed(expected);
    assert.deepEqual(decodeUpgradeRecovery(bytes(value),expected),value);
    if(expected.source.schema===1) {
      value.data.current.schema=3;
      assert.equal(decodeUpgradeRecovery(bytes(value),expected).data.current.schema,3);
    } else {
      assert.equal(value.data.current.generation,expected.source.generation);
      value.data.current.generation++;
      assert.equal(decodeUpgradeRecovery(bytes(value),expected).data.complete,true);
    }
  }
  for(const mutate of [
    v=>v.data.committedOperationId=uuid(99),
    v=>v.data.artifacts[0].matchesExpected=false,
    v=>v.data.artifacts[0].fullSnapshotDigest=sha('different original'),
    v=>v.data.artifacts[0].receiptMatch='none',
    v=>v.data.current.uuid=uuid(77),
    v=>v.data.current.generation=expected2.source.generation-1,
    v=>v.data.current.schema=2,
  ]) {
    const v=committed(expected2);mutate(v);
    assert.throws(()=>decodeUpgradeRecovery(bytes(v),expected2),code('OWNER_UNAVAILABLE'));
  }
});

test('original pins cannot be replaced by current schema, path, UUID, generation or binding digest',()=>{
  for(const mutate of [
    v=>v.data.current.schema=3,v=>v.data.current.canonicalPath=base+'/replacement.sqlite',
    v=>v.data.current.uuid=uuid(2),v=>v.data.current.generation++,v=>v.data.current.digest=sha('new bindings'),
    v=>v.data.committedOperationId=uuid(10),
  ]) {
    const v=original(expected2);mutate(v);
    assert.throws(()=>decodeUpgradeRecovery(bytes(v),expected2),code('OWNER_UNAVAILABLE'));
  }
  const unicode={source:{...lib2,canonicalPath:base+'/STRASSE/Thư-viện.sqlite'},fullSnapshotDigest:expected2.fullSnapshotDigest};
  assert.equal(decodeUpgradeRecovery(bytes(original(unicode)),unicode).data.current.canonicalPath,unicode.source.canonicalPath);
});

test('partial observations remain explicit unresolved; unavailable identity fields stay null',()=>{
  const value=unresolved(expected2);
  assert.deepEqual(decodeUpgradeRecovery(bytes(value),expected2),value);
  value.data.current=null;value.data.currentSnapshotDigest=null;
  value.data.artifacts[0].state='unavailable';
  assert.deepEqual(decodeUpgradeRecovery(bytes(value),expected2),value);
  const foreign=unresolved(expected2,'foreign');
  Object.assign(foreign.data.artifacts[0],{schema:2,fullSnapshotDigest:sha('foreign rows')});
  assert.equal(decodeUpgradeRecovery(bytes(foreign),expected2).data.artifacts[0].state,'foreign');
  for(const mutate of [
    v=>v.data.complete=true,v=>v.data.code='NONE',v=>v.data.parentSnapshotDigest=sha('invented complete set'),
    v=>v.data.unresolvedEntries=0,v=>v.data.artifacts[0].matchesExpected=true,
    v=>v.data.artifacts[0].receiptMatch='upgrade_v2',v=>v.data.currentSnapshotDigest=sha('without identity'),
  ]) {
    const v=clone(value);mutate(v);assert.throws(()=>decodeUpgradeRecovery(bytes(v),expected2),code('OWNER_UNAVAILABLE'));
  }
});

test('all sorted artifacts fit the dedicated 1000-row budget without broadening generic recovery JSON',()=>{
  const value=original(expected2,Array.from({length:1000},(_,i)=>artifact(i+1,expected2)));
  const decoded=decodeUpgradeRecovery(bytes(value),expected2);
  assert.equal(decoded.data.artifacts.length,1000);assert.ok(bytes(value).length<=512*1024);
  assert.match(upgradeRecoveryEvidence(decoded),/^[0-9a-f]{64}$/);
  assert.throws(()=>canonicalRecoveryJson(decoded.data.artifacts));
  value.data.artifacts.push(artifact(1001,expected2));value.data.examinedEntries++;
  assert.throws(()=>decodeUpgradeRecovery(bytes(value),expected2),code('OWNER_UNAVAILABLE'));
  const overflow=unresolved(expected2);
  overflow.data.examinedEntries=1001;
  assert.equal(decodeUpgradeRecovery(bytes(overflow),expected2).data.complete,false);
});

test('artifact order, operation uniqueness, durable receipt cardinality and count coherence are exact',()=>{
  for(const mutate of [
    v=>v.data.artifacts.reverse(),v=>v.data.artifacts[1].artifactKey=v.data.artifacts[0].artifactKey,
    v=>v.data.artifacts[1].operationId=v.data.artifacts[0].operationId,
    v=>v.data.examinedEntries=1,v=>v.data.unresolvedEntries=1,
    v=>v.data.artifacts[0].schema=null,v=>v.data.artifacts[0].operationId=null,
  ]) {
    const v=original(expected2,[artifact(2,expected2),artifact(7,expected2)]);mutate(v);
    assert.throws(()=>decodeUpgradeRecovery(bytes(v),expected2),code('OWNER_UNAVAILABLE'));
  }
  for(const expected of [expected1,expected2]) {
    const v=committed(expected),duplicate=artifact(11,expected,expected.source.schema===1?'upgrade_v1':'upgrade_v2');
    v.data.artifacts.push(duplicate);v.data.examinedEntries++;
    assert.throws(()=>decodeUpgradeRecovery(bytes(v),expected),code('OWNER_UNAVAILABLE'));
  }
});

test('malformed, extra, coerced, truncated and non-UTF8 native frames fail with bounded generic errors',()=>{
  const valid=bytes(original(expected2));
  for(const bad of [
    valid.subarray(0,valid.length-1),Buffer.concat([valid,Buffer.from([0,10])]),
    Buffer.concat([valid,Buffer.from([0x1a,10])]),Buffer.from([0xff,10]),Buffer.from('[]\n'),
    Buffer.from('{"ok":true,"ok":false}\n'),Buffer.alloc(512*1024+1,10),
  ])assert.throws(()=>decodeUpgradeRecovery(bad,expected2),code('OWNER_UNAVAILABLE'));
  for(const mutate of [
    v=>v.extra=base,v=>v.action='library-format-status',v=>v.schema='wrong',
    v=>v.data.complete=1,v=>v.data.current.schema='2',v=>v.data.current.generation=true,
    v=>v.data.code=['NONE'],v=>v.data.condition=['original_state_verified'],
    v=>v.data.examinedEntries=false,v=>v.data.artifacts[0].state=['verified'],
    v=>v.data.artifacts[0].matchesExpected=1,v=>v.data.artifacts[0].extra=base,
  ]) {
    const v=original(expected2,[artifact(10,expected2)]);mutate(v);
    assert.throws(()=>decodeUpgradeRecovery(bytes(v),expected2),e=>code('OWNER_UNAVAILABLE')(e)&&!e.message.includes(base));
  }
  for(const [native,api] of [['BUDGET_EXCEEDED','LIMIT_EXCEEDED'],['UNSUPPORTED_FORMAT','NOT_SUPPORTED'],
    ['CONFIG_CHANGED','CONFIG_CHANGED'],['RECOVERY_REQUIRED','RECOVERY_REQUIRED']])
    assert.throws(()=>decodeUpgradeRecovery(bytes({ok:false,code:native}),expected2),code(api));
  for(const v of [{ok:false,code:'NONE'},{ok:false,code:['CONFIG_CHANGED']},{ok:false,code:'OWNER_UNAVAILABLE',path:base}])
    assert.throws(()=>decodeUpgradeRecovery(bytes(v),expected2),code('OWNER_UNAVAILABLE'));
});

test('digest/UUID trailing LF is refused in new and extracted existing library codecs',()=>{
  for(const mutate of [
    v=>v.data.current.digest+='\n',v=>v.data.current.uuid+='\n',
    v=>v.data.parentSnapshotDigest+='\n',v=>v.data.artifacts[0].artifactKey+='\n',
    v=>v.data.artifacts[0].operationId+='\n',v=>v.data.artifacts[0].fullSnapshotDigest+='\n',
  ]) {
    const v=original(expected2,[artifact(10,expected2)]);mutate(v);
    assert.throws(()=>decodeUpgradeRecovery(bytes(v),expected2),code('OWNER_UNAVAILABLE'));
  }
  const baseline={ok:true,schema:'lmti.project.operations.v1',action:'library-format-status',libraryIdentity:lib2,
    upgradeOperationId:uuid(10),legacyDigest:sha('v1 rows'),activationFormatOperationId:null,activationFormatBackupDigest:null};
  assert.deepEqual(decodeProjectOperationRead(bytes(baseline),{action:'library-format-status'}),baseline);
  for(const field of ['digest','uuid']) {
    const frame={...baseline,libraryIdentity:{...lib2,[field]:lib2[field]+'\n'}};
    assert.throws(()=>decodeProjectOperationRead(bytes(frame),{action:'library-format-status'}),code('OWNER_UNAVAILABLE'));
  }
});

test('expected pins are rejected before owner dispatch for wrong schema, nulls, paths or full digest',async()=>{
  let calls=0;
  const pool={run:async()=>{calls++;throw new Error('must not dispatch');}};
  const owner=new ProjectOperationOwner({adminBinary:base+'/admin.exe',library:lib1.canonicalPath,
    copyParent:base+'/copies',backupParent:base+'/backups'},pool,pool);
  for(const e of [
    {...expected2,source:{...lib2,schema:3}},
    {...expected1,fullSnapshotDigest:sha('wrong rows')},
    {...expected2,source:{...lib2,generation:0}},
    {...expected2,source:{...lib2,uuid:uuid(1)+'\n'}},
    {...expected2,fullSnapshotDigest:sha('full')+'\n'},
    {...expected2,source:{...lib2,canonicalPath:'//host/share/library.sqlite'}},
    {...expected2,source:{...lib2,canonicalPath:base+'/library.sqlite:ads'}},
    {...expected2,source:{...lib2,canonicalPath:base+'/bad\ud800.sqlite'}},
    {...expected2,backupParent:base},
  ]) {
    assert.throws(()=>checkedUpgradeRecoveryExpected(e),code('INVALID_INPUT'));
    await assert.rejects(owner.upgradeRecovery(e),code('INVALID_INPUT'));
  }
  assert.equal(calls,0);
});

test('dedicated verification pool uses fixed argv, complete frame limits and queued guard only',async()=>{
  let main=0,verify=0,guard=0;
  const config={adminBinary:base+'/admin.exe',library:lib1.canonicalPath,copyParent:base+'/copies',backupParent:base+'/backups'};
  const trusted=clone(config);
  const pool={run:async()=>{main++;throw new Error('main pool unavailable');}};
  const verifier={run:async(binary,args,input,options)=>{
    verify++;assert.equal(binary,trusted.adminBinary);
    assert.deepEqual(args,['--project-operation-recovery','--library',trusted.library,'--backup-parent',trusted.backupParent]);
    assert.deepEqual(JSON.parse(input),{action:'library-upgrade-recovery',expected:expected2});
    assert.ok(Buffer.byteLength(input)<=32*1024);assert.equal(options.cap,512*1024);assert.equal(options.newlineTerminated,true);
    assert.equal(options.timeoutMs,30000);
    await options.guard?.();return original(expected2);
  }};
  const owner=new ProjectOperationOwner(config,pool,verifier);
  config.backupParent=base+'/caller-mutation';
  assert.equal((await owner.upgradeRecovery(expected2,{guard:()=>{guard++;}})).data.complete,true);
  assert.equal(main,0);assert.equal(verify,1);assert.equal(guard,1);
});

async function fixture(t,schema=2) {
  const root=await mkdtemp(join(tmpdir(),'lmti-upgrade-recovery-codec-'));
  const config={adminBinary:join(root,'unused-admin.exe'),library:join(root,'library.sqlite'),
    copyParent:join(root,'copies'),backupParent:join(root,'backups')};
  await writeFile(config.library,'controlled physical owner identity');
  await mkdir(config.copyParent);await mkdir(config.backupParent);
  const expected={source:{...(schema===1?lib1:lib2),canonicalPath:config.library.replaceAll('\\','/')},
    fullSnapshotDigest:schema===1?lib1.digest:expected2.fullSnapshotDigest};
  let grant=sha('grant'),observations=0,alive=true,callback=null;
  const owner={config,read:async()=>{throw new Error('generic read must not run for upgrade');},
    upgradeRecovery:async(e,options)=>{
      await options.guard?.();observations++;assert.deepEqual(e,expected);
      return callback?await callback(e):original(e);
    }};
  const recovery=new ProjectOperationRecovery(owner,()=>grant);
  const request=schema===1?{action:'library-upgrade-v1',expected:expected.source}:{action:'library-upgrade-v2',expected};
  const subject=await recovery.capture(request,null);
  let coordinator;
  t.after(async()=>{
    await coordinator?.close();
    assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));
    await rm(root,{recursive:true,force:true});
  });
  return {root,config,expected,request,subject,owner,recovery,
    guard:()=>{if(!alive)throw new ApiError('SESSION_EXPIRED');},
    authorize:()=>{throw new Error('whole-library scope is authorized by collector, not a fabricated project');},
    observations:()=>observations,setCallback:f=>{callback=f;},revoke:()=>{grant=sha('revoked');},
    expire:()=>{alive=false;},coordinator:async()=>coordinator=await WriteCoordinator.create(config.library,undefined,undefined,{domainId:sha('grant')})};
}

test('upgrade original and committed observations yield fresh evidence without rewriting captured pins',async t=>{
  for(const schema of [1,2]) {
    const f=await fixture(t,schema),before=canonicalRecoveryJson(f.subject);
    f.setCallback(e=>original(e,[artifact(2,e),artifact(7,e)]));
    const first=await f.recovery.inspect(f.subject,f.guard,f.authorize);
    assert.equal(first.librarySchema,schema);assert.equal(canonicalRecoveryJson(f.subject),before);
    f.setCallback(e=>committed(e));
    assert.equal((await f.recovery.inspect(f.subject,f.guard,f.authorize)).librarySchema,schema+1);
    assert.equal(canonicalRecoveryJson(f.subject),before);assert.equal(f.observations(),2);
    assert.deepEqual(Object.keys(first).sort(),['digest','librarySchema']);
  }
});

test('incomplete parent coverage cannot become evidence or silently acknowledge an unknown write',async t=>{
  const f=await fixture(t);
  f.setCallback(e=>unresolved(e));
  await assert.rejects(f.recovery.inspect(f.subject,f.guard,f.authorize),code('RECOVERY_REQUIRED'));
  f.setCallback(e=>({...original(e),data:{...original(e).data,complete:false}}));
  await assert.rejects(f.recovery.inspect(f.subject,f.guard,f.authorize),code('OWNER_UNAVAILABLE'));
  assert.equal(f.observations(),2);
});

test('preexisting physical replacement of library or backup parent refuses before owner observation',async t=>{
  for(const which of ['library','backupParent']) {
    const f=await fixture(t),path=f.config[which];
    await rename(path,path+'-original');
    if(which==='library')await writeFile(path,'substitute');else await mkdir(path);
    await assert.rejects(f.recovery.inspect(f.subject,f.guard,f.authorize),code('CONFIG_CHANGED'));
    assert.equal(f.observations(),0);
  }
});

test('queued and post-read grant, session and original physical checks reject stale evidence',async t=>{
  const revoked=await fixture(t);revoked.revoke();
  await assert.rejects(revoked.recovery.inspect(revoked.subject,revoked.guard,revoked.authorize),code('SCOPE_DENIED'));
  assert.equal(revoked.observations(),0);
  const queued=await fixture(t);
  queued.owner.upgradeRecovery=async(e,o)=>{queued.expire();await o.guard();throw new Error('must not reach owner');};
  await assert.rejects(queued.recovery.inspect(queued.subject,queued.guard,queued.authorize),code('SESSION_EXPIRED'));
  const post=await fixture(t);post.setCallback(async e=>{
    await rename(post.config.backupParent,post.config.backupParent+'-original');await mkdir(post.config.backupParent);
    return original(e);
  });
  await assert.rejects(post.recovery.inspect(post.subject,post.guard,post.authorize),code('CONFIG_CHANGED'));
  assert.equal(post.observations(),1);
});

test('full collector observes original upgrade scope twice; only explicit acknowledgment clears barrier',async t=>{
  const f=await fixture(t),coordinator=await f.coordinator();
  const lease=coordinator.acquire('exclusive',null,coordinator.snapshot().epoch,f.subject);
  await lease.beforeStart();lease.release('unknown');await coordinator.waitForIdle();
  f.setCallback(e=>original(e,[artifact(7,e),artifact(9,e)]));
  const history={outcome:'unknown',operationId:null},token=coordinator.beginReconciliation();
  let authorized=0;
  const options={guard:f.guard,authorize:s=>{assert.equal(s.projectId,null);authorized++;},
    inspect:s=>f.recovery.inspect(s,f.guard,f.authorize)};
  const a=await collectOriginalTargets(coordinator,options),b=await collectOriginalTargets(coordinator,options);
  assert.equal(a.digest,b.digest);assert.equal(f.observations(),2);assert.ok(authorized>=2);
  assert.equal(coordinator.snapshot().recoveryRequired,true);
  assert.deepEqual(history,{outcome:'unknown',operationId:null});
  await coordinator.acknowledge(token);assert.equal(coordinator.snapshot().recoveryRequired,false);
  assert.deepEqual(history,{outcome:'unknown',operationId:null});
});
