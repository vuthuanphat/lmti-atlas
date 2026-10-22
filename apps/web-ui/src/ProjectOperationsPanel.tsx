import { useEffect, useId, useRef, useState } from 'react';
import type { CommonRecoveryPreviewDto, RecoveryCoverageDto } from '../../web-api/src/contracts';
import { request } from './api';
import { Icon } from './Icon';
import './ProjectOperationsPanel.css';

type Action = 'copy-prepare'|'library-upgrade-v1'|'library-upgrade-v2'|'activation-prepare'|'activation-activate'|'activation-abandon';
type CopyMode = 'migrate_v1'|'clone_v2';
type Review =
  | {kind:'copy';mode:CopyMode;sourceSchema:1|2;sourceRevision:number;targetSchema:2;targetRevision:number;seedsInternalSites:boolean}
  | {kind:'activation';decision:'prepare'|'activate'|'abandon';mode:CopyMode;sourceRevision:number;targetRevision:number;receiptRevision:number|null;preservesSource:true;preservesLinkedRoot:true}
  | {kind:'library_upgrade';fromSchema:1|2;toSchema:2|3;scope:'library';backupRetained:true};
type Preview = {id:string;projectId:string|null;action:Action;expiresAt:string;review:Review};
type Summary =
  | {kind:'copy';state:'prepared';sourceRevision:number;targetRevision:number;seedsInternalSites:boolean}
  | {kind:'activation';state:'prepared'|'activated'|'abandoned';receiptRevision:number;sourceRevision:number;targetRevision:number}
  | {kind:'library_upgrade';fromSchema:1|2;toSchema:2|3};
type Result = {operationId:string;action:Action;outcome:'pending'|'confirmed'|'refused'|'unknown';code:string|null;recoveryHandle:string|null;summary:Summary|null};
type Job = {operationId:string;state:'pending'|'succeeded'|'failed'|'unknown';result:Result|null;errorCode:string|null};
type Scopes = {projectIds:string[];allowLibraryUpgrade:boolean};
type WriteStatus = {recoveryRequired:boolean;admitted:boolean;projectOperations:boolean;activeWrites:number};
type ProjectStatus = {projectId:string;projectSchema:1|2;projectRevision:number;librarySchema:1|2|3;capabilities:{copyModes:CopyMode[];activation:boolean};recoveryRequired:boolean};
type LibraryStatus = {librarySchema:1|2|3;canUpgrade:boolean;recoveryRequired:boolean};
type RecoveryItem = {handle:string;kind:'copy'|'activation';state:string;revision:number|null};
type RecoveryPage = {items:RecoveryItem[];nextCursor:string|null};
type RecoveryView = {handle:string;kind:'copy'|'activation';projectId:string;state:string;condition:string|null;mode:CopyMode|null;sourceRevision:number|null;targetRevision:number|null;receiptRevision:number|null;canPrepare:boolean;canActivate:boolean;canAbandon:boolean};
type RecoveryPreview = {id:string;projectId:string|null;expiresAt:string;scope:'project'|'activation'|'library';priorOutcome:'unknown';freshReviewRequired:true;librarySchema:1|2|3};
export type LegacyRecovery = CommonRecoveryPreviewDto;
type RecoveryReview = {base:string;value:RecoveryPreview|LegacyRecovery};
type Submission = {project:string|null;action:Action;result:Result|null;phase:'submitting'|'pending'|'confirmed'|'refused'|'unknown'};
type Props = {project:string;language:'en'|'vi';onLockChange:(locked:boolean)=>void;onChanged:()=>void;disabled?:boolean;refreshKey?:number};
export type RecoveryCoverage = RecoveryCoverageDto;
type RecoveryCapabilities = Readonly<{logical:boolean;physical:boolean}>;

class InvalidResponse extends Error { readonly code = 'INVALID_SOURCE_RESPONSE'; }
function check(condition:unknown):asserts condition {if(!condition)throw new InvalidResponse();}
function exact(v:unknown,keys:readonly string[]):Record<string,unknown> {
  check(v!==null&&typeof v==='object'&&!Array.isArray(v));
  const o=v as Record<string,unknown>;
  check(Object.keys(o).length===keys.length&&keys.every(k=>Object.hasOwn(o,k)));return o;
}
const member = <T extends string>(v:unknown,values:readonly T[]):v is T => typeof v==='string'&&values.includes(v as T);
const opaque = (v:unknown):v is string => typeof v==='string'&&/^[A-Za-z0-9_-]{43}$/.test(v);
const projectId = (v:unknown):v is string => typeof v==='string'&&/^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(v);
const revision = (v:unknown):v is number => typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
const time = (v:unknown):v is string => typeof v==='string'&&v.length<=32&&/^\d{4}-\d\d-\d\dT/.test(v)&&Number.isFinite(Date.parse(v));
const boolean = (v:unknown):v is boolean => typeof v==='boolean';
const modes = ['migrate_v1','clone_v2'] as const;
const actions = ['copy-prepare','library-upgrade-v1','library-upgrade-v2','activation-prepare','activation-activate','activation-abandon'] as const;
const codes = ['UNAUTHENTICATED','SESSION_EXPIRED','ORIGIN_REJECTED','SCOPE_DENIED','INVALID_INPUT','REVISION_CONFLICT','PREVIEW_EXPIRED','CONFIG_CHANGED','RECOVERY_REQUIRED','UNMANAGED_COLLISION','OWNED_CONFIG_DRIFT','NOT_SUPPORTED','OWNER_UNAVAILABLE','LIMIT_EXCEEDED','BUSY'] as const;
const activationStates = ['prepared','activated','abandoned'] as const;
const conditions = ['prepared_current','prepared_stale','activated_current','activated_superseded','abandoned','inconsistent','unavailable'] as const;
const codeOf = (e:unknown):string => e&&typeof e==='object'&&'code' in e&&typeof e.code==='string'&&[...codes,'NETWORK','INVALID_SOURCE_RESPONSE'].includes(e.code) ? e.code : 'NETWORK';
const baseFor = (project:string|null) => project===null ? '/api/v1/library/project-operations' : `/api/v1/projects/${encodeURIComponent(project)}/project-operations`;

