import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PhysicalHierarchyOwner,checkedPhysicalHierarchyProposal,checkedPhysicalHierarchyReadRequest,
  checkedPhysicalHierarchyWriteRequest,checkedPhysicalHierarchyOriginalExpected,
  decodePhysicalHierarchyRead,decodePhysicalHierarchyWrite,nativePhysicalHierarchyCodeToApi,
} from '../dist/physical-hierarchy-owner.js';
import {ProcessPool} from '../dist/process.js';
import {ApiError,strictJson} from '../dist/security.js';
import {authority,config,library,identity,clone,bytes,site,area,asset,placement,path,affected,
  batch,proposal,diff,review,readRequest,writeRequest,stateRequest,state,ack,reseal,closed,base,normalize} from './fixtures/physical-hierarchy.mjs';

const decode=(v,r=readRequest,g=authority)=>decodePhysicalHierarchyRead(bytes(v),r,g);
const invalidResponse=v=>assert.throws(()=>decode(v),{code:'OWNER_UNAVAILABLE'});
const rehashedBad=mutate=>{const v=review();mutate(v);invalidResponse(reseal(v));};

test('eleven variants normalize native kind/ID order, own frozen values and correlate independent digests',()=>{
  assert.deepEqual(checkedPhysicalHierarchyProposal(batch),proposal);
  const mixed={projectId:'project',expectedRevision:4,changes:['a_','a.','A','a-'].map(id=>
    ({kind:'add_site',desired:site(id)}))};
  assert.deepEqual(checkedPhysicalHierarchyProposal(mixed).changes.map(op=>op.desired.id),['A','a-','a.','a_']);
  assert.deepEqual(normalize(mixed).changes.map(op=>op.desired.id),['A','a-','a.','a_']);
  assert.deepEqual(decode(review()).diff,diff);
  const mutable=clone(batch),pinned=checkedPhysicalHierarchyProposal(mutable);
  mutable.changes[0].desired.label='Changed outside';
  assert.equal(pinned.changes[0].desired.label,proposal.changes[0].desired.label);
  assert.ok(Object.isFrozen(pinned.changes[0].desired));
  const changed=clone(review());changed.expected.reviewToken.schema='lmti.logical-hierarchy.review.v1';invalidResponse(changed);
  changed.expected.reviewToken.schema='lmti.physical-hierarchy.review.v1';
  changed.expected.reviewToken.scope.allowLogicalWrite=true;invalidResponse(changed);
});
test('proposal rejects coercion, authority fields, bad Unicode, duplicate targets and unsupported role without dispatch',()=>{
  const bad=[
    {...batch,scope:authority},{...batch,expectedRevision:'4'},{...batch,changes:[]},
    {...batch,changes:Array(33).fill(batch.changes[0])},{...batch,changes:[batch.changes[0],batch.changes[0]]},
    {...batch,changes:[{...batch.changes[0],desired:{...batch.changes[0].desired,privacy:'public'}}]},
    {...batch,changes:[{...batch.changes[1],desiredLabel:'bad\u0000label'}]},
    {...batch,changes:[{...batch.changes[1],desiredLabel:'bad\ud800label'}]},
    {...batch,changes:[{...batch.changes[5],desiredParentId:batch.changes[5].expected.id}]},
    {...batch,changes:[{...batch.changes[10],desired:{...placement('free'),role:'unknown'}}]},
    {...batch,changes:[{...batch.changes[10],desired:placement('other')}]},
    {...batch,changes:[{...batch.changes[10],desired:placement('free','','free')}]},
  ];
  for(const p of bad)assert.throws(()=>checkedPhysicalHierarchyProposal(p),e=>e instanceof ApiError);
  assert.throws(()=>checkedPhysicalHierarchyReadRequest({...stateRequest,expected:{}},authority));
  assert.throws(()=>checkedPhysicalHierarchyReadRequest(readRequest,{projectId:'other',allowInternal:true}),{code:'SCOPE_DENIED'});
});
test('each changed catalog/placement and affected path must correlate with the exact proposal',()=>{
  for(const mutate of [
    v=>v.diff.sites.shift(),v=>v.diff.areas[0].after.siteId='different-site',
    v=>v.diff.environments[1].after.label='Unreviewed',v=>v.diff.placements[0].after=null,
    v=>v.diff.affected.splice(v.diff.affected.findIndex(r=>r.id==='free'),1),
    v=>v.diff.affected.find(r=>r.id==='observer').afterPath.areaAncestors=['move-area'],
    v=>v.diff.affected.push(affected('asset','unrelated',path('unrelated'),path('unrelated'))),
    v=>v.diff.affected.find(r=>r.id==='new-env').beforeClassification='internal',
    v=>v.diff.affected.find(r=>r.id==='observer').afterClassification='public',
    v=>v.diff.affected.reverse(),
  ])rehashedBad(mutate);
  const bad=review();bad.expected.reviewToken.diffDigest='0'.repeat(64);invalidResponse(bad);
  const changed=clone(readRequest);changed.proposal.changes[1].desiredLabel='Other review';
  assert.throws(()=>decode(review(),changed),{code:'OWNER_UNAVAILABLE'});
});
test('null placement, declared empty placement and null role are distinct; no native operation ID invented',()=>{
  const result=decode(review());
  assert.equal(result.diff.placements[0].before,null);
  assert.deepEqual(result.diff.placements[0].after,placement('free'));
  assert.equal(result.diff.placements[0].after.role,null);
  const confirmed=decodePhysicalHierarchyWrite(bytes(ack()),writeRequest,authority);
  assert.equal(confirmed.operationId,null);assert.equal(confirmed.details.revision,5);
  assert.equal(decodePhysicalHierarchyWrite(bytes(ack(false)),writeRequest,authority).outcome,'confirmed');
});
test('complete state permits independent same-ID namespaces and unused environment with no inferred role',()=>{
  const result=decode(state(),stateRequest);
  assert.equal(result.projection.assets[0].placement,null);
  assert.equal(result.projection.assets[1].placement.role,null);
  assert.deepEqual(result.projection.assets[1].path,path('old-site',['shared'],[],'shared'));
  const v=state();v.projection.environments.push({value:site('unused','public'),classification:'public'});
  assert.equal(decode(v,stateRequest).projection.environments.length,2);
  assert.deepEqual(decode(state(),stateRequest,{...authority,allowInternal:false}).projection,state().projection);
});
test('complete projection rejects hidden/missing ancestors, cross-site and environment mismatches, and privacy weakening',()=>{
  const fail=mutate=>{const v=state();mutate(v);assert.throws(()=>decode(v,stateRequest),{code:'OWNER_UNAVAILABLE'});};
  for(const mutate of [
    v=>v.projection.sites=[],v=>v.projection.areas=[],v=>v.projection.environments=[],
    v=>v.projection.areas[0].value.siteId='other',
    v=>v.projection.assets[1].placement.assetId='other',
    v=>v.projection.assets[1].path.environmentId='',
    v=>v.projection.assets[1].value.privacy='internal',
    v=>v.projection.areas[0].classification='internal',
    v=>v.projection.assets.reverse(),
    v=>v.projection.assets[1].path.assetAncestors=['free'],
    v=>v.projection.assets[1].path.areaAncestors=['shared','shared'],
    v=>v.projection.assets[1].path.extra='private',
  ])fail(mutate);
  const inherited=state();inherited.projection.areas[0].value.privacy='internal';
  inherited.projection.areas[0].classification='internal';inherited.projection.assets[1].classification='internal';
  assert.equal(decode(inherited,stateRequest).projection.assets[1].classification,'internal');
  assert.throws(()=>decode(inherited,stateRequest,{...authority,allowInternal:false}),{code:'OWNER_UNAVAILABLE'});
});
function chainState(length){
  const v=state();v.projection.environments=[];v.projection.assets=[];v.projection.areas=[];
  const ids=Array.from({length},(_,i)=>'area'+String(i).padStart(2,'0'));
  ids.forEach((id,i)=>v.projection.areas.push({value:area(id,'old-site',ids[i-1]??'','public'),
    ancestors:ids.slice(0,i),classification:'public'}));
  v.projection.assets=[{value:asset('leaf','public'),placement:placement('leaf',ids.at(-1)??''),
    path:path('old-site',ids),classification:'public'}];return v;
}
test('combined area plus asset depth31 ancestors accepted, depth32 ancestors refused in state and rehashed diff',()=>{
  assert.equal(decode(chainState(31),stateRequest).projection.assets[0].path.areaAncestors.length,31);
  assert.throws(()=>decode(chainState(32),stateRequest),{code:'OWNER_UNAVAILABLE'});
  for(const count of [31,32]){
    const ids=Array.from({length:count},(_,i)=>'area'+String(i).padStart(2,'0'));
    const p={projectId:'project',expectedRevision:4,changes:[{kind:'rename_site',expected:site('old-site'),desiredLabel:'Renamed'}]};
    const d={sites:[{id:'old-site',before:site('old-site'),after:{...site('old-site'),label:'Renamed'}}],
      areas:[],environments:[],placements:[],affected:[
        affected('site','old-site',path('old-site'),path('old-site')),
        ...ids.map((id,i)=>affected('area',id,path('old-site',ids.slice(0,i)),path('old-site',ids.slice(0,i)))),
        affected('asset','leaf',path('old-site',ids),path('old-site',ids))]};
    const run=()=>decode(review(p,d),{action:'physical-hierarchy-preview',proposal:p});
    if(count===31)assert.equal(run().diff.affected.length,33);else assert.throws(run,{code:'OWNER_UNAVAILABLE'});
  }
});
test('immutable private path/UUID/revision pins obey native UTF16 path and revision boundaries',()=>{
  const v=state();v.projectIdentity.canonicalPath=base+'/'+'đ'.repeat(600)+'.sqlite';
  assert.ok(Buffer.byteLength(v.projectIdentity.canonicalPath)>1024);
  assert.equal(decode(v,stateRequest).projectIdentity.canonicalPath,v.projectIdentity.canonicalPath);
  for(const val of [base+'/../other','//host/share','relative','C:/CON',base+'/'+'x'.repeat(1024)]){
    const x=state();x.projectIdentity.canonicalPath=val;assert.throws(()=>decode(x,stateRequest),{code:'OWNER_UNAVAILABLE'});
  }
  const max=Number.MAX_SAFE_INTEGER;
  v.projectIdentity.canonicalPath=identity.canonicalPath;v.projectIdentity.revision=max-1;v.projection.revision=max-1;
  assert.equal(decode(v,stateRequest).projectIdentity.revision,max-1);
  v.projectIdentity.revision=max;v.projection.revision=max;assert.throws(()=>decode(v,stateRequest),{code:'OWNER_UNAVAILABLE'});
  const r=review();r.expected.reviewToken.revision=max-1;assert.throws(()=>checkedPhysicalHierarchyWriteRequest(
    {action:'physical-hierarchy-commit',expected:r.expected},authority),{code:'INVALID_INPUT'});
});
test('exact ACK action, null operation ID and every committed pin are checked; no success from malformed details',()=>{
  for(const mutate of [
    a=>a.action='logical-hierarchy-commit',a=>a.operationId='invented',a=>a.extra=true,a=>a.detailsAvailable='true',
    a=>a.code='CONFIG_CHANGED',a=>a.details.projectId='other',a=>a.details.storeUuid=library.uuid,
    a=>a.details.previousRevision=3,a=>a.details.revision=6,a=>a.details.proposalDigest='0'.repeat(64),
    a=>a.outcome='unknown',
  ]){const a=ack();mutate(a);assert.throws(()=>decodePhysicalHierarchyWrite(bytes(a),writeRequest,authority),{code:'OWNER_UNAVAILABLE'});}
  assert.equal(nativePhysicalHierarchyCodeToApi('BUDGET_EXCEEDED'),'LIMIT_EXCEEDED');
  assert.equal(nativePhysicalHierarchyCodeToApi('UNSUPPORTED_SCHEMA'),'NOT_SUPPORTED');
  for(const [native,code]of [['RECOVERY_REQUIRED','RECOVERY_REQUIRED'],['CONFIG_CHANGED','CONFIG_CHANGED'],['NONE',null]])
    assert.equal(nativePhysicalHierarchyCodeToApi(native),code);
});
test('strict framing refuses missing LF, duplicates, invalid UTF8, trailing bytes and complete overflow',()=>{
  const good=bytes(state()),raw=good.toString();
  for(const b of [good.subarray(0,-1),Buffer.from(raw.replace('"ok":true','"ok":true,"ok":true')),
    Buffer.from(raw.replace('"Controlled free"','"bad\\ud800"')),Buffer.concat([good,Buffer.from('x\n')]),
    Buffer.concat([good.subarray(0,10),Buffer.from([255]),good.subarray(10)]),Buffer.alloc(512*1024+1,10)]){
    assert.throws(()=>decodePhysicalHierarchyRead(b,stateRequest,authority),{code:'OWNER_UNAVAILABLE'});
  }
  assert.throws(()=>decode({ok:false,code:['CONFIG_CHANGED']},stateRequest),{code:'OWNER_UNAVAILABLE'});
  assert.throws(()=>decode({ok:false,code:'CONFIG_CHANGED'},stateRequest),{code:'CONFIG_CHANGED'});
});
test('physical-only array opt-in retains default limits and real ProcessPool read framing',async()=>{
  const a=Buffer.from(JSON.stringify(Array(4001).fill(0)));
  assert.throws(()=>strictJson(a,false));
  assert.throws(()=>strictJson(a,false,4000));
  assert.equal(strictJson(a,false,16000).length,4001);
  assert.throws(()=>strictJson(Buffer.from(JSON.stringify(Array(16001).fill(0))),false,16000));
  const pool=new ProcessPool(1),script='process.stdout.write(JSON.stringify({rows:Array(4001).fill(0)})+"\\n")';
  const result=await pool.run(process.execPath,['-e',script],'',{cap:512*1024,newlineTerminated:true,jsonArrayLimit:16000});
  assert.equal(result.rows.length,4001);
  await assert.rejects(pool.run(process.execPath,['-e',script],'',{cap:512*1024,newlineTerminated:true}));
  assert.equal(pool.isIdle(),true);
});
test('frozen explicit grants and fixed process options use dedicated verifier without profiles',async()=>{
  const calls=[],main={run:async(...a)=>{calls.push(['main',...a]);return state();}},verify={run:async(...a)=>{calls.push(['verify',...a]);return state();}};
  const mutable=clone(config),owner=new PhysicalHierarchyOwner(mutable,main,verify);
  mutable.library=base+'/changed';mutable.projects[0].allowInternal=false;
  await owner.read('project',stateRequest);await owner.read('project',stateRequest,{verify:true});
  assert.equal(owner.config.library,config.library);assert.equal(owner.config.projects[0].allowInternal,true);
  assert.ok(Object.isFrozen(owner.config.projects[0]));assert.equal(owner.has('other'),false);
  for(const call of calls){
    assert.deepEqual(call[2],['--physical-hierarchy-read','--library',config.library,'--project','project','--visibility','internal']);
    assert.equal(call[4].jsonArrayLimit,16000);assert.equal(call[4].timeoutMs,30000);
    assert.equal(call[4].newlineTerminated,true);assert.equal(call[4].cap,512*1024);
  }
  assert.deepEqual(calls.map(c=>c[0]),['main','verify']);
  await assert.rejects(owner.read('other',stateRequest),{code:'SCOPE_DENIED'});
  const defaultVerify=new PhysicalHierarchyOwner(config,new ProcessPool(1));assert.notEqual(defaultVerify.pool,defaultVerify.verifyPool);
});
test('started transport failures remain unknown; exact confirmation and confirmed fallback survive without retries',async()=>{
  const outcomes=[
    {kind:'not_started',code:'SESSION_EXPIRED'},
    {kind:'closed',exitCode:1,transportOk:true,bytes:bytes(ack())},
    {kind:'closed',exitCode:0,transportOk:false,bytes:bytes(ack())},
    {kind:'closed',exitCode:0,transportOk:true,bytes:null},closed({...ack(),action:'wrong'}),
    closed(ack()),closed(ack(false)),
  ];
  for(let i=0;i<outcomes.length;i++){
    let calls=0;const pool={runWrite:async(_b,_a,_i,o)=>{calls++;await o.guard?.();if(i)o.onStarted?.();return outcomes[i];}};
    const owner=new PhysicalHierarchyOwner(config,pool);const result=await owner.write('project',writeRequest);
    assert.equal(calls,1);assert.equal(result.started,i!==0);
    assert.equal(result.reply.outcome,i===0?'refused':i>=5?'confirmed':'unknown');
    if(!i)assert.equal(result.preflightCode,'SESSION_EXPIRED');
    if(i===6)assert.equal(result.reply.details,null);
  }
});
