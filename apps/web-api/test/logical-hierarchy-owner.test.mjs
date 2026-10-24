import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  LogicalHierarchyOwner, checkedLogicalHierarchyProposal, checkedLogicalHierarchyReadRequest,
  checkedLogicalHierarchyWriteRequest, decodeLogicalHierarchyRead, decodeLogicalHierarchyWrite,
  nativeHierarchyCodeToApi,
} from '../dist/logical-hierarchy-owner.js';
import { ProcessPool } from '../dist/process.js';
import { strictJson, ApiError } from '../dist/security.js';

const base=process.platform==='win32'?'C:/hierarchy-fixture':'/hierarchy-fixture';
const libraryId='11111111-1111-4111-8111-111111111111',storeId='22222222-2222-4222-8222-222222222222';
const d='a'.repeat(64),d2='b'.repeat(64);
const authority={projectId:'project',allowInternal:true};
const config={adminBinary:base+'/admin.exe',library:base+'/library.sqlite',projects:[authority]};
const library={schema:3,canonicalPath:base+'/library.sqlite',uuid:libraryId,generation:2,digest:d};
const identity={schemaVersion:2,projectId:'project',canonicalPath:base+'/project.sqlite',storeUuid:storeId,
  revision:4,contentDigest:d,registryDigest:d2};
const clone=v=>structuredClone(v),bytes=v=>Buffer.from(JSON.stringify(v)+'\n');
const subsystem=(id,parentSubsystemId='',privacy='internal')=>({id,label:'Controlled '+id,parentSubsystemId,privacy});
const component=(id,privacy='internal')=>({id,label:'Controlled '+id,repositoryId:'repository',kind:'firmware',privacy});
const oldRoot=subsystem('root'),oldChild=subsystem('child','root'),oldLeaf=subsystem('leaf','root'),added=subsystem('new','root');
const comp=component('component');
const batch={projectId:'project',expectedRevision:4,changes:[
  {kind:'rename_subsystem',expected:oldRoot,desiredLabel:'Renamed root'},
  {kind:'set_component_membership',expectedComponent:comp,expected:{componentId:comp.id,subsystemId:'child'},desiredSubsystemId:null},
  {kind:'retire_empty_subsystem',expected:oldLeaf},
  {kind:'add_subsystem',desired:added},
  {kind:'reparent_subsystem',expected:oldChild,desiredParentId:'new'},
]};
const target=op=>op.kind==='set_component_membership'?'1:'+op.expectedComponent.id:
  '0:'+(op.kind==='add_subsystem'?op.desired.id:op.expected.id);
const normalize=value=>({...clone(value),changes:clone(value.changes).sort((a,b)=>target(a)<target(b)?-1:1)});
const proposal=normalize(batch);
const subFields=value=>value===null?null:[value.id,value.label,value.parentSubsystemId,value.privacy];
const memFields=value=>value===null?null:[value.componentId,value.subsystemId];
const componentFields=value=>[value.id,value.label,value.repositoryId,value.kind,value.privacy];
function proposalHash(value,scope){
  const operations=value.changes.map(op=>{
    switch(op.kind){
      case 'add_subsystem':return ['add',subFields(op.desired)];
      case 'rename_subsystem':return ['rename',subFields(op.expected),op.desiredLabel];
      case 'reparent_subsystem':return ['reparent',subFields(op.expected),op.desiredParentId];
      case 'retire_empty_subsystem':return ['retire',subFields(op.expected)];
      case 'set_component_membership':return ['membership',componentFields(op.expectedComponent),memFields(op.expected),op.desiredSubsystemId];
    }
  });
  return createHash('sha256').update(JSON.stringify(['lmti.logical-hierarchy.review.v1',scope.projectId,
    true,scope.allowInternal,value.projectId,String(value.expectedRevision),operations])).digest('hex');
}
const affected=(kind,id,beforeAncestors,afterAncestors,beforeClassification='internal',afterClassification='internal')=>
  ({kind,id,beforeClassification,afterClassification,beforeAncestors,afterAncestors});
