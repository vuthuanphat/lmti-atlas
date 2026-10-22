import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, realpath, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { LogicalHierarchyService } from '../dist/logical-hierarchy-service.js';
import { WriteCoordinator } from '../dist/write-coordinator.js';
import { ApiError } from '../dist/security.js';

// Typed owner replies isolate the service contract. These cases use the real
// coordinator but do not claim native atomicity, child lifetime or marker I/O.
const clone=v=>structuredClone(v),sha=v=>createHash('sha256').update(String(v)).digest('hex');
const uuid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const project='factory-monitor',other='second-project',action='logical-hierarchy-commit';
const code=name=>error=>error instanceof ApiError&&error.code===name;
const subsystem=(id,parent='',privacy='internal')=>({id,label:id,parentSubsystemId:parent,privacy});
const component=id=>({id,label:id,repositoryId:'repo-a',kind:'firmware',privacy:'public'});
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}
const base=a=>({ok:true,schema:'lmti.logical-hierarchy.owner.v1',action:a});
function changes() {
  return [
    {kind:'add_subsystem',desired:subsystem('new-zone')},
    {kind:'rename_subsystem',expected:subsystem('named-zone'),desiredLabel:'Renamed zone'},
    {kind:'reparent_subsystem',expected:subsystem('moving-zone'),desiredParentId:'new-zone'},
    {kind:'set_component_membership',expectedComponent:component('firmware-a'),
      expected:{componentId:'firmware-a',subsystemId:'named-zone'},desiredSubsystemId:'moving-zone'},
    {kind:'retire_empty_subsystem',expected:subsystem('retiring-zone')},
  ];
}
function proposal(id=project){return {projectId:id,expectedRevision:4,changes:changes()};}
function reviewedDiff() {
  return {
    subsystems:[
      {id:'moving-zone',before:subsystem('moving-zone'),after:subsystem('moving-zone','new-zone')},
      {id:'named-zone',before:subsystem('named-zone'),after:{...subsystem('named-zone'),label:'Renamed zone'}},
      {id:'new-zone',before:null,after:subsystem('new-zone')},
      {id:'retiring-zone',before:subsystem('retiring-zone'),after:null},
    ],
    memberships:[{componentId:'firmware-a',before:{componentId:'firmware-a',subsystemId:'named-zone'},
      after:{componentId:'firmware-a',subsystemId:'moving-zone'}}],
    affected:[
      {kind:'component',id:'firmware-a',beforeClassification:'internal',afterClassification:'internal',
        beforeAncestors:['named-zone'],afterAncestors:['new-zone','moving-zone']},
      {kind:'component',id:'inherited-child',beforeClassification:'internal',afterClassification:'internal',
        beforeAncestors:['moving-zone'],afterAncestors:['new-zone','moving-zone']},
      ...['moving-zone','named-zone','new-zone','retiring-zone'].map(id=>({
        kind:'subsystem',id,beforeClassification:id==='new-zone'?null:'internal',
        afterClassification:id==='retiring-zone'?null:'internal',beforeAncestors:[],
        afterAncestors:id==='moving-zone'?['new-zone']:[],
      })),
    ],
  };
}
function state(id,index) {
  return {
    ...base('logical-hierarchy-state'),
    libraryIdentity:{schema:3,canonicalPath:'C:/synthetic/library.sqlite',uuid:uuid(1),generation:2,digest:sha('library')},
    projectIdentity:{schemaVersion:2,projectId:id,canonicalPath:`C:/synthetic/${id}.sqlite`,storeUuid:uuid(index),
      revision:4,contentDigest:sha(id+'content'),registryDigest:sha(id+'registry')},
    projection:{projectId:id,revision:4,
      subsystems:['moving-zone','named-zone','retiring-zone'].map(name=>({value:subsystem(name),ancestors:[],classification:'internal'})),
      components:[{value:component('firmware-a'),membership:{componentId:'firmware-a',subsystemId:'named-zone'},
        ancestors:['named-zone'],classification:'internal'},
      {value:component('inherited-child'),membership:{componentId:'inherited-child',subsystemId:'moving-zone'},
        ancestors:['moving-zone'],classification:'internal'}]},
  };
}
function reply(outcome,request,details=null,preflightCode=null) {
  return {started:outcome!=='refused',preflightCode,reply:{schema:'lmti.project.operation.write.v1',
    action,outcome,code:outcome==='confirmed'?'NONE':'OWNER_UNAVAILABLE',operationId:null,
    details,detailsAvailable:details!==null}};
}
async function fixture(t,extra={}) {
  const root=await mkdtemp(join(tmpdir(),'lmti-hierarchy-service-'));
  await writeFile(join(root,'library.sqlite'),'controlled service fixture');
  let now=100000,live=true,allowed=true,grant=sha('hierarchy-grant');
  let grants=Object.freeze([{projectId:project,allowInternal:true},{projectId:other,allowInternal:true}]);
  const coordinator=await WriteCoordinator.create(join(root,'library.sqlite'),undefined,()=>now);
  const states=new Map([[project,state(project,2)],[other,state(other,3)]]);
  const session={key:'session-key'},sameKey={key:'session-key'},events=[],gates=[];
  const model={states,reads:[],conditionals:[],captures:[],writes:[],effects:0,started:0,
    diff:reviewedDiff(),outcome:'confirmed',fallback:false,queueGate:null,closeGate:null,
    queued:deferred(),entered:deferred(),readHook:null,captureHook:null,conditionalHook:null,writeHook:null,confirmed:[]};
  const hold=()=>{const gate=deferred();gates.push(gate);return gate;};
  const owner={
    async read(id,request,options={}) {
      await options.guard?.();model.reads.push(clone(request));
      await model.readHook?.(id,request);await options.guard?.();
      if(request.action==='logical-hierarchy-state')return clone(states.get(id));
      assert.equal(request.action,'logical-hierarchy-preview');
      const s=states.get(id),expected={libraryIdentity:clone(s.libraryIdentity),
        reviewToken:{...clone(s.projectIdentity),schema:'lmti.logical-hierarchy.review.v1',
          scope:{projectId:id,allowLogicalWrite:true,allowInternal:true},proposal:clone(request.proposal),
          proposalDigest:sha(JSON.stringify(request.proposal)),diffDigest:sha(JSON.stringify(model.diff))}};
      return {...base(request.action),expected,diff:clone(model.diff)};
    },
    async write(id,request,options={}) {
      model.writes.push(clone(request));model.queued.resolve();
      if(model.queueGate)await model.queueGate.promise;
      try{await options.guard?.();}catch(error){
        return reply('refused',request,null,error instanceof ApiError?error.code:'OWNER_UNAVAILABLE');
      }
      model.started++;events.push('started');model.entered.resolve();
      if(model.closeGate)await model.closeGate.promise;
      if(model.writeHook)return model.writeHook(id,request);
      if(model.outcome==='refused')return {...reply('refused',request),started:true};
      if(model.outcome==='unknown')return reply('unknown',request);
      const before=request.expected.reviewToken,s=states.get(id);
      model.effects++;s.projectIdentity.revision++;s.projection.revision++;
      s.projectIdentity.contentDigest=sha(id+'after');
      return reply('confirmed',request,model.fallback?null:{projectId:id,storeUuid:before.storeUuid,
        previousRevision:before.revision,revision:before.revision+1,proposalDigest:before.proposalDigest});
    },
  };
  const common={
    owner,coordinator,clock:()=>now,pendingMs:0,
    guard:()=>{if(!live)throw new ApiError('SESSION_EXPIRED');},alive:()=>live,
    authorize:(_s,id)=>{if(!allowed||!states.has(id))throw new ApiError('SCOPE_DENIED');},
    grants:()=>grants,grantId:()=>grant,
    captureSubject:async(id,expected,options)=>{
      await options.guard();events.push('capture');model.captures.push(clone(expected));
      await model.captureHook?.(id,expected);await options.guard();
      return {version:1,kind:'logical_hierarchy',action,projectId:id,grantId:grant,
        target:{library:expected.libraryIdentity.canonicalPath,project:expected.reviewToken.canonicalPath,
          storeUuid:expected.reviewToken.storeUuid,version:1}};
    },
    conditionalState:async(subject,options)=>{
      await options.guard();events.push('conditional');model.conditionals.push(clone(subject));
      await model.conditionalHook?.(subject);await options.guard();
      return clone(states.get(subject.projectId));
    },
    onConfirmed:id=>{model.confirmed.push(id);},...extra,
  };
  const service=new LogicalHierarchyService(common);
  t.after(async()=>{
    gates.forEach(g=>g.resolve());
    await service.waitForIdle();await coordinator.close();
    const canonicalRoot=await realpath(root),canonicalTemp=await realpath(tmpdir());
    const rel=relative(canonicalTemp,canonicalRoot);
    assert.ok(rel&&!rel.startsWith('..')&&!isAbsolute(rel));
    assert.equal(resolve(canonicalRoot),resolve(root));assert.equal((await lstat(root)).isSymbolicLink(),false);
    await rm(root,{recursive:true,force:true});
  });
  return {root,model,owner,service,coordinator,session,sameKey,common,events,hold,
    advance:n=>{now+=n;},setLive:v=>{live=v;},setAllowed:v=>{allowed=v;},
    setGrant:v=>{grant=sha(v);},setGrants:v=>{grants=v;}};
}
function noPrivate(value) {
  assert.doesNotMatch(JSON.stringify(value),/C:|synthetic|canonicalPath|storeUuid|contentDigest|registryDigest|proposalDigest|diffDigest|libraryIdentity|reviewToken|grantId|00000000-0000-/);
}
const preview=(f,id=project)=>f.service.preview(f.session,id,{proposal:proposal(id)});
async function complete(f,id) {
  await f.service.waitForIdle();await f.coordinator.waitForIdle();return f.service.lookup(f.session,id);
}

