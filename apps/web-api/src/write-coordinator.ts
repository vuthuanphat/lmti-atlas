import { lstat, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { ApiError, exact, hash, requireThat } from './security.js';
import { BrokerRestartGuard, checkedBrokerClaim, type BrokerClaim, type BrokerRecoveryState } from './broker-guard.js';
import { canonicalRecoveryJson, checkedRecoveryEntries, checkedRecoverySubject, recoveryDigest,
  type RecoveryEntry, type RecoverySubject } from './recovery-subject.js';

export type WriteMode = 'shared'|'exclusive';
export interface WriteLease {
  /** Await once inside the queued owner guard, before any domain child starts. */
  beforeStart():Promise<void>;
  /** Release only after proven no-start or child close. The first outcome wins. */
  release(outcome:'known'|'unknown'):void;
}
export interface WriteSnapshot {
  readonly epoch:number;
  readonly admitted:boolean;
  readonly stopped:boolean;
  readonly recoveryRequired:boolean;
  readonly activeLeases:number;
}
/** Private object identity; retain server-side, never serialize as an authority. */
export interface RecoveryToken {
  readonly epoch:number;
  readonly expiresAt:number;
  readonly domainId:string;
  readonly generation:number;
  readonly digest:string;
}
type Coverage = 'complete'|'missing'|'unverifiable';
export interface RecoverySnapshot {
  readonly coverage:Coverage;
  readonly generation:number;
  readonly digest:string;
  readonly subjects:readonly RecoveryEntry[];
}
interface ScopeRecord {
  readonly library:string;
  readonly domainId:string;
  epoch:number;
  generation:number;
  coverage:Coverage;
  readonly entries:Map<string,RecoveryEntry>;
}
const registry = new Map<string,WriteCoordinator>();
// The existing tombstone now retains bounded private original-target metadata.
// It never supplies authority to inspect a target or replay a domain write.
const recoveryScopes = new Map<string,ScopeRecord>();
const maxScopes = 32, maxLeases = 32, recoveryTtl = 120000;
const pathKey = (path:string) => process.platform === 'win32' ? path.toLowerCase() : path;
const unavailable = ():BrokerClaim => Object.freeze({
  schema:'lmti.web.broker.guard.v1',outcome:'unavailable',recoveryRequired:true,
});
async function canonicalScope(library:string):Promise<{scope:string;library:string}> {
  requireThat(typeof library === 'string' && isAbsolute(library) && library.length <= 1024 &&
    !/[\x00-\x1f\x7f<>"|?*]/.test(library),'OWNER_UNAVAILABLE');
  const spelling = library.replaceAll('\\','/');
  requireThat(!spelling.startsWith('//') && !spelling.replace(/^[A-Za-z]:/,'').includes(':'),'OWNER_UNAVAILABLE');
  const tail = spelling.slice(parse(library).root.replaceAll('\\','/').length);
  requireThat(tail.length > 0 && tail.split('/').every(part => part.length > 0 && part !== '.' && part !== '..' &&
    !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)),'OWNER_UNAVAILABLE');
  const file = resolve(library), volume = parse(file).root;
  const segments = file.slice(volume.length).split(/[\\/]/);
  let current = volume;
  // Refuse a redirecting parent before examining any child beneath it.
  for (let index = -1; index < segments.length; index++) {
    if (index >= 0) current = join(current,segments[index]);
    const leaf = index === segments.length-1;
    let info;
    try { info = await lstat(current); }
    catch (error) {
      if (leaf && (error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw new ApiError('OWNER_UNAVAILABLE');
    }
    requireThat(!info.isSymbolicLink() && (leaf ? info.isFile() && info.nlink === 1 : info.isDirectory()),'OWNER_UNAVAILABLE');
    requireThat(pathKey(await realpath(current)) === pathKey(current),'OWNER_UNAVAILABLE');
  }
  const parent = await realpath(dirname(file));
  // The Windows helper's fixed marker belongs to the library parent, so distinct
  // library filenames in that same parent deliberately share this exclusion.
  return {scope:pathKey(parent),library:pathKey(file)};
}

/** One service lifetime, independent of HTTP sessions and their job cleanup. */
export class WriteCoordinator {
  private admitted=false;
  private stopped=false;
  private recoveryRequired=false;
  private readonly leases=new Map<symbol,{mode:WriteMode;projectId:string|null}>();
  private readonly projects=new Set<string>();
  private exclusive=false;
  private recoveryToken:RecoveryToken|null=null;
  private guardState:BrokerRecoveryState|null=null;
  private claimTask:Promise<BrokerClaim>|null=null;
  private acknowledgeTask:Promise<void>|null=null;
  private closeTask:Promise<void>|null=null;
  private drainTask:Promise<void>|null=null;
  private resolveDrain:(()=>void)|null=null;
  private constructor(private readonly scope:string,private readonly library:string,
    private readonly domainId:string,private readonly record:ScopeRecord,
    private readonly guard:BrokerRestartGuard|undefined,private readonly clock:()=>number) {}

  static async create(library:string,guard?:BrokerRestartGuard,clock:()=>number=Date.now,
    options?:{domainId:string}):Promise<WriteCoordinator> {
    requireThat(typeof clock==='function');
    if(options!==undefined) {
      exact(options,['domainId']);
      requireThat(typeof options.domainId==='string' && /^[0-9a-f]{64}$/.test(options.domainId));
    }
    let key:{scope:string;library:string};
    try {
      key=await canonicalScope(library);
      if(guard) {
        const other=await canonicalScope(guard.config.library);
        requireThat(other.library===key.library,'OWNER_UNAVAILABLE');
      }
    } catch(error) { throw error instanceof ApiError?error:new ApiError('OWNER_UNAVAILABLE'); }
    const domainId=options?.domainId ?? guard?.config.domainId ??
      hash(canonicalRecoveryJson({version:1,compatibilityLibrary:key.library}));
    requireThat(typeof domainId==='string' && /^[0-9a-f]{64}$/.test(domainId));
    if(guard) requireThat(guard.config.domainId===domainId,'OWNER_UNAVAILABLE');
    const scopes=new Set([...registry.keys(),...recoveryScopes.keys()]);
    requireThat(!registry.has(key.scope) && (scopes.has(key.scope) || scopes.size<maxScopes),'BUSY');
    const retained=recoveryScopes.get(key.scope);
    const record:ScopeRecord=retained ?? {library:key.library,domainId,epoch:1,generation:0,
      coverage:'complete',entries:new Map()};
    const coordinator=new WriteCoordinator(key.scope,key.library,domainId,record,guard,clock);
    if(retained) { coordinator.recoveryRequired=true; coordinator.advance(); }
    registry.set(key.scope,coordinator);
    try {
      if(guard) await coordinator.claim();
      else coordinator.admitted=true; // Same-process compatibility only.
      return coordinator;
    } catch(error) {
      coordinator.stop();
      if(registry.get(key.scope)===coordinator) registry.delete(key.scope);
      throw error;
    }
  }
  private matchesScope():boolean {
    return this.record.domainId===this.domainId && this.record.library===this.library;
  }
  private coverage():Coverage { return this.matchesScope()?this.record.coverage:'unverifiable'; }
  private retainBarrier():void {
    this.recoveryRequired=true;
    recoveryScopes.set(this.scope,this.record);
  }
  private changed():void {
    this.recoveryToken=null;
    if(this.record.generation<Number.MAX_SAFE_INTEGER) this.record.generation++;
    else { this.record.coverage='unverifiable'; this.admitted=false; this.retainBarrier(); }
  }
  private advance():void {
    this.recoveryToken=null;
    if(this.record.epoch<Number.MAX_SAFE_INTEGER) this.record.epoch++;
    else { this.record.coverage='unverifiable'; this.admitted=false; this.retainBarrier(); }
    this.changed();
  }
  private isAdmitted():boolean {
    return this.admitted && !this.stopped && (!this.guard || this.guard.isAdmitted());
  }
  snapshot():WriteSnapshot {
    return Object.freeze({epoch:this.record.epoch,admitted:this.isAdmitted(),stopped:this.stopped,
      recoveryRequired:this.recoveryRequired,activeLeases:this.leases.size});
  }
  recovery():RecoverySnapshot {
    const subjects=checkedRecoveryEntries([...this.record.entries.values()]);
    return Object.freeze({coverage:this.coverage(),generation:this.record.generation,
      digest:recoveryDigest(subjects),subjects});
  }
  private checkedState(value:unknown):BrokerRecoveryState {
    const o=exact(value,['generation','domainId','coverage','entries']);
    requireThat(typeof o.generation==='number' && Number.isSafeInteger(o.generation) && o.generation>=1 &&
      typeof o.domainId==='string' && /^[0-9a-f]{64}$/.test(o.domainId) &&
      ['complete','missing','unverifiable'].includes(o.coverage as string),'RECOVERY_REQUIRED');
    return Object.freeze({generation:o.generation,domainId:o.domainId,
      coverage:o.coverage as Coverage,entries:checkedRecoveryEntries(o.entries)});
  }
  /** Never replace a locally retained entry with a marker's current target. */
  private mergeState(value:unknown):BrokerRecoveryState {
    const state=this.checkedState(value);
    requireThat(state.domainId===this.domainId && this.matchesScope(),'RECOVERY_REQUIRED');
    requireThat(!this.guardState || state.generation>=this.guardState.generation,'RECOVERY_REQUIRED');
    const combined=new Map(this.record.entries);
    for(const entry of state.entries) {
      const old=combined.get(entry.id);
      requireThat(!old || canonicalRecoveryJson(old)===canonicalRecoveryJson(entry),'RECOVERY_REQUIRED');
      combined.set(entry.id,entry);
    }
    const entries=checkedRecoveryEntries([...combined.values()]);
    if(state.coverage!=='complete') this.record.coverage=state.coverage;
    for(const entry of entries) this.record.entries.set(entry.id,entry);
    this.guardState=state;
    this.changed();
    return state;
  }
  /** Explicit retry only; busy/unavailable never starts a claim loop. */
  claim():Promise<BrokerClaim> {
    if(this.stopped) return Promise.resolve(unavailable());
    if(this.claimTask) return this.claimTask;
    requireThat(this.leases.size===0 && this.acknowledgeTask===null,'BUSY');
    if(!this.guard) return Promise.resolve(Object.freeze({
      schema:'lmti.web.broker.guard.v1',outcome:'claimed',recoveryRequired:this.recoveryRequired,
    }));
    this.admitted=false; this.advance();
    const task=this.performClaim();
    this.claimTask=task;
    void task.then(()=>{if(this.claimTask===task)this.claimTask=null;},
      ()=>{if(this.claimTask===task)this.claimTask=null;});
    return task;
  }
  private async performClaim():Promise<BrokerClaim> {
    try {
      const result=checkedBrokerClaim(await this.guard!.claim());
      if(this.stopped) return unavailable();
      this.admitted=result.outcome==='claimed' && this.guard!.isAdmitted();
      if(!this.admitted) return result.outcome==='claimed'?unavailable():result;
      const value=this.guard!.recoveryState();
      if(value===null) {
        this.record.coverage='missing'; this.retainBarrier();
      } else {
        try {
          const state=this.mergeState(value);
          if(result.recoveryRequired || state.entries.length || state.coverage!=='complete') this.retainBarrier();
          // Verified v2 complete+empty is a clean retained set. It still needs
          // an explicit later acknowledgment; v1/null cannot assert this.
        } catch {
          if(this.matchesScope())this.record.coverage='unverifiable';
          this.retainBarrier();
        }
      }
      if(!this.matchesScope()) this.retainBarrier();
      return Object.freeze({...result,recoveryRequired:this.recoveryRequired});
    } catch { this.admitted=false; return unavailable(); }
  }
  assertAllowed(reviewEpoch?:number):void {
    requireThat(!this.stopped,'OWNER_UNAVAILABLE');
    requireThat(this.isAdmitted() && !this.recoveryRequired && this.matchesScope(),'RECOVERY_REQUIRED');
    requireThat(this.acknowledgeTask===null,'BUSY');
    if(reviewEpoch!==undefined)
      requireThat(Number.isSafeInteger(reviewEpoch) && reviewEpoch===this.record.epoch,'CONFIG_CHANGED');
    requireThat(this.record.epoch<=Number.MAX_SAFE_INTEGER-128 &&
      this.record.generation<=Number.MAX_SAFE_INTEGER-128,'LIMIT_EXCEEDED');
  }
  /** Reserve the full original provenance before consuming a preview or job. */
  acquire(mode:WriteMode,projectId:string|null,reviewEpoch:number,subject?:RecoverySubject):WriteLease {
    requireThat(mode==='shared' || mode==='exclusive');
    requireThat(projectId===null || (typeof projectId==='string' && /^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(projectId)));
    requireThat(mode!=='shared' || projectId!==null);
    requireThat(Number.isSafeInteger(reviewEpoch));
    const copied=subject===undefined?undefined:checkedRecoverySubject(subject);
    if(copied) requireThat(copied.projectId===projectId);
    this.assertAllowed(reviewEpoch);
    requireThat(this.leases.size<maxLeases && !this.exclusive &&
      (mode!=='exclusive' || this.leases.size===0) &&
      (projectId===null || !this.projects.has(projectId)),'BUSY');
    const entry=copied?Object.freeze({id:randomUUID(),subject:copied}):undefined;
    if(entry) checkedRecoveryEntries([...this.record.entries.values(),entry]);
    const key=Symbol();
    this.leases.set(key,{mode,projectId});
    if(entry) { this.record.entries.set(entry.id,entry); this.changed(); }
    if(projectId!==null) this.projects.add(projectId);
    if(mode==='exclusive') this.exclusive=true;
    let released=false,publicationAttempted=false,publicationFailed=false;
    let startTask:Promise<void>|null=null;
    const beforeStart=():Promise<void> => {
      if(startTask) return startTask;
      // Allocate the one attempt before invoking a helper. No retry after loss.
      startTask=(async()=>{
        requireThat(!released,'CONFIG_CHANGED');
        this.assertAllowed(reviewEpoch);
        if(this.guard) {
          requireThat(entry,'RECOVERY_REQUIRED');
          publicationAttempted=true;
          try {
            const state=this.mergeState(await this.guard.retain(entry));
            requireThat(state.entries.some(e=>e.id===entry.id &&
              canonicalRecoveryJson(e)===canonicalRecoveryJson(entry)),'RECOVERY_REQUIRED');
          } catch {
            publicationFailed=true; this.retainBarrier(); this.advance();
            throw new ApiError('RECOVERY_REQUIRED');
          }
        }
        // Stop/another unknown may arrive while publication is in flight.
        this.assertAllowed(reviewEpoch);
        requireThat(!released,'CONFIG_CHANGED');
      })();
      // The caller still receives rejection; attach a handler for close-only users.
      void startTask.catch(()=>{});
      return startTask;
    };
    const finish=():void => {
      this.leases.delete(key);
      if(projectId!==null) this.projects.delete(projectId);
      if(mode==='exclusive') this.exclusive=false;
      if(this.leases.size===0) {
        const complete=this.resolveDrain;
        this.resolveDrain=null;this.drainTask=null;complete?.();
      }
    };
    return Object.freeze({beforeStart,release:(outcome:'known'|'unknown')=>{
      requireThat(outcome==='known' || outcome==='unknown');
      if(released)return;
      released=true;
      if(outcome==='unknown') {
        if(!entry)this.record.coverage='missing';
        this.retainBarrier();this.advance();
      }
      // Lifetime includes any publication already in flight, then known cleanup.
      const cleanup=async()=>{
        if(startTask) { try { await startTask; } catch { /* no replay */ } }
        if(outcome==='known' && entry) {
          try {
            if(this.guard && publicationAttempted) {
              const state=this.mergeState(await this.guard.forgetKnown(entry));
              requireThat(!state.entries.some(e=>e.id===entry.id),'RECOVERY_REQUIRED');
            }
            // Failed publication remains conservatively recoverable even if
            // cleanup later succeeds; only an explicit review clears the barrier.
            if(!publicationFailed) { this.record.entries.delete(entry.id);this.changed(); }
          } catch { this.retainBarrier();this.advance(); }
        }
      };
      // Keep the old synchronous no-helper release behavior where possible.
      if(!startTask && (!this.guard || !publicationAttempted)) {
        if(outcome==='known' && entry) { this.record.entries.delete(entry.id);this.changed(); }
        finish();
      } else void cleanup().then(finish,()=>{this.retainBarrier();this.advance();finish();});
    }});
  }
  private requireRecovery():void {
    requireThat(!this.stopped,'OWNER_UNAVAILABLE');
    requireThat(this.isAdmitted(),'RECOVERY_REQUIRED');
    requireThat(this.leases.size===0 && this.claimTask===null && this.acknowledgeTask===null,'BUSY');
    requireThat(this.recoveryRequired,'CONFIG_CHANGED');
    requireThat(this.coverage()==='complete','RECOVERY_REQUIRED');
  }
  beginReconciliation():RecoveryToken {
    this.requireRecovery();
    const now=this.clock(),snapshot=this.recovery();
    requireThat(Number.isSafeInteger(now) && now>=0 && now<=Number.MAX_SAFE_INTEGER-recoveryTtl);
    const token=Object.freeze({epoch:this.record.epoch,expiresAt:now+recoveryTtl,
      domainId:this.domainId,generation:snapshot.generation,digest:snapshot.digest});
    this.recoveryToken=token;
    return token;
  }
  private checkToken(token:RecoveryToken):void {
    requireThat(token!==null && typeof token==='object' && token===this.recoveryToken &&
      token.epoch===this.record.epoch && token.domainId===this.domainId &&
      token.generation===this.record.generation && token.digest===this.recovery().digest,'CONFIG_CHANGED');
    const now=this.clock();
    requireThat(Number.isSafeInteger(now) && now>=0 && now<token.expiresAt,'PREVIEW_EXPIRED');
  }
  /** Persist complete-set acknowledgment before clearing any local provenance. */
  async acknowledge(token:RecoveryToken):Promise<void> {
    this.requireRecovery();this.checkToken(token);
    const task=(async()=>{
      try {
        if(this.guard) {
          requireThat(this.guardState!==null,'RECOVERY_REQUIRED');
          const state=this.checkedState(await this.guard.acknowledge(this.guardState));
          requireThat(state.domainId===this.domainId && state.coverage==='complete' &&
            state.entries.length===0 && state.generation>this.guardState.generation,'RECOVERY_REQUIRED');
          this.guardState=state;
        }
        // A stop while metadata is in flight cannot reopen this coordinator.
        requireThat(!this.stopped,'OWNER_UNAVAILABLE');
        this.checkToken(token);
        this.record.entries.clear();this.record.coverage='complete';
        this.advance();this.recoveryRequired=false;
        recoveryScopes.delete(this.scope);
      } catch(error) {
        this.retainBarrier();this.advance();
        throw error instanceof ApiError?error:new ApiError('RECOVERY_REQUIRED');
      }
    })();
    this.acknowledgeTask=task;
    void task.then(()=>{if(this.acknowledgeTask===task)this.acknowledgeTask=null;},
      ()=>{if(this.acknowledgeTask===task)this.acknowledgeTask=null;});
    return task;
  }
  stop():void {
    if(this.stopped)return;
    this.stopped=true;this.admitted=false;this.advance();
    // Existing writers still need the fixed guard for known-result cleanup.
  }
  async waitForIdle():Promise<void> {
    if(this.leases.size!==0 && !this.drainTask)
      this.drainTask=new Promise<void>(resolve=>{this.resolveDrain=resolve;});
    await Promise.allSettled([this.drainTask,this.claimTask,this.acknowledgeTask]);
  }
  close():Promise<void> {
    if(this.closeTask)return this.closeTask;
    this.stop();
    const task=(async()=>{
      await this.waitForIdle();
      this.guard?.stop();
      await this.guard?.waitForIdle();
      if(registry.get(this.scope)===this)registry.delete(this.scope);
    })();
    this.closeTask=task;
    return task;
  }
}

