import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { ProcessPool } from '../dist/process.js';
import { ProjectOperationOwner, decodeProjectOperationWrite } from '../dist/project-operations-owner.js';
import { ProjectOperationRecovery } from '../dist/project-operations-recovery.js';
import { WriteCoordinator } from '../dist/write-coordinator.js';
import { collectOriginalTargets } from '../dist/recovery-collection.js';
import { ApiError } from '../dist/security.js';

const names=['LMTI_WEB_TEST_ADMIN','LMTI_WEB_TEST_BINDING_PRODUCER','LMTI_WEB_TEST_UPGRADE_WRITE_ADMIN'];
const configured=names.some(name=>Boolean(process.env[name]));
const options={skip:!configured,timeout:120000};
const sha=value=>createHash('sha256').update(value).digest('hex');
const code=value=>error=>error instanceof ApiError&&error.code===value;
const unchanged=()=>{};
const noProject=()=>{throw new Error('Library recovery unexpectedly requested project authority.');};
function fixtureEnvironment() {
  const env={};
  for(const key of ['SystemRoot','WINDIR','PATH'])if(process.env[key])env[key]=process.env[key];
  return env;
}
async function snapshot(root) {
  const entries=[];
  async function visit(path,relative) {
    for(const name of (await readdir(path)).sort()) {
      const child=join(path,name),label=relative?`${relative}/${name}`:name,info=await lstat(child);
      assert.equal(info.isSymbolicLink(),false,'Controlled native fixture must not contain redirected entries.');
      if(info.isDirectory()){entries.push([label,'directory']);await visit(child,label);}
      else {assert.equal(info.isFile(),true);entries.push([label,info.size,sha(await readFile(child))]);}
    }
  }
  await visit(root,'');return entries;
}
async function readOnly(f,call) {
  const before=await snapshot(f.root);
  try {return await call();}
  finally {assert.deepEqual(await snapshot(f.root),before,'Recovery observation changed fixture bytes or entries.');}
}
async function fixture(t,schema) {
  for(const name of names) {
    assert.ok(typeof process.env[name]==='string'&&isAbsolute(process.env[name]),`${name} must be an explicit current native binary.`);
    assert.equal((await lstat(process.env[name])).isFile(),true);
  }
  assert.notEqual(resolve(process.env.LMTI_WEB_TEST_ADMIN),resolve(process.env.LMTI_WEB_TEST_UPGRADE_WRITE_ADMIN),
    'The isolated fault writer must not be the shipped admin.');
  const root=await mkdtemp(join(tmpdir(),'lmti-native-upgrade-api-'));
  const main=new ProcessPool(1),reads={children:0},verify=new ProcessPool(1,(...args)=>{reads.children++;return spawn(...args);});
  const coordinators=[],leases=[];
  t.after(async()=>{
    for(const lease of leases)lease.release('known');
    await Promise.all(coordinators.map(c=>c.close()));
    await Promise.all([main.waitForIdle(),verify.waitForIdle()]);
    assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));
    await rm(root,{recursive:true,force:true});
  });
  const made=spawnSync(process.env.LMTI_WEB_TEST_BINDING_PRODUCER,['--fixture',root,String(schema),'2'],
    {env:fixtureEnvironment(),encoding:'utf8',timeout:15000,windowsHide:true,maxBuffer:16384});
  assert.equal(made.error,undefined,'Controlled native fixture producer could not run.');
  assert.equal(made.status,0,'Controlled native fixture producer failed.');
  const library=join(root,'library.sqlite'),copyParent=join(root,'reviewed-copies'),backupParent=join(root,'reviewed-backups');
  await mkdir(copyParent);await mkdir(backupParent);
  const owner=new ProjectOperationOwner({adminBinary:process.env.LMTI_WEB_TEST_ADMIN,library,copyParent,backupParent},main,verify);
  const domain=sha(`native-upgrade-domain:${root}`),recovery=new ProjectOperationRecovery(owner,()=>domain);
  const preview=await owner.read({action:'library-format-preview',fromSchema:schema});
  const expected=schema===1?{source:preview.expected,fullSnapshotDigest:preview.expected.digest}:preview.expected;
  const request={action:schema===1?'library-upgrade-v1':'library-upgrade-v2',expected:preview.expected};
  const subject=await recovery.capture(request,null);
  const originalProject=await readFile(join(root,'project.sqlite'));
  return {root,schema,library,copyParent,backupParent,owner,recovery,expected,request,subject,domain,reads,
    originalProject,
    async coordinator(){
      const c=await WriteCoordinator.create(library,undefined,undefined,{domainId:domain});
      coordinators.push(c);return c;
    },
    lease(c){
      const value=c.acquire('exclusive',null,c.snapshot().epoch,subject);leases.push(value);return value;
    },
  };
}
async function orphanCopies(f,count=2) {
  // Test data only: closed native-produced snapshots, not invented verified ACKs
  // or proof that an interrupted owner produced these particular directories.
  for(const suffix of ['-wal','-shm','-journal'])
    await assert.rejects(lstat(f.library+suffix),error=>error.code==='ENOENT');
  const operations=[];
  for(let i=0;i<count;i++) {
    const id=randomUUID(),directory=join(f.backupParent,id);await mkdir(directory);
    await copyFile(f.library,join(directory,`library-v${f.schema}.sqlite`));operations.push(id);
  }
  return operations;
}
function postCommit(f) {
  const result=spawnSync(process.env.LMTI_WEB_TEST_UPGRADE_WRITE_ADMIN,
    ['--project-operation-write','--library',f.library,'--copy-parent',f.copyParent,'--backup-parent',f.backupParent],
    {env:{...fixtureEnvironment(),LMTI_PROJECT_OPERATION_WRITE_TEST_FAULT:f.schema===1?'after_upgrade_commit':'after_format_commit'},
      input:JSON.stringify(f.request),timeout:30000,windowsHide:true,maxBuffer:512*1024});
  assert.equal(result.error,undefined,'Isolated native fault writer could not run.');
  assert.equal(result.status,0);assert.equal(result.stderr.length,0);
  const reply=decodeProjectOperationWrite(result.stdout,f.request);
  assert.equal(reply.outcome,'unknown');assert.equal(reply.code,'RECOVERY_REQUIRED');
  assert.equal(reply.detailsAvailable,true);assert.ok(reply.operationId);
  assert.equal(reply.details.state,'recovery_required');
  return reply;
}
function complete(result,condition) {
  assert.equal(result.data.complete,true);assert.equal(result.data.condition,condition);
  assert.equal(result.data.code,'NONE');assert.equal(result.data.unresolvedEntries,0);
  assert.equal(result.data.artifacts.every(row=>row.state==='verified'),true);
}
async function inspected(f) {
  return readOnly(f,()=>f.recovery.inspect(f.subject,unchanged,noProject));
}

