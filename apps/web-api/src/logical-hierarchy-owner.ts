import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { ApiError, exact, requireThat, strictJson, type Code } from './security.js';
import { ProcessPool, type WriteOptions } from './process.js';
import type { LibraryIdentity } from './project-operations-owner.js';
import { checkedPhysicalTarget, type PhysicalTarget, type RecoveryGuard } from './legacy-recovery-target.js';

// Private owner boundary. Expected tokens, native paths and digests are never
// public grants; the following service must retain them behind opaque reviews.
export type HierarchyPrivacy = 'public'|'internal';
export interface LogicalSubsystem {
  readonly id:string; readonly label:string; readonly parentSubsystemId:string; readonly privacy:HierarchyPrivacy;
}
export interface LogicalComponent {
  readonly id:string; readonly label:string; readonly repositoryId:string;
  readonly kind:'firmware'|'gateway'|'backend'|'desktop'|'driver'|'library'; readonly privacy:HierarchyPrivacy;
}
export interface LogicalMembership {readonly componentId:string; readonly subsystemId:string}
export type LogicalHierarchyChange =
  | {readonly kind:'add_subsystem'; readonly desired:LogicalSubsystem}
  | {readonly kind:'rename_subsystem'; readonly expected:LogicalSubsystem; readonly desiredLabel:string}
  | {readonly kind:'reparent_subsystem'; readonly expected:LogicalSubsystem; readonly desiredParentId:string}
  | {readonly kind:'set_component_membership'; readonly expectedComponent:LogicalComponent;
      readonly expected:LogicalMembership|null; readonly desiredSubsystemId:string|null}
  | {readonly kind:'retire_empty_subsystem'; readonly expected:LogicalSubsystem};
export interface LogicalHierarchyProposal {
  readonly projectId:string; readonly expectedRevision:number; readonly changes:readonly LogicalHierarchyChange[];
}
export interface LogicalHierarchyGrant {readonly projectId:string; readonly allowInternal:boolean}
export interface LogicalHierarchyOwnerConfig {
  readonly adminBinary:string; readonly library:string; readonly projects:readonly LogicalHierarchyGrant[];
}
export interface HierarchyProjectIdentity {
  readonly schemaVersion:2; readonly projectId:string; readonly canonicalPath:string; readonly storeUuid:string;
  readonly revision:number; readonly contentDigest:string; readonly registryDigest:string;
}
export interface HierarchyReviewToken extends HierarchyProjectIdentity {
  readonly schema:'lmti.logical-hierarchy.review.v1';
  readonly scope:{readonly projectId:string; readonly allowLogicalWrite:true; readonly allowInternal:boolean};
  readonly proposal:LogicalHierarchyProposal; readonly proposalDigest:string; readonly diffDigest:string;
}
export interface HierarchyExpected {readonly libraryIdentity:LibraryIdentity; readonly reviewToken:HierarchyReviewToken}
export interface HierarchyAffected {
  readonly kind:'subsystem'|'component'; readonly id:string;
  readonly beforeClassification:HierarchyPrivacy|null; readonly afterClassification:HierarchyPrivacy|null;
  readonly beforeAncestors:readonly string[]; readonly afterAncestors:readonly string[];
}
export interface LogicalHierarchyDiff {
  readonly subsystems:readonly {readonly id:string; readonly before:LogicalSubsystem|null; readonly after:LogicalSubsystem|null}[];
  readonly memberships:readonly {readonly componentId:string; readonly before:LogicalMembership|null; readonly after:LogicalMembership|null}[];
  readonly affected:readonly HierarchyAffected[];
}
export interface LogicalHierarchyProjection {
  readonly projectId:string; readonly revision:number;
  readonly subsystems:readonly {readonly value:LogicalSubsystem; readonly ancestors:readonly string[]; readonly classification:HierarchyPrivacy}[];
  readonly components:readonly {readonly value:LogicalComponent; readonly membership:LogicalMembership|null;
    readonly ancestors:readonly string[]; readonly classification:HierarchyPrivacy}[];
}
export type LogicalHierarchyReadRequest =
  | {readonly action:'logical-hierarchy-state'}
  | {readonly action:'logical-hierarchy-preview'; readonly proposal:LogicalHierarchyProposal};