test('hierarchy scopes and complete state expose only authorized public rows and effective classification',async t=>{
  const f=await fixture(t),scopes=f.service.scopes(f.session),tree=await f.service.state(f.session,project);
  assert.deepEqual(scopes,{projects:[{projectId:project,allowInternal:true},{projectId:other,allowInternal:true}]});
  assert.deepEqual(tree,f.model.states.get(project).projection);
  assert.equal(tree.components[0].value.privacy,'public');assert.equal(tree.components[0].classification,'internal');
  noPrivate([scopes,tree]);assert.ok(Object.isFrozen(tree.components[0].ancestors));
  f.setAllowed(false);const before=f.model.reads.length;
  await assert.rejects(f.service.state(f.session,project),code('SCOPE_DENIED'));
  await assert.rejects(preview(f),code('SCOPE_DENIED'));assert.equal(f.model.reads.length,before);
});

test('complete five-operation review retains immutable original pins and rejects without a write',async t=>{
  const f=await fixture(t),input=proposal(),value=await f.service.preview(f.session,project,{proposal:input});
  assert.deepEqual(value.diff,f.model.diff);assert.equal(value.revision,4);assert.equal(value.expiresAt,new Date(220000).toISOString());
  assert.equal(value.diff.affected.find(v=>v.id==='inherited-child').afterAncestors.length,2);
  noPrivate(value);assert.match(value.id,/^[A-Za-z0-9_-]{43}$/);
  assert.throws(()=>{value.diff.affected[0].afterAncestors.push('forged');},TypeError);
  input.changes[0].desired.label='Mutated caller';assert.equal(f.model.captures[0].reviewToken.proposal.changes.find(c=>c.kind==='add_subsystem').desired.label,'new-zone');
  assert.equal(f.model.conditionals.length,1);assert.doesNotMatch(JSON.stringify(f.model.conditionals[0]),/changes|diff|label/);
  assert.deepEqual(f.service.reject(f.session,project,value.id),{rejected:true});
  await assert.rejects(f.service.commit(f.session,project,{previewId:value.id}),code('PREVIEW_EXPIRED'));
  assert.equal(f.model.writes.length,0);assert.equal(f.model.effects,0);
});