test('real native original schema1/schema2 and two matching standalone fixtures never select a lost operation',options,async t=>{
  for(const schema of [1,2]) {
    const f=await fixture(t,schema);
    const empty=await readOnly(f,()=>f.owner.upgradeRecovery(f.expected));
    complete(empty,'original_state_verified');assert.equal(empty.data.committedOperationId,null);
    assert.notEqual(empty.data.currentSnapshotDigest,f.expected.fullSnapshotDigest,
      'Current observation and original typed snapshot use distinct native digest domains.');
    assert.deepEqual(empty.data.artifacts,[]);assert.equal((await inspected(f)).librarySchema,schema);
    const ids=await orphanCopies(f);
    const observed=await readOnly(f,()=>f.owner.upgradeRecovery(f.expected));
    complete(observed,'original_state_verified');
    assert.equal(observed.data.committedOperationId,null);
    assert.deepEqual(observed.data.artifacts.map(row=>row.operationId).sort(),ids.sort());
    for(const row of observed.data.artifacts) {
      assert.equal(row.receiptMatch,'none');assert.equal(row.matchesExpected,true);
      assert.equal(row.fullSnapshotDigest,f.expected.fullSnapshotDigest);
    }
    const first=await inspected(f),second=await inspected(f);
    assert.deepEqual(first,second);
    assert.deepEqual(await readFile(join(f.root,'project.sqlite')),f.originalProject);
  }
});

test('actual native post-COMMIT unknown is reconciled only by separate acknowledgment and never relabeled',options,async t=>{
  for(const schema of [1,2]) {
    const f=await fixture(t,schema),c=await f.coordinator(),lease=f.lease(c);
    await lease.beforeStart();
    const historical=postCommit(f),historicalBytes=JSON.stringify(historical);
    lease.release('unknown');await c.waitForIdle();
    assert.equal(c.snapshot().recoveryRequired,true);
    const observed=await readOnly(f,()=>f.owner.upgradeRecovery(f.expected));
    complete(observed,'committed_state_verified');
    assert.equal(observed.data.current.schema,schema+1);
    assert.equal(observed.data.committedOperationId,historical.operationId);
    const row=observed.data.artifacts.find(item=>item.operationId===historical.operationId);
    assert.equal(row.matchesExpected,true);
    assert.equal(row.receiptMatch,schema===1?'upgrade_v1':'upgrade_v2');
    const target=await inspected(f);assert.equal(target.librarySchema,schema+1);
    assert.equal(c.snapshot().recoveryRequired,true,'Read-only inspection must not clear admission.');
    const token=c.beginReconciliation(),beforeReads=f.reads.children;
    const collect={
      guard:unchanged,
      authorize:subject=>{assert.equal(subject.grantId,f.domain);},
      inspect:subject=>f.recovery.inspect(subject,unchanged,noProject),
    };
    await assert.rejects(collectOriginalTargets(c,{...collect,authorize:()=>{throw new ApiError('SCOPE_DENIED');}}),
      code('SCOPE_DENIED'));
    assert.equal(f.reads.children,beforeReads,'Revoked union authority launched a recovery child.');
    const first=await readOnly(f,()=>collectOriginalTargets(c,collect));
    const second=await readOnly(f,()=>collectOriginalTargets(c,collect));
    assert.equal(first.digest,second.digest);assert.equal(c.recovery().subjects.length,1);
    assert.equal(c.snapshot().recoveryRequired,true);
    await c.acknowledge(token);
    assert.equal(c.snapshot().recoveryRequired,false);assert.equal(c.recovery().subjects.length,0);
    assert.equal(JSON.stringify(historical),historicalBytes);
    assert.equal(historical.outcome,'unknown');
    assert.deepEqual(await readFile(join(f.root,'project.sqlite')),f.originalProject);
  }
});

