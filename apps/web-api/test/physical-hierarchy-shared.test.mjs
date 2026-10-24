import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Owners } from '../dist/owners.js';
import { ApiError, hash, strictJson } from '../dist/security.js';
import { recoveryValueKey } from '../dist/legacy-recovery-target.js';
import { canonicalRecoveryJson, checkedRecoveryEntries, checkedRecoverySubject } from '../dist/recovery-subject.js';
import { collectOriginalTargets } from '../dist/recovery-collection.js';
import { WriteCoordinator } from '../dist/write-coordinator.js';
import { ProjectOperationsService } from '../dist/project-operations-service.js';

const scratch=resolve(process.env.LMTI_WEB_TEST_TMP??fileURLToPath(new URL('../../../build',import.meta.url)));
const code=value=>e=>e instanceof ApiError&&e.code===value;
const digest=hash('controlled physical shared fixture');
async function fixture(t,options={}) {
  await mkdir(scratch,{recursive:true});
  const root=await mkdtemp(join(scratch,'physical-shared-')),pkg=join(root,'package'),data=join(root,'data'),
    scripts=join(pkg,'share','lmti','scripts');
  for(const path of [join(pkg,'bin'),data,scripts,join(root,'copies'),join(root,'backups')])
    await mkdir(path,{recursive:true});
  const config={adminBinary:join(pkg,'bin','lmti-mcp-admin.exe'),projectBinary:join(pkg,'bin','lmti-project.exe'),
    python:join(root,'python.exe'),agentEntry:join(scripts,'lmti-agent-mcp.py'),configOwner:join(scripts,'mcp-config-owner.py'),
    library:join(data,'library.sqlite'),profiles:join(data,'profiles.sqlite'),
    allowedProjects:['project','other'],port:0,openBrowser:false,...options};
  for(const path of [config.adminBinary,config.projectBinary,config.python,config.agentEntry,config.configOwner,
    join(scripts,'web-broker-guard.py'),config.library])
    await writeFile(path,'inert controlled fixture');
  const all=[];
  const make=async override=>{
    const owner=new Owners({...config,...override});all.push(owner);await owner.validateLaunch();return owner;
  };
  t.after(async()=>{
    await Promise.all(all.map(owner=>owner.waitForIdle()));
    assert.ok(resolve(root).startsWith(scratch+sep));
    await rm(root,{recursive:true,force:true});
  });
  return {root,pkg,data,config,make};
}
function oldDomain(c) {
  return hash(recoveryValueKey({adminBinary:c.adminBinary,projectBinary:c.projectBinary,python:c.python,
    agentEntry:c.agentEntry,configOwner:c.configOwner,helper:join(dirname(c.configOwner),'web-broker-guard.py'),
    library:c.library,profiles:c.profiles,allowedProjects:[...c.allowedProjects].sort(),agentRead:null,
    projectOperations:c.projectOperations?{...c.projectOperations,projectIds:[...c.projectOperations.projectIds].sort()}:null,
    ...(c.logicalHierarchy?{logicalHierarchy:{projects:[...c.logicalHierarchy.projects]
      .sort((a,b)=>a.projectId<b.projectId?-1:a.projectId>b.projectId?1:0)}}:{})}));
}

test('absent physical capability preserves exact legacy/logical/operations domain and logical grant formulas',async t=>{
  const f=await fixture(t),logical={projects:[{projectId:'project',allowInternal:true}]},
    operations={copyParent:join(f.root,'copies'),backupParent:join(f.root,'backups'),projectIds:['other','project'],allowLibraryUpgrade:true};
  for(const extra of [{},{logicalHierarchy:logical},{projectOperations:operations},{logicalHierarchy:logical,projectOperations:operations}]) {
    const o=await f.make(extra),c={...f.config,...extra};
    assert.equal(o.recoveryDomainId(),oldDomain(c));
    assert.equal(o.physicalHierarchyOwner,null);assert.equal(o.physicalHierarchyRecovery,null);
    assert.equal(o.hasPhysicalHierarchy('project'),false);assert.deepEqual(o.physicalHierarchyGrants(),[]);
    assert.equal(Object.hasOwn(o.config,'physicalHierarchy'),false);
    assert.throws(()=>o.physicalHierarchyGrantId('project'),code('SCOPE_DENIED'));
    if(extra.logicalHierarchy)assert.equal(o.hierarchyGrantId('project'),
      hash(recoveryValueKey({domainId:oldDomain(c),projectId:'project',allowInternal:true})));
  }
});