const diff={
  subsystems:[
    {id:'child',before:oldChild,after:{...oldChild,parentSubsystemId:'new'}},
    {id:'leaf',before:oldLeaf,after:null},{id:'new',before:null,after:added},
    {id:'root',before:oldRoot,after:{...oldRoot,label:'Renamed root'}},
  ],
  memberships:[{componentId:'component',before:{componentId:'component',subsystemId:'child'},after:null}],
  affected:[
    affected('subsystem','child',['root'],['root','new']),
    affected('subsystem','grand',['root','child'],['root','new','child']),
    affected('subsystem','leaf',['root'],[],'internal',null),
    affected('subsystem','new',[],['root'],null,'internal'),
    affected('subsystem','root',[],[]),
    affected('component','component',['root','child'],[]),
    affected('component','observer',['root','child','grand'],['root','new','child','grand']),
  ],
};
function diffHash(value){
  const hash=createHash('sha256'),field=string=>{
    const b=Buffer.from(string);hash.update(String(b.length)+':');hash.update(b);
  };
  const row=value=>field(JSON.stringify(value));
  field('lmti.logical-hierarchy.diff.v1');
  row(['subsystems',String(value.subsystems.length)]);
  for(const v of value.subsystems)row([v.id,subFields(v.before),subFields(v.after)]);
  row(['memberships',String(value.memberships.length)]);
  for(const v of value.memberships)row([v.componentId,memFields(v.before),memFields(v.after)]);
  row(['affected',String(value.affected.length)]);
  for(const v of value.affected)row([v.kind,v.id,v.beforeClassification,v.afterClassification,v.beforeAncestors,v.afterAncestors]);
  return hash.digest('hex');
}
function review(value=proposal,changes=diff,g=authority){
  const scope={projectId:g.projectId,allowLogicalWrite:true,allowInternal:g.allowInternal};
  const token={...identity,schema:'lmti.logical-hierarchy.review.v1',scope,proposal:clone(value),
    proposalDigest:proposalHash(value,scope),diffDigest:diffHash(changes)};
  return {ok:true,schema:'lmti.logical-hierarchy.owner.v1',action:'logical-hierarchy-preview',
    expected:{libraryIdentity:clone(library),reviewToken:token},diff:clone(changes)};
}
const readRequest={action:'logical-hierarchy-preview',proposal:batch};
const writeRequest={action:'logical-hierarchy-commit',expected:review().expected};
function state(g=authority){
  const p=g.allowInternal?'internal':'public';
  return {ok:true,schema:'lmti.logical-hierarchy.owner.v1',action:'logical-hierarchy-state',
    libraryIdentity:clone(library),projectIdentity:clone(identity),
    projection:{projectId:g.projectId,revision:4,subsystems:[
      {value:subsystem('child','root',p),ancestors:['root'],classification:p},
      {value:subsystem('root','',p),ancestors:[],classification:p},
    ],components:[
      // Same ID across component/subsystem namespaces is valid.
      {value:component('root',p),membership:{componentId:'root',subsystemId:'child'},
        ancestors:['root','child'],classification:p},
    ]}};
}
const stateRequest={action:'logical-hierarchy-state'};
function ack(details=true,outcome='confirmed',code='NONE'){
  return {schema:'lmti.project.operation.write.v1',action:'logical-hierarchy-commit',outcome,code,operationId:null,
    details:details?{projectId:'project',storeUuid:storeId,previousRevision:4,revision:5,
      proposalDigest:writeRequest.expected.reviewToken.proposalDigest}:null,detailsAvailable:details};
}
const closed=value=>({kind:'closed',exitCode:0,transportOk:true,bytes:bytes(value)});
const reseal=value=>{value.expected.reviewToken.diffDigest=diffHash(value.diff);return value;};

