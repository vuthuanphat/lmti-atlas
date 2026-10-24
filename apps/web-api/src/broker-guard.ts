import { basename, dirname } from 'node:path';
import { ApiError, exact, requireThat, strictJson, trustedPath } from './security.js';
import { ProcessPool } from './process.js';
import { canonicalRecoveryJson, checkedRecoveryEntries, recoveryDigest, type RecoveryEntry } from './recovery-subject.js';

/** Private startup coordination, never an HTTP request or domain-state receipt. */
export interface BrokerGuardConfig {
  readonly python: string;
  readonly helper: string;
  readonly library: string;
  readonly domainId: string;
}
export interface BrokerRecoveryState {
  readonly generation:number;
  readonly domainId:string;
  readonly coverage:'complete'|'missing'|'unverifiable';
  readonly entries:readonly RecoveryEntry[];
}
export function checkedBrokerRecoveryState(value:unknown):BrokerRecoveryState {
  const o=exact(value,['generation','domainId','coverage','entries']);
  requireThat(typeof o.generation==='number'&&Number.isSafeInteger(o.generation)&&o.generation>=1&&
    typeof o.domainId==='string'&&/^[0-9a-f]{64}$/.test(o.domainId)&&typeof o.coverage==='string'&&
    ['complete','missing','unverifiable'].includes(o.coverage),'OWNER_UNAVAILABLE');
  const entries=checkedRecoveryEntries(o.entries);
  requireThat(canonicalRecoveryJson(entries)===canonicalRecoveryJson(o.entries),'OWNER_UNAVAILABLE');
  return Object.freeze({generation:o.generation,domainId:o.domainId,
    coverage:o.coverage as BrokerRecoveryState['coverage'],entries});
}
type Action='claim'|'retain'|'forget_known'|'acknowledge';
interface PrivateReply {
  action:Action;
  outcome:'claimed'|'updated'|'busy'|'unavailable';
  recoveryRequired:boolean;
  state:BrokerRecoveryState|null;
}
function privateReply(value:unknown,action:Action,domainId:string):PrivateReply {
  const o=exact(value,['schema','action','outcome','recoveryRequired','state']);
  requireThat(o.schema==='lmti.web.broker.guard.v2'&&o.action===action&&typeof o.outcome==='string'&&
    ['claimed','updated','busy','unavailable'].includes(o.outcome)&&typeof o.recoveryRequired==='boolean',
    'OWNER_UNAVAILABLE');
  const success=o.outcome==='claimed'||o.outcome==='updated';
  requireThat(success ? o.outcome===(action==='claim'?'claimed':'updated') : o.recoveryRequired&&o.state===null,
    'OWNER_UNAVAILABLE');
  const state=success?checkedBrokerRecoveryState(o.state):null;
  if(state)requireThat(state.domainId===domainId&&
    ((state.entries.length===0&&state.coverage==='complete')||o.recoveryRequired),'OWNER_UNAVAILABLE');
  return {action,outcome:o.outcome as PrivateReply['outcome'],recoveryRequired:o.recoveryRequired,state};
}
export interface BrokerClaim {
  readonly schema: 'lmti.web.broker.guard.v1';
  readonly outcome: 'claimed'|'busy'|'unavailable';
  readonly recoveryRequired: boolean;
}
const unavailable = (): BrokerClaim => Object.freeze({
  schema:'lmti.web.broker.guard.v1',outcome:'unavailable',recoveryRequired:true,
});
export function checkedBrokerClaim(value: unknown): BrokerClaim {
  const o = exact(value,['schema','outcome','recoveryRequired']);
  requireThat(o.schema === 'lmti.web.broker.guard.v1' && typeof o.outcome === 'string' &&
    ['claimed','busy','unavailable'].includes(String(o.outcome)) &&
    typeof o.recoveryRequired === 'boolean' &&
    (o.outcome === 'claimed' || o.recoveryRequired),'OWNER_UNAVAILABLE');
  return Object.freeze({schema:'lmti.web.broker.guard.v1',outcome:o.outcome as BrokerClaim['outcome'],
    recoveryRequired:o.recoveryRequired});
}

/**
 * A fixed helper proves that the preceding participating broker and its direct
 * children have exited. A claim never proves a previous write succeeded or failed.
 * The service must also reconcile native state and obtain a fresh explicit review.
 * First enrollment covers participating brokers only; rollout must drain older
 * uncoordinated runtimes or use a fresh controlled data directory.
 */
