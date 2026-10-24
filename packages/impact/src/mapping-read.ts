import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { types as nodeTypes } from "node:util";
import { validateGrant, grantFingerprint, identifier, timestamp, type Classification, type ImpactGrant, type ImpactImport, type SourceDescriptor } from "./model.js";
import { MappingError, canonicalMappingJson, normalizeMappingSourceImport, normalizeMappingSourceAuthority, mappingSourceFingerprint, mappingNativeFingerprint } from "./mapping.js";
import { captureMappingCurrent } from "./store.js";
import type {
  DeepReadonly, MappingDigest, MappingUuid, MappingRow, MappingEvidenceBinding,
  MappingSourceAuthority, MappingSourceObservation, MappingNativeObservation,
  MappingTarget,
  MappingVersionSnapshot,
} from "./mapping.js";

// A. Public Impact reader and typed trusted observer seams.

export const MAPPING_READ_LIMITS = {
  authorities: 200,
  authoritiesBytes: 131072,
  mappings: 2000,
  targets: 4000,
  evidenceBindings: 40000,
  captureBytes: 4194304,
  resultBytes: 4194304,
  nativeFrameBytes: 4194304, // Includes the complete terminal LF on stdout.
  stderrBytes: 65536,
  nativeMilliseconds: 35000,
  observationMilliseconds: 40000,
  readMilliseconds: 90000,
  sourceFileMilliseconds: 5000, // Cooperative, not forced OS cancellation.
  sourceDocumentBytes: 4194304,
  codeDescriptorBytes: 131072,
  codeInputs: 100,
  codeFileBytes: 262144,
  codeTotalBytes: 1048576,
} as const;

/** Thrown as the existing MappingError class; no new wire-error protocol.
 * INVALID_INPUT is malformed caller/config data. Malformed persisted data is
 * OWNER_UNAVAILABLE. Unknown/out-of-scope/no accepted mapping -> SOURCE_UNAVAILABLE.
 * LMIP/capability drift -> CONFIG_CHANGED; actual source mismatch -> SOURCE_CHANGED.
 * Native missing/hidden/retired -> NATIVE_UNAVAILABLE; UUID/ref/drift -> NATIVE_CHANGED.
 * Authorised native-as-source -> UNSUPPORTED_MAPPING before source/target I/O.
 */
export type MappingReadCode =
  | "INVALID_INPUT" | "UNSUPPORTED_FORMAT" | "UNSUPPORTED_MAPPING"
  | "SCOPE_DENIED" | "BUSY" | "BUDGET_EXCEEDED" | "CONFIG_CHANGED"
  | "SOURCE_UNAVAILABLE" | "SOURCE_CHANGED"
  | "NATIVE_UNAVAILABLE" | "NATIVE_CHANGED" | "OWNER_UNAVAILABLE";