test('strict body, route scope, exact session object, grant and TTL bind a review',async t=>{
  const f=await fixture(t);
  for(const body of [{proposal:proposal(),path:'C:/forged'}, {proposal:{...proposal(),changes:[]}},
    {proposal:{...proposal(),scope:{allowInternal:true}}}])
    await assert.rejects(f.service.preview(f.session,project,body),code('INVALID_INPUT'));
  await assert.rejects(f.service.preview(f.session,other,{proposal:proposal()}),code('SCOPE_DENIED'));
  const value=await preview(f);
  await assert.rejects(f.service.commit(f.sameKey,project,{previewId:value.id}),code('PREVIEW_EXPIRED'));
  await assert.rejects(f.service.commit(f.session,other,{previewId:value.id}),code('PREVIEW_EXPIRED'));
  await assert.rejects(f.service.commit(f.session,project,{previewId:value.id,expected:{}}),code('INVALID_INPUT'));
  f.setGrant('revoked');await assert.rejects(f.service.commit(f.session,project,{previewId:value.id}),code('SCOPE_DENIED'));
  f.setGrant('hierarchy-grant');f.advance(120000);
  await assert.rejects(f.service.commit(f.session,project,{previewId:value.id}),code('PREVIEW_EXPIRED'));
  assert.equal(f.model.writes.length,0);
});

