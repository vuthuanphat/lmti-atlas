import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { WriteCoordinator } from '../dist/write-coordinator.js';
import { checkedRecoveryEntries, checkedRecoverySubject, recoveryDigest } from '../dist/recovery-subject.js';
import { collectOriginalTargets } from '../dist/recovery-collection.js';
import { ApiError } from '../dist/security.js';

const sha=s=>createHash('sha256').update(s).digest('hex');
const subject=project=>checkedRecoverySubject({version:1,kind:'legacy',action:'profile_save',
  projectId:project,grantId:sha('test-domain'),target:{project,original:sha(project)}});
const code=value=>e=>e instanceof ApiError&&e.code===value;
async function fixture(t) {
  const path=await mkdtemp(join(tmpdir(),'lmti-recovery-collection-'));
  const coordinator=await WriteCoordinator.create(join(path,'library.sqlite'),undefined,undefined,{domainId:sha('test-domain')});
  t.after(async()=>{
    await coordinator.close();
    assert.ok(resolve(path).startsWith(resolve(tmpdir())+sep));
    await rm(path,{recursive:true,force:true});
  });
  return coordinator;
}

test('full union is inspected across projects and one acknowledgment clears only that exact token',async t=>{
  const coordinator=await fixture(t),a=coordinator.acquire('shared','project-a',coordinator.snapshot().epoch,subject('project-a')),
    b=coordinator.acquire('shared','project-b',coordinator.snapshot().epoch,subject('project-b'));
  await a.beforeStart();await b.beforeStart();a.release('unknown');b.release('unknown');
  await coordinator.waitForIdle();
  const inspected=[],options={guard:()=>{},authorize:()=>{},inspect:async s=>{
    inspected.push(s.projectId);return {digest:sha(s.projectId)};
  }};
  const token=coordinator.beginReconciliation(),first=await collectOriginalTargets(coordinator,options),
    second=await collectOriginalTargets(coordinator,options);
  assert.equal(first.digest,second.digest);
  assert.deepEqual(inspected.slice(0,2).sort(),['project-a','project-b']);
  assert.deepEqual(inspected.slice(2).sort(),['project-a','project-b']);
  await coordinator.acknowledge(token);
  assert.equal(coordinator.snapshot().recoveryRequired,false);
  await assert.rejects(coordinator.acknowledge(token));
});

test('revoked authority anywhere in the full set refuses before any target observation',async t=>{
  const coordinator=await fixture(t),a=coordinator.acquire('shared','project-a',coordinator.snapshot().epoch,subject('project-a')),
    b=coordinator.acquire('shared','project-b',coordinator.snapshot().epoch,subject('project-b'));
  await a.beforeStart();await b.beforeStart();a.release('unknown');b.release('unknown');
  await coordinator.waitForIdle();let reads=0;
  await assert.rejects(collectOriginalTargets(coordinator,{
    guard:()=>{},authorize:s=>{if(s.projectId==='project-b')throw new ApiError('SCOPE_DENIED');},
    inspect:async()=>{reads++;return {digest:sha('unused')};}
  }),code('SCOPE_DENIED'));
  assert.equal(reads,0);assert.equal(coordinator.snapshot().recoveryRequired,true);
});

test('unknown compatibility lease has missing provenance and cannot masquerade as empty recovery',async t=>{
  const coordinator=await fixture(t),lease=coordinator.acquire('shared','project-a',coordinator.snapshot().epoch);
  lease.release('unknown');await coordinator.waitForIdle();let reads=0;
  await assert.rejects(collectOriginalTargets(coordinator,{guard:()=>{},authorize:()=>{},
    inspect:async()=>{reads++;return {digest:sha('unused')};}}),code('RECOVERY_REQUIRED'));
  assert.equal(reads,0);
});

test('generation or authority change during observation prevents an equal-looking subset proof',async()=>{
  const entry={id:'00000000-0000-4000-8000-000000000001',subject:subject('project-a')};
  let generation=1,revoked=false;
  const coordinator={snapshot:()=>({epoch:1}),recovery:()=>({coverage:'complete',generation,digest:sha('entries'),subjects:[entry]})};
  const options={guard:()=>{},authorize:()=>{if(revoked)throw new ApiError('SCOPE_DENIED');},
    inspect:async()=>{generation++;return {digest:sha('state')};}};
  await assert.rejects(collectOriginalTargets(coordinator,options),code('CONFIG_CHANGED'));
  options.inspect=async()=>{revoked=true;return {digest:sha('state')};};
  await assert.rejects(collectOriginalTargets(coordinator,options),code('SCOPE_DENIED'));
});

