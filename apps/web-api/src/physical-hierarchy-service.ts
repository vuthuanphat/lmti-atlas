import { exact, opaque, requireThat, type Code } from './security.js';
import { checkedPhysicalHierarchyProposal, nativePhysicalHierarchyCodeToApi,
  type PhysicalHierarchyExpected, type PhysicalSite, type PhysicalArea, type PhysicalEnvironment, type PhysicalAssetAnchor,
  type PhysicalPlacement, type PhysicalHierarchyPath, type PhysicalHierarchyDiff,
  type PhysicalHierarchyGrant, type PhysicalHierarchyOwner, type PhysicalHierarchyProjection,
  type PhysicalHierarchyReadResult, type PhysicalHierarchyWriteRequest,
  type PhysicalHierarchyWriteResult } from './physical-hierarchy-owner.js';
import { checkedRecoverySubject, type RecoverySubject } from './recovery-subject.js';
import type { WriteCoordinator } from './write-coordinator.js';

export interface PhysicalHierarchySession {readonly key:string}
export interface PhysicalHierarchyPreview {
  readonly id:string; readonly projectId:string; readonly revision:number;
  readonly expiresAt:string; readonly diff:PhysicalHierarchyDiff;
}
export interface PhysicalHierarchyResult {
  readonly operationId:string; readonly action:'physical-hierarchy-commit';
  readonly outcome:'pending'|'confirmed'|'refused'|'unknown'; readonly code:Code|null;
  readonly summary:{readonly projectId:string;readonly previousRevision:number;readonly revision:number}|null;
}
export interface PhysicalHierarchyJob {
  readonly operationId:string; readonly state:'pending'|'succeeded'|'failed'|'unknown';
  readonly result:PhysicalHierarchyResult|null; readonly errorCode:Code|null;
}
type State=Extract<PhysicalHierarchyReadResult,{action:'physical-hierarchy-state'}>;
type Guard=()=>void|Promise<void>;
export interface PhysicalHierarchyServiceOptions {
  owner:Pick<PhysicalHierarchyOwner,'read'|'write'>;
  coordinator:Pick<WriteCoordinator,'snapshot'|'assertAllowed'|'acquire'>;
  guard:(session:PhysicalHierarchySession)=>void;
  alive:(session:PhysicalHierarchySession)=>boolean;
  authorize:(session:PhysicalHierarchySession,projectId:string)=>void;
  grants:()=>readonly PhysicalHierarchyGrant[];
  grantId:(projectId:string)=>string;
  captureSubject:(projectId:string,expected:PhysicalHierarchyExpected,options:{guard:Guard})=>Promise<RecoverySubject>;
  conditionalState:(subject:RecoverySubject,options:{guard:Guard})=>Promise<State>;
  onConfirmed:(projectId:string)=>void|Promise<void>;
  clock?:()=>number;
  pendingMs?:number;
}
type Meta={session:PhysicalHierarchySession;project:string;grant:string;expires:number};
type Review=Meta & {epoch:number;request:PhysicalHierarchyWriteRequest;subject:RecoverySubject;public:PhysicalHierarchyPreview};
type Job=Meta & {public:PhysicalHierarchyJob;finished:number|null};
const reviewTtl=120000,finishedTtl=600000,httpCap=256*1024;
const identifier=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(value);
function publicId(value:unknown):string {
  requireThat(typeof value==='string'&&/^[A-Za-z0-9_-]{43}$/.test(value));return value;
}
function fixed<T>(value:T):T {
  const result=structuredClone(value);
  const freeze=(v:unknown):void=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}};
  freeze(result);return result;
}
// Match the server's complete success envelope, including its fixed-width ID.
// A partial diff/tree must never become an actionable review.
function publicResult<T>(value:T):T {
  requireThat(Buffer.byteLength(JSON.stringify({apiVersion:1,requestId:'x'.repeat(43),ok:true,data:value}))<=httpCap,'LIMIT_EXCEEDED');
  return fixed(value);
}
function site(value:PhysicalSite):PhysicalSite {
  return {id:value.id,label:value.label,privacy:value.privacy};
}
function area(value:PhysicalArea):PhysicalArea {
  return {id:value.id,label:value.label,siteId:value.siteId,parentAreaId:value.parentAreaId,privacy:value.privacy};
}
function environment(value:PhysicalEnvironment):PhysicalEnvironment {
  return {id:value.id,label:value.label,privacy:value.privacy};
}
function asset(value:PhysicalAssetAnchor):PhysicalAssetAnchor {
  return {id:value.id,label:value.label,site:value.site,kind:value.kind,privacy:value.privacy};
}
function placement(value:PhysicalPlacement|null):PhysicalPlacement|null {
  return value===null?null:{assetId:value.assetId,areaId:value.areaId,parentAssetId:value.parentAssetId,
    environmentId:value.environmentId,role:value.role};
}
function path(value:PhysicalHierarchyPath):PhysicalHierarchyPath {
  return {siteId:value.siteId,areaAncestors:[...value.areaAncestors],assetAncestors:[...value.assetAncestors],
    environmentId:value.environmentId};
}
function projection(value:PhysicalHierarchyProjection):PhysicalHierarchyProjection {
  return {projectId:value.projectId,revision:value.revision,
    sites:value.sites.map(row=>({value:site(row.value),classification:row.classification})),
    areas:value.areas.map(row=>({value:area(row.value),ancestors:[...row.ancestors],classification:row.classification})),
    environments:value.environments.map(row=>({value:environment(row.value),classification:row.classification})),
    assets:value.assets.map(row=>({value:asset(row.value),placement:placement(row.placement),
      path:path(row.path),classification:row.classification}))};
}
function diff(value:PhysicalHierarchyDiff):PhysicalHierarchyDiff {
  return {sites:value.sites.map(row=>({id:row.id,
      before:row.before===null?null:site(row.before),after:row.after===null?null:site(row.after)})),
    areas:value.areas.map(row=>({id:row.id,
      before:row.before===null?null:area(row.before),after:row.after===null?null:area(row.after)})),
    environments:value.environments.map(row=>({id:row.id,
      before:row.before===null?null:environment(row.before),after:row.after===null?null:environment(row.after)})),
    placements:value.placements.map(row=>({assetId:row.assetId,before:placement(row.before),after:placement(row.after)})),
    affected:value.affected.map(row=>({kind:row.kind,id:row.id,beforeClassification:row.beforeClassification,
      afterClassification:row.afterClassification,beforePath:path(row.beforePath),afterPath:path(row.afterPath)}))};
}
function samePins(current:State,expected:PhysicalHierarchyExpected):void {
  const a=current.libraryIdentity,b=expected.libraryIdentity,p=current.projectIdentity,q=expected.reviewToken;
  requireThat(current.action==='physical-hierarchy-state'&&
    a.schema===b.schema&&a.canonicalPath===b.canonicalPath&&a.uuid===b.uuid&&
    a.generation===b.generation&&a.digest===b.digest&&
    p.schemaVersion===q.schemaVersion&&p.projectId===q.projectId&&p.canonicalPath===q.canonicalPath&&
    p.storeUuid===q.storeUuid&&p.revision===q.revision&&p.contentDigest===q.contentDigest&&p.registryDigest===q.registryDigest,
  'CONFIG_CHANGED');
}

