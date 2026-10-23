import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import test from 'node:test';

const uiRoot=process.env.LMTI_OPERATIONS_TEST_UI_ROOT??fileURLToPath(new URL('../',import.meta.url));
const app=createRequire(join(uiRoot,'package.json'));
const {build}=createRequire(app.resolve('vite'))('esbuild');
const bundle=await build({
  entryPoints:[fileURLToPath(new URL('../src/ProjectOperationsPanel.tsx',import.meta.url))],
  bundle:true,write:false,format:'cjs',platform:'node',jsx:'automatic',external:['react','react/*'],
  loader:{'.css':'empty','.png':'dataurl'},
});
const module={exports:{}};
new Function('require','module','exports',bundle.outputFiles[0].text)(app,module,module.exports);
const ui=module.exports,React=app('react'),{renderToStaticMarkup}=app('react-dom/server');
test('review focus reaches a visible target but never steals focus from a dialog or inactive workspace',()=>{
  let calls=0;
  const target={isConnected:true,getClientRects:()=>[{}],closest:()=>null,matches:()=>false,ownerDocument:{querySelector:()=>null},focus:()=>calls++};
  assert.equal(ui.focusOperationTarget(target),true);
  assert.equal(calls,1);
  const blocked=[null,{...target,isConnected:false},{...target,getClientRects:()=>[]},{...target,closest:()=>({})},{...target,matches:()=>true},{...target,ownerDocument:{querySelector:()=>({})}}];
  for(const value of blocked)assert.equal(ui.focusOperationTarget(value),false);
  assert.equal(calls,1);
});
const id='A'.repeat(43),handle='B'.repeat(43),project='factory-monitor';
const expiresAt='2099-10-20T00:00:00.000Z';
const bad=fn=>assert.throws(fn,{code:'INVALID_SOURCE_RESPONSE'});
const copyReview=(mode='migrate_v1')=>({kind:'copy',mode,sourceSchema:mode==='migrate_v1'?1:2,
  sourceRevision:7,targetSchema:2,targetRevision:8,seedsInternalSites:mode==='migrate_v1'});
const preview=(action='copy-prepare',review=copyReview(),projectId=project)=>({id,projectId,action,expiresAt,review});
const result=(action='copy-prepare',overrides={})=>({operationId:id,action,outcome:'confirmed',code:null,
  recoveryHandle:handle,summary:{kind:'copy',state:'prepared',sourceRevision:7,targetRevision:8,seedsInternalSites:true},...overrides});
const projectStatus={projectId:project,projectSchema:1,projectRevision:7,librarySchema:3,
  capabilities:{copyModes:['migrate_v1'],activation:true},recoveryRequired:false};
const view={handle,kind:'activation',projectId:project,state:'prepared',condition:'prepared_current',mode:'migrate_v1',
  sourceRevision:7,targetRevision:8,receiptRevision:1,canPrepare:false,canActivate:true,canAbandon:true};

