import { validateGrant, identifier, timestamp, ImpactError } from "./model.js";
import {
  MappingError, canonicalMappingJson, type MappingCode, type MappingOperator,
  type MappingOperatorConfig, type MappingSourceAuthority, type MappingObservations,
} from "./mapping.js";
import { createMappingStoreOperator } from "./store.js";
import { runEgressSecretScan } from "@atlas/privacy";

const codes = new Set<MappingCode>([
  "INVALID_INPUT","UNSUPPORTED_FORMAT","UNSUPPORTED_MAPPING","SCOPE_DENIED","BUSY",
  "BUDGET_EXCEEDED","CONFIG_CHANGED","REVISION_CONFLICT","VERSION_CONFLICT","IDENTITY_CONFLICT",
  "SOURCE_UNAVAILABLE","SOURCE_CHANGED","NATIVE_UNAVAILABLE","NATIVE_CHANGED","OWNER_UNAVAILABLE",
  "BACKUP_CONFLICT","BACKUP_VERIFICATION_FAILED","RECOVERY_REQUIRED",
]);
function denied(code: MappingCode): never { throw new MappingError(code); }
function fixedError(error: unknown): MappingError {
  if (error instanceof MappingError && codes.has(error.code)) return error;
  if (error instanceof ImpactError) {
    const old: Record<string, MappingCode> = {
      IMPACT_REVISION_CONFLICT:"REVISION_CONFLICT", SOURCE_IDENTITY_CONFLICT:"IDENTITY_CONFLICT",
      ENTITY_IDENTITY_CONFLICT:"IDENTITY_CONFLICT", RECORD_IDENTITY_CONFLICT:"IDENTITY_CONFLICT",
      SOURCE_CAPACITY_EXCEEDED:"BUDGET_EXCEEDED", CROSS_SCOPE_REFERENCE_DENIED:"SCOPE_DENIED",
      REVIEW_SCOPE_DENIED:"SCOPE_DENIED", BACKUP_DESTINATION_EXISTS:"BACKUP_CONFLICT",
      BACKUP_VERIFICATION_FAILED:"BACKUP_VERIFICATION_FAILED", UNSUPPORTED_IMPACT_STORE:"UNSUPPORTED_FORMAT",
      MAPPING_SOURCE_MANAGED:"UNSUPPORTED_MAPPING", FUTURE_EVIDENCE_DENIED:"INVALID_INPUT",
    };
    return new MappingError(old[error.code] ?? "INVALID_INPUT");
  }
  return new MappingError("OWNER_UNAVAILABLE");
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
function copy<T>(value: T): T {
  try { return freeze(JSON.parse(canonicalMappingJson(value)) as T); }
  catch (error) { throw fixedError(error); }
}
function text(value: unknown, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > maximum ||
      /[\u0000-\u001f\u007f]/u.test(value)) denied("INVALID_INPUT");
  canonicalMappingJson(value); // ES2022-compatible scalar validation, no lossy replacement.
  return value;
}
function nativeId(value: unknown): string {
  const result = text(value,64);
  if (!/^[A-Za-z][A-Za-z0-9._-]{0,63}$/u.test(result)) denied("INVALID_INPUT");
  if (/\b(?:sk-(?:proj-|ant-)?|gh[pousr]_)[A-Za-z0-9_-]{20,}|\bAKIA[0-9A-Z]{16}/iu.test(result)) denied("INVALID_INPUT");
  return result;
}
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join() !== [...keys].sort().join()) denied("INVALID_INPUT");
  return value as Record<string, unknown>;
}
function digest(value: unknown): string {
  if (typeof value !== "string" || value.length !== 64 || !/^[0-9a-f]{64}$/u.test(value)) denied("INVALID_INPUT");
  return value;
}
function uuid(value: unknown): string {
  if (typeof value !== "string" || value.length !== 36 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value) ||
      value === "00000000-0000-0000-0000-000000000000") denied("INVALID_INPUT");
  return value;
}
function authority(value: unknown): MappingSourceAuthority {
  const a = exact(value,["sourceId","projectId","siteId","environmentId","kind","minimumClassification",
    "sourceAuthorityFingerprint","nativeProjectId","nativeStoreUuid","nativeAuthorityFingerprint","policyVersion"]);
  if (!["manifest","code","native"].includes(a.kind as string) ||
      (a.minimumClassification !== "public" && a.minimumClassification !== "internal")) denied("INVALID_INPUT");
  const result: MappingSourceAuthority = {
    sourceId:identifier(a.sourceId),projectId:nativeId(a.projectId),siteId:nativeId(a.siteId),environmentId:nativeId(a.environmentId),
    kind:a.kind as MappingSourceAuthority["kind"],minimumClassification:a.minimumClassification,
    sourceAuthorityFingerprint:digest(a.sourceAuthorityFingerprint),nativeProjectId:nativeId(a.nativeProjectId),
    nativeStoreUuid:uuid(a.nativeStoreUuid),nativeAuthorityFingerprint:digest(a.nativeAuthorityFingerprint),
    policyVersion:text(a.policyVersion,160),
  };
  if (result.projectId !== result.nativeProjectId) denied("INVALID_INPUT");
  if (runEgressSecretScan(canonicalMappingJson(result)).blocked) denied("INVALID_INPUT");
  return freeze(result);
}