test('five operation proposal normalizes by native target kind/ID and freezes owned copies',()=>{
  const result=checkedLogicalHierarchyProposal(batch);
  assert.deepEqual(result,proposal);assert.ok(Object.isFrozen(result.changes[0].expected));
  const before=result.changes[0].expected.label;const mutable=clone(batch);
  const pinned=checkedLogicalHierarchyProposal(mutable);mutable.changes[4].expected.label='Changed';
  assert.equal(pinned.changes[0].expected.label,before);
  for(const bad of [
    {...batch,scope:authority},{...batch,projectId:'../project'},{...batch,expectedRevision:true},
    {...batch,changes:[]},{...batch,changes:[batch.changes[0],batch.changes[0]]},
    {...batch,changes:[{...batch.changes[1],desiredSubsystemId:''}]},
    {...batch,changes:[{...batch.changes[3],desired:{...added,privacy:'public'}}]},
    {...batch,changes:[{...batch.changes[0],desiredLabel:'bad\u0000label'}]},
    {...batch,changes:[{...batch.changes[0],desiredLabel:'\ud800'}]},
    {...batch,changes:[{...batch.changes[0],path:base}]},
  ])assert.throws(()=>checkedLogicalHierarchyProposal(bad),{code:'INVALID_INPUT'});
});
test('input authority is selected only from explicit immutable grants',async()=>{
  let calls=0;const raw=clone(config),owner=new LogicalHierarchyOwner(raw,{run:async()=>{calls++;return state();}});
  raw.projects[0].allowInternal=false;raw.library=base+'/other.sqlite';raw.projects.push({projectId:'other',allowInternal:true});
  assert.equal(owner.config.library,config.library);assert.equal(owner.config.projects[0].allowInternal,true);
  assert.ok(Object.isFrozen(owner.config.projects[0]));assert.equal(owner.has('other'),false);
  await assert.rejects(owner.read('other',stateRequest),{code:'SCOPE_DENIED'});assert.equal(calls,0);
  assert.throws(()=>new LogicalHierarchyOwner({...config,projects:[authority,authority]},{}),{code:'INVALID_INPUT'});
  assert.throws(()=>new LogicalHierarchyOwner({...config,projects:[{projectId:'project'}]},{}),{code:'INVALID_INPUT'});
  assert.throws(()=>checkedLogicalHierarchyReadRequest({...stateRequest,path:base},authority),{code:'INVALID_INPUT'});
  assert.throws(()=>checkedLogicalHierarchyReadRequest({...readRequest,proposal:{...batch,projectId:'other'}},authority),{code:'SCOPE_DENIED'});
});
test('native conservative proposal byte budget remains bounded before transport',()=>{
  const long='L'.repeat(63);
  const changes=Array.from({length:32},(_,i)=>{
    const id='c'+String(i).padStart(2,'0')+long.slice(3);
    return {kind:'set_component_membership',expectedComponent:{...component(id),label:'"'.repeat(120),repositoryId:long},
      expected:{componentId:id,subsystemId:long},desiredSubsystemId:long};
  });
  assert.throws(()=>checkedLogicalHierarchyProposal({...batch,changes}),{code:'LIMIT_EXCEEDED'});
});
test('complete native-shaped preview correlates all five changes and exact typed digest framing',()=>{
  const result=decodeLogicalHierarchyRead(bytes(review()),readRequest,authority);
  assert.deepEqual(result,review());assert.ok(Object.isFrozen(result.diff.affected[0].beforeAncestors));
  assert.ok(Buffer.byteLength(JSON.stringify({action:'logical-hierarchy-commit',expected:result.expected}))<64*1024);
  const missing=review();missing.diff.affected.splice(1,1);
  assert.throws(()=>decodeLogicalHierarchyRead(bytes(missing),readRequest,authority),{code:'OWNER_UNAVAILABLE'});
});
test('review token cannot change proposal, scope, identity, normalized order or digest syntax',()=>{
  for(const mutate of [
    v=>v.expected.reviewToken.proposal.expectedRevision++,
    v=>v.expected.reviewToken.proposal.changes.reverse(),
    v=>v.expected.reviewToken.proposalDigest=d,
    v=>v.expected.reviewToken.diffDigest='A'.repeat(64),
    v=>v.expected.reviewToken.scope.allowInternal=false,
    v=>v.expected.reviewToken.scope.allowLogicalWrite=1,
    v=>v.expected.reviewToken.projectId='other',
    v=>v.expected.reviewToken.storeUuid=storeId.toUpperCase().replace('2222','ABCD'),
    v=>v.expected.reviewToken.schemaVersion=1,
    v=>v.expected.reviewToken.revision=Number.MAX_SAFE_INTEGER-1,
    v=>v.expected.reviewToken.extra=true,
  ]){
    const value=review();mutate(value);
    assert.throws(()=>decodeLogicalHierarchyRead(bytes(value),readRequest,authority),{code:'OWNER_UNAVAILABLE'});
  }
});
test('self-consistent digest cannot conceal wrong direct changes, unrelated rows, invalid ancestry or privacy loss',()=>{
  for(const mutate of [
    v=>v.diff.subsystems[0].after.parentSubsystemId='root',
    v=>v.diff.subsystems.splice(3,1),
    v=>v.diff.memberships[0].after={componentId:'component',subsystemId:'new'},
    v=>v.diff.affected[0].afterAncestors=['new'],
    v=>v.diff.affected[1].afterAncestors=['root','new','grand'],
    v=>v.diff.affected[1].afterClassification='public',
    v=>v.diff.affected[6].id='component',
    v=>v.diff.affected[6].beforeAncestors=[],
    v=>v.diff.affected[2].afterAncestors=['root'],
    v=>v.diff.affected.push(affected('component','z-unrelated',[],[])),
  ]){
    const value=review();mutate(value);reseal(value);
    assert.throws(()=>decodeLogicalHierarchyRead(bytes(value),readRequest,authority),{code:'OWNER_UNAVAILABLE'});
  }
});
test('mixed batch permits native no-op targets while requiring a nonempty exact diff',()=>{
  const p=normalize({...batch,changes:[batch.changes[3],{...batch.changes[0],desiredLabel:oldRoot.label}]});
  const changes={subsystems:[{id:'new',before:null,after:added}],memberships:[],affected:[
    affected('subsystem','child',['root'],['root']),affected('subsystem','new',[],['root'],null,'internal'),
    affected('subsystem','root',[],[]),
  ]};
  assert.equal(decodeLogicalHierarchyRead(bytes(review(p,changes)),{action:'logical-hierarchy-preview',proposal:p},authority).diff.subsystems.length,1);
});
test('state validates stable full ancestry, classification and independent ID namespaces',()=>{
  assert.deepEqual(decodeLogicalHierarchyRead(bytes(state()),stateRequest,authority),state());
  const final=state();final.projectIdentity.revision=Number.MAX_SAFE_INTEGER-1;final.projection.revision=final.projectIdentity.revision;
  assert.equal(decodeLogicalHierarchyRead(bytes(final),stateRequest,authority).projection.revision,Number.MAX_SAFE_INTEGER-1);
  for(const mutate of [
    v=>v.projection.subsystems.splice(1,1),
    v=>v.projection.subsystems.reverse(),
    v=>v.projection.subsystems[0].ancestors=[],
    v=>v.projection.subsystems[1].ancestors=['child'],
    v=>v.projection.components[0].membership=null,
    v=>v.projection.components[0].ancestors=['root','root'],
    v=>v.projection.components[0].membership.componentId='other',
    v=>v.projection.components[0].classification='public',
    v=>v.projection.projectId='other',
    v=>v.projection.revision++,
    v=>v.projection.hiddenCount=4,
  ]){
    const value=state();mutate(value);
    assert.throws(()=>decodeLogicalHierarchyRead(bytes(value),stateRequest,authority),{code:'OWNER_UNAVAILABLE'});
  }
});
test('public grant rejects leaked internal rows and internal effective repository classification is preserved',()=>{
  const g={...authority,allowInternal:false},value=state(g);
  assert.deepEqual(decodeLogicalHierarchyRead(bytes(value),stateRequest,g),value);
  value.projection.components[0].classification='internal';
  assert.throws(()=>decodeLogicalHierarchyRead(bytes(value),stateRequest,g),{code:'OWNER_UNAVAILABLE'});
  // Native is authoritative for a repository absent from this logical-only DTO.
  assert.equal(decodeLogicalHierarchyRead(bytes(value),stateRequest,authority).projection.components[0].classification,'internal');
});
test('native depth32 counts the component leaf: 31 ancestors pass, 32 fail in state and digest-consistent diff',()=>{
  for(const depth of [31,32]){
    const ids=Array.from({length:depth},(_,i)=>'node'+String(i).padStart(2,'0'));
    const value=state();
    value.projection.subsystems=ids.map((id,i)=>({value:subsystem(id,i===0?'':ids[i-1]),
      ancestors:ids.slice(0,i),classification:'internal'}));
    value.projection.components=[{value:component('component'),membership:{componentId:'component',subsystemId:ids.at(-1)},
      ancestors:ids,classification:'internal'}];
    const root=value.projection.subsystems[0].value;
    const p={projectId:'project',expectedRevision:4,changes:[{kind:'rename_subsystem',expected:root,desiredLabel:'Renamed'}]};
    const changes={subsystems:[{id:root.id,before:root,after:{...root,label:'Renamed'}}],memberships:[],
      affected:[...ids.map((id,i)=>affected('subsystem',id,ids.slice(0,i),ids.slice(0,i))),
        affected('component','component',ids,ids)]};
    if(depth===31){
      assert.equal(decodeLogicalHierarchyRead(bytes(value),stateRequest,authority).projection.components[0].ancestors.length,31);
      assert.equal(decodeLogicalHierarchyRead(bytes(review(p,changes)),{action:'logical-hierarchy-preview',proposal:p},authority).diff.affected.at(-1).afterAncestors.length,31);
    }else{
      assert.throws(()=>decodeLogicalHierarchyRead(bytes(value),stateRequest,authority),{code:'OWNER_UNAVAILABLE'});
      assert.throws(()=>decodeLogicalHierarchyRead(bytes(review(p,changes)),{action:'logical-hierarchy-preview',proposal:p},authority),{code:'OWNER_UNAVAILABLE'});
    }
  }
});
test('private native path keys preserve Unicode bytes and never use JavaScript recasing',()=>{
  const value=state();value.libraryIdentity.canonicalPath=base+'/STRASSE/library.sqlite';
  value.projectIdentity.canonicalPath=base+'/'+('é'.repeat(120)+'/').repeat(5)+'project.sqlite';
  assert.ok(Buffer.byteLength(value.projectIdentity.canonicalPath)>1024&&value.projectIdentity.canonicalPath.length<=1024);
  assert.equal(decodeLogicalHierarchyRead(bytes(value),stateRequest,authority).projectIdentity.canonicalPath,value.projectIdentity.canonicalPath);
  for(const p of ['relative','//host/share/project.sqlite',base+'/../project.sqlite',base+'/project.sqlite:ads',base+'/NUL',base+'/trailing.',base+'/bad\\path']){
    value.projectIdentity.canonicalPath=p;
    assert.throws(()=>decodeLogicalHierarchyRead(bytes(value),stateRequest,authority),{code:'OWNER_UNAVAILABLE'});
  }
  value.projectIdentity.canonicalPath=identity.canonicalPath;value.libraryIdentity.schema=1;value.libraryIdentity.uuid=null;value.libraryIdentity.generation=null;
  assert.equal(decodeLogicalHierarchyRead(bytes(value),stateRequest,authority).libraryIdentity.uuid,null);
  value.libraryIdentity.generation=0;
  assert.throws(()=>decodeLogicalHierarchyRead(bytes(value),stateRequest,authority),{code:'OWNER_UNAVAILABLE'});
});
test('read refusals have bounded codes; raw owner text and malformed frames never escape',()=>{
  for(const [native,api] of [['SCOPE_DENIED','SCOPE_DENIED'],['UNSUPPORTED_SCHEMA','NOT_SUPPORTED'],['BUDGET_EXCEEDED','LIMIT_EXCEEDED']]){
    assert.equal(nativeHierarchyCodeToApi(native),api);
    assert.throws(()=>decodeLogicalHierarchyRead(bytes({ok:false,code:native}),stateRequest,authority),{code:api});
  }
  const valid=bytes(state());
  for(const raw of [
    Buffer.from(JSON.stringify(state())),Buffer.from('{"ok":false,"ok":false,"code":"SCOPE_DENIED"}\n'),
    bytes({ok:false,code:'NONE'}),bytes({ok:false,code:'RAW_TEXT',message:base}),
    Buffer.from([0xff,10]),Buffer.concat([valid,Buffer.from('\x1agarbage\n')]),
    Buffer.concat([valid,Buffer.from('\0\n')]),Buffer.alloc(512*1024+1,10),
  ])assert.throws(()=>decodeLogicalHierarchyRead(raw,stateRequest,authority),e=>e.code==='OWNER_UNAVAILABLE'&&!e.message.includes(base));
});
test('native ACK preserves confirmed details, confirmed fallback, refused and unknown with no native operation ID',()=>{
  for(const value of [ack(),ack(false),ack(false,'refused','CONFIG_CHANGED'),ack(false,'unknown','RECOVERY_REQUIRED')]){
    assert.deepEqual(decodeLogicalHierarchyWrite(bytes(value),writeRequest,authority),value);
  }
  const malformedRequestAck={...ack(false,'refused','INVALID_INPUT'),action:null};
  assert.deepEqual(decodeLogicalHierarchyWrite(bytes(malformedRequestAck),writeRequest,authority),malformedRequestAck);
  for(const mutate of [
    v=>v.details.revision++,v=>v.details.previousRevision++,v=>v.details.projectId='other',
    v=>v.details.storeUuid=libraryId,v=>v.details.proposalDigest=d,v=>v.operationId=libraryId,
    v=>v.action='copy-prepare',v=>v.code='OWNER_UNAVAILABLE',v=>v.detailsAvailable=false,
    v=>v.details.extra=true,v=>v.outcome='unknown',
  ]){
    const value=ack();mutate(value);
    assert.throws(()=>decodeLogicalHierarchyWrite(bytes(value),writeRequest,authority),{code:'OWNER_UNAVAILABLE'});
  }
  assert.throws(()=>decodeLogicalHierarchyWrite(bytes({...ack(false,'unknown','OWNER_UNAVAILABLE'),action:null}),writeRequest,authority),{code:'OWNER_UNAVAILABLE'});
});
test('adapter uses only fixed grant argv, freezes request before queueing and opts into strict read framing',async()=>{
  const calls=[],main={run:async(...args)=>{calls.push(args);return state();},
    runWrite:async(...args)=>{calls.push(args);await args[3].guard?.();args[3].onStarted?.();return closed(ack());}};
  const verifier={run:async(...args)=>{calls.push(args);return state();}};
  const owner=new LogicalHierarchyOwner(config,main,verifier);
  await owner.read('project',stateRequest,{verify:true});
  assert.deepEqual(calls[0][1],['--logical-hierarchy-read','--library',config.library,'--project','project','--visibility','internal']);
  assert.equal(calls[0][3].newlineTerminated,true);assert.equal(calls[0][3].jsonArrayLimit,4000);assert.equal(calls[0][3].cap,512*1024);
  const request=clone(writeRequest);let guarded=0,started=0;
  const result=await owner.write('project',request,{guard:()=>{guarded++;request.expected.reviewToken.proposal.changes.length=0;},onStarted:()=>started++});
  assert.equal(result.reply.outcome,'confirmed');assert.equal(guarded,1);assert.equal(started,1);
  assert.equal(JSON.parse(calls[1][2]).expected.reviewToken.proposal.changes.length,5);
  assert.deepEqual(calls[1][1],['--logical-hierarchy-write','--library',config.library,'--project','project','--visibility','internal']);
});
test('no-start remains refused while malformed or missing started ACK remains unknown and never retries',async()=>{
  for(const [transport,start,expectedOutcome,expectedStarted,preflight] of [
    [{kind:'not_started',code:'BUSY'},false,'refused',false,'BUSY'],
    [{kind:'not_started',code:'CONFIG_CHANGED'},false,'refused',false,'CONFIG_CHANGED'],
    [{kind:'not_started',code:'OWNER_UNAVAILABLE'},true,'unknown',true,null],
    [{...closed(ack()),bytes:Buffer.from('{"incomplete":')},true,'unknown',true,null],
    [{...closed(ack()),exitCode:1},true,'unknown',true,null],
    [{...closed(ack()),transportOk:false},true,'unknown',true,null],
    [{...closed(ack()),bytes:null},true,'unknown',true,null],
  ]){
    let calls=0;const owner=new LogicalHierarchyOwner(config,{runWrite:async(_b,_a,_i,o)=>{calls++;if(start)o.onStarted();return transport;}});
    const result=await owner.write('project',writeRequest);
    assert.equal(calls,1);assert.equal(result.started,expectedStarted);assert.equal(result.reply.outcome,expectedOutcome);assert.equal(result.preflightCode,preflight);
  }
  const owner=new LogicalHierarchyOwner(config,{runWrite:async()=>{throw new Error('transport uncertainty');}});
  assert.equal((await owner.write('project',writeRequest)).reply.outcome,'unknown');
});
test('known success remains immutable after a later independent read fails',async()=>{
  const owner=new LogicalHierarchyOwner(config,{runWrite:async()=>closed(ack(false)),run:async()=>({ok:false,code:'OWNER_UNAVAILABLE'})});
  const result=await owner.write('project',writeRequest);
  await assert.rejects(owner.read('project',stateRequest),{code:'OWNER_UNAVAILABLE'});
  assert.equal(result.reply.outcome,'confirmed');assert.equal(result.reply.operationId,null);assert.equal(result.reply.details,null);
  assert.ok(Object.isFrozen(result.reply));
});
test('shared strict parser retains default2000 and explicit bounded4000 array policy',()=>{
  const data=bytes(Array.from({length:2001},()=>0));
  assert.throws(()=>strictJson(data),{code:'INVALID_INPUT'});
  assert.equal(strictJson(data,false,4000).length,2001);
  assert.throws(()=>strictJson(bytes(Array.from({length:4001},()=>0)),false,4000),{code:'INVALID_INPUT'});
  for(const cap of [0,2001,4001,Infinity,'4000'])assert.throws(()=>strictJson(Buffer.from('[]'),false,cap),{code:'INVALID_INPUT'});
  assert.throws(()=>strictJson(Buffer.from('{"same":1,"same":2}'),false,4000),{code:'INVALID_INPUT'});
  assert.throws(()=>strictJson(Buffer.from([0xff]),false,4000),{code:'INVALID_INPUT'});
  assert.throws(()=>strictJson(Buffer.from('{"__proto__":1}'),true,4000),{code:'INVALID_INPUT'});
});
test('real ProcessPool read opt-in preserves framing and UTF8 while accepting a bounded large array',{timeout:30000},async()=>{
  const pool=new ProcessPool(1),script='process.stdout.write(JSON.stringify({items:Array.from({length:2001},()=>0)})+"\\n")';
  await assert.rejects(pool.run(process.execPath,['-e',script],'',{cap:512*1024,newlineTerminated:true}),{code:'OWNER_UNAVAILABLE'});
  const value=await pool.run(process.execPath,['-e',script],'',{cap:512*1024,newlineTerminated:true,jsonArrayLimit:4000});
  assert.equal(value.items.length,2001);
  await assert.rejects(pool.run(process.execPath,['-e','process.stdout.write(Buffer.from([255,10]))'],'',
    {cap:512*1024,newlineTerminated:true,jsonArrayLimit:4000}),{code:'OWNER_UNAVAILABLE'});
  await assert.rejects(pool.run(process.execPath,['-e',script.replace('2001','4001')],'',
    {cap:512*1024,newlineTerminated:true,jsonArrayLimit:4000}),{code:'OWNER_UNAVAILABLE'});
  await pool.waitForIdle();assert.equal(pool.isIdle(),true);
});
test('affected2001 accepted within native frame cap; per-kind state and overall affected caps remain strict',()=>{
  const p={projectId:'project',expectedRevision:4,changes:[{kind:'rename_subsystem',expected:oldRoot,desiredLabel:'Renamed'}]};
  const changes={subsystems:[{id:'root',before:oldRoot,after:{...oldRoot,label:'Renamed'}}],memberships:[],
    affected:[affected('subsystem','root',[],[]),...Array.from({length:2000},(_,i)=>affected('component','c'+String(i).padStart(4,'0'),['root'],['root']))]};
  const value=review(p,changes);assert.ok(bytes(value).length<512*1024);
  assert.equal(decodeLogicalHierarchyRead(bytes(value),{action:'logical-hierarchy-preview',proposal:p},authority).diff.affected.length,2001);
  const tooMany=state();tooMany.projection.components=Array.from({length:2001},(_,i)=>({
    value:component('c'+String(i).padStart(4,'0')),membership:null,ancestors:[],classification:'internal',
  }));
  assert.throws(()=>decodeLogicalHierarchyRead(bytes(tooMany),stateRequest,authority),{code:'OWNER_UNAVAILABLE'});
});

