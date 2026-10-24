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
const ui=await load('physical-hierarchy-ui.ts');
test('physical ID HTML pattern compiles in Unicode sets mode without changing accepted identities',()=>{
  const source=readFileSync(new URL('../src/PhysicalHierarchyPanel.tsx',import.meta.url),'utf8');
  const patterns=[...source.matchAll(/\bpattern="([^"]+)"/g)].map(match=>match[1]);
  assert.equal(patterns.length,1);
  const id=new RegExp(`^(?:${patterns[0]})$`,'v');
  for(const value of ['a','Site-1','area_01.v2','A'+'b'.repeat(63)])assert.equal(id.test(value),true,value);
  for(const value of ['','1site','-area','a b','a/b','a@b','điểm','A'+'b'.repeat(64)])assert.equal(id.test(value),false,value);
});
const clone=value=>structuredClone(value),grant={projectId:'demo',allowInternal:true};
const project='demo',opaque='A'.repeat(43),expiresAt='2099-10-20T00:00:00.000Z';
const site=(id,privacy='public',label=id)=>({id,label,privacy});
const area=(id,parentAreaId='',privacy='public',siteId='factory')=>({id,label:id,siteId,parentAreaId,privacy});
const asset=(id,privacy='public',site='factory')=>({id,label:id,site,kind:'machine',privacy});
const place=(assetId,areaId='',parentAssetId='',environmentId='',role=null)=>({assetId,areaId,parentAssetId,environmentId,role});
const path=(siteId='',areaAncestors=[],assetAncestors=[],environmentId='')=>({siteId,areaAncestors,assetAncestors,environmentId});
function state(){
  return {projectId:project,revision:7,
    sites:[{value:site('factory'),classification:'public'},{value:site('unusedSite','internal'),classification:'internal'}],
    areas:[
      {value:area('cell','root'),ancestors:['root'],classification:'public'},
      {value:area('emptyArea'),ancestors:[],classification:'public'},
      {value:area('movable','root'),ancestors:['root'],classification:'public'},
      {value:area('root'),ancestors:[],classification:'public'},
      {value:area('target'),ancestors:[],classification:'public'},
    ],
    environments:[{value:site('emptyEnv','internal'),classification:'internal'},{value:site('live'),classification:'public'}],
    assets:[
      {value:asset('loose','internal'),placement:null,path:path('factory'),classification:'internal'},
      {value:asset('machine'),placement:place('machine','cell','','live','host'),path:path('factory',['root','cell'],[],'live'),classification:'public'},
      {value:{...asset('sensor'),kind:'sensor'},placement:place('sensor','cell','machine','live'),path:path('factory',['root','cell'],['machine'],'live'),classification:'public'},
    ]};
}
const bad=(fn,code='INVALID_SOURCE_RESPONSE')=>assert.throws(fn,{code});
const change=(kind,targetId,extra={},source=state())=>ui.makePhysicalHierarchyChange(source,grant,{kind,targetId,...extra});
const proposal=(source,changes)=>ui.physicalHierarchyProposal(source,grant,changes);
function renameReview(source=state()){
  const op=change('rename_area','root',{label:'Root renamed'},source),p=proposal(source,[op]);
  const affected=[
    ...['cell','movable','root'].map(id=>{const row=source.areas.find(r=>r.value.id===id);return {
      kind:'area',id,beforeClassification:row.classification,afterClassification:row.classification,
      beforePath:path('factory',row.ancestors),afterPath:path('factory',row.ancestors)};}),
    ...['machine','sensor'].map(id=>{const row=source.assets.find(r=>r.value.id===id);return {
      kind:'asset',id,beforeClassification:row.classification,afterClassification:row.classification,beforePath:row.path,afterPath:row.path};}),
  ];
  const diff={sites:[],areas:[{id:'root',before:op.expected,after:{...op.expected,label:'Root renamed'}}],environments:[],placements:[],affected};
  return {proposal:p,preview:{id:opaque,projectId:project,revision:7,expiresAt,diff}};
}
const result=(outcome='confirmed',overrides={})=>({operationId:'B'.repeat(43),action:'physical-hierarchy-commit',outcome,
  code:outcome==='confirmed'||outcome==='pending'?null:'RECOVERY_REQUIRED',
  summary:outcome==='confirmed'?{projectId:project,previousRevision:7,revision:8}:null,...overrides});