test('public status accepts scoped metadata and refuses private fields, enum coercion and capability widening',()=>{
  assert.deepEqual(ui.checkedOperationScopes({projectIds:[project],allowLibraryUpgrade:true}),{projectIds:[project],allowLibraryUpgrade:true});
  ui.checkedOperationStatus(projectStatus,project);
  ui.checkedOperationStatus({librarySchema:3,canUpgrade:false,recoveryRequired:true},null);
  bad(()=>ui.checkedOperationScopes({projectIds:[project,project],allowLibraryUpgrade:true}));
  bad(()=>ui.checkedOperationStatus(projectStatus,'another-project'));
  bad(()=>ui.checkedOperationStatus({...projectStatus,libraryIdentity:{uuid:'private'}},project));
  bad(()=>ui.checkedOperationStatus({...projectStatus,projectSchema:[1]},project));
  bad(()=>ui.checkedOperationStatus({...projectStatus,capabilities:{copyModes:['clone_v2'],activation:true}},project));
  bad(()=>ui.checkedOperationStatus({librarySchema:3,canUpgrade:true,recoveryRequired:false},null));
});
test('write status requires explicit bounded live-write count and actual boolean values',()=>{
  const status={admitted:true,recoveryRequired:true,projectOperations:true,activeWrites:1};
  assert.deepEqual(ui.checkedWriteStatus(status),status);
  for(const activeWrites of [-1,33,0.5,'0',null])bad(()=>ui.checkedWriteStatus({...status,activeWrites}));
  bad(()=>ui.checkedWriteStatus({admitted:true,recoveryRequired:true,projectOperations:true}));
  bad(()=>ui.checkedWriteStatus({...status,admitted:['true']}));
});
test('operation scope can select a granted removed project while a live or unknown pin cannot retarget',()=>{
  const scopes=ui.checkedOperationScopes({projectIds:[project,'removed-project'],allowLibraryUpgrade:true});
  assert.equal(ui.operationSelection('', 'removed-project',scopes,false,false),'removed-project');
  assert.equal(ui.operationSelection(project,'removed-project',scopes,false,false),'removed-project');
  assert.equal(ui.operationSelection(project,'removed-project',scopes,true,false),project);
  assert.equal(ui.operationSelection('removed-project',project,scopes,false,true),'removed-project');
  bad(()=>ui.operationSelection(project,'not-granted',scopes,false,false));
  bad(()=>ui.operationSelection(project,'C:\\private\\project.sqlite',scopes,false,false));
});
test('all six previews bind project, action, schema and immutable transition semantics',()=>{
  for(const mode of ['migrate_v1','clone_v2'])ui.checkedOperationPreview(preview('copy-prepare',copyReview(mode)),project,'copy-prepare');
  for(const decision of ['prepare','activate','abandon']){
    const action='activation-'+decision,review={kind:'activation',decision,mode:'clone_v2',sourceRevision:7,targetRevision:8,
      receiptRevision:decision==='prepare'?null:1,preservesSource:true,preservesLinkedRoot:true};
    ui.checkedOperationPreview(preview(action,review),project,action);
    bad(()=>ui.checkedOperationPreview(preview(action,{...review,preservesLinkedRoot:false}),project,action));
  }
  for(const fromSchema of [1,2]){
    const action='library-upgrade-v'+fromSchema;
    ui.checkedOperationPreview(preview(action,{kind:'library_upgrade',fromSchema,toSchema:fromSchema+1,scope:'library',backupRetained:true},null),null,action);
  }
  bad(()=>ui.checkedOperationPreview(preview(),null,'copy-prepare'));
  bad(()=>ui.checkedOperationPreview(preview(),project,'activation-activate'));
  bad(()=>ui.checkedOperationPreview(preview('copy-prepare',{...copyReview(),targetRevision:7}),project,'copy-prepare'));
  bad(()=>ui.checkedOperationPreview(preview('copy-prepare',{...copyReview(),seedsInternalSites:false}),project,'copy-prepare'));
  bad(()=>ui.checkedOperationPreview({...preview(),id:'native-uuid'},project,'copy-prepare'));
  bad(()=>ui.checkedOperationPreview({...preview(),database:'private path'},project,'copy-prepare'));
});
test('confirmed details-unavailable remains confirmed and is not confused with pending or unknown',()=>{
  const fallback=result('copy-prepare',{summary:null,recoveryHandle:null,code:'OWNER_UNAVAILABLE'});
  assert.equal(ui.checkedOperationResult(fallback,'copy-prepare').outcome,'confirmed');
  const pending=result('copy-prepare',{outcome:'pending',summary:null,recoveryHandle:null});
  ui.checkedOperationResult(pending,'copy-prepare');
  const unknown=result('copy-prepare',{outcome:'unknown',summary:null,code:'RECOVERY_REQUIRED'});
  assert.equal(ui.checkedOperationResult(unknown,'copy-prepare').outcome,'unknown');
  bad(()=>ui.checkedOperationResult({...pending,summary:result().summary},'copy-prepare'));
  bad(()=>ui.checkedOperationResult({...unknown,code:null},'copy-prepare'));
  bad(()=>ui.checkedOperationResult({...unknown,code:['RECOVERY_REQUIRED']},'copy-prepare'));
  bad(()=>ui.checkedOperationResult({...fallback,outcome:['confirmed']},'copy-prepare'));
  bad(()=>ui.checkedOperationResult(result(),'activation-prepare'));
  bad(()=>ui.checkedOperationResult(result(),'copy-prepare','C'.repeat(43)));
});
test('terminal jobs correlate original operation and distinguish failed, unknown and confirmed replies',()=>{
  const known=result(),unknown=result('copy-prepare',{outcome:'unknown',summary:null,code:'RECOVERY_REQUIRED'}),
    refused=result('copy-prepare',{outcome:'refused',summary:null,recoveryHandle:null,code:'CONFIG_CHANGED'});
  for(const [state,r,errorCode] of [['succeeded',known,null],['unknown',unknown,null],['failed',refused,'CONFIG_CHANGED']])
    ui.checkedOperationJob({operationId:id,state,result:r,errorCode},id,'copy-prepare');
  ui.checkedOperationJob({operationId:id,state:'pending',result:null,errorCode:null},id,'copy-prepare');
  bad(()=>ui.checkedOperationJob({operationId:id,state:'failed',result:unknown,errorCode:'RECOVERY_REQUIRED'},id,'copy-prepare'));
  bad(()=>ui.checkedOperationJob({operationId:id,state:'succeeded',result:known,errorCode:null},handle,'copy-prepare'));
  bad(()=>ui.checkedOperationJob({operationId:id,state:'pending',result:known,errorCode:null},id,'copy-prepare'));
});
test('recovery pages expose opaque handles only and inspection does not invent activation authority',()=>{
  ui.checkedOperationPage({items:[{handle,kind:'copy',state:'uninspected',revision:null}],nextCursor:id},'copy');
  ui.checkedOperationPage({items:[{handle,kind:'activation',state:'prepared',revision:1}],nextCursor:null},'activation');
  const item={handle,kind:'activation',state:'prepared',revision:1};
  bad(()=>ui.checkedOperationPage({items:[item,item],nextCursor:null},'activation'));
  bad(()=>ui.checkedOperationPage({items:[{...item,sourcePath:'private'}],nextCursor:null},'activation'));
  ui.checkedOperationRecovery(view,project,handle);
  ui.checkedOperationRecovery({...view,condition:'unavailable',canActivate:false},project,handle);
  bad(()=>ui.checkedOperationRecovery({...view,condition:'prepared_stale'},project,handle));
  bad(()=>ui.checkedOperationRecovery(view,'other',handle));
  bad(()=>ui.checkedOperationRecovery({...view,state:'activated',receiptRevision:2},project,handle));
  const copy={...view,kind:'copy',state:'recovery_required',condition:null,mode:null,sourceRevision:null,targetRevision:null,receiptRevision:null,canPrepare:false,canActivate:false,canAbandon:false};
  ui.checkedOperationRecovery(copy,project,handle);
  bad(()=>ui.checkedOperationRecovery({...copy,canPrepare:true},project,handle));
});
test('reconciliation requires a new explicit acknowledgment and keeps historical unknown semantics',()=>{
  const review={id,projectId:project,expiresAt,scope:'activation',priorOutcome:'unknown',freshReviewRequired:true,librarySchema:3};
  ui.checkedOperationRecoveryPreview(review,project);
  ui.checkedOperationRecoveryPreview({...review,projectId:null,scope:'library'},null);
  bad(()=>ui.checkedOperationRecoveryPreview({...review,priorOutcome:'confirmed'},project));
  bad(()=>ui.checkedOperationRecoveryPreview({...review,freshReviewRequired:false},project));
  bad(()=>ui.checkedOperationRecoveryPreview(review,'other'));
  ui.checkedOperationAcknowledgment({reconciled:true,priorOutcome:'unknown',freshReviewRequired:true});
  bad(()=>ui.checkedOperationAcknowledgment({reconciled:true,priorOutcome:'confirmed',freshReviewRequired:true}));
  bad(()=>ui.checkedOperationAcknowledgment({reconciled:true,priorOutcome:'unknown',freshReviewRequired:true,operationId:id}));
});
test('legacy recovery supports safe settings evidence without new project-operation capability',()=>{
  const legacy={id,expiresAt,priorOutcome:'unknown',items:[{projectId:project,projectRevision:7,profileRevision:2,clients:[{client:'codex',state:'configured'}]}]};
  ui.checkedOperationRecoveryPreview(legacy,null,true);
  ui.checkedOperationAcknowledgment({reviewed:true,priorOutcome:'unknown',freshReviewRequired:true},true);
  bad(()=>ui.checkedOperationRecoveryPreview({...legacy,items:[{...legacy.items[0],root:'private'}]},null,true));
  bad(()=>ui.checkedOperationRecoveryPreview({...legacy,items:[{...legacy.items[0],clients:[{client:'codex',state:['configured']}]}]},null,true));
});
test('initial EN/VI and maintenance-only renders show inspection without write authority or path input',()=>{
  for(const [language,title] of [['en','Project copies &amp; recovery'],['vi','Bản sao dự án &amp; phục hồi']]){
    const html=renderToStaticMarkup(React.createElement(ui.ProjectOperationsPanel,{
      project:'',language,onLockChange:()=>assert.fail('render must not acquire a lease'),onChanged:()=>assert.fail('render must not mutate'),
    }));
    assert.ok(html.includes(title));assert.ok(html.includes('<section'));
    assert.ok(!html.includes('<input'));assert.ok(!html.includes('Confirm this operation'));
    assert.ok(!html.includes('Xác nhận thao tác này'));assert.ok(!html.includes('C:\\'));
  }
});

