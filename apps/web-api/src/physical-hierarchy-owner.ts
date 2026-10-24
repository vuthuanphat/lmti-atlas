import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { ApiError, exact, requireThat, strictJson, type Code } from './security.js';
import { ProcessPool, type WriteOptions } from './process.js';
import type { LibraryIdentity } from './project-operations-owner.js';
import { checkedPhysicalTarget, type PhysicalTarget, type RecoveryGuard } from './legacy-recovery-target.js';

// Private owner boundary. Expected tokens, native paths and digests are never
// public grants; the following service must retain them behind opaque reviews.
export type PhysicalHierarchyPrivacy = 'public'|'internal';
export interface PhysicalSite {readonly id:string;readonly label:string;readonly privacy:PhysicalHierarchyPrivacy}
export interface PhysicalArea extends PhysicalSite {readonly siteId:string;readonly parentAreaId:string}
export interface PhysicalEnvironment extends PhysicalSite {}
export interface PhysicalAssetAnchor extends PhysicalSite {
  readonly site:string;readonly kind:'machine'|'gateway'|'broker'|'service'|'sensor';
}
export interface PhysicalPlacement {
  readonly assetId:string;readonly areaId:string;readonly parentAssetId:string;readonly environmentId:string;
  readonly role:'host'|'gateway'|'device'|null;
}
export interface PhysicalHierarchyPath {
  readonly siteId:string;readonly areaAncestors:readonly string[];readonly assetAncestors:readonly string[];readonly environmentId:string;
}
export type PhysicalHierarchyChange =
  | {readonly kind:'add_site';readonly desired:PhysicalSite}
  | {readonly kind:'rename_site';readonly expected:PhysicalSite;readonly desiredLabel:string}
  | {readonly kind:'retire_empty_site';readonly expected:PhysicalSite}
  | {readonly kind:'add_area';readonly desired:PhysicalArea}
  | {readonly kind:'rename_area';readonly expected:PhysicalArea;readonly desiredLabel:string}
  | {readonly kind:'reparent_area';readonly expected:PhysicalArea;readonly desiredParentId:string}
  | {readonly kind:'retire_empty_area';readonly expected:PhysicalArea}
  | {readonly kind:'add_environment';readonly desired:PhysicalEnvironment}
  | {readonly kind:'rename_environment';readonly expected:PhysicalEnvironment;readonly desiredLabel:string}
  | {readonly kind:'retire_empty_environment';readonly expected:PhysicalEnvironment}
  | {readonly kind:'set_asset_placement';readonly expectedAsset:PhysicalAssetAnchor;
      readonly expected:PhysicalPlacement|null;readonly desired:PhysicalPlacement|null};
export interface PhysicalHierarchyProposal {
  readonly projectId:string;readonly expectedRevision:number;readonly changes:readonly PhysicalHierarchyChange[];
}
export interface PhysicalHierarchyGrant {readonly projectId:string; readonly allowInternal:boolean}
export interface PhysicalHierarchyOwnerConfig {
  readonly adminBinary:string; readonly library:string; readonly projects:readonly PhysicalHierarchyGrant[];
}
export interface PhysicalHierarchyProjectIdentity {
  readonly schemaVersion:2; readonly projectId:string; readonly canonicalPath:string; readonly storeUuid:string;
  readonly revision:number; readonly contentDigest:string; readonly registryDigest:string;
}
export interface PhysicalHierarchyReviewToken extends PhysicalHierarchyProjectIdentity {
  readonly schema:'lmti.physical-hierarchy.review.v1';
  readonly scope:{readonly projectId:string; readonly allowPhysicalWrite:true; readonly allowInternal:boolean};
  readonly proposal:PhysicalHierarchyProposal; readonly proposalDigest:string; readonly diffDigest:string;
}
export interface PhysicalHierarchyExpected {readonly libraryIdentity:LibraryIdentity; readonly reviewToken:PhysicalHierarchyReviewToken}
export type PhysicalHierarchyKind='site'|'area'|'environment'|'asset';
export interface PhysicalHierarchyAffected {
  readonly kind:PhysicalHierarchyKind;readonly id:string;
  readonly beforeClassification:PhysicalHierarchyPrivacy|null;readonly afterClassification:PhysicalHierarchyPrivacy|null;
  readonly beforePath:PhysicalHierarchyPath;readonly afterPath:PhysicalHierarchyPath;
}
type CatalogChange<T>={readonly id:string;readonly before:T|null;readonly after:T|null};
export interface PhysicalHierarchyDiff {
  readonly sites:readonly CatalogChange<PhysicalSite>[];
  readonly areas:readonly CatalogChange<PhysicalArea>[];
  readonly environments:readonly CatalogChange<PhysicalEnvironment>[];
  readonly placements:readonly {readonly assetId:string;readonly before:PhysicalPlacement|null;readonly after:PhysicalPlacement|null}[];
  readonly affected:readonly PhysicalHierarchyAffected[];
}
export interface PhysicalHierarchyProjection {
  readonly projectId:string;readonly revision:number;
  readonly sites:readonly {readonly value:PhysicalSite;readonly classification:PhysicalHierarchyPrivacy}[];
  readonly areas:readonly {readonly value:PhysicalArea;readonly ancestors:readonly string[];readonly classification:PhysicalHierarchyPrivacy}[];
  readonly environments:readonly {readonly value:PhysicalEnvironment;readonly classification:PhysicalHierarchyPrivacy}[];
  readonly assets:readonly {readonly value:PhysicalAssetAnchor;readonly placement:PhysicalPlacement|null;
    readonly path:PhysicalHierarchyPath;readonly classification:PhysicalHierarchyPrivacy}[];
}
export type PhysicalHierarchyReadRequest =
  | {readonly action:'physical-hierarchy-state'}
  | {readonly action:'physical-hierarchy-preview'; readonly proposal:PhysicalHierarchyProposal};
