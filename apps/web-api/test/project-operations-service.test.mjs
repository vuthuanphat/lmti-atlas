import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { ProjectOperationsService } from '../dist/project-operations-service.js';
import { WriteCoordinator } from '../dist/write-coordinator.js';
import { ApiError } from '../dist/security.js';
import { ProjectOperationRecovery } from '../dist/project-operations-recovery.js';
import { collectOriginalTargets } from '../dist/recovery-collection.js';

// These tests exercise the broker state machine with typed native-shaped
// responses and the real coordinator. Native storage/process contracts are
// covered separately; this fixture is not evidence of SQLite atomicity.
const clone=v=>structuredClone(v), sha=v=>createHash('sha256').update(String(v)).digest('hex');
const uuid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const p='factory-monitor',other='other-project';
const base=action=>({ok:true,schema:'lmti.project.operations.v1',action});
const refusal=(r,code='CONFIG_CHANGED')=>({started:false,preflightCode:code,reply:{
  schema:'lmti.project.operation.write.v1',action:r.action,outcome:'refused',code:'OWNER_UNAVAILABLE',
  operationId:null,details:null,detailsAvailable:false}});
const unknown=r=>({started:true,preflightCode:null,reply:{schema:'lmti.project.operation.write.v1',
  action:r.action,outcome:'unknown',code:'OWNER_UNAVAILABLE',operationId:null,details:null,detailsAvailable:false}});
