import { ApiError, exact, hash, requireThat, strictJson, type Code } from './security.js';
import { checkedNativeOperationLibrary, type LibraryIdentity } from './project-operation-identity.js';
import type { FormatPreview, NativeOperationCode } from './project-operations-owner.js';

// Private native evidence, never browser path authority or a write acknowledgment.
export interface UpgradeRecoveryArtifact {
  readonly artifactKey:string; readonly operationId:string|null;
  readonly schema:1|2|null; readonly fullSnapshotDigest:string|null;
  readonly state:'verified'|'incomplete'|'invalid'|'foreign'|'unavailable';
  readonly receiptMatch:'none'|'upgrade_v1'|'upgrade_v2'; readonly matchesExpected:boolean;
}
export interface UpgradeRecoveryData {
  readonly condition:'original_state_verified'|'committed_state_verified'|'unresolved';
  readonly code:NativeOperationCode; readonly complete:boolean;
  readonly examinedEntries:number; readonly unresolvedEntries:number;
  readonly current:LibraryIdentity|null; readonly currentSnapshotDigest:string|null;
  readonly parentSnapshotDigest:string|null; readonly committedOperationId:string|null;
  readonly artifacts:readonly UpgradeRecoveryArtifact[];
}
export interface UpgradeRecoveryResult {
  readonly ok:true; readonly schema:'lmti.project.upgrade-recovery.v1';
  readonly action:'library-upgrade-recovery'; readonly data:UpgradeRecoveryData;
}
const outputCap=512*1024;
const libraryCodes=['NONE','INVALID_INPUT','UNSUPPORTED_FORMAT','CONFIG_CHANGED',
  'BUDGET_EXCEEDED','OWNER_UNAVAILABLE','RECOVERY_REQUIRED'] as const;
