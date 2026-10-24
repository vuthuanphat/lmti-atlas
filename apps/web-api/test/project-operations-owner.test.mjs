import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  ProjectOperationOwner, checkedProjectOperationReadRequest, checkedProjectOperationWriteRequest,
  decodeProjectOperationRead, decodeProjectOperationWrite, nativeOperationCodeToApi,
} from '../dist/project-operations-owner.js';
import { ProcessPool } from '../dist/process.js';
import { ApiError } from '../dist/security.js';

const base=process.platform==='win32'?'C:/codec-fixture':'/codec-fixture';
const libId='11111111-1111-4111-8111-111111111111', copyId='22222222-2222-4222-8222-222222222222';
const storeId='33333333-3333-4333-8333-333333333333', operationId='44444444-4444-4444-8444-444444444444';
const oldStoreId='55555555-5555-4555-8555-555555555555', otherId='66666666-6666-4666-8666-666666666666';
const d='a'.repeat(64),d2='b'.repeat(64),d3='c'.repeat(64);
const library={schema:3,canonicalPath:base+'/library.sqlite',uuid:libId,generation:4,digest:d};
const source={schemaVersion:2,projectId:'project',canonicalPath:base+'/source.sqlite',storeUuid:oldStoreId,revision:2,contentDigest:d,registryDigest:d2};
const target={...source,canonicalPath:base+'/copies/'+copyId+'/project.sqlite',storeUuid:storeId,revision:3};
const preview={mode:'clone_v2',seedsInternalSites:false,source,targetRevision:3,targetContentDigest:d,targetRegistryDigest:d2};
const candidate={library,projectId:'project',copyParent:base+'/copies',copyOperationId:copyId,mode:'clone_v2',seedsInternalSites:false,source,target};
const token={libraryUuid:libId,operationId,receiptDigest:d,revision:1};
const prepared={token,state:'prepared',prepared:candidate,sourceFolder:null,sourceFolderKey:'',activatedGeneration:0};
const config={adminBinary:base+'/admin.exe',library:base+'/library.sqlite',copyParent:base+'/copies',backupParent:base+'/backups'};
const copyRequest={action:'copy-prepare',projectId:'project',expected:{libraryIdentity:library,preview}};
const status={operationId:copyId,state:'prepared',code:'NONE',mode:'clone_v2',seedsInternalSites:false,verifiedReceipt:true,source,target};
const bytes=v=>Buffer.from(JSON.stringify(v)+'\n');
const clone=v=>structuredClone(v);
const readFrame=(action,extra)=>({ok:true,schema:'lmti.project.operations.v1',action,...extra});
const writeFrame=(request,details,id=operationId,outcome='confirmed',code='NONE')=>({
  schema:'lmti.project.operation.write.v1',action:request.action,outcome,code,operationId:id,details,detailsAvailable:details!==null,
});
const fallback=(r,outcome='confirmed',code='NONE')=>writeFrame(r,null,null,outcome,code);
const closed=frame=>({kind:'closed',exitCode:0,transportOk:true,bytes:frame});
const copyAck=()=>writeFrame(copyRequest,status,copyId);
const lib1={...library,schema:1,uuid:null,generation:null},lib2={...library,schema:2};
const format={source:lib2,fullSnapshotDigest:d3};
const requests=[
  {action:'inspect',projectId:'project'},{action:'copy-preview',projectId:'project',mode:'clone_v2'},
  {action:'copy-discover',offset:0,limit:5,snapshot:null},{action:'copy-inspect',operationId:copyId},
  {action:'activation-history',projectId:'project',offset:0,limit:5,snapshot:null},
  {action:'library-format-preview',fromSchema:2},{action:'library-format-status'},
  {action:'activation-candidate',projectId:'project',copyOperationId:copyId},
  {action:'activation-inspect',libraryUuid:libId,operationId},
];
const responses=[
  readFrame('inspect',{libraryIdentity:library,project:{projectId:'project',name:'Controlled',database:base+'/source.sqlite',root:'',schemaVersion:2,storeUuid:oldStoreId,revision:2}}),
  readFrame('copy-preview',{libraryIdentity:library,projectId:'project',preview}),
  readFrame('copy-discover',{complete:true,code:'NONE',examinedEntries:1,unattributedEntries:0,snapshot:d,offset:0,nextOffset:null,
    items:[{operationId:copyId,state:'uninspected',intent:{mode:'clone_v2',seedsInternalSites:false,source,target}}]}),
  readFrame('copy-inspect',{status}),
  readFrame('activation-history',{libraryIdentity:library,projectId:'project',snapshot:d,offset:0,nextOffset:null,
    items:[{operationId,projectId:'project',copyOperationId:copyId,state:'prepared',revision:1}]}),
  readFrame('library-format-preview',{fromSchema:2,toSchema:3,expected:format}),
  readFrame('library-format-status',{libraryIdentity:library,upgradeOperationId:otherId,legacyDigest:d,
    activationFormatOperationId:operationId,activationFormatBackupDigest:d3}),
  readFrame('activation-candidate',{preview:candidate}),
  readFrame('activation-inspect',{libraryIdentity:library,receipt:prepared,condition:'prepared_current',code:'NONE'}),
];