test('capture closes its original-target interval and rejects every independent identity pin drift',async t=>{
  const mutations=[
    s=>{s.libraryIdentity.generation++;},s=>{s.libraryIdentity.uuid=uuid(9);},
    s=>{s.libraryIdentity.digest=sha('drift');},s=>{s.libraryIdentity.canonicalPath='C:/synthetic/rebound.sqlite';},
    s=>{s.projectIdentity.revision++;},s=>{s.projectIdentity.storeUuid=uuid(8);},
    s=>{s.projectIdentity.contentDigest=sha('drift');},s=>{s.projectIdentity.registryDigest=sha('drift');},
    s=>{s.projectIdentity.canonicalPath='C:/synthetic/replaced.sqlite';},
  ];
  for(const mutate of mutations)await t.test('changed original snapshot pin',async t=>{
    const f=await fixture(t);f.model.captureHook=()=>mutate(f.model.states.get(project));
    await assert.rejects(preview(f),code('CONFIG_CHANGED'));assert.equal(f.model.effects,0);assert.equal(f.model.writes.length,0);
  });
});

test('BUSY preserves review and same-project serialization permits an unrelated shared lease',async t=>{
  const f=await fixture(t),value=await preview(f),epoch=f.coordinator.snapshot().epoch;
  const same=f.coordinator.acquire('shared',project,epoch);
  await assert.rejects(f.service.commit(f.session,project,{previewId:value.id}),code('BUSY'));same.release('known');
  const maintenance=f.coordinator.acquire('exclusive',null,epoch);
  await assert.rejects(f.service.commit(f.session,project,{previewId:value.id}),code('BUSY'));maintenance.release('known');
  const unrelated=f.coordinator.acquire('shared',other,epoch);
  const result=await f.service.commit(f.session,project,{previewId:value.id});unrelated.release('known');
  const job=await complete(f,result.operationId);
  assert.equal(job.state,'succeeded');assert.deepEqual(job.result.summary,{projectId:project,previousRevision:4,revision:5});
  assert.equal(f.model.effects,1);assert.equal(f.model.writes[0].expected.reviewToken.revision,4);noPrivate(job);
  await assert.rejects(f.service.commit(f.session,project,{previewId:value.id}),code('PREVIEW_EXPIRED'));
});

test('queued guard rechecks original state and authority after beforeStart without ordinary read fallback',async t=>{
  const cases=[
    ['scope',f=>f.setAllowed(false),'SCOPE_DENIED'],
    ['grant',f=>f.setGrant('revoked'),'SCOPE_DENIED'],
    ['expiry',f=>f.advance(120000),'PREVIEW_EXPIRED'],
    ['registry',f=>{f.model.states.get(project).projectIdentity.registryDigest=sha('new-registry');},'CONFIG_CHANGED'],
    ['physical',f=>{f.model.conditionalHook=()=>{throw new ApiError('RECOVERY_REQUIRED');};},'RECOVERY_REQUIRED'],
  ];
  for(const [name,mutate,expected] of cases)await t.test(name,async t=>{
    const f=await fixture(t),value=await preview(f);f.model.queueGate=f.hold();
    const result=await f.service.commit(f.session,project,{previewId:value.id});
    assert.equal(result.outcome,'pending');mutate(f);f.model.queueGate.resolve();
    await f.service.waitForIdle();await f.coordinator.waitForIdle();
    if(name==='scope')f.setAllowed(true);if(name==='grant')f.setGrant('hierarchy-grant');
    const job=f.service.lookup(f.session,result.operationId);
    assert.equal(job.state,'failed');assert.equal(job.result.code,expected);
    assert.equal(f.model.started,0);assert.equal(f.model.effects,0);
    assert.equal(f.model.reads.filter(r=>r.action==='logical-hierarchy-state').length,0);
    assert.equal(f.coordinator.snapshot().recoveryRequired,false);
  });
});

