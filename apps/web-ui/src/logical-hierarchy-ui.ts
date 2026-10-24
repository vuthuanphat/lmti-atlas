import type {
  LogicalHierarchyStateDto as State, LogicalHierarchyGrantDto as Grant,
  LogicalHierarchyProposalDto as Proposal, LogicalHierarchyDiffDto as Diff,
  LogicalHierarchyPreviewDto as Preview, LogicalHierarchyCommitResultDto as Result,
  LogicalHierarchyJobDto as Job,
} from '../../web-api/src/contracts';

export type {State,Grant,Proposal,Diff,Preview,Result,Job};
export type Change=Proposal['changes'][number];
export type Subsystem=State['subsystems'][number]['value'];
export type Component=State['components'][number]['value'];
export type Membership=State['components'][number]['membership'];
export type Kind=Change['kind'];
export const hierarchyKinds:readonly Kind[]=['add_subsystem','rename_subsystem','reparent_subsystem','set_component_membership','retire_empty_subsystem'];
export const hierarchyCodes=['UNAUTHENTICATED','SESSION_EXPIRED','ORIGIN_REJECTED','SCOPE_DENIED','INVALID_INPUT',
  'REVISION_CONFLICT','PREVIEW_EXPIRED','CONFIG_CHANGED','RECOVERY_REQUIRED','UNMANAGED_COLLISION',
  'OWNED_CONFIG_DRIFT','NOT_SUPPORTED','OWNER_UNAVAILABLE','LIMIT_EXCEEDED','BUSY'] as const;