const idle={admitted:true,recoveryRequired:true,projectOperations:false,activeWrites:0};

test('physical grants and complete state reject private fields, wrong project, coercion and inherited privacy changes',()=>{
  assert.deepEqual(ui.checkedPhysicalHierarchyScopes({projects:[grant]}),[grant]);
  const checked=ui.checkedPhysicalHierarchyState(state(),grant);assert.ok(Object.isFrozen(checked.assets[1].path));
  bad(()=>ui.checkedPhysicalHierarchyScopes({projects:[grant,grant]}));
  bad(()=>ui.checkedPhysicalHierarchyScopes({projects:[{...grant,allowInternal:['true']}]}));
  bad(()=>ui.checkedPhysicalHierarchyState({...state(),database:'private'},grant));
  bad(()=>ui.checkedPhysicalHierarchyState({...state(),projectId:'other'},grant));
  bad(()=>ui.checkedPhysicalHierarchyState(state(),{...grant,allowInternal:false}));
  const hidden=state();hidden.environments[1].value.privacy='internal';hidden.environments[1].classification='internal';
  bad(()=>ui.checkedPhysicalHierarchyState(hidden,grant));
  hidden.assets[1].classification=hidden.assets[2].classification='internal';
  assert.equal(ui.checkedPhysicalHierarchyState(hidden,grant).assets[2].classification,'internal');
  const inconsistent=state();inconsistent.environments[1].classification='internal';
  bad(()=>ui.checkedPhysicalHierarchyState(inconsistent,grant),'INVALID_SOURCE_RESPONSE');
});

test('complete empty state is available but malformed state is not; maximum read revision has no write headroom',()=>{
  const empty={projectId:project,revision:Number.MAX_SAFE_INTEGER-1,sites:[],areas:[],environments:[],assets:[]};
  assert.deepEqual(ui.checkedPhysicalHierarchyState(empty,grant),empty);
  bad(()=>ui.checkedPhysicalHierarchyState(null,grant));
  bad(()=>ui.checkedPhysicalHierarchyState({projectId:project,revision:1},grant));
  bad(()=>proposal(empty,[change('add_site','new',{label:'New'},empty)]),'INVALID_INPUT');
  bad(()=>ui.checkedPhysicalHierarchyState({...empty,revision:Number.MAX_SAFE_INTEGER},grant));
});

test('all eleven changes derive original expectations without mutating or freezing caller snapshots',()=>{
  const source=state(),before=JSON.stringify(source);
  const inputs=[
    ['add_site','newSite',{label:'New site'}],['rename_site','factory',{label:'Factory renamed'}],['retire_empty_site','unusedSite',{}],
    ['add_area','newArea',{label:'New area',siteId:'factory',parentAreaId:'root'}],['rename_area','root',{label:'Root renamed'}],
    ['reparent_area','movable',{parentAreaId:'target'}],['retire_empty_area','emptyArea',{}],
    ['add_environment','newEnv',{label:'New environment'}],['rename_environment','live',{label:'Live renamed'}],['retire_empty_environment','emptyEnv',{}],
    ['set_asset_placement','loose',{desired:{areaId:'',parentAssetId:'',environmentId:'',role:null}}],
  ];
  const changes=inputs.map(([kind,id,extra])=>change(kind,id,extra,source)),p=proposal(source,changes);
  assert.equal(p.changes.length,11);assert.equal(new Set(p.changes.map(c=>c.kind)).size,11);
  for(const op of changes.filter(c=>c.kind.startsWith('add_')))assert.equal(op.desired.privacy,'internal');
  const placement=changes.at(-1);assert.equal(placement.expected,null);assert.deepEqual(placement.expectedAsset,source.assets[0].value);
  assert.deepEqual(placement.desired,place('loose'));
  assert.equal(JSON.stringify(source),before);assert.equal(Object.isFrozen(source.assets[0].value),false);
  assert.ok(Object.isFrozen(placement.expectedAsset));
  bad(()=>ui.makePhysicalHierarchyChange(source,grant,{kind:'rename_site',targetId:'factory',label:'X',expected:{}}),'INVALID_INPUT');
  bad(()=>ui.makePhysicalHierarchyChange(source,grant,{kind:'set_asset_placement',targetId:'loose',desired:{...place('loose')}}),'INVALID_INPUT');
});

