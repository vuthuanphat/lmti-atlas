import { ApiError, exact, hash, requireThat } from './security.js';
import { canonicalRecoveryJson, checkedRecoveryEntries, type RecoveryEntry, type RecoverySubject } from './recovery-subject.js';
import type { RecoveryAffectedScopeDto, RecoveryCoverageDto } from './contracts.js';
import type { WriteCoordinator } from './write-coordinator.js';

export interface RecoveryObservation {
  digest:string;
  hierarchySummary?:{projectId:string;projectRevision:number};
  physicalHierarchySummary?:{projectId:string;projectRevision:number};
  summary?:{projectId:string;projectRevision:number;profileRevision:number;clients:{client:string;state:string}[]};
}

// This opt-in public projection requires one observation per retained subject.
// A project ID is a display grouping key, never proof of the same physical target.
function publicObservation(result:RecoveryObservation, subject:RecoverySubject):RecoveryObservation {
  try {
    const revision=(value:unknown,minimum:number):number=>{
      requireThat(typeof value==='number'&&Number.isSafeInteger(value)&&value>=minimum&&
        value<=Number.MAX_SAFE_INTEGER-(minimum===1?1:0));
      return value;
    };
    if(subject.kind==='legacy') {
      requireThat(result.summary!==undefined&&result.hierarchySummary===undefined&&result.physicalHierarchySummary===undefined);
      const row=exact(result.summary,['projectId','projectRevision','profileRevision','clients']);
      requireThat(row.projectId===subject.projectId&&typeof row.projectId==='string');
      requireThat(Array.isArray(row.clients)&&row.clients.length<=2);
      const seen=new Set<string>(),clients=row.clients.map(value=>{
        const item=exact(value,['client','state']);
        requireThat((item.client==='codex'||item.client==='cursor')&&!seen.has(item.client));
        requireThat(item.state==='not_applied'||item.state==='configured'||item.state==='recovery_required');
        seen.add(item.client);return {client:item.client,state:item.state};
      });
      return {digest:result.digest,summary:{projectId:row.projectId,
        projectRevision:revision(row.projectRevision,1),profileRevision:revision(row.profileRevision,0),clients}};
    }
    if(subject.kind==='logical_hierarchy') {
      requireThat(result.hierarchySummary!==undefined&&result.summary===undefined&&result.physicalHierarchySummary===undefined);
      const row=exact(result.hierarchySummary,['projectId','projectRevision']);
      requireThat(row.projectId===subject.projectId&&typeof row.projectId==='string');
      return {digest:result.digest,hierarchySummary:{projectId:row.projectId,projectRevision:revision(row.projectRevision,1)}};
    }
    if(subject.kind==='physical_hierarchy') {
      requireThat(result.physicalHierarchySummary!==undefined&&result.summary===undefined&&result.hierarchySummary===undefined);
      const row=exact(result.physicalHierarchySummary,['projectId','projectRevision']);
      requireThat(row.projectId===subject.projectId&&typeof row.projectId==='string');
      return {digest:result.digest,physicalHierarchySummary:{projectId:row.projectId,projectRevision:revision(row.projectRevision,1)}};
    }
    requireThat(result.summary===undefined&&result.hierarchySummary===undefined&&result.physicalHierarchySummary===undefined);
    return {digest:result.digest};
  } catch {
    throw new ApiError('OWNER_UNAVAILABLE');
  }
}
function publicCoverage(subjects:readonly RecoveryEntry[], librarySchema:1|2|3|null):RecoveryCoverageDto {
  requireThat(librarySchema===null||librarySchema===1||librarySchema===2||librarySchema===3,'OWNER_UNAVAILABLE');
  const groups=new Map<string,RecoveryAffectedScopeDto>();
  for(const {subject} of subjects) {
    const {kind,action,projectId}=subject,key=JSON.stringify([kind,action,projectId]);
    // checkedRecoveryEntries already enforces the exact kind/action/project-null
    // union, bounded identifiers, and the complete retained-record budget.
    const prior=groups.get(key);
    groups.set(key,{kind,action,projectId,subjects:(prior?.subjects??0)+1} as RecoveryAffectedScopeDto);
  }
  const affectedScopes=[...groups].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([,scope])=>scope);
  requireThat(affectedScopes.reduce((total,scope)=>total+scope.subjects,0)===subjects.length,'OWNER_UNAVAILABLE');
  return {retainedSubjects:subjects.length,affectedScopes,librarySchema};
}

/** Every acknowledgment route consumes the same complete original-target set. */
export async function collectOriginalTargets(
  coordinator:Pick<WriteCoordinator,'recovery'|'snapshot'>,
  options:{
    guard:()=>void;
    authorize:(subject:RecoverySubject)=>void;
    inspect:(subject:RecoverySubject)=>Promise<RecoveryObservation>;
    librarySchema?:()=>Promise<1|2|3>;
    includeCoverage?:boolean;
  }
) {
  options.guard();
  const before=coordinator.recovery(),epoch=coordinator.snapshot().epoch;
  requireThat(before.coverage==='complete','RECOVERY_REQUIRED');
  const subjects=options.includeCoverage?checkedRecoveryEntries(before.subjects):before.subjects;
  // Resolve authority for the whole set before any private target is read.
  for(const entry of subjects)options.authorize(entry.subject);
  const evidence:unknown[]=[],items:NonNullable<RecoveryObservation['summary']>[]=[];
  const hierarchyItems:NonNullable<RecoveryObservation['hierarchySummary']>[]=[];
  const physicalHierarchyItems:NonNullable<RecoveryObservation['physicalHierarchySummary']>[]=[];
  for(const entry of subjects) {
    options.guard();options.authorize(entry.subject);
    const observed=await options.inspect(entry.subject);
    const result=options.includeCoverage?publicObservation(observed,entry.subject):observed;
    requireThat(typeof result.digest==='string'&&/^[a-f0-9]{64}$/.test(result.digest),'OWNER_UNAVAILABLE');
    evidence.push([entry.id,result.digest]);
    if(result.summary)items.push(result.summary);
    if(result.hierarchySummary)hierarchyItems.push(result.hierarchySummary);
    if(result.physicalHierarchySummary)physicalHierarchyItems.push(result.physicalHierarchySummary);
    options.guard();options.authorize(entry.subject);
  }
  const librarySchema=options.librarySchema?await options.librarySchema():null;
  options.guard();
  for(const entry of subjects)options.authorize(entry.subject);
  const after=coordinator.recovery();
  requireThat(coordinator.snapshot().epoch===epoch&&after.coverage==='complete'&&
    after.generation===before.generation&&after.digest===before.digest,'CONFIG_CHANGED');
  // Coverage is derived only from this already digest-bound immutable snapshot
  // and observed library schema. It adds no read, evidence or ACK mechanism.
  return {items,hierarchyItems,physicalHierarchyItems,librarySchema,
    ...(options.includeCoverage?{coverage:publicCoverage(subjects,librarySchema)}:{}),
    digest:hash(canonicalRecoveryJson({
    generation:before.generation,subjects:before.digest,evidence,librarySchema
  }))};
}