export class BrokerRestartGuard {
  readonly config: BrokerGuardConfig;
  private stopped = false;
  private admitted = false;
  private pending: Promise<BrokerClaim>|null = null;
  private state:BrokerRecoveryState|null = null;
  private tail:Promise<void> = Promise.resolve();
  constructor(config: BrokerGuardConfig, private readonly pool: ProcessPool = new ProcessPool(1)) {
    const o = exact(config,['python','helper','library','domainId']);
    requireThat([o.python,o.helper,o.library].every(v => typeof v === 'string'));
    requireThat(typeof o.domainId==='string'&&/^[0-9a-f]{64}$/.test(o.domainId));
    this.config = Object.freeze({python:o.python as string,helper:o.helper as string,library:o.library as string,domainId:o.domainId});
  }
  isAdmitted(): boolean { return this.admitted && !this.stopped; }
  recoveryState():BrokerRecoveryState|null { return this.state; }
  stop(): void { this.stopped = true; this.admitted = false; }
  async waitForIdle(): Promise<void> {
    this.stop();
    await this.tail;
    await this.pool.waitForIdle();
  }
  private enqueue<T>(operation:()=>Promise<T>):Promise<T> {
    const task=this.tail.then(operation);
    this.tail=task.then(()=>{},()=>{});
    return task;
  }
  claim(): Promise<BrokerClaim> {
    if (this.stopped) return Promise.resolve(unavailable());
    if (this.pending) return this.pending;
    this.admitted = false;
    const task = this.enqueue(async()=>{
      try {
        const value=await this.execute('claim',{});
        if(this.stopped)return unavailable();
        this.admitted=value.outcome==='claimed';
        if(value.state)this.state=value.state;
        return checkedBrokerClaim({schema:'lmti.web.broker.guard.v1',
          outcome:value.outcome,recoveryRequired:value.recoveryRequired});
      } catch { this.admitted=false;return unavailable(); }
    });
    this.pending = task;
    void task.finally(() => { if (this.pending === task) this.pending = null; });
    return task;
  }
  retain(value:RecoveryEntry):Promise<BrokerRecoveryState> {
    const entry=checkedRecoveryEntries([value])[0]!;
    return this.mutate('retain',entry);
  }
  forgetKnown(value:RecoveryEntry):Promise<BrokerRecoveryState> {
    const entry=checkedRecoveryEntries([value])[0]!;
    return this.mutate('forget_known',entry);
  }
  acknowledge(value:BrokerRecoveryState):Promise<BrokerRecoveryState> {
    const expected=checkedBrokerRecoveryState(value);
    return this.mutate('acknowledge',expected);
  }
  private mutate(action:Exclude<Action,'claim'>,value:RecoveryEntry|BrokerRecoveryState):Promise<BrokerRecoveryState> {
    return this.enqueue(async()=>{
      try {
        requireThat(this.isAdmitted()&&this.state!==null,'RECOVERY_REQUIRED');
        const before=this.state;
        let wanted:readonly RecoveryEntry[],extra:Record<string,unknown>;
        if(action==='acknowledge'){
          const expected=value as BrokerRecoveryState;
          requireThat(before.coverage==='complete'&&before.generation===expected.generation&&
            before.domainId===expected.domainId&&before.coverage===expected.coverage&&
            recoveryDigest(before.entries)===recoveryDigest(expected.entries),
            'RECOVERY_REQUIRED');
          wanted=[];extra={generation:before.generation,entriesDigest:recoveryDigest(before.entries)};
        }else{
          const entry=value as RecoveryEntry,found=before.entries.find(e=>e.id===entry.id);
          requireThat(!found||canonicalRecoveryJson(found)===canonicalRecoveryJson(entry),'RECOVERY_REQUIRED');
          if(action==='retain'){
            requireThat(before.coverage==='complete','RECOVERY_REQUIRED');
            wanted=checkedRecoveryEntries(found?before.entries:[...before.entries,entry]);
          }else{
            requireThat(found!==undefined,'RECOVERY_REQUIRED');
            wanted=checkedRecoveryEntries(before.entries.filter(e=>e.id!==entry.id));
          }
          extra={generation:before.generation,entry};
        }
        const changed=action!=='retain'||canonicalRecoveryJson(wanted)!==canonicalRecoveryJson(before.entries);
        requireThat(!changed||before.generation<Number.MAX_SAFE_INTEGER,'RECOVERY_REQUIRED');
        const reply=await this.execute(action,extra);
        requireThat(reply.outcome==='updated'&&reply.state!==null,'RECOVERY_REQUIRED');
        const after=reply.state;
        requireThat(after.generation===before.generation+(changed?1:0)&&after.coverage===before.coverage&&
          canonicalRecoveryJson(after.entries)===canonicalRecoveryJson(wanted)&&
          (action!=='acknowledge'||reply.recoveryRequired===false),'RECOVERY_REQUIRED');
        this.state=after;
        requireThat(!this.stopped,'RECOVERY_REQUIRED');
        return after;
      }catch{this.admitted=false;throw new ApiError('RECOVERY_REQUIRED');}
    });
  }
  private async execute(action:Action,extra:Record<string,unknown>):Promise<PrivateReply> {
      requireThat(process.platform === 'win32','NOT_SUPPORTED');
      requireThat(!this.stopped,'RECOVERY_REQUIRED');
      requireThat(basename(this.config.helper) === 'web-broker-guard.py','OWNER_UNAVAILABLE');
      for (const p of [this.config.python,this.config.helper]) await trustedPath(p,'file');
      await trustedPath(this.config.library,'file',true);
      const stateRoot = dirname(this.config.library);
      await trustedPath(stateRoot,'directory');
      const input = JSON.stringify({schema:'lmti.web.broker.guard.request.v2',action,
        stateRoot,brokerPid:process.pid,domainId:this.config.domainId,...extra});
      requireThat(Buffer.byteLength(input) <= 64*1024,'LIMIT_EXCEEDED');
      // Even coordination writes retain their process slot until close. Lost ACK
      // never permits native dispatch and cannot drop the coordinator's subject.
      const result = await this.pool.runWrite(this.config.python,['-I','-B',this.config.helper],input,
        {cap:256*1024,guard:() => requireThat(!this.stopped,'SESSION_EXPIRED')});
      requireThat(result.kind==='closed'&&result.exitCode===0&&result.transportOk&&result.bytes!==null&&
        result.bytes.length>0&&result.bytes[result.bytes.length-1]===10,'OWNER_UNAVAILABLE');
      return privateReply(strictJson(result.bytes),action,this.config.domainId);
  }
}