test('placement absence, declared-empty placement and unknown role stay distinct',()=>{
  const source=state(),declared=change('set_asset_placement','loose',{desired:{areaId:'',parentAssetId:'',environmentId:'',role:null}},source);
  assert.equal(declared.expected,null);assert.notEqual(declared.desired,null);assert.equal(declared.desired.role,null);
  proposal(source,[declared]);
  source.assets[0].placement=place('loose');
  const removed=change('set_asset_placement','loose',{desired:null},source);
  assert.deepEqual(removed.expected,place('loose'));assert.equal(removed.desired,null);proposal(source,[removed]);
  bad(()=>change('set_asset_placement','loose',{desired:{areaId:'',parentAssetId:'',environmentId:'',role:'unknown'}}),'INVALID_INPUT');
  const forged=clone(declared);forged.expectedAsset.site='unusedSite';
  bad(()=>proposal(state(),[forged]),'INVALID_INPUT');
});

test('batch references resolve against final additions and retirements require final emptiness',()=>{
  const source=state();
  const additions=[
    change('add_area','child',{label:'Child',siteId:'newSite',parentAreaId:'parent'},source),
    change('add_site','newSite',{label:'New'},source),
    change('add_area','parent',{label:'Parent',siteId:'newSite',parentAreaId:''},source),
  ];
  assert.equal(proposal(source,additions).changes.length,3);
  source.assets[0].placement=place('loose','emptyArea','','emptyEnv');
  source.assets[0].path=path('factory',['emptyArea'],[],'emptyEnv');
  const retire=[change('retire_empty_area','emptyArea',{},source),change('retire_empty_environment','emptyEnv',{},source),
    change('set_asset_placement','loose',{desired:null},source)];
  assert.equal(proposal(source,retire).changes.length,3);
  bad(()=>proposal(source,retire.slice(0,2)),'INVALID_INPUT');
  bad(()=>proposal(state(),[change('retire_empty_site','factory')]),'INVALID_INPUT');
  bad(()=>proposal(state(),[change('retire_empty_area','root')]),'INVALID_INPUT');
  bad(()=>proposal(state(),[change('add_area','x',{label:'X',siteId:'missing',parentAreaId:''})]),'INVALID_INPUT');
});

test('typed identity keys allow equal IDs across catalogs but forbid duplicate targets and stale expectations',()=>{
  const source=state(),changes=[
    change('add_site','same',{label:'Same'}),change('add_area','same',{label:'Same',siteId:'same',parentAreaId:''}),
    change('add_environment','same',{label:'Same'}),
  ];
  assert.deepEqual(proposal(source,changes).changes.map(ui.physicalChangeKey),['0:same','1:same','2:same']);
  const rename=change('rename_area','root',{label:'Changed'}),reparent=change('reparent_area','root',{parentAreaId:'target'});
  bad(()=>ui.addPhysicalHierarchyChange([rename],reparent),'INVALID_INPUT');
  assert.deepEqual(ui.addPhysicalHierarchyChange([rename],reparent,true),[reparent]);
  bad(()=>proposal(source,[rename,reparent]),'INVALID_INPUT');
  const stale=clone(rename);stale.expected.label='not original';bad(()=>proposal(source,[stale]),'INVALID_INPUT');
  const unchanged=change('rename_area','root',{label:'root'});bad(()=>proposal(source,[unchanged]),'INVALID_INPUT');
  assert.equal(proposal(source,[unchanged,changes[0]]).changes.length,2,'one unchanged reviewed target may accompany a real change');
  const ordered=['a_','a.','a-','A'].map(target=>change('add_site',target,{label:target}));
  assert.deepEqual(proposal(source,ordered).changes.map(c=>c.desired.id),['A','a-','a.','a_']);
});