export interface MappingReadQuery {
  readonly sourceId: string; // Existing legacy-compatible identifier, <=100 ASCII.
}
export interface MappingReadOptions {
  readonly signal?: AbortSignal; // Control only; not serialized authority.
}
export interface MappingReadObservationContext {
  readonly signal: AbortSignal;
  readonly timeoutMilliseconds: 40000;
}
export interface MappingSourceReadRequest {
  readonly phase: "current";
  readonly pass: 1 | 2;
  readonly authority: MappingSourceAuthority;
  /** Complete authorized copied source content; never an I/O locator.
   * Mutable content is not part of the immutable launcher capability. */
  readonly acceptedImport: DeepReadonly<ImpactImport>;
  readonly expectedContentFingerprint: MappingDigest;
}
export interface MappingSourceReadResult {
  readonly observation: MappingSourceObservation;
  /** SHA256("lmti.impact.mapping.source-content.v1\n" + canonical normalized import).
   * This is distinct from the source's self-declared revision/digest. */
  readonly contentFingerprint: MappingDigest;
}
export interface MappingNativeReadRequest {
  readonly phase: "current";
  readonly pass: 1 | 2;
  readonly authority: MappingSourceAuthority;
  readonly allowInternal: boolean;
  readonly targets: readonly MappingTarget[]; // Sorted unique active endpoints only.
}
export interface MappingReadObservers {
  /** Both promises settle only after all admitted work has ended. In particular,
   * native timeout/abort requests termination but rejects only after actual close
   * (or proven no-start). Reader outer deadlines may return failure earlier while
   * tracking these still-pending workers, so BUSY cannot hide a live child. */
  readonly source: (
    request: MappingSourceReadRequest, context: MappingReadObservationContext
  ) => Promise<MappingSourceReadResult>;
  readonly native: (
    request: MappingNativeReadRequest, context: MappingReadObservationContext
  ) => Promise<MappingNativeObservation>;
}
export interface MappingReaderConfig {
  readonly storePath: string;
  readonly storeUuid: MappingUuid;
  readonly sourceIdentityDigest: MappingDigest;
  readonly grant: DeepReadonly<ImpactGrant>;
  readonly authorities: readonly MappingSourceAuthority[];
  readonly observers: MappingReadObservers;
  /** Synchronous current-config/capability check; fixed error, no widening.
   * Failure latches this reader revoked, even if later config bytes are restored. */
  readonly authorize: () => void;
  readonly clock: () => string;
}
export type ActiveMappingRow = MappingRow & { readonly state: "active" };
export interface MappingCurrentRow {
  readonly mapping: ActiveMappingRow;
  readonly effectiveClassification: Classification;
}
export interface MappingCurrentSnapshot {
  readonly schema: "lmti.impact.mapping-current.v1";
  readonly storeUuid: MappingUuid;
  readonly graphRevision: number; // Existing LMIP safe integer interval, including 0.
  readonly sourceId: string;
  readonly grantFingerprint: MappingDigest; // Existing grantFingerprint, unchanged.
  readonly authorityFingerprint: MappingDigest;
  readonly accepted: {
    readonly batchId: string;
    readonly mappingVersion: string;
    readonly payloadDigest: MappingDigest;
    readonly reviewedAt: string;
  };
  readonly source: DeepReadonly<SourceDescriptor>;
  readonly sourceObservation: MappingSourceObservation;
  readonly sourceContentFingerprint: MappingDigest;
  readonly nativeObservation: MappingNativeObservation;
  readonly mappings: readonly MappingCurrentRow[];
  readonly evidenceBindings: readonly MappingEvidenceBinding[];
  readonly complete: true;
  readonly checkedAt: string;
  readonly fingerprint: MappingDigest;
}
export interface MappingReader {
  readCurrent(query: MappingReadQuery, options?: MappingReadOptions): Promise<MappingCurrentSnapshot>;
  isIdle(): boolean;
  waitForIdle(): Promise<void>;
}