// Common recovery is a complete current-scope review, never a receipt claiming
// that any historical unknown write committed. These are DTO/SSR tests; they do
// not simulate a browser, component effects, network responses or owner writes.
const coverage=(affectedScopes=[],librarySchema=null)=>({
  retainedSubjects:affectedScopes.reduce((sum,row)=>sum+row.subjects,0),
  affectedScopes,librarySchema,
});
const scope=(kind,action,projectId=project,subjects=1)=>({kind,action,projectId,subjects});
const legacyItem=(projectId=project,projectRevision=7)=>({
  projectId,projectRevision,profileRevision:2,clients:[{client:'codex',state:'configured'}],
});
const common=(overrides={})=>({
  id,expiresAt,priorOutcome:'unknown',items:[],hierarchyItems:[],coverage:coverage(),...overrides,
});
const checkedCommon=value=>ui.checkedOperationRecoveryPreview(value,null,true,true);

test('complete recovery distinguishes explicitly empty coverage from absent or partial display data',()=>{
  const empty=common();
  assert.deepEqual(checkedCommon(empty),empty);
  const old={id,expiresAt,priorOutcome:'unknown',items:[]};
  assert.deepEqual(ui.checkedOperationRecoveryPreview(old,null,true),old);
  const oldZero={...old,items:[legacyItem(project,0)]};
  assert.equal(ui.checkedOperationRecoveryPreview(oldZero,null,true).items[0].projectRevision,0);
  bad(()=>checkedCommon(old));
  bad(()=>checkedCommon({...old,hierarchyItems:[]}));
  bad(()=>checkedCommon({...old,coverage:coverage()}));
  bad(()=>ui.checkedOperationRecoveryPreview({...old,hierarchyItems:[]},null,true));
  bad(()=>checkedCommon({...empty,coverage:null}));
  bad(()=>checkedCommon({...empty,priorOutcome:'confirmed'}));
});