test('physical grants are independent, defensively frozen, order-stable and use a distinct discriminator',async t=>{
  const f=await fixture(t),physical={projects:[{projectId:'project',allowInternal:true},{projectId:'other',allowInternal:false}]};
  const a=await f.make({physicalHierarchy:physical,logicalHierarchy:{projects:[{projectId:'project',allowInternal:true}]}});
  const b=await f.make({physicalHierarchy:{projects:[...physical.projects].reverse()},logicalHierarchy:{projects:[{projectId:'project',allowInternal:true}]}});
  assert.equal(a.recoveryDomainId(),b.recoveryDomainId());
  assert.equal(a.physicalHierarchyGrantId('project'),b.physicalHierarchyGrantId('project'));
  assert.equal(a.physicalHierarchyGrantId('project'),hash(recoveryValueKey({
    domainId:a.recoveryDomainId(),kind:'physical_hierarchy',projectId:'project',allowInternal:true})));
  assert.notEqual(a.physicalHierarchyGrantId('project'),a.hierarchyGrantId('project'));
  assert.equal(a.physicalHierarchyOwner.pool,a.pool);assert.equal(a.physicalHierarchyOwner.verifyPool,a.verificationPool);
  physical.projects[0].allowInternal=false;physical.projects.push({projectId:'unauthorized',allowInternal:true});
  assert.deepEqual(a.physicalHierarchyGrants(),[{projectId:'other',allowInternal:false},{projectId:'project',allowInternal:true}]);
  assert.throws(()=>{a.physicalHierarchyGrants()[0].allowInternal=false;},TypeError);
  const changed=await f.make({physicalHierarchy:{projects:[{projectId:'project',allowInternal:false},{projectId:'other',allowInternal:false}]},
    logicalHierarchy:{projects:[{projectId:'project',allowInternal:true}]}});
  assert.notEqual(a.recoveryDomainId(),changed.recoveryDomainId());
  const physicalOnly=await f.make({physicalHierarchy:{projects:[{projectId:'project',allowInternal:true}]}});
  assert.ok(physicalOnly.physicalHierarchyOwner);assert.equal(physicalOnly.logicalHierarchyOwner,null);
  assert.equal(physicalOnly.hasLogicalHierarchy('project'),false);assert.equal(physicalOnly.hasPhysicalHierarchy('other'),false);
  const removed=await f.make({});assert.notEqual(removed.recoveryDomainId(),physicalOnly.recoveryDomainId());
});

test('physical optional config refuses coercion, extra fields, absent/subset grants and package data',async t=>{
  const f=await fixture(t);
  for(const physicalHierarchy of [null,{}, {projects:[]},{projects:[{projectId:'denied',allowInternal:false}]},
    {projects:[{projectId:'project',allowInternal:'false'}]}, {projects:[{projectId:'project'}]},
    {projects:[{projectId:'project',allowInternal:true,extra:1}]},
    {projects:[{projectId:'project',allowInternal:false},{projectId:'project',allowInternal:true}]},
    {projects:Array(501).fill({projectId:'project',allowInternal:false})},
    {projects:[{projectId:'project',allowInternal:false}],extra:true}]) {
    const owner=new Owners({...f.config,physicalHierarchy});
    await assert.rejects(owner.validateLaunch(),e=>e instanceof ApiError);
    assert.equal(owner.physicalHierarchyOwner,null);assert.equal(owner.brokerGuardConfig,null);
  }
  const physicalHierarchy={projects:[{projectId:'project',allowInternal:true}]};
  await assert.rejects(f.make({physicalHierarchy,library:join(f.pkg,'data.sqlite').replaceAll('\\','/')}),code('SCOPE_DENIED'));
  await assert.rejects(f.make({physicalHierarchy,library:join(f.root,'.lmti','data.sqlite')}),code('SCOPE_DENIED'));
});