test('beforeStart is awaited before conditional verification and an early failure cannot dispatch',async t=>{
  const f=await fixture(t),gate=f.hold(),entered=deferred(),trace=[];
  const coordinator={
    snapshot:()=>f.coordinator.snapshot(),assertAllowed:e=>f.coordinator.assertAllowed(e),
    acquire(...args){const lease=f.coordinator.acquire(...args);return {
      beforeStart:async()=>{trace.push('publication');entered.resolve();await gate.promise;throw new ApiError('RECOVERY_REQUIRED');},
      release:outcome=>lease.release(outcome),
    };},
  };
  const service=new LogicalHierarchyService({...f.common,coordinator});
  t.after(()=>service.waitForIdle());
  const value=await service.preview(f.session,project,{proposal:proposal()}),before=f.model.conditionals.length;
  const pending=await service.commit(f.session,project,{previewId:value.id});await entered.promise;
  assert.deepEqual(trace,['publication']);assert.equal(f.model.conditionals.length,before);assert.equal(f.model.started,0);
  gate.resolve();await service.waitForIdle();await f.coordinator.waitForIdle();
  assert.equal(service.lookup(f.session,pending.operationId).result.outcome,'refused');
  assert.equal(f.model.started,0);
});

test('pending child simulation survives logout and cleanup until close with no cancellation or retry',async t=>{
  const f=await fixture(t),value=await preview(f);f.model.closeGate=f.hold();
  const pending=await f.service.commit(f.session,project,{previewId:value.id});await f.model.entered.promise;
  assert.equal(pending.outcome,'pending');assert.equal(f.service.isIdle(),false);assert.equal(f.coordinator.snapshot().activeLeases,1);
  f.setLive(false);f.service.cleanup();let drained=false;
  const drain=f.service.waitForIdle().then(()=>{drained=true;});
  await Promise.resolve();assert.equal(drained,false);
  assert.throws(()=>f.service.lookup(f.session,pending.operationId),code('SESSION_EXPIRED'));
  f.model.closeGate.resolve();await drain;await f.coordinator.waitForIdle();
  assert.equal(f.model.effects,1);assert.equal(f.model.writes.length,1);assert.equal(f.coordinator.snapshot().activeLeases,0);
  f.setLive(true);const job=f.service.lookup(f.session,pending.operationId);assert.equal(job.result.outcome,'confirmed');
  assert.throws(()=>f.service.lookup(f.sameKey,pending.operationId),code('SCOPE_DENIED'));
});

test('confirmed ACK survives refresh failure; confirmation invalidates same-project reviews only',async t=>{
  const f=await fixture(t,{onConfirmed:()=>{throw new Error('private refresh failure');}});
  const a=await preview(f),stale=await preview(f),unrelated=await preview(f,other);
  const first=await f.service.commit(f.session,project,{previewId:a.id}),job=await complete(f,first.operationId);
  assert.equal(job.result.outcome,'confirmed');assert.equal(f.coordinator.snapshot().recoveryRequired,false);
  await assert.rejects(f.service.commit(f.session,project,{previewId:stale.id}),code('PREVIEW_EXPIRED'));
  const second=await f.service.commit(f.session,other,{previewId:unrelated.id});
  assert.equal((await complete(f,second.operationId)).result.outcome,'confirmed');assert.equal(f.model.effects,2);noPrivate(job);
});

