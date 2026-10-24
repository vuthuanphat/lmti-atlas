import { ApiError, exact, requireThat, strictJson, type Code } from './security.js';
import { ProcessPool, type WriteOptions } from './process.js';
import { checkedNativeOperationLibrary as library, checkedNativeOperationPath as path,
  checkedNativeOperationIdentityPath as identityPath, type LibraryIdentity } from './project-operation-identity.js';
import { checkedUpgradeRecoveryExpected, checkedUpgradeRecoveryResult,
  type UpgradeRecoveryResult } from './upgrade-recovery-owner.js';
export type { LibraryIdentity } from './project-operation-identity.js';

// Private native operator values only. No path/token in this module is a browser grant.
export const nativeOperationCodes = ['NONE','INVALID_INPUT','SOURCE_CHANGED','UNSUPPORTED_SCHEMA','BUDGET_EXCEEDED',
  'OWNER_UNAVAILABLE','EVIDENCE_INVALID','TARGET_CHANGED','UNSUPPORTED_FORMAT','CONFIG_CHANGED','RECOVERY_REQUIRED','SCOPE_DENIED'] as const;
export type NativeOperationCode = typeof nativeOperationCodes[number];
export interface CopyToken {readonly schemaVersion:1|2;readonly projectId:string;readonly canonicalPath:string;readonly storeUuid:string;readonly revision:number;readonly contentDigest:string;readonly registryDigest:string}
export type CopyMode = 'migrate_v1'|'clone_v2';
export interface CopyPreview {readonly mode:CopyMode;readonly seedsInternalSites:boolean;readonly source:CopyToken;readonly targetRevision:number;readonly targetContentDigest:string;readonly targetRegistryDigest:string}
export interface CopyIntent {readonly mode:CopyMode;readonly seedsInternalSites:boolean;readonly source:CopyToken;readonly target:CopyToken}
export interface CopyStatus {readonly operationId:string;readonly state:'prepared'|'recovery_required';readonly code:NativeOperationCode;readonly mode:CopyMode|null;readonly seedsInternalSites:boolean|null;readonly verifiedReceipt:boolean;readonly source:CopyToken|null;readonly target:CopyToken|null}
export interface FormatPreview {readonly source:LibraryIdentity;readonly fullSnapshotDigest:string}
export interface ActivationPreview extends CopyIntent {readonly library:LibraryIdentity;readonly projectId:string;readonly copyParent:string;readonly copyOperationId:string}
export interface ActivationToken {readonly libraryUuid:string;readonly operationId:string;readonly receiptDigest:string;readonly revision:1|2}
export interface ActivationReceipt {readonly token:ActivationToken;readonly state:'prepared'|'activated'|'abandoned';readonly prepared:ActivationPreview;readonly sourceFolder:string|null;readonly sourceFolderKey:string|null;readonly activatedGeneration:number}
type Page = {readonly offset:number;readonly limit:number;readonly snapshot:string|null};
export type ProjectOperationReadRequest =
  | {readonly action:'inspect';readonly projectId:string}
  | {readonly action:'copy-preview';readonly projectId:string;readonly mode:CopyMode}
  | ({readonly action:'copy-discover'} & Page)
  | {readonly action:'copy-inspect';readonly operationId:string}
  | ({readonly action:'activation-history';readonly projectId:string} & Page)
  | {readonly action:'library-format-preview';readonly fromSchema:1|2}
  | {readonly action:'library-format-status'}
  | {readonly action:'activation-candidate';readonly projectId:string;readonly copyOperationId:string}
  | {readonly action:'activation-inspect';readonly libraryUuid:string;readonly operationId:string};
export type ProjectOperationWriteRequest =
  | {readonly action:'copy-prepare';readonly projectId:string;readonly expected:{readonly libraryIdentity:LibraryIdentity;readonly preview:CopyPreview}}
  | {readonly action:'library-upgrade-v1';readonly expected:LibraryIdentity}
  | {readonly action:'library-upgrade-v2';readonly expected:FormatPreview}
  | {readonly action:'activation-prepare';readonly expected:ActivationPreview}
  | {readonly action:'activation-activate'|'activation-abandon';readonly projectId:string;readonly expected:ActivationToken};