test('all nine read DTOs decode exactly, independently preserving nullable roots',()=>{
  requests.forEach((r,i)=>{
    assert.deepEqual(decodeProjectOperationRead(bytes(responses[i]),r),responses[i]);
    const bad=clone(responses[i]);bad.extra='private';assert.throws(()=>decodeProjectOperationRead(bytes(bad),r),{code:'OWNER_UNAVAILABLE'});
  });
  const result=decodeProjectOperationRead(bytes(responses[8]),requests[8]);
  assert.equal(result.receipt.sourceFolder,null);assert.equal(result.receipt.sourceFolderKey,'');
  assert.ok(Object.isFrozen(result.receipt.prepared.source));
});
test('read failures map bounded codes without owner text and malformed shape never forwards errors',()=>{
  for(const [native,api] of [['INVALID_INPUT','INVALID_INPUT'],['SCOPE_DENIED','SCOPE_DENIED'],['BUDGET_EXCEEDED','LIMIT_EXCEEDED'],
    ['UNSUPPORTED_FORMAT','NOT_SUPPORTED'],['SOURCE_CHANGED','CONFIG_CHANGED'],['EVIDENCE_INVALID','RECOVERY_REQUIRED']]){
    assert.equal(nativeOperationCodeToApi(native),api);
    assert.throws(()=>decodeProjectOperationRead(bytes({ok:false,code:native}),requests[0]),{code:api});
  }
  for(const v of [{ok:false,code:'RAW_SECRET'},{ok:false,code:'NONE'},{ok:false,code:'CONFIG_CHANGED',message:base}]){
    assert.throws(()=>decodeProjectOperationRead(bytes(v),requests[0]),e=>e.code==='OWNER_UNAVAILABLE'&&!e.message.includes(base));
  }
});
test('read selectors, paging, snapshots and project/operation correlation reject malformed or mixed responses',()=>{
  for(const r of [{action:'latest'},{action:'inspect',projectId:'../project'},
    {...requests[2],offset:true},{...requests[2],offset:1},{...requests[2],limit:51},
    {...requests[2],snapshot:d},{...requests[8],operationId:otherId,source:base}]){
    assert.throws(()=>checkedProjectOperationReadRequest(r),{code:'INVALID_INPUT'});
  }
  for(const i of [0,1,4,7,8]){
    const value=clone(responses[i]);
    if(i===0)value.project.projectId='other';
    if(i===1)value.preview.source.projectId='other';
    if(i===4)value.items[0].projectId='other';
    if(i===7)value.preview.copyOperationId=otherId;
    if(i===8)value.receipt.token.operationId=otherId;
    assert.throws(()=>decodeProjectOperationRead(bytes(value),requests[i]),{code:'OWNER_UNAVAILABLE'});
  }
  const page=clone(responses[2]);page.nextOffset=3;
  assert.throws(()=>decodeProjectOperationRead(bytes(page),requests[2]),{code:'OWNER_UNAVAILABLE'});
  page.nextOffset=null;page.items.push(clone(page.items[0]));
  assert.throws(()=>decodeProjectOperationRead(bytes(page),requests[2]),{code:'OWNER_UNAVAILABLE'});
  assert.throws(()=>decodeProjectOperationRead(bytes({...responses[2],offset:1}),{...requests[2],offset:1,snapshot:d2}),{code:'OWNER_UNAVAILABLE'});
});
test('native path spelling remains opaque, including Unicode folding; unsafe paths and schema null mistakes fail',()=>{
  const value=clone(responses[0]);value.libraryIdentity.canonicalPath=base+'/STRASSE/library.sqlite';
  const result=decodeProjectOperationRead(bytes(value),requests[0]);
  assert.equal(result.libraryIdentity.canonicalPath,value.libraryIdentity.canonicalPath);
  value.libraryIdentity.canonicalPath=base+'/'+('é'.repeat(120)+'/').repeat(5)+'library.sqlite';
  assert.ok(Buffer.byteLength(value.libraryIdentity.canonicalPath)>1024&&value.libraryIdentity.canonicalPath.length<=1024);
  assert.equal(decodeProjectOperationRead(bytes(value),requests[0]).libraryIdentity.canonicalPath,value.libraryIdentity.canonicalPath);
  for(const unsafe of ['relative','//server/share/library.sqlite',base+'/../library.sqlite',base+'/library.sqlite:ads',base+'/NUL',base+'/trailing.']){
    value.libraryIdentity.canonicalPath=unsafe;
    assert.throws(()=>decodeProjectOperationRead(bytes(value),requests[0]),{code:'OWNER_UNAVAILABLE'});
  }
  for(const libraryIdentity of [{...lib1,uuid:libId},{...lib1,generation:0},{...lib2,uuid:null},{...lib2,generation:0},{...lib2,generation:true}]){
    assert.throws(()=>decodeProjectOperationRead(bytes({...responses[0],libraryIdentity}),requests[0]),{code:'OWNER_UNAVAILABLE'});
  }
});
test('copy-inspect preserves unknown metadata and discovery never promotes candidates',()=>{
  const unknown={...status,state:'recovery_required',code:'EVIDENCE_INVALID',verifiedReceipt:false,mode:null,seedsInternalSites:null,source:null,target:null};
  assert.deepEqual(decodeProjectOperationRead(bytes(readFrame('copy-inspect',{status:unknown})),requests[3]).status,unknown);
  const bad={...unknown,state:'prepared',code:'NONE'};
  assert.throws(()=>decodeProjectOperationRead(bytes(readFrame('copy-inspect',{status:bad})),requests[3]),{code:'OWNER_UNAVAILABLE'});
  const discovery=clone(responses[2]);discovery.items[0].state='prepared';
  assert.throws(()=>decodeProjectOperationRead(bytes(discovery),requests[2]),{code:'OWNER_UNAVAILABLE'});
});
test('six write ACKs correlate original tokens and exact action-specific states',()=>{
  const v1={action:'library-upgrade-v1',expected:lib1},v2={action:'library-upgrade-v2',expected:format};
  const prepare={action:'activation-prepare',expected:candidate};
  const activate={action:'activation-activate',projectId:'project',expected:token};
  const abandon={...activate,action:'activation-abandon'};
  const upgraded1={state:'upgraded',operationId,backupPath:base+'/backups/'+operationId+'/library-v1.sqlite',libraryIdentity:{...lib2,generation:1}};
  const upgraded2={state:'upgraded',operationId,backupPath:base+'/backups/'+operationId+'/library-v2.sqlite',libraryIdentity:library};
  const terminal=state=>({...prepared,state,token:{...token,revision:2,receiptDigest:d2},activatedGeneration:state==='activated'?5:0});
  for(const [request,ack] of [[copyRequest,copyAck()],[v1,writeFrame(v1,upgraded1)],[v2,writeFrame(v2,upgraded2)],
    [prepare,writeFrame(prepare,{receipt:prepared})],[activate,writeFrame(activate,{receipt:terminal('activated')})],[abandon,writeFrame(abandon,{receipt:terminal('abandoned')})]]){
    assert.deepEqual(decodeProjectOperationWrite(bytes(ack),request),ack);
    const wrong=clone(ack);wrong.action='different';assert.throws(()=>decodeProjectOperationWrite(bytes(wrong),request),{code:'OWNER_UNAVAILABLE'});
    assert.deepEqual(decodeProjectOperationWrite(bytes(fallback(request)),request),fallback(request));
  }
});
test('confirmed copy cannot substitute source, revision, project, registry, target operation or receipt verification',()=>{
  for(const mutate of [
    v=>v.details.source.revision++,v=>v.details.target.revision++,v=>v.details.source.projectId='other',
    v=>v.details.target.registryDigest=d3,v=>v.details.target.canonicalPath=base+'/copies/'+otherId+'/project.sqlite',
    v=>v.details.verifiedReceipt=false,v=>v.details={status:v.details},v=>v.operationId=otherId,
  ]){
    const value=clone(copyAck());mutate(value);
    assert.throws(()=>decodeProjectOperationWrite(bytes(value),copyRequest),{code:'OWNER_UNAVAILABLE'});
  }
});
test('activation reply cannot invent a different review, operation, revision or generation',()=>{
  const prepare={action:'activation-prepare',expected:candidate};
  for(const mutate of [v=>v.details.receipt.prepared.library.generation++,v=>v.details.receipt.prepared.source.contentDigest=d3,
    v=>v.details.receipt.token.libraryUuid=otherId,v=>v.details.receipt.token.revision=2,v=>v.details.receipt.activatedGeneration=1]){
    const ack=writeFrame(prepare,clone({receipt:prepared}));mutate(ack);
    assert.throws(()=>decodeProjectOperationWrite(bytes(ack),prepare),{code:'OWNER_UNAVAILABLE'});
  }
  const request={action:'activation-activate',projectId:'project',expected:token};
  const activated={...prepared,state:'activated',token:{...token,revision:2,receiptDigest:d2},activatedGeneration:5};
  for(const receipt of [{...activated,activatedGeneration:6},{...activated,token:{...activated.token,operationId:otherId}},
    {...activated,token:{...activated.token,receiptDigest:d}},{...activated,state:'prepared'}]){
    assert.throws(()=>decodeProjectOperationWrite(bytes(writeFrame(request,{receipt})),request),{code:'OWNER_UNAVAILABLE'});
  }
});
test('native refusal, intended recovery and minimal fallback retain distinct semantics',()=>{
  const refused=fallback(copyRequest,'refused','SOURCE_CHANGED');
  assert.deepEqual(decodeProjectOperationWrite(bytes(refused),copyRequest),refused);
  const unknown=writeFrame(copyRequest,{...status,state:'recovery_required',code:'RECOVERY_REQUIRED',verifiedReceipt:false},copyId,'unknown','RECOVERY_REQUIRED');
  assert.equal(decodeProjectOperationWrite(bytes(unknown),copyRequest).outcome,'unknown');
  for(const ack of [{...refused,operationId:copyId},{...unknown,code:'NONE'},{...copyAck(),code:'BUSY'},
    {...fallback(copyRequest),detailsAvailable:true},{...fallback(copyRequest),operationId:copyId},
    {...refused,action:null,code:'SOURCE_CHANGED'}]){
    assert.throws(()=>decodeProjectOperationWrite(bytes(ack),copyRequest),{code:'OWNER_UNAVAILABLE'});
  }
});
test('duplicate keys, invalid UTF8, trailing bytes, oversized or non-object ACKs are never accepted',()=>{
  const valid=bytes(copyAck());
  for(const bad of [Buffer.from('{"schema":"x","schema":"y"}\n'),Buffer.from('{"a":1,"a":2}\n'),Buffer.from('[]\n'),
    Buffer.concat([valid,Buffer.from([0])]),Buffer.concat([valid,Buffer.from([0x1a])]),Buffer.from([0xff,10]),
    valid.subarray(0,valid.length-1),Buffer.alloc(512*1024+1,32),Buffer.from('')]){
    assert.throws(()=>decodeProjectOperationWrite(bad,copyRequest),{code:'OWNER_UNAVAILABLE'});
  }
});
test('request validators reject coercion, extras, schema/version and token shape errors',()=>{
  for(const mutate of [v=>v.expected.preview.seedsInternalSites=0,v=>v.expected.preview.targetRevision=4,
    v=>v.expected.preview.source.storeUuid=null,v=>v.expected.libraryIdentity.generation=Number.MAX_SAFE_INTEGER+1,
    v=>v.projectId='other',v=>v.source=base,v=>v.expected.preview.source.revision=true]){
    const request=clone(copyRequest);mutate(request);assert.throws(()=>checkedProjectOperationWriteRequest(request),{code:'INVALID_INPUT'});
  }
  const checked=checkedProjectOperationWriteRequest(copyRequest);
  assert.ok(Object.isFrozen(checked.expected.preview.source));
  assert.notEqual(checked.expected.preview.source,copyRequest.expected.preview.source);
  const boundary=clone(copyRequest);
  boundary.expected.preview.source.revision=Number.MAX_SAFE_INTEGER-2;
  boundary.expected.preview.targetRevision=Number.MAX_SAFE_INTEGER-1;
  assert.equal(checkedProjectOperationWriteRequest(boundary).expected.preview.targetRevision,Number.MAX_SAFE_INTEGER-1);
  boundary.expected.preview.source.revision++;boundary.expected.preview.targetRevision++;
  assert.throws(()=>checkedProjectOperationWriteRequest(boundary),{code:'INVALID_INPUT'});
});
test('adapter uses fixed arguments, main/verify pools, immutable construction and bounded input/output',async()=>{
  const calls=[];
  const pool={run:async(...args)=>{calls.push(['main',...args]);return clone(responses[0]);},runWrite:async(...args)=>{
    calls.push(['write',...args]);args[3].onStarted();return closed(bytes(copyAck()));}};
  const verify={run:async(...args)=>{calls.push(['verify',...args]);return clone(responses[0]);}};
  const supplied=clone(config),owner=new ProjectOperationOwner(supplied,pool,verify);supplied.library=base+'/changed';
  await owner.read(requests[0]);await owner.read(requests[0],{verify:true});
  let started=0;const result=await owner.write(copyRequest,{onStarted:()=>started++});
  assert.equal(started,1);assert.equal(result.started,true);assert.equal(result.reply.outcome,'confirmed');assert.equal(result.preflightCode,null);
  assert.deepEqual(calls.map(v=>v[0]),['main','verify','write']);
  assert.deepEqual(calls[0][2],['--project-operations','--library',config.library,'--copy-parent',config.copyParent]);
  for(const call of calls.slice(0,2)){
    assert.equal(call[4].newlineTerminated,true);assert.equal(call[4].cap,512*1024);
    assert.equal(call[4].raw,undefined);assert.ok(Buffer.byteLength(call[3])<=32*1024);
  }
  assert.deepEqual(calls[2][2],['--project-operation-write','--library',config.library,'--copy-parent',config.copyParent,'--backup-parent',config.backupParent]);
  assert.equal(calls[2][4].cap,512*1024);assert.ok(Buffer.byteLength(calls[2][3])<=32*1024);
  assert.ok(Object.isFrozen(owner.config));assert.ok(Object.isFrozen(result.reply.details.source));
});
test('known no-start refusal differs from started malformed ACK and transport failure',async()=>{
  for(const code of ['BUSY','SCOPE_DENIED','SESSION_EXPIRED']){
    const owner=new ProjectOperationOwner(config,{runWrite:async()=>({kind:'not_started',code})});
    const result=await owner.write(copyRequest);
    assert.equal(result.started,false);assert.equal(result.reply.outcome,'refused');assert.equal(result.preflightCode,code);
  }
  for(const transport of [
    closed(bytes({...copyAck(),action:'activation-activate'})),closed(Buffer.from('bad\n')),
    {kind:'closed',exitCode:1,bytes:bytes(fallback(copyRequest,'refused','INVALID_INPUT')),transportOk:true},
    {kind:'closed',exitCode:0,bytes:null,transportOk:false},
  ]){
    const owner=new ProjectOperationOwner(config,{runWrite:async()=>transport});
    const result=await owner.write(copyRequest);
    assert.equal(result.started,true);assert.equal(result.reply.outcome,'unknown');assert.equal(result.preflightCode,null);
    assert.equal(result.reply.details,null);
  }
});
test('unexpected transport exceptions and contradictory started evidence cannot produce refusal',async()=>{
  for(const runWrite of [async()=>{throw new Error(base);},async(_binary,_args,_input,options)=>{
    options.onStarted();return {kind:'not_started',code:'OWNER_UNAVAILABLE'};}]){
    const owner=new ProjectOperationOwner(config,{runWrite});const result=await owner.write(copyRequest);
    assert.equal(result.started,true);assert.equal(result.reply.outcome,'unknown');
    assert.ok(!JSON.stringify(result).includes(base));
  }
});
test('a later reload error does not mutate or demote a confirmed typed result',async()=>{
  const owner=new ProjectOperationOwner(config,{runWrite:async()=>closed(bytes(copyAck())),run:async()=>{throw new ApiError('OWNER_UNAVAILABLE');}});
  const completed=await owner.write(copyRequest);
  await assert.rejects(owner.read(requests[0]),{code:'OWNER_UNAVAILABLE'});
  assert.equal(completed.reply.outcome,'confirmed');assert.equal(completed.reply.operationId,copyId);
});