test('complete empty v2 state may be reviewed while missing empty state remains refused',async()=>{
  let coverage='complete',libraryReads=0;
  const coordinator={snapshot:()=>({epoch:2}),recovery:()=>({coverage,generation:4,digest:sha('[]'),subjects:[]})};
  const options={guard:()=>{},authorize:()=>{},inspect:async()=>{throw new Error('no subjects');},
    librarySchema:async()=>{libraryReads++;return 3;}};
  const result=await collectOriginalTargets(coordinator,options);
  assert.deepEqual(result.items,[]);assert.equal(result.librarySchema,3);assert.equal(libraryReads,1);
  coverage='missing';await assert.rejects(collectOriginalTargets(coordinator,options),code('RECOVERY_REQUIRED'));
  assert.equal(libraryReads,1);
});

test('mixed hierarchy and legacy union retains separate complete summaries without inventing a profile revision',async t=>{
  const coordinator=await fixture(t),legacy=subject('project-a');
  const hierarchy=checkedRecoverySubject({version:1,kind:'logical_hierarchy',action:'logical-hierarchy-commit',
    projectId:'project-b',grantId:sha('hierarchy-grant'),target:{original:'controlled-hierarchy-target'}});
  const a=coordinator.acquire('shared','project-a',coordinator.snapshot().epoch,legacy),
    b=coordinator.acquire('shared','project-b',coordinator.snapshot().epoch,hierarchy);
  await a.beforeStart();await b.beforeStart();a.release('unknown');b.release('unknown');await coordinator.waitForIdle();
  const authorizations=[],reads=[],options={guard:()=>{},authorize:s=>{authorizations.push(s.kind);},
    inspect:async s=>{
      assert.ok(authorizations.includes('legacy')&&authorizations.includes('logical_hierarchy'));
      reads.push(s.kind);
      return s.kind==='legacy'?{digest:sha('legacy'),summary:{projectId:s.projectId,projectRevision:2,profileRevision:3,clients:[]}}:
        {digest:sha('hierarchy'),hierarchySummary:{projectId:s.projectId,projectRevision:4}};
    }};
  const token=coordinator.beginReconciliation(),first=await collectOriginalTargets(coordinator,options),
    second=await collectOriginalTargets(coordinator,options);
  assert.deepEqual(first.items,[{projectId:'project-a',projectRevision:2,profileRevision:3,clients:[]}]);
  assert.deepEqual(first.hierarchyItems,[{projectId:'project-b',projectRevision:4}]);
  assert.equal(first.digest,second.digest);assert.equal(reads.length,4);
  assert.equal(coordinator.snapshot().recoveryRequired,true);
  await coordinator.acknowledge(token);assert.equal(coordinator.snapshot().recoveryRequired,false);
});

test('revoked hierarchy authority fences an entire mixed recovery union before any owner read',async t=>{
  const coordinator=await fixture(t),a=coordinator.acquire('shared','project-a',coordinator.snapshot().epoch,subject('project-a'));
  const hierarchy=checkedRecoverySubject({version:1,kind:'logical_hierarchy',action:'logical-hierarchy-commit',
    projectId:'project-b',grantId:sha('old-grant'),target:{original:'controlled-hierarchy-target'}});
  const b=coordinator.acquire('shared','project-b',coordinator.snapshot().epoch,hierarchy);
  await a.beforeStart();await b.beforeStart();a.release('unknown');b.release('unknown');await coordinator.waitForIdle();
  let reads=0;
  await assert.rejects(collectOriginalTargets(coordinator,{guard:()=>{},
    authorize:s=>{if(s.kind==='logical_hierarchy')throw new ApiError('SCOPE_DENIED');},
    inspect:async()=>{reads++;return {digest:sha('unused')};}}),code('SCOPE_DENIED'));
  assert.equal(reads,0);assert.equal(coordinator.snapshot().recoveryRequired,true);
});

// Typed immutable coordinator snapshots isolate public projection from native
// storage. Actual mixed-route/native behavior is covered by the HTTP suite.
function coverageFixture(specs) {
  const entries=checkedRecoveryEntries(specs.map(([kind,action,projectId],index)=>({
    id:'00000000-0000-4000-8000-'+String(index+1).padStart(12,'0'),
    subject:{version:1,kind,action,projectId,grantId:sha('private-grant'),
      target:{original:'private-target-'+index}}
  })));
  const snapshot={coverage:'complete',generation:5,digest:recoveryDigest(entries),subjects:entries};
  const coordinator={snapshot:()=>({epoch:7}),recovery:()=>Object.freeze({...snapshot})};
  let reads=0,libraryReads=0;
  const options={includeCoverage:true,guard:()=>{},authorize:()=>{},inspect:async s=>{
    reads++;
    if(s.kind==='legacy')return {digest:sha(s.target.original),summary:{
      projectId:s.projectId,projectRevision:reads,profileRevision:0,clients:[]}};
    if(s.kind==='logical_hierarchy')return {digest:sha(s.target.original),
      hierarchySummary:{projectId:s.projectId,projectRevision:reads}};
    return {digest:sha(s.target.original)};
  },librarySchema:async()=>{libraryReads++;return 3;}};
  return {entries,snapshot,coordinator,options,counts:()=>({reads,libraryReads})};
}