test('coverage accepts the exact finite family/action combinations including maintenance without a project',()=>{
  const families={
    legacy:['profile_save','desired_proposal','client_apply','client_restore'],
    logical_hierarchy:['logical-hierarchy-commit'],
    physical_hierarchy:['physical-hierarchy-commit'],
    project_operations:['copy-prepare','activation-prepare','activation-activate','activation-abandon',
      'library-upgrade-v1','library-upgrade-v2'],
  };
  for(const [kind,actions] of Object.entries(families))for(const action of actions){
    const maintenance=action.startsWith('library-upgrade-'),row=scope(kind,action,maintenance?null:project);
    assert.deepEqual(ui.checkedRecoveryCoverage(coverage([row],3)),coverage([row],3));
    bad(()=>ui.checkedRecoveryCoverage(coverage([{...row,projectId:maintenance?project:null}],3)));
  }
  for(const row of [
    scope('legacy','logical-hierarchy-commit'),scope('logical_hierarchy','profile_save'),
    scope('physical_hierarchy','logical-hierarchy-commit'),scope('logical_hierarchy','physical-hierarchy-commit'),
    scope('project_operations','client_apply'),scope('other','copy-prepare'),
    scope('legacy',['profile_save']),scope(['legacy'],'profile_save'),
    scope('project_operations','copy-prepare','C:\\private\\source.sqlite'),
  ])bad(()=>ui.checkedRecoveryCoverage(coverage([row],3)));
});

test('coverage checks whole retained-record counts, unique groups and exact bounded public fields',()=>{
  const row=scope('logical_hierarchy','logical-hierarchy-commit',project,2),valid=coverage([row],null);
  assert.equal(ui.checkedRecoveryCoverage(valid).retainedSubjects,2);
  for(const count of [-1,33,1.5,'2',null])bad(()=>ui.checkedRecoveryCoverage({...valid,retainedSubjects:count}));
  for(const count of [0,-1,33,1.5,'2',null])bad(()=>ui.checkedRecoveryCoverage({...valid,affectedScopes:[{...row,subjects:count}]}));
  bad(()=>ui.checkedRecoveryCoverage({...valid,retainedSubjects:1}));
  bad(()=>ui.checkedRecoveryCoverage(coverage([row,row])));
  bad(()=>ui.checkedRecoveryCoverage({...valid,librarySchema:0}));
  bad(()=>ui.checkedRecoveryCoverage({...valid,librarySchema:[3]}));
  bad(()=>ui.checkedRecoveryCoverage({...valid,entryIds:[id]}));
  bad(()=>ui.checkedRecoveryCoverage({...valid,affectedScopes:[{...row,target:{path:'private'}}]}));
  const maximum=coverage(Array.from({length:32},(_,i)=>scope('project_operations','copy-prepare','project-'+i)),3);
  assert.equal(ui.checkedRecoveryCoverage(maximum).affectedScopes.length,32);
  bad(()=>ui.checkedRecoveryCoverage(coverage([...maximum.affectedScopes,scope('project_operations','copy-prepare','project-32')],3)));
});