const realAvailable=Boolean(process.env.LMTI_WEB_TEST_ADMIN&&process.env.LMTI_WEB_TEST_BINDING_PRODUCER);
test('default verifier completes a real guarded write while the sole main-pool slot is held',
  {skip:!realAvailable,timeout:60000},async t=>{
  const root=await mkdtemp(join(tmpdir(),'lmti-operation-verifier-'));
  const main=new ProcessPool(1);
  t.after(async()=>{
    await main.waitForIdle();
    assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));
    await rm(root,{recursive:true,force:true});
  });
  const producer=spawnSync(process.env.LMTI_WEB_TEST_BINDING_PRODUCER,['--fixture',root,'1','2'],
    {encoding:'utf8',timeout:15000,windowsHide:true,maxBuffer:8192});
  assert.equal(producer.status,0,'Controlled native fixture producer failed');
  const copyParent=join(root,'codec-copies'),backupParent=join(root,'codec-backups');
  await mkdir(copyParent);await mkdir(backupParent);
  // Omit explicit verifier injection: the default must be independent of main.
  const owner=new ProjectOperationOwner({adminBinary:process.env.LMTI_WEB_TEST_ADMIN,
    library:join(root,'library.sqlite'),copyParent,backupParent},main);
  const original=await readFile(join(root,'project.sqlite'));
  const review=await owner.read({action:'library-format-preview',fromSchema:1});
  let guards=0,started=0;
  const completed=await owner.write({action:'library-upgrade-v1',expected:review.expected},{
    guard:async()=>{
      guards++;assert.equal(main.isIdle(),false);
      let timer;
      try{
        // A shared-pool regression must fail in bounded time, releasing the guard
        // and allowing its queued read to drain before fixture cleanup.
        const current=await Promise.race([
          owner.read({action:'library-format-preview',fromSchema:1},{verify:true}),
          new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Verifier could not run while main was occupied.')),10000);}),
        ]);
        assert.deepEqual(current.expected,review.expected);
      }finally{clearTimeout(timer);}
    },
    onStarted:()=>started++,
  });
  await main.waitForIdle();
  assert.equal(guards,1);assert.equal(started,1);
  assert.equal(completed.started,true);assert.equal(completed.reply.outcome,'confirmed');
  assert.equal(completed.preflightCode,null);
  const current=await owner.read({action:'library-format-status'});
  assert.equal(current.libraryIdentity.schema,2);
  assert.deepEqual(await readFile(join(root,'project.sqlite')),original);
});
test('real current native adapter: separate formats, migrate/clone, prepare/abandon/activate and recovery', {skip:!realAvailable,timeout:120000},async t=>{
  const root=await mkdtemp(join(tmpdir(),'lmti-operation-codec-'));
  t.after(async()=>{assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));await rm(root,{recursive:true,force:true});});
  for(const projectSchema of [1,2]){
    const location=join(root,`schema-${projectSchema}`);await mkdir(location);
    const producer=spawnSync(process.env.LMTI_WEB_TEST_BINDING_PRODUCER,['--fixture',location,'1',String(projectSchema)],{encoding:'utf8',timeout:15000,windowsHide:true,maxBuffer:8192});
    assert.equal(producer.status,0,'Controlled native fixture producer failed');
    const copyParent=join(location,'codec-copies'),backupParent=join(location,'codec-backups');
    await mkdir(copyParent);await mkdir(backupParent);
    const owner=new ProjectOperationOwner({adminBinary:process.env.LMTI_WEB_TEST_ADMIN,library:join(location,'library.sqlite'),copyParent,backupParent},new ProcessPool(1));
    const original=await readFile(join(location,'project.sqlite'));
    for(const fromSchema of [1,2]){
      const p=await owner.read({action:'library-format-preview',fromSchema});
      const result=await owner.write({action:fromSchema===1?'library-upgrade-v1':'library-upgrade-v2',expected:p.expected});
      assert.equal(result.reply.outcome,'confirmed');
      const status=await owner.read({action:'library-format-status'});assert.equal(status.libraryIdentity.schema,fromSchema+1);
    }
    const p=await owner.read({action:'copy-preview',projectId:'factory-monitor',mode:projectSchema===1?'migrate_v1':'clone_v2'});
    const copied=await owner.write({action:'copy-prepare',projectId:'factory-monitor',expected:{libraryIdentity:p.libraryIdentity,preview:p.preview}});
    assert.equal(copied.reply.outcome,'confirmed');assert.ok(copied.reply.operationId);
    const inspected=await owner.read({action:'copy-inspect',operationId:copied.reply.operationId});assert.equal(inspected.status.state,'prepared');
    const review=await owner.read({action:'activation-candidate',projectId:'factory-monitor',copyOperationId:copied.reply.operationId});
    const preparedA=await owner.write({action:'activation-prepare',expected:review.preview});
    const preparedB=await owner.write({action:'activation-prepare',expected:review.preview});
    assert.equal(preparedA.reply.outcome,'confirmed');assert.equal(preparedB.reply.outcome,'confirmed');
    const a=preparedA.reply.details.receipt.token,b=preparedB.reply.details.receipt.token;
    const abandoned=await owner.write({action:'activation-abandon',projectId:'factory-monitor',expected:a});
    const activated=await owner.write({action:'activation-activate',projectId:'factory-monitor',expected:b});
    assert.equal(abandoned.reply.outcome,'confirmed');assert.equal(activated.reply.outcome,'confirmed');
    const current=await owner.read({action:'activation-inspect',libraryUuid:b.libraryUuid,operationId:b.operationId});
    assert.equal(current.condition,'activated_current');
    const history=await owner.read({action:'activation-history',projectId:'factory-monitor',offset:0,limit:50,snapshot:null});
    assert.equal(history.items.length,2);
    const discovery=await owner.read({action:'copy-discover',offset:0,limit:50,snapshot:null});
    assert.equal(discovery.complete,true);assert.equal(discovery.items.length,1);
    assert.deepEqual(await readFile(join(location,'project.sqlite')),original);
    await assert.rejects(owner.read({action:'inspect',projectId:'absent-project'}),{code:'SCOPE_DENIED'});
  }
});