test('cycles, cross-site Area moves and undeclared or incompatible parent Asset placements are refused',()=>{
  bad(()=>proposal(state(),[change('reparent_area','root',{parentAreaId:'cell'})]),'INVALID_INPUT');
  const source=state();source.areas.push({value:area('zOther','','internal','unusedSite'),ancestors:[],classification:'internal'});
  bad(()=>proposal(source,[change('reparent_area','root',{parentAreaId:'zOther'},source)]),'INVALID_INPUT');
  const desired=(parentAssetId,areaId='cell',environmentId='live')=>({areaId,parentAssetId,environmentId,role:null});
  bad(()=>proposal(state(),[change('set_asset_placement','machine',{desired:desired('loose')})]),'INVALID_INPUT');
  bad(()=>proposal(state(),[change('set_asset_placement','machine',{desired:desired('sensor')})]),'INVALID_INPUT');
  bad(()=>proposal(state(),[change('set_asset_placement','sensor',{desired:desired('machine','root')})]),'INVALID_INPUT');
  bad(()=>proposal(state(),[change('set_asset_placement','sensor',{desired:desired('machine','cell','')})]),'INVALID_INPUT');
});

test('effective privacy cannot decrease through environment removal or Area reparenting',()=>{
  const source=state();source.environments[1].value.privacy='internal';source.environments[1].classification='internal';
  source.assets[1].classification=source.assets[2].classification='internal';
  const changes=['machine','sensor'].map(id=>change('set_asset_placement',id,{desired:{areaId:'cell',parentAssetId:id==='sensor'?'machine':'',environmentId:'',role:null}},source));
  bad(()=>proposal(source,changes),'INVALID_INPUT');
  const moved=state();moved.areas[3].value.privacy='internal';for(const i of [0,2,3])moved.areas[i].classification='internal';
  moved.assets[1].classification=moved.assets[2].classification='internal';
  bad(()=>proposal(moved,[change('reparent_area','cell',{parentAreaId:'target'},moved)]),'INVALID_INPUT');
  const global=state();for(const row of [...global.sites,...global.environments,...global.areas,...global.assets])row.classification='internal';
  assert.equal(proposal(global,[change('reparent_area','cell',{parentAreaId:'target'},global)]).changes.length,1,
    'unchanged effective project privacy is retained through visible Site classification');
});

test('full preview contains unchanged affected descendants with exact original/final paths and no private fields',()=>{
  const source=state(),{proposal:p,preview}=renameReview(source);
  assert.equal(ui.checkedPhysicalHierarchyPreview(preview,source,grant,p).diff.affected.length,5);
  const partial=clone(preview);partial.diff.affected.pop();bad(()=>ui.checkedPhysicalHierarchyPreview(partial,source,grant,p));
  const altered=clone(preview);altered.diff.areas[0].after.label='Different';bad(()=>ui.checkedPhysicalHierarchyPreview(altered,source,grant,p));
  const ancestry=clone(preview);ancestry.diff.affected[4].afterPath.assetAncestors=[];bad(()=>ui.checkedPhysicalHierarchyPreview(ancestry,source,grant,p));
  const extra=clone(preview);extra.diff.affected[0].canonicalPath='private';bad(()=>ui.checkedPhysicalHierarchyPreview(extra,source,grant,p));
  bad(()=>ui.checkedPhysicalHierarchyPreview({...preview,revision:8},source,grant,p));
  bad(()=>ui.checkedPhysicalHierarchyPreview({...preview,id:opaque+'\n'},source,grant,p));
  bad(()=>ui.checkedPhysicalHierarchyPreview({...preview,nativeToken:{}},source,grant,p));
});