export interface CopyCandidate {readonly operationId:string;readonly state:'uninspected'|'incomplete'|'invalid'|'unavailable';readonly intent:CopyIntent|null}
export interface ActivationSummary {readonly operationId:string;readonly projectId:string;readonly copyOperationId:string;readonly state:ActivationReceipt['state'];readonly revision:1|2}
export type ActivationCondition = 'prepared_current'|'prepared_stale'|'activated_current'|'activated_superseded'|'abandoned'|'inconsistent'|'unavailable';
type ReadBase<A extends string> = {readonly ok:true;readonly schema:'lmti.project.operations.v1';readonly action:A};
type PageResult = {readonly snapshot:string;readonly offset:number;readonly nextOffset:number|null};
export type ProjectOperationReadResult =
  | (ReadBase<'inspect'> & {readonly libraryIdentity:LibraryIdentity;readonly project:{readonly projectId:string;readonly name:string;readonly database:string;readonly root:string;readonly schemaVersion:1|2;readonly storeUuid:string;readonly revision:number}})
  | (ReadBase<'copy-preview'> & {readonly libraryIdentity:LibraryIdentity;readonly projectId:string;readonly preview:CopyPreview})
  | (ReadBase<'copy-discover'> & PageResult & {readonly complete:boolean;readonly code:NativeOperationCode;readonly examinedEntries:number;readonly unattributedEntries:number;readonly items:readonly CopyCandidate[]})
  | (ReadBase<'copy-inspect'> & {readonly status:CopyStatus})
  | (ReadBase<'activation-history'> & PageResult & {readonly libraryIdentity:LibraryIdentity;readonly projectId:string;readonly items:readonly ActivationSummary[]})
  | (ReadBase<'library-format-preview'> & {readonly fromSchema:1|2;readonly toSchema:2|3;readonly expected:LibraryIdentity|FormatPreview})
  | (ReadBase<'library-format-status'> & {readonly libraryIdentity:LibraryIdentity;readonly upgradeOperationId:string|null;readonly legacyDigest:string|null;readonly activationFormatOperationId:string|null;readonly activationFormatBackupDigest:string|null})
  | (ReadBase<'activation-candidate'> & {readonly preview:ActivationPreview})
  | (ReadBase<'activation-inspect'> & {readonly libraryIdentity:LibraryIdentity;readonly receipt:ActivationReceipt;readonly condition:ActivationCondition;readonly code:NativeOperationCode});