test('hierarchy-only recovery has original project revisions and no fabricated profile state',()=>{
  const value=common({
    hierarchyItems:[{projectId:project,projectRevision:8}],
    coverage:coverage([scope('logical_hierarchy','logical-hierarchy-commit')]),
  });
  const parsed=checkedCommon(value);
  assert.deepEqual(parsed.hierarchyItems,value.hierarchyItems);
  assert.equal(parsed.items.length,0);
  assert.equal('profileRevision' in parsed.hierarchyItems[0],false);
  bad(()=>checkedCommon({...value,hierarchyItems:[{...value.hierarchyItems[0],profileRevision:0}]}));
  bad(()=>checkedCommon({...value,hierarchyItems:[{projectId:'other-project',projectRevision:8}]}));
  bad(()=>checkedCommon({...value,hierarchyItems:[]}));
  bad(()=>checkedCommon({...value,coverage:coverage()}));
  assert.equal(checkedCommon({...value,hierarchyItems:[{
    projectId:project,projectRevision:Number.MAX_SAFE_INTEGER-1,
  }]}).hierarchyItems[0].projectRevision,Number.MAX_SAFE_INTEGER-1);
  for(const revision of [-1,0,1.5,'8',Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER+1,null])
    bad(()=>checkedCommon({...value,hierarchyItems:[{projectId:project,projectRevision:revision}]}));
});

test('same project may retain multiple original targets and no common-recovery row is silently deduplicated',()=>{
  const value=common({
    items:[legacyItem(project,7),legacyItem(project,9)],
    hierarchyItems:[{projectId:project,projectRevision:8},{projectId:project,projectRevision:10}],
    coverage:coverage([
      scope('legacy','profile_save',project,2),
      scope('logical_hierarchy','logical-hierarchy-commit',project,2),
    ]),
  });
  const parsed=checkedCommon(value);
  assert.deepEqual(parsed.items.map(row=>row.projectRevision),[7,9]);
  assert.deepEqual(parsed.hierarchyItems.map(row=>row.projectRevision),[8,10]);
  assert.equal(parsed.coverage.retainedSubjects,4);
  bad(()=>checkedCommon({...value,hierarchyItems:value.hierarchyItems.slice(0,1)}));
  bad(()=>checkedCommon({...value,hierarchyItems:[...value.hierarchyItems,{projectId:project,projectRevision:11}]}));
  bad(()=>checkedCommon({...value,items:value.items.slice(0,1)}));
  for(const projectRevision of [0,Number.MAX_SAFE_INTEGER])
    bad(()=>checkedCommon({...value,items:[{...value.items[0],projectRevision},value.items[1]]}));
  const maximum=checkedCommon({...value,items:[{
    ...value.items[0],projectRevision:Number.MAX_SAFE_INTEGER-1,profileRevision:Number.MAX_SAFE_INTEGER,
  },value.items[1]]});
  assert.equal(maximum.items[0].profileRevision,Number.MAX_SAFE_INTEGER);
});

test('mixed family review retains operation groups even when those subjects have no legacy or hierarchy detail row',()=>{
  const value=common({
    items:[legacyItem()],
    hierarchyItems:[{projectId:project,projectRevision:8}],
    coverage:coverage([
      scope('legacy','client_apply'),scope('logical_hierarchy','logical-hierarchy-commit'),
      scope('project_operations','copy-prepare','removed-project',2),
      scope('project_operations','library-upgrade-v2',null),
    ],3),
  });
  const parsed=checkedCommon(value);
  assert.equal(parsed.coverage.retainedSubjects,5);
  assert.equal(parsed.coverage.affectedScopes.length,4);
  assert.equal(parsed.items.length+parsed.hierarchyItems.length,2);
  bad(()=>checkedCommon({...value,coverage:{...value.coverage,retainedSubjects:2}}));
  bad(()=>checkedCommon({...value,libraryIdentity:{uuid:'private'}}));
  bad(()=>checkedCommon({...value,hierarchyItems:[{...value.hierarchyItems[0],canonicalPath:'private'}]}));
  bad(()=>checkedCommon({...value,items:[{...value.items[0],grantId:'private'}]}));
});

test('bounded complete hierarchy recovery accepts thirty-two targets and refuses a thirty-third row',()=>{
  const hierarchyItems=Array.from({length:32},(_,i)=>({projectId:'project-'+i,projectRevision:i+1}));
  const value=common({hierarchyItems,coverage:coverage(hierarchyItems.map(row=>
    scope('logical_hierarchy','logical-hierarchy-commit',row.projectId)))});
  assert.equal(checkedCommon(value).hierarchyItems.length,32);
  bad(()=>checkedCommon({...value,hierarchyItems:[...hierarchyItems,{projectId:'project-32',projectRevision:32}]}));
});

test('hierarchy availability is explicit and rejects empty, duplicate or widened display capabilities',()=>{
  assert.equal(ui.checkedHierarchyAvailability({projects:[{projectId:project,allowInternal:false}]}),true);
  for(const value of [
    {projects:[]},{projects:[{projectId:project,allowInternal:'false'}]},
    {projects:[{projectId:project,allowInternal:true},{projectId:project,allowInternal:false}]},
    {projects:[{projectId:project,allowInternal:true,root:'private'}]},
    {projects:[{projectId:project,allowInternal:true}],libraryIdentity:{uuid:'private'}},
  ])bad(()=>ui.checkedHierarchyAvailability(value));
});