test('confirmed without details remains confirmed while retaining an original-subject recovery barrier',async t=>{
  const f=await fixture(t);f.model.fallback=true;const value=await preview(f);
  const result=await f.service.commit(f.session,project,{previewId:value.id}),job=await complete(f,result.operationId);
  assert.equal(job.state,'succeeded');assert.equal(job.result.outcome,'confirmed');assert.equal(job.result.summary,null);
  assert.equal(f.model.effects,1);assert.equal(f.coordinator.snapshot().recoveryRequired,true);
  const recovery=f.coordinator.recovery();assert.equal(recovery.subjects.length,1);
  assert.equal(recovery.subjects[0].subject.projectId,project);assert.doesNotMatch(JSON.stringify(recovery),/changes|afterAncestors/);
  await assert.rejects(preview(f),code('RECOVERY_REQUIRED'));noPrivate(job);
});

test('unknown remains historical after explicit common acknowledgment and requires a separate fresh review',async t=>{
  const f=await fixture(t);f.model.outcome='unknown';const value=await preview(f);
  const result=await f.service.commit(f.session,project,{previewId:value.id}),job=await complete(f,result.operationId);
  assert.equal(job.state,'unknown');assert.equal(f.coordinator.recovery().subjects.length,1);
  await f.service.state(f.session,project);assert.equal(f.coordinator.snapshot().recoveryRequired,true);
  assert.equal(f.model.writes.length,1);
  // Deliberately exercise the existing coordinator ACK, not an HTTP recovery
  // collector or a new hierarchy-specific recovery ledger.
  const acknowledgment=f.coordinator.beginReconciliation();await f.coordinator.acknowledge(acknowledgment);
  assert.equal(f.service.lookup(f.session,result.operationId).state,'unknown');
  await assert.rejects(f.service.commit(f.session,project,{previewId:value.id}),code('PREVIEW_EXPIRED'));
  f.model.outcome='confirmed';const fresh=await preview(f);
  const next=await f.service.commit(f.session,project,{previewId:fresh.id});assert.equal((await complete(f,next.operationId)).state,'succeeded');
});

test('discarding an authorized preview during a recovery barrier remains a read-free operation',async t=>{
  const f=await fixture(t),value=await preview(f);
  const subject={version:1,kind:'legacy',action:'profile_save',projectId:other,grantId:sha('other-grant'),target:{version:1}};
  const writer=f.coordinator.acquire('shared',other,f.coordinator.snapshot().epoch,subject);writer.release('unknown');
  const reads=f.model.reads.length,conditionals=f.model.conditionals.length;
  assert.equal(f.coordinator.snapshot().recoveryRequired,true);
  assert.deepEqual(f.service.reject(f.session,project,value.id),{rejected:true});
  assert.equal(f.model.reads.length,reads);assert.equal(f.model.conditionals.length,conditionals);assert.equal(f.model.writes.length,0);
  await assert.rejects(f.service.commit(f.session,project,{previewId:value.id}),code('PREVIEW_EXPIRED'));
});

test('another shared writer becoming unknown blocks a queued hierarchy dispatch and preserves its original subject',async t=>{
  const f=await fixture(t),value=await preview(f),epoch=f.coordinator.snapshot().epoch;
  const subject={version:1,kind:'legacy',action:'profile_save',projectId:other,grantId:sha('other-grant'),
    target:{version:1,original:'unrelated-original-target'}};
  const legacy=f.coordinator.acquire('shared',other,epoch,subject);await legacy.beforeStart();
  f.model.queueGate=f.hold();const pending=await f.service.commit(f.session,project,{previewId:value.id});
  legacy.release('unknown');f.model.queueGate.resolve();
  const job=await complete(f,pending.operationId);
  assert.equal(job.result.outcome,'refused');assert.equal(job.result.code,'RECOVERY_REQUIRED');
  assert.equal(f.model.started,0);assert.equal(f.coordinator.snapshot().recoveryRequired,true);
  assert.deepEqual(f.coordinator.recovery().subjects.map(e=>e.subject.projectId),[other]);
});

test('unexpected post-dispatch exception is unknown and never exposes raw errors or retries',async t=>{
  const f=await fixture(t);f.model.writeHook=()=>{throw new Error('C:/synthetic/private-error');};
  const value=await preview(f),result=await f.service.commit(f.session,project,{previewId:value.id});
  const job=await complete(f,result.operationId);assert.equal(job.result.outcome,'unknown');assert.equal(job.result.code,'RECOVERY_REQUIRED');
  assert.equal(f.model.started,1);assert.equal(f.model.writes.length,1);noPrivate(job);
  assert.equal(f.coordinator.snapshot().recoveryRequired,true);
});