test('opt-in coverage includes every finite action across all families and retains repeated project observations',async()=>{
  const specs=[
    ...['profile_save','desired_proposal','client_apply','client_restore'].map(action=>['legacy',action,'project-a']),
    ['logical_hierarchy','logical-hierarchy-commit','project-a'],
    ...['copy-prepare','activation-prepare','activation-activate','activation-abandon']
      .map(action=>['project_operations',action,'project-b']),
    ...['library-upgrade-v1','library-upgrade-v2'].map(action=>['project_operations',action,null]),
    ['legacy','profile_save','project-a'],['logical_hierarchy','logical-hierarchy-commit','project-a']
  ];
  const f=coverageFixture(specs),authorized=new Set();
  f.options.authorize=s=>authorized.add(s.target.original);
  const inspect=f.options.inspect;
  f.options.inspect=async s=>{assert.equal(authorized.size,specs.length);return inspect(s);};
  const result=await collectOriginalTargets(f.coordinator,f.options);
  assert.deepEqual(f.counts(),{reads:13,libraryReads:1});
  assert.equal(result.coverage.retainedSubjects,13);
  assert.equal(result.coverage.affectedScopes.length,11);
  assert.equal(result.coverage.affectedScopes.reduce((sum,row)=>sum+row.subjects,0),13);
  assert.equal(result.coverage.librarySchema,3);
  assert.equal(result.coverage.affectedScopes.find(row=>row.action==='profile_save').subjects,2);
  assert.equal(result.coverage.affectedScopes.find(row=>row.kind==='logical_hierarchy').subjects,2);
  assert.deepEqual(result.items.map(row=>row.projectId),Array(5).fill('project-a'));
  assert.deepEqual(result.hierarchyItems.map(row=>row.projectId),Array(2).fill('project-a'));
  assert.equal(new Set(result.items.map(row=>row.projectRevision)).size,5);
  assert.equal(new Set(result.hierarchyItems.map(row=>row.projectRevision)).size,2);
  const keys=result.coverage.affectedScopes.map(row=>JSON.stringify([row.kind,row.action,row.projectId]));
  assert.deepEqual(keys,[...keys].sort());
  for(const row of result.coverage.affectedScopes) {
    assert.deepEqual(Object.keys(row).sort(),['action','kind','projectId','subjects']);
    assert.equal(row.projectId===null,row.action.startsWith('library-upgrade-'));
  }
  const publicText=JSON.stringify({items:result.items,hierarchyItems:result.hierarchyItems,coverage:result.coverage});
  for(const secret of ['private-target','private-grant',f.entries[0].id,sha('private-grant'),'grantId','digest'])
    assert.equal(publicText.includes(secret),false);
});

test('coverage opt-in adds no owner reads and preserves the exact existing evidence digest',async()=>{
  const f=coverageFixture([['legacy','profile_save','project-a'],['logical_hierarchy','logical-hierarchy-commit','project-b']]);
  let reads=0;
  f.options.inspect=async s=>{
    reads++;
    return s.kind==='legacy'?
      {digest:sha('fixed-legacy'),summary:{projectId:s.projectId,projectRevision:2,profileRevision:0,clients:[]}}:
      {digest:sha('fixed-hierarchy'),hierarchySummary:{projectId:s.projectId,projectRevision:3}};
  };
  const old=await collectOriginalTargets(f.coordinator,{...f.options,includeCoverage:false});
  assert.equal(reads,2);
  const projected=await collectOriginalTargets(f.coordinator,f.options);
  assert.equal(reads,4);
  assert.equal(Object.hasOwn(old,'coverage'),false);
  assert.equal(projected.digest,old.digest);
  assert.deepEqual(projected.items,old.items);assert.deepEqual(projected.hierarchyItems,old.hierarchyItems);
  assert.deepEqual(f.counts(),{reads:0,libraryReads:2});
});

