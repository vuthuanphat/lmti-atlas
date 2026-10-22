import { hash, exact, requireThat } from './security.js';
import { checkedRecoverySubject, type RecoverySubject } from './recovery-subject.js';
import { capturePhysicalTarget, verifyPhysicalTarget, recoveryValueKey, type RecoveryGuard } from './legacy-recovery-target.js';
import { checkedHierarchyRecoveryPins, checkedLogicalHierarchyOriginalExpected, checkedLogicalHierarchyWriteRequest,
  type LogicalHierarchyOwner, type HierarchyExpected, type LogicalHierarchyOriginalExpected,
  type LogicalHierarchyState } from './logical-hierarchy-owner.js';

type Pins = ReturnType<typeof checkedHierarchyRecoveryPins>;
type Target = {version:1; original:LogicalHierarchyOriginalExpected; pins:Pins};
const same = (a:unknown,b:unknown) => requireThat(recoveryValueKey(a)===recoveryValueKey(b),'CONFIG_CHANGED');

/** Private coordination evidence, never a grant or a replayable hierarchy edit. */
export class LogicalHierarchyRecovery {
  constructor(private readonly owner:Pick<LogicalHierarchyOwner,'config'|'locator'|'originalState'>,
    private readonly grantId:(project:string)=>string) {}

  private authority(project:string) {
    const grant=this.owner.config.projects.find(g=>g.projectId===project);
    requireThat(grant,'SCOPE_DENIED'); return grant;
  }
  private target(value:RecoverySubject):Target {
    const subject=checkedRecoverySubject(value);
    requireThat(subject.kind==='logical_hierarchy'&&subject.action==='logical-hierarchy-commit'&&
      subject.projectId!==null&&subject.grantId===this.grantId(subject.projectId),'SCOPE_DENIED');
    const authority=this.authority(subject.projectId);
    const o=exact(subject.target,['version','original','pins']); requireThat(o.version===1);
    const original=checkedLogicalHierarchyOriginalExpected(o.original,authority);
    const pins=checkedHierarchyRecoveryPins(o.pins);
    requireThat(original.library.physical.path===this.owner.config.library,'SCOPE_DENIED');
    requireThat(pins.projectIdentity.projectId===subject.projectId&&
      pins.projectIdentity.storeUuid===original.project.storeUuid&&
      pins.libraryIdentity.schema===original.library.schema&&
      pins.libraryIdentity.canonicalPath===original.library.canonicalPath&&
      pins.libraryIdentity.uuid===original.library.uuid,'CONFIG_CHANGED');
    return {version:1,original,pins};
  }
  authorize(subject:RecoverySubject):void { this.target(subject); }

  async verifySubject(subject:RecoverySubject,options:{guard?:RecoveryGuard}={}):Promise<void> {
    const target=this.target(subject);
    await options.guard?.();
    await verifyPhysicalTarget(target.original.library.physical);
    await options.guard?.();
    await verifyPhysicalTarget(target.original.project.physical);
    await options.guard?.();
    this.target(subject);
  }

  async conditionalState(subject:RecoverySubject,options:{guard?:RecoveryGuard}={}):Promise<LogicalHierarchyState> {
    const target=this.target(subject);
    await this.verifySubject(subject,options);
    const result=await this.owner.originalState(target.original.projectId,target.original,{guard:async()=>{
      await this.verifySubject(subject,options);
    }});
    // The native conditional read compares raw DB/root before opening the graph.
    // These opaque identity keys are comparisons only, never filesystem inputs.
    requireThat(result.projectIdentity.canonicalPath===target.pins.projectIdentity.canonicalPath&&
      result.projectIdentity.projectId===target.original.projectId&&
      result.projectIdentity.storeUuid===target.original.project.storeUuid&&
      result.libraryIdentity.schema===target.original.library.schema&&
      result.libraryIdentity.uuid===target.original.library.uuid&&
      result.libraryIdentity.canonicalPath===target.original.library.canonicalPath,'CONFIG_CHANGED');
    await this.verifySubject(subject,options);
    return result;
  }

  async captureSubject(project:string,value:HierarchyExpected,options:{guard?:RecoveryGuard}={}):Promise<RecoverySubject> {
    const authority=this.authority(project);
    const expected=checkedLogicalHierarchyWriteRequest({action:'logical-hierarchy-commit',expected:value},authority).expected;
    const reviewed=expected.reviewToken;
    await options.guard?.();
    const locator=await this.owner.locator(project,{verify:true,guard:options.guard});
    await options.guard?.();
    // Reject a changed catalog before using any returned project locator.
    same(locator.libraryIdentity,expected.libraryIdentity);
    requireThat(locator.projectId===project,'OWNER_UNAVAILABLE');
    const libraryPhysical=await capturePhysicalTarget(this.owner.config.library,'file');
    await options.guard?.();
    const projectPhysical=await capturePhysicalTarget(locator.database,'file');
    await options.guard?.();
    const original=checkedLogicalHierarchyOriginalExpected({
      version:1,projectId:project,
      library:{schema:expected.libraryIdentity.schema,canonicalPath:expected.libraryIdentity.canonicalPath,
        uuid:expected.libraryIdentity.uuid,physical:libraryPhysical},
      project:{schema:2,storeUuid:reviewed.storeUuid,physical:projectPhysical},
      linkedRoot:locator.linkedRoot,
    },authority);
    const {schemaVersion,projectId,canonicalPath,storeUuid,revision,contentDigest,registryDigest}=reviewed;
    const pins=checkedHierarchyRecoveryPins({libraryIdentity:expected.libraryIdentity,
      projectIdentity:{schemaVersion,projectId,canonicalPath,storeUuid,revision,contentDigest,registryDigest},
      proposalDigest:reviewed.proposalDigest,diffDigest:reviewed.diffDigest});
    const subject=checkedRecoverySubject({version:1,kind:'logical_hierarchy',action:'logical-hierarchy-commit',
      projectId:project,grantId:this.grantId(project),target:{version:1,original,pins}});
    const current=await this.conditionalState(subject,options);
    same(current.libraryIdentity,pins.libraryIdentity);
    same(current.projectIdentity,pins.projectIdentity);
    return subject;
  }

  async inspect(subject:RecoverySubject,guard?:RecoveryGuard):Promise<{
    digest:string;hierarchySummary:{projectId:string;projectRevision:number}
  }> {
    const current=await this.conditionalState(subject,{guard});
    // Hash the complete strictly decoded projection (up to the owner frame cap),
    // not the smaller public summary. Recovery may observe legitimate N+1 here.
    return {digest:hash(recoveryValueKey(current)),
      hierarchySummary:{projectId:current.projectIdentity.projectId,projectRevision:current.projectIdentity.revision}};
  }
}