/** Store-only owned capture, deliberately not exported through index.ts. */
export interface MappingCurrentCapture {
  readonly storeUuid: string;
  readonly graphRevision: number;
  readonly authority: MappingSourceAuthority;
  readonly head: DeepReadonly<SourceDescriptor>;
  readonly accepted: MappingVersionSnapshot;
  readonly reviewedAt: string;
  readonly evidenceFloor: readonly {
    mappingId: string; evidenceId: string; classification: Classification;
  }[];
  readonly token: string;
}
const readCodes = new Set<MappingReadCode>([
  "INVALID_INPUT","UNSUPPORTED_FORMAT","UNSUPPORTED_MAPPING","SCOPE_DENIED","BUSY",
  "BUDGET_EXCEEDED","CONFIG_CHANGED","SOURCE_UNAVAILABLE","SOURCE_CHANGED",
  "NATIVE_UNAVAILABLE","NATIVE_CHANGED","OWNER_UNAVAILABLE",
]);
function fail(code: MappingReadCode): never { throw new MappingError(code); }
function fixed(error: unknown): MappingError {
  if (error instanceof MappingError && readCodes.has(error.code as MappingReadCode)) return error;
  return new MappingError("OWNER_UNAVAILABLE");
}
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || nodeTypes.isProxy(value) ||
      ![Object.prototype,null].includes(Object.getPrototypeOf(value))) fail("INVALID_INPUT");
  const descriptors = Object.getOwnPropertyDescriptors(value), own = Reflect.ownKeys(value);
  if (own.some(k=>typeof k!=="string") || own.length!==keys.length ||
      keys.some(k=>!Object.hasOwn(descriptors,k) || !("value" in descriptors[k]) || !descriptors[k].enumerable)) fail("INVALID_INPUT");
  return value as Record<string,unknown>;
}
function copy<T>(value: T): T { return JSON.parse(canonicalMappingJson(value)) as T; }
function freeze<T>(value: T): T {
  if (value && typeof value==="object") {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
function hex(value: unknown): string {
  if (typeof value!=="string" || value.length!==64 || !/^[0-9a-f]{64}$/u.test(value)) fail("INVALID_INPUT");
  return value;
}
function uuid(value: unknown): string {
  if (typeof value!=="string" || value.length!==36 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value) ||
      value==="00000000-0000-0000-0000-000000000000") fail("INVALID_INPUT");
  return value;
}
function bytes(value: unknown, cap: number): string {
  const encoded=canonicalMappingJson(value);
  if (Buffer.byteLength(encoded)>cap) fail("BUDGET_EXCEEDED");
  return encoded;
}
function hash(domain: string, value: unknown): string {
  return createHash("sha256").update(domain+"\n"+canonicalMappingJson(value),"utf8").digest("hex");
}
function same(a: unknown,b: unknown): boolean { return canonicalMappingJson(a)===canonicalMappingJson(b); }
function maximum(...values: Classification[]): Classification {
  return values.includes("internal")?"internal":"public";
}
const targetKey = (t: MappingTarget): string=>canonicalMappingJson([t.projectId,t.storeUuid,t.kind,t.id]);
const rawOrder=(a:string,b:string):number=>a<b?-1:a>b?1:0;
export function mappingReadAuthorityFingerprint(authority: MappingSourceAuthority): MappingDigest {
  return hash("lmti.impact.mapping.read-authority.v1",normalizeMappingSourceAuthority(authority));
}
export function mappingSourceContentFingerprint(input: unknown): MappingDigest {
  return hash("lmti.impact.mapping.source-content.v1",normalizeMappingSourceImport(input));
}
export function mappingCurrentFingerprint(value: Omit<MappingCurrentSnapshot,"fingerprint">): MappingDigest {
  const raw=copy(value);
  exact(raw,["schema","storeUuid","graphRevision","sourceId","grantFingerprint","authorityFingerprint",
    "accepted","source","sourceObservation","sourceContentFingerprint","nativeObservation","mappings",
    "evidenceBindings","complete","checkedAt"]);
  bytes(raw,MAPPING_READ_LIMITS.resultBytes);
  const {checkedAt,...body}=raw;
  const {checkedAt:sourceAt,...source}=body.sourceObservation;
  const {checkedAt:nativeAt,...native}=body.nativeObservation;
  return hash("lmti.impact.mapping.current.v1",{...body,sourceObservation:source,nativeObservation:native});
}
function checkObservationTime(value: string, now: string): void {
  const elapsed=Date.parse(timestamp(now))-Date.parse(timestamp(value));
  if (elapsed < -60000 || elapsed > 300000) fail("OWNER_UNAVAILABLE");
}
function sourceAge(source: DeepReadonly<SourceDescriptor>, now: string): void {
  const age=Date.parse(timestamp(now))-Date.parse(timestamp(source.capturedAt));
  if (age < -60000 || (source.maxAgeSeconds!==undefined && age>source.maxAgeSeconds*1000)) fail("SOURCE_CHANGED");
}
function checkSource(result: MappingSourceReadResult, captured: MappingCurrentCapture, now: string): MappingSourceReadResult {
  exact(result,["observation","contentFingerprint"]);
  const raw=exact(result.observation,["sourceId","authorityFingerprint","revision","digest","classification","checkedAt","fingerprint"]);
  const {checkedAt,fingerprint,...fields}=raw;
  if (mappingSourceFingerprint(fields as Omit<MappingSourceObservation,"checkedAt"|"fingerprint">)!==hex(fingerprint)) fail("OWNER_UNAVAILABLE");
  checkObservationTime(checkedAt as string,now);
  const expected=captured.accepted.input.source, a=captured.authority;
  if (raw.sourceId!==a.sourceId || raw.authorityFingerprint!==a.sourceAuthorityFingerprint) fail("CONFIG_CHANGED");
  if (raw.revision!==expected.revision || raw.digest!==expected.digest ||
      hex(result.contentFingerprint)!==mappingSourceContentFingerprint(captured.accepted.input) ||
      (expected.privacy==="internal" && raw.classification!=="internal")) fail("SOURCE_CHANGED");
  return result;
}
function checkNative(value: MappingNativeObservation, authority: MappingSourceAuthority, targets: readonly MappingTarget[], now: string): MappingNativeObservation {
  const raw=exact(value,["schema","projectId","storeUuid","revision","authorityFingerprint","checkedAt","fingerprint","targets"]);
  const {checkedAt,fingerprint,...fields}=raw;
  if (mappingNativeFingerprint(fields as Omit<MappingNativeObservation,"checkedAt"|"fingerprint">)!==hex(fingerprint)) fail("OWNER_UNAVAILABLE");
  checkObservationTime(checkedAt as string,now);
  if (value.projectId!==authority.nativeProjectId || value.storeUuid!==authority.nativeStoreUuid ||
      value.authorityFingerprint!==authority.nativeAuthorityFingerprint) fail("NATIVE_CHANGED");
  if (!same(value.targets.map(r=>r.target),targets)) fail("NATIVE_UNAVAILABLE");
  return value;
}

/** Read-only facade. All SQL remains in store.ts; no transaction crosses await. */
export function createImpactMappingReader(value: MappingReaderConfig): MappingReader {
  const raw=exact(value,["storePath","storeUuid","sourceIdentityDigest","grant","authorities","observers","authorize","clock"]);
  const observers=exact(raw.observers,["source","native"]);
  if (typeof observers.source!=="function" || typeof observers.native!=="function" ||
      typeof raw.authorize!=="function" || typeof raw.clock!=="function") fail("INVALID_INPUT");
  if (typeof raw.storePath!=="string" || !raw.storePath.trim() || Buffer.byteLength(raw.storePath)>32768 ||
      /[\u0000-\u001f\u007f]/u.test(raw.storePath)) fail("INVALID_INPUT");
  const storePath=copy(raw.storePath), storeUuid=uuid(raw.storeUuid), sourceIdentityDigest=hex(raw.sourceIdentityDigest);
  let grant: ImpactGrant;
  try { grant=freeze(validateGrant(copy(value.grant))); } catch { return fail("INVALID_INPUT"); }
  const list=copy(value.authorities);
  if (!Array.isArray(list) || list.length>MAPPING_READ_LIMITS.authorities) fail("BUDGET_EXCEEDED");
  const authorities=list.map(normalizeMappingSourceAuthority);
  if (new Set(authorities.map(a=>a.sourceId)).size!==authorities.length) fail("INVALID_INPUT");
  bytes(authorities,MAPPING_READ_LIMITS.authoritiesBytes);
  const configured=new Map(authorities.map(a=>[a.sourceId,freeze(a)]));
  const observeSource=value.observers.source,observeNative=value.observers.native;
  const authorizeFixed=value.authorize,clockFixed=value.clock;
  const grantHash=grantFingerprint(grant);
  let revoked: MappingError|null=null, active=false,pending=0;
  const idleWaiters=new Set<()=>void>();
  const isIdle=()=>!active&&pending===0;
  function notifyIdle():void {
    if(isIdle()) {for(const done of idleWaiters)done();idleWaiters.clear();}
  }
  function authorize():void {
    if(revoked)throw revoked;
    try{if(authorizeFixed()!==undefined)fail("CONFIG_CHANGED");}
    catch(error){revoked=new MappingError(error instanceof MappingError && error.code==="SCOPE_DENIED"?"SCOPE_DENIED":"CONFIG_CHANGED");throw revoked;}
  }
  const now=()=>timestamp(clockFixed());
  function authority(sourceId:string):MappingSourceAuthority {
    const a=configured.get(sourceId);
    if(!a || grant.projectId!==a.projectId || !grant.siteIds.includes(a.siteId) ||
        !grant.environmentIds.includes(a.environmentId) || (!grant.allowInternal&&a.minimumClassification==="internal")) fail("SOURCE_UNAVAILABLE");
    if(a.kind==="native")fail("UNSUPPORTED_MAPPING");
    return a;
  }
  function capture(a:MappingSourceAuthority):MappingCurrentCapture {
    authorize();
    const result=captureMappingCurrent({storePath,storeUuid,sourceIdentityDigest,grant,authority:a,authorize});
    sourceAge(result.accepted.input.source,now());sourceAge(result.head,now());
    return result;
  }
  function track<T>(work:()=>Promise<T>):Promise<T> {
    pending++;
    return Promise.resolve().then(()=>{authorize();return work();})
      .then(result=>{authorize();return freeze(copy(result));})
      .finally(()=>{pending--;notifyIdle();});
  }
  function bounded<T>(worker:Promise<T>,signal:AbortSignal,limit:number):Promise<T> {
    return new Promise<T>((resolve,reject)=>{
      let finished=false;
      const finish=(callback:()=>void)=>{
        if(finished)return;finished=true;clearTimeout(timer);signal.removeEventListener("abort",aborted);callback();
      };
      const aborted=()=>finish(()=>reject(new MappingError("OWNER_UNAVAILABLE")));
      const timer=setTimeout(aborted,Math.max(0,limit));
      signal.addEventListener("abort",aborted,{once:true});
      worker.then(v=>finish(()=>resolve(v)),e=>finish(()=>reject(e)));
      if(signal.aborted)aborted();
    });
  }
  return {
    isIdle,
    waitForIdle:()=>isIdle()?Promise.resolve():new Promise<void>(resolve=>idleWaiters.add(resolve)),
    async readCurrent(query,options={}) {
      if(!isIdle())fail("BUSY");
      active=true;
      const controller=new AbortController(),started=performance.now();
      let external:AbortSignal|undefined;
      const abort=()=>controller.abort();
      try{
        let sourceId:string;
        try { sourceId=identifier(exact(query,["sourceId"]).sourceId); }
        catch { return fail("INVALID_INPUT"); }
        if (!options || typeof options!=="object" || nodeTypes.isProxy(options)) fail("INVALID_INPUT");
        const opts=Reflect.ownKeys(options);
        if(opts.some(k=>k!=="signal"))fail("INVALID_INPUT");
        const checkedOptions=exact(options,opts as string[]);
        const candidate=checkedOptions.signal;
        if(candidate!==undefined && !(candidate instanceof AbortSignal))fail("INVALID_INPUT");
        external=candidate as AbortSignal|undefined;
        external?.addEventListener("abort",abort,{once:true});
        if(external?.aborted)controller.abort();
        if(controller.signal.aborted)fail("OWNER_UNAVAILABLE");
        authorize();const a=authority(sourceId),first=capture(a);
        const activeRows=first.accepted.mappings.filter(r=>r.state==="active");
        const targetMap=new Map(activeRows.map(r=>[targetKey(r.target),r.target]));
        const targets=freeze([...targetMap].sort(([a],[b])=>rawOrder(a,b)).map(([,v])=>v));
        const expectedContentFingerprint=mappingSourceContentFingerprint(first.accepted.input);
        async function observe(pass:1|2) {
          if(controller.signal.aborted)fail("OWNER_UNAVAILABLE");
          authorize();
          const context:MappingReadObservationContext={signal:controller.signal,timeoutMilliseconds:40000};
          const sourceRequest=freeze(copy({phase:"current" as const,pass,authority:a,acceptedImport:first.accepted.input,expectedContentFingerprint}));
          const nativeRequest=freeze(copy({phase:"current" as const,pass,authority:a,allowInternal:grant.allowInternal,targets}));
          const source=track(()=>observeSource(sourceRequest,context)),native=track(()=>observeNative(nativeRequest,context));
          const remaining=MAPPING_READ_LIMITS.readMilliseconds-(performance.now()-started);
          const result=await bounded(Promise.all([source,native]),controller.signal,Math.min(remaining,40000));
          authorize();
          return {source:checkSource(result[0],first,now()),native:checkNative(result[1],a,targets,now())};
        }
        const left=await observe(1);
        if(capture(a).token!==first.token)fail("CONFIG_CHANGED");
        const right=await observe(2);
        if(left.source.observation.fingerprint!==right.source.observation.fingerprint ||
            left.source.contentFingerprint!==right.source.contentFingerprint)fail("SOURCE_CHANGED");
        if(left.native.fingerprint!==right.native.fingerprint || left.native.revision!==right.native.revision)fail("NATIVE_CHANGED");
        if(capture(a).token!==first.token)fail("CONFIG_CHANGED");
        const observed=new Map(right.native.targets.map(r=>[targetKey(r.target),r]));
        const entities=new Map(first.accepted.input.entities.map(e=>[e.id,e.privacy]));
        const evidence=new Map(first.evidenceFloor.map(e=>[canonicalMappingJson([e.mappingId,e.evidenceId]),e.classification]));
        const mappings:MappingCurrentRow[]=activeRows.map(row=>{
          const current=observed.get(targetKey(row.target));
          if(!current) return fail("NATIVE_UNAVAILABLE");
          if((row.kind==="code"||row.kind==="document")&&row.referenceFingerprint!==current.referenceFingerprint)fail("NATIVE_CHANGED");
          const floor=maximum(row.classification,first.accepted.input.source.privacy,first.head.privacy,a.minimumClassification,
            right.source.observation.classification,current.effectiveClassification,
            ...(row.impactEntityId===null?[]:[entities.get(row.impactEntityId)??fail("OWNER_UNAVAILABLE")]),
            ...row.evidenceIds.map(id=>evidence.get(canonicalMappingJson([row.mappingId,id]))??fail("OWNER_UNAVAILABLE")));
          if(!grant.allowInternal&&floor==="internal")fail("NATIVE_UNAVAILABLE");
          return {mapping:row as ActiveMappingRow,effectiveClassification:floor};
        });
        const activeIds=new Set(activeRows.map(r=>r.mappingId)),checkedAt=now();
        checkObservationTime(right.source.observation.checkedAt,checkedAt);checkObservationTime(right.native.checkedAt,checkedAt);
        sourceAge(first.accepted.input.source,checkedAt);sourceAge(first.head,checkedAt);
        const body:Omit<MappingCurrentSnapshot,"fingerprint">={
          schema:"lmti.impact.mapping-current.v1",storeUuid:first.storeUuid,graphRevision:first.graphRevision,
          sourceId,grantFingerprint:grantHash,authorityFingerprint:mappingReadAuthorityFingerprint(a),
          accepted:{batchId:first.accepted.batchId,mappingVersion:first.accepted.mappingVersion,payloadDigest:first.accepted.payloadDigest,reviewedAt:first.reviewedAt},
          source:first.accepted.input.source,sourceObservation:right.source.observation,sourceContentFingerprint:right.source.contentFingerprint,
          nativeObservation:right.native,mappings,evidenceBindings:first.accepted.evidenceBindings.filter(e=>activeIds.has(e.mappingId)),complete:true,checkedAt,
        };
        const result=freeze({...body,fingerprint:mappingCurrentFingerprint(body)});
        bytes(result,MAPPING_READ_LIMITS.resultBytes);
        if(controller.signal.aborted || performance.now()-started>MAPPING_READ_LIMITS.readMilliseconds)fail("OWNER_UNAVAILABLE");
        authorize();return result;
      }catch(error){throw fixed(error);}
      finally{controller.abort();external?.removeEventListener("abort",abort);active=false;notifyIdle();}
    },
  };
}