const realAvailable=Boolean(process.env.LMTI_WEB_TEST_HIERARCHY_ADMIN&&process.env.LMTI_WEB_TEST_BINDING_PRODUCER);
test('real current native hierarchy roundtrip pins Unicode proposal and full diff through a guarded sole-slot write',
  {skip:!realAvailable,timeout:60000},async t=>{
    const root=await mkdtemp(join(tmpdir(),'lmti-hierarchy-adapter-')),main=new ProcessPool(1);
    t.after(async()=>{
      await main.waitForIdle();assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));
      await rm(root,{recursive:true,force:true});
    });
    const producer=spawnSync(process.env.LMTI_WEB_TEST_BINDING_PRODUCER,['--fixture',root,'3','2'],
      {encoding:'utf8',timeout:15000,windowsHide:true,maxBuffer:8192});
    assert.equal(producer.status,0,'Controlled native fixture producer failed');
    const owner=new LogicalHierarchyOwner({adminBinary:process.env.LMTI_WEB_TEST_HIERARCHY_ADMIN,
      library:join(root,'library.sqlite'),projects:[{projectId:'factory-monitor',allowInternal:true}]},main);
    const beforeLibrary=await readFile(join(root,'library.sqlite'));
    const before=await owner.read('factory-monitor',stateRequest),revision=before.projectIdentity.revision;
    const p={projectId:'factory-monitor',expectedRevision:revision,changes:[{kind:'add_subsystem',
      desired:subsystem('codec-subsystem','')}]};
    p.changes[0].desired.label='Điều khiển "demo" \\ α 😀';
    const preview=await owner.read('factory-monitor',{action:'logical-hierarchy-preview',proposal:p});
    let started=0,guarded=0;
    const result=await owner.write('factory-monitor',{action:'logical-hierarchy-commit',expected:preview.expected},{
      guard:async()=>{
        guarded++;assert.equal(main.isIdle(),false);let timer;
        try{
          const current=await Promise.race([
            owner.read('factory-monitor',{action:'logical-hierarchy-preview',proposal:p},{verify:true}),
            new Promise((_,reject)=>{timer=setTimeout(()=>reject(new ApiError('OWNER_UNAVAILABLE')),10000);}),
          ]);
          assert.deepEqual(current.expected,preview.expected);assert.deepEqual(current.diff,preview.diff);
        }finally{clearTimeout(timer);}
      },onStarted:()=>started++,
    });
    assert.equal(result.reply.outcome,'confirmed');assert.equal(result.reply.operationId,null);
    assert.equal(started,1);assert.equal(guarded,1);
    const after=await owner.read('factory-monitor',stateRequest);
    assert.equal(after.projectIdentity.revision,revision+1);
    assert.equal(after.projectIdentity.storeUuid,before.projectIdentity.storeUuid);
    assert.equal(after.projection.subsystems.find(v=>v.value.id==='codec-subsystem').value.label,p.changes[0].desired.label);
    assert.deepEqual(await readFile(join(root,'library.sqlite')),beforeLibrary);
    const duplicate=await owner.write('factory-monitor',{action:'logical-hierarchy-commit',expected:preview.expected});
    assert.equal(duplicate.reply.outcome,'refused');assert.equal(duplicate.reply.code,'CONFIG_CHANGED');
  });