test('EN/VI common recovery evidence renders all families as observed scope without receipt attribution',()=>{
  const value=checkedCommon(common({
    items:[legacyItem('settings-project',7)],
    hierarchyItems:[{projectId:'hierarchy-project',projectRevision:8}],
    coverage:coverage([
      scope('legacy','client_apply','settings-project'),
      scope('logical_hierarchy','logical-hierarchy-commit','hierarchy-project'),
      scope('project_operations','copy-prepare','removed-project',2),
      scope('project_operations','library-upgrade-v2',null),
    ],3),
  }));
  for(const [language,headings,notice] of [
    ['en',['Complete affected scope','Profile and client observations','Logical hierarchy observations',
      'Observed library format'],'This summary does not attribute a prior result'],
    ['vi',['Toàn bộ phạm vi bị ảnh hưởng','Quan sát hồ sơ và client','Quan sát phân cấp logic',
      'Định dạng thư viện đã quan sát'],'Tóm tắt này không xác định kết quả trước đó'],
  ]){
    const html=renderToStaticMarkup(React.createElement(ui.CommonRecoveryEvidence,{value,language}));
    for(const text of [...headings,'settings-project','hierarchy-project','removed-project','codex',notice])
      assert.ok(html.includes(text),`missing ${language} evidence ${text}`);
    assert.match(html,/r7/);assert.match(html,/r8/);
    assert.ok(!html.includes('<button')&&!html.includes('<input')&&!html.includes('<form'));
    for(const privateField of ['canonicalPath','storeUuid','grantId','proposalDigest','C:\\'])
      assert.ok(!html.includes(privateField));
  }
});

test('same-project target observations remain separate in both rendered languages',()=>{
  const value=checkedCommon(common({
    items:[legacyItem(project,101),legacyItem(project,102)],
    hierarchyItems:[{projectId:project,projectRevision:201},{projectId:project,projectRevision:202}],
    coverage:coverage([scope('legacy','profile_save',project,2),
      scope('logical_hierarchy','logical-hierarchy-commit',project,2)]),
  }));
  for(const language of ['en','vi']){
    const html=renderToStaticMarkup(React.createElement(ui.CommonRecoveryEvidence,{value,language}));
    for(const rev of [101,102,201,202])assert.equal((html.match(new RegExp(`r${rev}\\b`,'g'))??[]).length,1);
    assert.ok(!html.includes(language==='en'?'Observed library format':'Định dạng thư viện đã quan sát'));
  }
});

test('explicitly verified empty scope is rendered distinctly from a compatible legacy-only review',()=>{
  const empty=checkedCommon(common());
  const old=ui.checkedOperationRecoveryPreview({
    id,expiresAt,priorOutcome:'unknown',items:[legacyItem()],
  },null,true);
  for(const [language,phrase,heading] of [
    ['en','The service explicitly verified an empty retained scope.','Complete affected scope'],
    ['vi','Dịch vụ đã xác minh rõ ràng rằng không có phạm vi được giữ lại.','Toàn bộ phạm vi bị ảnh hưởng'],
  ]){
    const emptyHtml=renderToStaticMarkup(React.createElement(ui.CommonRecoveryEvidence,{value:empty,language}));
    const oldHtml=renderToStaticMarkup(React.createElement(ui.CommonRecoveryEvidence,{value:old,language}));
    assert.ok(emptyHtml.includes(phrase)&&emptyHtml.includes(heading));
    assert.ok(!oldHtml.includes(phrase)&&!oldHtml.includes(heading));
    assert.ok(oldHtml.includes(project)&&oldHtml.includes('codex'));
  }
});

const physicalCommon=(overrides={})=>common({physicalHierarchyItems:[],...overrides});
const checkedPhysicalCommon=value=>ui.checkedOperationRecoveryPreview(value,null,true,true,true);
const grantResponse={projects:[{projectId:project,allowInternal:false}]};
const unsupported=()=>Object.assign(new Error('not configured'),{code:'NOT_SUPPORTED'});

test('recovery discovery reads logical and physical grants independently without inferring either capability',async()=>{
  for(const logical of [false,true])for(const physical of [false,true])for(const library of [false,true]){
    const calls=[],signal=new AbortController().signal;
    const result=await ui.discoverRecoveryCapabilities(async(path,method,body,receivedSignal)=>{
      calls.push(path);
      assert.equal(method,'GET');assert.equal(body,undefined);assert.equal(receivedSignal,signal);
      if(path==='/api/v1/library-management-capability')return {enabled:library};
      const enabled=path==='/api/v1/logical-hierarchy-scopes'?logical:
        path==='/api/v1/physical-hierarchy-scopes'?physical:assert.fail('Unexpected capability route');
      if(!enabled)throw unsupported();
      return grantResponse;
    },signal);
    assert.deepEqual(result,{logical,physical,library});
    assert.equal(Object.isFrozen(result),true);
    assert.deepEqual(calls.sort(),['/api/v1/library-management-capability','/api/v1/logical-hierarchy-scopes','/api/v1/physical-hierarchy-scopes']);
  }
});