test('16000 is a per-call parser opt-in; defaults, duplicate keys, depth and recovery budgets stay fixed',()=>{
  const array=n=>Buffer.from(JSON.stringify(Array(n).fill(0)));
  assert.equal(strictJson(array(2000)).length,2000);
  assert.throws(()=>strictJson(array(2001)),code('INVALID_INPUT'));
  assert.equal(strictJson(array(4000),true,4000).length,4000);
  assert.throws(()=>strictJson(array(4001),true,4000),code('INVALID_INPUT'));
  assert.equal(strictJson(array(16000),true,16000).length,16000);
  assert.throws(()=>strictJson(array(16001),true,16000),code('INVALID_INPUT'));
  assert.throws(()=>strictJson(array(4001)),code('INVALID_INPUT'),'prior opt-in must not mutate defaults');
  for(const bytes of [Buffer.from('{"a":1,"a":2}'),Buffer.from('{"__proto__":0}'),
    Buffer.from('['.repeat(26)+'0'+']'.repeat(26)),Buffer.from([0xff])])
    assert.throws(()=>strictJson(bytes,true,16000),code('INVALID_INPUT'));
  assert.throws(()=>strictJson(array(1),true,16001),code('INVALID_INPUT'));
  const subject={version:1,kind:'physical_hierarchy',action:'physical-hierarchy-commit',projectId:'project',
    grantId:digest,target:{rows:Array(257).fill(0)}};
  assert.throws(()=>checkedRecoverySubject(subject),e=>e instanceof ApiError);
  assert.throws(()=>checkedRecoveryEntries(Array.from({length:33},(_,i)=>({
    id:'00000000-0000-4000-8000-'+String(i+1).padStart(12,'0'),subject:{...subject,target:{original:i}}
  }))),e=>e instanceof ApiError);
});

const specs=[
  ['legacy','profile_save','project-a'],['logical_hierarchy','logical-hierarchy-commit','project-b'],
  ['physical_hierarchy','physical-hierarchy-commit','project-c'],
  ['physical_hierarchy','physical-hierarchy-commit','project-c'],
  ['project_operations','activation-abandon','project-d']
];
function entriesFor(rows=specs) {
  return checkedRecoveryEntries(rows.map(([kind,action,projectId],i)=>({
    id:'00000000-0000-4000-8000-'+String(i+1).padStart(12,'0'),
    subject:{version:1,kind,action,projectId,grantId:digest,target:{original:'private-distinct-target-'+i}}
  })));
}
function observation(subject) {
  const result={digest:hash(subject.target.original)};
  if(subject.kind==='legacy')return {...result,summary:{projectId:subject.projectId,projectRevision:3,profileRevision:2,clients:[]}};
  if(subject.kind==='logical_hierarchy')return {...result,hierarchySummary:{projectId:subject.projectId,projectRevision:4}};
  if(subject.kind==='physical_hierarchy')return {...result,physicalHierarchySummary:{
    projectId:subject.projectId,projectRevision:subject.target.original.endsWith('2')?5:6}};
  return result;
}
async function retainedCoordinator(t) {
  const f=await fixture(t),entries=entriesFor();
  let state={generation:1,domainId:digest,coverage:'complete',entries},stopped=false,ackCalls=0;
  const guard={config:{library:f.config.library,domainId:digest},
    claim:async()=>({schema:'lmti.web.broker.guard.v1',outcome:'claimed',recoveryRequired:true}),
    isAdmitted:()=>!stopped,recoveryState:()=>state,
    acknowledge:async expected=>{
      assert.equal(canonicalRecoveryJson(expected),canonicalRecoveryJson(state));
      assert.equal(expected.entries.length,5,'metadata ACK must cover the complete retained set');
      ackCalls++;state={...state,generation:state.generation+1,entries:[]};return state;
    },stop:()=>{stopped=true;},waitForIdle:async()=>{}};
  // Injected verified marker state exercises the real coordinator and collector.
  // It is not evidence of a restarted OS broker or actual domain writes.
  const coordinator=await WriteCoordinator.create(f.config.library,guard,undefined,{domainId:digest});
  t.after(()=>coordinator.close());
  return {coordinator,entries,ackCalls:()=>ackCalls};
}