function deferred() {let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}
const code=name=>error=>error instanceof ApiError&&error.code===name;
function model() {
  const state={
    library:{schema:3,canonicalPath:'C:/private/library.sqlite',uuid:uuid(1),generation:1,digest:sha('bindings')},
    source:{schemaVersion:2,projectId:p,canonicalPath:'C:/private/source.sqlite',storeUuid:uuid(2),
      revision:4,contentDigest:sha('source'),registryDigest:sha('registry')},
    copies:[],receipts:new Map(),conditions:new Map(),reads:[],writes:[],effects:0,
    snapshot:sha('copies'),historySnapshot:sha('history'),upgradeId:null,activationUpgradeId:null,legacyDigest:null,backupDigest:null,nextId:100,readFailure:null,complete:true,
  };
  const copyPreview=()=>({mode:state.source.schemaVersion===1?'migrate_v1':'clone_v2',
    seedsInternalSites:state.source.schemaVersion===1,source:clone(state.source),targetRevision:state.source.revision+1,
    targetContentDigest:sha('target'),targetRegistryDigest:sha('targetRegistry')});
  const project=()=>({projectId:p,name:'Synthetic fixture',database:'C:/private/source.sqlite',root:'C:/private/root',
    schemaVersion:state.source.schemaVersion,storeUuid:state.source.storeUuid,revision:state.source.revision});
  const addCopy=(projectId=p,n=state.nextId++)=>{
    const preview=copyPreview(),source={...preview.source,projectId},operationId=uuid(n);
    const target={...source,schemaVersion:2,canonicalPath:`C:/private/copies/${operationId}/project.sqlite`,
      storeUuid:uuid(n+1000),revision:preview.targetRevision,contentDigest:preview.targetContentDigest,registryDigest:preview.targetRegistryDigest};
    const item={operationId,state:'uninspected',intent:{mode:preview.mode,seedsInternalSites:preview.seedsInternalSites,source,target}};
    state.copies.push(item);return item;
  };
  state.addCopy=addCopy;
  state.result=request=>{
    if(state.readFailure?.(request))throw new ApiError('OWNER_UNAVAILABLE');
    const action=request.action;
    if(action==='inspect')return {...base(action),libraryIdentity:clone(state.library),project:project()};
    if(action==='copy-preview')return {...base(action),projectId:p,libraryIdentity:clone(state.library),preview:copyPreview()};
    if(action==='library-format-status')return {...base(action),libraryIdentity:clone(state.library),
      upgradeOperationId:state.upgradeId,legacyDigest:state.legacyDigest,activationFormatOperationId:state.activationUpgradeId,activationFormatBackupDigest:state.backupDigest};
    if(action==='library-format-preview') {
      if(request.fromSchema!==state.library.schema)throw new ApiError('CONFIG_CHANGED');
      return {...base(action),fromSchema:request.fromSchema,toSchema:request.fromSchema+1,
        expected:request.fromSchema===1?clone(state.library):{source:clone(state.library),fullSnapshotDigest:sha('fullSnapshot')}};
    }
    if(action==='copy-discover') {
      if(request.snapshot!==null&&request.snapshot!==state.snapshot)throw new ApiError('CONFIG_CHANGED');
      const items=state.copies.slice(request.offset,request.offset+request.limit),stop=request.offset+items.length;
      return {...base(action),complete:state.complete,code:state.complete?'NONE':'BUDGET_EXCEEDED',
        examinedEntries:state.copies.length,unattributedEntries:state.unattributedEntries??0,snapshot:state.snapshot,offset:request.offset,
        nextOffset:stop<state.copies.length?stop:null,items};
    }
    if(action==='copy-inspect') {
      const item=state.copies.find(v=>v.operationId===request.operationId);
      return {...base(action),status:item?{operationId:item.operationId,state:'prepared',code:'NONE',verifiedReceipt:true,...clone(item.intent)}:
        {operationId:request.operationId,state:'recovery_required',code:'EVIDENCE_INVALID',verifiedReceipt:false,mode:null,seedsInternalSites:null,source:null,target:null}};
    }
    if(action==='activation-candidate') {
      const item=state.copies.find(v=>v.operationId===request.copyOperationId);assert.ok(item);
      return {...base(action),preview:{library:clone(state.library),projectId:p,copyParent:'C:/private/copies',
        copyOperationId:item.operationId,...clone(item.intent)}};
    }
    if(action==='activation-history') {
      if(request.snapshot!==null&&request.snapshot!==state.historySnapshot)throw new ApiError('CONFIG_CHANGED');
      const all=[...state.receipts.values()].filter(r=>r.prepared.projectId===request.projectId).map(r=>({
        operationId:r.token.operationId,projectId:r.prepared.projectId,copyOperationId:r.prepared.copyOperationId,state:r.state,revision:r.token.revision}));
      const items=all.slice(request.offset,request.offset+request.limit),stop=request.offset+items.length;
      return {...base(action),libraryIdentity:clone(state.library),projectId:request.projectId,
        snapshot:state.historySnapshot,offset:request.offset,nextOffset:stop<all.length?stop:null,items};
    }
    if(action==='activation-inspect') {
      const receipt=state.receipts.get(request.operationId);assert.ok(receipt);
      if(request.libraryUuid!==state.library.uuid)throw new ApiError('CONFIG_CHANGED');
      const condition=state.conditions.get(request.operationId)??(receipt.state==='prepared'?'prepared_current':receipt.state==='activated'?'activated_current':'abandoned');
      return {...base(action),libraryIdentity:clone(state.library),receipt:clone(receipt),condition,
        code:condition==='unavailable'?'OWNER_UNAVAILABLE':condition==='prepared_stale'?'CONFIG_CHANGED':'NONE'};
    }
    throw new Error('unexpected fixture read');
  };
  state.confirm=request=>{
    const action=request.action;let details,operationId;
    if(action==='copy-prepare') {
      const item=addCopy();operationId=item.operationId;
      details={operationId,state:'prepared',code:'NONE',verifiedReceipt:true,...clone(item.intent)};
    } else if(action.startsWith('library-upgrade')) {
      operationId=uuid(state.nextId++);state.library.schema++;
      if(state.library.schema===2){state.library.uuid=uuid(1);state.library.generation=1;state.upgradeId=operationId;state.legacyDigest=request.expected.digest;}
      else {state.activationUpgradeId=operationId;state.backupDigest=request.expected.fullSnapshotDigest;}
      details={state:'upgraded',operationId,backupPath:`C:/private/backups/${operationId}/library-v1.sqlite`,libraryIdentity:clone(state.library)};
    } else if(action==='activation-prepare') {
      operationId=uuid(state.nextId++);
      const receipt={token:{libraryUuid:state.library.uuid,operationId,receiptDigest:sha(operationId),revision:1},
        state:'prepared',prepared:clone(request.expected),sourceFolder:null,sourceFolderKey:'',activatedGeneration:0};
      state.receipts.set(operationId,receipt);details={receipt:clone(receipt)};
    } else {
      operationId=request.expected.operationId;const receipt=state.receipts.get(operationId);assert.ok(receipt);
      receipt.state=action==='activation-activate'?'activated':'abandoned';
      receipt.token={...receipt.token,receiptDigest:sha(operationId+'terminal'),revision:2};
      if(action==='activation-activate') {
        state.library.generation++;state.library.digest=sha('new binding');
        receipt.activatedGeneration=state.library.generation;
      }
      details={receipt:clone(receipt)};
    }
    state.effects++;
    return {started:true,preflightCode:null,reply:{schema:'lmti.project.operation.write.v1',action,
      outcome:'confirmed',code:'NONE',operationId,details,detailsAvailable:true}};
  };
  return state;
}
async function fixture(t,options={}) {
  const root=await mkdtemp(join(tmpdir(),'lmti-service-'));
  await writeFile(join(root,'library.sqlite'),'fixture-owner-file');
  await mkdir(join(root,'copies'));await mkdir(join(root,'backups'));
  let now=100000,alive=true,grant=sha('trusted-grant'),legacy=sha('legacy');
  const coordinator=await WriteCoordinator.create(join(root,'library.sqlite'),undefined,()=>now),state=model();
  const session={key:'same-key'},otherSession={key:'same-key'};
  const owner={
    config:{adminBinary:join(root,'unused-admin.exe'),library:join(root,'library.sqlite'),copyParent:join(root,'copies'),backupParent:join(root,'backups')},
    async read(request,opts={}) {
      await opts.guard?.();state.reads.push({request:clone(request),verify:opts.verify===true});return clone(state.result(request));
    },
    async upgradeRecovery(_expected,opts={}) {
      await opts.guard?.();
      // This broker-only fixture has no full native backup-parent observation.
      throw new ApiError('RECOVERY_REQUIRED');
    },
    async write(request,opts={}) {
      state.writes.push(clone(request));
      try {await opts.guard?.();}catch(e){return refusal(request,e instanceof ApiError?e.code:'OWNER_UNAVAILABLE');}
      opts.onStarted?.();return state.confirm(request);
    },
  };
  const recoveryOwner=new ProjectOperationRecovery(owner,()=>grant);
  const common={owner,coordinator,guard:()=>{if(!alive)throw new ApiError('SESSION_EXPIRED');},alive:()=>alive,
    authorize:(_s,project)=>{if(project!==null&&project!==p&&project!==other)throw new ApiError('SCOPE_DENIED');},
    grantId:()=>grant,captureSubject:(r,receipt)=>recoveryOwner.capture(r,receipt),
    verifySubject:s=>recoveryOwner.verify(s),
    collectRecovery:async(session,active)=>{
      const value=await collectOriginalTargets(active,{
        guard:()=>{if(!alive)throw new ApiError('SESSION_EXPIRED');},
        authorize:s=>{if(s.grantId!==grant)throw new ApiError('SCOPE_DENIED');},
        inspect:s=>recoveryOwner.inspect(s,()=>{if(!alive)throw new ApiError('SESSION_EXPIRED');},
          project=>{if(project!==p&&project!==other)throw new ApiError('SCOPE_DENIED');}),
        librarySchema:async()=>state.library.schema
      });
      return {digest:sha(value.digest+legacy),librarySchema:value.librarySchema};
    },onReconciled:()=>{},onConfirmed:()=>{},
    clock:()=>now,pendingMs:8000,...options};
  const service=new ProjectOperationsService(common);
  t.after(async()=>{
    await service.waitForIdle();await coordinator.close();
    assert.ok(root.startsWith(join(tmpdir(),'lmti-service-')));await rm(root,{recursive:true,force:true});
  });
  return {root,coordinator,state,owner,session,otherSession,service,common,
    advance:n=>{now+=n;},setAlive:v=>{alive=v;},setGrant:v=>{grant=sha(v);},setLegacy:v=>{legacy=sha(v);}};
}
function noPrivate(value) {
  const text=JSON.stringify(value);
  assert.doesNotMatch(text,/C:|private|canonicalPath|receiptDigest|contentDigest|storeUuid|00000000-0000-|unattributed|snapshot|copyParent|backupPath/);
}
async function copyHandle(f) {
  f.state.addCopy();const page=await f.service.copies(f.session,p,{limit:1,cursor:null});return page.items[0].handle;
}
async function prepared(f) {
  const handle=await copyHandle(f),preview=await f.service.activationPreview(f.session,p,{copyHandle:handle});
  const result=await f.service.commit(f.session,p,{previewId:preview.id});assert.equal(result.outcome,'confirmed');
  return {copy:handle,activation:result.recoveryHandle,result};
}

