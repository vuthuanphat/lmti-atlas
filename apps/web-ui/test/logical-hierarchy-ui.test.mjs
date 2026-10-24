import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import test from 'node:test';

const uiRoot=process.env.LMTI_HIERARCHY_TEST_UI_ROOT??fileURLToPath(new URL('../',import.meta.url));
const app=createRequire(join(uiRoot,'package.json'));
const {build}=createRequire(app.resolve('vite'))('esbuild');
async function load(name){
  const bundle=await build({entryPoints:[fileURLToPath(new URL('../src/'+name,import.meta.url))],
    bundle:true,write:false,format:'cjs',platform:'node',jsx:'automatic',
    external:['react','react/*'],loader:{'.css':'empty','.png':'dataurl'}});
  const module={exports:{}};
  new Function('require','module','exports',bundle.outputFiles[0].text)(app,module,module.exports);
  return module.exports;
}
const ui=await load('logical-hierarchy-ui.ts'),panel=await load('LogicalHierarchyPanel.tsx');
const React=app('react'),{renderToStaticMarkup}=app('react-dom/server');
test('logical ID HTML pattern compiles in Unicode sets mode without changing accepted identities',()=>{
  const source=readFileSync(new URL('../src/LogicalHierarchyPanel.tsx',import.meta.url),'utf8');
  const patterns=[...source.matchAll(/\bpattern="([^"]+)"/g)].map(match=>match[1]);
  assert.equal(patterns.length,1);
  const id=new RegExp(`^(?:${patterns[0]})$`,'v');
  for(const value of ['a','Root-1','sensor_01.v2','A'+'b'.repeat(63)])assert.equal(id.test(value),true,value);
  for(const value of ['','1root','-root','a b','a/b','a@b','điểm','A'+'b'.repeat(64)])assert.equal(id.test(value),false,value);
});
const clone=value=>structuredClone(value),grant={projectId:'demo',allowInternal:true};
const project='demo',opaque='A'.repeat(43),expiresAt='2099-10-20T00:00:00.000Z';
const sub=(id,parentSubsystemId='',privacy='internal',label=id)=>({id,label,parentSubsystemId,privacy});
const comp=(id,privacy='public')=>({id,label:id,repositoryId:'',kind:'library',privacy});
function state(){
  return {projectId:project,revision:7,subsystems:[
    {value:sub('child','root','public'),ancestors:['root'],classification:'internal'},
    {value:sub('empty'),ancestors:[],classification:'internal'},
    {value:sub('root'),ancestors:[],classification:'internal'},
  ],components:[
    {value:comp('firmware'),membership:{componentId:'firmware',subsystemId:'child'},ancestors:['root','child'],classification:'internal'},
    {value:comp('loose'),membership:null,ancestors:[],classification:'public'},
  ]};
}
const input=(kind,targetId='',label='',parentId='')=>({kind,targetId,label,parentId});
const bad=(fn,code='INVALID_SOURCE_RESPONSE')=>assert.throws(fn,{code});
const change=(kind,targetId='',label='',parentId='',source=state())=>ui.makeHierarchyChange(source,grant,input(kind,targetId,label,parentId));
function renameReview(source=state()){
  const proposal=ui.hierarchyProposal(source,grant,[change('rename_subsystem','root','Root renamed','',source)]);
  const diff={subsystems:[{id:'root',before:source.subsystems.find(r=>r.value.id==='root').value,
    after:{...source.subsystems.find(r=>r.value.id==='root').value,label:'Root renamed'}}],memberships:[],
    affected:[
      {kind:'subsystem',id:'child',beforeClassification:'internal',afterClassification:'internal',beforeAncestors:['root'],afterAncestors:['root']},
      {kind:'subsystem',id:'root',beforeClassification:'internal',afterClassification:'internal',beforeAncestors:[],afterAncestors:[]},
      {kind:'component',id:'firmware',beforeClassification:'internal',afterClassification:'internal',beforeAncestors:['root','child'],afterAncestors:['root','child']},
    ]};
  return {proposal,preview:{id:opaque,projectId:project,revision:7,expiresAt,diff}};
}
const result=(outcome='confirmed',overrides={})=>({operationId:'B'.repeat(43),action:'logical-hierarchy-commit',outcome,
  code:outcome==='confirmed'||outcome==='pending'?null:'RECOVERY_REQUIRED',
  summary:outcome==='confirmed'?{projectId:project,previousRevision:7,revision:8}:null,...overrides});