export interface LogicalHierarchyOriginalExpected {
  readonly version:1; readonly projectId:string;
  readonly library:{readonly schema:1|2|3; readonly canonicalPath:string; readonly uuid:string|null; readonly physical:PhysicalTarget};
  readonly project:{readonly schema:2; readonly storeUuid:string; readonly physical:PhysicalTarget};
  readonly linkedRoot:string;
}
export interface LogicalHierarchyLocator {
  readonly ok:true; readonly schema:'lmti.logical-hierarchy.owner.v1'; readonly action:'logical-hierarchy-locator';
  readonly libraryIdentity:LibraryIdentity; readonly projectId:string; readonly database:string; readonly linkedRoot:string;
}
export type LogicalHierarchyState = Extract<LogicalHierarchyReadResult,{action:'logical-hierarchy-state'}>;
export interface LogicalHierarchyWriteRequest {
  readonly action:'logical-hierarchy-commit'; readonly expected:HierarchyExpected;
}
type ReadBase<A extends string> = {readonly ok:true; readonly schema:'lmti.logical-hierarchy.owner.v1'; readonly action:A};
export type LogicalHierarchyReadResult =
  | (ReadBase<'logical-hierarchy-state'> & {readonly libraryIdentity:LibraryIdentity;
      readonly projectIdentity:HierarchyProjectIdentity; readonly projection:LogicalHierarchyProjection})
  | (ReadBase<'logical-hierarchy-preview'> & {readonly expected:HierarchyExpected; readonly diff:LogicalHierarchyDiff});
export const nativeHierarchyCodes = ['NONE','INVALID_INPUT','SCOPE_DENIED','UNSUPPORTED_SCHEMA','UNSUPPORTED_FORMAT',
  'CONFIG_CHANGED','BUDGET_EXCEEDED','OWNER_UNAVAILABLE','RECOVERY_REQUIRED'] as const;