export interface UpgradeDetails {readonly state:'upgraded'|'recovery_required';readonly operationId:string|null;readonly backupPath:string|null;readonly libraryIdentity:LibraryIdentity|null}
export interface ProjectOperationWriteReply {
  readonly schema:'lmti.project.operation.write.v1';readonly action:ProjectOperationWriteRequest['action']|null;
  readonly outcome:'refused'|'confirmed'|'unknown';readonly code:NativeOperationCode;readonly operationId:string|null;
  readonly details:CopyStatus|UpgradeDetails|{readonly receipt:ActivationReceipt}|null;readonly detailsAvailable:boolean;
}
export interface ProjectOperationWriteResult {readonly started:boolean;readonly reply:ProjectOperationWriteReply;readonly preflightCode:Code|null}
export interface ProjectOperationOwnerConfig {readonly adminBinary:string;readonly library:string;readonly copyParent:string;readonly backupParent:string}
const max = Number.MAX_SAFE_INTEGER, inputCap = 32*1024, outputCap = 512*1024;
const need: (v:unknown)=>asserts v = v => requireThat(v,'INVALID_INPUT');
function one<T extends string|number>(v:unknown, values:readonly T[]):T { need(values.includes(v as T));return v as T; }
function num(v:unknown,min=1,limit=max):number {need(typeof v==='number'&&Number.isSafeInteger(v)&&v>=min&&v<=limit);return v;}
function txt(v:unknown,cap=1024,empty=false):string {
  need(typeof v==='string'&&(empty||v.length>0)&&Buffer.byteLength(v)<=cap&&!/[\x00-\x1f\x7f]/.test(v));return v;
}
function id(v:unknown):string {const s=txt(v,64);need(/^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(s));return s;}
function uuid(v:unknown):string {const s=txt(v,36);need(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s)&&s!=='00000000-0000-0000-0000-000000000000');return s;}
function digest(v:unknown):string {const s=txt(v,64);need(/^[0-9a-f]{64}$/.test(s));return s;}
function bool(v:unknown):boolean {need(typeof v==='boolean');return v;}
function nullable<T>(v:unknown,decode:(v:unknown)=>T):T|null {return v===null?null:decode(v);}
function freeze<T>(value:T):T {
  if(value&&typeof value==='object'){for(const item of Object.values(value))freeze(item);Object.freeze(value);}return value;
}
function same(a:unknown,b:unknown):boolean {
  if(a===b)return true;
  if(!a||!b||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return false;
  const x=Object.keys(a),y=Object.keys(b);
  return x.length===y.length&&x.every(k=>Object.hasOwn(b,k)&&same((a as Record<string,unknown>)[k],(b as Record<string,unknown>)[k]));
}
function token(v:unknown):CopyToken {
  const o=exact(v,['schemaVersion','projectId','canonicalPath','storeUuid','revision','contentDigest','registryDigest']);
  const schemaVersion=one(o.schemaVersion,[1,2] as const);need(schemaVersion!==1||o.storeUuid==='');
  return {schemaVersion,projectId:id(o.projectId),canonicalPath:identityPath(o.canonicalPath),storeUuid:schemaVersion===1?'':uuid(o.storeUuid),
    revision:num(o.revision,1,max-1),contentDigest:digest(o.contentDigest),registryDigest:digest(o.registryDigest)};
}
function mode(v:unknown):CopyMode {return one(v,['migrate_v1','clone_v2'] as const);}
function pair(m:CopyMode,seeds:boolean,source:CopyToken,target:CopyToken) {
  need(seeds===(m==='migrate_v1')&&source.schemaVersion===(seeds?1:2)&&target.schemaVersion===2&&
    source.projectId===target.projectId&&target.revision===source.revision+1&&target.storeUuid!==source.storeUuid&&target.canonicalPath!==source.canonicalPath);
}
function preview(v:unknown):CopyPreview {
  const o=exact(v,['mode','seedsInternalSites','source','targetRevision','targetContentDigest','targetRegistryDigest']);
  const result={mode:mode(o.mode),seedsInternalSites:bool(o.seedsInternalSites),source:token(o.source),targetRevision:num(o.targetRevision,2,max-1),
    targetContentDigest:digest(o.targetContentDigest),targetRegistryDigest:digest(o.targetRegistryDigest)};
  need(result.seedsInternalSites===(result.mode==='migrate_v1')&&result.source.schemaVersion===(result.seedsInternalSites?1:2)&&
    result.targetRevision===result.source.revision+1);return result;
}
function intent(v:unknown):CopyIntent {
  const o=exact(v,['mode','seedsInternalSites','source','target']);
  const result={mode:mode(o.mode),seedsInternalSites:bool(o.seedsInternalSites),source:token(o.source),target:token(o.target)};
  pair(result.mode,result.seedsInternalSites,result.source,result.target);return result;
}
function format(v:unknown):FormatPreview {
  const o=exact(v,['source','fullSnapshotDigest']),source=library(o.source);need(source.schema===2);
  return {source,fullSnapshotDigest:digest(o.fullSnapshotDigest)};
}
function candidate(v:unknown):ActivationPreview {
  const o=exact(v,['library','projectId','copyParent','copyOperationId','mode','seedsInternalSites','source','target']);
  const result={library:library(o.library),projectId:id(o.projectId),copyParent:identityPath(o.copyParent),copyOperationId:uuid(o.copyOperationId),
    ...intent({mode:o.mode,seedsInternalSites:o.seedsInternalSites,source:o.source,target:o.target})};
  need(result.library.schema===3&&result.projectId===result.source.projectId&&
    result.target.canonicalPath===result.copyParent+'/'+result.copyOperationId+'/project.sqlite');return result;
}
function activationToken(v:unknown):ActivationToken {
  const o=exact(v,['libraryUuid','operationId','receiptDigest','revision']);
  return {libraryUuid:uuid(o.libraryUuid),operationId:uuid(o.operationId),receiptDigest:digest(o.receiptDigest),revision:one(o.revision,[1,2] as const)};
}
function receipt(v:unknown):ActivationReceipt {
  const o=exact(v,['token','state','prepared','sourceFolder','sourceFolderKey','activatedGeneration']);
  const result={token:activationToken(o.token),state:one(o.state,['prepared','activated','abandoned'] as const),prepared:candidate(o.prepared),
    sourceFolder:nullable(o.sourceFolder,v=>path(v,true)),sourceFolderKey:nullable(o.sourceFolderKey,v=>path(v,true)),activatedGeneration:num(o.activatedGeneration,0)};
  need(result.token.libraryUuid===result.prepared.library.uuid&&result.token.revision===(result.state==='prepared'?1:2)&&
    (result.state==='activated'?result.activatedGeneration===result.prepared.library.generation!+1:result.activatedGeneration===0));
  need((result.sourceFolder===null||result.sourceFolder==='')===(result.sourceFolderKey===null||result.sourceFolderKey===''));
  return result;
}
/** Strict private recovery codec, shared with original-target reconciliation. */
export function checkedProjectOperationReceipt(v:unknown):ActivationReceipt {return freeze(receipt(v));}
function copyStatus(v:unknown):CopyStatus {
  const o=exact(v,['operationId','state','code','mode','seedsInternalSites','verifiedReceipt','source','target']);
  const result={operationId:uuid(o.operationId),state:one(o.state,['prepared','recovery_required'] as const),code:one(o.code,nativeOperationCodes),
    mode:nullable(o.mode,mode),seedsInternalSites:nullable(o.seedsInternalSites,bool),verifiedReceipt:bool(o.verifiedReceipt),
    source:nullable(o.source,token),target:nullable(o.target,token)};
  const has=result.source!==null;need([result.target,result.mode,result.seedsInternalSites].every(v=>(v!==null)===has));
  if(has)pair(result.mode!,result.seedsInternalSites!,result.source!,result.target!);
  need(result.state==='prepared'?result.code==='NONE'&&has:result.code!=='NONE');
  need(!result.verifiedReceipt||result.state==='prepared');
  if(result.target)need(result.target.canonicalPath.endsWith('/'+result.operationId+'/project.sqlite'));
  return result;
}
function page(v:Record<string,unknown>):Page {
  const offset=num(v.offset,0,1000),limit=num(v.limit,1,50);
  need(offset!==0||v.snapshot===null);return {offset,limit,snapshot:offset===0?null:digest(v.snapshot)};
}
function checkedRead(v:unknown):ProjectOperationReadRequest {
  need(v&&typeof v==='object'&&!Array.isArray(v));const a=(v as Record<string,unknown>).action;
  switch(a){
    case 'inspect':{const o=exact(v,['action','projectId']);return {action:a,projectId:id(o.projectId)};}
    case 'copy-preview':{const o=exact(v,['action','projectId','mode']);return {action:a,projectId:id(o.projectId),mode:mode(o.mode)};}
    case 'copy-discover':{const o=exact(v,['action','offset','limit','snapshot']);return {action:a,...page(o)};}
    case 'copy-inspect':{const o=exact(v,['action','operationId']);return {action:a,operationId:uuid(o.operationId)};}
    case 'activation-history':{const o=exact(v,['action','projectId','offset','limit','snapshot']);return {action:a,projectId:id(o.projectId),...page(o)};}
    case 'library-format-preview':{const o=exact(v,['action','fromSchema']);return {action:a,fromSchema:one(o.fromSchema,[1,2] as const)};}
    case 'library-format-status':exact(v,['action']);return {action:a};
    case 'activation-candidate':{const o=exact(v,['action','projectId','copyOperationId']);return {action:a,projectId:id(o.projectId),copyOperationId:uuid(o.copyOperationId)};}
    case 'activation-inspect':{const o=exact(v,['action','libraryUuid','operationId']);return {action:a,libraryUuid:uuid(o.libraryUuid),operationId:uuid(o.operationId)};}
    default:throw new ApiError('INVALID_INPUT');
  }
}
function checkedWrite(v:unknown):ProjectOperationWriteRequest {
  need(v&&typeof v==='object'&&!Array.isArray(v));const a=(v as Record<string,unknown>).action;
  if(a==='copy-prepare'){
    const o=exact(v,['action','projectId','expected']),e=exact(o.expected,['libraryIdentity','preview']);
    const result={action:a,projectId:id(o.projectId),expected:{libraryIdentity:library(e.libraryIdentity),preview:preview(e.preview)}} as const;
    need(result.projectId===result.expected.preview.source.projectId);return result;
  }
  if(a==='library-upgrade-v1'){const o=exact(v,['action','expected']),e=library(o.expected);need(e.schema===1);return {action:a,expected:e};}
  if(a==='library-upgrade-v2'){const o=exact(v,['action','expected']);return {action:a,expected:format(o.expected)};}
  if(a==='activation-prepare'){const o=exact(v,['action','expected']);return {action:a,expected:candidate(o.expected)};}
  if(a==='activation-activate'||a==='activation-abandon'){
    const o=exact(v,['action','projectId','expected']);return {action:a,projectId:id(o.projectId),expected:activationToken(o.expected)};
  }
  throw new ApiError('INVALID_INPUT');
}
export function checkedProjectOperationReadRequest(v:unknown):ProjectOperationReadRequest {return freeze(checkedRead(v));}
export function checkedProjectOperationWriteRequest(v:unknown):ProjectOperationWriteRequest {return freeze(checkedWrite(v));}
export function nativeOperationCodeToApi(code:NativeOperationCode):Code|null {
  switch(code){
    case 'NONE':return null;
    case 'INVALID_INPUT':case 'SCOPE_DENIED':case 'CONFIG_CHANGED':case 'OWNER_UNAVAILABLE':case 'RECOVERY_REQUIRED':return code;
    case 'SOURCE_CHANGED':case 'TARGET_CHANGED':return 'CONFIG_CHANGED';
    case 'UNSUPPORTED_SCHEMA':case 'UNSUPPORTED_FORMAT':return 'NOT_SUPPORTED';
    case 'BUDGET_EXCEEDED':return 'LIMIT_EXCEEDED';
    case 'EVIDENCE_INVALID':return 'RECOVERY_REQUIRED';
  }
}
function frame(bytes:Uint8Array):unknown {
  need(bytes.byteLength>0&&bytes.byteLength<=outputCap&&bytes[bytes.byteLength-1]===10);
  return strictJson(bytes,false);
}
function paged(o:Record<string,unknown>,request:Page,items:readonly {operationId:string}[]):PageResult {
  const snapshot=digest(o.snapshot),offset=num(o.offset,0,1000),nextOffset=nullable(o.nextOffset,v=>num(v,1,1000));
  need(offset===request.offset&&(request.snapshot===null||snapshot===request.snapshot)&&items.length<=request.limit&&
    offset+items.length<=1000&&items.every((v,i)=>i===0||items[i-1].operationId<v.operationId));
  need(nextOffset===null||(items.length===request.limit&&nextOffset===offset+items.length));
  return {snapshot,offset,nextOffset};
}
class NativeReadRefusal extends ApiError {}
function readResult(v:unknown,r:ProjectOperationReadRequest):ProjectOperationReadResult {
  need(v&&typeof v==='object'&&!Array.isArray(v));const data=v as Record<string,unknown>;
  if(data.ok===false){const e=exact(v,['ok','code']),code=one(e.code,nativeOperationCodes);need(code!=='NONE');throw new NativeReadRefusal(nativeOperationCodeToApi(code)!);}
  const base=['ok','schema','action'];need(data.ok===true&&data.schema==='lmti.project.operations.v1'&&data.action===r.action);
  const o=(extra:string[])=>exact(v,[...base,...extra]);
  const result={ok:true as const,schema:'lmti.project.operations.v1' as const,action:r.action};
  switch(r.action){
    case 'inspect':{
      const x=o(['libraryIdentity','project']),p=exact(x.project,['projectId','name','database','root','schemaVersion','storeUuid','revision']);
      const schemaVersion=one(p.schemaVersion,[1,2] as const);need(p.projectId===r.projectId&&(schemaVersion!==1||p.storeUuid===''));
      return {...result,action:r.action,libraryIdentity:library(x.libraryIdentity),project:{projectId:id(p.projectId),name:txt(p.name),
        database:path(p.database),root:path(p.root,true),schemaVersion,storeUuid:schemaVersion===1?'':uuid(p.storeUuid),revision:num(p.revision,1,max-1)}};
    }
    case 'copy-preview':{const x=o(['libraryIdentity','projectId','preview']),p=preview(x.preview);need(x.projectId===r.projectId&&p.source.projectId===r.projectId&&p.mode===r.mode);
      return {...result,action:r.action,libraryIdentity:library(x.libraryIdentity),projectId:r.projectId,preview:p};}
    case 'copy-inspect':{const x=o(['status']),status=copyStatus(x.status);need(status.operationId===r.operationId);return {...result,action:r.action,status};}
    case 'copy-discover':{
      const x=o(['complete','code','examinedEntries','unattributedEntries','snapshot','offset','nextOffset','items']);need(Array.isArray(x.items)&&x.items.length<=50);
      const items=x.items.map(value=>{const c=exact(value,['operationId','state','intent']);const state=one(c.state,['uninspected','incomplete','invalid','unavailable'] as const);
        const i=nullable(c.intent,intent),operationId=uuid(c.operationId);need((state==='uninspected')===(i!==null));
        if(i)need(i.target.canonicalPath.endsWith('/'+operationId+'/project.sqlite'));return {operationId,state,intent:i};});
      const complete=bool(x.complete),code=one(x.code,nativeOperationCodes),examinedEntries=num(x.examinedEntries,0,1001),unattributedEntries=num(x.unattributedEntries,0,1000);
      need(unattributedEntries<=Math.min(examinedEntries,1000)&&items.length<=Math.min(examinedEntries,1000)&&
        (complete?code==='NONE'&&examinedEntries<=1000:code!=='NONE'));
      return {...result,action:r.action,...paged(x,r,items),complete,code,examinedEntries,unattributedEntries,items};
    }
    case 'activation-history':{
      const x=o(['libraryIdentity','projectId','snapshot','offset','nextOffset','items']),l=library(x.libraryIdentity);
      need(l.schema===3&&x.projectId===r.projectId&&Array.isArray(x.items)&&x.items.length<=50);
      const items=x.items.map(value=>{const s=exact(value,['operationId','projectId','copyOperationId','state','revision']);const state=one(s.state,['prepared','activated','abandoned'] as const);
        const revision=one(s.revision,[1,2] as const);need(s.projectId===r.projectId&&revision===(state==='prepared'?1:2));
        return {operationId:uuid(s.operationId),projectId:r.projectId,copyOperationId:uuid(s.copyOperationId),state,revision};});
      return {...result,action:r.action,...paged(x,r,items),libraryIdentity:l,projectId:r.projectId,items};
    }
    case 'library-format-preview':{
      const x=o(['fromSchema','toSchema','expected']);need(x.fromSchema===r.fromSchema&&x.toSchema===r.fromSchema+1);
      const expected=r.fromSchema===1?library(x.expected):format(x.expected);if(r.fromSchema===1)need((expected as LibraryIdentity).schema===1);
      return {...result,action:r.action,fromSchema:r.fromSchema,toSchema:r.fromSchema===1?2:3,expected};
    }
    case 'library-format-status':{
      const x=o(['libraryIdentity','upgradeOperationId','legacyDigest','activationFormatOperationId','activationFormatBackupDigest']),l=library(x.libraryIdentity);
      const resultFields={libraryIdentity:l,upgradeOperationId:nullable(x.upgradeOperationId,uuid),legacyDigest:nullable(x.legacyDigest,digest),
        activationFormatOperationId:nullable(x.activationFormatOperationId,uuid),activationFormatBackupDigest:nullable(x.activationFormatBackupDigest,digest)};
      need((resultFields.upgradeOperationId!==null)===(l.schema>=2)&&(resultFields.legacyDigest!==null)===(l.schema>=2)&&
        (resultFields.activationFormatOperationId!==null)===(l.schema===3)&&(resultFields.activationFormatBackupDigest!==null)===(l.schema===3));
      return {...result,action:r.action,...resultFields};
    }
    case 'activation-candidate':{const x=o(['preview']),p=candidate(x.preview);need(p.projectId===r.projectId&&p.copyOperationId===r.copyOperationId);return {...result,action:r.action,preview:p};}
    case 'activation-inspect':{
      const x=o(['libraryIdentity','receipt','condition','code']),l=library(x.libraryIdentity),p=receipt(x.receipt);
      const condition=one(x.condition,['prepared_current','prepared_stale','activated_current','activated_superseded','abandoned','inconsistent','unavailable'] as const),code=one(x.code,nativeOperationCodes);
      need(l.schema===3&&l.uuid===r.libraryUuid&&p.token.libraryUuid===r.libraryUuid&&p.token.operationId===r.operationId);
      need(p.state==='prepared'?['prepared_current','prepared_stale','unavailable'].includes(condition):
        p.state==='activated'?['activated_current','activated_superseded','inconsistent'].includes(condition):condition==='abandoned');
      need(['prepared_current','activated_current','activated_superseded','abandoned'].includes(condition)?code==='NONE':code!=='NONE');
      return {...result,action:r.action,libraryIdentity:l,receipt:p,condition,code};
    }
  }
}
export function decodeProjectOperationRead(bytes:Uint8Array,request:ProjectOperationReadRequest):ProjectOperationReadResult {
  const r=checkedProjectOperationReadRequest(request);
  try{return freeze(readResult(frame(bytes),r));}catch(e){if(e instanceof NativeReadRefusal)throw new ApiError(e.code);throw new ApiError('OWNER_UNAVAILABLE');}
}
function upgrade(v:unknown):UpgradeDetails {
  const o=exact(v,['state','operationId','backupPath','libraryIdentity']);
  const result={state:one(o.state,['upgraded','recovery_required'] as const),operationId:nullable(o.operationId,uuid),
    backupPath:nullable(o.backupPath,path),libraryIdentity:nullable(o.libraryIdentity,library)};
  need(result.state!=='upgraded'||result.operationId!==null&&result.backupPath!==null&&result.libraryIdentity!==null);return result;
}
function writeReply(v:unknown,r:ProjectOperationWriteRequest):ProjectOperationWriteReply {
  const o=exact(v,['schema','action','outcome','code','operationId','details','detailsAvailable']);
  const outcome=one(o.outcome,['refused','confirmed','unknown'] as const),code=one(o.code,nativeOperationCodes),operationId=nullable(o.operationId,uuid),detailsAvailable=bool(o.detailsAvailable);
  need(o.schema==='lmti.project.operation.write.v1'&&(o.action===r.action||o.action===null&&outcome==='refused'&&code==='INVALID_INPUT'));
  need((outcome==='confirmed')===(code==='NONE')&&detailsAvailable===(o.details!==null));
  if(outcome==='refused')need(operationId===null&&!detailsAvailable);
  if(!detailsAvailable){need(outcome!=='confirmed'||operationId===null);return {...o,schema:'lmti.project.operation.write.v1',action:o.action as ProjectOperationWriteReply['action'],outcome,code,operationId,details:null,detailsAvailable:false};}
  need(o.action===r.action&&operationId!==null&&outcome!=='refused');
  let details:NonNullable<ProjectOperationWriteReply['details']>;
  if(r.action==='copy-prepare'){
    const p=r.expected.preview,s=copyStatus(o.details);need(s.operationId===operationId&&s.state===(outcome==='confirmed'?'prepared':'recovery_required'));
    need(s.source!==null&&s.target!==null&&same(s.source,p.source)&&s.mode===p.mode&&s.seedsInternalSites===p.seedsInternalSites&&
      s.target.revision===p.targetRevision&&s.target.contentDigest===p.targetContentDigest&&s.target.registryDigest===p.targetRegistryDigest);
    if(outcome==='confirmed')need(s.verifiedReceipt);details=s;
  }else if(r.action==='library-upgrade-v1'||r.action==='library-upgrade-v2'){
    const u=upgrade(o.details),source=r.action==='library-upgrade-v1'?r.expected:r.expected.source;
    need(u.operationId===operationId&&u.state===(outcome==='confirmed'?'upgraded':'recovery_required'));
    if(u.libraryIdentity)need(u.libraryIdentity.schema===source.schema+1&&u.libraryIdentity.canonicalPath===source.canonicalPath&&
      (source.schema===1?u.libraryIdentity.generation===1:u.libraryIdentity.uuid===source.uuid&&u.libraryIdentity.generation===source.generation&&u.libraryIdentity.digest===source.digest));
    if(u.backupPath)need(u.backupPath.replaceAll('\\','/').endsWith('/'+operationId+(source.schema===1?'/library-v1.sqlite':'/library-v2.sqlite')));
    details=u;
  }else{
    const value=exact(o.details,['receipt']),p=receipt(value.receipt);need(p.token.operationId===operationId);
    const expectedState=r.action==='activation-prepare'?'prepared':r.action==='activation-activate'?'activated':'abandoned';
    need(p.state===expectedState);
    if(r.action==='activation-prepare')need(same(p.prepared,r.expected)&&p.token.revision===1);
    else need(p.prepared.projectId===r.projectId&&p.token.libraryUuid===r.expected.libraryUuid&&p.token.operationId===r.expected.operationId&&
      r.expected.revision===1&&p.token.revision===2&&p.token.receiptDigest!==r.expected.receiptDigest);
    details={receipt:p};
  }
  return {schema:'lmti.project.operation.write.v1',action:r.action,outcome,code,operationId,details,detailsAvailable:true};
}
export function decodeProjectOperationWrite(bytes:Uint8Array,request:ProjectOperationWriteRequest):ProjectOperationWriteReply {
  const r=checkedProjectOperationWriteRequest(request);
  try{return freeze(writeReply(frame(bytes),r));}catch{throw new ApiError('OWNER_UNAVAILABLE');}
}
function fallback(action:ProjectOperationWriteRequest['action'],outcome:'refused'|'unknown',code:NativeOperationCode='OWNER_UNAVAILABLE'):ProjectOperationWriteReply {
  return freeze({schema:'lmti.project.operation.write.v1',action,outcome,code,operationId:null,details:null,detailsAvailable:false});
}
export class ProjectOperationOwner {
  readonly config:ProjectOperationOwnerConfig;
  constructor(config:ProjectOperationOwnerConfig,private readonly pool:ProcessPool,private readonly verifyPool:ProcessPool=new ProcessPool(1)){
    const o=exact(config,['adminBinary','library','copyParent','backupParent']);
    this.config=freeze({adminBinary:path(o.adminBinary),library:path(o.library),copyParent:path(o.copyParent),backupParent:path(o.backupParent)});
  }
  async read(request:ProjectOperationReadRequest,options:{guard?:()=>void|Promise<void>;verify?:boolean}={}):Promise<ProjectOperationReadResult>{
    const r=checkedProjectOperationReadRequest(request),input=JSON.stringify(r);requireThat(Buffer.byteLength(input)<=inputCap,'LIMIT_EXCEEDED');
    const value=await (options.verify?this.verifyPool:this.pool).run(this.config.adminBinary,
      ['--project-operations','--library',this.config.library,'--copy-parent',this.config.copyParent],input,{cap:outputCap,guard:options.guard,newlineTerminated:true});
    try{return freeze(readResult(value,r));}catch(e){if(e instanceof NativeReadRefusal)throw new ApiError(e.code);throw new ApiError('OWNER_UNAVAILABLE');}
  }
  async upgradeRecovery(expected:FormatPreview,options:{guard?:()=>void|Promise<void>}={}):Promise<UpgradeRecoveryResult>{
    const e=checkedUpgradeRecoveryExpected(expected),input=JSON.stringify({action:'library-upgrade-recovery',expected:e});
    requireThat(Buffer.byteLength(input)<=inputCap,'LIMIT_EXCEEDED');
    const value=await this.verifyPool.run(this.config.adminBinary,
      ['--project-operation-recovery','--library',this.config.library,'--backup-parent',this.config.backupParent],
      input,{cap:outputCap,timeoutMs:30000,guard:options.guard,newlineTerminated:true});
    return checkedUpgradeRecoveryResult(value,e);
  }
  async write(request:ProjectOperationWriteRequest,options:Pick<WriteOptions,'guard'|'onStarted'>={}):Promise<ProjectOperationWriteResult>{
    const r=checkedProjectOperationWriteRequest(request),input=JSON.stringify(r);requireThat(Buffer.byteLength(input)<=inputCap,'LIMIT_EXCEEDED');
    let observedStart=false;
    let result:Awaited<ReturnType<ProcessPool['runWrite']>>;
    try{
      result=await this.pool.runWrite(this.config.adminBinary,['--project-operation-write','--library',this.config.library,
        '--copy-parent',this.config.copyParent,'--backup-parent',this.config.backupParent],input,
        {cap:outputCap,guard:options.guard,onStarted:()=>{observedStart=true;options.onStarted?.();}});
    }catch{
      // Unexpected transport failures cannot prove no child started.
      return freeze({started:true,reply:fallback(r.action,'unknown'),preflightCode:null});
    }
    if(result.kind==='not_started'&&!observedStart){
      const native=nativeOperationCodes.includes(result.code as NativeOperationCode)?result.code as NativeOperationCode:'OWNER_UNAVAILABLE';
      return freeze({started:false,reply:fallback(r.action,'refused',native),preflightCode:result.code});
    }
    if(result.kind!=='closed'||!result.transportOk||result.exitCode!==0||result.bytes===null)
      return freeze({started:true,reply:fallback(r.action,'unknown'),preflightCode:null});
    try{return freeze({started:true,reply:decodeProjectOperationWrite(result.bytes,r),preflightCode:null});}
    catch{return freeze({started:true,reply:fallback(r.action,'unknown'),preflightCode:null});}
  }
}