const idle={admitted:true,recoveryRequired:true,projectOperations:false,activeWrites:0};

test('explicit grants and complete state reject private fields, coercion, bad ancestry and widened visibility',()=>{
  assert.deepEqual(ui.checkedHierarchyScopes({projects:[grant]}),[grant]);
  const valid=ui.checkedHierarchyState(state(),grant);
  assert.equal(valid.subsystems[0].value.privacy,'public');assert.equal(valid.subsystems[0].classification,'internal');
  assert.ok(Object.isFrozen(valid.components));
  bad(()=>ui.checkedHierarchyScopes({projects:[grant,grant]}));
  bad(()=>ui.checkedHierarchyScopes({projects:[{...grant,allowInternal:['true']}]}));
  bad(()=>ui.checkedHierarchyState({...state(),database:'private path'},grant));
  bad(()=>ui.checkedHierarchyState(state(),{...grant,allowInternal:false}));
  const wrong=state();wrong.components[0].ancestors=['child'];bad(()=>ui.checkedHierarchyState(wrong,grant));
  const inherited=state();inherited.subsystems[0].classification='public';bad(()=>ui.checkedHierarchyState(inherited,grant));
  const duplicate=state();duplicate.subsystems[1]=duplicate.subsystems[0];bad(()=>ui.checkedHierarchyState(duplicate,grant));
  const newline=state();newline.projectId='demo\n';bad(()=>ui.checkedHierarchyState(newline,grant));
});
test('complete empty state is distinct from malformed/unavailable and existing max read revision is accepted',()=>{
  const empty={projectId:project,revision:Number.MAX_SAFE_INTEGER-1,subsystems:[],components:[]};
  assert.equal(ui.checkedHierarchyState(empty,grant).components.length,0);
  bad(()=>ui.checkedHierarchyState(null,grant));bad(()=>ui.checkedHierarchyState({projectId:project,revision:1},grant));
  bad(()=>ui.hierarchyProposal(empty,grant,[change('add_subsystem','new','New')]),'INVALID_INPUT');
});
test('all five draft operations preserve complete original expected values and nullable membership',()=>{
  const source=ui.checkedHierarchyState(state(),grant),before=JSON.stringify(source);
  const add=ui.makeHierarchyChange(source,grant,input('add_subsystem','new','New','root'));
  assert.deepEqual(add,{kind:'add_subsystem',desired:sub('new','root','internal','New')});
  const rename=ui.makeHierarchyChange(source,grant,input('rename_subsystem','root','Renamed'));
  assert.deepEqual(rename.expected,source.subsystems[2].value);assert.equal(rename.desiredLabel,'Renamed');
  const reparent=ui.makeHierarchyChange(source,grant,input('reparent_subsystem','empty','','root'));
  assert.equal(reparent.desiredParentId,'root');assert.equal(reparent.expected.parentSubsystemId,'');
  const detach=ui.makeHierarchyChange(source,grant,input('set_component_membership','firmware','',''));
  assert.equal(detach.desiredSubsystemId,null);assert.deepEqual(detach.expected,{componentId:'firmware',subsystemId:'child'});
  assert.deepEqual(detach.expectedComponent,source.components[0].value);
  const attach=ui.makeHierarchyChange(source,grant,input('set_component_membership','loose','','root'));
  assert.equal(attach.expected,null);assert.equal(attach.desiredSubsystemId,'root');
  const retire=ui.makeHierarchyChange(source,grant,input('retire_empty_subsystem','empty'));
  assert.deepEqual(retire,{kind:'retire_empty_subsystem',expected:source.subsystems[1].value});
  assert.equal(JSON.stringify(source),before);
});
test('draft bounds use UTF-8 labels, original rows and one operation per identity',()=>{
  const source=state(),rename=change('rename_subsystem','root','Renamed');
  bad(()=>change('rename_subsystem','root','root'),'INVALID_INPUT');
  bad(()=>change('add_subsystem','new','ắ'.repeat(41)),'INVALID_INPUT');
  assert.equal(change('add_subsystem','new','ắ'.repeat(40)).desired.label.length,40);
  bad(()=>change('add_subsystem','root','Existing'),'INVALID_INPUT');
  bad(()=>ui.makeHierarchyChange(source,{...grant,allowInternal:false},input('add_subsystem','new','New')),'INVALID_INPUT');
  const draft=ui.addHierarchyChange([],rename);
  bad(()=>ui.addHierarchyChange(draft,change('reparent_subsystem','root','','empty')),'INVALID_INPUT');
  const replacement=ui.addHierarchyChange(draft,change('rename_subsystem','root','Again'),true);
  assert.equal(replacement.length,1);assert.equal(replacement[0].desiredLabel,'Again');
  const changed=clone(rename);changed.expected.label='not original';
  bad(()=>ui.hierarchyProposal(source,grant,[changed]),'INVALID_INPUT');
  const many=Array.from({length:32},(_,i)=>change('add_subsystem',`new${i}`,`N${i}`));
  assert.equal(ui.hierarchyProposal(source,grant,many).changes.length,32);
  bad(()=>ui.addHierarchyChange(many,change('add_subsystem','overflow','Overflow')),'LIMIT_EXCEEDED');
});
test('final-draft references support new parent and detach-retire without sequential expected values',()=>{
  const source=state();
  const draft=[change('add_subsystem','newparent','Parent'),change('add_subsystem','newchild','Child','newparent')];
  assert.equal(ui.hierarchyProposal(source,grant,draft).changes.length,2);
  const detachRetire=[change('set_component_membership','firmware','',''),change('retire_empty_subsystem','child')];
  assert.equal(ui.hierarchyProposal(source,grant,detachRetire).changes.length,2);
  bad(()=>ui.hierarchyProposal(source,grant,[change('retire_empty_subsystem','child')]),'INVALID_INPUT');
  bad(()=>ui.hierarchyProposal(source,grant,[change('reparent_subsystem','root','','child')]),'INVALID_INPUT');
  bad(()=>ui.hierarchyProposal(source,grant,[change('add_subsystem','new','New','missing')]),'INVALID_INPUT');
  const loop=[change('add_subsystem','a','A','b'),change('add_subsystem','b','B','a')];
  bad(()=>ui.hierarchyProposal(source,grant,loop),'INVALID_INPUT');
});
test('full affected review preserves unchanged descendants and rejects partial, stale or uncorrelated details',()=>{
  const source=state(),{proposal,preview}=renameReview();
  assert.equal(ui.checkedHierarchyPreview(preview,source,grant,proposal).diff.affected.length,3);
  const partial=clone(preview);partial.diff.affected.pop();bad(()=>ui.checkedHierarchyPreview(partial,source,grant,proposal));
  const path=clone(preview);path.diff.affected[2].afterAncestors=['root'];bad(()=>ui.checkedHierarchyPreview(path,source,grant,proposal));
  const wrong=clone(preview);wrong.diff.subsystems[0].after.label='Different';bad(()=>ui.checkedHierarchyPreview(wrong,source,grant,proposal));
  bad(()=>ui.checkedHierarchyPreview({...preview,revision:8},source,grant,proposal));
  bad(()=>ui.checkedHierarchyPreview({...preview,nativeToken:{}},source,grant,proposal));
  bad(()=>ui.checkedHierarchyPreview({...preview,id:opaque+'\n'},source,grant,proposal));
  const leaked=clone(preview);leaked.diff.affected[0].path='private';bad(()=>ui.checkedHierarchyPreview(leaked,source,grant,proposal));
});
test('review after paths inherit Internal from an unchanged parent under an internal grant',()=>{
  const source={projectId:project,revision:7,subsystems:[
    {value:sub('child','parent','public'),ancestors:['parent'],classification:'public'},
    {value:sub('parent','','public'),ancestors:[],classification:'public'},
    {value:sub('sink'),ancestors:[],classification:'internal'},
  ],components:[]};
  const op=change('reparent_subsystem','parent','','sink',source),proposal=ui.hierarchyProposal(source,grant,[op]);
  const preview={id:opaque,projectId:project,revision:7,expiresAt,diff:{
    subsystems:[{id:'parent',before:source.subsystems[1].value,after:{...source.subsystems[1].value,parentSubsystemId:'sink'}}],
    memberships:[],affected:[
      {kind:'subsystem',id:'child',beforeClassification:'public',afterClassification:'internal',beforeAncestors:['parent'],afterAncestors:['sink','parent']},
      {kind:'subsystem',id:'parent',beforeClassification:'public',afterClassification:'internal',beforeAncestors:[],afterAncestors:['sink']},
    ]}};
  ui.checkedHierarchyPreview(preview,source,grant,proposal);
  for(const index of [0,1]){
    const wrong=clone(preview);wrong.diff.affected[index].afterClassification='public';
    bad(()=>ui.checkedHierarchyPreview(wrong,source,grant,proposal));
  }
});
test('hierarchy collections above 256 remain complete while full public-frame overflow is refused',()=>{
  const source={projectId:project,revision:7,subsystems:[{value:sub('root','','public'),ancestors:[],classification:'public'}],
    components:Array.from({length:300},(_,i)=>{const key=`c${String(i).padStart(4,'0')}`;return {
      value:comp(key),membership:{componentId:key,subsystemId:'root'},ancestors:['root'],classification:'public'};})};
  assert.equal(ui.checkedHierarchyState(source,grant).components.length,300);
  const proposal=ui.hierarchyProposal(source,grant,[change('rename_subsystem','root','Renamed','',source)]);
  const affected=[{kind:'subsystem',id:'root',beforeClassification:'public',afterClassification:'public',beforeAncestors:[],afterAncestors:[]},
    ...source.components.map(r=>({kind:'component',id:r.value.id,beforeClassification:'public',afterClassification:'public',beforeAncestors:['root'],afterAncestors:['root']}))];
  const preview={id:opaque,projectId:project,revision:7,expiresAt,diff:{
    subsystems:[{id:'root',before:source.subsystems[0].value,after:{...source.subsystems[0].value,label:'Renamed'}}],memberships:[],affected}};
  assert.equal(ui.checkedHierarchyPreview(preview,source,grant,proposal).diff.affected.length,301);
  const oversized={projectId:project,revision:7,subsystems:[],components:Array.from({length:2000},(_,i)=>{
    const key=`c${String(i).padStart(4,'0')}`;return {value:{...comp(key),label:'x'.repeat(120)},membership:null,ancestors:[],classification:'public'};
  })};
  bad(()=>ui.checkedHierarchyState(oversized,grant),'LIMIT_EXCEEDED');
});
test('component and subsystem namespaces are independent; complete 31-ancestor chain accepted, 32 refused',()=>{
  const source={projectId:project,revision:7,subsystems:[],components:[]};
  for(let i=0;i<31;i++){
    const key=`s${String(i).padStart(2,'0')}`,path=source.subsystems.map(r=>r.value.id);
    source.subsystems.push({value:sub(key,path.at(-1)??'','public'),ancestors:path,classification:'public'});
  }
  source.components.push({value:comp('s00'),membership:{componentId:'s00',subsystemId:'s30'},ancestors:source.subsystems.map(r=>r.value.id),classification:'public'});
  ui.checkedHierarchyState(source,grant);
  source.subsystems.push({value:sub('s31','s30','public'),ancestors:source.subsystems.map(r=>r.value.id),classification:'public'});
  source.components[0].membership.subsystemId='s31';source.components[0].ancestors.push('s31');
  bad(()=>ui.checkedHierarchyState(source,grant));
});
test('write replies and jobs enforce project/revision/action correlation and confirmed fallback',()=>{
  assert.equal(ui.checkedHierarchyResult(result(),project,7).summary.revision,8);
  assert.equal(ui.checkedHierarchyResult(result('confirmed',{summary:null}),project,7).outcome,'confirmed');
  for(const outcome of ['pending','refused','unknown'])ui.checkedHierarchyResult(result(outcome),project,7);
  bad(()=>ui.checkedHierarchyResult({...result(),action:'activation-activate'},project,7));
  bad(()=>ui.checkedHierarchyResult(result('confirmed',{summary:{projectId:'other',previousRevision:7,revision:8}}),project,7));
  bad(()=>ui.checkedHierarchyResult(result('confirmed',{code:'OWNER_UNAVAILABLE'}),project,7));
  bad(()=>ui.checkedHierarchyResult(result('unknown',{code:['RECOVERY_REQUIRED']}),project,7));
  for(const [phase,outcome] of [['succeeded','confirmed'],['failed','refused'],['unknown','unknown']]){
    const r=result(outcome);ui.checkedHierarchyJob({operationId:r.operationId,state:phase,result:r,errorCode:phase==='failed'?r.code:null},project,7,r.operationId);
  }
  const r=result();bad(()=>ui.checkedHierarchyJob({operationId:r.operationId,state:'pending',result:r,errorCode:null},project,7,r.operationId));
});
test('synchronous gate consumes a review once, preserves confirmation and never retries a lost reply',()=>{
  const gate=new ui.HierarchyCommitGate(),preview=renameReview().preview;
  assert.deepEqual(gate.begin(preview,0),{previewId:preview.id});
  bad(()=>gate.begin(preview,0),'BUSY');
  gate.uncertain();assert.equal(gate.current.phase,'unknown');assert.equal(gate.current.locked,true);
  bad(()=>gate.begin({...preview,id:'C'.repeat(43)},0),'BUSY');
  const known=ui.checkedHierarchyResult(result('confirmed',{summary:null}),project,7);
  gate.observe(known);gate.uncertain();
  assert.equal(gate.current.phase,'confirmed');assert.equal(gate.current.result.summary,null);assert.equal(gate.current.locked,false);
  bad(()=>gate.begin(preview,0),'BUSY');
  const expired=new ui.HierarchyCommitGate();bad(()=>expired.begin(preview,Date.parse(expiresAt)),'PREVIEW_EXPIRED');
});
test('unknown cannot unlock from pre-dispatch status or a different submission; requires fresh post-unknown observation',()=>{
  const gate=new ui.HierarchyCommitGate(),preview=renameReview().preview;
  gate.begin(preview,0);const beforeUnknown=gate.current;
  gate.uncertain();assert.equal(gate.canEndUnknown(),false);bad(()=>gate.endUnknown(),'BUSY');
  bad(()=>gate.observeWriteStatus(idle,beforeUnknown),'BUSY');
  gate.observeWriteStatus({...idle,activeWrites:1},gate.current);assert.equal(gate.canEndUnknown(),false);
  gate.observeWriteStatus(idle,gate.current);assert.equal(gate.canEndUnknown(),true);
  gate.uncertain();assert.equal(gate.canEndUnknown(),false);
  gate.observeWriteStatus(idle,gate.current);gate.endUnknown();
  assert.equal(gate.current.phase,'unknown');assert.equal(gate.current.locked,false);
  gate.begin({...preview,id:'C'.repeat(43)},0);gate.uncertain();
  assert.equal(gate.canEndUnknown(),false,'a new dispatch clears old status proof');
});
test('only pending jobs poll automatically, with a finite read budget and no write path',()=>{
  const gate=new ui.HierarchyCommitGate();gate.begin(renameReview().preview,0);gate.observe(result('pending'));
  assert.equal(ui.hierarchyShouldPoll(gate.current,0,false),true);
  assert.equal(ui.hierarchyShouldPoll(gate.current,40,false),false);
  assert.equal(ui.hierarchyShouldPoll(gate.current,0,true),false);
  gate.uncertain();assert.equal(ui.hierarchyShouldPoll(gate.current,0,false),false);
  assert.deepEqual(ui.checkedHierarchyWriteStatus(idle),idle);
  bad(()=>ui.checkedHierarchyWriteStatus({...idle,activeWrites:33}));
  bad(()=>ui.checkedHierarchyWriteStatus({...idle,logicalHierarchy:true}));
});
test('read generation rejects previous projects, refresh epochs, cancelled work and unmounted responses',()=>{
  const fence=new ui.HierarchyReadFence(),old=fence.begin('demo\n0');
  assert.equal(fence.accepts(old,'demo\n0',true),true);
  assert.equal(fence.accepts(old,'other\n0',true),false,'selection blocks late arrival before effect cancellation');
  assert.equal(fence.accepts(old,'demo\n1',true),false);
  fence.invalidate();assert.equal(fence.accepts(old,'demo\n0',true),false);
  const next=fence.begin('other\n0');
  assert.equal(fence.current(old),false,'old finally cannot release the new read busy flag');
  assert.equal(fence.accepts(next,'other\n0',true),true);
  assert.equal(fence.accepts(next,'other\n0',false),false);
});
test('EN/VI server rendering shows complete affected rows, explicit classifications and fixed errors',()=>{
  const {preview}=renameReview();
  for(const language of ['en','vi']){
    const markup=renderToStaticMarkup(React.createElement(panel.HierarchyDiffView,{diff:preview.diff,language}));
    for(const id of ['child','root','firmware'])assert.ok(markup.includes(id));
    assert.ok(markup.includes(language==='en'?'All affected identities':'Tất cả đối tượng'));
    assert.ok(markup.includes(language==='en'?'Internal':'Nội bộ'));
    const initial=renderToStaticMarkup(React.createElement(panel.LogicalHierarchyPanel,{
      project,language,refreshKey:0,request:async()=>{throw Error('SSR must not dispatch');},onLockChange(){},onChanged(){},
    }));
    assert.ok(initial.includes(language==='en'?'Load current hierarchy':'Tải phân cấp hiện tại'));
    assert.ok(initial.includes('aria-labelledby=')&&initial.includes('aria-live="polite"'));
    assert.ok(!initial.includes('nativeToken')&&!initial.includes('canonicalPath'));
  }
  const html=renderToStaticMarkup(React.createElement(panel.HierarchyStateView,{state:state(),language:'en'}));
  assert.ok(html.includes('<summary>Subsystems'));assert.ok(html.includes('Stored')&&html.includes('Effective'));
  assert.equal(ui.hierarchyErrorCode({code:'C:\\private\\secret'}),'NETWORK');
  const message=panel.hierarchyMessage('C:\\private\\secret',(en)=>en);assert.ok(!message.includes('secret'));
});

test('logical explorer orders visible parents before descendants and keeps an accessible selection',()=>{
  const html=renderToStaticMarkup(React.createElement(panel.HierarchyStateView,{state:state(),language:'en'}));
  const navigation=html.slice(html.indexOf('<nav'),html.indexOf('</nav>'));
  assert.ok(navigation.indexOf('>root</strong>')<navigation.indexOf('>child</strong>'));
  assert.ok(navigation.indexOf('>child</strong>')<navigation.indexOf('>firmware</strong>'));
  assert.match(navigation,/aria-pressed="true"/);
  assert.match(navigation,/type="search"/);
  assert.match(html,/Complete authorized details/);
});