test('failed or malformed capability discovery cannot become absence or an actionable partial recovery shape',async()=>{
  for(const failedPath of ['/api/v1/logical-hierarchy-scopes','/api/v1/physical-hierarchy-scopes']){
    for(const code of ['NETWORK','SCOPE_DENIED','OWNER_UNAVAILABLE','SESSION_EXPIRED']){
      const failure=Object.assign(new Error('fixture failure'),{code});
      await assert.rejects(ui.discoverRecoveryCapabilities(async path=>{
        if(path===failedPath)throw failure;
        return path==='/api/v1/library-management-capability'?{enabled:false}:grantResponse;
      }),error=>error===failure);
    }
    for(const invalid of [{projects:[]},{projects:[{projectId:project,allowInternal:'false'}]},
      {...grantResponse,physical:true}]){
      await assert.rejects(ui.discoverRecoveryCapabilities(async path=>
        path===failedPath?invalid:path==='/api/v1/library-management-capability'?{enabled:false}:grantResponse),{code:'INVALID_SOURCE_RESPONSE'});
    }
  }
});

test('physical capability requires all seven common recovery fields while legacy and logical shapes stay scoped',()=>{
  const empty=physicalCommon();
  assert.deepEqual(checkedPhysicalCommon(empty),empty);
  bad(()=>checkedCommon(empty));
  bad(()=>ui.checkedOperationRecoveryPreview(empty,null,true));
  bad(()=>checkedPhysicalCommon(common()));
  bad(()=>checkedPhysicalCommon({id,expiresAt,priorOutcome:'unknown',items:[]}));
  for(const key of ['hierarchyItems','physicalHierarchyItems','coverage']){
    const missing={...empty};delete missing[key];bad(()=>checkedPhysicalCommon(missing));
  }
  for(const value of [null,{},'absent'])bad(()=>checkedPhysicalCommon({...empty,physicalHierarchyItems:value}));
  bad(()=>checkedPhysicalCommon({...empty,physicalHierarchyItems:[],privateScope:{path:'private'}}));
  assert.deepEqual(checkedCommon(common()),common());
  const legacy={id,expiresAt,priorOutcome:'unknown',items:[]};
  assert.deepEqual(ui.checkedOperationRecoveryPreview(legacy,null,true),legacy);
});

test('physical-only recovery retains every original target including repeated project labels and maximum saved revisions',()=>{
  const value=physicalCommon({
    physicalHierarchyItems:[{projectId:project,projectRevision:17},{projectId:project,projectRevision:23}],
    coverage:coverage([scope('physical_hierarchy','physical-hierarchy-commit',project,2)]),
  });
  const parsed=checkedPhysicalCommon(value);
  assert.deepEqual(parsed.physicalHierarchyItems,value.physicalHierarchyItems);
  assert.equal(parsed.items.length,0);assert.equal(parsed.hierarchyItems.length,0);
  assert.equal(parsed.coverage.retainedSubjects,2);
  bad(()=>checkedPhysicalCommon({...value,physicalHierarchyItems:value.physicalHierarchyItems.slice(0,1)}));
  bad(()=>checkedPhysicalCommon({...value,physicalHierarchyItems:[...value.physicalHierarchyItems,{projectId:project,projectRevision:24}]}));
  bad(()=>checkedPhysicalCommon({...value,physicalHierarchyItems:[{projectId:'substituted',projectRevision:17},value.physicalHierarchyItems[1]]}));
  bad(()=>checkedCommon({...common(),coverage:value.coverage}));
  for(const revision of [0,-1,1.5,'17',Number.MAX_SAFE_INTEGER,null]){
    bad(()=>checkedPhysicalCommon({...value,physicalHierarchyItems:[
      {...value.physicalHierarchyItems[0],projectRevision:revision},value.physicalHierarchyItems[1],
    ]}));
  }
  for(const key of ['profileRevision','storeUuid','canonicalPath','proposal','grantId']){
    bad(()=>checkedPhysicalCommon({...value,physicalHierarchyItems:[
      {...value.physicalHierarchyItems[0],[key]:key==='profileRevision'?0:'private'},value.physicalHierarchyItems[1],
    ]}));
  }
  const max={...value,physicalHierarchyItems:[
    {...value.physicalHierarchyItems[0],projectRevision:Number.MAX_SAFE_INTEGER-1},value.physicalHierarchyItems[1],
  ]};
  assert.equal(checkedPhysicalCommon(max).physicalHierarchyItems[0].projectRevision,Number.MAX_SAFE_INTEGER-1);
});

