import { isDeepStrictEqual } from 'node:util';
import { ApiError, exact, opaque, requireThat, type Code } from './security.js';
import { nativeOperationCodeToApi, type ActivationReceipt, type CopyMode, type CopyStatus,
  type ProjectOperationOwner, type ProjectOperationReadRequest, type ProjectOperationReadResult,
  type ProjectOperationWriteRequest, type ProjectOperationWriteResult } from './project-operations-owner.js';
import type { RecoveryToken, WriteCoordinator } from './write-coordinator.js';
import { checkedRecoverySubject, type RecoverySubject } from './recovery-subject.js';

export interface ProjectOperationSession { readonly key:string }
export type ProjectOperationAction = ProjectOperationWriteRequest['action'];
export type ProjectOperationReview =
  | {kind:'copy';mode:CopyMode;sourceSchema:1|2;sourceRevision:number;targetSchema:2;targetRevision:number;seedsInternalSites:boolean}
  | {kind:'activation';decision:'prepare'|'activate'|'abandon';mode:CopyMode;sourceRevision:number;targetRevision:number;receiptRevision:number|null;preservesSource:true;preservesLinkedRoot:true}
  | {kind:'library_upgrade';fromSchema:1|2;toSchema:2|3;scope:'library';backupRetained:true};
export interface ProjectOperationPreview {
  id:string;projectId:string|null;action:ProjectOperationAction;expiresAt:string;review:ProjectOperationReview;
}
export type ProjectOperationSummary =
  | {kind:'copy';state:'prepared';sourceRevision:number;targetRevision:number;seedsInternalSites:boolean}
  | {kind:'activation';state:ActivationReceipt['state'];receiptRevision:number;sourceRevision:number;targetRevision:number}
  | {kind:'library_upgrade';fromSchema:1|2;toSchema:2|3};
export interface ProjectOperationResult {
  operationId:string;action:ProjectOperationAction;outcome:'pending'|'confirmed'|'refused'|'unknown';
  code:Code|null;recoveryHandle:string|null;summary:ProjectOperationSummary|null;
}
export interface ProjectOperationJob {
  operationId:string;state:'pending'|'succeeded'|'failed'|'unknown';result:ProjectOperationResult|null;errorCode:Code|null;
}
export interface ProjectOperationRecoveryItem {
  handle:string;kind:'copy'|'activation';state:string;revision:number|null;
}
export interface ProjectOperationRecoveryView {
  handle:string;kind:'copy'|'activation';projectId:string;state:string;condition:string|null;mode:CopyMode|null;
  sourceRevision:number|null;targetRevision:number|null;receiptRevision:number|null;
  canPrepare:boolean;canActivate:boolean;canAbandon:boolean;
}
export interface ProjectOperationRecoveryPreview {
  id:string;projectId:string|null;expiresAt:string;scope:'project'|'activation'|'library';
  priorOutcome:'unknown';freshReviewRequired:true;librarySchema:1|2|3;
}
export interface ProjectOperationsServiceOptions {
  owner:Pick<ProjectOperationOwner,'read'|'write'>;
  coordinator:Pick<WriteCoordinator,'snapshot'|'assertAllowed'|'acquire'|'beginReconciliation'|'acknowledge'|'recovery'>;
  guard:(session:ProjectOperationSession)=>void;
  alive:(session:ProjectOperationSession)=>boolean;
  authorize:(session:ProjectOperationSession,projectId:string|null)=>void;
  grantId:()=>string;
  captureSubject:(request:ProjectOperationWriteRequest,receipt:ActivationReceipt|null)=>Promise<RecoverySubject>;
  verifySubject:(subject:RecoverySubject)=>Promise<void>;
  collectRecovery:(session:ProjectOperationSession,coordinator:Pick<WriteCoordinator,'snapshot'|'recovery'>)=>Promise<{digest:string;librarySchema:1|2|3}>;
  onReconciled:()=>void;
  onConfirmed:(action:ProjectOperationAction,projectId:string|null)=>void|Promise<void>;
  clock?:()=>number;
  pendingMs?:number;
}
type Read<A extends ProjectOperationReadRequest['action']> = Extract<ProjectOperationReadResult,{action:A}>;
type Meta = {session:ProjectOperationSession;project:string|null;grant:string;expires:number};
type Review = Meta & {
  epoch:number;request:ProjectOperationWriteRequest;public:ProjectOperationPreview;
  read:ProjectOperationReadRequest;observed:ProjectOperationReadResult;receipt:ActivationReceipt|null;subject:RecoverySubject;
};
type Handle = Meta & {kind:'copy'|'activation';nativeId:string;libraryUuid:string|null};
type Cursor = Meta & {kind:'copy'|'activation';offset:number;snapshot:string;limit:number};
type Job = Meta & {public:ProjectOperationJob;finished:number|null};
type Recovery = Meta & {
  token:RecoveryToken;digest:string;public:ProjectOperationRecoveryPreview;
};
const reviewTtl=120000, handleTtl=600000, finishedTtl=600000;
function fixed<T>(value:T):T {
  const result=structuredClone(value);
  const freeze=(v:unknown):void=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}};
  freeze(result);return result;
}
function publicId(v:unknown):string {
  requireThat(typeof v==='string'&&/^[A-Za-z0-9_-]{43}$/.test(v));return v;
}
function projectId(v:unknown):string {
  requireThat(typeof v==='string'&&/^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(v));return v;
}
function same(a:unknown,b:unknown):void {requireThat(isDeepStrictEqual(a,b),'CONFIG_CHANGED');}
function apiCode(e:unknown):Code {return e instanceof ApiError?e.code:'OWNER_UNAVAILABLE';}