test('four-family full union retains duplicate physical projects and authorizes all before any observation',async t=>{
  const f=await retainedCoordinator(t),authorized=new Set(),read=[];
  const options={includeCoverage:true,guard:()=>{},authorize:s=>{authorized.add(s.target.original);},
    inspect:async s=>{assert.equal(authorized.size,5);read.push(s.target.original);return observation(s);},
    librarySchema:async()=>3};
  const token=f.coordinator.beginReconciliation(),first=await collectOriginalTargets(f.coordinator,options),
    second=await collectOriginalTargets(f.coordinator,options);
  assert.equal(first.digest,second.digest);assert.equal(read.length,10);
  assert.deepEqual(first.physicalHierarchyItems,[{projectId:'project-c',projectRevision:5},{projectId:'project-c',projectRevision:6}]);
  assert.equal(first.items.length,1);assert.equal(first.hierarchyItems.length,1);
  assert.equal(first.coverage.retainedSubjects,5);assert.equal(first.coverage.affectedScopes.length,4);
  assert.equal(first.coverage.affectedScopes.reduce((sum,row)=>sum+row.subjects,0),5);
  assert.deepEqual(first.coverage.affectedScopes.find(row=>row.kind==='physical_hierarchy'),
    {kind:'physical_hierarchy',action:'physical-hierarchy-commit',projectId:'project-c',subjects:2});
  const text=JSON.stringify({items:first.items,hierarchyItems:first.hierarchyItems,
    physicalHierarchyItems:first.physicalHierarchyItems,coverage:first.coverage});
  for(const secret of ['private-distinct-target',digest,'grantId','original',f.entries[0].id])assert.equal(text.includes(secret),false);
  const historical=Object.freeze({outcome:'unknown'});
  await f.coordinator.acknowledge(token);
  assert.equal(f.ackCalls(),1);assert.equal(f.coordinator.snapshot().recoveryRequired,false);
  assert.deepEqual(historical,{outcome:'unknown'});
  await assert.rejects(f.coordinator.acknowledge(token),code('CONFIG_CHANGED'));
});

test('each revoked family fences the entire mixed set before reads; missing summaries cannot be acknowledged',async t=>{
  const f=await retainedCoordinator(t);let reads=0;
  for(const kind of ['legacy','logical_hierarchy','physical_hierarchy','project_operations']) {
    await assert.rejects(collectOriginalTargets(f.coordinator,{includeCoverage:true,guard:()=>{},
      authorize:s=>{if(s.kind===kind)throw new ApiError('SCOPE_DENIED');},
      inspect:async s=>{reads++;return observation(s);}}),code('SCOPE_DENIED'));
    assert.equal(reads,0);assert.equal(f.ackCalls(),0);
  }
  await assert.rejects(collectOriginalTargets(f.coordinator,{includeCoverage:true,guard:()=>{},authorize:()=>{},
    inspect:async s=>s.kind==='physical_hierarchy'?{digest:hash('missing summary')}:observation(s)}),code('OWNER_UNAVAILABLE'));
  assert.equal(f.coordinator.snapshot().recoveryRequired,true);assert.equal(f.ackCalls(),0);
});