/** Browser reviews/jobs only. The existing coordinator owns recovery subjects. */
export class PhysicalHierarchyService {
  private readonly options:PhysicalHierarchyServiceOptions;
  private readonly clock:()=>number;
  private readonly pendingMs:number;
  private readonly reviews=new Map<string,Review>();
  private readonly jobs=new Map<string,Job>();
  private readonly tasks=new Set<Promise<void>>();
  constructor(options:PhysicalHierarchyServiceOptions) {
    this.options=Object.freeze({...options});this.clock=options.clock??Date.now;this.pendingMs=options.pendingMs??8000;
    requireThat(Number.isFinite(this.pendingMs)&&this.pendingMs>=0&&this.pendingMs<=8000);
  }
  private check(session:PhysicalHierarchySession,project:string,expectedGrant?:string):string {
    requireThat(identifier(project));this.options.guard(session);
    requireThat(this.options.alive(session),'SESSION_EXPIRED');this.options.authorize(session,project);
    requireThat(this.options.grants().some(g=>g.projectId===project),'SCOPE_DENIED');
    const grant=this.options.grantId(project);
    requireThat(typeof grant==='string'&&/^[a-f0-9]{64}$/.test(grant)&&
      (expectedGrant===undefined||grant===expectedGrant),'SCOPE_DENIED');return grant;
  }
  private meta(session:PhysicalHierarchySession,project:string):Meta {
    return {session,project,grant:this.check(session,project),expires:this.clock()+reviewTtl};
  }
  private guard(review:Meta & {epoch:number}):void {
    this.check(review.session,review.project,review.grant);
    requireThat(review.expires>this.clock(),'PREVIEW_EXPIRED');this.options.coordinator.assertAllowed(review.epoch);
  }
  private retained(session:PhysicalHierarchySession,project:string,id:string):Review {
    this.check(session,project);publicId(id);
    const review=this.reviews.get(id);
    requireThat(review&&review.session===session&&review.project===project,'PREVIEW_EXPIRED');
    this.check(session,project,review.grant);
    requireThat(review.expires>this.clock(),'PREVIEW_EXPIRED');return review;
  }
  scopes(session:PhysicalHierarchySession):{projects:readonly PhysicalHierarchyGrant[]} {
    this.options.guard(session);requireThat(this.options.alive(session),'SESSION_EXPIRED');
    const projects=this.options.grants().map(g=>{
      this.check(session,g.projectId);return {projectId:g.projectId,allowInternal:g.allowInternal};
    });
    return publicResult({projects});
  }
  async state(session:PhysicalHierarchySession,project:string):Promise<PhysicalHierarchyProjection> {
    const meta=this.meta(session,project),guard=()=>{this.check(session,project,meta.grant);};
    guard();let value:PhysicalHierarchyReadResult;
    try {value=await this.options.owner.read(project,{action:'physical-hierarchy-state'},{guard});}
    catch(error){guard();throw error;}
    guard();requireThat(value.action==='physical-hierarchy-state'&&value.projection.projectId===project,'OWNER_UNAVAILABLE');
    return publicResult(projection(value.projection));
  }
  async preview(session:PhysicalHierarchySession,project:string,body:unknown):Promise<PhysicalHierarchyPreview> {
    const input=exact(body,['proposal']),proposal=checkedPhysicalHierarchyProposal(input.proposal);
    const meta={...this.meta(session,project),epoch:this.options.coordinator.snapshot().epoch};
    requireThat(proposal.projectId===project,'SCOPE_DENIED');
    const guard=()=>this.guard(meta);guard();
    let observed:PhysicalHierarchyReadResult;
    try {observed=await this.options.owner.read(project,{action:'physical-hierarchy-preview',proposal},{guard});}
    catch(error){guard();throw error;}
    guard();requireThat(observed.action==='physical-hierarchy-preview','OWNER_UNAVAILABLE');
    const request=fixed({action:'physical-hierarchy-commit',expected:observed.expected} as const);
    // The private owner also checks this. Keep a service-side gate before any
    // retained review so complete transport framing cannot become uncommittable.
    requireThat(Buffer.byteLength(JSON.stringify(request)+'\n')<=64*1024,'LIMIT_EXCEEDED');
    const value=publicResult({id:opaque(),projectId:project,revision:observed.expected.reviewToken.revision,
      expiresAt:new Date(meta.expires).toISOString(),diff:diff(observed.diff)});
    // Capture original physical provenance inside this deliberate review, then
    // close that interval using the conditional original-target native read.
    let subject:RecoverySubject;
    try {
      subject=checkedRecoverySubject(await this.options.captureSubject(project,request.expected,{guard}));
      guard();requireThat(subject.kind==='physical_hierarchy'&&subject.action==='physical-hierarchy-commit'&&
        subject.projectId===project&&subject.grantId===meta.grant,'SCOPE_DENIED');
      const current=await this.options.conditionalState(subject,{guard});guard();samePins(current,request.expected);
    } catch(error){guard();throw error;}
    guard();this.cleanup();
    requireThat(this.reviews.size<256&&[...this.reviews.values()].filter(r=>r.session===session).length<64,'LIMIT_EXCEEDED');
    this.reviews.set(value.id,{...meta,request,subject,public:value});return value;
  }
  reject(session:PhysicalHierarchySession,project:string,id:string):{rejected:true} {
    this.retained(session,project,id);this.reviews.delete(id);return {rejected:true};
  }
  private async recheck(review:Review):Promise<void> {
    const guard=()=>this.guard(review);guard();
    let current:State;
    try {current=await this.options.conditionalState(review.subject,{guard});}
    catch(error){guard();throw error;}
    guard();samePins(current,review.request.expected);
  }
  async commit(session:PhysicalHierarchySession,project:string,body:unknown):Promise<PhysicalHierarchyResult> {
    const input=exact(body,['previewId']),review=this.retained(session,project,publicId(input.previewId));
    this.guard(review);
    this.cleanup();requireThat(this.jobs.size<128,'LIMIT_EXCEEDED');
    // BUSY preserves the review. The lease reserves the bounded original
    // subject before any accepted job or consumed preview can lose it.
    const lease=this.options.coordinator.acquire('shared',project,review.epoch,review.subject);
    let operationId:string,job:Job,pending:PhysicalHierarchyResult,unknownJob:PhysicalHierarchyJob,confirmedFallback:PhysicalHierarchyJob;
    try {
      operationId=opaque();
      pending=fixed({operationId,action:'physical-hierarchy-commit',outcome:'pending',code:null,summary:null});
      unknownJob=fixed({operationId,state:'unknown',result:{...pending,outcome:'unknown',code:'RECOVERY_REQUIRED'},errorCode:null});
      confirmedFallback=fixed({operationId,state:'succeeded',result:{...pending,outcome:'confirmed',code:null},errorCode:null});
      job={...review,finished:null,public:fixed({operationId,state:'pending',result:null,errorCode:null})};
      this.jobs.set(operationId,job);this.reviews.delete(review.public.id);
    } catch(error){lease.release('known');throw error;}
    const task=(async()=>{
      let release:'known'|'unknown'='unknown';
      try {
        let native:PhysicalHierarchyWriteResult;
        try {native=await this.options.owner.write(project,review.request,{guard:async()=>{
          await lease.beforeStart();this.guard(review);await this.recheck(review);this.guard(review);
        }});}
        catch {job.public=unknownJob;return;}
        if(native.reply.outcome==='confirmed') {
          // Allocate this fallback before dispatch. Later metadata/refresh
          // failures cannot demote a strict, already decoded confirmation.
          job.public=confirmedFallback;
          if(native.reply.detailsAvailable&&native.reply.details) {
            const d=native.reply.details;
            try {
              const result:PhysicalHierarchyResult={...pending,outcome:'confirmed',code:null,
                summary:{projectId:d.projectId,previousRevision:d.previousRevision,revision:d.revision}};
              job.public=publicResult({operationId,state:'succeeded',result,errorCode:null});
              release='known';
            } catch {/* Keep the known confirmation and conservative barrier. */}
          }
          this.invalidate(project);
          try {await this.options.onConfirmed(project);}catch {/* The native confirmation remains authoritative. */}
        } else {
          const outcome=native.reply.outcome,code=native.preflightCode??nativePhysicalHierarchyCodeToApi(native.reply.code);
          const result:PhysicalHierarchyResult={...pending,outcome,code,summary:null};
          job.public=publicResult({operationId,state:outcome==='refused'?'failed':'unknown',
            result,errorCode:outcome==='refused'?code:null});
          release=outcome==='refused'?'known':'unknown';
        }
      } catch {
        // Preserve an already latched confirmation; otherwise disclose only
        // the preallocated unknown result, never raw owner/metadata errors.
        if(job.public.state==='pending')job.public=unknownJob;
      } finally {
        if(job.public.state==='pending')job.public=unknownJob;
        job.finished=this.clock();lease.release(release);
      }
    })();
    this.tasks.add(task);void task.then(()=>this.tasks.delete(task),()=>this.tasks.delete(task));
    let timer:ReturnType<typeof setTimeout>|undefined;
    await Promise.race([task,new Promise<void>(resolve=>{timer=setTimeout(resolve,this.pendingMs);})]);
    if(timer!==undefined)clearTimeout(timer);
    this.check(session,project,review.grant);return job.public.result??pending;
  }
  lookup(session:PhysicalHierarchySession,id:string):PhysicalHierarchyJob|null {
    publicId(id);const job=this.jobs.get(id);if(!job)return null;
    requireThat(job.session===session,'SCOPE_DENIED');this.check(session,job.project,job.grant);
    return publicResult(job.public);
  }
  invalidate(project?:string):void {
    for(const [id,review] of this.reviews)if(project===undefined||review.project===project)this.reviews.delete(id);
  }
  cleanup():void {
    const now=this.clock();
    for(const [id,review] of this.reviews)if(review.expires<=now||!this.options.alive(review.session))this.reviews.delete(id);
    for(const [id,job] of this.jobs)
      if(job.finished!==null&&(now-job.finished>=finishedTtl||!this.options.alive(job.session)))this.jobs.delete(id);
  }
  isIdle():boolean{return this.tasks.size===0;}
  async waitForIdle():Promise<void>{while(this.tasks.size)await Promise.allSettled([...this.tasks]);}
}