/** Session-bound broker records. Native IDs, paths and tokens never form browser authority. */
export class ProjectOperationsService {
  private readonly options:Readonly<ProjectOperationsServiceOptions>;
  private readonly clock:()=>number;
  private readonly pendingMs:number;
  private readonly reviews=new Map<string,Review>();
  private readonly handles=new Map<string,Handle>();
  private readonly cursors=new Map<string,Cursor>();
  private readonly recoveries=new Map<string,Recovery>();
  private readonly jobs=new Map<string,Job>();
  private readonly tasks=new Set<Promise<void>>();
  constructor(options:ProjectOperationsServiceOptions) {
    this.options=Object.freeze({...options});
    this.clock=options.clock??Date.now;this.pendingMs=options.pendingMs??8000;
    requireThat(Number.isFinite(this.pendingMs)&&this.pendingMs>=0&&this.pendingMs<=8000);
  }
  private check(session:ProjectOperationSession,project:string|null,grant?:string):string {
    if(project!==null)projectId(project);
    this.options.guard(session);
    requireThat(this.options.alive(session),'SESSION_EXPIRED');
    this.options.authorize(session,project);
    const current=this.options.grantId();
    requireThat(typeof current==='string'&&current.length>0,'SCOPE_DENIED');
    if(grant!==undefined)requireThat(current===grant,'SCOPE_DENIED');
    return current;
  }
  private meta(session:ProjectOperationSession,project:string|null,ttl:number):Meta {
    return {session,project,grant:this.check(session,project),expires:this.clock()+ttl};
  }
  private retained<T extends Meta>(map:Map<string,T>,session:ProjectOperationSession,project:string|null,id:string):T {
    this.check(session,project);publicId(id);
    const value=map.get(id);
    requireThat(value&&value.session===session&&value.project===project,'PREVIEW_EXPIRED');
    requireThat(value.expires>this.clock(),'PREVIEW_EXPIRED');
    this.check(session,project,value.grant);return value;
  }
  private room<T extends Meta>(map:Map<string,T>,session:ProjectOperationSession,perSession:number,total:number):void {
    this.cleanup();
    requireThat(map.size<total&&[...map.values()].filter(v=>v.session===session).length<perSession,'LIMIT_EXCEEDED');
  }
  private async read<A extends ProjectOperationReadRequest['action']>(
    meta:Meta,request:Extract<ProjectOperationReadRequest,{action:A}>,verify=false
  ):Promise<Read<A>> {
    const guard=()=>this.check(meta.session,meta.project,meta.grant);
    guard();
    try {
      const result=await this.options.owner.read(request,{verify,guard:()=>{guard();}});
      guard();requireThat(result.action===request.action,'OWNER_UNAVAILABLE');
      return result as Read<A>;
    } catch(error) {guard();throw error;}
  }
  private currentReview(session:ProjectOperationSession,project:string|null):Meta & {epoch:number} {
    const meta=this.meta(session,project,reviewTtl);
    this.options.coordinator.assertAllowed();
    return {...meta,epoch:this.options.coordinator.snapshot().epoch};
  }
  private reviewedLibrary(observed:ProjectOperationReadResult) {
    if('libraryIdentity' in observed)return observed.libraryIdentity;
    if(observed.action==='activation-candidate')return observed.preview.library;
    if(observed.action==='library-format-preview')
      return 'source' in observed.expected?observed.expected.source:observed.expected;
    throw new ApiError('OWNER_UNAVAILABLE');
  }
  private async storeReview(meta:Meta & {epoch:number},request:ProjectOperationWriteRequest,
    read:ProjectOperationReadRequest,observed:ProjectOperationReadResult,review:ProjectOperationReview,
    receipt:ActivationReceipt|null=null):Promise<ProjectOperationPreview> {
    this.check(meta.session,meta.project,meta.grant);
    requireThat(meta.expires>this.clock(),'PREVIEW_EXPIRED');
    this.options.coordinator.assertAllowed(meta.epoch);
    const subject=checkedRecoverySubject(await this.options.captureSubject(request,receipt));
    requireThat(subject.kind==='project_operations'&&subject.action===request.action&&subject.projectId===meta.project&&subject.grantId===meta.grant,'SCOPE_DENIED');
    // Physical identity is captured within the review boundary, before the
    // browser can hold the preview. Close the observation/capture interval.
    const library=await this.read(meta,{action:'library-format-status'},true);
    same(library.libraryIdentity,this.reviewedLibrary(observed));
    same(await this.read(meta,read,true),observed);
    this.check(meta.session,meta.project,meta.grant);
    requireThat(meta.expires>this.clock(),'PREVIEW_EXPIRED');
    this.options.coordinator.assertAllowed(meta.epoch);
    this.room(this.reviews,meta.session,64,256);
    const id=opaque(),value:ProjectOperationPreview={id,projectId:meta.project,action:request.action,
      expiresAt:new Date(meta.expires).toISOString(),review};
    this.reviews.set(id,{...meta,request:fixed(request),read:fixed(read),observed:fixed(observed),
      receipt:receipt?fixed(receipt):null,subject,public:fixed(value)});
    return fixed(value);
  }
  private handle(meta:Meta,kind:Handle['kind'],nativeId:string,libraryUuid:string|null):string {
    requireThat(meta.project!==null,'SCOPE_DENIED');
    this.check(meta.session,meta.project,meta.grant);
    for(const [id,h] of this.handles)if(h.session===meta.session&&h.project===meta.project&&h.grant===meta.grant&&
      h.kind===kind&&h.nativeId===nativeId&&h.libraryUuid===libraryUuid&&h.expires>this.clock())return id;
    this.room(this.handles,meta.session,256,1024);
    const id=opaque();this.handles.set(id,{...meta,expires:this.clock()+handleTtl,kind,nativeId,libraryUuid});return id;
  }
  async projectStatus(session:ProjectOperationSession,project:string) {
    const meta=this.meta(session,project,reviewTtl),value=await this.read(meta,{action:'inspect',projectId:project});
    requireThat(value.project.projectId===project,'SCOPE_DENIED');
    return {projectId:project,projectSchema:value.project.schemaVersion,projectRevision:value.project.revision,
      librarySchema:value.libraryIdentity.schema,capabilities:{
        copyModes:[value.project.schemaVersion===1?'migrate_v1':'clone_v2'] as CopyMode[],
        activation:value.libraryIdentity.schema===3},
      recoveryRequired:this.options.coordinator.snapshot().recoveryRequired};
  }
  async libraryStatus(session:ProjectOperationSession) {
    const value=await this.read(this.meta(session,null,reviewTtl),{action:'library-format-status'});
    return {librarySchema:value.libraryIdentity.schema,canUpgrade:value.libraryIdentity.schema<3,
      recoveryRequired:this.options.coordinator.snapshot().recoveryRequired};
  }
  async copyPreview(session:ProjectOperationSession,project:string,body:unknown):Promise<ProjectOperationPreview> {
    const o=exact(body,['mode']);requireThat(o.mode==='migrate_v1'||o.mode==='clone_v2');
    const meta=this.currentReview(session,project),read={action:'copy-preview',projectId:project,mode:o.mode} as const;
    const value=await this.read(meta,read),p=value.preview;
    requireThat(value.projectId===project&&p.source.projectId===project,'SCOPE_DENIED');
    return this.storeReview(meta,{action:'copy-prepare',projectId:project,expected:{libraryIdentity:value.libraryIdentity,preview:p}},
      read,value,{kind:'copy',mode:p.mode,sourceSchema:p.source.schemaVersion,sourceRevision:p.source.revision,
        targetSchema:2,targetRevision:p.targetRevision,seedsInternalSites:p.seedsInternalSites});
  }
  async libraryPreview(session:ProjectOperationSession,body:unknown):Promise<ProjectOperationPreview> {
    const o=exact(body,['fromSchema']);requireThat(o.fromSchema===1||o.fromSchema===2);
    const meta=this.currentReview(session,null),read={action:'library-format-preview',fromSchema:o.fromSchema} as const;
    const value=await this.read(meta,read);
    const request:ProjectOperationWriteRequest=value.fromSchema===1?
      {action:'library-upgrade-v1',expected:value.expected as Read<'library-format-status'>['libraryIdentity']}:
      {action:'library-upgrade-v2',expected:value.expected as Extract<ProjectOperationWriteRequest,{action:'library-upgrade-v2'}>['expected']};
    return this.storeReview(meta,request,read,value,{kind:'library_upgrade',fromSchema:value.fromSchema,
      toSchema:value.toSchema,scope:'library',backupRetained:true});
  }
  copies(session:ProjectOperationSession,project:string,body:unknown) {return this.page(session,project,body,'copy');}
  activations(session:ProjectOperationSession,project:string,body:unknown) {return this.page(session,project,body,'activation');}
  private async page(session:ProjectOperationSession,project:string,body:unknown,kind:Handle['kind']) {
    const o=exact(body,['limit','cursor']);
    requireThat(typeof o.limit==='number'&&Number.isInteger(o.limit)&&o.limit>=1&&o.limit<=50);
    requireThat(o.cursor===null||typeof o.cursor==='string');
    const meta=this.meta(session,project,reviewTtl);
    let offset=0,snapshot:string|null=null;
    if(o.cursor!==null) {
      const cursor=this.retained(this.cursors,session,project,publicId(o.cursor));
      requireThat(cursor.kind===kind&&cursor.limit===o.limit,'INVALID_INPUT');
      offset=cursor.offset;snapshot=cursor.snapshot;
    }
    const items:ProjectOperationRecoveryItem[]=[];
    let nextOffset:number|null=offset,budget=0;
    while(nextOffset!==null&&items.length<o.limit) {
      requireThat(++budget<=21,'LIMIT_EXCEEDED');
      const page:Read<'copy-discover'>|Read<'activation-history'>=kind==='copy'?await this.read(meta,{action:'copy-discover',offset:nextOffset,limit:50,snapshot}):
        await this.read(meta,{action:'activation-history',projectId:project,offset:nextOffset,limit:50,snapshot});
      if(page.action==='copy-discover')requireThat(page.complete&&page.code==='NONE',
        nativeOperationCodeToApi(page.code)??'OWNER_UNAVAILABLE');
      if(page.action==='activation-history')requireThat(page.projectId===project,'SCOPE_DENIED');
      if(snapshot!==null)same(page.snapshot,snapshot);
      snapshot=page.snapshot;nextOffset=page.nextOffset;
      for(let index=0;index<page.items.length;index++) {
        if(page.action==='copy-discover') {
          const item=page.items[index];
          if(!item.intent||item.intent.source.projectId!==project||item.intent.target.projectId!==project)continue;
          items.push({handle:this.handle(meta,'copy',item.operationId,null),kind:'copy',state:item.state,revision:null});
        } else {
          const item=page.items[index];requireThat(item.projectId===project,'SCOPE_DENIED');
          requireThat(page.libraryIdentity.uuid!==null,'OWNER_UNAVAILABLE');
          items.push({handle:this.handle(meta,'activation',item.operationId,page.libraryIdentity.uuid),
            kind:'activation',state:item.state,revision:item.revision});
        }
        if(items.length===o.limit) {
          if(index+1<page.items.length)nextOffset=page.offset+index+1;
          break;
        }
      }
      requireThat(nextOffset===null||nextOffset>page.offset,'OWNER_UNAVAILABLE');
    }
    let nextCursor:string|null=null;
    if(nextOffset!==null) {
      requireThat(snapshot!==null,'OWNER_UNAVAILABLE');this.room(this.cursors,session,64,256);
      nextCursor=opaque();this.cursors.set(nextCursor,{...meta,kind,offset:nextOffset,snapshot,limit:o.limit});
    }
    this.check(session,project,meta.grant);return {items,nextCursor};
  }
  private checkReceipt(receipt:ActivationReceipt,project:string,handle?:Handle):void {
    requireThat(receipt.prepared.projectId===project&&receipt.prepared.source.projectId===project&&
      receipt.prepared.target.projectId===project,'SCOPE_DENIED');
    if(handle)requireThat(receipt.token.operationId===handle.nativeId&&receipt.token.libraryUuid===handle.libraryUuid,'CONFIG_CHANGED');
  }
  async recovery(session:ProjectOperationSession,project:string,id:string):Promise<ProjectOperationRecoveryView> {
    const h=this.retained(this.handles,session,project,id);
    if(h.kind==='copy') {
      const {status:s}=await this.read(h,{action:'copy-inspect',operationId:h.nativeId});
      requireThat(s.operationId===h.nativeId,'OWNER_UNAVAILABLE');
      if(s.source)requireThat(s.source.projectId===project&&s.target?.projectId===project,'SCOPE_DENIED');
      return {handle:id,kind:'copy',projectId:project,state:s.state,condition:null,mode:s.mode,
        sourceRevision:s.source?.revision??null,targetRevision:s.target?.revision??null,receiptRevision:null,
        canPrepare:s.state==='prepared',canActivate:false,canAbandon:false};
    }
    const value=await this.read(h,{action:'activation-inspect',libraryUuid:h.libraryUuid!,operationId:h.nativeId});
    const r=value.receipt;this.checkReceipt(r,project,h);
    return {handle:id,kind:'activation',projectId:project,state:r.state,condition:value.condition,mode:r.prepared.mode,
      sourceRevision:r.prepared.source.revision,targetRevision:r.prepared.target.revision,receiptRevision:r.token.revision,
      canPrepare:false,canActivate:r.state==='prepared'&&value.condition==='prepared_current'&&value.code==='NONE',
      canAbandon:r.state==='prepared'};
  }
  async activationPreview(session:ProjectOperationSession,project:string,body:unknown):Promise<ProjectOperationPreview> {
    const o=exact(body,['copyHandle']),h=this.retained(this.handles,session,project,publicId(o.copyHandle));
    requireThat(h.kind==='copy','INVALID_INPUT');
    const meta=this.currentReview(session,project),read={action:'activation-candidate',projectId:project,copyOperationId:h.nativeId} as const;
    const value=await this.read(meta,read),p=value.preview;
    requireThat(p.projectId===project&&p.source.projectId===project&&p.target.projectId===project&&p.copyOperationId===h.nativeId,'SCOPE_DENIED');
    return this.storeReview(meta,{action:'activation-prepare',expected:p},read,value,
      {kind:'activation',decision:'prepare',mode:p.mode,sourceRevision:p.source.revision,targetRevision:p.target.revision,
        receiptRevision:null,preservesSource:true,preservesLinkedRoot:true});
  }
  async decisionPreview(session:ProjectOperationSession,project:string,body:unknown):Promise<ProjectOperationPreview> {
    const o=exact(body,['activationHandle','decision']);requireThat(o.decision==='activate'||o.decision==='abandon');
    const h=this.retained(this.handles,session,project,publicId(o.activationHandle));
    requireThat(h.kind==='activation','INVALID_INPUT');
    const meta=this.currentReview(session,project),read={action:'activation-inspect',libraryUuid:h.libraryUuid!,operationId:h.nativeId} as const;
    const value=await this.read(meta,read),r=value.receipt;this.checkReceipt(r,project,h);
    requireThat(r.state==='prepared','CONFIG_CHANGED');
    if(o.decision==='activate')requireThat(value.condition==='prepared_current'&&value.code==='NONE','CONFIG_CHANGED');
    return this.storeReview(meta,{action:o.decision==='activate'?'activation-activate':'activation-abandon',projectId:project,expected:r.token},
      read,value,{kind:'activation',decision:o.decision,mode:r.prepared.mode,sourceRevision:r.prepared.source.revision,
        targetRevision:r.prepared.target.revision,receiptRevision:r.token.revision,preservesSource:true,preservesLinkedRoot:true},r);
  }
  reject(session:ProjectOperationSession,project:string|null,id:string) {
    this.retained(this.reviews,session,project,id);this.reviews.delete(id);return {rejected:true};
  }
  private async recheck(review:Review):Promise<void> {
    this.check(review.session,review.project,review.grant);
    requireThat(review.expires>this.clock(),'PREVIEW_EXPIRED');
    this.options.coordinator.assertAllowed(review.epoch);
    if(review.request.action==='activation-abandon') {
      const expected=review.request.expected;
      // Abandon's queued guard uses durable library/history only. It must work
      // even when the source, target and original copy parent are unavailable.
      const lib=await this.read(review,{action:'library-format-status'},true);
      same(lib.libraryIdentity,(review.observed as Read<'activation-inspect'>).libraryIdentity);
      let offset=0,snapshot:string|null=null,found=false;
      for(let page=0;page<21;page++) {
        const value:Read<'activation-history'>=await this.read(review,{action:'activation-history',projectId:review.project!,offset,limit:50,snapshot},true);
        same(value.libraryIdentity,lib.libraryIdentity);
        const item=value.items.find(v=>v.operationId===expected.operationId);
        if(item) {
          requireThat(item.projectId===review.project&&item.state==='prepared'&&item.revision===expected.revision,'CONFIG_CHANGED');
          found=true;break;
        }
        if(value.nextOffset===null)break;
        requireThat(value.nextOffset>offset,'OWNER_UNAVAILABLE');offset=value.nextOffset;snapshot=value.snapshot;
      }
      requireThat(found,'CONFIG_CHANGED');
    } else {
      // Refuse an already changed selection before a selected-store reader.
      // Native conditional reads are still needed to close the concurrent gap.
      const library=await this.read(review,{action:'library-format-status'},true);
      same(library.libraryIdentity,this.reviewedLibrary(review.observed));
      same(await this.read(review,review.read,true),review.observed);
    }
    this.check(review.session,review.project,review.grant);
    requireThat(review.expires>this.clock(),'PREVIEW_EXPIRED');
    this.options.coordinator.assertAllowed(review.epoch);
  }
  async commit(session:ProjectOperationSession,project:string|null,body:unknown):Promise<ProjectOperationResult> {
    const o=exact(body,['previewId']),id=publicId(o.previewId);
    const review=this.retained(this.reviews,session,project,id);
    this.cleanup();requireThat(this.jobs.size<128,'LIMIT_EXCEEDED');
    // Contention refuses before consuming the reviewed request.
    const lease=this.options.coordinator.acquire('exclusive',project,review.epoch,review.subject);
    let job:Job,operationId:string;
    try {
      operationId=opaque();job={...review,expires:Number.POSITIVE_INFINITY,finished:null,
        public:{operationId,state:'pending',result:null,errorCode:null}};
      this.jobs.set(operationId,job);this.reviews.delete(id);
    } catch(error) {
      lease.release('known');throw error;
    }
    const pending:ProjectOperationResult={operationId,action:review.request.action,outcome:'pending',code:null,recoveryHandle:null,summary:null};
    const task=(async()=>{
      let release:'known'|'unknown'='unknown';
      try {
        let native:ProjectOperationWriteResult;
        try {native=await this.options.owner.write(review.request,{guard:async()=>{
          await lease.beforeStart();
          await this.options.verifySubject(review.subject);
          await this.recheck(review);
          await this.options.verifySubject(review.subject);
          this.check(review.session,review.project,review.grant);
          this.options.coordinator.assertAllowed(review.epoch);
        }});}
        catch {native={started:true,preflightCode:null,reply:{schema:'lmti.project.operation.write.v1',action:review.request.action,
          outcome:'unknown',code:'OWNER_UNAVAILABLE',operationId:null,details:null,detailsAvailable:false}};}
        let result:ProjectOperationResult={...pending,outcome:native.reply.outcome,
          code:native.preflightCode??nativeOperationCodeToApi(native.reply.code)};
        let details=native.reply.details,reliable=true;
        if(review.receipt&&details&&'receipt' in details) {
          const r=details.receipt;
          reliable=isDeepStrictEqual(r.prepared,review.receipt.prepared)&&r.sourceFolder===review.receipt.sourceFolder&&
            r.sourceFolderKey===review.receipt.sourceFolderKey;
        }
        if(!reliable) {result={...pending,outcome:'unknown',code:'RECOVERY_REQUIRED'};details=null;}
        release=result.outcome==='unknown'||(result.outcome==='confirmed'&&!native.reply.detailsAvailable)?'unknown':'known';
        // Disclosure metadata is optional. A failed allocation/session cleanup
        // must never turn a previously confirmed owner result into a refusal.
        try {
          if(details&&this.options.alive(session)) {
            if('receipt' in details) {
              const r=details.receipt;this.checkReceipt(r,project!);
              result.recoveryHandle=this.handle(review,'activation',r.token.operationId,r.token.libraryUuid);
              if(result.outcome==='confirmed')result.summary={kind:'activation',state:r.state,receiptRevision:r.token.revision,
                sourceRevision:r.prepared.source.revision,targetRevision:r.prepared.target.revision};
            } else if('source' in details) {
              const s=details as CopyStatus;
              if(s.source&&s.target) {
                requireThat(s.source.projectId===project&&s.target.projectId===project,'SCOPE_DENIED');
                result.recoveryHandle=this.handle(review,'copy',s.operationId,null);
                if(result.outcome==='confirmed')result.summary={kind:'copy',state:'prepared',sourceRevision:s.source.revision,
                  targetRevision:s.target.revision,seedsInternalSites:s.seedsInternalSites!};
              }
            } else if(result.outcome==='confirmed') {
              const fromSchema=review.request.action==='library-upgrade-v1'?1:2;
              result.summary={kind:'library_upgrade',fromSchema,toSchema:fromSchema===1?2:3};
            }
          }
        } catch {result={...result,recoveryHandle:null,summary:null};if(result.outcome==='confirmed')release='unknown';}
        job.public=fixed({operationId,state:result.outcome==='confirmed'?'succeeded':result.outcome==='refused'?'failed':'unknown',
          result,errorCode:result.outcome==='refused'?result.code:null});
        if(result.outcome==='confirmed') {
          this.invalidate(review.request.action==='copy-prepare'?project??undefined:undefined);
          try {await this.options.onConfirmed(review.request.action,project);}catch {/* The native result is already latched. */}
        }
      } finally {
        if(job.public.state==='pending')job.public=fixed({operationId,state:'unknown',
          result:{...pending,outcome:'unknown',code:'RECOVERY_REQUIRED'},errorCode:null});
        job.finished=this.clock();
        lease.release(release);
      }
    })();
    this.tasks.add(task);void task.then(()=>this.tasks.delete(task),()=>this.tasks.delete(task));
    let timer:ReturnType<typeof setTimeout>|undefined;
    await Promise.race([task,new Promise<void>(resolve=>{timer=setTimeout(resolve,this.pendingMs);})]);
    if(timer!==undefined)clearTimeout(timer);
    this.check(session,project,review.grant);
    return fixed(job.public.result??pending);
  }
  lookup(session:ProjectOperationSession,id:string):ProjectOperationJob|null {
    publicId(id);const job=this.jobs.get(id);if(!job)return null;
    requireThat(job.session===session,'SCOPE_DENIED');this.check(session,job.project,job.grant);
    return fixed(job.public);
  }
  async recoveryPreview(session:ProjectOperationSession,project:string|null,body:unknown):Promise<ProjectOperationRecoveryPreview> {
    const o=exact(body,['activationHandle']);requireThat(o.activationHandle===null||typeof o.activationHandle==='string');
    const meta=this.meta(session,project,reviewTtl);
    this.recoverySubject(project);
    let scope:ProjectOperationRecoveryPreview['scope']=project===null?'library':'project';
    if(o.activationHandle!==null) {
      requireThat(project!==null,'INVALID_INPUT');
      const h=this.retained(this.handles,session,project,publicId(o.activationHandle));
      requireThat(h.kind==='activation','INVALID_INPUT');scope='activation';
    }
    const token=this.options.coordinator.beginReconciliation();
    const evidence=await this.options.collectRecovery(session,this.options.coordinator);
    this.check(session,project,meta.grant);
    requireThat(/^[a-f0-9]{64}$/.test(evidence.digest),'OWNER_UNAVAILABLE');
    requireThat(token.epoch===this.options.coordinator.snapshot().epoch&&token.expiresAt>this.clock(),'PREVIEW_EXPIRED');
    this.room(this.recoveries,session,64,256);
    const id=opaque(),value:ProjectOperationRecoveryPreview={id,projectId:project,expiresAt:new Date(meta.expires).toISOString(),
      scope,priorOutcome:'unknown',freshReviewRequired:true,librarySchema:evidence.librarySchema};
    this.recoveries.set(id,{...meta,token,digest:evidence.digest,public:fixed(value)});
    return fixed(value);
  }
  private recoverySubject(project:string|null):void {
    const subjects=this.options.coordinator.recovery().subjects;
    requireThat(subjects.length===0||subjects.some(entry=>entry.subject.projectId===project),'RECOVERY_REQUIRED');
  }
  async acknowledgeRecovery(session:ProjectOperationSession,project:string|null,body:unknown) {
    const o=exact(body,['previewId']),id=publicId(o.previewId);
    const review=this.retained(this.recoveries,session,project,id);
    this.recoverySubject(project);
    const evidence=await this.options.collectRecovery(session,this.options.coordinator);same(evidence.digest,review.digest);
    this.check(session,project,review.grant);requireThat(review.expires>this.clock(),'PREVIEW_EXPIRED');
    // The shared collector has inspected every retained original target twice.
    // The coordinator pins the exact full set and persists acknowledgment first.
    await this.options.coordinator.acknowledge(review.token);
    this.recoveries.delete(id);this.invalidate();
    try {this.options.onReconciled();}catch {/* Explicit acknowledgment is already recorded. */}
    return {reconciled:true,priorOutcome:'unknown',freshReviewRequired:true} as const;
  }
  invalidate(project?:string):void {
    for(const map of [this.reviews,this.cursors,this.recoveries] as const)
      for(const [id,value] of map)if(project===undefined||value.project===project)map.delete(id);
  }
  cleanup():void {
    const now=this.clock();
    for(const map of [this.reviews,this.handles,this.cursors,this.recoveries] as const)
      for(const [id,value] of map)if(value.expires<=now||!this.options.alive(value.session))map.delete(id);
    for(const [id,job] of this.jobs)if(job.finished!==null&&(now-job.finished>=finishedTtl||!this.options.alive(job.session)))this.jobs.delete(id);
  }
  isIdle():boolean {return this.tasks.size===0;}
  async waitForIdle():Promise<void> {while(this.tasks.size)await Promise.allSettled([...this.tasks]);}
}