test('preview independently checks inherited Internal classifications after moving a public subtree',()=>{
  const source=state();source.areas[4].value.privacy='internal';source.areas[4].classification='internal';
  const op=change('reparent_area','root',{parentAreaId:'target'},source),p=proposal(source,[op]);
  const affected=[
    ...['cell','movable','root'].map(id=>{const row=source.areas.find(r=>r.value.id===id);return {kind:'area',id,
      beforeClassification:'public',afterClassification:'internal',beforePath:path('factory',row.ancestors),
      afterPath:path('factory',['target',...row.ancestors])};}),
    ...['machine','sensor'].map(id=>{const row=source.assets.find(r=>r.value.id===id);return {kind:'asset',id,
      beforeClassification:'public',afterClassification:'internal',beforePath:row.path,
      afterPath:{...row.path,areaAncestors:['target',...row.path.areaAncestors]}};}),
  ];
  const preview={id:opaque,projectId:project,revision:7,expiresAt,diff:{
    sites:[],areas:[{id:'root',before:op.expected,after:{...op.expected,parentAreaId:'target'}}],environments:[],placements:[],affected}};
  ui.checkedPhysicalHierarchyPreview(preview,source,grant,p);
  for(const index of [0,2,3,4]){
    const wrong=clone(preview);wrong.diff.affected[index].afterClassification='public';bad(()=>ui.checkedPhysicalHierarchyPreview(wrong,source,grant,p));
  }
});

test('combined Area plus Asset depth accepts 31 ancestors, rejects 32, with independent typed namespaces',()=>{
  const source={projectId:project,revision:7,sites:[{value:site('same'),classification:'public'}],areas:[],
    environments:[{value:site('same'),classification:'public'}],assets:[]};
  for(let i=0;i<20;i++){
    const id=`a${String(i).padStart(2,'0')}`,ancestors=source.areas.map(r=>r.value.id);
    source.areas.push({value:area(id,ancestors.at(-1)??'','public','same'),ancestors,classification:'public'});
  }
  for(let i=0;i<12;i++){
    const id=i===0?'same':`x${String(i).padStart(2,'0')}`,parent=source.assets.at(-1)?.value.id??'',parents=source.assets.map(r=>r.value.id);
    source.assets.push({value:asset(id,'public','same'),placement:place(id,'a19',parent,'same'),
      path:path('same',source.areas.map(r=>r.value.id),parents,'same'),classification:'public'});
  }
  ui.checkedPhysicalHierarchyState(source,grant);
  const next={value:asset('x12','public','same'),placement:place('x12','a19','x11','same'),
    path:path('same',source.areas.map(r=>r.value.id),source.assets.map(r=>r.value.id),'same'),classification:'public'};
  source.assets.push(next);bad(()=>ui.checkedPhysicalHierarchyState(source,grant));
});