export function checkedOperationScopes(v:unknown):Scopes {
  const o=exact(v,['projectIds','allowLibraryUpgrade']);
  check(Array.isArray(o.projectIds)&&o.projectIds.length<=500&&o.projectIds.every(projectId)&&new Set(o.projectIds).size===o.projectIds.length&&boolean(o.allowLibraryUpgrade));
  return o as unknown as Scopes;
}
export function operationSelection(current:string,next:string,scopes:Scopes,busy:boolean,locked:boolean):string {
  if(busy||locked)return current;
  check(projectId(next)&&scopes.projectIds.includes(next));return next;
}
export function checkedWriteStatus(v:unknown):WriteStatus {
  const o=exact(v,['recoveryRequired','admitted','projectOperations','activeWrites']);
  check(boolean(o.recoveryRequired)&&boolean(o.admitted)&&boolean(o.projectOperations)&&revision(o.activeWrites)&&o.activeWrites<=32);
  return o as unknown as WriteStatus;
}
export function checkedOperationStatus(v:unknown,project:string|null):ProjectStatus|LibraryStatus {
  if(project===null) {
    const o=exact(v,['librarySchema','canUpgrade','recoveryRequired']);
    check([1,2,3].includes(o.librarySchema as number)&&boolean(o.canUpgrade)&&boolean(o.recoveryRequired));
    check(o.canUpgrade===(o.librarySchema!==3));return o as unknown as LibraryStatus;
  }
  const o=exact(v,['projectId','projectSchema','projectRevision','librarySchema','capabilities','recoveryRequired']);
  const c=exact(o.capabilities,['copyModes','activation']);
  check(projectId(o.projectId)&&o.projectId===project&&[1,2].includes(o.projectSchema as number)&&revision(o.projectRevision)&&
    [1,2,3].includes(o.librarySchema as number)&&boolean(o.recoveryRequired)&&boolean(c.activation)&&c.activation===(o.librarySchema===3));
  check(Array.isArray(c.copyModes)&&c.copyModes.length===1&&c.copyModes[0]===(o.projectSchema===1?'migrate_v1':'clone_v2'));
  return o as unknown as ProjectStatus;
}
export function checkedOperationPreview(v:unknown,project:string|null,action:Action):Preview {
  const o=exact(v,['id','projectId','action','expiresAt','review']);
  check(opaque(o.id)&&o.projectId===project&&(project===null||projectId(project))&&o.action===action&&member(action,actions)&&time(o.expiresAt));
  if(action==='copy-prepare') {
    const r=exact(o.review,['kind','mode','sourceSchema','sourceRevision','targetSchema','targetRevision','seedsInternalSites']);
    check(project!==null&&r.kind==='copy'&&member(r.mode,modes)&&r.sourceSchema===(r.mode==='migrate_v1'?1:2)&&r.targetSchema===2&&
      revision(r.sourceRevision)&&revision(r.targetRevision)&&r.targetRevision===r.sourceRevision+1&&r.seedsInternalSites===(r.mode==='migrate_v1'));
  } else if(action.startsWith('activation-')) {
    const r=exact(o.review,['kind','decision','mode','sourceRevision','targetRevision','receiptRevision','preservesSource','preservesLinkedRoot']);
    check(project!==null&&r.kind==='activation'&&r.decision===action.slice(11)&&member(r.mode,modes)&&
      revision(r.sourceRevision)&&revision(r.targetRevision)&&r.targetRevision===r.sourceRevision+1&&
      (r.decision==='prepare'?r.receiptRevision===null:r.receiptRevision===1)&&r.preservesSource===true&&r.preservesLinkedRoot===true);
  } else {
    const r=exact(o.review,['kind','fromSchema','toSchema','scope','backupRetained']),from=action==='library-upgrade-v1'?1:2;
    check(project===null&&r.kind==='library_upgrade'&&r.fromSchema===from&&r.toSchema===from+1&&r.scope==='library'&&r.backupRetained===true);
  }
  return o as unknown as Preview;
}
export function checkedOperationResult(v:unknown,action:Action,operationId?:string):Result {
  const o=exact(v,['operationId','action','outcome','code','recoveryHandle','summary']);
  check(opaque(o.operationId)&&(!operationId||o.operationId===operationId)&&o.action===action&&member(o.outcome,['pending','confirmed','refused','unknown'])&&
    (o.code===null||member(o.code,codes))&&(o.recoveryHandle===null||opaque(o.recoveryHandle)));
  if(o.outcome==='pending')check(o.code===null&&o.recoveryHandle===null&&o.summary===null);
  if(o.outcome==='refused'||o.outcome==='unknown')check(o.code!==null);
  if(o.summary!==null) {
    check(o.outcome==='confirmed');
    if(action==='copy-prepare') {
      const s=exact(o.summary,['kind','state','sourceRevision','targetRevision','seedsInternalSites']);
      check(s.kind==='copy'&&s.state==='prepared'&&revision(s.sourceRevision)&&revision(s.targetRevision)&&s.targetRevision===s.sourceRevision+1&&boolean(s.seedsInternalSites));
    } else if(action.startsWith('activation-')) {
      const s=exact(o.summary,['kind','state','receiptRevision','sourceRevision','targetRevision']);
      check(s.kind==='activation'&&s.state===(action==='activation-prepare'?'prepared':action==='activation-activate'?'activated':'abandoned')&&
        s.receiptRevision===(action==='activation-prepare'?1:2)&&revision(s.sourceRevision)&&revision(s.targetRevision)&&s.targetRevision===s.sourceRevision+1);
    } else {
      const s=exact(o.summary,['kind','fromSchema','toSchema']),from=action==='library-upgrade-v1'?1:2;
      check(s.kind==='library_upgrade'&&s.fromSchema===from&&s.toSchema===from+1&&o.recoveryHandle===null);
    }
  }
  return o as unknown as Result;
}
export function checkedOperationJob(v:unknown,id:string,action:Action):Job {
  const o=exact(v,['operationId','state','result','errorCode']);
  check(o.operationId===id&&opaque(id)&&member(o.state,['pending','succeeded','failed','unknown'])&&(o.errorCode===null||member(o.errorCode,codes)));
  if(o.state==='pending')check(o.result===null&&o.errorCode===null);
  else {
    const r=checkedOperationResult(o.result,action,id);
    check(r.outcome===(o.state==='succeeded'?'confirmed':o.state==='failed'?'refused':'unknown')&&
      (o.state==='failed'?o.errorCode===r.code:o.errorCode===null));
  }
  return o as unknown as Job;
}
export function checkedOperationPage(v:unknown,kind:'copy'|'activation'):RecoveryPage {
  const o=exact(v,['items','nextCursor']);check(Array.isArray(o.items)&&o.items.length<=20&&(o.nextCursor===null||opaque(o.nextCursor)));
  const seen=new Set<string>();
  for(const item of o.items) {
    const r=exact(item,['handle','kind','state','revision']);
    check(opaque(r.handle)&&!seen.has(r.handle)&&r.kind===kind);
    check(kind==='copy' ? member(r.state,['uninspected','incomplete','invalid','unavailable'])&&r.revision===null :
      member(r.state,activationStates)&&r.revision===(r.state==='prepared'?1:2));seen.add(r.handle);
  }
  return o as unknown as RecoveryPage;
}
export function checkedOperationRecovery(v:unknown,project:string,handle:string):RecoveryView {
  const o=exact(v,['handle','kind','projectId','state','condition','mode','sourceRevision','targetRevision','receiptRevision','canPrepare','canActivate','canAbandon']);
  check(o.handle===handle&&opaque(handle)&&o.projectId===project&&projectId(project)&&member(o.kind,['copy','activation'])&&
    (o.mode===null||member(o.mode,modes))&&[o.sourceRevision,o.targetRevision,o.receiptRevision].every(n=>n===null||revision(n))&&
    [o.canPrepare,o.canActivate,o.canAbandon].every(boolean));
  if(o.kind==='copy') {
    check(member(o.state,['prepared','recovery_required'])&&o.condition===null&&o.receiptRevision===null&&o.canPrepare===(o.state==='prepared')&&!o.canActivate&&!o.canAbandon);
    check((o.sourceRevision===null)===(o.targetRevision===null));
    if(o.canPrepare)check(o.mode!==null&&o.sourceRevision!==null&&o.targetRevision!==null);
  } else check(member(o.state,activationStates)&&member(o.condition,conditions)&&o.mode!==null&&revision(o.sourceRevision)&&revision(o.targetRevision)&&
    o.receiptRevision===(o.state==='prepared'?1:2)&&!o.canPrepare&&o.canAbandon===(o.state==='prepared')&&
    (!o.canActivate||o.state==='prepared'&&o.condition==='prepared_current'));
  return o as unknown as RecoveryView;
}
export function checkedRecoveryCoverage(v:unknown):RecoveryCoverage {
  const o=exact(v,['retainedSubjects','affectedScopes','librarySchema']);
  check(revision(o.retainedSubjects)&&o.retainedSubjects<=32&&Array.isArray(o.affectedScopes)&&o.affectedScopes.length<=32&&
    (o.librarySchema===null||[1,2,3].includes(o.librarySchema as number)));
  const seen=new Set<string>();let total=0;
  for(const row of o.affectedScopes) {
    const r=exact(row,['kind','action','projectId','subjects']);
    check(member(r.kind,['legacy','logical_hierarchy','physical_hierarchy','project_operations']));
    check(r.kind==='legacy'?member(r.action,['profile_save','desired_proposal','client_apply','client_restore']):
      r.kind==='logical_hierarchy'?r.action==='logical-hierarchy-commit':
      r.kind==='physical_hierarchy'?r.action==='physical-hierarchy-commit':member(r.action,actions));
    const maintenance=r.action==='library-upgrade-v1'||r.action==='library-upgrade-v2';
    check(maintenance?r.projectId===null:projectId(r.projectId));
    check(revision(r.subjects)&&r.subjects>=1&&r.subjects<=32);
    const key=JSON.stringify([r.kind,r.action,r.projectId]);check(!seen.has(key));seen.add(key);total+=r.subjects;
  }
  check(total===o.retainedSubjects);return o as unknown as RecoveryCoverage;
}
export function checkedHierarchyAvailability(v:unknown):boolean {
  const o=exact(v,['projects']);check(Array.isArray(o.projects)&&o.projects.length>0&&o.projects.length<=500);
  const seen=new Set<string>();
  for(const row of o.projects){const r=exact(row,['projectId','allowInternal']);check(projectId(r.projectId)&&!seen.has(r.projectId)&&boolean(r.allowInternal));seen.add(r.projectId);}
  return true;
}
export async function discoverRecoveryCapabilities(read:typeof request,signal?:AbortSignal):Promise<RecoveryCapabilities> {
  async function available(path:string):Promise<boolean> {
    try{return checkedHierarchyAvailability(await read(path,'GET',undefined,signal));}
    catch(e){if(codeOf(e)==='NOT_SUPPORTED')return false;throw e;}
  }
  // These are independent explicit grants. Failure of either discovery leaves
  // the complete recovery shape unknown; it cannot be treated as absence.
  const [logical,physical]=await Promise.all([
    available('/api/v1/logical-hierarchy-scopes'),
    available('/api/v1/physical-hierarchy-scopes'),
  ]);
  return Object.freeze({logical,physical});
}
export function checkedOperationRecoveryPreview(v:unknown,project:string|null,legacy=false,requireCoverage=false,requirePhysical=false):RecoveryPreview|LegacyRecovery {
  if(legacy) {
    check(v!==null&&typeof v==='object'&&!Array.isArray(v));
    const raw=v as Record<string,unknown>,hasHierarchy=Object.hasOwn(raw,'hierarchyItems'),hasCoverage=Object.hasOwn(raw,'coverage'),
      hasPhysical=Object.hasOwn(raw,'physicalHierarchyItems');
    // A hierarchy-enabled reply must describe its entire retained scope. An old
    // backend without that display contract cannot produce an actionable review.
    check(hasHierarchy===hasCoverage&&(!(requireCoverage||requirePhysical)||hasCoverage)&&hasPhysical===requirePhysical);
    const o=exact(v,['id','expiresAt','items','priorOutcome',...(hasHierarchy?['hierarchyItems','coverage']:[]),...(hasPhysical?['physicalHierarchyItems']:[])]);
    check(opaque(o.id)&&time(o.expiresAt)&&o.priorOutcome==='unknown'&&Array.isArray(o.items)&&o.items.length<=(hasCoverage?32:500));
    const seen=new Set<string>();
    for(const item of o.items) {
      const i=exact(item,['projectId','projectRevision','profileRevision','clients']);
      check(projectId(i.projectId)&&(hasCoverage||!seen.has(i.projectId))&&revision(i.projectRevision)&&revision(i.profileRevision)&&Array.isArray(i.clients)&&i.clients.length<=2);
      if(hasCoverage)check(i.projectRevision>=1&&i.projectRevision<Number.MAX_SAFE_INTEGER);
      seen.add(i.projectId);const clients=new Set<string>();
      for(const client of i.clients){const c=exact(client,['client','state']);check(member(c.client,['codex','cursor'])&&!clients.has(c.client)&&member(c.state,['recovery_required','configured','not_applied']));clients.add(c.client);}
    }
    if(hasCoverage) {
      const coverage=checkedRecoveryCoverage(o.coverage);
      check(Array.isArray(o.hierarchyItems)&&o.hierarchyItems.length<=32);
      for(const item of o.hierarchyItems){const i=exact(item,['projectId','projectRevision']);check(projectId(i.projectId)&&revision(i.projectRevision)&&i.projectRevision>=1&&i.projectRevision<Number.MAX_SAFE_INTEGER);}
      const physicalItems=hasPhysical?o.physicalHierarchyItems:[];
      check(Array.isArray(physicalItems)&&physicalItems.length<=32);
      for(const item of physicalItems){const i=exact(item,['projectId','projectRevision']);check(projectId(i.projectId)&&revision(i.projectRevision)&&i.projectRevision>=1&&i.projectRevision<Number.MAX_SAFE_INTEGER);}
      // Repeated project labels can describe distinct retained original targets.
      // Preserve every summary; correlate counts, never deduplicate these rows.
      for(const [kind,items] of [['legacy',o.items],['logical_hierarchy',o.hierarchyItems],['physical_hierarchy',physicalItems]] as const) {
        const expected=new Map<string,number>(),observed=new Map<string,number>();
        for(const scope of coverage.affectedScopes)if(scope.kind===kind)expected.set(scope.projectId!, (expected.get(scope.projectId!)??0)+scope.subjects);
        for(const item of items){const id=(item as {projectId:string}).projectId;observed.set(id,(observed.get(id)??0)+1);}
        check(expected.size===observed.size&&[...expected].every(([id,count])=>observed.get(id)===count));
      }
    }
    check(new TextEncoder().encode(JSON.stringify({apiVersion:1,requestId:'x'.repeat(43),ok:true,data:o})).length<=256*1024);
    return o as unknown as LegacyRecovery;
  }
  const o=exact(v,['id','projectId','expiresAt','scope','priorOutcome','freshReviewRequired','librarySchema']);
  check(opaque(o.id)&&o.projectId===project&&time(o.expiresAt)&&o.priorOutcome==='unknown'&&o.freshReviewRequired===true&&[1,2,3].includes(o.librarySchema as number)&&
    (project===null?o.scope==='library':projectId(project)&&member(o.scope,['project','activation'])));
  return o as unknown as RecoveryPreview;
}
export function CommonRecoveryEvidence({value,language}:{value:LegacyRecovery;language:'en'|'vi'}) {
  const t=(en:string,vi:string)=>language==='vi'?vi:en;
  const actionName=(action:string)=>({
    profile_save:t('Save profile','Lưu hồ sơ'),desired_proposal:t('Desired-state proposal','Đề xuất trạng thái mong muốn'),
    client_apply:t('Apply client settings','Áp dụng cấu hình client'),client_restore:t('Restore client settings','Phục hồi cấu hình client'),
    'logical-hierarchy-commit':t('Edit logical hierarchy','Sửa phân cấp logic'),
    'physical-hierarchy-commit':t('Edit physical hierarchy','Sửa phân cấp vật lý'),
    'copy-prepare':t('Prepare project copy','Chuẩn bị bản sao dự án'),'library-upgrade-v1':t('Upgrade library to format 2','Nâng thư viện lên định dạng 2'),
    'library-upgrade-v2':t('Upgrade library to format 3','Nâng thư viện lên định dạng 3'),'activation-prepare':t('Prepare activation','Chuẩn bị kích hoạt'),
    'activation-activate':t('Activate copy','Kích hoạt bản sao'),'activation-abandon':t('Abandon activation','Hủy kích hoạt'),
  } as Record<string,string>)[action]??t('Unavailable','Không khả dụng');
  const clientState=(state:string)=>state==='configured'?t('Configured','Đã cấu hình'):state==='not_applied'?t('Not applied','Chưa áp dụng'):t('Recovery required','Cần phục hồi');
  return <>
    {value.coverage&&<section aria-label={t('Complete affected scope','Toàn bộ phạm vi bị ảnh hưởng')}>
      <h4>{t('Complete affected scope','Toàn bộ phạm vi bị ảnh hưởng')}</h4>
      <p>{t('Retained coordination records','Bản ghi điều phối được giữ lại')}: {value.coverage.retainedSubjects}. {t('These counts do not establish how many writes completed or how many physical targets are distinct.','Các số đếm không xác định số thao tác đã hoàn thành hoặc số đích vật lý khác nhau.')}</p>
      {!value.coverage.affectedScopes.length&&<p>{t('The service explicitly verified an empty retained scope.','Dịch vụ đã xác minh rõ ràng rằng không có phạm vi được giữ lại.')}</p>}
      <ul>{value.coverage.affectedScopes.map((scope,index)=><li key={index}>{scope.projectId??t('Library','Thư viện')} · {actionName(scope.action)} · {t('records','bản ghi')}: {scope.subjects}</li>)}</ul>
      {value.coverage.affectedScopes.some(scope=>scope.kind==='project_operations')&&<p>{t('Project operations are included in the observed scope above. This summary does not attribute a prior result; inspect retained copy or activation evidence separately.','Thao tác dự án đã nằm trong phạm vi quan sát ở trên. Tóm tắt này không xác định kết quả trước đó; kiểm tra riêng bằng chứng bản sao hoặc kích hoạt được giữ lại.')}</p>}
      {value.coverage.librarySchema!==null&&<p>{t('Observed library format','Định dạng thư viện đã quan sát')}: {value.coverage.librarySchema}</p>}
    </section>}
    {!!value.items.length&&<section aria-label={t('Profile and client observations','Quan sát hồ sơ và client')}><h4>{t('Profile and client observations','Quan sát hồ sơ và client')}</h4><ul>{value.items.map((item,index)=><li key={index}>{item.projectId}: {t('project','dự án')} r{item.projectRevision}, {t('profile','hồ sơ')} r{item.profileRevision}<ul>{item.clients.map(c=><li key={c.client}>{c.client}: {clientState(c.state)}</li>)}</ul></li>)}</ul></section>}
    {!!value.hierarchyItems?.length&&<section aria-label={t('Logical hierarchy observations','Quan sát phân cấp logic')}><h4>{t('Logical hierarchy observations','Quan sát phân cấp logic')}</h4><ul>{value.hierarchyItems.map((item,index)=><li key={index}>{item.projectId}: {t('project','dự án')} r{item.projectRevision}</li>)}</ul></section>}
    {!!value.physicalHierarchyItems?.length&&<section aria-label={t('Physical hierarchy observations','Quan sát phân cấp vật lý')}><h4>{t('Physical hierarchy observations','Quan sát phân cấp vật lý')}</h4><ul>{value.physicalHierarchyItems.map((item,index)=><li key={index}>{item.projectId}: {t('project','dự án')} r{item.projectRevision}</li>)}</ul></section>}
  </>;
}
export function checkedOperationAcknowledgment(v:unknown,legacy=false):void {
  const o=exact(v,[legacy?'reviewed':'reconciled','priorOutcome','freshReviewRequired']);
  check(o[legacy?'reviewed':'reconciled']===true&&o.priorOutcome==='unknown'&&o.freshReviewRequired===true);
}

