import { exact, hash, requireThat } from './security.js';
import { checkedRecoverySubject, canonicalRecoveryJson, type RecoverySubject } from './recovery-subject.js';
import { capturePhysicalTarget, checkedPhysicalTarget, verifyPhysicalTarget, type PhysicalTarget } from './legacy-recovery-target.js';
import { checkedUpgradeRecoveryResult, upgradeRecoveryEvidence } from './upgrade-recovery-owner.js';
import { checkedProjectOperationWriteRequest, checkedProjectOperationReceipt,
  type ActivationReceipt, type LibraryIdentity, type ProjectOperationOwner,
  type ProjectOperationWriteRequest, type ProjectOperationReadRequest,
  type ProjectOperationReadResult } from './project-operations-owner.js';

type Action = ProjectOperationWriteRequest['action'];
type Target = {
  version:1; library:LibraryIdentity; libraryFile:PhysicalTarget;
  copyParent:PhysicalTarget|null; backupParent:PhysicalTarget|null;
  pins:ProjectOperationWriteRequest['expected']|ActivationReceipt;
};
type Read<A extends ProjectOperationReadRequest['action']> = Extract<ProjectOperationReadResult,{action:A}>;
const same=(a:unknown,b:unknown)=>requireThat(canonicalRecoveryJson(a)===canonicalRecoveryJson(b),'CONFIG_CHANGED');

/** Original owner locations and immutable native lineage, never browser input. */
export class ProjectOperationRecovery {
  constructor(private readonly owner:Pick<ProjectOperationOwner,'config'|'read'|'upgradeRecovery'>,private readonly grant:()=>string) {}

  private target(subject:RecoverySubject):Target {
    requireThat(subject.kind==='project_operations'&&subject.grantId===this.grant(),'SCOPE_DENIED');
    const o=exact(subject.target,['version','library','libraryFile','copyParent','backupParent','pins']);
    requireThat(o.version===1);
    const action=subject.action as Action;
    let request:ProjectOperationWriteRequest,receipt:ActivationReceipt|null=null;
    if(action==='activation-activate'||action==='activation-abandon') {
      receipt=checkedProjectOperationReceipt(o.pins);
      requireThat(receipt.state==='prepared'&&receipt.prepared.projectId===subject.projectId);
      request=checkedProjectOperationWriteRequest({action,projectId:subject.projectId,expected:receipt.token});
    } else {
      request=checkedProjectOperationWriteRequest(action==='copy-prepare'?
        {action,projectId:subject.projectId,expected:o.pins}:{action,expected:o.pins});
    }
    const library=request.action==='copy-prepare'?request.expected.libraryIdentity:
      request.action==='library-upgrade-v1'?request.expected:
      request.action==='library-upgrade-v2'?request.expected.source:
      request.action==='activation-prepare'?request.expected.library:receipt!.prepared.library;
    same(o.library,library);
    const libraryFile=checkedPhysicalTarget(o.libraryFile);
    requireThat(libraryFile.path===this.owner.config.library&&libraryFile.kind==='file','SCOPE_DENIED');
    const copyParent=o.copyParent===null?null:checkedPhysicalTarget(o.copyParent);
    const backupParent=o.backupParent===null?null:checkedPhysicalTarget(o.backupParent);
    const needsCopy=action==='copy-prepare',needsBackup=action.startsWith('library-upgrade-');
    requireThat(needsCopy===(copyParent!==null)&&needsBackup===(backupParent!==null));
    if(copyParent)requireThat(copyParent.path===this.owner.config.copyParent&&copyParent.kind==='directory','SCOPE_DENIED');
    if(backupParent)requireThat(backupParent.path===this.owner.config.backupParent&&backupParent.kind==='directory','SCOPE_DENIED');
    requireThat((subject.projectId===null)===needsBackup);
    if(request.action==='activation-prepare')requireThat(request.expected.projectId===subject.projectId);
    return {version:1,library,libraryFile,copyParent,backupParent,pins:receipt??request.expected};
  }

  async capture(request:ProjectOperationWriteRequest,receipt:ActivationReceipt|null):Promise<RecoverySubject> {
    const r=checkedProjectOperationWriteRequest(request);
    const decision=r.action==='activation-activate'||r.action==='activation-abandon';
    if(decision) {
      requireThat(receipt!==null);
      same(checkedProjectOperationReceipt(receipt).token,r.expected);
    }
    const library=r.action==='copy-prepare'?r.expected.libraryIdentity:
      r.action==='library-upgrade-v1'?r.expected:r.action==='library-upgrade-v2'?r.expected.source:
      r.action==='activation-prepare'?r.expected.library:receipt!.prepared.library;
    const target:Target={version:1,library,
      libraryFile:await capturePhysicalTarget(this.owner.config.library,'file'),
      copyParent:r.action==='copy-prepare'?
        await capturePhysicalTarget(this.owner.config.copyParent,'directory'):null,
      backupParent:r.action.startsWith('library-upgrade-')?
        await capturePhysicalTarget(this.owner.config.backupParent,'directory'):null,
      pins:decision?receipt!:r.expected};
    const projectId=r.action==='copy-prepare'||decision?r.projectId:
      r.action==='activation-prepare'?r.expected.projectId:null;
    const subject=checkedRecoverySubject({version:1,kind:'project_operations',action:r.action,
      projectId,grantId:this.grant(),target});
    this.target(subject);
    await this.verify(subject);
    return subject;
  }

  async verify(subject:RecoverySubject):Promise<void> {
    const target=this.target(subject);
    await verifyPhysicalTarget(target.libraryFile);
    if(target.copyParent)await verifyPhysicalTarget(target.copyParent);
    if(target.backupParent)await verifyPhysicalTarget(target.backupParent);
  }

