import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,readFile,rename,rm} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {PhysicalHierarchyOwner} from '../dist/physical-hierarchy-owner.js';
import {PhysicalHierarchyRecovery} from '../dist/physical-hierarchy-recovery.js';
import {ApiError} from '../dist/security.js';
import {canonicalRecoveryJson} from '../dist/recovery-subject.js';
import {recoveryValueKey} from '../dist/legacy-recovery-target.js';
import {authority,library,identity,clone,review,state,asset,path} from './fixtures/physical-hierarchy.mjs';

const key=p=>process.platform==='win32'?p.replaceAll('\\','/').toLowerCase():p;
async function fixture(t){
  const parent=resolve(process.env.LMTI_WEB_TEST_TMP??tmpdir());await mkdir(parent,{recursive:true});
  const root=await mkdtemp(join(parent,'physical-recovery-'));
  t.after(async()=>{assert.ok(resolve(root).startsWith(parent+sep));await rm(root,{recursive:true,force:true});});
  const libraryPath=join(root,'library.sqlite'),database=join(root,'project.sqlite');
  await writeFile(libraryPath,'controlled library identity fixture');await writeFile(database,'controlled project identity fixture');
  const config={adminBinary:join(root,'admin.exe'),library:libraryPath,projects:[authority]};
  const l={...library,canonicalPath:key(libraryPath)},p={...identity,canonicalPath:key(database)};
  const expected=review().expected;expected.libraryIdentity=l;Object.assign(expected.reviewToken,p);
  const original=state();original.libraryIdentity=l;original.projectIdentity=p;
  const locator={ok:true,schema:'lmti.physical-hierarchy.owner.v1',action:'physical-hierarchy-locator',
    libraryIdentity:l,projectId:'project',database,linkedRoot:join(root,'offline-root')};
  let mainCalls=0,grant='d'.repeat(64),response=q=>q.action==='physical-hierarchy-locator'?locator:{...original,action:q.action};
  const calls=[],verify={run:async(binary,args,input,options)=>{
    await options.guard?.();const q=JSON.parse(input);calls.push({binary,args,input,options});
    return clone(response(q));
  }};
  const owner=new PhysicalHierarchyOwner(config,{run:async()=>{mainCalls++;throw new Error('Ordinary read must not run.');}},verify);
  const recovery=new PhysicalHierarchyRecovery(owner,project=>{if(project!=='project')throw new ApiError('SCOPE_DENIED');return grant;});
  return {root,config,database,l,p,expected,original,locator,calls,owner,recovery,
    setResponse:fn=>{response=fn;},revoke:()=>{grant='e'.repeat(64);},mainCalls:()=>mainCalls};
}
test('capture uses library-only locator then dedicated original state with complete identity and no profiles',async t=>{
  const f=await fixture(t),before=[await readFile(f.config.library),await readFile(f.database)];
  const subject=await f.recovery.captureSubject('project',f.expected);
  assert.deepEqual(f.calls.map(c=>JSON.parse(c.input).action),['physical-hierarchy-locator','physical-hierarchy-original-state']);
  assert.equal(f.mainCalls(),0);assert.equal(subject.kind,'physical_hierarchy');assert.equal(subject.grantId,'d'.repeat(64));
  assert.equal(subject.target.original.project.physical.path,f.database);
  assert.equal(subject.target.original.linkedRoot,f.locator.linkedRoot);
  assert.equal(subject.target.original.project.physical.chain.every(v=>typeof v.ino==='string'),true);
  assert.deepEqual(Object.keys(subject.target.pins).sort(),['diffDigest','libraryIdentity','projectIdentity','proposalDigest']);
  assert.ok(Object.isFrozen(subject.target));assert.ok(Buffer.byteLength(canonicalRecoveryJson(subject))<=32*1024);
  for(const c of f.calls){
    assert.deepEqual(c.args,['--physical-hierarchy-read','--library',f.config.library,'--project','project','--visibility','internal']);
    assert.equal(c.options.cap,512*1024);assert.equal(c.options.newlineTerminated,true);assert.equal(c.options.timeoutMs,30000);
    assert.equal(c.args.includes('--profiles'),false);assert.ok(Buffer.byteLength(c.input)<=64*1024);
  }
  assert.equal(f.calls[1].options.jsonArrayLimit,16000);
  assert.deepEqual([await readFile(f.config.library),await readFile(f.database)],before);
});
test('changed catalog token refuses before using nonexistent substituted path',async t=>{
  const f=await fixture(t);
  f.setResponse(()=>({...f.locator,libraryIdentity:{...f.l,generation:3},database:join(f.root,'missing','project.sqlite')}));
  await assert.rejects(f.recovery.captureSubject('project',f.expected),{code:'CONFIG_CHANGED'});
  assert.equal(f.calls.length,1);assert.equal(f.mainCalls(),0);
});
test('revocation between capture observations prevents next metadata probe and selected dispatch',async t=>{
  const f=await fixture(t);f.setResponse(()=>({...f.locator,database:join(f.root,'missing','project.sqlite')}));
  let guards=0;
  await assert.rejects(f.recovery.captureSubject('project',f.expected,{guard:()=>{
    if(++guards===4)throw new ApiError('SESSION_EXPIRED');
  }}),{code:'SESSION_EXPIRED'});
  assert.equal(guards,4);assert.equal(f.calls.length,1);
});
test('capture pins full snapshot but recovery observes later revision without changing retained historical pins',async t=>{
  const f=await fixture(t);
  const later={...clone(f.original),projectIdentity:{...f.p,revision:5,contentDigest:'f'.repeat(64)},
    projection:{...clone(f.original.projection),revision:5}};
  f.setResponse(q=>q.action==='physical-hierarchy-locator'?f.locator:{...later,action:q.action});
  await assert.rejects(f.recovery.captureSubject('project',f.expected),{code:'CONFIG_CHANGED'});
  f.setResponse(q=>q.action==='physical-hierarchy-locator'?f.locator:{...f.original,action:q.action});
  const subject=await f.recovery.captureSubject('project',f.expected),before=canonicalRecoveryJson(subject),old=await f.recovery.inspect(subject);
  f.setResponse(q=>({...later,action:q.action}));const next=await f.recovery.inspect(subject);
  assert.deepEqual(next.physicalHierarchySummary,{projectId:'project',projectRevision:5});
  assert.notEqual(next.digest,old.digest);assert.equal(canonicalRecoveryJson(subject),before);
  assert.deepEqual(Object.keys(next).sort(),['digest','physicalHierarchySummary']);
});
test('physical original target replacement refuses before native dispatch and never falls back to current resolution',async t=>{
  for(const which of ['library','project']){
    const f=await fixture(t),subject=await f.recovery.captureSubject('project',f.expected);
    f.calls.length=0;const file=which==='library'?f.config.library:f.database,retained=join(f.root,which+'-retained.sqlite');
    assert.ok(resolve(file).startsWith(resolve(f.root)+sep)&&resolve(retained).startsWith(resolve(f.root)+sep));
    const content=await readFile(file);await rename(file,retained);await writeFile(file,content);
    await assert.rejects(f.recovery.conditionalState(subject),{code:'CONFIG_CHANGED'});
    assert.equal(f.calls.length,0);assert.equal(f.mainCalls(),0);
    assert.deepEqual(await readFile(retained),content);
  }
});
test('grant and strict original/pin tampering deny all reads before target inspection',async t=>{
  const f=await fixture(t),subject=await f.recovery.captureSubject('project',f.expected);f.calls.length=0;
  for(const mutate of [
    s=>s.kind='logical_hierarchy',s=>s.action='logical-hierarchy-commit',s=>s.projectId='other',
    s=>s.target.original.library.physical.path=f.database,s=>s.target.original.profiles={},
    s=>s.target.pins.projectIdentity.storeUuid=library.uuid,s=>s.target.pins.extra=true,
    s=>s.target.original.project.physical.state=['present'],s=>s.target.original.project.schema=1,
  ]){
    const bad=clone(subject);mutate(bad);assert.throws(()=>f.recovery.authorize(bad),e=>e instanceof ApiError);
  }
  f.revoke();await assert.rejects(f.recovery.conditionalState(subject),{code:'SCOPE_DENIED'});
  assert.equal(f.calls.length,0);
});
test('queued conditional guard rechecks before dispatch and protects sole-main-pool independence',async t=>{
  const f=await fixture(t),subject=await f.recovery.captureSubject('project',f.expected);f.calls.length=0;
  let checks=0;
  await assert.rejects(f.recovery.conditionalState(subject,{guard:()=>{
    if(++checks===4)throw new ApiError('SESSION_EXPIRED');
  }}),{code:'SESSION_EXPIRED'});
  assert.equal(checks,4);assert.equal(f.calls.length,0);assert.equal(f.mainCalls(),0);
});
test('full decoded recovery evidence exceeds generic256-row budget without retaining graph or acknowledging outcome',async t=>{
  const f=await fixture(t),subject=await f.recovery.captureSubject('project',f.expected);
  const large=clone(f.original);large.projection.assets=Array.from({length:300},(_,i)=>({
    value:asset('item'+String(i).padStart(3,'0'),'public'),placement:null,path:path('old-site'),classification:'public',
  }));
  f.setResponse(q=>({...large,action:q.action}));
  assert.throws(()=>canonicalRecoveryJson(large),{code:'LIMIT_EXCEEDED'});
  const result=await f.recovery.inspect(subject);
  assert.match(result.digest,/^[a-f0-9]{64}$/);assert.equal(result.physicalHierarchySummary.projectRevision,4);
  assert.ok(Buffer.byteLength(recoveryValueKey(large))<512*1024);
  assert.ok(!Object.hasOwn(subject.target,'projection'));assert.equal(subject.target.pins.projectIdentity.revision,4);
});
test('valid native refusal and malformed post-read identity remain blocked without ordinary fallback',async t=>{
  const f=await fixture(t),subject=await f.recovery.captureSubject('project',f.expected);
  f.setResponse(()=>({ok:false,code:'CONFIG_CHANGED'}));
  await assert.rejects(f.recovery.inspect(subject),{code:'CONFIG_CHANGED'});
  f.setResponse(q=>({...f.original,action:q.action,projectIdentity:{...f.p,storeUuid:library.uuid}}));
  await assert.rejects(f.recovery.inspect(subject),{code:'OWNER_UNAVAILABLE'});
  assert.equal(f.mainCalls(),0);
});