export class HierarchyUiError extends Error {
  constructor(readonly code:'INVALID_SOURCE_RESPONSE'|'INVALID_INPUT'|'LIMIT_EXCEEDED'|'PREVIEW_EXPIRED'|'BUSY'='INVALID_SOURCE_RESPONSE'){
    super('The hierarchy request or response could not be used.');
  }
}
function check(value:unknown,code:HierarchyUiError['code']='INVALID_SOURCE_RESPONSE'):asserts value {
  if(!value)throw new HierarchyUiError(code);
}
function exact(value:unknown,keys:readonly string[]):Record<string,unknown>{
  check(value!==null&&typeof value==='object'&&!Array.isArray(value));
  check(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);
  const descriptors=Object.getOwnPropertyDescriptors(value);
  check(Object.getOwnPropertySymbols(value).length===0&&Object.keys(descriptors).length===keys.length&&
    keys.every(key=>Object.hasOwn(descriptors,key)&&descriptors[key].enumerable&&Object.hasOwn(descriptors[key],'value')));
  return value as Record<string,unknown>;
}
const bytes=(value:string)=>new TextEncoder().encode(value).length;
function string(value:unknown,cap:number,empty=false):string {
  check(typeof value==='string'&&(empty||value.length>0)&&bytes(value)<=cap&&!/[\u0000-\u001f\u007f]/u.test(value));
  for(let i=0;i<value.length;i++){
    const n=value.charCodeAt(i);
    if(n>=0xd800&&n<=0xdbff){const next=value.charCodeAt(++i);check(next>=0xdc00&&next<=0xdfff);}
    else check(n<0xdc00||n>0xdfff);
  }
  return value;
}
function id(value:unknown,empty=false):string {
  const result=string(value,64,empty);
  check(empty&&result===''||/^[A-Za-z][A-Za-z0-9._-]{0,63}$/u.test(result));return result;
}
function integer(value:unknown,min=1,max=Number.MAX_SAFE_INTEGER-1):number {
  check(typeof value==='number'&&Number.isSafeInteger(value)&&value>=min&&value<=max);return value;
}
function member<T extends string>(value:unknown,values:readonly T[]):T{
  check(typeof value==='string'&&values.includes(value as T));return value as T;
}
const privacy=(v:unknown)=>member(v,['public','internal'] as const);
const nullable=<T>(v:unknown,decode:(v:unknown)=>T):T|null=>v===null?null:decode(v);
function list<T>(value:unknown,cap:number,decode:(value:unknown)=>T):T[]{
  check(Array.isArray(value)&&value.length<=cap);
  check(Object.keys(value).length===value.length);return value.map(decode);
}
function ordered<T>(rows:readonly T[],key:(value:T)=>string):void {
  let previous:string|null=null;
  for(const row of rows){const next=key(row);check(previous===null||previous<next);previous=next;}
}
function same(a:unknown,b:unknown):boolean {
  if(a===b)return true;
  if(a===null||b===null||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return false;
  const aa=a as Record<string,unknown>,bb=b as Record<string,unknown>,keys=Object.keys(aa);
  return keys.length===Object.keys(bb).length&&keys.every(k=>Object.hasOwn(bb,k)&&same(aa[k],bb[k]));
}
function freeze<T>(value:T):T{
  if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;
}
function bounded<T>(value:T):T {
  check(bytes(JSON.stringify({apiVersion:1,requestId:'x'.repeat(43),ok:true,data:value}))<=256*1024,'LIMIT_EXCEEDED');
  return freeze(value);
}
function subsystem(value:unknown):Subsystem {
  const o=exact(value,['id','label','parentSubsystemId','privacy']);
  return {id:id(o.id),label:string(o.label,120),parentSubsystemId:id(o.parentSubsystemId,true),privacy:privacy(o.privacy)};
}
function component(value:unknown):Component {
  const o=exact(value,['id','label','repositoryId','kind','privacy']);
  return {id:id(o.id),label:string(o.label,120),repositoryId:id(o.repositoryId,true),
    kind:member(o.kind,['firmware','gateway','backend','desktop','driver','library'] as const),privacy:privacy(o.privacy)};
}
function membership(value:unknown):NonNullable<Membership> {
  const o=exact(value,['componentId','subsystemId']);return {componentId:id(o.componentId),subsystemId:id(o.subsystemId)};
}
function ancestors(value:unknown,self=''):string[]{
  const result=list(value,31,v=>id(v));check(new Set(result).size===result.length&&!result.includes(self));return result;
}
function allowed(stored:'public'|'internal',effective:'public'|'internal',grant:Grant):void {
  check((grant.allowInternal||effective==='public')&&(stored!=='internal'||effective==='internal'));
}
function opaque(value:unknown):string{
  const result=string(value,43);check(result.length===43&&/^[A-Za-z0-9_-]+$/u.test(result));return result;
}
function time(value:unknown):string{
  const result=string(value,24);check(result.length===24&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(result)&&
    Number.isFinite(Date.parse(result))&&new Date(result).toISOString()===result);return result;
}
export function checkedHierarchyScopes(value:unknown):readonly Grant[]{
  const o=exact(value,['projects']),rows=list(o.projects,500,v=>{
    const row=exact(v,['projectId','allowInternal']);check(typeof row.allowInternal==='boolean');
    return {projectId:id(row.projectId),allowInternal:row.allowInternal};
  });
  check(new Set(rows.map(r=>r.projectId)).size===rows.length);return bounded(rows);
}
export function checkedHierarchyState(value:unknown,grant:Grant):State{
  const o=exact(value,['projectId','revision','subsystems','components']);check(id(o.projectId)===grant.projectId);
  const subsystems=list(o.subsystems,2000,v=>{
    const row=exact(v,['value','ancestors','classification']),item=subsystem(row.value),path=ancestors(row.ancestors,item.id),classification=privacy(row.classification);
    allowed(item.privacy,classification,grant);check((path.at(-1)??'')===item.parentSubsystemId);
    return {value:item,ancestors:path,classification};
  });
  const components=list(o.components,2000,v=>{
    const row=exact(v,['value','membership','ancestors','classification']),item=component(row.value),
      own=nullable(row.membership,membership),path=ancestors(row.ancestors),classification=privacy(row.classification);
    check(own===null||own.componentId===item.id);check((path.at(-1)??'')===(own?.subsystemId??''));
    allowed(item.privacy,classification,grant);return {value:item,membership:own,ancestors:path,classification};
  });
  ordered(subsystems,r=>r.value.id);ordered(components,r=>r.value.id);
  const byId=new Map(subsystems.map(r=>[r.value.id,r]));
  for(const row of [...subsystems,...components])row.ancestors.forEach((key,i)=>{
    const parent=byId.get(key);check(parent&&same(parent.ancestors,row.ancestors.slice(0,i)));
    check(parent.classification!=='internal'||row.classification==='internal');
  });
  return bounded({projectId:grant.projectId,revision:integer(o.revision),subsystems,components});
}
export type DraftInput={kind:Kind;targetId:string;label:string;parentId:string};
export function changeKey(change:Change):string{
  return change.kind==='set_component_membership'?'1:'+change.expectedComponent.id:
    '0:'+(change.kind==='add_subsystem'?change.desired.id:change.expected.id);
}
/** Original expected rows are copied from the retained complete state only. */
export function makeHierarchyChange(state:State,grant:Grant,input:DraftInput):Change{
  try{
    check(state.projectId===grant.projectId);member(input.kind,hierarchyKinds);
    if(input.kind==='add_subsystem'){
      check(grant.allowInternal);const desired=subsystem({id:input.targetId,label:input.label,parentSubsystemId:input.parentId,privacy:'internal'});
      check(!state.subsystems.some(r=>r.value.id===desired.id)&&desired.id!==desired.parentSubsystemId);
      return freeze({kind:input.kind,desired});
    }
    if(input.kind==='set_component_membership'){
      const row=state.components.find(r=>r.value.id===input.targetId);check(row);
      const desiredSubsystemId=input.parentId===''?null:id(input.parentId);
      check((row.membership?.subsystemId??null)!==desiredSubsystemId);
      return freeze({kind:input.kind,expectedComponent:{...row.value},expected:row.membership?{...row.membership}:null,desiredSubsystemId});
    }
    const row=state.subsystems.find(r=>r.value.id===input.targetId);check(row);const expected={...row.value};
    if(input.kind==='rename_subsystem'){
      const desiredLabel=string(input.label,120);check(desiredLabel!==expected.label);
      return freeze({kind:input.kind,expected,desiredLabel});
    }
    if(input.kind==='reparent_subsystem'){
      const desiredParentId=id(input.parentId,true);check(desiredParentId!==expected.id&&desiredParentId!==expected.parentSubsystemId);
      return freeze({kind:input.kind,expected,desiredParentId});
    }
    return freeze({kind:'retire_empty_subsystem',expected});
  }catch{throw new HierarchyUiError('INVALID_INPUT');}
}
/** Replacing a draft entry is explicit; all other duplicate targets are refused. */
export function addHierarchyChange(changes:readonly Change[],change:Change,replace=false):readonly Change[]{
  const at=changes.findIndex(c=>changeKey(c)===changeKey(change));
  check(at<0||replace,'INVALID_INPUT');check(at>=0||changes.length<32,'LIMIT_EXCEEDED');
  return freeze([...changes.filter((_,i)=>i!==at),change].sort((a,b)=>changeKey(a)<changeKey(b)?-1:1));
}
function finalDraft(state:State,changes:readonly Change[]){
  const subsystems=new Map(state.subsystems.map(r=>[r.value.id,{...r.value}]));
  const memberships=new Map(state.components.map(r=>[r.value.id,r.membership?.subsystemId??null]));
  for(const op of changes){
    if(op.kind==='add_subsystem')subsystems.set(op.desired.id,{...op.desired});
    else if(op.kind==='retire_empty_subsystem')subsystems.delete(op.expected.id);
    else if(op.kind==='rename_subsystem')subsystems.set(op.expected.id,{...op.expected,label:op.desiredLabel});
    else if(op.kind==='reparent_subsystem')subsystems.set(op.expected.id,{...op.expected,parentSubsystemId:op.desiredParentId});
    else memberships.set(op.expectedComponent.id,op.desiredSubsystemId);
  }
  const path=(parent:string,self='')=>{
    const seen=new Set(self?[self]:[]),result:string[]=[];
    while(parent){check(!seen.has(parent)&&result.length<31,'INVALID_INPUT');seen.add(parent);
      const row=subsystems.get(parent);check(row,'INVALID_INPUT');result.unshift(parent);parent=row.parentSubsystemId;}
    return result;
  };
  for(const row of subsystems.values())path(row.parentSubsystemId,row.id);
  for(const parent of memberships.values())if(parent)path(parent);
  return {subsystems,memberships,path};
}
export function hierarchyProposal(state:State,grant:Grant,changes:readonly Change[]):Proposal{
  check(state.projectId===grant.projectId&&state.revision<Number.MAX_SAFE_INTEGER-1,'INVALID_INPUT');
  check(changes.length>=1&&changes.length<=32,'INVALID_INPUT');
  check(new Set(changes.map(changeKey)).size===changes.length,'INVALID_INPUT');
  for(const op of changes){
    if(op.kind==='add_subsystem')check(grant.allowInternal&&!state.subsystems.some(r=>r.value.id===op.desired.id),'INVALID_INPUT');
    else if(op.kind==='set_component_membership'){
      const current=state.components.find(r=>r.value.id===op.expectedComponent.id);
      check(current&&same(current.value,op.expectedComponent)&&same(current.membership,op.expected),'INVALID_INPUT');
    }else check(same(state.subsystems.find(r=>r.value.id===op.expected.id)?.value,op.expected),'INVALID_INPUT');
  }
  finalDraft(state,changes);
  const sorted=[...changes].sort((a,b)=>changeKey(a)<changeKey(b)?-1:1);
  // Same conservative field framing used by the native proposal boundary.
  let budget=256+2*bytes(JSON.stringify(state.projectId));
  for(const op of sorted){
    budget+=512;
    const fields=op.kind==='add_subsystem'?Object.values(op.desired):
      op.kind==='set_component_membership'?[...Object.values(op.expectedComponent),...(op.expected?Object.values(op.expected):[]),
        ...(op.desiredSubsystemId===null?[]:[op.desiredSubsystemId])]:
        [...Object.values(op.expected),...(op.kind==='rename_subsystem'?[op.desiredLabel]:op.kind==='reparent_subsystem'?[op.desiredParentId]:[])];
    budget+=fields.reduce((n,v)=>n+bytes(JSON.stringify(v)),0);
  }
  check(budget<=32768,'LIMIT_EXCEEDED');
  return freeze({projectId:state.projectId,expectedRevision:state.revision,changes:sorted});
}
export function checkedHierarchyPreview(value:unknown,state:State,grant:Grant,proposal:Proposal):Preview{
  const o=exact(value,['id','projectId','revision','expiresAt','diff']);
  check(o.projectId===state.projectId&&o.revision===state.revision&&proposal.projectId===state.projectId&&proposal.expectedRevision===state.revision);
  const d=exact(o.diff,['subsystems','memberships','affected']);
  const subsystems=list(d.subsystems,32,v=>{
    const r=exact(v,['id','before','after']),key=id(r.id),before=nullable(r.before,subsystem),after=nullable(r.after,subsystem);
    check(!same(before,after)&&[before,after].every(s=>s===null||s.id===key));return {id:key,before,after};
  });
  const memberships=list(d.memberships,32,v=>{
    const r=exact(v,['componentId','before','after']),key=id(r.componentId),before=nullable(r.before,membership),after=nullable(r.after,membership);
    check(!same(before,after)&&[before,after].every(m=>m===null||m.componentId===key));return {componentId:key,before,after};
  });
  const affected=list(d.affected,4000,v=>{
    const r=exact(v,['kind','id','beforeClassification','afterClassification','beforeAncestors','afterAncestors']),
      kind=member(r.kind,['subsystem','component'] as const),key=id(r.id),beforeClassification=nullable(r.beforeClassification,privacy),
      afterClassification=nullable(r.afterClassification,privacy),beforeAncestors=ancestors(r.beforeAncestors,kind==='subsystem'?key:''),
      afterAncestors=ancestors(r.afterAncestors,kind==='subsystem'?key:'');
    check(beforeClassification!==null||afterClassification!==null);
    check(beforeClassification!==null||beforeAncestors.length===0);check(afterClassification!==null||afterAncestors.length===0);
    check(beforeClassification!=='internal'||afterClassification!=='public');
    check(grant.allowInternal||[beforeClassification,afterClassification].every(p=>p===null||p==='public'));
    return {kind,id:key,beforeClassification,afterClassification,beforeAncestors,afterAncestors};
  });
  ordered(subsystems,r=>r.id);ordered(memberships,r=>r.componentId);
  ordered(affected,r=>(r.kind==='subsystem'?'0:':'1:')+r.id);
  check(subsystems.length+memberships.length>0&&subsystems.length+memberships.length===proposal.changes.length);
  const final=finalDraft(state,proposal.changes),touched=new Set(proposal.changes.filter(c=>c.kind!=='set_component_membership').map(c=>changeKey(c).slice(2)));
  const expectedAffected=new Set(proposal.changes.map(changeKey));
  for(const row of state.subsystems){
    const after=final.subsystems.get(row.value.id),path=after?final.path(after.parentSubsystemId,after.id):[];
    if([...row.ancestors,...path].some(p=>touched.has(p)))expectedAffected.add('0:'+row.value.id);
  }
  for(const row of state.components)if([...row.ancestors,...final.path(final.memberships.get(row.value.id)??'')].some(p=>touched.has(p)))expectedAffected.add('1:'+row.value.id);
  check(affected.length===expectedAffected.size);
  for(const op of proposal.changes){
    if(op.kind==='set_component_membership'){
      const row=memberships.find(r=>r.componentId===op.expectedComponent.id),after=op.desiredSubsystemId===null?null:{componentId:op.expectedComponent.id,subsystemId:op.desiredSubsystemId};
      check(row&&same(row.before,op.expected)&&same(row.after,after));
    }else{
      const key=changeKey(op).slice(2),row=subsystems.find(r=>r.id===key);
      check(row&&same(row.before,op.kind==='add_subsystem'?null:op.expected)&&same(row.after,final.subsystems.get(key)??null));
    }
  }
  for(const row of affected){
    const key=(row.kind==='subsystem'?'0:':'1:')+row.id;check(expectedAffected.has(key));
    const before=row.kind==='subsystem'?state.subsystems.find(r=>r.value.id===row.id):state.components.find(r=>r.value.id===row.id);
    check(same(row.beforeAncestors,before?.ancestors??[])&&row.beforeClassification===(before?.classification??null));
    const next=row.kind==='subsystem'?final.subsystems.get(row.id):state.components.find(r=>r.value.id===row.id)?.value;
    check((row.afterClassification===null)===(next===undefined));
    const path=next?row.kind==='subsystem'?final.path((next as Subsystem).parentSubsystemId,row.id):final.path(final.memberships.get(row.id)??''):[];
    check(same(row.afterAncestors,path));
    if(next&&row.afterClassification)allowed(next.privacy,row.afterClassification,grant);
    for(const parentId of path){
      const parent=affected.find(r=>r.kind==='subsystem'&&r.id===parentId);
      const classification=parent?.afterClassification??state.subsystems.find(r=>r.value.id===parentId)?.classification;
      check(classification!==undefined&&classification!==null);
      check(classification!=='internal'||row.afterClassification==='internal');
    }
  }
  return bounded({id:opaque(o.id),projectId:state.projectId,revision:state.revision,expiresAt:time(o.expiresAt),diff:{subsystems,memberships,affected}});
}
export type WriteStatus={admitted:boolean;recoveryRequired:boolean;projectOperations:boolean;activeWrites:number};
export function checkedHierarchyWriteStatus(value:unknown):WriteStatus{
  const o=exact(value,['admitted','recoveryRequired','projectOperations','activeWrites']);
  check([o.admitted,o.recoveryRequired,o.projectOperations].every(v=>typeof v==='boolean'));
  return {admitted:o.admitted as boolean,recoveryRequired:o.recoveryRequired as boolean,projectOperations:o.projectOperations as boolean,activeWrites:integer(o.activeWrites,0,32)};
}
export function checkedHierarchyResult(value:unknown,project:string,revision:number,operationId?:string):Result{
  const o=exact(value,['operationId','action','outcome','code','summary']),key=opaque(o.operationId);
  check(o.action==='logical-hierarchy-commit'&&(!operationId||key===operationId));
  const outcome=member(o.outcome,['pending','confirmed','refused','unknown'] as const),code=nullable(o.code,v=>member(v,hierarchyCodes));
  check(outcome==='pending'||outcome==='confirmed'?code===null:code!==null);
  const summary=o.summary===null?null:(()=>{
    const s=exact(o.summary,['projectId','previousRevision','revision']);
    check(outcome==='confirmed'&&s.projectId===project&&s.previousRevision===revision&&s.revision===revision+1);
    return {projectId:project,previousRevision:integer(s.previousRevision),revision:integer(s.revision)};
  })();
  check(outcome==='confirmed'||summary===null);
  return bounded({operationId:key,action:'logical-hierarchy-commit',outcome,code,summary});
}
export function checkedHierarchyJob(value:unknown,project:string,revision:number,operationId:string):Job{
  const o=exact(value,['operationId','state','result','errorCode']);check(o.operationId===opaque(operationId));
  const state=member(o.state,['pending','succeeded','failed','unknown'] as const),errorCode=nullable(o.errorCode,v=>member(v,hierarchyCodes));
  if(state==='pending'){check(o.result===null&&errorCode===null);return {operationId,state,result:null,errorCode:null};}
  const result=checkedHierarchyResult(o.result,project,revision,operationId);
  check(result.outcome===(state==='succeeded'?'confirmed':state==='failed'?'refused':'unknown'));
  check(errorCode===(state==='failed'?result.code:null));return bounded({operationId,state,result,errorCode});
}
export function checkedHierarchyRejection(value:unknown):void{check(exact(value,['rejected']).rejected===true);}
export function hierarchyErrorCode(error:unknown):string{
  const code=error&&typeof error==='object'&&'code' in error?error.code:null;
  return typeof code==='string'&&[...hierarchyCodes,'NETWORK','INVALID_SOURCE_RESPONSE'].includes(code)?code:'NETWORK';
}
export function hierarchyShouldPoll(submission:Submission|null,attempts:number,busy:boolean):boolean{
  return submission?.phase==='pending'&&!!submission.result?.operationId&&!busy&&attempts<40;
}
export interface HierarchyReadTicket{readonly generation:number;readonly selection:string}
export class HierarchyReadFence {
  private generation=0;
  invalidate():void{this.generation++;}
  begin(selection:string):HierarchyReadTicket{return {generation:++this.generation,selection};}
  current(ticket:HierarchyReadTicket):boolean{return ticket.generation===this.generation;}
  accepts(ticket:HierarchyReadTicket,selection:string,mounted:boolean):boolean {
    return mounted&&this.current(ticket)&&ticket.selection===selection;
  }
}
export type Submission={project:string;revision:number;phase:'submitting'|'pending'|'confirmed'|'refused'|'unknown';result:Result|null;locked:boolean};
/** Synchronous one-use gate used directly by the component before any await. */
export class HierarchyCommitGate {
  current:Submission|null=null;
  private lastPreview:string|null=null;
  private observedWriteStatus:WriteStatus|null=null;
  begin(preview:Preview,now:number):{previewId:string}{
    check(!this.current?.locked&&this.lastPreview!==preview.id,'BUSY');
    check(Date.parse(preview.expiresAt)>now,'PREVIEW_EXPIRED');this.lastPreview=preview.id;
    this.observedWriteStatus=null;
    this.current={project:preview.projectId,revision:preview.revision,phase:'submitting',result:null,locked:true};
    return {previewId:preview.id};
  }
  observe(result:Result):Submission{
    check(this.current);
    if(this.current.phase==='confirmed')return this.current;
    check(!this.current.result||this.current.result.operationId===result.operationId);
    this.observedWriteStatus=null;
    this.current={...this.current,phase:result.outcome,result,locked:result.outcome==='pending'||result.outcome==='unknown'};
    return this.current;
  }
  uncertain():Submission {
    check(this.current);
    this.observedWriteStatus=null;
    if(this.current.phase!=='confirmed'&&this.current.phase!=='refused')this.current={...this.current,phase:'unknown',locked:true};
    return this.current;
  }
  observeWriteStatus(status:WriteStatus,submission:Submission):void {
    check(this.current===submission&&this.current.phase==='unknown','BUSY');
    this.observedWriteStatus={...status};
  }
  canEndUnknown():boolean {
    return this.current?.phase==='unknown'&&this.current.locked&&!!this.observedWriteStatus?.admitted&&this.observedWriteStatus.activeWrites===0;
  }
  endUnknown():Submission {
    check(this.current&&this.canEndUnknown(),'BUSY');
    this.current={...this.current,locked:false};this.observedWriteStatus=null;return this.current;
  }
}