export type NativeHierarchyCode = typeof nativeHierarchyCodes[number];
export interface LogicalHierarchyWriteReply {
  readonly schema:'lmti.project.operation.write.v1'; readonly action:'logical-hierarchy-commit'|null;
  readonly outcome:'refused'|'unknown'|'confirmed'; readonly code:NativeHierarchyCode; readonly operationId:null;
  readonly details:{readonly projectId:string; readonly storeUuid:string; readonly previousRevision:number;
    readonly revision:number; readonly proposalDigest:string}|null; readonly detailsAvailable:boolean;
}
export interface LogicalHierarchyWriteResult {
  readonly started:boolean; readonly reply:LogicalHierarchyWriteReply; readonly preflightCode:Code|null;
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
function privacy(value:unknown):HierarchyPrivacy {return one(value,['public','internal'] as const);}
function grant(value:unknown):LogicalHierarchyGrant {
  const o=exact(value,['projectId','allowInternal']); return {projectId:id(o.projectId),allowInternal:bool(o.allowInternal)};
}
function subsystem(value:unknown):LogicalSubsystem {
  const o=exact(value,['id','label','parentSubsystemId','privacy']);
  const result={id:id(o.id),label:text(o.label,120),parentSubsystemId:id(o.parentSubsystemId,true),privacy:privacy(o.privacy)};
  need(result.id!==result.parentSubsystemId); return result;
}
function component(value:unknown):LogicalComponent {
  const o=exact(value,['id','label','repositoryId','kind','privacy']);
  return {id:id(o.id),label:text(o.label,120),repositoryId:id(o.repositoryId,true),
    kind:one(o.kind,['firmware','gateway','backend','desktop','driver','library'] as const),privacy:privacy(o.privacy)};
}
function membership(value:unknown):LogicalMembership {
  const o=exact(value,['componentId','subsystemId']); return {componentId:id(o.componentId),subsystemId:id(o.subsystemId)};
}
function change(value:unknown):LogicalHierarchyChange {
  need(value&&typeof value==='object'&&!Array.isArray(value));
  const kind=(value as Record<string,unknown>).kind;
  switch(kind){
    case 'add_subsystem': {
      const o=exact(value,['kind','desired']),desired=subsystem(o.desired);
      need(desired.privacy==='internal'); return {kind,desired};
    }
    case 'rename_subsystem': {
      const o=exact(value,['kind','expected','desiredLabel']);
      return {kind,expected:subsystem(o.expected),desiredLabel:text(o.desiredLabel,120)};
    }
    case 'reparent_subsystem': {
      const o=exact(value,['kind','expected','desiredParentId']),expected=subsystem(o.expected),desiredParentId=id(o.desiredParentId,true);
      need(expected.id!==desiredParentId); return {kind,expected,desiredParentId};
    }
    case 'retire_empty_subsystem': {const o=exact(value,['kind','expected']); return {kind,expected:subsystem(o.expected)};}
    case 'set_component_membership': {
      const o=exact(value,['kind','expectedComponent','expected','desiredSubsystemId']);
      const result={kind,expectedComponent:component(o.expectedComponent),expected:nullable(o.expected,membership),
        desiredSubsystemId:nullable(o.desiredSubsystemId,v=>id(v))} as const;
      need(result.expected===null||result.expected.componentId===result.expectedComponent.id); return result;
    }
    default:throw new ApiError('INVALID_INPUT');
  }
}
function target(value:LogicalHierarchyChange):string {
  return value.kind==='set_component_membership'?'1:'+value.expectedComponent.id:
    '0:'+(value.kind==='add_subsystem'?value.desired.id:value.expected.id);
}
function subsystemFields(value:LogicalSubsystem):string[] {
  return [value.id,value.label,value.parentSubsystemId,value.privacy];
}
function componentFields(value:LogicalComponent):string[] {
  return [value.id,value.label,value.repositoryId,value.kind,value.privacy];
}
function membershipFields(value:LogicalMembership|null):unknown {
  return value===null?null:[value.componentId,value.subsystemId];
}
function changeFields(value:LogicalHierarchyChange):unknown[] {
  switch(value.kind){
    case 'add_subsystem':return ['add',subsystemFields(value.desired)];
    case 'rename_subsystem':return ['rename',subsystemFields(value.expected),value.desiredLabel];
    case 'reparent_subsystem':return ['reparent',subsystemFields(value.expected),value.desiredParentId];
    case 'retire_empty_subsystem':return ['retire',subsystemFields(value.expected)];
    case 'set_component_membership':return ['membership',componentFields(value.expectedComponent),
      membershipFields(value.expected),value.desiredSubsystemId];
  }
}
function proposal(value:unknown):LogicalHierarchyProposal {
  const o=exact(value,['projectId','expectedRevision','changes']);
  const result={projectId:id(o.projectId),expectedRevision:integer(o.expectedRevision,1,max-1),changes:list(o.changes,32,change)};
  need(result.changes.length>0 && new Set(result.changes.map(target)).size===result.changes.length);
  // Match the native conservative proposal budget, including scope framing.
  let budget=256+2*Buffer.byteLength(JSON.stringify(result.projectId));
  for(const row of result.changes){
    budget+=512;
    const strings:string[]=row.kind==='add_subsystem'?subsystemFields(row.desired):
      row.kind==='set_component_membership'?[...componentFields(row.expectedComponent),
        ...(row.expected?[row.expected.componentId,row.expected.subsystemId]:[]),
        ...(row.desiredSubsystemId===null?[]:[row.desiredSubsystemId])]:
      [...subsystemFields(row.expected),...(row.kind==='rename_subsystem'?[row.desiredLabel]:
        row.kind==='reparent_subsystem'?[row.desiredParentId]:[])];
    for(const item of strings) budget+=Buffer.byteLength(JSON.stringify(item));
  }
  requireThat(budget<=32768,'LIMIT_EXCEEDED');
  result.changes.sort((a,b)=>target(a)<target(b)?-1:target(a)>target(b)?1:0);
  return result;
}
export function checkedLogicalHierarchyProposal(value:unknown):LogicalHierarchyProposal {return freeze(proposal(value));}
function library(value:unknown):LibraryIdentity {
  const o=exact(value,['schema','canonicalPath','uuid','generation','digest']),schema=one(o.schema,[1,2,3] as const);
  need(schema!==1||(o.uuid===null&&o.generation===null));
  return {schema,canonicalPath:path(o.canonicalPath,true),uuid:schema===1?null:uuid(o.uuid),
    generation:schema===1?null:integer(o.generation),digest:digest(o.digest)};
}
function projectIdentity(value:unknown):HierarchyProjectIdentity {
  const o=exact(value,['schemaVersion','projectId','canonicalPath','storeUuid','revision','contentDigest','registryDigest']);
  need(o.schemaVersion===2);
  return {schemaVersion:2,projectId:id(o.projectId),canonicalPath:path(o.canonicalPath,true),storeUuid:uuid(o.storeUuid),
    revision:integer(o.revision,1,max-1),contentDigest:digest(o.contentDigest),registryDigest:digest(o.registryDigest)};
}
function proposalDigest(value:LogicalHierarchyProposal, scope:HierarchyReviewToken['scope']):string {
  return createHash('sha256').update(JSON.stringify(['lmti.logical-hierarchy.review.v1',scope.projectId,
    scope.allowLogicalWrite,scope.allowInternal,value.projectId,String(value.expectedRevision),value.changes.map(changeFields)])).digest('hex');
}
function reviewToken(value:unknown, authority:LogicalHierarchyGrant):HierarchyReviewToken {
  const o=exact(value,['schema','schemaVersion','projectId','canonicalPath','storeUuid','revision','contentDigest',
    'registryDigest','scope','proposal','proposalDigest','diffDigest']);
  need(o.schema==='lmti.logical-hierarchy.review.v1');
  const identity=projectIdentity({schemaVersion:o.schemaVersion,projectId:o.projectId,canonicalPath:o.canonicalPath,
    storeUuid:o.storeUuid,revision:o.revision,contentDigest:o.contentDigest,registryDigest:o.registryDigest});
  const rawScope=exact(o.scope,['projectId','allowLogicalWrite','allowInternal']);
  need(rawScope.allowLogicalWrite===true);
  const scope={projectId:id(rawScope.projectId),allowLogicalWrite:true,allowInternal:bool(rawScope.allowInternal)} as const;
  const normalized=proposal(o.proposal);
  need(same(normalized,o.proposal)&&identity.revision<=max-2&&identity.projectId===authority.projectId&&
    scope.projectId===authority.projectId&&scope.allowInternal===authority.allowInternal&&
    normalized.projectId===authority.projectId&&normalized.expectedRevision===identity.revision);
  const result={...identity,schema:'lmti.logical-hierarchy.review.v1',scope,proposal:normalized,
    proposalDigest:digest(o.proposalDigest),diffDigest:digest(o.diffDigest)} as const;
  need(proposalDigest(normalized,scope)===result.proposalDigest); return result;
}
function expected(value:unknown, authority:LogicalHierarchyGrant):HierarchyExpected {
  const o=exact(value,['libraryIdentity','reviewToken']);
  return {libraryIdentity:library(o.libraryIdentity),reviewToken:reviewToken(o.reviewToken,authority)};
}
export function checkedLogicalHierarchyReadRequest(value:unknown, authority:LogicalHierarchyGrant):LogicalHierarchyReadRequest {
  const g=grant(authority); need(value&&typeof value==='object'&&!Array.isArray(value));
  if((value as Record<string,unknown>).action==='logical-hierarchy-state'){
    exact(value,['action']); return freeze({action:'logical-hierarchy-state'});
  }
  const o=exact(value,['action','proposal']); need(o.action==='logical-hierarchy-preview');
  const desired=proposal(o.proposal); requireThat(desired.projectId===g.projectId,'SCOPE_DENIED');
  return freeze({action:'logical-hierarchy-preview',proposal:desired});
}
export function checkedLogicalHierarchyWriteRequest(value:unknown, authority:LogicalHierarchyGrant):LogicalHierarchyWriteRequest {
  const o=exact(value,['action','expected']); need(o.action==='logical-hierarchy-commit');
  return freeze({action:'logical-hierarchy-commit',expected:expected(o.expected,grant(authority))});
}
export function checkedLogicalHierarchyOriginalExpected(value:unknown, authority:LogicalHierarchyGrant):LogicalHierarchyOriginalExpected {
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
export function checkedHierarchyRecoveryPins(value:unknown):{
  readonly libraryIdentity:LibraryIdentity; readonly projectIdentity:HierarchyProjectIdentity; readonly proposalDigest:string; readonly diffDigest:string
} {
  const o=exact(value,['libraryIdentity','projectIdentity','proposalDigest','diffDigest']);
  return freeze({libraryIdentity:library(o.libraryIdentity),projectIdentity:projectIdentity(o.projectIdentity),
    proposalDigest:digest(o.proposalDigest),diffDigest:digest(o.diffDigest)});
}
function ancestors(value:unknown, self:string, maxDepth:number):string[] {
  const result=list(value,maxDepth,v=>id(v)); need(new Set(result).size===result.length&&!result.includes(self)); return result;
}
function classification(stored:HierarchyPrivacy, effective:HierarchyPrivacy, authority:LogicalHierarchyGrant):void {
  need((authority.allowInternal||effective==='public') && (stored!=='internal'||effective==='internal'));
}
function parentMatches(path:readonly string[], parent:string):void {need((path.at(-1)??'')===parent);}
function projection(value:unknown, identity:HierarchyProjectIdentity, authority:LogicalHierarchyGrant):LogicalHierarchyProjection {
  const o=exact(value,['projectId','revision','subsystems','components']);
  need(id(o.projectId)===identity.projectId&&integer(o.revision,1,max-1)===identity.revision);
  const subsystems=list(o.subsystems,2000,v=>{
    const row=exact(v,['value','ancestors','classification']),item=subsystem(row.value);
    const result={value:item,ancestors:ancestors(row.ancestors,item.id,31),classification:privacy(row.classification)};
    classification(item.privacy,result.classification,authority); parentMatches(result.ancestors,item.parentSubsystemId); return result;
  });
  const components=list(o.components,2000,v=>{
    const row=exact(v,['value','membership','ancestors','classification']),item=component(row.value);
    // Component/subsystem ID namespaces are independent; a component may have
    // the same ID as a subsystem in its ancestry.
    const result={value:item,membership:nullable(row.membership,membership),
      ancestors:ancestors(row.ancestors,'',31),classification:privacy(row.classification)};
    need(result.membership===null||result.membership.componentId===item.id);
    classification(item.privacy,result.classification,authority);
    parentMatches(result.ancestors,result.membership?.subsystemId??''); return result;
  });
  ordered(subsystems,v=>v.value.id); ordered(components,v=>v.value.id);
  const index=new Map(subsystems.map(row=>[row.value.id,row]));
  for(const row of [...subsystems,...components]){
    row.ancestors.forEach((parent,i)=>{
      const ancestor=index.get(parent); need(ancestor&&same(ancestor.ancestors,row.ancestors.slice(0,i)));
      need(ancestor.classification!=='internal'||row.classification==='internal');
    });
  }
  return {projectId:identity.projectId,revision:identity.revision,subsystems,components};
}
function diffDigest(value:LogicalHierarchyDiff):string {
  const hash=createHash('sha256');
  const field=(value:string)=>{const bytes=Buffer.from(value); hash.update(String(bytes.length)+':'); hash.update(bytes);};
  const row=(value:unknown[])=>field(JSON.stringify(value));
  field('lmti.logical-hierarchy.diff.v1');
  row(['subsystems',String(value.subsystems.length)]);
  for(const item of value.subsystems)row([item.id,item.before===null?null:subsystemFields(item.before),
    item.after===null?null:subsystemFields(item.after)]);
  row(['memberships',String(value.memberships.length)]);
  for(const item of value.memberships)row([item.componentId,membershipFields(item.before),membershipFields(item.after)]);
  row(['affected',String(value.affected.length)]);
  for(const item of value.affected)row([item.kind,item.id,item.beforeClassification,item.afterClassification,
    item.beforeAncestors,item.afterAncestors]);
  return hash.digest('hex');
}
function diff(value:unknown, token:HierarchyReviewToken, authority:LogicalHierarchyGrant):LogicalHierarchyDiff {
  const o=exact(value,['subsystems','memberships','affected']);
  const subsystems=list(o.subsystems,32,v=>{
    const row=exact(v,['id','before','after']),key=id(row.id);
    const before=nullable(row.before,subsystem),after=nullable(row.after,subsystem);
    need((before!==null||after!==null)&&!same(before,after)&&[before,after].every(v=>v===null||v.id===key));
    return {id:key,before,after};
  });
  const memberships=list(o.memberships,32,v=>{
    const row=exact(v,['componentId','before','after']),componentId=id(row.componentId);
    const before=nullable(row.before,membership),after=nullable(row.after,membership);
    need(!same(before,after)&&[before,after].every(v=>v===null||v.componentId===componentId));
    return {componentId,before,after};
  });
  const affected=list(o.affected,4000,v=>{
    const row=exact(v,['kind','id','beforeClassification','afterClassification','beforeAncestors','afterAncestors']);
    const kind=one(row.kind,['subsystem','component'] as const),key=id(row.id);
    const result={kind,id:key,beforeClassification:nullable(row.beforeClassification,privacy),
      afterClassification:nullable(row.afterClassification,privacy),
      beforeAncestors:ancestors(row.beforeAncestors,kind==='subsystem'?key:'',31),
      afterAncestors:ancestors(row.afterAncestors,kind==='subsystem'?key:'',31)};
    need(result.beforeClassification!==null||result.afterClassification!==null);
    need(result.beforeClassification!==null||result.beforeAncestors.length===0);
    need(result.afterClassification!==null||result.afterAncestors.length===0);
    need(result.beforeClassification!=='internal'||result.afterClassification!=='public');
    need(authority.allowInternal||[result.beforeClassification,result.afterClassification].every(v=>v===null||v==='public'));
    if(kind==='component')need(result.beforeClassification!==null&&result.afterClassification!==null);
    return result;
  });
  ordered(subsystems,v=>v.id); ordered(memberships,v=>v.componentId);
  ordered(affected,v=>(v.kind==='subsystem'?'0:':'1:')+v.id);
  need(subsystems.length+memberships.length>0 && subsystems.length+memberships.length<=32);
  const affectedIndex=new Map(affected.map(v=>[(v.kind==='subsystem'?'0:':'1:')+v.id,v]));
  const changedSubsystems=new Map(subsystems.map(v=>[v.id,v]));
  const changedMemberships=new Map(memberships.map(v=>[v.componentId,v]));
  const targets=new Set(token.proposal.changes.map(target));
  const touchedSubsystems=new Set(token.proposal.changes.filter(v=>v.kind!=='set_component_membership').map(v=>target(v).slice(2)));
  const adds=new Set<string>(),retires=new Set<string>();
  for(const op of token.proposal.changes){
    const key=target(op),entry=affectedIndex.get(key); need(entry);
    if(op.kind==='set_component_membership'){
      const after=op.desiredSubsystemId===null?null:{componentId:op.expectedComponent.id,subsystemId:op.desiredSubsystemId};
      const actual=changedMemberships.get(op.expectedComponent.id);
      need(same(op.expected,after)?actual===undefined:
        actual!==undefined&&same(actual.before,op.expected)&&same(actual.after,after));
      parentMatches(entry.beforeAncestors,op.expected?.subsystemId??''); parentMatches(entry.afterAncestors,after?.subsystemId??'');
      need(entry.beforeClassification!==null&&entry.afterClassification!==null);
      classification(op.expectedComponent.privacy,entry.beforeClassification,authority);
      classification(op.expectedComponent.privacy,entry.afterClassification,authority);
    }else{
      const before=op.kind==='add_subsystem'?null:op.expected;
      const after=op.kind==='add_subsystem'?op.desired:op.kind==='retire_empty_subsystem'?null:
        op.kind==='rename_subsystem'?{...op.expected,label:op.desiredLabel}:{...op.expected,parentSubsystemId:op.desiredParentId};
      const actual=changedSubsystems.get(key.slice(2));
      need(same(before,after)?actual===undefined:actual!==undefined&&same(actual.before,before)&&same(actual.after,after));
      need((entry.beforeClassification===null)===(before===null)&&(entry.afterClassification===null)===(after===null));
      if(before){parentMatches(entry.beforeAncestors,before.parentSubsystemId); classification(before.privacy,entry.beforeClassification!,authority);}
      else adds.add(entry.id);
      if(after){parentMatches(entry.afterAncestors,after.parentSubsystemId); classification(after.privacy,entry.afterClassification!,authority);}
      else retires.add(entry.id);
    }
  }
  need(subsystems.every(v=>targets.has('0:'+v.id))&&memberships.every(v=>targets.has('1:'+v.componentId)));
  for(const entry of affected){
    const key=(entry.kind==='subsystem'?'0:':'1:')+entry.id;
    need(targets.has(key)||[...entry.beforeAncestors,...entry.afterAncestors].some(v=>touchedSubsystems.has(v)));
    need(entry.beforeClassification!==null||(entry.kind==='subsystem'&&adds.has(entry.id)));
    need(entry.afterClassification!==null||(entry.kind==='subsystem'&&retires.has(entry.id)));
    need(!entry.afterAncestors.some(v=>retires.has(v))&&!entry.beforeAncestors.some(v=>adds.has(v)));
    if(!targets.has(key))parentMatches(entry.afterAncestors,entry.beforeAncestors.at(-1)??'');
    for(const side of ['before','after'] as const){
      const path=side==='before'?entry.beforeAncestors:entry.afterAncestors;
      const effective=side==='before'?entry.beforeClassification:entry.afterClassification;
      path.forEach((id,i)=>{
        const parent=affectedIndex.get('0:'+id);
        if(parent){
          const parentPrivacy=side==='before'?parent.beforeClassification:parent.afterClassification;
          need(parentPrivacy!==null&&same(side==='before'?parent.beforeAncestors:parent.afterAncestors,path.slice(0,i)));
          need(parentPrivacy!=='internal'||effective==='internal');
        }
      });
    }
  }
  const result={subsystems,memberships,affected};
  need(diffDigest(result)===token.diffDigest); return result;
}
export function nativeHierarchyCodeToApi(value:NativeHierarchyCode):Code|null {
  switch(value){
    case 'NONE':return null;
    case 'UNSUPPORTED_SCHEMA':case 'UNSUPPORTED_FORMAT':return 'NOT_SUPPORTED';
    case 'BUDGET_EXCEEDED':return 'LIMIT_EXCEEDED';
    default:return value;
  }
}
class NativeReadRefusal extends ApiError {}
function readResult(value:unknown, request:LogicalHierarchyReadRequest, authority:LogicalHierarchyGrant):LogicalHierarchyReadResult {
  need(value&&typeof value==='object'&&!Array.isArray(value));
  const raw=value as Record<string,unknown>;
  if(raw.ok===false){
    const error=exact(value,['ok','code']),native=one(error.code,nativeHierarchyCodes);
    need(native!=='NONE'); throw new NativeReadRefusal(nativeHierarchyCodeToApi(native)!);
  }
  need(raw.ok===true&&raw.schema==='lmti.logical-hierarchy.owner.v1'&&raw.action===request.action);
  if(request.action==='logical-hierarchy-state'){
    const o=exact(value,['ok','schema','action','libraryIdentity','projectIdentity','projection']),identity=projectIdentity(o.projectIdentity);
    need(identity.projectId===authority.projectId);
    return {ok:true,schema:'lmti.logical-hierarchy.owner.v1',action:request.action,
      libraryIdentity:library(o.libraryIdentity),projectIdentity:identity,projection:projection(o.projection,identity,authority)};
  }
  const o=exact(value,['ok','schema','action','expected','diff']),review=expected(o.expected,authority);
  need(same(review.reviewToken.proposal,request.proposal));
  const result={ok:true,schema:'lmti.logical-hierarchy.owner.v1',action:request.action,expected:review,
    diff:diff(o.diff,review.reviewToken,authority)} as const;
  requireThat(Buffer.byteLength(JSON.stringify({action:'logical-hierarchy-commit',expected:review}))<=inputCap,'LIMIT_EXCEEDED');
  return result;
}
function frame(bytes:Uint8Array):unknown {
  need(bytes.byteLength>0&&bytes.byteLength<=outputCap&&bytes[bytes.byteLength-1]===10);
  return strictJson(bytes,false,4000);
}
export function decodeLogicalHierarchyRead(bytes:Uint8Array, request:LogicalHierarchyReadRequest, authority:LogicalHierarchyGrant):LogicalHierarchyReadResult {
  const g=grant(authority),r=checkedLogicalHierarchyReadRequest(request,g);
  try{return freeze(readResult(frame(bytes),r,g));}
  catch(error){if(error instanceof NativeReadRefusal)throw new ApiError(error.code); throw new ApiError('OWNER_UNAVAILABLE');}
}
function writeReply(value:unknown, request:LogicalHierarchyWriteRequest):LogicalHierarchyWriteReply {
  const o=exact(value,['schema','action','outcome','code','operationId','details','detailsAvailable']);
  need(o.schema==='lmti.project.operation.write.v1'&&o.operationId===null);
  const action=one(o.action,['logical-hierarchy-commit',null] as const);
  const outcome=one(o.outcome,['refused','confirmed','unknown'] as const),code=one(o.code,nativeHierarchyCodes);
  const detailsAvailable=bool(o.detailsAvailable);
  need((outcome==='confirmed')===(code==='NONE')&&(o.details!==null)===detailsAvailable);
  need(action!==null||(outcome==='refused'&&code==='INVALID_INPUT'&&!detailsAvailable));
  let details:LogicalHierarchyWriteReply['details']=null;
  if(detailsAvailable){
    need(outcome==='confirmed'&&action==='logical-hierarchy-commit');
    const d=exact(o.details,['projectId','storeUuid','previousRevision','revision','proposalDigest']),t=request.expected.reviewToken;
    details={projectId:id(d.projectId),storeUuid:uuid(d.storeUuid),previousRevision:integer(d.previousRevision,1,max-2),
      revision:integer(d.revision,2,max-1),proposalDigest:digest(d.proposalDigest)};
    need(details.projectId===t.projectId&&details.storeUuid===t.storeUuid&&details.previousRevision===t.revision&&
      details.revision===t.revision+1&&details.proposalDigest===t.proposalDigest);
  }
  return {schema:'lmti.project.operation.write.v1',action,outcome,code,operationId:null,details,detailsAvailable};
}
export function decodeLogicalHierarchyWrite(bytes:Uint8Array, request:LogicalHierarchyWriteRequest, authority:LogicalHierarchyGrant):LogicalHierarchyWriteReply {
  const r=checkedLogicalHierarchyWriteRequest(request,grant(authority));
  try{return freeze(writeReply(frame(bytes),r));}catch{throw new ApiError('OWNER_UNAVAILABLE');}
}
function fallback(outcome:'refused'|'unknown',code:NativeHierarchyCode='OWNER_UNAVAILABLE'):LogicalHierarchyWriteReply {
  return {schema:'lmti.project.operation.write.v1',action:'logical-hierarchy-commit',outcome,code,
    operationId:null,details:null,detailsAvailable:false};
}
export class LogicalHierarchyOwner {
  readonly config:LogicalHierarchyOwnerConfig;
  constructor(config:LogicalHierarchyOwnerConfig,private readonly pool:ProcessPool,
    private readonly verifyPool:ProcessPool=new ProcessPool(1)){
    const o=exact(config,['adminBinary','library','projects']),projects=list(o.projects,500,grant);
    need(projects.length>0&&new Set(projects.map(v=>v.projectId)).size===projects.length);
    projects.sort((a,b)=>a.projectId<b.projectId?-1:a.projectId>b.projectId?1:0);
    this.config=freeze({adminBinary:path(o.adminBinary),library:path(o.library),projects});
  }
  has(projectId:string):boolean {return this.config.projects.some(v=>v.projectId===projectId);}
  private authority(projectId:string):LogicalHierarchyGrant {
    const found=this.config.projects.find(v=>v.projectId===id(projectId));
    requireThat(found,'SCOPE_DENIED'); return found;
  }
  private args(projectId:string,write:boolean):string[] {
    const g=this.authority(projectId);
    return [write?'--logical-hierarchy-write':'--logical-hierarchy-read','--library',this.config.library,
      '--project',g.projectId,'--visibility',g.allowInternal?'internal':'public'];
  }
  async read(projectId:string,request:LogicalHierarchyReadRequest,
    options:{guard?:()=>void|Promise<void>;verify?:boolean}={}):Promise<LogicalHierarchyReadResult>{
    const g=this.authority(projectId),r=checkedLogicalHierarchyReadRequest(request,g),input=JSON.stringify(r);
    requireThat(Buffer.byteLength(input)<=inputCap,'LIMIT_EXCEEDED');
    const value=await (options.verify?this.verifyPool:this.pool).run(this.config.adminBinary,this.args(projectId,false),input,
      {cap:outputCap,guard:options.guard,newlineTerminated:true,jsonArrayLimit:4000});
    try{return freeze(readResult(value,r,g));}
    catch(error){if(error instanceof NativeReadRefusal)throw new ApiError(error.code); throw new ApiError('OWNER_UNAVAILABLE');}
  }
  async locator(projectId:string,options:{guard?:RecoveryGuard;verify?:boolean}={}):Promise<LogicalHierarchyLocator>{
    const g=this.authority(projectId);
    const raw=await (options.verify?this.verifyPool:this.pool).run(this.config.adminBinary,this.args(projectId,false),
      JSON.stringify({action:'logical-hierarchy-locator'}),{cap:outputCap,newlineTerminated:true,timeoutMs:30000,guard:options.guard});
    try {
      if(raw&&typeof raw==='object'&&(raw as {ok?:unknown}).ok===false)
        readResult(raw,{action:'logical-hierarchy-state'},g);
      const o=exact(raw,['ok','schema','action','libraryIdentity','projectId','database','linkedRoot']);
      need(o.ok===true&&o.schema==='lmti.logical-hierarchy.owner.v1'&&o.action==='logical-hierarchy-locator'&&id(o.projectId)===g.projectId);
      return freeze({ok:true,schema:'lmti.logical-hierarchy.owner.v1',action:'logical-hierarchy-locator',
        libraryIdentity:library(o.libraryIdentity),projectId:g.projectId,database:path(o.database),linkedRoot:o.linkedRoot===''?'':path(o.linkedRoot)});
    } catch(error) {if(error instanceof NativeReadRefusal)throw new ApiError(error.code);throw new ApiError('OWNER_UNAVAILABLE');}
  }
  async originalState(projectId:string,value:LogicalHierarchyOriginalExpected,options:{guard?:RecoveryGuard}={}):Promise<LogicalHierarchyState>{
    const g=this.authority(projectId),expected=checkedLogicalHierarchyOriginalExpected(value,g);
    requireThat(expected.library.physical.path===this.config.library,'SCOPE_DENIED');
    const input=JSON.stringify({action:'logical-hierarchy-original-state',expected});
    requireThat(Buffer.byteLength(input)<=inputCap,'LIMIT_EXCEEDED');
    const raw=await this.verifyPool.run(this.config.adminBinary,this.args(projectId,false),input,
      {cap:outputCap,newlineTerminated:true,timeoutMs:30000,guard:options.guard,jsonArrayLimit:4000});
    try {
      if(raw&&typeof raw==='object'&&(raw as {ok?:unknown}).ok===false)
        readResult(raw,{action:'logical-hierarchy-state'},g);
      const o=exact(raw,['ok','schema','action','libraryIdentity','projectIdentity','projection']);
      need(o.action==='logical-hierarchy-original-state');
      const result=readResult({...o,action:'logical-hierarchy-state'},{action:'logical-hierarchy-state'},g) as LogicalHierarchyState;
      need(result.libraryIdentity.schema===expected.library.schema&&result.libraryIdentity.uuid===expected.library.uuid&&
        result.libraryIdentity.canonicalPath===expected.library.canonicalPath&&result.projectIdentity.storeUuid===expected.project.storeUuid);
      return freeze(result);
    } catch(error) {if(error instanceof NativeReadRefusal)throw new ApiError(error.code);throw new ApiError('OWNER_UNAVAILABLE');}
  }
  async write(projectId:string,request:LogicalHierarchyWriteRequest,
    options:Pick<WriteOptions,'guard'|'onStarted'>={}):Promise<LogicalHierarchyWriteResult>{
    const g=this.authority(projectId),r=checkedLogicalHierarchyWriteRequest(request,g),input=JSON.stringify(r);
    requireThat(Buffer.byteLength(input)<=inputCap,'LIMIT_EXCEEDED');
    let observedStart=false,result:Awaited<ReturnType<ProcessPool['runWrite']>>;
    try{
      result=await this.pool.runWrite(this.config.adminBinary,this.args(projectId,true),input,
        {cap:outputCap,guard:options.guard,onStarted:()=>{observedStart=true; options.onStarted?.();}});
    }catch{return freeze({started:true,reply:fallback('unknown'),preflightCode:null});}
    if(result.kind==='not_started'&&!observedStart){
      const code=nativeHierarchyCodes.includes(result.code as NativeHierarchyCode)?result.code as NativeHierarchyCode:'OWNER_UNAVAILABLE';
      return freeze({started:false,reply:fallback('refused',code),preflightCode:result.code});
    }
    if(result.kind!=='closed'||!result.transportOk||result.exitCode!==0||result.bytes===null)
      return freeze({started:true,reply:fallback('unknown'),preflightCode:null});
    try{return freeze({started:true,reply:decodeLogicalHierarchyWrite(result.bytes,r,g),preflightCode:null});}
    catch{return freeze({started:true,reply:fallback('unknown'),preflightCode:null});}
  }
}
