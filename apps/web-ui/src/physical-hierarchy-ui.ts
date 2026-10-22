import type {
  PhysicalHierarchyStateDto as State, PhysicalHierarchyGrantDto as Grant,
  PhysicalHierarchyProposalDto as Proposal, PhysicalHierarchyDiffDto as Diff,
  PhysicalHierarchyPreviewDto as Preview, PhysicalHierarchyCommitResultDto as Result,
  PhysicalHierarchyJobDto as Job, PhysicalSiteDto as Site, PhysicalAreaDto as Area,
  PhysicalEnvironmentDto as Environment, PhysicalAssetAnchorDto as AssetAnchor,
  PhysicalAssetPlacementDto as Placement, PhysicalHierarchyPathDto as Path,
} from '../../web-api/src/contracts';

export type {State,Grant,Proposal,Diff,Preview,Result,Job,Site,Area,Environment,AssetAnchor,Placement,Path};
export type Change=Proposal['changes'][number];
export type Kind=Change['kind'];
export type EntityKind='site'|'area'|'environment'|'asset';
export type DraftInput=
  | {kind:'add_site'|'add_environment';targetId:string;label:string}
  | {kind:'add_area';targetId:string;label:string;siteId:string;parentAreaId:string}
  | {kind:'rename_site'|'rename_area'|'rename_environment';targetId:string;label:string}
  | {kind:'retire_empty_site'|'retire_empty_area'|'retire_empty_environment';targetId:string}
  | {kind:'reparent_area';targetId:string;parentAreaId:string}
  | {kind:'set_asset_placement';targetId:string;desired:null|{
      areaId:string;parentAssetId:string;environmentId:string;role:'host'|'gateway'|'device'|null}};
export const physicalHierarchyKinds:readonly Kind[]=['add_site','rename_site','retire_empty_site',
  'add_area','rename_area','reparent_area','retire_empty_area',
  'add_environment','rename_environment','retire_empty_environment','set_asset_placement'];
export const physicalHierarchyCodes=['UNAUTHENTICATED','SESSION_EXPIRED','ORIGIN_REJECTED','SCOPE_DENIED','INVALID_INPUT',
  'REVISION_CONFLICT','PREVIEW_EXPIRED','CONFIG_CHANGED','RECOVERY_REQUIRED','UNMANAGED_COLLISION',
  'OWNED_CONFIG_DRIFT','NOT_SUPPORTED','OWNER_UNAVAILABLE','LIMIT_EXCEEDED','BUSY'] as const;