test('full state supports more than the generic recovery collection limit and refuses oversized complete output',async t=>{
  const f=await fixture(t),s=f.model.states.get(project);
  s.projection.components=Array.from({length:300},(_,i)=>({value:component('component-'+String(i).padStart(4,'0')),
    membership:null,ancestors:[],classification:'public'}));
  const full=await f.service.state(f.session,project);assert.equal(full.components.length,300);noPrivate(full);
  s.projection.components=Array.from({length:1200},(_,i)=>({value:{...component('component-'+String(i).padStart(4,'0')),label:'x'.repeat(120)},
    membership:null,ancestors:[],classification:'public'}));
  assert.ok(Buffer.byteLength(JSON.stringify(s))<512*1024,'native frame remains within its separate cap');
  await assert.rejects(f.service.state(f.session,project),code('LIMIT_EXCEEDED'));
});

test('oversized diff refuses before original-subject capture or actionable review retention',async t=>{
  const f=await fixture(t);
  f.model.diff.affected=Array.from({length:2000},(_,i)=>({kind:'component',id:'component-'+String(i).padStart(4,'0'),
    beforeClassification:'internal',afterClassification:'internal',
    beforeAncestors:['named-zone'],afterAncestors:['new-zone','moving-zone']}));
  assert.ok(Buffer.byteLength(JSON.stringify(f.model.diff))<500*1024,'leave room for native private tokens');
  await assert.rejects(preview(f),code('LIMIT_EXCEEDED'));
  assert.equal(f.model.captures.length,0);assert.equal(f.model.conditionals.length,0);assert.equal(f.model.writes.length,0);
  f.model.diff=reviewedDiff();const value=await preview(f);assert.ok(value.id);
});

test('public cap includes HTTP envelope overhead instead of accepting a data-only boundary',async t=>{
  const f=await fixture(t),s=f.model.states.get(project),cap=256*1024;
  s.projection.components=Array.from({length:1200},(_,i)=>({value:{...component('component-'+String(i).padStart(4,'0')),label:'x'},
    membership:null,ancestors:[],classification:'public'}));
  const size=()=>Buffer.byteLength(JSON.stringify(s.projection));
  assert.ok(size()<cap-20);
  // Distribute exact padding among authorized labels, retaining the native
  // 120-byte per-label bound and complete component rows.
  for(const row of s.projection.components){
    const missing=cap-20-size();if(missing<=0)break;
    row.value.label+='x'.repeat(Math.min(120-row.value.label.length,missing));
  }
  assert.equal(size(),cap-20);assert.ok(Buffer.byteLength(JSON.stringify(s))<512*1024);
  await assert.rejects(f.service.state(f.session,project),code('LIMIT_EXCEEDED'));
});

test('bounded retention never evicts an existing review and finished-job cleanup does not rewrite outcomes',async t=>{
  const f=await fixture(t),reviews=[];
  for(let i=0;i<64;i++)reviews.push(await preview(f));
  await assert.rejects(preview(f),code('LIMIT_EXCEEDED'));
  assert.deepEqual(f.service.reject(f.session,project,reviews[0].id),{rejected:true});
  const value=await preview(f),result=await f.service.commit(f.session,project,{previewId:value.id});
  const job=await complete(f,result.operationId);assert.equal(job.state,'succeeded');
  f.advance(600000);f.service.cleanup();assert.equal(f.service.lookup(f.session,result.operationId),null);
  assert.equal(job.state,'succeeded');assert.equal(f.model.effects,1);
});

test('invalidation and removed explicit grants prevent retained previews before native dispatch',async t=>{
  const f=await fixture(t),a=await preview(f),b=await preview(f,other);
  f.service.invalidate(project);
  await assert.rejects(f.service.commit(f.session,project,{previewId:a.id}),code('PREVIEW_EXPIRED'));
  f.setGrants([{projectId:project,allowInternal:true}]);
  await assert.rejects(f.service.commit(f.session,other,{previewId:b.id}),code('SCOPE_DENIED'));
  assert.equal(f.model.writes.length,0);f.service.invalidate();
});