test('status and strict public input expose neither native paths nor private identity',async t=>{
  const f=await fixture(t),s=await f.service.projectStatus(f.session,p),l=await f.service.libraryStatus(f.session);
  assert.deepEqual(s,{projectId:p,projectSchema:2,projectRevision:4,librarySchema:3,
    capabilities:{copyModes:['clone_v2'],activation:true},recoveryRequired:false});
  noPrivate([s,l]);
  await assert.rejects(f.service.copyPreview(f.session,p,{mode:'clone_v2',path:'C:/bad'}),code('INVALID_INPUT'));
  await assert.rejects(f.service.projectStatus(f.session,'denied-project'),code('SCOPE_DENIED'));
  await assert.rejects(f.service.copyPreview(f.session,p,{mode:'delete'}),code('INVALID_INPUT'));
  assert.equal(f.state.effects,0);
});
test('filtered candidate paging retains each matching row and rejects native snapshot drift',async t=>{
  const f=await fixture(t);
  for(let i=0;i<54;i++)f.state.addCopy(other);
  const a=f.state.addCopy(),b=f.state.addCopy();
  const first=await f.service.copies(f.session,p,{limit:1,cursor:null});
  assert.equal(first.items.length,1);assert.ok(first.nextCursor);noPrivate(first);
  const second=await f.service.copies(f.session,p,{limit:1,cursor:first.nextCursor});
  assert.equal(second.items.length,1);assert.equal(second.nextCursor,null);assert.notEqual(first.items[0].handle,second.items[0].handle);
  const x=await f.service.recovery(f.session,p,first.items[0].handle),y=await f.service.recovery(f.session,p,second.items[0].handle);
  assert.equal(x.targetRevision,a.intent.target.revision);assert.equal(y.targetRevision,b.intent.target.revision);
  assert.equal(f.state.reads.filter(r=>r.request.action==='copy-discover').at(-1).request.offset,55);
  f.state.snapshot=sha('changed');
  await assert.rejects(f.service.copies(f.session,p,{limit:1,cursor:first.nextCursor}),code('CONFIG_CHANGED'));
});
test('incomplete discovery is explicit, foreign and unattributed entries never become handles',async t=>{
  const f=await fixture(t);f.state.addCopy(other);
  f.state.copies.push({operationId:uuid(999),state:'invalid',intent:null});
  assert.deepEqual(await f.service.copies(f.session,p,{limit:50,cursor:null}),{items:[],nextCursor:null});
  f.state.complete=false;
  await assert.rejects(f.service.copies(f.session,p,{limit:50,cursor:null}),code('LIMIT_EXCEEDED'));
});
test('session object, grant, project and expiry bind every retained handle',async t=>{
  const f=await fixture(t),handle=await copyHandle(f);
  await assert.rejects(f.service.recovery(f.otherSession,p,handle),code('PREVIEW_EXPIRED'));
  await assert.rejects(f.service.recovery(f.session,other,handle),code('PREVIEW_EXPIRED'));
  await assert.rejects(f.service.recovery(f.session,p,uuid(100)),code('INVALID_INPUT'));
  f.setGrant('changed');
  await assert.rejects(f.service.recovery(f.session,p,handle),code('SCOPE_DENIED'));
  f.setGrant('trusted-grant');f.advance(600001);
  await assert.rejects(f.service.recovery(f.session,p,handle),code('PREVIEW_EXPIRED'));
});
test('BUSY precedes consumption; accepted preview is immutable, one use, with safe result',async t=>{
  const f=await fixture(t),preview=await f.service.copyPreview(f.session,p,{mode:'clone_v2'});
  const held=f.coordinator.acquire('shared',other,f.coordinator.snapshot().epoch);
  await assert.rejects(f.service.commit(f.session,p,{previewId:preview.id}),code('BUSY'));held.release('known');
  assert.throws(()=>{preview.review.sourceRevision=999;},TypeError);
  const result=await f.service.commit(f.session,p,{previewId:preview.id});
  assert.equal(result.outcome,'confirmed');assert.equal(f.state.writes[0].expected.preview.source.revision,4);
  noPrivate(result);assert.equal(f.state.effects,1);
  await assert.rejects(f.service.commit(f.session,p,{previewId:preview.id}),code('PREVIEW_EXPIRED'));
  const job=f.service.lookup(f.session,result.operationId);assert.equal(job.state,'succeeded');noPrivate(job);
});
test('rejection and bounded reviews never invoke a native writer',async t=>{
  const f=await fixture(t),preview=await f.service.copyPreview(f.session,p,{mode:'clone_v2'});
  assert.deepEqual(f.service.reject(f.session,p,preview.id),{rejected:true});
  await assert.rejects(f.service.commit(f.session,p,{previewId:preview.id}),code('PREVIEW_EXPIRED'));
  for(let i=0;i<64;i++)await f.service.copyPreview(f.session,p,{mode:'clone_v2'});
  await assert.rejects(f.service.copyPreview(f.session,p,{mode:'clone_v2'}),code('LIMIT_EXCEEDED'));
  assert.equal(f.state.writes.length,0);
});
test('queued verification detects changed source and uses the separate verifier',async t=>{
  const f=await fixture(t),preview=await f.service.copyPreview(f.session,p,{mode:'clone_v2'});
  f.state.source.revision++;
  const result=await f.service.commit(f.session,p,{previewId:preview.id});
  assert.equal(result.outcome,'refused');assert.equal(result.code,'CONFIG_CHANGED');assert.equal(f.state.effects,0);
  assert.ok(f.state.reads.some(r=>r.verify&&r.request.action==='copy-preview'));assert.equal(f.coordinator.snapshot().recoveryRequired,false);
});
test('queued expiry and grant drift refuse before effects; rejected review cannot be replayed',async t=>{
  for(const change of ['expiry','grant']) {
    const f=await fixture(t),entered=deferred(),release=deferred();
    f.owner.write=async(r,o)=>{entered.resolve();await release.promise;try{await o.guard();}catch(e){return refusal(r,e.code);}return f.state.confirm(r);};
    const preview=await f.service.copyPreview(f.session,p,{mode:'clone_v2'});
    const result=f.service.commit(f.session,p,{previewId:preview.id});await entered.promise;
    if(change==='expiry')f.advance(120001);else f.setGrant('withdrawn');
    release.resolve();
    if(change==='expiry') {
      const value=await result;assert.equal(value.outcome,'refused');assert.equal(value.code,'PREVIEW_EXPIRED');
    } else await assert.rejects(result,code('SCOPE_DENIED'));
    await f.service.waitForIdle();assert.equal(f.state.effects,0);assert.equal(f.coordinator.snapshot().recoveryRequired,false);
  }
});
test('queued session revocation prevents effects without releasing any live writer prematurely',async t=>{
  const f=await fixture(t),entered=deferred(),release=deferred();
  f.owner.write=async(r,o)=>{entered.resolve();await release.promise;try{await o.guard();}catch(e){return refusal(r,e.code);}return f.state.confirm(r);};
  const preview=await f.service.copyPreview(f.session,p,{mode:'clone_v2'});
  const response=f.service.commit(f.session,p,{previewId:preview.id});await entered.promise;
  f.setAlive(false);release.resolve();
  await assert.rejects(response,code('SESSION_EXPIRED'));await f.service.waitForIdle();
  assert.equal(f.state.effects,0);assert.equal(f.coordinator.snapshot().activeLeases,0);assert.equal(f.coordinator.snapshot().recoveryRequired,false);
});
test('HTTP pending and session cleanup leave exclusive writer alive until close',async t=>{
  const f=await fixture(t,{pendingMs:20}),release=deferred(),entered=deferred();
  f.owner.write=async(r,o)=>{await o.guard();entered.resolve();await release.promise;return unknown(r);};
  const preview=await f.service.copyPreview(f.session,p,{mode:'clone_v2'});
  const response=f.service.commit(f.session,p,{previewId:preview.id});await entered.promise;
  const pending=await response;assert.equal(pending.outcome,'pending');assert.equal(f.service.isIdle(),false);
  f.setAlive(false);f.service.cleanup();assert.equal(f.coordinator.snapshot().activeLeases,1);
  release.resolve();await f.service.waitForIdle();
  assert.equal(f.coordinator.snapshot().activeLeases,0);assert.equal(f.coordinator.snapshot().recoveryRequired,true);
  f.service.cleanup();f.setAlive(true);
  assert.equal(f.service.lookup(f.session,pending.operationId),null);assert.equal(f.coordinator.snapshot().recoveryRequired,true);
});
test('copy handle survives prepare and abandon; offline abandon guard reads only library/history',async t=>{
  const f=await fixture(t),handles=await prepared(f);
  const receipt=[...f.state.receipts.values()][0];f.state.conditions.set(receipt.token.operationId,'unavailable');
  const preview=await f.service.decisionPreview(f.session,p,{activationHandle:handles.activation,decision:'abandon'});
  const before=f.state.reads.length;
  f.state.readFailure=r=>['inspect','activation-inspect','copy-inspect'].includes(r.action);
  const result=await f.service.commit(f.session,p,{previewId:preview.id});
  assert.equal(result.outcome,'confirmed');assert.equal(result.summary.state,'abandoned');noPrivate(result);
  assert.deepEqual(f.state.reads.slice(before).map(r=>r.request.action),['library-format-status','activation-history']);
  f.state.readFailure=null;
  const second=await f.service.activationPreview(f.session,p,{copyHandle:handles.copy});
  assert.equal(second.review.decision,'prepare');
  assert.equal((await f.service.commit(f.session,p,{previewId:second.id})).outcome,'confirmed');
});
test('terminal ACK must preserve reviewed native identity and independent NULL/empty root fields',async t=>{
  const f=await fixture(t),handles=await prepared(f);
  const preview=await f.service.decisionPreview(f.session,p,{activationHandle:handles.activation,decision:'abandon'});
  f.owner.write=async(r,o)=>{await o.guard();const result=f.state.confirm(r);result.reply.details.receipt.sourceFolder='';return result;};
  const result=await f.service.commit(f.session,p,{previewId:preview.id});
  assert.equal(result.outcome,'unknown');assert.equal(result.summary,null);assert.equal(result.recoveryHandle,null);
  assert.equal(f.coordinator.snapshot().recoveryRequired,true);
});
test('activation confirmation remains distinct from its later advisory recovery read',async t=>{
  const f=await fixture(t),handles=await prepared(f);
  const preview=await f.service.decisionPreview(f.session,p,{activationHandle:handles.activation,decision:'activate'});
  const result=await f.service.commit(f.session,p,{previewId:preview.id});
  assert.equal(result.outcome,'confirmed');assert.equal(result.summary.state,'activated');
  assert.equal(result.summary.receiptRevision,2);assert.equal(f.state.library.generation,2);noPrivate(result);
  f.state.readFailure=r=>r.action==='activation-inspect';
  await assert.rejects(f.service.recovery(f.session,p,result.recoveryHandle),code('OWNER_UNAVAILABLE'));
  assert.equal(f.service.lookup(f.session,result.operationId).state,'succeeded');
});
test('known success survives failed refresh; confirmed minimal fallback retains success and recovery barrier',async t=>{
  const f=await fixture(t,{onConfirmed:()=>{throw new Error('private refresh failure');}});
  let preview=await f.service.copyPreview(f.session,p,{mode:'clone_v2'});
  assert.equal((await f.service.commit(f.session,p,{previewId:preview.id})).outcome,'confirmed');
  assert.equal(f.coordinator.snapshot().recoveryRequired,false);
  f.owner.write=async(r,o)=>{await o.guard();const value=f.state.confirm(r);value.reply.details=null;
    value.reply.operationId=null;value.reply.detailsAvailable=false;return value;};
  preview=await f.service.copyPreview(f.session,p,{mode:'clone_v2'});
  const result=await f.service.commit(f.session,p,{previewId:preview.id});
  assert.equal(result.outcome,'confirmed');assert.equal(result.summary,null);assert.equal(result.recoveryHandle,null);
  assert.equal(f.service.lookup(f.session,result.operationId).state,'succeeded');assert.equal(f.coordinator.snapshot().recoveryRequired,true);
});
test('unknown is immutable history; only explicit equal native plus legacy reconciliation admits fresh reviews',async t=>{
  const f=await fixture(t);f.owner.write=async(r,o)=>{await o.guard();return unknown(r);};
  const preview=await f.service.copyPreview(f.session,p,{mode:'clone_v2'});
  const result=await f.service.commit(f.session,p,{previewId:preview.id});assert.equal(result.outcome,'unknown');
  await f.service.projectStatus(f.session,p);await f.service.copies(f.session,p,{limit:1,cursor:null});
  assert.equal(f.coordinator.snapshot().recoveryRequired,true);
  await assert.rejects(f.service.copyPreview(f.session,p,{mode:'clone_v2'}),code('RECOVERY_REQUIRED'));
  await assert.rejects(f.service.recoveryPreview(f.session,other,{activationHandle:null}),code('RECOVERY_REQUIRED'));
  await assert.rejects(f.service.recoveryPreview(f.session,null,{activationHandle:null}),code('RECOVERY_REQUIRED'));
  let recovery=await f.service.recoveryPreview(f.session,p,{activationHandle:null});noPrivate(recovery);
  f.setLegacy('changed');
  await assert.rejects(f.service.acknowledgeRecovery(f.session,p,{previewId:recovery.id}),code('CONFIG_CHANGED'));
  recovery=await f.service.recoveryPreview(f.session,p,{activationHandle:null});
  f.state.snapshot=sha('changed-copy-parent');
  await assert.rejects(f.service.acknowledgeRecovery(f.session,p,{previewId:recovery.id}),code('CONFIG_CHANGED'));
  recovery=await f.service.recoveryPreview(f.session,p,{activationHandle:null});
  assert.deepEqual(await f.service.acknowledgeRecovery(f.session,p,{previewId:recovery.id}),
    {reconciled:true,priorOutcome:'unknown',freshReviewRequired:true});
  assert.equal(f.coordinator.snapshot().recoveryRequired,false);
  assert.equal(f.service.lookup(f.session,result.operationId).state,'unknown');
  await assert.rejects(f.service.commit(f.session,p,{previewId:preview.id}),code('PREVIEW_EXPIRED'));
  assert.equal(f.state.effects,0);
});
test('unknown subject persists across service replacement without retaining old session or tokens',async t=>{
  const f=await fixture(t);f.owner.write=async(r,o)=>{await o.guard();return unknown(r);};
  const preview=await f.service.copyPreview(f.session,p,{mode:'clone_v2'});
  await f.service.commit(f.session,p,{previewId:preview.id});
  await f.coordinator.close();
  const next=await WriteCoordinator.create(join(f.root,'library.sqlite'),undefined,f.common.clock);
  t.after(()=>next.close());
  const replacement=new ProjectOperationsService({...f.common,coordinator:next});
  assert.equal(next.snapshot().recoveryRequired,true);
  await assert.rejects(replacement.recoveryPreview(f.otherSession,other,{activationHandle:null}),code('RECOVERY_REQUIRED'));
  const recovery=await replacement.recoveryPreview(f.otherSession,p,{activationHandle:null});
  await replacement.acknowledgeRecovery(f.otherSession,p,{previewId:recovery.id});
  assert.equal(next.snapshot().recoveryRequired,false);
});
test('expired recovery token and inconsistent native receipt cannot clear the barrier',async t=>{
  const f=await fixture(t),handles=await prepared(f),receipt=[...f.state.receipts.values()][0];
  const request={action:'activation-abandon',projectId:p,expected:clone(receipt.token)};
  const subject=await f.common.captureSubject(request,receipt);
  const held=f.coordinator.acquire('exclusive',p,f.coordinator.snapshot().epoch,subject);
  await held.beforeStart();held.release('unknown');await f.coordinator.waitForIdle();
  f.state.conditions.set(receipt.token.operationId,'inconsistent');
  await assert.rejects(f.service.recoveryPreview(f.session,p,{activationHandle:handles.activation}),code('RECOVERY_REQUIRED'));
  f.state.conditions.delete(receipt.token.operationId);
  const recovery=await f.service.recoveryPreview(f.session,p,{activationHandle:handles.activation});
  f.advance(120001);
  await assert.rejects(f.service.acknowledgeRecovery(f.session,p,{previewId:recovery.id}),code('PREVIEW_EXPIRED'));
  assert.equal(f.coordinator.snapshot().recoveryRequired,true);
});
test('retained receipt permits offline reconciliation without opening the current selected project',async t=>{
  const f=await fixture(t),handles=await prepared(f),receipt=[...f.state.receipts.values()][0];
  const request={action:'activation-abandon',projectId:p,expected:clone(receipt.token)};
  const subject=await f.common.captureSubject(request,receipt);
  const held=f.coordinator.acquire('exclusive',p,f.coordinator.snapshot().epoch,subject);
  await held.beforeStart();held.release('unknown');await f.coordinator.waitForIdle();
  f.state.conditions.set(receipt.token.operationId,'unavailable');f.state.readFailure=r=>r.action==='inspect';
  const withoutHint=await f.service.recoveryPreview(f.session,p,{activationHandle:null});
  assert.equal(withoutHint.scope,'project');
  assert.equal(f.state.reads.some(r=>r.request.action==='inspect'),false);
  const recovery=await f.service.recoveryPreview(f.session,p,{activationHandle:handles.activation});
  assert.equal(recovery.scope,'activation');assert.equal(recovery.priorOutcome,'unknown');
  await f.service.acknowledgeRecovery(f.session,p,{previewId:recovery.id});
  const preview=await f.service.decisionPreview(f.session,p,{activationHandle:handles.activation,decision:'abandon'});
  assert.equal(preview.review.decision,'abandon');
});
test('maintenance reconciliation is scope-limited and upgrades remain separate explicit previews',async t=>{
  const f=await fixture(t);f.state.library={...f.state.library,schema:1,uuid:null,generation:null};
  let preview=await f.service.libraryPreview(f.session,{fromSchema:1});noPrivate(preview);
  let result=await f.service.commit(f.session,null,{previewId:preview.id});assert.equal(result.outcome,'confirmed');
  preview=await f.service.libraryPreview(f.session,{fromSchema:2});
  result=await f.service.commit(f.session,null,{previewId:preview.id});assert.equal(result.outcome,'confirmed');
  assert.equal(f.state.library.schema,3);
  const request={action:'library-upgrade-v2',expected:{source:{...clone(f.state.library),schema:2},fullSnapshotDigest:sha('fullSnapshot')}};
  const subject=await f.common.captureSubject(request,null);
  const held=f.coordinator.acquire('exclusive',null,f.coordinator.snapshot().epoch,subject);
  await held.beforeStart();held.release('unknown');await f.coordinator.waitForIdle();
  await assert.rejects(f.service.recoveryPreview(f.session,null,{activationHandle:null}),code('RECOVERY_REQUIRED'));
  assert.equal(f.coordinator.snapshot().recoveryRequired,true);
  assert.equal(f.state.effects,2);
  // Current library status alone is insufficient. This fixture deliberately
  // refuses the full backup observation; real native success is tested separately.
});