test('project-operations acknowledgment alias also collects all four retained families twice',async t=>{
  const f=await retainedCoordinator(t),session={},read=[];
  const service=new ProjectOperationsService({
    owner:{read:async()=>assert.fail('Only the complete collector reads recovery evidence'),
      write:async()=>assert.fail('Recovery cannot dispatch a domain write')},
    coordinator:f.coordinator,clock:Date.now,guard:()=>{},alive:()=>true,
    authorize:(_session,project)=>assert.equal(project,'project-d'),grantId:()=>digest,
    captureSubject:async()=>assert.fail('No new write during recovery'),
    verifySubject:async()=>assert.fail('No new write during recovery'),
    collectRecovery:async()=>{
      const result=await collectOriginalTargets(f.coordinator,{includeCoverage:true,guard:()=>{},authorize:()=>{},
        inspect:async subject=>{read.push(subject.kind);return observation(subject);},librarySchema:async()=>3});
      return {digest:result.digest,librarySchema:result.librarySchema};
    },onConfirmed:()=>assert.fail('Recovery must not confirm a historical write'),onReconciled:()=>{}
  });
  const preview=await service.recoveryPreview(session,'project-d',{activationHandle:null});
  assert.equal(preview.priorOutcome,'unknown');assert.equal(read.length,5);
  const result=await service.acknowledgeRecovery(session,'project-d',{previewId:preview.id});
  assert.deepEqual(result,{reconciled:true,priorOutcome:'unknown',freshReviewRequired:true});
  assert.equal(read.length,10);assert.equal(read.filter(kind=>kind==='physical_hierarchy').length,4);
  assert.equal(f.ackCalls(),1);assert.equal(f.coordinator.snapshot().recoveryRequired,false);
});

test('physical summaries are exact, family-specific and preserve legacy revision bounds',async()=>{
  const entries=entriesFor([['physical_hierarchy','physical-hierarchy-commit','project-c']]);
  const coordinator={snapshot:()=>({epoch:7}),recovery:()=>({
    coverage:'complete',generation:1,digest,subjects:entries})};
  const good={projectId:'project-c',projectRevision:1};
  for(const result of [{}, {hierarchySummary:good}, {summary:{...good,profileRevision:0,clients:[]}},
    {physicalHierarchySummary:{...good,projectId:'other'}}, {physicalHierarchySummary:{...good,privatePath:'hidden'}},
    {physicalHierarchySummary:{...good,projectRevision:0}},
    {physicalHierarchySummary:{...good,projectRevision:Number.MAX_SAFE_INTEGER}},
    {physicalHierarchySummary:good,hierarchySummary:good}]) {
    await assert.rejects(collectOriginalTargets(coordinator,{includeCoverage:true,guard:()=>{},authorize:()=>{},
      inspect:async()=>({digest,...result})}),code('OWNER_UNAVAILABLE'));
  }
  const ok=await collectOriginalTargets(coordinator,{includeCoverage:true,guard:()=>{},authorize:()=>{},
    inspect:async()=>({digest,physicalHierarchySummary:good})});
  assert.deepEqual(ok.physicalHierarchyItems,[good]);
  assert.deepEqual(ok.items,[]);assert.deepEqual(ok.hierarchyItems,[]);
});

test('physical collection rejects generation drift and never widens generic target canonicalization',async()=>{
  const entries=entriesFor();let generation=1;
  const coordinator={snapshot:()=>({epoch:7}),recovery:()=>({coverage:'complete',generation,digest,subjects:entries})};
  await assert.rejects(collectOriginalTargets(coordinator,{includeCoverage:true,guard:()=>{},authorize:()=>{},
    inspect:async s=>{generation++;return observation(s);}}),code('CONFIG_CHANGED'));
  const fullState={assets:Array.from({length:300},(_,i)=>({id:'asset-'+i}))};
  assert.equal(typeof hash(recoveryValueKey(fullState)),'string');
  assert.throws(()=>canonicalRecoveryJson(fullState),e=>e instanceof ApiError);
});