test('Unicode, exact string limits, batch count and conservative 32 KiB request framing are enforced',()=>{
  const source=state();assert.equal(change('add_site','new',{label:'ắ'.repeat(40)}).desired.label.length,40);
  assert.equal(change('add_site','new',{label:'𐐀'}).desired.label,'𐐀');
  for(const label of ['ắ'.repeat(41),'\ud800','\udc00','\udc00\ud800','bad\n'])
    bad(()=>change('add_site','new',{label}),'INVALID_INPUT');
  const changes=Array.from({length:32},(_,i)=>change('add_site',`s${String(i).padStart(2,'0')}`,{label:`S${i}`}));
  assert.equal(proposal(source,changes).changes.length,32);
  bad(()=>ui.addPhysicalHierarchyChange(changes,change('add_site','overflow',{label:'Overflow'})),'LIMIT_EXCEEDED');
  bad(()=>proposal(source,[]),'INVALID_INPUT');
  // 32 complete old/new placement records exceed the request framing budget.
  const wide={projectId:project,revision:7,sites:[{value:site('s'.repeat(64),'internal'),classification:'internal'}],areas:[],environments:[],assets:[]};
  for(let i=0;i<32;i++){
    const id=`a${String(i).padStart(2,'0')}`+'x'.repeat(61),value={...asset(id,'internal','s'.repeat(64)),label:'L'.repeat(120)};
    wide.assets.push({value,placement:place(id),path:path(value.site),classification:'internal'});
  }
  // Use maximal optional IDs backed by valid final catalogs; no missing-reference shortcut.
  const aid='b'.repeat(64),eid='e'.repeat(64);
  wide.areas=[{value:{...area(aid,'','internal','s'.repeat(64)),label:'Area'},ancestors:[],classification:'internal'}];
  wide.environments=[{value:site(eid,'internal'),classification:'internal'}];
  for(const row of wide.assets){row.placement=place(row.value.id,aid,'',eid,'device');row.path=path(row.value.site,[aid],[],eid);}
  const rich=wide.assets.map(row=>change('set_asset_placement',row.value.id,{desired:{areaId:aid,parentAssetId:'',environmentId:eid,role:'gateway'}},wide));
  bad(()=>proposal(wide,rich),'LIMIT_EXCEEDED');
});

test('collections above 256 stay complete and whole success-envelope overflow never becomes empty state',()=>{
  const source={projectId:project,revision:7,sites:[{value:site('factory'),classification:'public'}],areas:[],environments:[],
    assets:Array.from({length:300},(_,i)=>{const id=`x${String(i).padStart(4,'0')}`;return {value:asset(id),placement:null,path:path('factory'),classification:'public'};})};
  assert.equal(ui.checkedPhysicalHierarchyState(source,grant).assets.length,300);
  const rename=change('rename_site','factory',{label:'Renamed'},source),p=proposal(source,[rename]);
  const review=count=>({id:opaque,projectId:project,revision:7,expiresAt,diff:{
    sites:[{id:'factory',before:source.sites[0].value,after:{...source.sites[0].value,label:'Renamed'}}],
    areas:[],environments:[],placements:[],affected:[
      {kind:'site',id:'factory',beforeClassification:'public',afterClassification:'public',beforePath:path('factory'),afterPath:path('factory')},
      ...Array.from({length:count},(_,i)=>({kind:'asset',id:`x${String(i).padStart(4,'0')}`,
        beforeClassification:'public',afterClassification:'public',beforePath:path('factory'),afterPath:path('factory')})),
    ]}});
  assert.equal(ui.checkedPhysicalHierarchyPreview(review(300),source,grant,p).diff.affected.length,301);
  const large=clone(source);large.assets=Array.from({length:1000},(_,i)=>{
    const id=`x${String(i).padStart(4,'0')}`;return {value:asset(id),placement:null,path:path('factory'),classification:'public'};
  });
  const envelope=value=>Buffer.byteLength(JSON.stringify({apiVersion:1,requestId:'x'.repeat(43),ok:true,data:value}));
  assert.ok(envelope(large)<=256*1024,'large original state is a valid complete response');
  assert.ok(envelope(review(1000))>256*1024,'only the complete reviewed affected set exceeds the frame');
  ui.checkedPhysicalHierarchyState(large,grant);
  bad(()=>ui.checkedPhysicalHierarchyPreview(review(1000),large,grant,proposal(large,[rename])),'LIMIT_EXCEEDED');
  const oversized=clone(source);oversized.assets=Array.from({length:1000},(_,i)=>{
    const id=`x${String(i).padStart(4,'0')}`;return {value:{...asset(id),label:'L'.repeat(120)},placement:null,path:path('factory'),classification:'public'};
  });
  bad(()=>ui.checkedPhysicalHierarchyState(oversized,grant),'LIMIT_EXCEEDED');
  const catalogs={projectId:project,revision:7,sites:[],areas:[],environments:[],assets:[]};
  catalogs.sites=Array.from({length:2001},(_,i)=>({value:site(`s${String(i).padStart(4,'0')}`),classification:'public'}));
  bad(()=>ui.checkedPhysicalHierarchyState(catalogs,grant));
});