test('recovery refuses replaced original library before any native owner read',async t=>{
  const f=await fixture(t);f.owner.write=async(r,o)=>{await o.guard();return unknown(r);};
  const preview=await f.service.copyPreview(f.session,p,{mode:'clone_v2'});
  await f.service.commit(f.session,p,{previewId:preview.id});
  const before=f.state.reads.length;
  await rename(join(f.root,'library.sqlite'),join(f.root,'library-original.sqlite'));
  await writeFile(join(f.root,'library.sqlite'),'fixture-owner-file');
  await assert.rejects(f.service.recoveryPreview(f.session,p,{activationHandle:null}),code('CONFIG_CHANGED'));
  assert.equal(f.state.reads.length,before);
  assert.equal(f.coordinator.snapshot().recoveryRequired,true);
});

test('lost copy ID reviews every candidate without attributing an equivalent copy',async t=>{
  const f=await fixture(t);f.owner.write=async(r,o)=>{await o.guard();f.state.confirm(r);return unknown(r);};
  const preview=await f.service.copyPreview(f.session,p,{mode:'clone_v2'});
  const historical=await f.service.commit(f.session,p,{previewId:preview.id});
  f.state.addCopy();const before=f.state.reads.length;
  const review=await f.service.recoveryPreview(f.session,p,{activationHandle:null});
  assert.equal(f.state.reads.slice(before).filter(r=>r.request.action==='copy-inspect').length,2);
  await f.service.acknowledgeRecovery(f.session,p,{previewId:review.id});
  const job=f.service.lookup(f.session,historical.operationId);
  assert.equal(job.state,'unknown');assert.equal(job.result.recoveryHandle,null);
});

test('unattributed copy artifacts preserve the barrier and do not trigger write retries',async t=>{
  const f=await fixture(t);f.owner.write=async(r,o)=>{await o.guard();return unknown(r);};
  const preview=await f.service.copyPreview(f.session,p,{mode:'clone_v2'});
  await f.service.commit(f.session,p,{previewId:preview.id});
  f.state.unattributedEntries=1;
  await assert.rejects(f.service.recoveryPreview(f.session,p,{activationHandle:null}),code('RECOVERY_REQUIRED'));
  assert.equal(f.state.effects,0);assert.equal(f.coordinator.snapshot().recoveryRequired,true);
});