const need:(value:unknown)=>asserts value=value=>requireThat(value,'INVALID_INPUT');
function one<T extends string|number>(value:unknown,values:readonly T[]):T {
  need(values.includes(value as T));return value as T;
}
function digest(value:unknown):string {
  need(typeof value==='string'&&value.length===64&&/^[0-9a-f]{64}$/.test(value));return value;
}
function uuid(value:unknown):string {
  need(typeof value==='string'&&value.length===36&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)&&
    value!=='00000000-0000-0000-0000-000000000000');return value;
}
function num(value:unknown,max:number):number {
  need(typeof value==='number'&&Number.isSafeInteger(value)&&value>=0&&value<=max);return value;
}
function bool(value:unknown):boolean {need(typeof value==='boolean');return value;}
function nullable<T>(value:unknown,decode:(value:unknown)=>T):T|null {return value===null?null:decode(value);}
function freeze<T>(value:T):T {
  if(value!==null&&typeof value==='object') {
    for(const item of Object.values(value))freeze(item);
    Object.freeze(value);
  }
  return value;
}
function sameLibrary(a:LibraryIdentity,b:LibraryIdentity):boolean {
  return a.schema===b.schema&&a.canonicalPath===b.canonicalPath&&a.uuid===b.uuid&&
    a.generation===b.generation&&a.digest===b.digest;
}
export function checkedUpgradeRecoveryExpected(value:unknown):FormatPreview {
  const o=exact(value,['source','fullSnapshotDigest']),source=checkedNativeOperationLibrary(o.source);
  need(source.schema===1||source.schema===2);
  const fullSnapshotDigest=digest(o.fullSnapshotDigest);
  need(source.schema!==1||fullSnapshotDigest===source.digest);
  // Native UTF-8 must roundtrip even when this function is called with a JS object.
  need(Buffer.from(source.canonicalPath,'utf8').toString('utf8')===source.canonicalPath);
  return freeze({source,fullSnapshotDigest});
}
function artifact(value:unknown,expected:FormatPreview):UpgradeRecoveryArtifact {
  const o=exact(value,['artifactKey','operationId','schema','fullSnapshotDigest','state','receiptMatch','matchesExpected']);
  const result:UpgradeRecoveryArtifact={
    artifactKey:digest(o.artifactKey),operationId:nullable(o.operationId,uuid),
    schema:nullable(o.schema,v=>one(v,[1,2] as const)),fullSnapshotDigest:nullable(o.fullSnapshotDigest,digest),
    state:one(o.state,['verified','incomplete','invalid','foreign','unavailable'] as const),
    receiptMatch:one(o.receiptMatch,['none','upgrade_v1','upgrade_v2'] as const),matchesExpected:bool(o.matchesExpected),
  };
  need((result.schema===null)===(result.fullSnapshotDigest===null));
  if(result.schema!==null)need(result.operationId!==null);
  if(result.matchesExpected)need(result.schema===expected.source.schema&&result.fullSnapshotDigest===expected.fullSnapshotDigest);
  if(result.receiptMatch!=='none')need(result.schema===(result.receiptMatch==='upgrade_v1'?1:2));
  if(result.state==='verified')
    need(result.schema!==null&&(result.matchesExpected||result.receiptMatch!=='none'));
  else need(!result.matchesExpected&&result.receiptMatch==='none');
  if(result.state==='foreign')need(result.schema!==null);
  if(result.state==='incomplete')need(result.operationId!==null&&result.schema===null);
  return result;
}
class NativeRefusal extends Error {constructor(readonly code:Code){super('Native recovery read refused.');}}
function refusal(value:unknown):never {
  const o=exact(value,['ok','code']);need(o.ok===false);
  const code=one(o.code,libraryCodes);need(code!=='NONE');
  const api:Code=code==='BUDGET_EXCEEDED'?'LIMIT_EXCEEDED':code==='UNSUPPORTED_FORMAT'?'NOT_SUPPORTED':code;
  throw new NativeRefusal(api);
}
function result(value:unknown,expected:FormatPreview):UpgradeRecoveryResult {
  if(value&&typeof value==='object'&&!Array.isArray(value)&&(value as {ok?:unknown}).ok===false)refusal(value);
  const envelope=exact(value,['ok','schema','action','data']);
  need(envelope.ok===true&&envelope.schema==='lmti.project.upgrade-recovery.v1'&&envelope.action==='library-upgrade-recovery');
  const o=exact(envelope.data,['condition','code','complete','examinedEntries','unresolvedEntries','current',
    'currentSnapshotDigest','parentSnapshotDigest','committedOperationId','artifacts']);
  need(Array.isArray(o.artifacts)&&o.artifacts.length<=1000);
  const artifacts=o.artifacts.map(v=>artifact(v,expected));
  const data:UpgradeRecoveryData={
    condition:one(o.condition,['original_state_verified','committed_state_verified','unresolved'] as const),
    code:one(o.code,libraryCodes),complete:bool(o.complete),
    examinedEntries:num(o.examinedEntries,1001),unresolvedEntries:num(o.unresolvedEntries,1000),
    current:nullable(o.current,checkedNativeOperationLibrary),
    currentSnapshotDigest:nullable(o.currentSnapshotDigest,digest),parentSnapshotDigest:nullable(o.parentSnapshotDigest,digest),
    committedOperationId:nullable(o.committedOperationId,uuid),artifacts,
  };
  need(artifacts.length<=data.examinedEntries&&data.unresolvedEntries<=artifacts.length);
  const operations=new Set<string>(),receipts=new Set<string>();
  for(let i=0;i<artifacts.length;i++) {
    const row=artifacts[i];
    need(i===0||artifacts[i-1].artifactKey<row.artifactKey);
    if(row.operationId!==null){need(!operations.has(row.operationId));operations.add(row.operationId);}
    if(row.receiptMatch!=='none'){need(!receipts.has(row.receiptMatch));receipts.add(row.receiptMatch);}
    if(row.receiptMatch==='upgrade_v1')need(data.current!==null&&data.current.schema>=2);
    if(row.receiptMatch==='upgrade_v2')need(data.current!==null&&data.current.schema===3);
    if(row.state==='foreign')need(data.current!==null);
  }
  need(data.unresolvedEntries===artifacts.filter(row=>row.state!=='verified').length);
  need((data.current===null)===(data.currentSnapshotDigest===null));
  if(data.current) {
    need(Buffer.from(data.current.canonicalPath,'utf8').toString('utf8')===data.current.canonicalPath);
    need(data.current.canonicalPath===expected.source.canonicalPath);
    if(expected.source.uuid!==null)need(data.current.uuid===expected.source.uuid);
  } else need(data.committedOperationId===null);
  if(data.committedOperationId!==null)
    need(data.current!==null&&(expected.source.schema===1?data.current.schema>=2:data.current.schema===3));
  if(data.complete) {
    need(data.condition!=='unresolved'&&data.code==='NONE'&&data.current!==null&&
      data.currentSnapshotDigest!==null&&data.parentSnapshotDigest!==null&&data.unresolvedEntries===0&&
      data.examinedEntries===artifacts.length&&data.examinedEntries<=1000);
    if(data.condition==='original_state_verified') {
      need(sameLibrary(data.current,expected.source)&&data.committedOperationId===null);
    } else {
      need(expected.source.schema===1?data.current.schema===2||data.current.schema===3:data.current.schema===3);
      if(expected.source.schema===2)
        need(data.current.generation!==null&&expected.source.generation!==null&&data.current.generation>=expected.source.generation);
      need(data.committedOperationId!==null);
      const match=artifacts.find(row=>row.operationId===data.committedOperationId);
      need(match!==undefined&&match.state==='verified'&&match.matchesExpected&&
        match.receiptMatch===(expected.source.schema===1?'upgrade_v1':'upgrade_v2'));
    }
  } else {
    need(data.condition==='unresolved'&&data.code!=='NONE'&&data.parentSnapshotDigest===null);
  }
  const normalized:UpgradeRecoveryResult={ok:true,schema:'lmti.project.upgrade-recovery.v1',
    action:'library-upgrade-recovery',data};
  need(Buffer.byteLength(JSON.stringify(normalized))+1<=outputCap);
  return freeze(normalized);
}
/** ProcessPool has already enforced complete UTF-8/duplicate/framing checks. */
export function checkedUpgradeRecoveryResult(value:unknown,expected:FormatPreview):UpgradeRecoveryResult {
  const e=checkedUpgradeRecoveryExpected(expected);
  try{return result(value,e);}
  catch(error){if(error instanceof NativeRefusal)throw new ApiError(error.code);throw new ApiError('OWNER_UNAVAILABLE');}
}
export function decodeUpgradeRecovery(bytes:Uint8Array,expected:FormatPreview):UpgradeRecoveryResult {
  const e=checkedUpgradeRecoveryExpected(expected);
  try {
    need(bytes.byteLength>0&&bytes.byteLength<=outputCap&&bytes[bytes.byteLength-1]===10);
    return result(strictJson(bytes,false),e);
  } catch(error){if(error instanceof NativeRefusal)throw new ApiError(error.code);throw new ApiError('OWNER_UNAVAILABLE');}
}
// The exact DTO has fixed key order and at most1000 artifacts; generic recovery
// JSON deliberately keeps its independent256-element cap unchanged.
export function upgradeRecoveryEvidence(value:UpgradeRecoveryResult):string {
  return hash(JSON.stringify(value));
}