export interface PhysicalHierarchyOriginalExpected {
  readonly version:1; readonly projectId:string;
  readonly library:{readonly schema:1|2|3; readonly canonicalPath:string; readonly uuid:string|null; readonly physical:PhysicalTarget};
  readonly project:{readonly schema:2; readonly storeUuid:string; readonly physical:PhysicalTarget};
  readonly linkedRoot:string;
}
export interface PhysicalHierarchyLocator {
  readonly ok:true; readonly schema:'lmti.physical-hierarchy.owner.v1'; readonly action:'physical-hierarchy-locator';
  readonly libraryIdentity:LibraryIdentity; readonly projectId:string; readonly database:string; readonly linkedRoot:string;
}
export type PhysicalHierarchyState = Extract<PhysicalHierarchyReadResult,{action:'physical-hierarchy-state'}>;
export interface PhysicalHierarchyWriteRequest {
  readonly action:'physical-hierarchy-commit'; readonly expected:PhysicalHierarchyExpected;
}
type ReadBase<A extends string> = {readonly ok:true; readonly schema:'lmti.physical-hierarchy.owner.v1'; readonly action:A};
export type PhysicalHierarchyReadResult =
  | (ReadBase<'physical-hierarchy-state'> & {readonly libraryIdentity:LibraryIdentity;
      readonly projectIdentity:PhysicalHierarchyProjectIdentity; readonly projection:PhysicalHierarchyProjection})
  | (ReadBase<'physical-hierarchy-preview'> & {readonly expected:PhysicalHierarchyExpected; readonly diff:PhysicalHierarchyDiff});
export const nativePhysicalHierarchyCodes = ['NONE','INVALID_INPUT','SCOPE_DENIED','UNSUPPORTED_SCHEMA','UNSUPPORTED_FORMAT',
  'CONFIG_CHANGED','BUDGET_EXCEEDED','OWNER_UNAVAILABLE','RECOVERY_REQUIRED'] as const;