test('physical replies and jobs keep confirmed fallback and enforce action, operation, project and revision correlation',()=>{
  assert.equal(ui.checkedPhysicalHierarchyResult(result(),project,7).summary.revision,8);
  assert.equal(ui.checkedPhysicalHierarchyResult(result('confirmed',{summary:null}),project,7).outcome,'confirmed');
  for(const outcome of ['pending','refused','unknown'])ui.checkedPhysicalHierarchyResult(result(outcome),project,7);
  bad(()=>ui.checkedPhysicalHierarchyResult({...result(),action:'logical-hierarchy-commit'},project,7));
  bad(()=>ui.checkedPhysicalHierarchyResult(result(),project,7,'C'.repeat(43)));
  bad(()=>ui.checkedPhysicalHierarchyResult(result('confirmed',{summary:{projectId:'other',previousRevision:7,revision:8}}),project,7));
  bad(()=>ui.checkedPhysicalHierarchyResult(result('confirmed',{code:'OWNER_UNAVAILABLE'}),project,7));
  bad(()=>ui.checkedPhysicalHierarchyResult(result('unknown',{code:['RECOVERY_REQUIRED']}),project,7));
  for(const [state,outcome] of [['succeeded','confirmed'],['failed','refused'],['unknown','unknown']]){
    const r=result(outcome);ui.checkedPhysicalHierarchyJob({operationId:r.operationId,state,result:r,errorCode:state==='failed'?r.code:null},project,7,r.operationId);
  }
  const r=result();bad(()=>ui.checkedPhysicalHierarchyJob({operationId:r.operationId,state:'pending',result:r,errorCode:null},project,7,r.operationId));
  ui.checkedPhysicalHierarchyRejection({rejected:true});bad(()=>ui.checkedPhysicalHierarchyRejection({rejected:false}));
  assert.equal(ui.physicalHierarchyErrorCode({code:'C:\\private\\secret'}),'NETWORK');
});

test('one-use synchronous gate preserves confirmed results and cannot reuse stale idle observations after unknown',()=>{
  const gate=new ui.PhysicalHierarchyCommitGate(),preview=renameReview().preview;
  assert.deepEqual(gate.begin(preview,0),{previewId:preview.id});const started=gate.current;
  bad(()=>gate.begin(preview,0),'BUSY');gate.uncertain();
  assert.equal(gate.canEndUnknown(),false);bad(()=>gate.endUnknown(),'BUSY');
  bad(()=>gate.observeWriteStatus(idle,started),'BUSY');
  gate.observeWriteStatus({...idle,activeWrites:1},gate.current);assert.equal(gate.canEndUnknown(),false);
  gate.observeWriteStatus(idle,gate.current);assert.equal(gate.canEndUnknown(),true);
  gate.uncertain();assert.equal(gate.canEndUnknown(),false);
  gate.observeWriteStatus(idle,gate.current);gate.endUnknown();assert.equal(gate.current.phase,'unknown');assert.equal(gate.current.locked,false);
  bad(()=>gate.begin(preview,0),'BUSY');
  gate.begin({...preview,id:'C'.repeat(43)},0);gate.observe(result('confirmed',{summary:null}));gate.uncertain();
  assert.equal(gate.current.phase,'confirmed');assert.equal(gate.current.result.summary,null);assert.equal(gate.current.locked,false);
  const expired=new ui.PhysicalHierarchyCommitGate();bad(()=>expired.begin(preview,Date.parse(expiresAt)),'PREVIEW_EXPIRED');
});