export class PhysicalHierarchyUiError extends Error {
  constructor(readonly code:'INVALID_SOURCE_RESPONSE'|'INVALID_INPUT'|'LIMIT_EXCEEDED'|'PREVIEW_EXPIRED'|'BUSY'='INVALID_SOURCE_RESPONSE'){
    super('The physical hierarchy request or response could not be used.');
  }
}
function check(value:unknown,code:PhysicalHierarchyUiError['code']='INVALID_SOURCE_RESPONSE'):asserts value {
  if(!value)throw new PhysicalHierarchyUiError(code);
}
function exact(value:unknown,keys:readonly string[]):Record<string,unknown>{
  check(value!==null&&typeof value==='object'&&!Array.isArray(value));
  check(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);
  const descriptors=Object.getOwnPropertyDescriptors(value);
  check(Object.getOwnPropertySymbols(value).length===0&&Object.keys(descriptors).length===keys.length&&
    keys.every(key=>Object.hasOwn(descriptors,key)&&descriptors[key].enumerable&&Object.hasOwn(descriptors[key],'value')));
  return value as Record<string,unknown>;
}
const bytes=(value:string)=>new TextEncoder().encode(value).length;
function string(value:unknown,cap:number,empty=false):string {
  check(typeof value==='string'&&(empty||value.length>0)&&bytes(value)<=cap&&!/[\u0000-\u001f\u007f]/u.test(value));
  for(let i=0;i<value.length;i++){
    const n=value.charCodeAt(i);
    if(n>=0xd800&&n<=0xdbff){const next=value.charCodeAt(++i);check(next>=0xdc00&&next<=0xdfff);}
    else check(n<0xdc00||n>0xdfff);
  }
  return value;
}
function id(value:unknown,empty=false):string {
  const result=string(value,64,empty);
  check(empty&&result===''||/^[A-Za-z][A-Za-z0-9._-]{0,63}$/u.test(result));return result;
}
function integer(value:unknown,min=1,max=Number.MAX_SAFE_INTEGER-1):number {
  check(typeof value==='number'&&Number.isSafeInteger(value)&&value>=min&&value<=max);return value;
}
function member<T extends string>(value:unknown,values:readonly T[]):T{
  check(typeof value==='string'&&values.includes(value as T));return value as T;
}
const privacy=(v:unknown)=>member(v,['public','internal'] as const);
const nullable=<T>(v:unknown,decode:(v:unknown)=>T):T|null=>v===null?null:decode(v);
function list<T>(value:unknown,cap:number,decode:(value:unknown)=>T):T[]{
  check(Array.isArray(value)&&value.length<=cap);
  check(Object.keys(value).length===value.length);return value.map(decode);
}
function ordered<T>(rows:readonly T[],key:(value:T)=>string):void {
  let previous:string|null=null;
  for(const row of rows){const next=key(row);check(previous===null||previous<next);previous=next;}
}
function same(a:unknown,b:unknown):boolean {
  if(a===b)return true;
  if(a===null||b===null||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return false;
  const aa=a as Record<string,unknown>,bb=b as Record<string,unknown>,keys=Object.keys(aa);
  return keys.length===Object.keys(bb).length&&keys.every(k=>Object.hasOwn(bb,k)&&same(aa[k],bb[k]));
}
function freeze<T>(value:T):T{
  if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;
}
function bounded<T>(value:T):T {
  check(bytes(JSON.stringify({apiVersion:1,requestId:'x'.repeat(43),ok:true,data:value}))<=256*1024,'LIMIT_EXCEEDED');
  return freeze(value);
}
function ancestors(value:unknown,self=''):string[]{
  const result=list(value,31,v=>id(v));check(new Set(result).size===result.length&&!result.includes(self));return result;
}
function allowed(stored:'public'|'internal',effective:'public'|'internal',grant:Grant):void {
  check((grant.allowInternal||effective==='public')&&(stored!=='internal'||effective==='internal'));
}
function opaque(value:unknown):string{
  const result=string(value,43);check(result.length===43&&/^[A-Za-z0-9_-]+$/u.test(result));return result;
}
function time(value:unknown):string{
  const result=string(value,24);check(result.length===24&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(result)&&
    Number.isFinite(Date.parse(result))&&new Date(result).toISOString()===result);return result;
}
export function checkedPhysicalHierarchyScopes(value:unknown):readonly Grant[]{
  const o=exact(value,['projects']),rows=list(o.projects,500,v=>{
    const row=exact(v,['projectId','allowInternal']);check(typeof row.allowInternal==='boolean');
    return {projectId:id(row.projectId),allowInternal:row.allowInternal};
  });
  check(new Set(rows.map(r=>r.projectId)).size===rows.length);return bounded(rows);
}
function site(value:unknown):Site{
  const o=exact(value,['id','label','privacy']);return {id:id(o.id),label:string(o.label,120),privacy:privacy(o.privacy)};
}
function area(value:unknown):Area{
  const o=exact(value,['id','label','siteId','parentAreaId','privacy']);
  return {id:id(o.id),label:string(o.label,120),siteId:id(o.siteId),parentAreaId:id(o.parentAreaId,true),privacy:privacy(o.privacy)};
}
function asset(value:unknown):AssetAnchor{
  const o=exact(value,['id','label','site','kind','privacy']);
  return {id:id(o.id),label:string(o.label,120),site:id(o.site),
    kind:member(o.kind,['machine','gateway','broker','service','sensor'] as const),privacy:privacy(o.privacy)};
}
function placement(value:unknown):Placement{
  const o=exact(value,['assetId','areaId','parentAssetId','environmentId','role']);
  return {assetId:id(o.assetId),areaId:id(o.areaId,true),parentAssetId:id(o.parentAssetId,true),
    environmentId:id(o.environmentId,true),role:nullable(o.role,v=>member(v,['host','gateway','device'] as const))};
}
const entities:readonly EntityKind[]=['site','area','environment','asset'];
const entityKey=(kind:EntityKind,key:string)=>`${entities.indexOf(kind)}:${key}`;
const emptyPath=():Path=>({siteId:'',areaAncestors:[],assetAncestors:[],environmentId:''});
function physicalPath(value:unknown,kind:EntityKind,self:string):Path{
  const o=exact(value,['siteId','areaAncestors','assetAncestors','environmentId']);
  const p={siteId:id(o.siteId,true),areaAncestors:ancestors(o.areaAncestors,kind==='area'?self:''),
    assetAncestors:ancestors(o.assetAncestors,kind==='asset'?self:''),environmentId:id(o.environmentId,true)};
  if(kind==='environment')check(same(p,emptyPath()));
  if(kind==='site')check(p.areaAncestors.length===0&&p.assetAncestors.length===0&&p.environmentId===''&&(p.siteId===''||p.siteId===self));
  if(kind==='area')check(p.assetAncestors.length===0&&p.environmentId==='');
  if(kind==='asset')check(p.areaAncestors.length+p.assetAncestors.length<=31);
  return p;
}
type Classification=Site['privacy'];
const inherited=(...values:Classification[]):Classification=>values.includes('internal')?'internal':'public';
type Maps={sites:Map<string,Site>;areas:Map<string,Area>;environments:Map<string,Environment>;
  assets:Map<string,AssetAnchor>;placements:Map<string,Placement|null>;roots:Map<string,Classification>};
type ViewRow={kind:EntityKind;id:string;path:Path;classification:Classification};
function maps(state:State):Maps{
  return {sites:new Map(state.sites.map(r=>[r.value.id,r.value])),areas:new Map(state.areas.map(r=>[r.value.id,r.value])),
    environments:new Map(state.environments.map(r=>[r.value.id,r.value])),assets:new Map(state.assets.map(r=>[r.value.id,r.value])),
    placements:new Map(state.assets.map(r=>[r.value.id,r.placement])),
    roots:new Map([...state.sites.map(r=>[entityKey('site',r.value.id),r.classification] as const),
      ...state.environments.map(r=>[entityKey('environment',r.value.id),r.classification] as const)])};
}
/** Derive complete visible paths without inventing project privacy or hidden rows. */
function view(m:Maps):Map<string,ViewRow>{
  check(m.sites.size<=2000&&m.areas.size<=2000&&m.environments.size<=2000&&m.assets.size<=10000,'LIMIT_EXCEEDED');
  const result=new Map<string,ViewRow>();
  for(const [kind,rows] of [['site',m.sites],['environment',m.environments]] as const)
    for(const row of rows.values()){
      const key=entityKey(kind,row.id),classification=m.roots.get(key)??row.privacy;
      check(row.privacy!=='internal'||classification==='internal');
      result.set(key,{kind,id:row.id,path:kind==='site'?{...emptyPath(),siteId:row.id}:emptyPath(),classification});
    }
  const areaActive=new Set<string>();
  const areaView=(key:string):ViewRow=>{
    const known=result.get(entityKey('area',key));if(known)return known;
    check(!areaActive.has(key)&&areaActive.size<32);areaActive.add(key);
    const row=m.areas.get(key);check(row);const root=result.get(entityKey('site',row.siteId));check(root);
    let path:readonly string[]=[],classification=inherited(root.classification,row.privacy);
    if(row.parentAreaId){
      const parent=m.areas.get(row.parentAreaId);check(parent&&parent.siteId===row.siteId);
      const previous=areaView(parent.id);path=[...previous.path.areaAncestors,parent.id];
      classification=inherited(classification,previous.classification);
    }
    check(path.length<=31);areaActive.delete(key);
    const value={kind:'area' as const,id:key,path:{siteId:row.siteId,areaAncestors:path,assetAncestors:[],environmentId:''},classification};
    result.set(entityKey('area',key),value);return value;
  };
  for(const key of m.areas.keys())areaView(key);
  const assetActive=new Set<string>();
  const assetView=(key:string):ViewRow=>{
    const known=result.get(entityKey('asset',key));if(known)return known;
    check(!assetActive.has(key)&&assetActive.size<32);assetActive.add(key);
    const row=m.assets.get(key);check(row);const root=result.get(entityKey('site',row.site));check(root);
    const own=m.placements.get(key)??null;check(own===null||own.assetId===key);
    let areaAncestors:readonly string[]=[],assetAncestors:readonly string[]=[],classification=inherited(root.classification,row.privacy);
    if(own?.areaId){
      const parent=m.areas.get(own.areaId);check(parent&&parent.siteId===row.site);
      const path=areaView(parent.id);areaAncestors=[...path.path.areaAncestors,parent.id];classification=inherited(classification,path.classification);
    }
    if(own?.environmentId){
      const environment=result.get(entityKey('environment',own.environmentId));check(environment);
      classification=inherited(classification,environment.classification);
    }
    if(own?.parentAssetId){
      const parent=m.assets.get(own.parentAssetId),parentPlacement=m.placements.get(own.parentAssetId);
      check(parent&&parentPlacement&&parent.site===row.site&&parentPlacement.areaId===own.areaId&&parentPlacement.environmentId===own.environmentId);
      const path=assetView(parent.id);assetAncestors=[...path.path.assetAncestors,parent.id];classification=inherited(classification,path.classification);
    }
    check(areaAncestors.length+assetAncestors.length<=31);assetActive.delete(key);
    const value={kind:'asset' as const,id:key,path:{siteId:row.site,areaAncestors,assetAncestors,environmentId:own?.environmentId??''},classification};
    result.set(entityKey('asset',key),value);return value;
  };
  for(const key of m.assets.keys())assetView(key);
  return result;
}
export function checkedPhysicalHierarchyState(value:unknown,grant:Grant):State{
  const o=exact(value,['projectId','revision','sites','areas','environments','assets']);check(id(o.projectId)===grant.projectId);
  const catalog=(v:unknown)=>{
    const r=exact(v,['value','classification']),value=site(r.value),classification=privacy(r.classification);
    allowed(value.privacy,classification,grant);return {value,classification};
  };
  const sites=list(o.sites,2000,catalog),environments=list(o.environments,2000,catalog);
  const areas=list(o.areas,2000,v=>{
    const r=exact(v,['value','ancestors','classification']),value=area(r.value),path=ancestors(r.ancestors,value.id),classification=privacy(r.classification);
    allowed(value.privacy,classification,grant);return {value,ancestors:path,classification};
  });
  const assets=list(o.assets,10000,v=>{
    const r=exact(v,['value','placement','path','classification']),value=asset(r.value),own=nullable(r.placement,placement),
      path=physicalPath(r.path,'asset',value.id),classification=privacy(r.classification);
    check(own===null||own.assetId===value.id);allowed(value.privacy,classification,grant);return {value,placement:own,path,classification};
  });
  ordered(sites,r=>r.value.id);ordered(areas,r=>r.value.id);ordered(environments,r=>r.value.id);ordered(assets,r=>r.value.id);
  check(new Set([...sites,...environments].filter(r=>r.value.privacy==='public').map(r=>r.classification)).size<=1);
  const result={projectId:grant.projectId,revision:integer(o.revision),sites,areas,environments,assets},expected=view(maps(result));
  for(const row of areas){
    const wanted=expected.get(entityKey('area',row.value.id))!;
    check(same(row.ancestors,wanted.path.areaAncestors)&&row.classification===wanted.classification);
  }
  for(const row of assets){
    const wanted=expected.get(entityKey('asset',row.value.id))!;
    check(same(row.path,wanted.path)&&row.classification===wanted.classification);
  }
  return bounded(result);
}
function changeEntity(change:Change):EntityKind{
  return change.kind==='set_asset_placement'?'asset':change.kind.endsWith('_site')?'site':change.kind.endsWith('_area')?'area':'environment';
}
export function physicalChangeKey(change:Change):string{
  return entityKey(changeEntity(change),change.kind==='set_asset_placement'?change.expectedAsset.id:'desired' in change?change.desired.id:change.expected.id);
}
function checkedChange(value:unknown):Change{
  check(value!==null&&typeof value==='object'&&!Array.isArray(value));
  const kind=member((value as {kind?:unknown}).kind,physicalHierarchyKinds);
  switch(kind){
    case 'add_site':case 'add_environment':{
      const o=exact(value,['kind','desired']),desired=site(o.desired);check(desired.privacy==='internal');return {kind,desired};
    }
    case 'add_area':{const o=exact(value,['kind','desired']),desired=area(o.desired);check(desired.privacy==='internal');return {kind,desired};}
    case 'rename_site':case 'rename_environment':{
      const o=exact(value,['kind','expected','desiredLabel']);return {kind,expected:site(o.expected),desiredLabel:string(o.desiredLabel,120)};
    }
    case 'rename_area':{const o=exact(value,['kind','expected','desiredLabel']);return {kind,expected:area(o.expected),desiredLabel:string(o.desiredLabel,120)};}
    case 'reparent_area':{const o=exact(value,['kind','expected','desiredParentId']);return {kind,expected:area(o.expected),desiredParentId:id(o.desiredParentId,true)};}
    case 'retire_empty_site':case 'retire_empty_environment':{const o=exact(value,['kind','expected']);return {kind,expected:site(o.expected)};}
    case 'retire_empty_area':{const o=exact(value,['kind','expected']);return {kind,expected:area(o.expected)};}
    case 'set_asset_placement':{
      const o=exact(value,['kind','expectedAsset','expected','desired']),expectedAsset=asset(o.expectedAsset),
        expected=nullable(o.expected,placement),desired=nullable(o.desired,placement);
      check([expected,desired].every(p=>p===null||p.assetId===expectedAsset.id));return {kind,expectedAsset,expected,desired};
    }
  }
}
function inputError(error:unknown):never{
  if(error instanceof PhysicalHierarchyUiError&&error.code==='LIMIT_EXCEEDED')throw error;
  throw new PhysicalHierarchyUiError('INVALID_INPUT');
}
/** Every expectation is copied from the retained original state, never from a form. */
export function makePhysicalHierarchyChange(state:State,grant:Grant,input:DraftInput):Change{
  try{
    check(state.projectId===grant.projectId);member(input.kind,physicalHierarchyKinds);const target=id(input.targetId);
    let candidate:unknown;
    switch(input.kind){
      case 'add_site':case 'add_environment':
        exact(input,['kind','targetId','label']);check(grant.allowInternal);
        check(!(input.kind==='add_site'?state.sites:state.environments).some(r=>r.value.id===target));
        candidate={kind:input.kind,desired:{id:target,label:input.label,privacy:'internal'}};break;
      case 'add_area':
        exact(input,['kind','targetId','label','siteId','parentAreaId']);check(grant.allowInternal&&!state.areas.some(r=>r.value.id===target));
        candidate={kind:input.kind,desired:{id:target,label:input.label,siteId:input.siteId,parentAreaId:input.parentAreaId,privacy:'internal'}};break;
      case 'set_asset_placement':{
        exact(input,['kind','targetId','desired']);const row=state.assets.find(r=>r.value.id===target);check(row);
        if(input.desired!==null)exact(input.desired,['areaId','parentAssetId','environmentId','role']);
        candidate={kind:input.kind,expectedAsset:row.value,expected:row.placement,desired:input.desired===null?null:{assetId:target,...input.desired}};break;
      }
      default:{
        const row=(input.kind.endsWith('_site')?state.sites:input.kind.endsWith('_area')?state.areas:state.environments).find(r=>r.value.id===target);
        check(row);
        if(input.kind==='reparent_area'){
          exact(input,['kind','targetId','parentAreaId']);candidate={kind:input.kind,expected:row.value,desiredParentId:input.parentAreaId};
        }else if('label' in input){
          exact(input,['kind','targetId','label']);candidate={kind:input.kind,expected:row.value,desiredLabel:input.label};
        }else {exact(input,['kind','targetId']);candidate={kind:input.kind,expected:row.value};}
      }
    }
    return freeze(checkedChange(candidate));
  }catch(error){return inputError(error);}
}
export function addPhysicalHierarchyChange(changes:readonly Change[],change:Change,replace=false):readonly Change[]{
  try{
    const next=checkedChange(change),key=physicalChangeKey(next),index=changes.findIndex(c=>physicalChangeKey(c)===key);
    check(index<0||replace);const result=changes.map(c=>checkedChange(c));
    if(index<0)result.push(next);else result[index]=next;
    check(result.length<=32,'LIMIT_EXCEEDED');return freeze(result);
  }catch(error){return inputError(error);}
}
function references(p:Path):string[]{
  return [...(p.siteId?[entityKey('site',p.siteId)]:[]),...p.areaAncestors.map(x=>entityKey('area',x)),
    ...p.assetAncestors.map(x=>entityKey('asset',x)),...(p.environmentId?[entityKey('environment',p.environmentId)]:[])];
}
type Transition={before:Maps;after:Maps;oldView:Map<string,ViewRow>;newView:Map<string,ViewRow>;affected:Set<string>};
function transition(state:State,grant:Grant,changes:readonly Change[]):Transition{
  const before=maps(state),after=maps(state),oldView=view(before),touched=new Set(changes.map(physicalChangeKey));
  for(const op of changes){
    if(op.kind==='set_asset_placement'){
      check(same(before.assets.get(op.expectedAsset.id),op.expectedAsset)&&same(before.placements.get(op.expectedAsset.id),op.expected));
      after.placements.set(op.expectedAsset.id,op.desired);continue;
    }
    if(op.kind==='add_site'){check(grant.allowInternal&&!before.sites.has(op.desired.id));after.sites.set(op.desired.id,op.desired);continue;}
    if(op.kind==='add_area'){check(grant.allowInternal&&!before.areas.has(op.desired.id));after.areas.set(op.desired.id,op.desired);continue;}
    if(op.kind==='add_environment'){check(grant.allowInternal&&!before.environments.has(op.desired.id));after.environments.set(op.desired.id,op.desired);continue;}
    if(op.kind==='rename_site'||op.kind==='retire_empty_site'){
      check(same(before.sites.get(op.expected.id),op.expected));
      if(op.kind==='rename_site')after.sites.set(op.expected.id,{...op.expected,label:op.desiredLabel});else after.sites.delete(op.expected.id);
    }else if(op.kind==='rename_environment'||op.kind==='retire_empty_environment'){
      check(same(before.environments.get(op.expected.id),op.expected));
      if(op.kind==='rename_environment')after.environments.set(op.expected.id,{...op.expected,label:op.desiredLabel});else after.environments.delete(op.expected.id);
    }else{
      check(same(before.areas.get(op.expected.id),op.expected));
      if(op.kind==='rename_area')after.areas.set(op.expected.id,{...op.expected,label:op.desiredLabel});
      else if(op.kind==='reparent_area')after.areas.set(op.expected.id,{...op.expected,parentAreaId:op.desiredParentId});
      else after.areas.delete(op.expected.id);
    }
  }
  const newView=view(after),affected=new Set(touched);
  for(const [key,row] of [...oldView,...newView])if(references(row.path).some(p=>touched.has(p)))affected.add(key);
  for(const key of affected){
    const old=oldView.get(key),next=newView.get(key);
    check(grant.allowInternal||[old,next].every(r=>!r||r.classification==='public'));
    check(old?.classification!=='internal'||next?.classification!=='public');
  }
  return {before,after,oldView,newView,affected};
}
function changedRows(t:Transition):Pick<Diff,'sites'|'areas'|'environments'|'placements'>{
  const catalog=<T extends Site>(a:Map<string,T>,b:Map<string,T>)=>[...new Set([...a.keys(),...b.keys()])].sort()
    .filter(key=>!same(a.get(key)??null,b.get(key)??null)).map(key=>({id:key,before:a.get(key)??null,after:b.get(key)??null}));
  return {sites:catalog(t.before.sites,t.after.sites),areas:catalog(t.before.areas,t.after.areas),
    environments:catalog(t.before.environments,t.after.environments),
    placements:[...t.before.assets.keys()].sort().filter(key=>!same(t.before.placements.get(key),t.after.placements.get(key)))
      .map(key=>({assetId:key,before:t.before.placements.get(key)??null,after:t.after.placements.get(key)??null}))};
}
export function physicalHierarchyProposal(state:State,grant:Grant,changes:readonly Change[]):Proposal{
  try{
    state=checkedPhysicalHierarchyState(state,grant);check(state.revision<Number.MAX_SAFE_INTEGER-1);
    check(changes.length>=1&&changes.length<=32);
    const normalized=changes.map(checkedChange);check(new Set(normalized.map(physicalChangeKey)).size===normalized.length);
    normalized.sort((a,b)=>physicalChangeKey(a)<physicalChangeKey(b)?-1:1);
    let budget=256+2*bytes(JSON.stringify(state.projectId));
    for(const op of normalized){
      budget+=512;let fields:unknown[];
      if(op.kind==='set_asset_placement')fields=[...Object.values(op.expectedAsset),
        ...(op.expected?Object.values(op.expected).filter(v=>v!==null):[]),...(op.desired?Object.values(op.desired).filter(v=>v!==null):[])];
      else fields=[...Object.values('desired' in op?op.desired:op.expected),
        ...('desiredLabel' in op?[op.desiredLabel]:[]),...('desiredParentId' in op?[op.desiredParentId]:[])];
      for(const field of fields)budget+=bytes(JSON.stringify(field));
    }
    check(budget<=32768,'LIMIT_EXCEEDED');
    const changed=changedRows(transition(state,grant,normalized));check(Object.values(changed).some(rows=>rows.length>0));
    return freeze({projectId:state.projectId,expectedRevision:state.revision,changes:normalized});
  }catch(error){return inputError(error);}
}
export function checkedPhysicalHierarchyPreview(value:unknown,state:State,grant:Grant,proposal:Proposal):Preview{
  const o=exact(value,['id','projectId','revision','expiresAt','diff']);
  state=checkedPhysicalHierarchyState(state,grant);
  check(o.projectId===state.projectId&&o.revision===state.revision&&proposal.projectId===state.projectId&&proposal.expectedRevision===state.revision);
  // Revalidate the captured proposal, but never accept new expectations from a reply.
  const normalized=physicalHierarchyProposal(state,grant,proposal.changes);check(same(normalized,proposal));
  const t=transition(state,grant,proposal.changes),expected=changedRows(t);
  const d=exact(o.diff,['sites','areas','environments','placements','affected']);
  const catalog=<T extends Site>(value:unknown,decode:(v:unknown)=>T)=>list(value,32,v=>{
    const r=exact(v,['id','before','after']);return {id:id(r.id),before:nullable(r.before,decode),after:nullable(r.after,decode)};
  });
  const sites=catalog(d.sites,site),areas=catalog(d.areas,area),environments=catalog(d.environments,site);
  const placements=list(d.placements,32,v=>{
    const r=exact(v,['assetId','before','after']);return {assetId:id(r.assetId),before:nullable(r.before,placement),after:nullable(r.after,placement)};
  });
  check(same({sites,areas,environments,placements},expected));
  const affected=list(d.affected,16000,v=>{
    const r=exact(v,['kind','id','beforeClassification','afterClassification','beforePath','afterPath']),
      kind=member(r.kind,entities),key=id(r.id);
    return {kind,id:key,beforeClassification:nullable(r.beforeClassification,privacy),afterClassification:nullable(r.afterClassification,privacy),
      beforePath:physicalPath(r.beforePath,kind,key),afterPath:physicalPath(r.afterPath,kind,key)};
  });
  ordered(affected,r=>entityKey(r.kind,r.id));check(affected.length===t.affected.size);
  for(const row of affected){
    const key=entityKey(row.kind,row.id),old=t.oldView.get(key),next=t.newView.get(key);
    check(t.affected.has(key)&&row.beforeClassification===(old?.classification??null)&&row.afterClassification===(next?.classification??null));
    check(same(row.beforePath,old?.path??emptyPath())&&same(row.afterPath,next?.path??emptyPath()));
  }
  return bounded({id:opaque(o.id),projectId:state.projectId,revision:state.revision,expiresAt:time(o.expiresAt),
    diff:{sites,areas,environments,placements,affected}});
}
export type WriteStatus={admitted:boolean;recoveryRequired:boolean;projectOperations:boolean;activeWrites:number};
export function checkedPhysicalHierarchyWriteStatus(value:unknown):WriteStatus{
  const o=exact(value,['admitted','recoveryRequired','projectOperations','activeWrites']);
  check([o.admitted,o.recoveryRequired,o.projectOperations].every(v=>typeof v==='boolean'));
  return {admitted:o.admitted as boolean,recoveryRequired:o.recoveryRequired as boolean,projectOperations:o.projectOperations as boolean,activeWrites:integer(o.activeWrites,0,32)};
}
export function checkedPhysicalHierarchyResult(value:unknown,project:string,revision:number,operationId?:string):Result{
  const o=exact(value,['operationId','action','outcome','code','summary']),key=opaque(o.operationId);
  check(o.action==='physical-hierarchy-commit'&&(!operationId||key===operationId));
  const outcome=member(o.outcome,['pending','confirmed','refused','unknown'] as const),code=nullable(o.code,v=>member(v,physicalHierarchyCodes));
  check(outcome==='pending'||outcome==='confirmed'?code===null:code!==null);
  const summary=o.summary===null?null:(()=>{
    const s=exact(o.summary,['projectId','previousRevision','revision']);
    check(outcome==='confirmed'&&s.projectId===project&&s.previousRevision===revision&&s.revision===revision+1);
    return {projectId:project,previousRevision:integer(s.previousRevision),revision:integer(s.revision)};
  })();
  check(outcome==='confirmed'||summary===null);
  return bounded({operationId:key,action:'physical-hierarchy-commit',outcome,code,summary});
}
export function checkedPhysicalHierarchyJob(value:unknown,project:string,revision:number,operationId:string):Job{
  const o=exact(value,['operationId','state','result','errorCode']);check(o.operationId===opaque(operationId));
  const state=member(o.state,['pending','succeeded','failed','unknown'] as const),errorCode=nullable(o.errorCode,v=>member(v,physicalHierarchyCodes));
  if(state==='pending'){check(o.result===null&&errorCode===null);return {operationId,state,result:null,errorCode:null};}
  const result=checkedPhysicalHierarchyResult(o.result,project,revision,operationId);
  check(result.outcome===(state==='succeeded'?'confirmed':state==='failed'?'refused':'unknown'));
  check(errorCode===(state==='failed'?result.code:null));return bounded({operationId,state,result,errorCode});
}
export function checkedPhysicalHierarchyRejection(value:unknown):void{check(exact(value,['rejected']).rejected===true);}
export function physicalHierarchyErrorCode(error:unknown):string{
  const code=error&&typeof error==='object'&&'code' in error?error.code:null;
  return typeof code==='string'&&[...physicalHierarchyCodes,'NETWORK','INVALID_SOURCE_RESPONSE'].includes(code)?code:'NETWORK';
}
export function physicalHierarchyShouldPoll(submission:Submission|null,attempts:number,busy:boolean):boolean{
  return submission?.phase==='pending'&&!!submission.result?.operationId&&!busy&&attempts<40;
}
export interface PhysicalHierarchyReadTicket{readonly generation:number;readonly selection:string}
export class PhysicalHierarchyReadFence {
  private generation=0;
  invalidate():void{this.generation++;}
  begin(selection:string):PhysicalHierarchyReadTicket{return {generation:++this.generation,selection};}
  current(ticket:PhysicalHierarchyReadTicket):boolean{return ticket.generation===this.generation;}
  accepts(ticket:PhysicalHierarchyReadTicket,selection:string,mounted:boolean):boolean {
    return mounted&&this.current(ticket)&&ticket.selection===selection;
  }
}
export type Submission={project:string;revision:number;phase:'submitting'|'pending'|'confirmed'|'refused'|'unknown';result:Result|null;locked:boolean};
/** Synchronous one-use gate used directly by the component before any await. */
export class PhysicalHierarchyCommitGate {
  current:Submission|null=null;
  private lastPreview:string|null=null;
  private observedWriteStatus:WriteStatus|null=null;
  begin(preview:Preview,now:number):{previewId:string}{
    check(!this.current?.locked&&this.lastPreview!==preview.id,'BUSY');
    check(Date.parse(preview.expiresAt)>now,'PREVIEW_EXPIRED');this.lastPreview=preview.id;
    this.observedWriteStatus=null;
    this.current={project:preview.projectId,revision:preview.revision,phase:'submitting',result:null,locked:true};
    return {previewId:preview.id};
  }
  observe(result:Result):Submission{
    check(this.current);
    if(this.current.phase==='confirmed')return this.current;
    check(!this.current.result||this.current.result.operationId===result.operationId);
    this.observedWriteStatus=null;
    this.current={...this.current,phase:result.outcome,result,locked:result.outcome==='pending'||result.outcome==='unknown'};
    return this.current;
  }
  uncertain():Submission {
    check(this.current);
    this.observedWriteStatus=null;
    if(this.current.phase!=='confirmed'&&this.current.phase!=='refused')this.current={...this.current,phase:'unknown',locked:true};
    return this.current;
  }
  observeWriteStatus(status:WriteStatus,submission:Submission):void {
    check(this.current===submission&&this.current.phase==='unknown','BUSY');
    this.observedWriteStatus={...status};
  }
  canEndUnknown():boolean {
    return this.current?.phase==='unknown'&&this.current.locked&&!!this.observedWriteStatus?.admitted&&this.observedWriteStatus.activeWrites===0;
  }
  endUnknown():Submission {
    check(this.current&&this.canEndUnknown(),'BUSY');
    this.current={...this.current,locked:false};this.observedWriteStatus=null;return this.current;
  }
}