  async inspect(subject:RecoverySubject,guard:()=>void,authorize:(project:string)=>void):
    Promise<{digest:string;librarySchema:1|2|3}> {
    const t=this.target(subject);
    guard();await this.verify(subject);
    if(subject.action==='library-upgrade-v1'||subject.action==='library-upgrade-v2') {
      // The fixed native recovery read owns the complete original backup parent.
      // A generic current-library status cannot substitute for that observation.
      const request=checkedProjectOperationWriteRequest({action:subject.action,expected:t.pins});
      requireThat(request.action==='library-upgrade-v1'||request.action==='library-upgrade-v2');
      const expected=request.action==='library-upgrade-v1'?
        {source:request.expected,fullSnapshotDigest:request.expected.digest}:request.expected;
      requireThat(typeof this.owner.upgradeRecovery==='function','RECOVERY_REQUIRED');
      const value=checkedUpgradeRecoveryResult(await this.owner.upgradeRecovery(expected,{guard:async()=>{
        guard();await this.verify(subject);guard();
      }}),expected);
      guard();await this.verify(subject);guard();
      const observed=value.data;
      requireThat(observed.complete&&observed.code==='NONE'&&observed.condition!=='unresolved'&&
        observed.current!==null,'RECOVERY_REQUIRED');
      // Fresh evidence only: caller still collects the full union twice and
      // explicitly acknowledges. No operation-ID selection, retry, or relabel.
      return {digest:upgradeRecoveryEvidence(value),librarySchema:observed.current.schema};
    }
    const evidence:string[]=[];
    let bytes=0,observations=0;
    const read=async <A extends ProjectOperationReadRequest['action']>(
      request:Extract<ProjectOperationReadRequest,{action:A}>):Promise<Read<A>>=>{
      guard();requireThat(++observations<=64,'LIMIT_EXCEEDED');
      const result=await this.owner.read(request,{verify:true,guard});
      guard();requireThat(result.action===request.action,'OWNER_UNAVAILABLE');
      const serialized=canonicalRecoveryJson(result);bytes+=Buffer.byteLength(serialized);
      requireThat(bytes<=2*1024*1024,'LIMIT_EXCEEDED');
      evidence.push(hash(serialized));return result as Read<A>;
    };
    const status=await read({action:'library-format-status'}),current=status.libraryIdentity;
    requireThat(current.canonicalPath===t.library.canonicalPath,'CONFIG_CHANGED');
    if(t.library.uuid!==null)requireThat(current.uuid===t.library.uuid,'CONFIG_CHANGED');
    // Schema1 has no UUID. Its original physical owner is checked on both sides.
    requireThat(current.schema===t.library.schema,'CONFIG_CHANGED');
    if(subject.action==='copy-prepare') {
      // Review the entire fixed parent. Never select an equivalent candidate
      // as the lost write's operation ID or promote the historical outcome.
      let offset=0,snapshot:string|null=null;
      for(let page=0;page<21;page++) {
        const value:Read<'copy-discover'>=await read({action:'copy-discover',offset,limit:50,snapshot});
        requireThat(value.complete&&value.code==='NONE'&&value.unattributedEntries===0,'RECOVERY_REQUIRED');
        for(const item of value.items) {
          requireThat(item.intent!==null&&item.state==='uninspected','RECOVERY_REQUIRED');
          authorize(item.intent.source.projectId);
          const inspected=await read({action:'copy-inspect',operationId:item.operationId});
          requireThat(inspected.status.state==='prepared'&&inspected.status.verifiedReceipt,'RECOVERY_REQUIRED');
          same(inspected.status.source,item.intent.source);same(inspected.status.target,item.intent.target);
        }
        if(value.nextOffset===null)break;
        requireThat(page<20&&value.nextOffset>offset,'LIMIT_EXCEEDED');
        offset=value.nextOffset;snapshot=value.snapshot;
      }
    } else if(subject.action==='activation-prepare') {
      const pin=t.pins as Extract<ProjectOperationWriteRequest,{action:'activation-prepare'}>['expected'];
      let offset=0,snapshot:string|null=null;
      for(let page=0;page<21;page++) {
        const value:Read<'activation-history'>=await read({action:'activation-history',projectId:subject.projectId!,offset,limit:50,snapshot});
        same(value.libraryIdentity,current);
        for(const item of value.items)if(item.copyOperationId===pin.copyOperationId) {
          const inspected=await read({action:'activation-inspect',libraryUuid:current.uuid!,operationId:item.operationId});
          same(inspected.libraryIdentity,current);
          same(inspected.receipt.prepared,pin);
          requireThat(inspected.condition!=='inconsistent','RECOVERY_REQUIRED');
        }
        if(value.nextOffset===null)break;
        requireThat(page<20&&value.nextOffset>offset,'LIMIT_EXCEEDED');
        offset=value.nextOffset;snapshot=value.snapshot;
      }
    } else if(subject.action==='activation-activate'||subject.action==='activation-abandon') {
      const original=t.pins as ActivationReceipt;
      const inspected=await read({action:'activation-inspect',libraryUuid:original.token.libraryUuid,
        operationId:original.token.operationId});
      same(inspected.libraryIdentity,current);same(inspected.receipt.prepared,original.prepared);
      same(inspected.receipt.sourceFolder,original.sourceFolder);same(inspected.receipt.sourceFolderKey,original.sourceFolderKey);
      requireThat(inspected.condition!=='inconsistent','RECOVERY_REQUIRED');
      // Terminal history intentionally does not require source/target/copy-parent.
    }
    await this.verify(subject);guard();
    return {digest:hash(canonicalRecoveryJson(evidence)),librarySchema:current.schema};
  }
}