export type NativePhysicalHierarchyCode = typeof nativePhysicalHierarchyCodes[number];
export interface PhysicalHierarchyWriteReply {
  readonly schema:'lmti.project.operation.write.v1'; readonly action:'physical-hierarchy-commit'|null;
  readonly outcome:'refused'|'unknown'|'confirmed'; readonly code:NativePhysicalHierarchyCode; readonly operationId:null;
  readonly details:{readonly projectId:string; readonly storeUuid:string; readonly previousRevision:number;
    readonly revision:number; readonly proposalDigest:string}|null; readonly detailsAvailable:boolean;
}
export interface PhysicalHierarchyWriteResult {
  readonly started:boolean; readonly reply:PhysicalHierarchyWriteReply; readonly preflightCode:Code|null;
}
const max = Number.MAX_SAFE_INTEGER, inputCap = 64*1024, outputCap = 512*1024;
const need:(v:unknown)=>asserts v = v => requireThat(v,'INVALID_INPUT');
function one<T extends string|number|null>(value:unknown, choices:readonly T[]):T {
  need(choices.includes(value as T)); return value as T;
}
function integer(value:unknown, low=1, high=max):number {
  need(typeof value==='number' && Number.isSafeInteger(value) && value>=low && value<=high); return value;
}
function text(value:unknown, cap:number, empty=false):string {
  need(typeof value==='string' && (empty||value.length>0) && Buffer.byteLength(value)<=cap &&
    !/[\x00-\x1f\x7f]/.test(value) && Buffer.from(value).toString('utf8')===value); return value;
}
function id(value:unknown, empty=false):string {
  const result=text(value,64,empty);
  need((empty&&result==='') || /^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(result)); return result;
}
function bool(value:unknown):boolean {need(typeof value==='boolean'); return value;}
function uuid(value:unknown):string {
  const result=text(value,36);
  need(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(result) &&
    result!=='00000000-0000-0000-0000-000000000000'); return result;
}
function digest(value:unknown):string {const result=text(value,64); need(/^[0-9a-f]{64}$/.test(result)); return result;}
function path(value:unknown, identity=false):string {
  need(typeof value==='string' && value.length>0 && value.length<=1024 &&
    !/[\x00-\x1f\x7f]/.test(value) && Buffer.from(value).toString('utf8')===value);
  const p=value.replaceAll('\\','/');
  need(isAbsolute(value) && !p.startsWith('//') && !p.replace(/^[A-Za-z]:/,'').includes(':') &&
    (!identity||!value.includes('\\')));
  const parts=p.replace(/^[A-Za-z]:\//,'').replace(/^\//,'').split('/');
  need(parts.every((part,i)=>part==='' ? parts.length===1&&i===0 :
    part!=='.'&&part!=='..'&&!/[. ]$/.test(part)&&!/[\"<>|?*]/.test(part)&&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)));
  return value; // Native Qt Unicode folding is opaque; this is never an I/O locator.
}
function list<T>(value:unknown, cap:number, decode:(v:unknown)=>T):T[] {
  need(Array.isArray(value)&&value.length<=cap); return value.map(decode);
}
function nullable<T>(value:unknown, decode:(v:unknown)=>T):T|null {return value===null?null:decode(value);}
function freeze<T>(value:T):T {
  if(value&&typeof value==='object'){for(const child of Object.values(value)) freeze(child); Object.freeze(value);} return value;
}
function same(a:unknown,b:unknown):boolean {
  if(a===b)return true;
  if(!a||!b||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return false;
  const keys=Object.keys(a);
  return keys.length===Object.keys(b).length && keys.every(key=>Object.hasOwn(b,key)&&
    same((a as Record<string,unknown>)[key],(b as Record<string,unknown>)[key]));
}
function ordered<T>(rows:readonly T[], key:(v:T)=>string):void {
  need(rows.every((row,i)=>i===0||key(rows[i-1])<key(row)));
}
function privacy(value:unknown):PhysicalHierarchyPrivacy {return one(value,['public','internal'] as const);}
function grant(value:unknown):PhysicalHierarchyGrant {
  const o=exact(value,['projectId','allowInternal']); return {projectId:id(o.projectId),allowInternal:bool(o.allowInternal)};
}
function site(value:unknown):PhysicalSite {
  const o=exact(value,['id','label','privacy']);return {id:id(o.id),label:text(o.label,120),privacy:privacy(o.privacy)};
}
function area(value:unknown):PhysicalArea {
  const o=exact(value,['id','label','siteId','parentAreaId','privacy']);
  const result={id:id(o.id),label:text(o.label,120),siteId:id(o.siteId),parentAreaId:id(o.parentAreaId,true),privacy:privacy(o.privacy)};
  need(result.id!==result.parentAreaId);return result;
}
function asset(value:unknown):PhysicalAssetAnchor {
  const o=exact(value,['id','label','site','kind','privacy']);
  return {id:id(o.id),label:text(o.label,120),site:id(o.site),
    kind:one(o.kind,['machine','gateway','broker','service','sensor'] as const),privacy:privacy(o.privacy)};
}
function placement(value:unknown):PhysicalPlacement {
  const o=exact(value,['assetId','areaId','parentAssetId','environmentId','role']);
  const result={assetId:id(o.assetId),areaId:id(o.areaId,true),parentAssetId:id(o.parentAssetId,true),
    environmentId:id(o.environmentId,true),role:one(o.role,['host','gateway','device',null] as const)};
  need(result.assetId!==result.parentAssetId);return result;
}
function change(value:unknown):PhysicalHierarchyChange {
  need(value&&typeof value==='object'&&!Array.isArray(value));
  const kind=(value as Record<string,unknown>).kind;
  switch(kind){
    case 'add_site':case 'add_environment': {
      const o=exact(value,['kind','desired']),desired=site(o.desired);need(desired.privacy==='internal');return {kind,desired};
    }
    case 'add_area': {
      const o=exact(value,['kind','desired']),desired=area(o.desired);need(desired.privacy==='internal');return {kind,desired};
    }
    case 'rename_site':case 'rename_environment': {
      const o=exact(value,['kind','expected','desiredLabel']);return {kind,expected:site(o.expected),desiredLabel:text(o.desiredLabel,120)};
    }
    case 'rename_area': {
      const o=exact(value,['kind','expected','desiredLabel']);return {kind,expected:area(o.expected),desiredLabel:text(o.desiredLabel,120)};
    }
    case 'retire_empty_site':case 'retire_empty_environment': {
      const o=exact(value,['kind','expected']);return {kind,expected:site(o.expected)};
    }
    case 'retire_empty_area': {const o=exact(value,['kind','expected']);return {kind,expected:area(o.expected)};}
    case 'reparent_area': {
      const o=exact(value,['kind','expected','desiredParentId']),expected=area(o.expected),desiredParentId=id(o.desiredParentId,true);
      need(expected.id!==desiredParentId);return {kind,expected,desiredParentId};
    }
    case 'set_asset_placement': {
      const o=exact(value,['kind','expectedAsset','expected','desired']),expectedAsset=asset(o.expectedAsset);
      const expected=nullable(o.expected,placement),desired=nullable(o.desired,placement);
      need([expected,desired].every(row=>row===null||row.assetId===expectedAsset.id));
      return {kind,expectedAsset,expected,desired};
    }
    default:throw new ApiError('INVALID_INPUT');
  }
}
const kinds=['site','area','environment','asset'] as const;
function key(kind:PhysicalHierarchyKind,id:string):string {return String(kinds.indexOf(kind))+':'+id;}
function changeKind(op:PhysicalHierarchyChange):PhysicalHierarchyKind {
  return op.kind==='set_asset_placement'?'asset':op.kind.endsWith('_site')?'site':op.kind.endsWith('_area')?'area':'environment';
}
function target(op:PhysicalHierarchyChange):string {
  return key(changeKind(op),op.kind==='set_asset_placement'?op.expectedAsset.id:'desired' in op?op.desired.id:op.expected.id);
}
function siteFields(v:PhysicalSite):string[] {return [v.id,v.label,v.privacy];}
function areaFields(v:PhysicalArea):string[] {return [v.id,v.label,v.siteId,v.parentAreaId,v.privacy];}
function assetFields(v:PhysicalAssetAnchor):string[] {return [v.id,v.label,v.site,v.kind,v.privacy];}
function placementFields(v:PhysicalPlacement|null):unknown {
  return v===null?null:[v.assetId,v.areaId,v.parentAssetId,v.environmentId,v.role];
}
function changeFields(op:PhysicalHierarchyChange):unknown[] {
  switch(op.kind){
    case 'add_site':return ['add_site',siteFields(op.desired)];
    case 'rename_site':return ['rename_site',siteFields(op.expected),op.desiredLabel];
    case 'retire_empty_site':return ['retire_site',siteFields(op.expected)];
    case 'add_area':return ['add_area',areaFields(op.desired)];
    case 'rename_area':return ['rename_area',areaFields(op.expected),op.desiredLabel];
    case 'reparent_area':return ['reparent_area',areaFields(op.expected),op.desiredParentId];
    case 'retire_empty_area':return ['retire_area',areaFields(op.expected)];
    case 'add_environment':return ['add_environment',siteFields(op.desired)];
    case 'rename_environment':return ['rename_environment',siteFields(op.expected),op.desiredLabel];
    case 'retire_empty_environment':return ['retire_environment',siteFields(op.expected)];
    case 'set_asset_placement':return ['placement',assetFields(op.expectedAsset),placementFields(op.expected),placementFields(op.desired)];
  }
}
function proposal(value:unknown):PhysicalHierarchyProposal {
  const o=exact(value,['projectId','expectedRevision','changes']);
  const result={projectId:id(o.projectId),expectedRevision:integer(o.expectedRevision,1,max-1),changes:list(o.changes,32,change)};
  need(result.changes.length>0&&new Set(result.changes.map(target)).size===result.changes.length);
  let budget=256+2*Buffer.byteLength(JSON.stringify(result.projectId));
  for(const op of result.changes){
    budget+=512;
    let strings:string[];
    if(op.kind==='set_asset_placement'){
      strings=assetFields(op.expectedAsset);
      for(const p of [op.expected,op.desired])if(p)strings.push(p.assetId,p.areaId,p.parentAssetId,p.environmentId,...(p.role?[p.role]:[]));
    }else{
      const row='desired' in op?op.desired:op.expected;
      strings=[...(changeKind(op)==='area'?areaFields(row as PhysicalArea):siteFields(row)),
        ...('desiredLabel' in op?[op.desiredLabel]:[]),...('desiredParentId' in op?[op.desiredParentId]:[])];
    }
    for(const v of strings)budget+=Buffer.byteLength(JSON.stringify(v));
  }
  requireThat(budget<=32768,'LIMIT_EXCEEDED');
  result.changes.sort((a,b)=>target(a)<target(b)?-1:target(a)>target(b)?1:0);return result;
}
export function checkedPhysicalHierarchyProposal(value:unknown):PhysicalHierarchyProposal {return freeze(proposal(value));}
function library(value:unknown):LibraryIdentity {
  const o=exact(value,['schema','canonicalPath','uuid','generation','digest']),schema=one(o.schema,[1,2,3] as const);
  need(schema!==1||(o.uuid===null&&o.generation===null));
  return {schema,canonicalPath:path(o.canonicalPath,true),uuid:schema===1?null:uuid(o.uuid),
    generation:schema===1?null:integer(o.generation),digest:digest(o.digest)};
}
function projectIdentity(value:unknown):PhysicalHierarchyProjectIdentity {
  const o=exact(value,['schemaVersion','projectId','canonicalPath','storeUuid','revision','contentDigest','registryDigest']);
  need(o.schemaVersion===2);
  return {schemaVersion:2,projectId:id(o.projectId),canonicalPath:path(o.canonicalPath,true),storeUuid:uuid(o.storeUuid),
    revision:integer(o.revision,1,max-1),contentDigest:digest(o.contentDigest),registryDigest:digest(o.registryDigest)};
}
function proposalDigest(value:PhysicalHierarchyProposal, scope:PhysicalHierarchyReviewToken['scope']):string {
  return createHash('sha256').update(JSON.stringify(['lmti.physical-hierarchy.review.v1',scope.projectId,
    scope.allowPhysicalWrite,scope.allowInternal,value.projectId,String(value.expectedRevision),value.changes.map(changeFields)])).digest('hex');
}
function reviewToken(value:unknown, authority:PhysicalHierarchyGrant):PhysicalHierarchyReviewToken {
  const o=exact(value,['schema','schemaVersion','projectId','canonicalPath','storeUuid','revision','contentDigest',
    'registryDigest','scope','proposal','proposalDigest','diffDigest']);
  need(o.schema==='lmti.physical-hierarchy.review.v1');
  const identity=projectIdentity({schemaVersion:o.schemaVersion,projectId:o.projectId,canonicalPath:o.canonicalPath,
    storeUuid:o.storeUuid,revision:o.revision,contentDigest:o.contentDigest,registryDigest:o.registryDigest});
  const rawScope=exact(o.scope,['projectId','allowPhysicalWrite','allowInternal']);
  need(rawScope.allowPhysicalWrite===true);
  const scope={projectId:id(rawScope.projectId),allowPhysicalWrite:true,allowInternal:bool(rawScope.allowInternal)} as const;
  const normalized=proposal(o.proposal);
  need(same(normalized,o.proposal)&&identity.revision<=max-2&&identity.projectId===authority.projectId&&
    scope.projectId===authority.projectId&&scope.allowInternal===authority.allowInternal&&
    normalized.projectId===authority.projectId&&normalized.expectedRevision===identity.revision);
  const result={...identity,schema:'lmti.physical-hierarchy.review.v1',scope,proposal:normalized,
    proposalDigest:digest(o.proposalDigest),diffDigest:digest(o.diffDigest)} as const;
  need(proposalDigest(normalized,scope)===result.proposalDigest); return result;
}
function expected(value:unknown, authority:PhysicalHierarchyGrant):PhysicalHierarchyExpected {
  const o=exact(value,['libraryIdentity','reviewToken']);
  return {libraryIdentity:library(o.libraryIdentity),reviewToken:reviewToken(o.reviewToken,authority)};
}
export function checkedPhysicalHierarchyReadRequest(value:unknown, authority:PhysicalHierarchyGrant):PhysicalHierarchyReadRequest {
  const g=grant(authority); need(value&&typeof value==='object'&&!Array.isArray(value));
  if((value as Record<string,unknown>).action==='physical-hierarchy-state'){
    exact(value,['action']); return freeze({action:'physical-hierarchy-state'});
  }
  const o=exact(value,['action','proposal']); need(o.action==='physical-hierarchy-preview');
  const desired=proposal(o.proposal); requireThat(desired.projectId===g.projectId,'SCOPE_DENIED');
  return freeze({action:'physical-hierarchy-preview',proposal:desired});
}
export function checkedPhysicalHierarchyWriteRequest(value:unknown, authority:PhysicalHierarchyGrant):PhysicalHierarchyWriteRequest {
  const o=exact(value,['action','expected']); need(o.action==='physical-hierarchy-commit');
  return freeze({action:'physical-hierarchy-commit',expected:expected(o.expected,grant(authority))});
}
export function checkedPhysicalHierarchyOriginalExpected(value:unknown, authority:PhysicalHierarchyGrant):PhysicalHierarchyOriginalExpected {
  const g=grant(authority),o=exact(value,['version','projectId','library','project','linkedRoot']);
  need(o.version===1); const projectId=id(o.projectId); requireThat(projectId===g.projectId,'SCOPE_DENIED');
  const l=exact(o.library,['schema','canonicalPath','uuid','physical']),p=exact(o.project,['schema','storeUuid','physical']);
  const schema=one(l.schema,[1,2,3] as const); need(schema!==1||l.uuid===null); need(p.schema===2);
  const file=(v:unknown)=>{const result=checkedPhysicalTarget(v); need(result.kind==='file');
    requireThat(result.state==='present'&&result.chain.every(row=>row!==null),'RECOVERY_REQUIRED'); return result;};
  return freeze({version:1,projectId,library:{schema,canonicalPath:path(l.canonicalPath,true),uuid:schema===1?null:uuid(l.uuid),physical:file(l.physical)},
    project:{schema:2,storeUuid:uuid(p.storeUuid),physical:file(p.physical)},linkedRoot:o.linkedRoot===''?'':path(o.linkedRoot)});
}
// Metadata-only decoder used by retained coordination subjects; proposals stay
// in the consumed private review and are never persisted as replayable requests.
export function checkedPhysicalHierarchyRecoveryPins(value:unknown):{
  readonly libraryIdentity:LibraryIdentity; readonly projectIdentity:PhysicalHierarchyProjectIdentity; readonly proposalDigest:string; readonly diffDigest:string
} {
  const o=exact(value,['libraryIdentity','projectIdentity','proposalDigest','diffDigest']);
  return freeze({libraryIdentity:library(o.libraryIdentity),projectIdentity:projectIdentity(o.projectIdentity),
    proposalDigest:digest(o.proposalDigest),diffDigest:digest(o.diffDigest)});
}
function ancestors(value:unknown,self:string):string[] {
  const rows=list(value,31,v=>id(v));need(new Set(rows).size===rows.length&&!rows.includes(self));return rows;
}
function classification(stored:PhysicalHierarchyPrivacy,effective:PhysicalHierarchyPrivacy,g:PhysicalHierarchyGrant):void {
  need((g.allowInternal||effective==='public')&&(stored!=='internal'||effective==='internal'));
}
function inherited(...values:PhysicalHierarchyPrivacy[]):PhysicalHierarchyPrivacy {return values.includes('internal')?'internal':'public';}
function parentMatches(rows:readonly string[],parent:string):void {need((rows.at(-1)??'')===parent);}
const emptyPath=():PhysicalHierarchyPath=>({siteId:'',areaAncestors:[],assetAncestors:[],environmentId:''});
function physicalPath(value:unknown,kind:PhysicalHierarchyKind,self:string):PhysicalHierarchyPath {
  const o=exact(value,['siteId','areaAncestors','assetAncestors','environmentId']);
  const p={siteId:id(o.siteId,true),areaAncestors:ancestors(o.areaAncestors,kind==='area'?self:''),
    assetAncestors:ancestors(o.assetAncestors,kind==='asset'?self:''),environmentId:id(o.environmentId,true)};
  if(kind==='environment')need(same(p,emptyPath()));
  if(kind==='site')need(p.areaAncestors.length===0&&p.assetAncestors.length===0&&p.environmentId===''&&(p.siteId===''||p.siteId===self));
  if(kind==='area')need(p.assetAncestors.length===0&&p.environmentId==='');
  if(kind==='asset')need(p.areaAncestors.length+p.assetAncestors.length<=31);
  return p;
}
function projection(value:unknown,identity:PhysicalHierarchyProjectIdentity,g:PhysicalHierarchyGrant):PhysicalHierarchyProjection {
  const o=exact(value,['projectId','revision','sites','areas','environments','assets']);
  need(id(o.projectId)===identity.projectId&&integer(o.revision,1,max-1)===identity.revision);
  const catalog=(v:unknown)=>{const r=exact(v,['value','classification']),item=site(r.value),c=privacy(r.classification);
    classification(item.privacy,c,g);return {value:item,classification:c};};
  const sites=list(o.sites,2000,catalog),environments=list(o.environments,2000,catalog);
  const areas=list(o.areas,2000,v=>{
    const r=exact(v,['value','ancestors','classification']),item=area(r.value),a=ancestors(r.ancestors,item.id),c=privacy(r.classification);
    classification(item.privacy,c,g);parentMatches(a,item.parentAreaId);return {value:item,ancestors:a,classification:c};
  });
  const assets=list(o.assets,10000,v=>{
    const r=exact(v,['value','placement','path','classification']),item=asset(r.value),p=nullable(r.placement,placement);
    const result={value:item,placement:p,path:physicalPath(r.path,'asset',item.id),classification:privacy(r.classification)};
    need(p===null||p.assetId===item.id);classification(item.privacy,result.classification,g);
    need(result.path.siteId===item.site&&result.path.environmentId===(p?.environmentId??''));
    parentMatches(result.path.areaAncestors,p?.areaId??'');parentMatches(result.path.assetAncestors,p?.parentAssetId??'');
    return result;
  });
  ordered(sites,r=>r.value.id);ordered(areas,r=>r.value.id);ordered(environments,r=>r.value.id);ordered(assets,r=>r.value.id);
  const si=new Map(sites.map(r=>[r.value.id,r])),ai=new Map(areas.map(r=>[r.value.id,r])),
    ei=new Map(environments.map(r=>[r.value.id,r])),ti=new Map(assets.map(r=>[r.value.id,r]));
  // Project privacy is not in this DTO. All public stored root rows nevertheless
  // share its same effective classification; descendants have an exact visible site.
  need(new Set([...sites,...environments].filter(r=>r.value.privacy==='public').map(r=>r.classification)).size<=1);
  for(const row of areas){
    const s=si.get(row.value.siteId);need(s);
    const classes=[s.classification,row.value.privacy];
    row.ancestors.forEach((parent,i)=>{
      const a=ai.get(parent);need(a&&a.value.siteId===row.value.siteId&&same(a.ancestors,row.ancestors.slice(0,i)));
      classes.push(a.classification);
    });
    need(row.classification===inherited(...classes));
  }
  for(const row of assets){
    const s=si.get(row.value.site);need(s);const classes=[s.classification,row.value.privacy];
    row.path.areaAncestors.forEach((parent,i)=>{
      const a=ai.get(parent);need(a&&a.value.siteId===row.value.site&&same(a.ancestors,row.path.areaAncestors.slice(0,i)));
      classes.push(a.classification);
    });
    if(row.path.environmentId){const e=ei.get(row.path.environmentId);need(e);classes.push(e.classification);}
    row.path.assetAncestors.forEach((parent,i)=>{
      const a=ti.get(parent);need(a&&a.placement!==null&&a.value.site===row.value.site&&
        same(a.path.areaAncestors,row.path.areaAncestors)&&a.path.environmentId===row.path.environmentId&&
        same(a.path.assetAncestors,row.path.assetAncestors.slice(0,i)));
      classes.push(a.classification);
    });
    need(row.classification===inherited(...classes));
  }
  return {projectId:identity.projectId,revision:identity.revision,sites,areas,environments,assets};
}
function pathFields(p:PhysicalHierarchyPath):unknown[] {return [p.siteId,p.areaAncestors,p.assetAncestors,p.environmentId];}
function diffDigest(value:PhysicalHierarchyDiff):string {
  const h=createHash('sha256'),field=(v:string)=>{const b=Buffer.from(v);h.update(String(b.length)+':');h.update(b);},
    row=(v:unknown[])=>field(JSON.stringify(v));
  field('lmti.physical-hierarchy.diff.v1');
  const catalog=<T>(name:string,rows:readonly CatalogChange<T>[],fields:(v:T)=>unknown)=>{
    row([name,String(rows.length)]);for(const r of rows)row([r.id,r.before===null?null:fields(r.before),r.after===null?null:fields(r.after)]);
  };
  catalog('sites',value.sites,siteFields);catalog('areas',value.areas,areaFields);catalog('environments',value.environments,siteFields);
  row(['placements',String(value.placements.length)]);
  for(const r of value.placements)row([r.assetId,placementFields(r.before),placementFields(r.after)]);
  row(['affected',String(value.affected.length)]);
  for(const r of value.affected)row([r.kind,r.id,r.beforeClassification,r.afterClassification,pathFields(r.beforePath),pathFields(r.afterPath)]);
  return h.digest('hex');
}
function references(p:PhysicalHierarchyPath):string[] {
  return [...(p.siteId?[key('site',p.siteId)]:[]),...p.areaAncestors.map(v=>key('area',v)),
    ...p.assetAncestors.map(v=>key('asset',v)),...(p.environmentId?[key('environment',p.environmentId)]:[])];
}
function diff(value:unknown,token:PhysicalHierarchyReviewToken,g:PhysicalHierarchyGrant):PhysicalHierarchyDiff {
  const o=exact(value,['sites','areas','environments','placements','affected']);
  const catalog=<T extends PhysicalSite>(v:unknown,decode:(v:unknown)=>T):CatalogChange<T>[]=>list(v,32,item=>{
    const r=exact(item,['id','before','after']),i=id(r.id),before=nullable(r.before,decode),after=nullable(r.after,decode);
    need(!same(before,after)&&[before,after].every(x=>x===null||x.id===i));return {id:i,before,after};
  });
  const sites=catalog(o.sites,site),areas=catalog(o.areas,area),environments=catalog(o.environments,site);
  const placements=list(o.placements,32,item=>{
    const r=exact(item,['assetId','before','after']),assetId=id(r.assetId),before=nullable(r.before,placement),after=nullable(r.after,placement);
    need(!same(before,after)&&[before,after].every(x=>x===null||x.assetId===assetId));return {assetId,before,after};
  });
  const affected=list(o.affected,16000,item=>{
    const r=exact(item,['kind','id','beforeClassification','afterClassification','beforePath','afterPath']),
      kind=one(r.kind,kinds),i=id(r.id);
    const result={kind,id:i,beforeClassification:nullable(r.beforeClassification,privacy),afterClassification:nullable(r.afterClassification,privacy),
      beforePath:physicalPath(r.beforePath,kind,i),afterPath:physicalPath(r.afterPath,kind,i)};
    need(result.beforeClassification!==null||result.afterClassification!==null);
    need(result.beforeClassification!=='internal'||result.afterClassification!=='public');
    for(const side of ['before','after'] as const){
      const c=result[`${side}Classification`],p=result[`${side}Path`];
      need(c===null?same(p,emptyPath()):(kind==='environment'||p.siteId!==''));
      need(g.allowInternal||c===null||c==='public');
    }
    if(kind==='asset')need(result.beforeClassification!==null&&result.afterClassification!==null);
    return result;
  });
  ordered(sites,r=>r.id);ordered(areas,r=>r.id);ordered(environments,r=>r.id);ordered(placements,r=>r.assetId);
  ordered(affected,r=>key(r.kind,r.id));
  const count=sites.length+areas.length+environments.length+placements.length;need(count>0&&count<=32);
  const changed=new Map<string,{before:PhysicalSite|PhysicalPlacement|null;after:PhysicalSite|PhysicalPlacement|null}>();
  for(const [kind,rows] of [['site',sites],['area',areas],['environment',environments]] as const)
    for(const r of rows)changed.set(key(kind,r.id),r);
  for(const r of placements)changed.set(key('asset',r.assetId),r);
  const index=new Map(affected.map(r=>[key(r.kind,r.id),r])),targets=new Set(token.proposal.changes.map(target)),
    adds=new Set<string>(),retires=new Set<string>();
  for(const op of token.proposal.changes){
    const k=target(op),entry=index.get(k);need(entry);
    const actual=changed.get(k);
    if(op.kind==='set_asset_placement'){
      need(same(op.expected,op.desired)?actual===undefined:!!actual&&same(actual.before,op.expected)&&same(actual.after,op.desired));
      for(const [side,p] of [['before',op.expected],['after',op.desired]] as const){
        const path=entry[`${side}Path`],c=entry[`${side}Classification`];need(c!==null);
        need(path.siteId===op.expectedAsset.site&&path.environmentId===(p?.environmentId??''));
        parentMatches(path.areaAncestors,p?.areaId??'');parentMatches(path.assetAncestors,p?.parentAssetId??'');
        classification(op.expectedAsset.privacy,c,g);
      }
    }else{
      const before='desired' in op?null:op.expected;
      const after='desired' in op?op.desired:op.kind.startsWith('retire_')?null:
        'desiredLabel' in op?{...op.expected,label:op.desiredLabel}:
        op.kind==='reparent_area'?{...op.expected,parentAreaId:op.desiredParentId}:null;
      need(same(before,after)?actual===undefined:!!actual&&same(actual.before,before)&&same(actual.after,after));
      for(const [side,row] of [['before',before],['after',after]] as const){
        const c=entry[`${side}Classification`],p=entry[`${side}Path`];
        need((c===null)===(row===null));
        if(row){
          classification(row.privacy,c!,g);
          if(entry.kind==='site')need(p.siteId===row.id);
          if(entry.kind==='area'){
            need('siteId' in row&&'parentAreaId' in row&&p.siteId===row.siteId);
            parentMatches(p.areaAncestors,(row as PhysicalArea).parentAreaId);
          }
        }else (side==='before'?adds:retires).add(k);
      }
    }
  }
  need([...changed.keys()].every(k=>targets.has(k)));
  for(const entry of affected){
    const k=key(entry.kind,entry.id);
    need(targets.has(k)||[...references(entry.beforePath),...references(entry.afterPath)].some(v=>targets.has(v)));
    need(entry.beforeClassification!==null||adds.has(k));need(entry.afterClassification!==null||retires.has(k));
    if(entry.kind==='area'&&entry.beforeClassification!==null&&entry.afterClassification!==null)
      need(entry.beforePath.siteId===entry.afterPath.siteId);
    if(entry.kind==='asset')need(entry.beforePath.siteId===entry.afterPath.siteId);
    if(!targets.has(k)){
      need(entry.beforeClassification!==null&&entry.afterClassification!==null);
      if(entry.kind==='area')parentMatches(entry.afterPath.areaAncestors,entry.beforePath.areaAncestors.at(-1)??'');
      if(entry.kind==='asset'){
        parentMatches(entry.afterPath.areaAncestors,entry.beforePath.areaAncestors.at(-1)??'');
        parentMatches(entry.afterPath.assetAncestors,entry.beforePath.assetAncestors.at(-1)??'');
        need(entry.beforePath.environmentId===entry.afterPath.environmentId);
      }
    }
    for(const side of ['before','after'] as const){
      const p=entry[`${side}Path`],c=entry[`${side}Classification`];
      for(const ref of references(p)){
        need(!(side==='before'?adds:retires).has(ref));
        const parent=index.get(ref);if(!parent||ref===k)continue;
        const pc=parent[`${side}Classification`],pp=parent[`${side}Path`];
        need(pc!==null&&(pc!=='internal'||c==='internal'));
        if(parent.kind==='site')need(pp.siteId===p.siteId);
        if(parent.kind==='area'){
          const i=p.areaAncestors.indexOf(parent.id);need(i>=0&&pp.siteId===p.siteId&&same(pp.areaAncestors,p.areaAncestors.slice(0,i)));
        }
        if(parent.kind==='asset'){
          const i=p.assetAncestors.indexOf(parent.id);need(i>=0&&pp.siteId===p.siteId&&pp.environmentId===p.environmentId&&
            same(pp.areaAncestors,p.areaAncestors)&&same(pp.assetAncestors,p.assetAncestors.slice(0,i)));
        }
      }
    }
  }
  const result={sites,areas,environments,placements,affected};need(diffDigest(result)===token.diffDigest);return result;
}
export function nativePhysicalHierarchyCodeToApi(value:NativePhysicalHierarchyCode):Code|null {
  switch(value){
    case 'NONE':return null;
    case 'UNSUPPORTED_SCHEMA':case 'UNSUPPORTED_FORMAT':return 'NOT_SUPPORTED';
    case 'BUDGET_EXCEEDED':return 'LIMIT_EXCEEDED';
    default:return value;
  }
}
class NativeReadRefusal extends ApiError {}
function readResult(value:unknown, request:PhysicalHierarchyReadRequest, authority:PhysicalHierarchyGrant):PhysicalHierarchyReadResult {
  need(value&&typeof value==='object'&&!Array.isArray(value));
  const raw=value as Record<string,unknown>;
  if(raw.ok===false){
    const error=exact(value,['ok','code']),native=one(error.code,nativePhysicalHierarchyCodes);
    need(native!=='NONE'); throw new NativeReadRefusal(nativePhysicalHierarchyCodeToApi(native)!);
  }
  need(raw.ok===true&&raw.schema==='lmti.physical-hierarchy.owner.v1'&&raw.action===request.action);
  if(request.action==='physical-hierarchy-state'){
    const o=exact(value,['ok','schema','action','libraryIdentity','projectIdentity','projection']),identity=projectIdentity(o.projectIdentity);
    need(identity.projectId===authority.projectId);
    return {ok:true,schema:'lmti.physical-hierarchy.owner.v1',action:request.action,
      libraryIdentity:library(o.libraryIdentity),projectIdentity:identity,projection:projection(o.projection,identity,authority)};
  }
  const o=exact(value,['ok','schema','action','expected','diff']),review=expected(o.expected,authority);
  need(same(review.reviewToken.proposal,request.proposal));
  const result={ok:true,schema:'lmti.physical-hierarchy.owner.v1',action:request.action,expected:review,
    diff:diff(o.diff,review.reviewToken,authority)} as const;
  requireThat(Buffer.byteLength(JSON.stringify({action:'physical-hierarchy-commit',expected:review})+'\n')<=inputCap,'LIMIT_EXCEEDED');
  return result;
}
function frame(bytes:Uint8Array):unknown {
  need(bytes.byteLength>0&&bytes.byteLength<=outputCap&&bytes[bytes.byteLength-1]===10);
  return strictJson(bytes,false,16000);
}
export function decodePhysicalHierarchyRead(bytes:Uint8Array, request:PhysicalHierarchyReadRequest, authority:PhysicalHierarchyGrant):PhysicalHierarchyReadResult {
  const g=grant(authority),r=checkedPhysicalHierarchyReadRequest(request,g);
  try{return freeze(readResult(frame(bytes),r,g));}
  catch(error){if(error instanceof NativeReadRefusal)throw new ApiError(error.code); throw new ApiError('OWNER_UNAVAILABLE');}
}
function writeReply(value:unknown, request:PhysicalHierarchyWriteRequest):PhysicalHierarchyWriteReply {
  const o=exact(value,['schema','action','outcome','code','operationId','details','detailsAvailable']);
  need(o.schema==='lmti.project.operation.write.v1'&&o.operationId===null);
  const action=one(o.action,['physical-hierarchy-commit',null] as const);
  const outcome=one(o.outcome,['refused','confirmed','unknown'] as const),code=one(o.code,nativePhysicalHierarchyCodes);
  const detailsAvailable=bool(o.detailsAvailable);
  need((outcome==='confirmed')===(code==='NONE')&&(o.details!==null)===detailsAvailable);
  need(action!==null||(outcome==='refused'&&code==='INVALID_INPUT'&&!detailsAvailable));
  let details:PhysicalHierarchyWriteReply['details']=null;
  if(detailsAvailable){
    need(outcome==='confirmed'&&action==='physical-hierarchy-commit');
    const d=exact(o.details,['projectId','storeUuid','previousRevision','revision','proposalDigest']),t=request.expected.reviewToken;
    details={projectId:id(d.projectId),storeUuid:uuid(d.storeUuid),previousRevision:integer(d.previousRevision,1,max-2),
      revision:integer(d.revision,2,max-1),proposalDigest:digest(d.proposalDigest)};
    need(details.projectId===t.projectId&&details.storeUuid===t.storeUuid&&details.previousRevision===t.revision&&
      details.revision===t.revision+1&&details.proposalDigest===t.proposalDigest);
  }
  return {schema:'lmti.project.operation.write.v1',action,outcome,code,operationId:null,details,detailsAvailable};
}
export function decodePhysicalHierarchyWrite(bytes:Uint8Array, request:PhysicalHierarchyWriteRequest, authority:PhysicalHierarchyGrant):PhysicalHierarchyWriteReply {
  const r=checkedPhysicalHierarchyWriteRequest(request,grant(authority));
  try{return freeze(writeReply(frame(bytes),r));}catch{throw new ApiError('OWNER_UNAVAILABLE');}
}
function fallback(outcome:'refused'|'unknown',code:NativePhysicalHierarchyCode='OWNER_UNAVAILABLE'):PhysicalHierarchyWriteReply {
  return {schema:'lmti.project.operation.write.v1',action:'physical-hierarchy-commit',outcome,code,
    operationId:null,details:null,detailsAvailable:false};
}
export class PhysicalHierarchyOwner {
  readonly config:PhysicalHierarchyOwnerConfig;
  constructor(config:PhysicalHierarchyOwnerConfig,private readonly pool:ProcessPool,
    private readonly verifyPool:ProcessPool=new ProcessPool(1)){
    const o=exact(config,['adminBinary','library','projects']),projects=list(o.projects,500,grant);
    need(projects.length>0&&new Set(projects.map(v=>v.projectId)).size===projects.length);
    projects.sort((a,b)=>a.projectId<b.projectId?-1:a.projectId>b.projectId?1:0);
    this.config=freeze({adminBinary:path(o.adminBinary),library:path(o.library),projects});
  }
  has(projectId:string):boolean {return this.config.projects.some(v=>v.projectId===projectId);}
  private authority(projectId:string):PhysicalHierarchyGrant {
    const found=this.config.projects.find(v=>v.projectId===id(projectId));
    requireThat(found,'SCOPE_DENIED'); return found;
  }
  private args(projectId:string,write:boolean):string[] {
    const g=this.authority(projectId);
    return [write?'--physical-hierarchy-write':'--physical-hierarchy-read','--library',this.config.library,
      '--project',g.projectId,'--visibility',g.allowInternal?'internal':'public'];
  }
  async read(projectId:string,request:PhysicalHierarchyReadRequest,
    options:{guard?:()=>void|Promise<void>;verify?:boolean}={}):Promise<PhysicalHierarchyReadResult>{
    const g=this.authority(projectId),r=checkedPhysicalHierarchyReadRequest(request,g),input=JSON.stringify(r);
    requireThat(Buffer.byteLength(input)<=inputCap,'LIMIT_EXCEEDED');
    const value=await (options.verify?this.verifyPool:this.pool).run(this.config.adminBinary,this.args(projectId,false),input,
      {cap:outputCap,guard:options.guard,newlineTerminated:true,jsonArrayLimit:16000,timeoutMs:30000});
    try{return freeze(readResult(value,r,g));}
    catch(error){if(error instanceof NativeReadRefusal)throw new ApiError(error.code); throw new ApiError('OWNER_UNAVAILABLE');}
  }
  async locator(projectId:string,options:{guard?:RecoveryGuard;verify?:boolean}={}):Promise<PhysicalHierarchyLocator>{
    const g=this.authority(projectId);
    const raw=await (options.verify?this.verifyPool:this.pool).run(this.config.adminBinary,this.args(projectId,false),
      JSON.stringify({action:'physical-hierarchy-locator'}),{cap:outputCap,newlineTerminated:true,timeoutMs:30000,guard:options.guard});
    try {
      if(raw&&typeof raw==='object'&&(raw as {ok?:unknown}).ok===false)
        readResult(raw,{action:'physical-hierarchy-state'},g);
      const o=exact(raw,['ok','schema','action','libraryIdentity','projectId','database','linkedRoot']);
      need(o.ok===true&&o.schema==='lmti.physical-hierarchy.owner.v1'&&o.action==='physical-hierarchy-locator'&&id(o.projectId)===g.projectId);
      return freeze({ok:true,schema:'lmti.physical-hierarchy.owner.v1',action:'physical-hierarchy-locator',
        libraryIdentity:library(o.libraryIdentity),projectId:g.projectId,database:path(o.database),linkedRoot:o.linkedRoot===''?'':path(o.linkedRoot)});
    } catch(error) {if(error instanceof NativeReadRefusal)throw new ApiError(error.code);throw new ApiError('OWNER_UNAVAILABLE');}
  }
  async originalState(projectId:string,value:PhysicalHierarchyOriginalExpected,options:{guard?:RecoveryGuard}={}):Promise<PhysicalHierarchyState>{
    const g=this.authority(projectId),expected=checkedPhysicalHierarchyOriginalExpected(value,g);
    requireThat(expected.library.physical.path===this.config.library,'SCOPE_DENIED');
    const input=JSON.stringify({action:'physical-hierarchy-original-state',expected});
    requireThat(Buffer.byteLength(input)<=inputCap,'LIMIT_EXCEEDED');
    const raw=await this.verifyPool.run(this.config.adminBinary,this.args(projectId,false),input,
      {cap:outputCap,newlineTerminated:true,timeoutMs:30000,guard:options.guard,jsonArrayLimit:16000});
    try {
      if(raw&&typeof raw==='object'&&(raw as {ok?:unknown}).ok===false)
        readResult(raw,{action:'physical-hierarchy-state'},g);
      const o=exact(raw,['ok','schema','action','libraryIdentity','projectIdentity','projection']);
      need(o.action==='physical-hierarchy-original-state');
      const result=readResult({...o,action:'physical-hierarchy-state'},{action:'physical-hierarchy-state'},g) as PhysicalHierarchyState;
      need(result.libraryIdentity.schema===expected.library.schema&&result.libraryIdentity.uuid===expected.library.uuid&&
        result.libraryIdentity.canonicalPath===expected.library.canonicalPath&&result.projectIdentity.storeUuid===expected.project.storeUuid);
      return freeze(result);
    } catch(error) {if(error instanceof NativeReadRefusal)throw new ApiError(error.code);throw new ApiError('OWNER_UNAVAILABLE');}
  }
  async write(projectId:string,request:PhysicalHierarchyWriteRequest,
    options:Pick<WriteOptions,'guard'|'onStarted'>={}):Promise<PhysicalHierarchyWriteResult>{
    const g=this.authority(projectId),r=checkedPhysicalHierarchyWriteRequest(request,g),input=JSON.stringify(r);
    requireThat(Buffer.byteLength(input)<=inputCap,'LIMIT_EXCEEDED');
    let observedStart=false,result:Awaited<ReturnType<ProcessPool['runWrite']>>;
    try{
      result=await this.pool.runWrite(this.config.adminBinary,this.args(projectId,true),input,
        {cap:outputCap,guard:options.guard,onStarted:()=>{observedStart=true; options.onStarted?.();}});
    }catch{return freeze({started:true,reply:fallback('unknown'),preflightCode:null});}
    if(result.kind==='not_started'&&!observedStart){
      const code=nativePhysicalHierarchyCodes.includes(result.code as NativePhysicalHierarchyCode)?result.code as NativePhysicalHierarchyCode:'OWNER_UNAVAILABLE';
      return freeze({started:false,reply:fallback('refused',code),preflightCode:result.code});
    }
    if(result.kind!=='closed'||!result.transportOk||result.exitCode!==0||result.bytes===null)
      return freeze({started:true,reply:fallback('unknown'),preflightCode:null});
    try{return freeze({started:true,reply:decodePhysicalHierarchyWrite(result.bytes,r,g),preflightCode:null});}
    catch{return freeze({started:true,reply:fallback('unknown'),preflightCode:null});}
  }
}