test('four-family recovery correlates the full retained union and never substitutes one family summary for another',()=>{
  const value=physicalCommon({
    items:[legacyItem(project,3)],
    hierarchyItems:[{projectId:project,projectRevision:5}],
    physicalHierarchyItems:[{projectId:project,projectRevision:7},{projectId:project,projectRevision:9}],
    coverage:coverage([
      scope('legacy','client_apply'),scope('logical_hierarchy','logical-hierarchy-commit'),
      scope('physical_hierarchy','physical-hierarchy-commit',project,2),
      scope('project_operations','copy-prepare','removed-project',2),
      scope('project_operations','library-upgrade-v2',null),
    ],3),
  });
  const parsed=checkedPhysicalCommon(value);
  assert.equal(parsed.coverage.retainedSubjects,7);
  assert.equal(parsed.coverage.affectedScopes.length,5);
  assert.deepEqual(parsed.physicalHierarchyItems.map(row=>row.projectRevision),[7,9]);
  bad(()=>checkedPhysicalCommon({...value,hierarchyItems:[],physicalHierarchyItems:[
    ...value.hierarchyItems,...value.physicalHierarchyItems,
  ]}));
  bad(()=>checkedPhysicalCommon({...value,coverage:coverage(value.coverage.affectedScopes.filter(row=>row.kind!=='physical_hierarchy'),3)}));
  bad(()=>checkedPhysicalCommon({...value,coverage:{...value.coverage,retainedSubjects:4}}));
  bad(()=>checkedPhysicalCommon({...value,physicalHierarchyItems:[]}));
  bad(()=>checkedPhysicalCommon({...value,items:[]}));
});

test('physical plus project operations without logical scope still requires complete physical recovery observations',()=>{
  const value=physicalCommon({
    physicalHierarchyItems:[{projectId:project,projectRevision:11}],
    coverage:coverage([scope('physical_hierarchy','physical-hierarchy-commit'),
      scope('project_operations','copy-prepare','removed-project')],3),
  });
  const parsed=checkedPhysicalCommon(value);
  assert.equal(parsed.coverage.retainedSubjects,2);
  assert.deepEqual(parsed.hierarchyItems,[]);
  bad(()=>ui.checkedOperationRecoveryPreview(value,null,false));
  bad(()=>checkedCommon({...common(),coverage:value.coverage}));
});

test('physical common recovery bounds the whole retained set at thirty-two without deduplicating observations',()=>{
  const physicalHierarchyItems=Array.from({length:32},(_,i)=>({projectId:project,projectRevision:i+1}));
  const value=physicalCommon({physicalHierarchyItems,
    coverage:coverage([scope('physical_hierarchy','physical-hierarchy-commit',project,32)])});
  assert.equal(checkedPhysicalCommon(value).physicalHierarchyItems.length,32);
  bad(()=>checkedPhysicalCommon({...value,physicalHierarchyItems:[...physicalHierarchyItems,{projectId:project,projectRevision:33}]}));
  bad(()=>checkedPhysicalCommon({...value,items:[legacyItem()],
    coverage:coverage([...value.coverage.affectedScopes,scope('legacy','profile_save')])}));
});

test('EN/VI physical and mixed recovery renders distinct original observations without private fields or outcome attribution',()=>{
  const value=checkedPhysicalCommon(physicalCommon({
    items:[legacyItem('settings-project',101)],
    hierarchyItems:[{projectId:'logical-project',projectRevision:201}],
    physicalHierarchyItems:[{projectId:'physical-project',projectRevision:301},{projectId:'physical-project',projectRevision:302}],
    coverage:coverage([scope('legacy','client_apply','settings-project'),
      scope('logical_hierarchy','logical-hierarchy-commit','logical-project'),
      scope('physical_hierarchy','physical-hierarchy-commit','physical-project',2),
      scope('project_operations','activation-abandon','removed-project')],3),
  }));
  for(const [language,heading,action] of [
    ['en','Physical hierarchy observations','Edit physical hierarchy'],
    ['vi','Quan sát phân cấp vật lý','Sửa phân cấp vật lý'],
  ]){
    const html=renderToStaticMarkup(React.createElement(ui.CommonRecoveryEvidence,{value,language}));
    for(const text of [heading,action,'settings-project','logical-project','physical-project','removed-project'])
      assert.ok(html.includes(text),`Missing ${language} ${text}`);
    for(const revision of [101,201,301,302])assert.equal((html.match(new RegExp(`r${revision}\\b`,'g'))??[]).length,1);
    assert.ok(!html.includes('<button')&&!html.includes('<input')&&!html.includes('<form'));
    for(const key of ['storeUuid','canonicalPath','grantId','proposalDigest','C:\\'])
      assert.ok(!html.includes(key));
  }
  ui.checkedOperationAcknowledgment({reviewed:true,priorOutcome:'unknown',freshReviewRequired:true},true);
  bad(()=>ui.checkedOperationAcknowledgment({reviewed:true,priorOutcome:'confirmed',freshReviewRequired:true},true));
});