test('finite read polling and generation fences prevent stale selections from changing current work',()=>{
  const gate=new ui.PhysicalHierarchyCommitGate();gate.begin(renameReview().preview,0);gate.observe(result('pending'));
  assert.equal(ui.physicalHierarchyShouldPoll(gate.current,0,false),true);
  assert.equal(ui.physicalHierarchyShouldPoll(gate.current,40,false),false);
  assert.equal(ui.physicalHierarchyShouldPoll(gate.current,0,true),false);
  gate.uncertain();assert.equal(ui.physicalHierarchyShouldPoll(gate.current,0,false),false);
  assert.deepEqual(ui.checkedPhysicalHierarchyWriteStatus(idle),idle);
  bad(()=>ui.checkedPhysicalHierarchyWriteStatus({...idle,physicalHierarchy:true}));
  bad(()=>ui.checkedPhysicalHierarchyWriteStatus({...idle,activeWrites:33}));
  const fence=new ui.PhysicalHierarchyReadFence(),old=fence.begin('demo\n0');
  assert.equal(fence.accepts(old,'demo\n0',true),true);assert.equal(fence.accepts(old,'other\n0',true),false);
  assert.equal(fence.accepts(old,'demo\n1',true),false);fence.invalidate();assert.equal(fence.current(old),false);
  const next=fence.begin('other\n0');assert.equal(fence.current(old),false);
  assert.equal(fence.accepts(next,'other\n0',true),true);assert.equal(fence.accepts(next,'other\n0',false),false);
});

test('EN/VI SSR displays complete typed paths, placement absence, unknown role and fixed safe errors',async()=>{
  const panel=await load('PhysicalHierarchyPanel.tsx'),React=app('react'),{renderToStaticMarkup}=app('react-dom/server');
  for(const language of ['en','vi']){
    const source=state(),{preview}=renameReview(source);
    const html=renderToStaticMarkup(React.createElement(panel.PhysicalHierarchyStateView,{state:source,language}));
    for(const id of ['factory','unusedSite','emptyEnv','loose','machine','sensor'])assert.ok(html.includes(id));
    assert.ok(html.includes(language==='en'?'No placement declared':'Chưa khai báo vị trí'));
    assert.ok(html.includes(language==='en'?'Declared placement':'Vị trí đã khai báo'));
    assert.ok(html.includes(language==='en'?'Unknown':'Chưa biết'));
    assert.ok(html.includes(language==='en'?'Fixed Site':'Site cố định'));
    assert.ok(html.includes(language==='en'?'Environment membership':'Thành viên Environment'));
    const diff=renderToStaticMarkup(React.createElement(panel.PhysicalHierarchyDiffView,{diff:preview.diff,language}));
    for(const id of ['cell','movable','root','machine','sensor'])assert.ok(diff.includes(id));
    assert.ok(diff.includes(language==='en'?'All affected identities and inherited paths':'Tất cả đối tượng bị ảnh hưởng và đường dẫn kế thừa'));
    assert.ok(diff.includes('root / cell'));
    const initial=renderToStaticMarkup(React.createElement(panel.PhysicalHierarchyPanel,{
      project,language,refreshKey:0,request:async()=>{throw Error('SSR must not dispatch');},onLockChange(){},onChanged(){},
    }));
    assert.ok(initial.includes(language==='en'?'Physical hierarchy':'Phân cấp vật lý'));
    assert.ok(initial.includes(language==='en'?'Load current hierarchy':'Tải phân cấp hiện tại'));
    assert.ok(initial.includes('aria-labelledby=')&&initial.includes('aria-live="polite"'));
    assert.ok(!initial.includes('canonicalPath')&&!initial.includes('nativeToken'));
  }
  const source=state();source.assets[0].value.label='<img src=x onerror=alert(1)>';
  const escaped=renderToStaticMarkup(React.createElement(panel.PhysicalHierarchyStateView,{state:source,language:'en'}));
  assert.ok(!escaped.includes('<img src=x'));assert.ok(escaped.includes('&lt;img'));
  assert.ok(!panel.physicalHierarchyMessage('C:\\private\\secret',en=>en).includes('secret'));
});