/** Never pull focus out of a modal or into an inactive persistent workspace. */
export function focusOperationTarget(target:HTMLElement|null):boolean {
  if(!target?.isConnected||!target.getClientRects().length||target.closest('[hidden], [inert]')||target.matches(':disabled')||target.ownerDocument.querySelector('dialog[open]'))return false;
  target.focus();return true;
}

export function ProjectOperationsPanel({project,language,onLockChange,onChanged,disabled=false,refreshKey=0}:Props) {
  const t=(en:string,vi:string)=>language==='vi'?vi:en;
  const heading=useId(),mounted=useRef(true),serial=useRef(0),readAbort=useRef<AbortController|null>(null);
  const selected=useRef(project),lastMainProject=useRef(project),initialized=useRef(false),busyRef=useRef(false),lockedRef=useRef(false);
  const callbacks=useRef({onLockChange,onChanged});callbacks.current={onLockChange,onChanged};
  const [busy,setBusy]=useState(false),[locked,setLocked]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [selectedProject,setSelectedProject]=useState(project);
  const [recoveryCapabilities,setRecoveryCapabilities]=useState<RecoveryCapabilities|null>(null);
  const hierarchyEnabled=recoveryCapabilities===null?null:recoveryCapabilities.logical||recoveryCapabilities.physical;
  const lastRefresh=useRef(refreshKey);
  const [scopes,setScopes]=useState<Scopes|null>(null),[write,setWrite]=useState<WriteStatus|null>(null);
  const [status,setStatus]=useState<ProjectStatus|null>(null),[library,setLibrary]=useState<LibraryStatus|null>(null);
  const [preview,setPreview]=useState<Preview|null>(null),[recoveryReview,setRecoveryReview]=useState<RecoveryReview|null>(null);
  const [copies,setCopies]=useState<RecoveryPage|null>(null),[activations,setActivations]=useState<RecoveryPage|null>(null),[recovery,setRecovery]=useState<RecoveryView|null>(null);
  const [submission,setSubmission]=useState<Submission|null>(null),[idleObserved,setIdleObserved]=useState(false),[now,setNow]=useState(Date.now());
  const panelRef=useRef<HTMLElement|null>(null),reviewHeading=useRef<HTMLHeadingElement|null>(null),recoveryHeading=useRef<HTMLHeadingElement|null>(null);
  const reviewTrigger=useRef<HTMLElement|null>(null),pendingFocus=useRef<'preview'|'recovery'|'trigger'|null>(null);
  function activeTrigger(){const active=document.activeElement;return active instanceof HTMLElement&&panelRef.current?.contains(active)?active:null;}
  useEffect(()=>{
    if(busy||!pendingFocus.current)return;
    const target=pendingFocus.current==='preview'?reviewHeading.current:pendingFocus.current==='recovery'?recoveryHeading.current:reviewTrigger.current;
    pendingFocus.current=null;focusOperationTarget(target);
  },[preview,recoveryReview,busy]);
  function lock(value:boolean){lockedRef.current=value;setLocked(value);callbacks.current.onLockChange(value);}
  function changed(){try{callbacks.current.onChanged();}catch{/* A refresh callback cannot change a latched owner outcome. */}}
  function clearRead(){serial.current++;readAbort.current?.abort();}
  function start(){if(busyRef.current)return false;busyRef.current=true;setBusy(true);setError('');return true;}
  function finish(){busyRef.current=false;if(mounted.current)setBusy(false);}
  async function readTask(work:(signal:AbortSignal,accept:(apply:()=>void)=>void)=>Promise<void>) {
    if(!start())return;clearRead();const generation=serial.current,abort=new AbortController();readAbort.current=abort;
    const accept=(apply:()=>void)=>{if(mounted.current&&serial.current===generation&&!abort.signal.aborted)apply();};
    try{await work(abort.signal,accept);}catch(e){accept(()=>setError(codeOf(e)));}finally{if(serial.current===generation)finish();}
  }
  async function refresh() {
    const p=selected.current;
    await readTask(async(signal,accept)=>{
      accept(()=>{setPreview(null);setStatus(null);setLibrary(null);setScopes(null);setRecoveryCapabilities(null);setRecoveryReview(null);setIdleObserved(false);});
      const w=checkedWriteStatus(await request('/api/v1/write-status','GET',undefined,signal));
      accept(()=>{setWrite(w);setIdleObserved(w.admitted&&w.activeWrites===0);});
      const capabilities=await discoverRecoveryCapabilities(request,signal);
      accept(()=>setRecoveryCapabilities(capabilities));
      let s:Scopes|null=null;
      if(w.projectOperations)s=checkedOperationScopes(await request('/api/v1/project-operation-scopes','GET',undefined,signal));
      accept(()=>{setScopes(s);setStatus(null);setLibrary(null);});
      if(s?.projectIds.includes(p)) {
        try {
          const value=checkedOperationStatus(await request(baseFor(p),'GET',undefined,signal),p) as ProjectStatus;
          accept(()=>setStatus(value));
        } catch(e) {accept(()=>setError(codeOf(e)));}
      }
      if(s?.allowLibraryUpgrade) {
        const value=checkedOperationStatus(await request(baseFor(null),'GET',undefined,signal),null) as LibraryStatus;
        accept(()=>setLibrary(value));
      }
    });
  }
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;initialized.current=false;clearRead();};},[]);
  useEffect(()=>{
    // Unlock alone must not replace a deliberately chosen historical project.
    if(lockedRef.current||initialized.current&&lastMainProject.current===project)return;
    initialized.current=true;lastMainProject.current=project;
    clearRead();selected.current=project;setSelectedProject(project);busyRef.current=false;setBusy(false);
    setScopes(null);setStatus(null);setLibrary(null);setPreview(null);setCopies(null);setActivations(null);setRecovery(null);setRecoveryReview(null);setError('');setNotice('');
    // A read is the only automatic request. No claim, preview or write is replayed.
    void refresh();
  },[project,locked]);
  useEffect(()=>{
    if(lastRefresh.current===refreshKey||lockedRef.current||busyRef.current)return;
    lastRefresh.current=refreshKey;
    // A sibling commit invalidates every local preview; refresh only reads.
    setPreview(null);setRecoveryReview(null);void refresh();
  },[refreshKey,locked,busy]);
  function chooseProject(next:string) {
    if(!scopes||disabled)return;
    const chosen=operationSelection(selected.current,next,scopes,busyRef.current,lockedRef.current);
    if(chosen===selected.current)return;
    clearRead();selected.current=chosen;setSelectedProject(chosen);
    setStatus(null);setLibrary(null);setPreview(null);setCopies(null);setActivations(null);setRecovery(null);setRecoveryReview(null);
    setError('');setNotice('');setIdleObserved(false);
    void refresh();
  }
  useEffect(()=>{
    if(!preview&&!recoveryReview)return;
    setNow(Date.now());const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);
  },[preview,recoveryReview]);
  const blocked=disabled||busy||locked||!write?.admitted||write.recoveryRequired;
  async function createPreview(p:string|null,action:Action,suffix:string,body:unknown) {
    if(blocked)return;
    const trigger=activeTrigger();
    await readTask(async(signal,accept)=>{
      const value=checkedOperationPreview(await request(`${baseFor(p)}/${suffix}`,'POST',body,signal),p,action);
      if(value.review.kind==='copy')check(body!==null&&typeof body==='object'&&'mode' in body&&value.review.mode===body.mode);
      accept(()=>{reviewTrigger.current=trigger;pendingFocus.current='preview';setPreview(value);setRecoveryReview(null);setNotice('');});
    });
  }
  async function rejectPreview() {
    const p=preview;if(!p)return;
    await readTask(async(signal,accept)=>{
      const o=exact(await request(`${baseFor(p.projectId)}/previews/${p.id}`,'DELETE',undefined,signal),['rejected']);check(o.rejected===true);
      accept(()=>{pendingFocus.current='trigger';setPreview(null);setNotice('rejected');});
    });
  }
  function receive(result:Result,p:string|null) {
    setSubmission({project:p,action:result.action,result,phase:result.outcome});setIdleObserved(false);
    if(result.outcome==='confirmed'||result.outcome==='refused') {
      lock(false);setPreview(null);setRecoveryReview(null);setStatus(null);setLibrary(null);setCopies(null);setActivations(null);setRecovery(null);
      if(result.outcome==='confirmed')changed();
    }
    // Unknown remains pinned. Even a confirmed reply may require reconciliation
    // when optional details were unavailable; a later status read exposes that.
  }
  async function confirm() {
    const p=preview;if(!p||blocked||Date.now()>=Date.parse(p.expiresAt)||!start())return;
    clearRead();setPreview(null);setRecoveryReview(null);setIdleObserved(false);lock(true);
    setSubmission({project:p.projectId,action:p.action,result:null,phase:'submitting'});
    try {
      // No AbortSignal, timeout or retry on this request. The reviewed token is
      // consumed locally before dispatch; lost replies require observation.
      const result=checkedOperationResult(await request(`${baseFor(p.projectId)}/commits`,'POST',{previewId:p.id}),p.action);
      if(mounted.current)receive(result,p.projectId);
    } catch(e) {
      if(mounted.current){setSubmission({project:p.projectId,action:p.action,result:null,phase:'unknown'});setError(codeOf(e));}
    } finally{finish();}
  }
  async function checkJob() {
    const s=submission,id=s?.result?.operationId;if(!s||!id||!start())return;
    try {
      const job=checkedOperationJob(await request(`/api/v1/operations/${id}`),id,s.action);
      if(!mounted.current)return;
      if(job.result)receive(job.result,s.project);
    } catch(e){if(mounted.current){setSubmission({...s,phase:'unknown'});setError(codeOf(e));}}
    finally{finish();}
  }
  useEffect(()=>{
    if(submission?.phase!=='pending'||busy)return;
    const timer=setTimeout(()=>void checkJob(),1500);return()=>clearTimeout(timer);
  },[submission,busy]);
  async function list(kind:'copy'|'activation',next=false) {
    const old=kind==='copy'?copies:activations,p=selected.current;
    if(locked&&submission?.phase!=='unknown')return;
    await readTask(async(signal,accept)=>{
      const value=checkedOperationPage(await request(`${baseFor(p)}/${kind==='copy'?'copies':'activations'}`,'POST',{limit:20,cursor:next?old?.nextCursor??null:null},signal),kind);
      accept(()=>{if(kind==='copy')setCopies(value);else setActivations(value);});
    });
  }
  async function inspectHandle(handle:string) {
    const p=selected.current;
    await readTask(async(signal,accept)=>{
      const value=checkedOperationRecovery(await request(`${baseFor(p)}/recovery/${handle}`,'GET',undefined,signal),p,handle);
      accept(()=>{setRecovery(value);setPreview(null);});
    });
  }
  async function recoveryPreview(p:string|null,activationHandle:string|null=null,common=false) {
    if(disabled||!write?.recoveryRequired||hierarchyEnabled===null)return;
    const trigger=activeTrigger();
    const legacy=common||hierarchyEnabled||!write.projectOperations,base=legacy?'/api/v1':baseFor(p);
    await readTask(async(signal,accept)=>{
      const value=checkedOperationRecoveryPreview(await request(`${base}/recovery-previews`,'POST',legacy?{}:{activationHandle},signal),p,legacy,legacy&&hierarchyEnabled===true,legacy&&recoveryCapabilities?.physical===true);
      accept(()=>{reviewTrigger.current=trigger;pendingFocus.current='recovery';setRecoveryReview({base,value});setPreview(null);});
    });
  }
  async function acknowledge() {
    const r=recoveryReview;if(disabled||!r||Date.now()>=Date.parse(r.value.expiresAt)||!start())return;
    const wasLocked=lockedRef.current;lock(true);setRecoveryReview(null);setPreview(null);
    try {
      checkedOperationAcknowledgment(await request(`${r.base}/recoveries`,'POST',{previewId:r.value.id}),r.base==='/api/v1');
      if(mounted.current){setNotice('reconciled');setWrite(null);setStatus(null);setLibrary(null);setIdleObserved(true);lock(false);changed();}
    } catch(e){if(mounted.current){setError(codeOf(e));if(!wasLocked)lock(false);}}finally{finish();}
  }
  async function claim() {
    if(disabled)return;
    await readTask(async(signal,accept)=>{
      const o=exact(await request('/api/v1/write-claim','POST',{},signal),['outcome','recoveryRequired']);
      check(member(o.outcome,['claimed','busy','unavailable'])&&boolean(o.recoveryRequired));
      accept(()=>{setWrite(null);setNotice(o.outcome==='claimed'?'claimed':'claim_unavailable');});
    });
  }
  function endLocalReview() {
    if(busy||submission?.phase!=='unknown'||!idleObserved)return;
    setPreview(null);setRecoveryReview(null);lock(false);setNotice('unknown_retained');
  }
  const actionText=(a:Action)=>({
    'copy-prepare':t('Create reviewed project copy','Tạo bản sao dự án đã duyệt'),
    'library-upgrade-v1':t('Upgrade library to format 2','Nâng thư viện lên định dạng 2'),
    'library-upgrade-v2':t('Enable activation format 3','Bật định dạng kích hoạt 3'),
    'activation-prepare':t('Prepare activation receipt','Chuẩn bị biên nhận kích hoạt'),
    'activation-activate':t('Activate reviewed copy','Kích hoạt bản sao đã duyệt'),
    'activation-abandon':t('Abandon activation receipt','Hủy biên nhận kích hoạt'),
  })[a];
  const stateText=(state:string)=>({
    prepared:t('Prepared','Đã chuẩn bị'),activated:t('Activated','Đã kích hoạt'),abandoned:t('Abandoned','Đã hủy'),
    uninspected:t('Not inspected','Chưa kiểm tra'),incomplete:t('Incomplete','Chưa đầy đủ'),invalid:t('Invalid','Không hợp lệ'),unavailable:t('Unavailable','Không khả dụng'),
    recovery_required:t('Recovery required','Cần phục hồi'),configured:t('Configured','Đã cấu hình'),not_applied:t('Not applied','Chưa áp dụng'),
    prepared_current:t('Prepared against current state','Đã chuẩn bị theo trạng thái hiện tại'),prepared_stale:t('Prepared state changed','Trạng thái đã chuẩn bị bị thay đổi'),
    activated_current:t('Active selection','Lựa chọn đang dùng'),activated_superseded:t('Selection changed later','Lựa chọn đã thay đổi sau đó'),
    inconsistent:t('Inconsistent evidence','Bằng chứng không nhất quán'),
  } as Record<string,string>)[state]??t('Unknown','Chưa rõ');
  function reviewText(r:Review):string {
    if(r.kind==='library_upgrade')return t(`Library format ${r.fromSchema} → ${r.toSchema}. A typed backup is retained.`,`Định dạng thư viện ${r.fromSchema} → ${r.toSchema}. Giữ lại bản sao lưu có kiểm tra.`);
    if(r.kind==='copy')return t(`Project r${r.sourceRevision} → copy r${r.targetRevision}; schema ${r.sourceSchema} → ${r.targetSchema}. The source is preserved.`,`Dự án r${r.sourceRevision} → bản sao r${r.targetRevision}; định dạng ${r.sourceSchema} → ${r.targetSchema}. Giữ nguyên nguồn.`)+(r.seedsInternalSites?t(' Existing sites receive Internal privacy.',' Các site hiện có được gán quyền riêng tư Nội bộ.'):'');
    return t(`Source r${r.sourceRevision}, target r${r.targetRevision}. Source data and linked root are preserved.`,`Nguồn r${r.sourceRevision}, đích r${r.targetRevision}. Giữ nguyên dữ liệu nguồn và thư mục liên kết.`);
  }
  function errorText():string {
    if(error==='PREVIEW_EXPIRED')return t('This review expired. Inspect current state and create a new review.','Lượt duyệt đã hết hạn. Kiểm tra trạng thái hiện tại và tạo lượt duyệt mới.');
    if(error==='CONFIG_CHANGED'||error==='REVISION_CONFLICT')return t('State changed after review. Inspect it before creating another preview.','Trạng thái đã thay đổi sau khi duyệt. Kiểm tra trước khi tạo bản xem trước khác.');
    if(error==='BUSY')return t('Another operation is still active. Inspect status before continuing.','Một thao tác khác vẫn đang chạy. Kiểm tra trạng thái trước khi tiếp tục.');
    if(error==='SESSION_EXPIRED'||error==='UNAUTHENTICATED')return t('This session ended. Reopen the launcher and inspect recovery; the submitted write is not retried.','Phiên đã kết thúc. Mở lại bằng launcher và kiểm tra phục hồi; không thử lại thao tác đã gửi.');
    if(error==='SCOPE_DENIED')return t('This session cannot review the requested scope.','Phiên này không được phép duyệt phạm vi đã yêu cầu.');
    return t('The local owner could not provide a verified response. Inspect current state; no write is retried automatically.','Owner cục bộ chưa cung cấp phản hồi xác minh được. Kiểm tra trạng thái hiện tại; không tự động thử lại thao tác ghi.');
  }
  const canRead=!disabled&&!busy&&submission?.phase!=='pending'&&submission?.phase!=='submitting';
  const projectAllowed=!!scopes?.projectIds.includes(selected.current);
  const expired=!!preview&&now>=Date.parse(preview.expiresAt),recoveryExpired=!!recoveryReview&&now>=Date.parse(recoveryReview.value.expiresAt);
  return <section ref={panelRef} className="operations-panel" aria-labelledby={heading} aria-busy={busy}>
    <header className="operations-panel__heading">
      <div><p className="operations-panel__eyebrow">{t('OPERATIONS & REVIEW','THAO TÁC VÀ DUYỆT')}</p><h2 id={heading}><Icon name="work" size={24}/>{t('Project copies & recovery','Bản sao dự án & phục hồi')}</h2>
        <p className="muted">{t('Review copies and library changes here. Each confirmation is a separate operation; no device command is sent.','Duyệt bản sao và thay đổi thư viện tại đây. Mỗi xác nhận là một thao tác riêng; không gửi lệnh thiết bị.')}</p></div>
      <button type="button" disabled={!canRead} onClick={()=>void refresh()}>{t('Inspect current state','Kiểm tra trạng thái hiện tại')}</button>
    </header>

    {scopes&&scopes.projectIds.length>0&&<div className="operations-panel__scope"><label>{t('Granted project scope','Phạm vi dự án được cấp quyền')}
      <select aria-label={t('Granted project scope','Phạm vi dự án được cấp quyền')} value={projectAllowed?selectedProject:''} disabled={disabled||busy||locked} onChange={event=>chooseProject(event.target.value)}>
        <option value="" disabled>{t('Choose a granted project','Chọn dự án được cấp quyền')}</option>
        {scopes.projectIds.map(id=><option key={id} value={id}>{id}</option>)}
      </select></label><span className="muted">{t('Includes historical projects outside the current inventory.','Bao gồm dự án lịch sử ngoài danh sách hiện tại.')}</span>
    </div>}

    {error&&<p className="notice error-notice" role="alert">{errorText()}</p>}
    {locked&&<p className="notice operations-panel__warning" role="status">{t('This operation is pinned to','Thao tác này đang gắn với')} <strong>{submission?.project??t('the library','thư viện')}</strong>. {t('Keep this page open until its result is inspected.','Giữ trang này mở cho đến khi kiểm tra được kết quả.')}</p>}
    {notice&&<p className="notice" role="status">{notice==='rejected'?t('Preview rejected. No write was submitted.','Đã từ chối bản xem trước. Chưa gửi thao tác ghi.'):
      notice==='reconciled'?t('Current state acknowledged. The prior outcome remains unknown. Inspect again and create a separate fresh review before writing.','Đã xác nhận trạng thái hiện tại. Kết quả trước vẫn chưa rõ. Kiểm tra lại và tạo lượt duyệt mới riêng trước khi ghi.'):
      notice==='claimed'?t('Writer admission checked. Inspect current state before continuing.','Đã kiểm tra quyền bắt đầu ghi. Kiểm tra trạng thái hiện tại trước khi tiếp tục.'):
      notice==='claim_unavailable'?t('Writer admission is still unavailable. No write was started.','Vẫn chưa được phép bắt đầu ghi. Chưa khởi chạy thao tác ghi.'):
      t('The earlier outcome remains unknown. Ending this local review does not clear the service recovery barrier.','Kết quả trước vẫn chưa rõ. Kết thúc lượt duyệt cục bộ không xóa yêu cầu phục hồi của dịch vụ.')}</p>}

    {submission&&<section className={`operations-card operations-result operations-result--${submission.phase}`} aria-live="polite">
      <div className="operations-card__heading"><div><p className="operations-panel__eyebrow">{t('SUBMITTED OPERATION','THAO TÁC ĐÃ GỬI')}</p><h3>{actionText(submission.action)}</h3></div>
        <span className="operations-chip">{submission.phase==='confirmed'?t('Confirmed','Đã xác nhận'):submission.phase==='refused'?t('Refused','Đã từ chối'):submission.phase==='unknown'?t('Unknown outcome','Kết quả chưa rõ'):t('Processing','Đang xử lý')}</span></div>
      <p className="operations-card__meta">{submission.project??t('Library','Thư viện')}</p>
      <p>{submission.phase==='confirmed'?t('Confirmed by the owner.','Owner đã xác nhận.'):submission.phase==='refused'?t('The owner refused this request.','Owner đã từ chối yêu cầu.'):
        submission.phase==='unknown'?t('The submitted outcome is unknown. Do not repeat this write.','Kết quả thao tác đã gửi chưa rõ. Không gửi lại thao tác này.'):t('The owner is still processing. No retry will be submitted.','Owner vẫn đang xử lý. Không gửi lại yêu cầu.')}</p>
      {submission.result?.summary&&<p>{submission.result.summary.kind==='library_upgrade'?t(`Library format ${submission.result.summary.toSchema}.`,`Định dạng thư viện ${submission.result.summary.toSchema}.`):
        t(`Source r${submission.result.summary.sourceRevision}; target r${submission.result.summary.targetRevision}.`,`Nguồn r${submission.result.summary.sourceRevision}; đích r${submission.result.summary.targetRevision}.`)}</p>}
      <div className="operations-actions">
        {submission.result?.operationId&&['pending','unknown'].includes(submission.phase)&&<button type="button" disabled={busy} onClick={()=>void checkJob()}>{t('Check submitted operation','Kiểm tra thao tác đã gửi')}</button>}
        {submission.result?.recoveryHandle&&submission.project===selected.current&&<button type="button" disabled={!canRead} onClick={()=>void inspectHandle(submission.result!.recoveryHandle!)}>{t('Inspect retained evidence','Kiểm tra bằng chứng được giữ lại')}</button>}
        {submission.phase==='unknown'&&locked&&<button type="button" disabled={!canRead||!idleObserved} onClick={endLocalReview}>{t('End local review; retain unknown outcome','Kết thúc duyệt cục bộ; giữ kết quả chưa rõ')}</button>}
      </div>
    </section>}

    <div className="operations-panel__layout">
      <div className="operations-panel__main">
        {status&&<section className="operations-card"><div className="operations-card__heading"><h3>{t('Project operations','Thao tác dự án')}</h3><span className="operations-chip">r{status.projectRevision}</span></div>
          <p className="operations-card__meta"><strong>{status.projectId}</strong> · {t('Project format','Định dạng dự án')} {status.projectSchema} · {t('Library format','Định dạng thư viện')} {status.librarySchema}</p>
          <ol className="operations-steps" aria-label={t('Review workflow','Quy trình duyệt')}><li><span>1</span>{t('Inspect','Kiểm tra')}</li><li><span>2</span>{t('Review preview','Duyệt xem trước')}</li><li><span>3</span>{t('Confirm separately','Xác nhận riêng')}</li></ol>
          <div className="operations-options">{status.capabilities.copyModes.map(mode=><div className="operations-option" key={mode}>
            <div><h4>{mode==='migrate_v1'?t('Migration copy','Bản sao chuyển đổi'):t('Preserved-history clone','Bản sao giữ lịch sử')}</h4><p className="muted">{mode==='migrate_v1'?t('Review the format transition while preserving the source project.','Duyệt chuyển đổi định dạng và giữ nguyên dự án nguồn.'):t('Review a separate project copy with its retained history.','Duyệt bản sao dự án riêng cùng lịch sử được giữ lại.')}</p></div>
            <button type="button" disabled={blocked} onClick={()=>void createPreview(status.projectId,'copy-prepare','copy-previews',{mode})}>{mode==='migrate_v1'?t('Preview migration copy','Xem trước bản sao chuyển đổi'):t('Preview preserved-history clone','Xem trước bản sao giữ lịch sử')}</button>
          </div>)}</div>
        </section>}

        {projectAllowed&&<section className="operations-card"><div className="operations-card__heading"><h3>{t('Retained operation evidence','Bằng chứng thao tác được giữ lại')}</h3></div>
          <p className="muted">{t('Load the evidence, then inspect an item to see its available decisions.','Tải bằng chứng, rồi kiểm tra từng mục để xem các quyết định được phép.')}</p>
          <div className="operations-actions operations-evidence__load">
            <button type="button" disabled={!canRead} onClick={()=>void list('copy')}>{t('List copies','Liệt kê bản sao')}</button>
            <button type="button" disabled={!canRead} onClick={()=>void list('activation')}>{t('List activation receipts','Liệt kê biên nhận kích hoạt')}</button>
          </div>
          {!copies&&!activations&&<p className="operations-empty">{t('No evidence list loaded for this scope yet.','Chưa tải danh sách bằng chứng cho phạm vi này.')}</p>}
          {([['copy',copies],['activation',activations]] as const).map(([kind,page])=>page&&<div className="operations-evidence" key={kind}><h4>{kind==='copy'?t('Copies','Bản sao'):t('Activation receipts','Biên nhận kích hoạt')}</h4>
            {!page.items.length&&<p className="operations-empty">{t('No matching evidence on this page. This does not prove that an interrupted write never ran.','Trang này không có bằng chứng phù hợp. Điều này không chứng minh thao tác bị gián đoạn chưa từng chạy.')}</p>}
            <ul>{page.items.map((item,index)=><li key={item.handle}><span className="operations-evidence__number">{index+1}</span><span className="operations-evidence__state">{stateText(item.state)}<small>{item.revision!==null?`r${item.revision}`:t('Revision unavailable','Chưa có phiên bản')}</small></span>
              <button type="button" disabled={!canRead} onClick={()=>void inspectHandle(item.handle)}>{t('Inspect','Kiểm tra')}</button></li>)}</ul>
            {page.nextCursor&&<button type="button" disabled={!canRead} onClick={()=>void list(kind,true)}>{t('Next evidence page','Trang bằng chứng tiếp theo')}</button>}
          </div>)}
        </section>}

        {recovery&&<section className="operations-card operations-card--inspected"><p className="operations-panel__eyebrow">{t('EVIDENCE DETAILS','CHI TIẾT BẰNG CHỨNG')}</p><h3>{t('Inspected evidence','Bằng chứng đã kiểm tra')}</h3>
          <p><span className="operations-chip">{stateText(recovery.state)}</span>{recovery.condition&&<span className="operations-card__condition">{stateText(recovery.condition)}</span>}</p>
          <div className="operations-revisions"><div><span>{t('Source revision','Phiên bản nguồn')}</span><strong>{recovery.sourceRevision??'—'}</strong></div><span aria-hidden="true">→</span><div><span>{t('Target revision','Phiên bản đích')}</span><strong>{recovery.targetRevision??'—'}</strong></div></div>
          <div className="operations-actions">
            {recovery.canPrepare&&<button type="button" disabled={blocked} onClick={()=>void createPreview(recovery.projectId,'activation-prepare','activation-previews',{copyHandle:recovery.handle})}>{t('Review activation preparation','Duyệt chuẩn bị kích hoạt')}</button>}
            {recovery.canActivate&&<button type="button" disabled={blocked} onClick={()=>void createPreview(recovery.projectId,'activation-activate','decision-previews',{activationHandle:recovery.handle,decision:'activate'})}>{t('Review activation','Duyệt kích hoạt')}</button>}
            {recovery.canAbandon&&<button type="button" className="operations-action--caution" disabled={blocked} onClick={()=>void createPreview(recovery.projectId,'activation-abandon','decision-previews',{activationHandle:recovery.handle,decision:'abandon'})}>{t('Review abandonment','Duyệt hủy biên nhận')}</button>}
            {recovery.kind==='activation'&&write?.recoveryRequired&&hierarchyEnabled===false&&<button type="button" disabled={!canRead||hierarchyEnabled===null} onClick={()=>void recoveryPreview(recovery.projectId,recovery.handle)}>{t('Review recovery from this receipt','Duyệt phục hồi từ biên nhận này')}</button>}
          </div>
        </section>}

        {!status&&!projectAllowed&&<div className="operations-empty"><Icon name="work" size={28}/><p>{busy?t('Inspecting operation capabilities…','Đang kiểm tra quyền thao tác…'):t('Inspect current state to load the operations and evidence available to this session.','Kiểm tra trạng thái hiện tại để tải các thao tác và bằng chứng được cấp cho phiên này.')}</p></div>}
      </div>

      <aside className="operations-panel__aside" aria-label={t('Write coordination and maintenance','Điều phối ghi và bảo trì')}>
        <section className="operations-card"><div className="operations-card__heading"><h3>{t('Write coordination','Điều phối ghi')}</h3></div>
          {write?<><p className="operations-write-count"><span>{t('Active writes','Thao tác ghi đang chạy')}</span><strong>{write.activeWrites}</strong></p>
            <p className={write.recoveryRequired?'operations-panel__warning-text':'muted'}>{write.recoveryRequired?t('A recovery review is required before another write.','Cần duyệt phục hồi trước thao tác ghi khác.'):!write.admitted?t('Write admission is unavailable.','Hiện chưa được phép ghi.'):t('Write coordination is ready.','Điều phối ghi đã sẵn sàng.')}</p>
            {!write.admitted&&(write.projectOperations||hierarchyEnabled===true)&&<button type="button" disabled={!canRead} onClick={()=>void claim()}>{t('Check writer admission','Kiểm tra quyền bắt đầu ghi')}</button>}
          </>:<p className="muted">{t('Awaiting current write status.','Đang chờ trạng thái ghi hiện tại.')}</p>}
        </section>

        {library&&<section className="operations-card"><h3>{t('Library maintenance','Bảo trì thư viện')}</h3><p className="operations-card__meta">{t('Library format','Định dạng thư viện')} <strong>{library.librarySchema}</strong></p>
          {library.canUpgrade&&<button type="button" disabled={blocked} onClick={()=>void createPreview(null,library.librarySchema===1?'library-upgrade-v1':'library-upgrade-v2','previews',{fromSchema:library.librarySchema})}>{t('Review library upgrade','Duyệt nâng định dạng thư viện')}</button>}
        </section>}

        {write?.recoveryRequired&&<section className="operations-card operations-card--recovery"><p className="operations-panel__eyebrow">{t('RECOVERY REQUIRED','CẦN PHỤC HỒI')}</p><h3>{t('Review current state after interruption','Duyệt trạng thái hiện tại sau gián đoạn')}</h3>
          <p>{t('This acknowledges fresh evidence only. It does not determine the historical outcome or repeat the submitted write.','Chỉ xác nhận bằng chứng mới. Không xác định lại kết quả trong quá khứ hoặc gửi lại thao tác đã gửi.')}</p>
          <div className="operations-actions">
            {hierarchyEnabled===null?<p className="muted">{t('The complete recovery display is unavailable. Inspect current state again before acknowledging.','Chưa có đủ thông tin hiển thị phục hồi. Kiểm tra lại trạng thái trước khi xác nhận.')}</p>:hierarchyEnabled?<button type="button" disabled={!canRead} onClick={()=>void recoveryPreview(null,null,true)}>{t('Review affected scope','Xem lại phạm vi bị ảnh hưởng')}</button>:!write.projectOperations?<button type="button" disabled={!canRead} onClick={()=>void recoveryPreview(null)}>{t('Review affected settings','Duyệt cấu hình bị ảnh hưởng')}</button>:<>
              {projectAllowed&&<button type="button" disabled={!canRead} onClick={()=>void recoveryPreview(selected.current)}>{t('Review project recovery','Duyệt phục hồi dự án')}</button>}
              {scopes?.allowLibraryUpgrade&&<button type="button" disabled={!canRead} onClick={()=>void recoveryPreview(null)}>{t('Review library recovery','Duyệt phục hồi thư viện')}</button>}
            </>}
          </div>
        </section>}
      </aside>
    </div>

    {preview&&<section className="operations-card operations-review" role="region" aria-label={t('Confirm reviewed operation','Xác nhận thao tác đã duyệt')}>
      <div className="operations-card__heading"><div><p className="operations-panel__eyebrow">{t('REVIEW BEFORE CONFIRMING','DUYỆT TRƯỚC KHI XÁC NHẬN')}</p><h3 ref={reviewHeading} tabIndex={-1}>{actionText(preview.action)}</h3></div><span className="operations-chip">{preview.projectId??t('Library','Thư viện')}</span></div>
      <p className="operations-review__summary">{reviewText(preview.review)}</p>
      <p className={expired?'operations-panel__warning-text':'muted'}>{t('Review expires','Lượt duyệt hết hạn')}: {new Date(preview.expiresAt).toLocaleTimeString(language==='vi'?'vi-VN':'en-GB')}. {expired?t('Expired','Đã hết hạn'):''}</p>
      <div className="operations-review__footer"><button type="button" disabled={busy||locked} onClick={()=>void rejectPreview()}>{t('Reject preview','Từ chối bản xem trước')}</button><button type="button" className="primary" disabled={blocked||expired} onClick={()=>void confirm()}>{t('Confirm this operation','Xác nhận thao tác này')}</button></div>
    </section>}

    {recoveryReview&&<section className="operations-card operations-review operations-review--recovery" role="region" aria-label={t('Acknowledge current recovery evidence','Xác nhận bằng chứng phục hồi hiện tại')}>
      <p className="operations-panel__eyebrow">{t('RECOVERY REVIEW','DUYỆT PHỤC HỒI')}</p><h3 ref={recoveryHeading} tabIndex={-1}>{t('Current evidence review','Duyệt bằng chứng hiện tại')}</h3>
      <div className="operations-review__evidence">{'items' in recoveryReview.value?<CommonRecoveryEvidence value={recoveryReview.value} language={language}/>:<p>{recoveryReview.value.projectId??t('Library','Thư viện')} · {t('Library format','Định dạng thư viện')} {recoveryReview.value.librarySchema}</p>}</div>
      <p className="operations-review__summary">{t('The previous outcome stays unknown. A separate fresh preview is required for another write.','Kết quả trước vẫn chưa rõ. Cần bản xem trước mới riêng cho thao tác ghi tiếp theo.')}</p>
      {recoveryExpired&&<p className="operations-panel__warning-text">{t('This recovery review expired.','Lượt duyệt phục hồi đã hết hạn.')}</p>}
      <div className="operations-review__footer"><button type="button" disabled={busy} onClick={()=>{pendingFocus.current='trigger';setRecoveryReview(null);}}>{t('Cancel review','Hủy lượt duyệt')}</button><button type="button" className="primary" disabled={disabled||busy||recoveryExpired} onClick={()=>void acknowledge()}>{t('Acknowledge current state','Xác nhận trạng thái hiện tại')}</button></div>
    </section>}
    {write&&!write.projectOperations&&!write.recoveryRequired&&<p className="muted">{t('Project copy and activation capabilities were not enabled for this session.','Phiên này chưa bật quyền sao chép và kích hoạt dự án.')}</p>}
  </section>;
}