test('coverage complete-empty is explicit and does not infer a library schema or missing provenance',async()=>{
  const f=coverageFixture([]);delete f.options.librarySchema;
  const result=await collectOriginalTargets(f.coordinator,f.options);
  assert.deepEqual(result.coverage,{retainedSubjects:0,affectedScopes:[],librarySchema:null});
  assert.deepEqual(f.counts(),{reads:0,libraryReads:0});
  f.snapshot.coverage='missing';
  await assert.rejects(collectOriginalTargets(f.coordinator,f.options),code('RECOVERY_REQUIRED'));
});

test('mixed coverage cannot reveal a subset when any family is revoked or evidence becomes stale',async()=>{
  const specs=[['legacy','profile_save','project-a'],['logical_hierarchy','logical-hierarchy-commit','project-b'],
    ['project_operations','activation-abandon','project-c']];
  for(const kind of ['legacy','logical_hierarchy','project_operations']) {
    const f=coverageFixture(specs);
    f.options.authorize=s=>{if(s.kind===kind)throw new ApiError('SCOPE_DENIED');};
    await assert.rejects(collectOriginalTargets(f.coordinator,f.options),code('SCOPE_DENIED'));
    assert.deepEqual(f.counts(),{reads:0,libraryReads:0});
  }
  const f=coverageFixture(specs),inspect=f.options.inspect,captured=f.coordinator.recovery();
  assert.equal(Object.isFrozen(captured),true);
  f.options.inspect=async s=>{const value=await inspect(s);f.snapshot.generation++;return value;};
  await assert.rejects(collectOriginalTargets(f.coordinator,f.options),code('CONFIG_CHANGED'));
  assert.equal(captured.generation,5);
  assert.equal(f.coordinator.recovery().generation,8);
  const g=coverageFixture(specs);let revoked=false;
  g.options.authorize=()=>{if(revoked)throw new ApiError('SCOPE_DENIED');};
  g.options.librarySchema=async()=>{revoked=true;return 3;};
  await assert.rejects(collectOriginalTargets(g.coordinator,g.options),code('SCOPE_DENIED'));
});

test('opt-in coverage refuses oversized or malformed retained unions before observations',async()=>{
  const f=coverageFixture([['legacy','profile_save','project-a']]);
  f.snapshot.subjects=Array.from({length:33},(_,index)=>({
    id:'00000000-0000-4000-8000-'+String(index+1).padStart(12,'0'),subject:f.entries[0].subject}));
  await assert.rejects(collectOriginalTargets(f.coordinator,f.options),code('LIMIT_EXCEEDED'));
  for(const invalid of [
    {kind:'legacy',action:'activation-abandon',projectId:'project-a'},
    {kind:'logical_hierarchy',action:'logical-hierarchy-commit',projectId:null},
    {kind:'project_operations',action:'library-upgrade-v2',projectId:'project-a'},
    {kind:'project_operations',action:'copy-prepare',projectId:null}
  ]) {
    f.snapshot.subjects=[{id:f.entries[0].id,subject:{...f.entries[0].subject,...invalid}}];
    await assert.rejects(collectOriginalTargets(f.coordinator,f.options),code('INVALID_INPUT'));
  }
  assert.deepEqual(f.counts(),{reads:0,libraryReads:0});
});

test('coverage requires one exact family-appropriate summary and refuses hidden private fields',async t=>{
  const legacy={projectId:'project-a',projectRevision:1,profileRevision:0,clients:[]};
  const hierarchy={projectId:'project-a',projectRevision:1};
  for(const [name,kind,action,result] of [
    ['missing legacy','legacy','profile_save',{}],
    ['missing hierarchy','logical_hierarchy','logical-hierarchy-commit',{}],
    ['fabricated operation detail','project_operations','copy-prepare',{summary:legacy}],
    ['wrong project','logical_hierarchy','logical-hierarchy-commit',{hierarchySummary:{...hierarchy,projectId:'project-b'}}],
    ['private detail','legacy','profile_save',{summary:{...legacy,physical:'private-target'}}],
    ['both families','legacy','profile_save',{summary:legacy,hierarchySummary:hierarchy}],
    ['duplicate client','legacy','client_apply',{summary:{...legacy,clients:Array(2).fill({client:'codex',state:'configured'})}}],
    ['coerced client state','legacy','client_restore',{summary:{...legacy,clients:[{client:'cursor',state:['configured']}]}}],
    ['invalid revision','logical_hierarchy','logical-hierarchy-commit',{hierarchySummary:{...hierarchy,projectRevision:0}}]
  ])await t.test(name,async()=>{
    const f=coverageFixture([[kind,action,'project-a']]);
    f.options.inspect=async()=>({digest:sha('observed'),...result});
    await assert.rejects(collectOriginalTargets(f.coordinator,f.options),code('OWNER_UNAVAILABLE'));
  });
});