/** Trusted local construction only. No observer, path, clock or maintenance
 * capability comes from mapping import data. SQLite stays inside store.ts. */
export function createImpactMappingOperator(value: MappingOperatorConfig): MappingOperator {
  const raw = exact(value,["storePath","grant","authorities","observers","maintenance","clock"]);
  if (typeof raw.clock !== "function") denied("INVALID_INPUT");
  const observers = exact(raw.observers,["observe","authorize"]);
  if (typeof observers.observe !== "function" || typeof observers.authorize !== "function") denied("INVALID_INPUT");
  const grant = freeze(validateGrant(copy(value.grant)));
  if (!Array.isArray(value.authorities) || value.authorities.length > 200) denied("BUDGET_EXCEEDED");
  const authorities = value.authorities.map(a=>authority(copy(a)));
  if (new Set(authorities.map(a=>a.sourceId)).size !== authorities.length ||
      Buffer.byteLength(canonicalMappingJson(authorities)) > 131072) denied("BUDGET_EXCEEDED");
  let maintenance: MappingOperatorConfig["maintenance"] = null;
  if (value.maintenance !== null) {
    const m = exact(copy(value.maintenance),["capabilityId","policyVersion","backupPath"]);
    maintenance = freeze({ capabilityId:identifier(m.capabilityId),policyVersion:text(m.policyVersion,160),backupPath:text(m.backupPath,32768) });
  }
  const observeFixed = value.observers.observe, authorizeFixed = value.observers.authorize, clockFixed = value.clock;
  let active = false, pendingObservers = 0;
  const configuration: MappingOperatorConfig = {
    storePath:text(raw.storePath,32768),grant,authorities:freeze(authorities),maintenance,
    clock:()=>timestamp(clockFixed()),
    observers:{
      authorize:()=>{ try { authorizeFixed(); } catch(error) { throw error instanceof MappingError ? fixedError(error) : new MappingError("CONFIG_CHANGED"); } },
      observe:async(request)=>{
        const input = copy(request), controller = new AbortController();
        pendingObservers++;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const worker = Promise.resolve().then(()=>observeFixed(input,{signal:controller.signal,timeoutMilliseconds:30000}));
        // Keep BUSY after timeout until this read-only worker actually settles.
        // It never receives a transaction/handle. A late value is never reused.
        const settled = worker.then(value=>{pendingObservers--;return copy(value);},error=>{pendingObservers--;throw fixedError(error);});
        const deadline = new Promise<never>((_,reject)=>{
          timer=setTimeout(()=>{controller.abort();reject(new MappingError("OWNER_UNAVAILABLE"));},30000);
        });
        try { return await Promise.race([settled,deadline]) as MappingObservations; }
        finally { if(timer!==undefined)clearTimeout(timer); }
      },
    },
  };
  const store = createMappingStoreOperator(configuration);
  function enter(): void { if (active || pendingObservers) denied("BUSY"); active=true; }
  function sync<T>(invoke:()=>T):T {
    enter();try{return invoke();}catch(error){throw fixedError(error);}finally{active=false;}
  }
  async function asyncCall<T>(invoke:()=>Promise<T>):Promise<T> {
    enter();try{return await invoke();}catch(error){throw fixedError(error);}finally{active=false;}
  }
  return Object.freeze({
    inspectMappingFormat:()=>sync(()=>store.inspectMappingFormat()),
    upgradeMappings:(expected,operationId)=>sync(()=>store.upgradeMappings(copy(expected),operationId)),
    registerSource:(sourceId,expectedGraphRevision,operationId)=>sync(()=>store.registerSource(sourceId,expectedGraphRevision,operationId)),
    stageComplete:(input,expectedGraphRevision,operationId)=>asyncCall(()=>store.stageComplete(copy(input),expectedGraphRevision,operationId)),
    preview:(batchId)=>asyncCall(()=>store.preview(batchId)),
    decide:(review,decision,operationId)=>asyncCall(()=>store.decide(copy(review),decision,operationId)),
    receipt:(operationId)=>sync(()=>store.receipt(operationId)),
  } satisfies MappingOperator);
}