test('real native full-parent empty, malformed and missing committed evidence blocks the recovery helper',options,async t=>{
  for(const schema of [1,2]) {
    const f=await fixture(t,schema);await orphanCopies(f);
    const empty=join(f.backupParent,randomUUID());await mkdir(empty);
    let value=await readOnly(f,()=>f.owner.upgradeRecovery(f.expected));
    assert.equal(value.data.complete,false);assert.equal(value.data.artifacts.some(row=>row.state==='incomplete'),true);
    await assert.rejects(inspected(f),code('RECOVERY_REQUIRED'));
    await rename(empty,join(f.root,'retained-empty'));
    const malformed=join(f.backupParent,randomUUID());await mkdir(malformed);
    await writeFile(join(malformed,`library-v${schema}.sqlite`),'controlled incomplete SQLite bytes');
    value=await readOnly(f,()=>f.owner.upgradeRecovery(f.expected));
    assert.equal(value.data.complete,false);assert.ok(value.data.unresolvedEntries>=1);
    await assert.rejects(inspected(f),code('RECOVERY_REQUIRED'));
    await rename(malformed,join(f.root,'retained-malformed'));
    const unknown=postCommit(f),committed=join(f.backupParent,unknown.operationId);
    const valid=await readOnly(f,()=>f.owner.upgradeRecovery(f.expected));complete(valid,'committed_state_verified');
    // Equivalent orphan files must not substitute for this receipt-named backup.
    await rename(committed,join(f.root,'retained-committed'));
    value=await readOnly(f,()=>f.owner.upgradeRecovery(f.expected));
    assert.equal(value.data.complete,false);assert.equal(value.data.condition,'unresolved');
    assert.equal(value.data.artifacts.filter(row=>row.matchesExpected&&row.receiptMatch==='none').length,2);
    await assert.rejects(inspected(f),code('RECOVERY_REQUIRED'));
    await rename(join(f.root,'retained-committed'),committed);
    complete(await readOnly(f,()=>f.owner.upgradeRecovery(f.expected)),'committed_state_verified');
  }
});

test('original physical library and backup-parent replacement are refused before the native recovery child',options,async t=>{
  for(const schema of [1,2])for(const replace of ['library','parent']) {
    const f=await fixture(t,schema);
    if(replace==='library') {
      const retained=join(f.root,'retained-original-library.sqlite');
      await rename(f.library,retained);await copyFile(retained,f.library);
    }else {
      await rename(f.backupParent,join(f.root,'retained-original-parent'));await mkdir(f.backupParent);
    }
    const children=f.reads.children;
    await assert.rejects(inspected(f),code('CONFIG_CHANGED'));
    assert.equal(f.reads.children,children,'Substituted owner location was probed by native recovery.');
  }
});

test('real committed schema2 recovery keeps all original pins and decodes more than 256 bounded artifacts',options,async t=>{
  const f=await fixture(t,2),unknown=postCommit(f);
  complete(await readOnly(f,()=>f.owner.upgradeRecovery(f.expected)),'committed_state_verified');
  for(const source of [
    {...f.expected.source,generation:f.expected.source.generation+1},
    {...f.expected.source,digest:f.expected.source.digest==='a'.repeat(64)?'b'.repeat(64):'a'.repeat(64)},
  ]) {
    const wrong={...f.expected,source},observed=await readOnly(f,()=>f.owner.upgradeRecovery(wrong));
    assert.equal(observed.data.complete,false);assert.equal(observed.data.condition,'unresolved');
    assert.equal(observed.data.artifacts.find(row=>row.operationId===unknown.operationId).matchesExpected,false);
    const wrongSubject=await f.recovery.capture({action:'library-upgrade-v2',expected:wrong},null);
    await assert.rejects(readOnly(f,()=>f.recovery.inspect(wrongSubject,unchanged,noProject)),code('RECOVERY_REQUIRED'));
  }
  complete(await readOnly(f,()=>f.owner.upgradeRecovery(f.expected)),'committed_state_verified');
  for(let index=0;index<257;index++)await mkdir(join(f.backupParent,randomUUID()));
  const bounded=await readOnly(f,()=>f.owner.upgradeRecovery(f.expected));
  assert.equal(bounded.data.complete,false);assert.equal(bounded.data.examinedEntries,258);
  assert.equal(bounded.data.artifacts.length,258);assert.equal(bounded.data.unresolvedEntries,257);
  await assert.rejects(inspected(f),code('RECOVERY_REQUIRED'));
});
