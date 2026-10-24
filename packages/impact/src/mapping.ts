import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";
import { runEgressSecretScan } from "@atlas/privacy";
import { ImpactError, validateImport, validateGrant, grantFingerprint, sourceAllowed, timestamp } from "./model.js";
/**
 * Pure reviewed mapping domain. Storage and operator implementation are separate.
 * Intended split: mapping.ts owns pure records/functions; mapping-owner.ts owns
 * the trusted operator; store.ts alone owns SQLite/schema/transactions.
 * "./model.js" means the existing packages/impact/src/model.ts at that location.
 * No native write, memory write, accepted-serving, CLI, broker or UI API here.
 */
import type {
  Classification, ImpactAssertion, ImpactEntity, ImpactEvidence,
  ImpactGrant, ImpactImport, SourceDescriptor,
} from "./model.js";

export type DeepReadonly<T> = T extends (...args: never[]) => unknown ? T
  : T extends readonly (infer E)[] ? readonly DeepReadonly<E>[]
  : T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
export type MappingDigest = string; // Exactly 64 lowercase hex; no trailing LF.
export type MappingUuid = string; // Exactly 36 chars, lowercase canonical nonnil UUID.
export type MappingVersion = string; // Existing ASCII identifier grammar; <=100 bytes.
export type MappingGeneration = string; // Same grammar/bound; no inferred generation.
export type MappingNativeId = string; // /^[A-Za-z][A-Za-z0-9._-]{0,63}$/; native secret-like refusal.
export type MappingNativeKind =
  | "component" | "asset" | "subsystem" | "site" | "area" | "environment"
  | "repository" | "knowledge";
export type MappingIdentityKind = Exclude<MappingNativeKind, "repository" | "knowledge">;

export const MAPPING_LIMITS = Object.freeze({
  sources: 200, mappingsPerVersion: 2000, entitiesPerVersion: 2000,
  evidencePerVersion: 5000, assertionsPerVersion: 5000, evidenceIdsPerMapping: 20,
  aliasesPerMapping: 32, rowBytes: 4096, importBytes: 4194304, reviewBytes: 4194304,
  identifierBytes: 100, nativeIdentifierBytes: 64, externalKeyBytes: 240, relativeSelectionBytes: 512,
  observationTargets: 4000, observationBytes: 4194304,
  versions: 1000, identities: 20000, keys: 40000, operations: 2500,
  authoritiesBytes: 131072, receiptBytes: 8192, logicalStoreBytes: 268435456,
  observerMilliseconds: 30000,
} as const);

export type MappingCode =
  | "INVALID_INPUT" | "UNSUPPORTED_FORMAT" | "UNSUPPORTED_MAPPING"
  | "SCOPE_DENIED" | "BUSY" | "BUDGET_EXCEEDED" | "CONFIG_CHANGED"
  | "REVISION_CONFLICT" | "VERSION_CONFLICT" | "IDENTITY_CONFLICT"
  | "SOURCE_UNAVAILABLE" | "SOURCE_CHANGED" | "NATIVE_UNAVAILABLE" | "NATIVE_CHANGED"
  | "OWNER_UNAVAILABLE" | "BACKUP_CONFLICT" | "BACKUP_VERIFICATION_FAILED"
  | "RECOVERY_REQUIRED";
export class MappingError extends ImpactError {
  declare readonly code: MappingCode;
  constructor(code: MappingCode) { super(code); this.name = "MappingError"; }
}

export interface MappingTarget<K extends MappingNativeKind = MappingNativeKind> {
  readonly projectId: MappingNativeId;
  readonly storeUuid: MappingUuid; // Native LMPR schema 2 lineage, never LMIP UUID.
  readonly kind: K;
  readonly id: MappingNativeId; // Original native ID, never Impact's hashed entity ID.
}
export interface MappingRowCommon {
  readonly mappingId: MappingUuid;
  readonly externalKey: string;
  readonly generation: MappingGeneration;
  /** Complete desired aliases, excluding externalKey. Sorted/unique; never releases
   * prior reservations. A renamed old primary must appear here. Max 32. */
  readonly aliases: readonly string[];
  readonly classification: Classification;
  readonly evidenceIds: readonly string[]; // 1..20; explicit=current import, omitted retirement=preserved binding.
  readonly state: "active" | "retired";
  readonly impactEntityId: string | null;
  /** Null for ordinary creation/update; new ID+generation explicitly replaces old
   * same-source identity with a different native target. Old target is not copied. */
  readonly replacesMappingId: MappingUuid | null;
}
export type MappingRow = MappingRowCommon & (
  | { readonly kind: "identity"; readonly target: MappingTarget<MappingIdentityKind> }
  | { readonly kind: "code"; readonly target: MappingTarget<"repository">;
      readonly selection: string; readonly referenceFingerprint: MappingDigest }
  | { readonly kind: "document"; readonly target: MappingTarget<"knowledge">;
      readonly selection: string; readonly referenceFingerprint: MappingDigest }
  | { readonly kind: "memory"; readonly target: MappingTarget<"component">;
      readonly disclosure: "owner_safe_summary" }
);
export interface MappingImport {
  readonly schema: "lmti.impact.mapping-import.v1";
  readonly input: DeepReadonly<ImpactImport>;
  readonly expectedAcceptedVersion: MappingVersion | null;
  readonly mappingVersion: MappingVersion;
  readonly payloadDigest: MappingDigest;
  readonly mappings: readonly MappingRow[];
}

/** New wrapper recursively checks plain data, exact keys and Unicode scalars in
 * ALL nested legacy records before validateImport. No getters/custom prototypes,
 * sparse arrays, undefined own fields, nonfinite numbers or lone surrogates.
 * It applies the existing secret scan and bounded reference validation.
 * It does not change legacy validateImport/stableJson/digest behavior.
 * Canonical new records use raw UTF-16 code-unit ordering (never localeCompare);
 * ID fields are ASCII. payloadDigest excludes itself, includes all other fields,
 * and is SHA256 of UTF8("lmti.impact.mapping.payload.v1\n" + canonical JSON).
 * New identifiers/key/array normalization is deterministic and non-coercing.
 * Duplicate JSON keys are a later byte-boundary responsibility, not recoverable
 * from an already parsed JS object. selection is safe source-relative metadata;
 * the mapping owner never opens it.
 */

/** Trusted registration material, supplied only at operator construction. Neither
 * import nor registerSource can supply a path/executable/grant/callback/authority.
 * Existing legacy source enrollment must match project/site/environment/kind.
 * An authority is immutable after enrollment; widening needs a later explicit
 * authority lifecycle and is outside this increment. */
export interface MappingSourceAuthority {
  readonly sourceId: string;
  readonly projectId: MappingNativeId;
  readonly siteId: MappingNativeId;
  readonly environmentId: MappingNativeId;
  readonly kind: SourceDescriptor["kind"];
  readonly minimumClassification: Classification;
  readonly sourceAuthorityFingerprint: MappingDigest;
  readonly nativeProjectId: MappingNativeId; // Must equal projectId; both pins checked.
  readonly nativeStoreUuid: MappingUuid;
  readonly nativeAuthorityFingerprint: MappingDigest;
  readonly policyVersion: string;
}
export interface MappingScope {
  readonly grant: DeepReadonly<ImpactGrant>;
  readonly authority: MappingSourceAuthority;
  readonly grantFingerprint: MappingDigest;
}

/** Checked current source input, produced by a trusted fixed observer, not caller
 * SourceCheck. Stable fingerprint excludes checkedAt and binds fixed authority,
 * revision/digest and effective classification. Missing/hidden is a bounded error. */
export interface MappingSourceObservation {
  readonly sourceId: string;
  readonly authorityFingerprint: MappingDigest;
  readonly revision: string;
  readonly digest: MappingDigest;
  readonly classification: Classification;
  readonly checkedAt: string;
  readonly fingerprint: MappingDigest;
}
export interface MappingTargetObservation {
  readonly target: MappingTarget;
  readonly effectiveClassification: Classification; // Full native ancestors/environment/reference.
  readonly ancestryFingerprint: MappingDigest;
  readonly referenceFingerprint: MappingDigest | null;
  /** Six durable registry kinds require active. Repository/knowledge must be
   * currently present with reference fingerprint; no invented registry status. */
  readonly identityState: "active" | "present_reference";
}
export interface MappingNativeObservation {
  readonly schema: 2 | 3;
  readonly projectId: MappingNativeId;
  readonly storeUuid: MappingUuid;
  readonly revision: number;
  readonly authorityFingerprint: MappingDigest;
  readonly checkedAt: string;
  readonly fingerprint: MappingDigest;
  readonly targets: readonly MappingTargetObservation[];
}
export interface MappingObservations {
  readonly source: MappingSourceObservation;
  readonly native: MappingNativeObservation;
}
/** Source/native fingerprint = SHA256(UTF8(domain + "\n" + canonical object
 * excluding checkedAt and fingerprint)); domains respectively
 * lmti.impact.mapping.source-observation.v1 and
 * lmti.impact.mapping.native-observation.v1. Native targets sort by
 * projectId/storeUuid/kind/id tuple using raw ordering, never delimiter guessing.
 * Pure transition verifies exact supplied fingerprint and complete target set. */
export interface MappingObservationRequest {
  readonly phase: "stage" | "preview" | "accept";
  readonly authority: MappingSourceAuthority;
  readonly sourceRevision: string;
  readonly sourceDigest: MappingDigest;
  readonly targets: readonly MappingTarget[]; // Exact sorted unique active/affected existing endpoints.
}
export interface MappingObservationContext {
  readonly signal: AbortSignal;
  readonly timeoutMilliseconds: 30000;
}
export interface MappingObservers {
  /** Fixed read-only closure; no DatabaseSync, transaction, file opener or write
   * capability is supplied. Resolve only the authority pinned at construction.
   * No partial/filtered target set can be reported complete. A missing/hidden
   * requested target yields NATIVE_UNAVAILABLE uniformly before old-value tests. */
  readonly observe: (
    request: MappingObservationRequest, context: MappingObservationContext
  ) => Promise<MappingObservations>;
  /** Reauthorize current fixed capability/config; throws SCOPE_DENIED or
   * CONFIG_CHANGED. Return bytes cannot widen the copied original capability. */
  readonly authorize: () => void;
}

export interface MappingVersionSnapshot {
  readonly batchId: string;
  readonly mappingVersion: MappingVersion;
  readonly payloadDigest: MappingDigest;
  readonly input: DeepReadonly<ImpactImport>;
  readonly mappings: readonly MappingRow[]; // Includes explicit/derived retirement rows.
  readonly evidenceBindings: readonly MappingEvidenceBinding[];
}
export interface MappingIdentityReservation {
  readonly mappingId: MappingUuid;
  readonly sourceId: string;
  readonly generation: MappingGeneration;
  readonly target: MappingTarget;
  readonly createdBatchId: string;
  readonly retiredBatchId: string | null;
}
export interface MappingKeyReservation {
  readonly sourceId: string;
  readonly key: string;
  readonly generation: MappingGeneration;
  readonly mappingId: MappingUuid;
}
export interface MappingCapacity {
  readonly registeredSources: number;
  readonly versions: number;
  readonly identities: number;
  readonly keys: number;
  readonly operations: number;
  readonly authoritiesBytes: number;
}
export interface MappingBeforeState {
  readonly storeUuid: MappingUuid;
  readonly graphRevision: number;
  readonly authority: MappingSourceAuthority;
  /** Existing accepted legacy snapshot is retained for its entity/evidence/
   * assertion diff on first enrollment; no mappings are synthesized from it. */
  readonly acceptedImport: DeepReadonly<ImpactImport> | null;
  readonly acceptedMapping: MappingVersionSnapshot | null;
  readonly latestBatchId: string | null;
  readonly identities: readonly MappingIdentityReservation[];
  readonly keys: readonly MappingKeyReservation[];
  readonly capacity: MappingCapacity;
}
export type MappingRecordChange<T> =
  | { readonly kind: "added"; readonly id: string; readonly before: null; readonly after: DeepReadonly<T> }
  | { readonly kind: "changed"; readonly id: string; readonly before: DeepReadonly<T>; readonly after: DeepReadonly<T> }
  | { readonly kind: "retired"; readonly id: string; readonly before: DeepReadonly<T>; readonly after: null };
export interface MappingDiff {
  readonly source: {
    readonly before: DeepReadonly<SourceDescriptor> | null;
    readonly after: DeepReadonly<SourceDescriptor>;
  };
  readonly entities: readonly MappingRecordChange<ImpactEntity>[];
  readonly evidence: readonly MappingRecordChange<ImpactEvidence>[];
  readonly assertions: readonly MappingRecordChange<ImpactAssertion>[];
  /** Retirement is explicit before active -> after retired, never deletion of a
   * reservation. This is a changed row; kind=retired/after=null is not used here. */
  readonly mappings: readonly MappingRecordChange<MappingRow>[];
  /** Tuple key is canonical JSON [mappingId,evidenceId], not delimiter joining.
   * Includes historical evidence bodies/provenance absent from current input. */
  readonly mappingEvidence: readonly MappingRecordChange<MappingEvidenceBinding>[];
  readonly reservedKeys: readonly MappingKeyReservation[];
  readonly retireMappingIds: readonly MappingUuid[];
  readonly replacements: readonly {
    readonly oldMappingId: MappingUuid; readonly newMappingId: MappingUuid;
  }[];
}
export interface MappingTransition {
  readonly candidate: MappingVersionSnapshot;
  readonly diff: MappingDiff;
  readonly diffDigest: MappingDigest; // Domain lmti.impact.mapping.diff.v1 + LF + canonical JSON.
  readonly reserveIdentities: readonly MappingIdentityReservation[];
  readonly reserveKeys: readonly MappingKeyReservation[];
  readonly retireOnAccept: readonly MappingUuid[];
  readonly evidenceBindings: readonly MappingEvidenceBinding[];
}
export interface MappingEvidenceBinding {
  readonly mappingId: MappingUuid;
  readonly evidenceId: string;
  readonly evidenceBatchId: string;
  readonly evidence: DeepReadonly<ImpactEvidence>; // Exact persisted/current record, for full privacy/diff checks.
}
/** Storage first handles authorized exact operation/version replay, then supplies
 * the original persisted before state. This pure function rejects stale expected
 * accepted token, identity/alias conflicts and unsupported reactivation.
 * A mappingVersion-only change is not a semantic change. A changed complete
 * source descriptor (including real revision/digest/capturedAt) may legitimately
 * re-review unchanged associations. Ignore only observer checkedAt in freshness
 * fingerprints; reject no-op with VERSION_CONFLICT when source and all four
 * record sets are unchanged. Candidate batch ID is "mapping-" +
 * SHA256(UTF8("lmti.impact.mapping.batch.v1\n" + submitted payloadDigest)).
 * Complete omissions produce retirement candidates; never infer replacement.
 * Class floor = max(authority.minimum, source observation/source privacy,
 * mapping classification, linked entity/evidence privacy, native effective privacy).
 * Reject a declared mapping classification below that floor, even allowInternal.
 * Reject lowering an existing association's stored classification; owner_safe_summary
 * is disclosure policy, never permission to relabel Internal as Public.
 * Authorize before exposing before records/conflicts; compare complete snapshots,
 * not sequential mutations. The complete embedded import AND complete original/
 * desired diff must be within the grant, including each entity/evidence/assertion;
 * hidden Internal rows cause SCOPE_DENIED, never filtered "complete" output.
 * Retired/hidden/unavailable native endpoints are a
 * fail-closed first-slice limitation, not permission to invent identity evidence.
 * Omitted accepted rows remain in the complete candidate as retired; newly omitted
 * active rows preserve metadata except state. These derived rows carry their
 * exact previous evidenceBindings (which may refer to an older accepted batch).
 * Never guess that provenance from the immediately previous batch. Authorize
 * referenced prior evidence classification too. Explicit incoming retired rows
 * require current-batch evidence, existing same identity and no reactivation;
 * reviewed metadata can change without releasing original reservations.
 */

/** Private source-scoped receipt authorization persists original authority and
 * grant fingerprint. Historical lookup/replay authorizes THIS scope before
 * comparing a newly supplied request/source; current ID knowledge is insufficient.
 * Current config must still authorize this original authority. A grant may narrow
 * only if all original receipt/diff scope remains authorized; it cannot rebind it. */
export interface MappingReceiptScope {
  readonly authority: MappingSourceAuthority;
  readonly grantFingerprint: MappingDigest;
  readonly principalId: string;
  readonly classification: Classification;
}
export type MappingOperationScope =
  | { readonly kind: "source"; readonly scope: MappingReceiptScope }
  | { readonly kind: "maintenance"; readonly capabilityId: string;
      readonly policyVersion: string; readonly principalId: string;
      readonly grantFingerprint: MappingDigest };
export type MappingAction = "upgrade" | "register_source" | "stage" | "accept" | "reject";
export interface MappingReceipt {
  readonly schema: "lmti.impact.mapping.receipt.v1";
  readonly operationId: MappingUuid;
  readonly action: MappingAction;
  readonly requestDigest: MappingDigest;
  readonly storeUuid: MappingUuid;
  readonly sourceId: string | null;
  readonly batchId: string | null;
  readonly mappingVersion: MappingVersion | null;
  readonly payloadDigest: MappingDigest | null;
  readonly graphRevisionBefore: number;
  readonly graphRevisionAfter: number;
  readonly decision: "format_upgraded" | "source_registered" | "pending" | "accepted" | "rejected";
  readonly committedAt: string;
  readonly upgrade: null | {
    readonly originalSnapshotDigest: MappingDigest;
    readonly backupSnapshotDigest: MappingDigest;
    readonly backupIdentityDigest: MappingDigest; // No path disclosure in receipt.
  };
}
export type MappingWriteOutcome =
  | { readonly outcome: "confirmed"; readonly receipt: MappingReceipt; readonly replayed: boolean }
  | { readonly outcome: "unknown"; readonly operationId: MappingUuid; readonly action: MappingAction;
      readonly code: "RECOVERY_REQUIRED"; readonly receipt: null };
/** Only confirmed receipts are durable. Refusals throw MappingError before any
 * possible COMMIT; unexpected COMMIT errors return unknown. Known success latch
 * precedes fallible return work; no post-COMMIT read/observer can demote it.
 * Exact receipt inspection may establish historical success, never auto-replay.
 * A version retry may return the original stage receipt/operationId; it does not
 * insert a fresh receipt under the retry's unused operationId.
 */

export interface MappingReview {
  readonly schema: "lmti.impact.mapping.review.v1";
  readonly storeUuid: MappingUuid;
  readonly graphRevision: number;
  readonly scope: MappingReceiptScope;
  readonly batchId: string;
  readonly mappingVersion: MappingVersion;
  readonly payloadDigest: MappingDigest;
  readonly expectedAcceptedVersion: MappingVersion | null;
  readonly sourceFingerprint: MappingDigest;
  readonly nativeFingerprint: MappingDigest;
  readonly nativeRevision: number;
  readonly diff: MappingDiff;
  readonly diffDigest: MappingDigest;
  readonly reviewDigest: MappingDigest; // Entire review except this field, domain+LF.
}
export interface MappingFormatPreview {
  readonly schema: "lmti.impact.mapping.format.v1";
  readonly applicationId: 0x4c4d4950;
  readonly schemaVersion: 1 | 2 | 3;
  readonly storeUuid: MappingUuid | null; // Null exactly for 1/2.
  readonly graphRevision: number;
  readonly sourceIdentityDigest: MappingDigest; // Fixed opened LMIP file identity.
  readonly ownedSnapshotDigest: MappingDigest; // Exact owned schema/data/raw legacy JSON.
  readonly schemaCatalogDigest: MappingDigest; // All sqlite_schema objects, bounded.
}
export interface MappingOperatorConfig {
  readonly storePath: string; // Trusted fixed local LMIP path; never payload authority.
  readonly grant: DeepReadonly<ImpactGrant>;
  readonly authorities: readonly MappingSourceAuthority[];
  readonly observers: MappingObservers;
  /** Separate explicit whole-store maintenance capability. Mapping source grants
   * alone do not authorize a format upgrade of other sources/reports. */
  readonly maintenance: null | {
    readonly capabilityId: string; readonly policyVersion: string;
    readonly backupPath: string; // Fixed exact destination reserved before VACUUM INTO.
  };
  readonly clock: () => string; // Fixed UTC provider, copied function reference.
}
export interface MappingOperator {
  inspectMappingFormat(): MappingFormatPreview; // Whole-store digests require maintenance capability.
  upgradeMappings(expected: MappingFormatPreview, operationId: MappingUuid): MappingWriteOutcome;
  registerSource(sourceId: string, expectedGraphRevision: number, operationId: MappingUuid): MappingWriteOutcome;
  stageComplete(input: unknown, expectedGraphRevision: number, operationId: MappingUuid): Promise<MappingWriteOutcome>;
  preview(batchId: string): Promise<MappingReview>;
  decide(review: MappingReview, decision: "accept" | "reject", operationId: MappingUuid): Promise<MappingWriteOutcome>;
  /** Current config authorize first. Unknown and known-but-out-of-scope IDs both
   * return null; never reveal which exists. Explicit config revocation may throw
   * the fixed SCOPE_DENIED/CONFIG_CHANGED code. Same rule precedes request replay. */
  receipt(operationId: MappingUuid): MappingReceipt | null;
}
// This runtime export belongs only to mapping-owner.ts. Other shared types and
// pure runtime exports above belong to mapping.ts (no third contract module).
// createImpactMappingOperator is implemented/exported by mapping-owner.ts.

/**
 * STORAGE / LIFETIME INVARIANTS (implementation acceptance, not optional advice)
 *
 * - Copy/freeze all config/data before await; callbacks retain no owner handle.
 *   One in-flight method per operator, including reads; a second call fails BUSY.
 *   Each observe has a 30s bound and AbortSignal. On timeout, ignore late result,
 *   roll back/close LMIP transaction, return OWNER_UNAVAILABLE. Keep in-flight gate
 *   until underlying read callback settles; never release a DB handle to it.
 *   authorize() runs before disclosure/transaction and after await before DML.
 * - Stage/accept: one BEGIN IMMEDIATE connection; original graph/accepted/version
 *   state and complete diff recomputed there; observer recheck under that lock.
 *   Exact retries authorize persisted scope FIRST, then compare op/action/request
 *   or source/version/digest BEFORE stale incoming graph CAS, without new writes.
 *   Reject uses original review/graph/latest CAS but does not need source/native
 *   availability to reject; it still requires current original-scope authority.
 * - Stage reserves identities/keys permanently even if rejected, as old Impact
 *   ownership does. Native targets never mutate. Only accept retires old mapping
 *   reservations; pending/rejected versions never become serving state.
 *   Pure before-state contains this source's bounded reservations; storage also
 *   refuses global mappingId/entity/evidence ownership collisions without exposing
 *   another source's records. Retained retired rows count toward the complete
 *   candidate limit; original identity/key/evidence provenance is preserved.
 * - Internal batch writer takes discriminated mode legacy|mapping_managed.
 *   Only mapping_managed bypasses SOURCE_DIGEST_REUSED and uses mapping batch ID.
 *   Both share original entity/key/evidence ownership/reference checks. Old entry
 *   points refuse mapping-managed source/batch; no duplicate/nested transaction.
 * - Preserve initializer format2, explicit old1->2, and read1|2|3. Old upgrade on3
 *   is a nonmutating already-newer result, never downgrade or reserve backup.
 *   New upgrade requires schema2 + maintenance capability. UUID minted before
 *   DML; verified VACUUM INTO backup includes committed WAL. Under same original
 *   connection, recheck schema/graph/data_version/full snapshot before DDL.
 * - Validate exact owned table columns/PK/FK/CHECK/index definitions before new
 *   mapping operations and upgrade. Never accept a view/virtual table in place of
 *   an owned table. Only the exact two review_events immutable triggers are
 *   allowed on legacy owned tables; new owned tables allow only specified owner
 *   guards, if any. Unexpected attached triggers refuse BEFORE any mutation.
 *   Preserve unrelated objects without querying/executing their view/trigger SQL;
 *   reject reserved-name collisions. Do not use writable_schema/extension loads.
 * - Migration preserves raw old data and unrelated objects; full schema catalog
 *   digest plus owned data digest and data_version bind review/backup. This does
 *   not assert a hostile-filesystem lease or a cross-owner transaction.
 * - Count+1 checks enforce every limit including rejected/retired reservations.
 *   N+1 needs safe-integer headroom. Logical main page limit and per-file sidecar
 *   bounds do not imply aggregate VFS work/WAL-size guarantees.
 * - Compact <=8KiB success receipt is prebuilt before DML, stored atomically with
 *   heads/history; immutable after commit. Rollback failure cannot overwrite the
 *   original unknown-commit classification. No automatic retry/delete/restore.
 *   Upgrade receipts authorize maintenance; source receipts authorize persisted
 *   original scope. No accepted-mapping serving or native handoff in this slice.
 */

type Data = null | boolean | number | string | Data[] | { [key: string]: Data };
type Obj = Record<string, unknown>;
const identityKinds = ["component", "asset", "subsystem", "site", "area", "environment"] as const;
const targetKinds = [...identityKinds, "repository", "knowledge"] as const;
const rawOrder = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
function deny(code: MappingCode = "INVALID_INPUT"): never { throw new MappingError(code); }
function requireThat(ok: unknown, code: MappingCode = "INVALID_INPUT"): asserts ok { if (!ok) deny(code); }
function scalar(value: string): void {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = value.charCodeAt(++i);
      requireThat(next >= 0xdc00 && next <= 0xdfff);
    } else requireThat(c < 0xdc00 || c > 0xdfff);
  }
}
/** Inspect descriptors before copying; JSON.stringify must never invoke a caller
 * getter/toJSON. The hard traversal ceiling also bounds private history objects;
 * operation-specific byte/row limits below are much smaller. */
function data(value: unknown): Data {
  let nodes = 0, bytes = 0;
  const active = new Set<object>();
  function visit(v: unknown, depth: number): Data {
    requireThat(++nodes <= 1_000_000 && depth <= 32, "BUDGET_EXCEEDED");
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "number") { requireThat(Number.isFinite(v)); return Object.is(v, -0) ? 0 : v; }
    if (typeof v === "string") {
      scalar(v); bytes += Buffer.byteLength(v);
      requireThat(bytes <= 64 * 1024 * 1024, "BUDGET_EXCEEDED"); return v;
    }
    requireThat(typeof v === "object" && v !== null && !active.has(v) && !nodeTypes.isProxy(v));
    const array = Array.isArray(v), proto = Object.getPrototypeOf(v);
    requireThat(array ? proto === Array.prototype : proto === Object.prototype || proto === null);
    active.add(v);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(v), keys = Reflect.ownKeys(v);
      requireThat(keys.every(k => typeof k === "string"));
      if (array) {
        const length = (v as unknown[]).length;
        requireThat(length <= 100_000, "BUDGET_EXCEEDED");
        requireThat(keys.length === length + 1 && Object.hasOwn(descriptors, "length"));
        const out: Data[] = [];
        for (let i = 0; i < length; i++) {
          const descriptor = descriptors[String(i)];
          requireThat(descriptor && "value" in descriptor && descriptor.enumerable);
          out.push(visit(descriptor.value, depth + 1));
        }
        return out;
      }
      const out: { [key: string]: Data } = Object.create(null);
      for (const key of keys as string[]) {
        scalar(key); bytes += Buffer.byteLength(key);
        requireThat(bytes <= 64 * 1024 * 1024, "BUDGET_EXCEEDED");
        const descriptor = descriptors[key];
        requireThat(descriptor && "value" in descriptor && descriptor.enumerable);
        out[key] = visit(descriptor.value, depth + 1);
      }
      return out;
    } finally { active.delete(v); }
  }
  return visit(value, 0);
}
function encoded(v: Data): string {
  if (Array.isArray(v)) return `[${v.map(encoded).join(",")}]`;
  if (v !== null && typeof v === "object") {
    return `{${Object.keys(v).sort(rawOrder).map(k => `${JSON.stringify(k)}:${encoded(v[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}
export function canonicalMappingJson(value: unknown): string { return encoded(data(value)); }
function same(a: unknown, b: unknown): boolean { return canonicalMappingJson(a) === canonicalMappingJson(b); }
function hash(domain: string, value: unknown): string {
  return createHash("sha256").update(domain + "\n" + canonicalMappingJson(value), "utf8").digest("hex");
}
function limit(value: unknown, maximum: number): string {
  const text = canonicalMappingJson(value);
  requireThat(Buffer.byteLength(text) <= maximum, "BUDGET_EXCEEDED"); return text;
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) freeze(entry);
    Object.freeze(value);
  }
  return value;
}
function obj(value: unknown, fields: readonly string[], optional: readonly string[] = []): Obj {
  requireThat(value !== null && typeof value === "object" && !Array.isArray(value));
  const o = value as Obj, keys = Object.keys(o);
  requireThat(keys.every(k => fields.includes(k) || optional.includes(k)) && fields.every(k => Object.hasOwn(o, k)));
  return o;
}
function text(value: unknown, max: number): string {
  requireThat(typeof value === "string" && value.trim().length > 0 && Buffer.byteLength(value) <= max &&
    !/[\x00-\x1f\x7f]/u.test(value)); scalar(value); return value;
}
function legacyText(value: unknown, max: number): string {
  requireThat(typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/u.test(value));
  scalar(value); return value;
}
function id(value: unknown): string { const s = text(value, 100); requireThat(/^[A-Za-z][A-Za-z0-9._:-]*$/u.test(s)); return s; }
function nativeId(value: unknown): string {
  const s = text(value, 64);
  requireThat(/^[A-Za-z][A-Za-z0-9._-]{0,63}$/u.test(s));
  requireThat(!/\b(?:(?:sk-(?:proj-|ant-)?|gh[pousr]_)[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})/iu.test(s));
  return s;
}
function hex(value: unknown): string { requireThat(typeof value === "string" && value.length === 64 && /^[a-f0-9]{64}$/u.test(value)); return value; }
function uuid(value: unknown): string {
  requireThat(typeof value === "string" && value.length === 36 && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(value) &&
    value !== "00000000-0000-0000-0000-000000000000"); return value;
}
function integer(value: unknown, max = Number.MAX_SAFE_INTEGER, min = 0): number {
  requireThat(typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max); return value;
}
function choice<T extends string>(value: unknown, values: readonly T[]): T {
  requireThat(typeof value === "string" && values.includes(value as T)); return value as T;
}
function privacy(value: unknown): Classification { return choice(value, ["public", "internal"]); }
function array<T>(value: unknown, max: number, convert: (v: unknown) => T, min = 0): T[] {
  requireThat(Array.isArray(value)); requireThat(value.length >= min && value.length <= max, "BUDGET_EXCEEDED");
  return value.map(convert);
}
function unique<T>(rows: readonly T[], key: (v: T) => string): void {
  requireThat(new Set(rows.map(key)).size === rows.length);
}
function strings(value: unknown, max: number, convert: (v: unknown) => string, min = 0): string[] {
  const result = array(value, max, convert, min); unique(result, x => x); return result.sort(rawOrder);
}
function date(value: unknown): string {
  try { return timestamp(value); } catch { return deny(); }
}
function selection(value: unknown): string {
  const s = text(value, 512).replaceAll("\\", "/");
  requireThat(!s.includes(":") && !/[<>|?*"]/u.test(s));
  requireThat(s.split("/").every(p => p && ![".", "..", ".git", ".lmti", ".ssh", ".aws", ".azure", "node_modules"].includes(p.toLowerCase()) &&
    p.toLowerCase() !== ".env" && !p.toLowerCase().startsWith(".env.") && !/[. ]$/u.test(p) &&
    !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(p)));
  return s;
}
function target(value: unknown): MappingTarget {
  const o = obj(value, ["projectId", "storeUuid", "kind", "id"]);
  return { projectId: nativeId(o.projectId), storeUuid: uuid(o.storeUuid), kind: choice(o.kind, targetKinds), id: nativeId(o.id) };
}
function targetKey(t: MappingTarget): string { return canonicalMappingJson([t.projectId, t.storeUuid, t.kind, t.id]); }
function compareTarget(a: MappingTarget, b: MappingTarget): number {
  for (const key of ["projectId", "storeUuid", "kind", "id"] as const) {
    const c = rawOrder(a[key], b[key]); if (c) return c;
  }
  return 0;
}
function row(value: unknown): MappingRow {
  requireThat(value !== null && typeof value === "object" && !Array.isArray(value));
  const kind = choice((value as Obj).kind, ["identity", "code", "document", "memory"]);
  const common = ["mappingId", "externalKey", "generation", "aliases", "classification", "evidenceIds", "state", "impactEntityId", "replacesMappingId", "kind", "target"];
  const o = obj(value, [...common, ...(kind === "code" || kind === "document" ? ["selection", "referenceFingerprint"] : kind === "memory" ? ["disclosure"] : [])]);
  const t = target(o.target), externalKey = text(o.externalKey, 240);
  const aliases = strings(o.aliases, 32, v => text(v, 240));
  requireThat(!aliases.includes(externalKey));
  const base: MappingRowCommon = {
    mappingId: uuid(o.mappingId), externalKey, generation: id(o.generation), aliases,
    classification: privacy(o.classification), evidenceIds: strings(o.evidenceIds, 20, id, 1),
    state: choice(o.state, ["active", "retired"]), impactEntityId: o.impactEntityId === null ? null : id(o.impactEntityId),
    replacesMappingId: o.replacesMappingId === null ? null : uuid(o.replacesMappingId)
  };
  requireThat(base.mappingId !== base.replacesMappingId);
  let result: MappingRow;
  if (kind === "identity") {
    requireThat((identityKinds as readonly string[]).includes(t.kind), "UNSUPPORTED_MAPPING");
    result = { ...base, kind, target: t as MappingTarget<MappingIdentityKind> };
  } else if (kind === "memory") {
    requireThat(t.kind === "component" && o.disclosure === "owner_safe_summary", "UNSUPPORTED_MAPPING");
    result = { ...base, kind, target: t as MappingTarget<"component">, disclosure: "owner_safe_summary" };
  } else {
    requireThat(t.kind === (kind === "code" ? "repository" : "knowledge"), "UNSUPPORTED_MAPPING");
    result = { ...base, kind, target: t, selection: selection(o.selection), referenceFingerprint: hex(o.referenceFingerprint) } as MappingRow;
  }
  limit(result, MAPPING_LIMITS.rowBytes); return result;
}
function legacy(value: unknown): ImpactImport {
  let result: ImpactImport;
  try { result = validateImport(value); }
  catch (e) { return deny(e instanceof ImpactError && e.code === "INPUT_SIZE_DENIED" ? "BUDGET_EXCEEDED" : "INVALID_INPUT"); }
  // New exact framing does not alter the pre-existing legacy validator/hash.
  hex(result.source.digest);
  // Only this new contract uses raw identity order; legacy normalization is unchanged.
  return { ...result, entities: result.entities.sort((a, b) => rawOrder(a.id, b.id)),
    evidence: result.evidence.sort((a, b) => rawOrder(a.id, b.id)),
    assertions: result.assertions.map(a => ({ ...a, evidenceIds: [...a.evidenceIds].sort(rawOrder),
      applicableChanges: [...a.applicableChanges].sort(rawOrder) })).sort((a, b) => rawOrder(a.id, b.id)) };
}
type Body = Omit<MappingImport, "payloadDigest">;
function body(value: unknown): Body {
  const o = obj(value, ["schema", "input", "expectedAcceptedVersion", "mappingVersion", "mappings"]);
  requireThat(o.schema === "lmti.impact.mapping-import.v1", "UNSUPPORTED_FORMAT");
  const input = legacy(o.input), mappings = array(o.mappings, 2000, row).sort((a, b) => rawOrder(a.mappingId, b.mappingId));
  unique(mappings, r => r.mappingId);
  const evidence = new Set(input.evidence.map(e => e.id)), entities = new Set(input.entities.map(e => e.id));
  for (const r of mappings) {
    requireThat(r.evidenceIds.every(e => evidence.has(e)) && (r.impactEntityId === null || entities.has(r.impactEntityId)));
  }
  return { schema: "lmti.impact.mapping-import.v1", input,
    expectedAcceptedVersion: o.expectedAcceptedVersion === null ? null : id(o.expectedAcceptedVersion),
    mappingVersion: id(o.mappingVersion), mappings };
}
function safeInput(value: unknown): Data {
  const copied = data(value), encoded = limit(copied, MAPPING_LIMITS.importBytes);
  requireThat(!runEgressSecretScan(encoded).blocked); return copied;
}
export function mappingPayloadDigest(value: Omit<MappingImport, "payloadDigest">): MappingDigest {
  return hash("lmti.impact.mapping.payload.v1", body(safeInput(value)));
}
export function normalizeMappingImport(value: unknown): MappingImport {
  const o = obj(safeInput(value), ["schema", "input", "expectedAcceptedVersion", "mappingVersion", "payloadDigest", "mappings"]);
  const { payloadDigest, ...rest } = o, normalized = body(rest);
  const expected = hash("lmti.impact.mapping.payload.v1", normalized);
  requireThat(hex(payloadDigest) === expected);
  const result = { ...normalized, payloadDigest: expected };
  limit(result, MAPPING_LIMITS.importBytes); return freeze(result);
}
function sourceObservation(value: unknown): Omit<MappingSourceObservation, "checkedAt" | "fingerprint"> {
  const o = obj(value, ["sourceId", "authorityFingerprint", "revision", "digest", "classification"]);
  return { sourceId: id(o.sourceId), authorityFingerprint: hex(o.authorityFingerprint),
    revision: legacyText(o.revision, 160), digest: hex(o.digest), classification: privacy(o.classification) };
}
function observedTarget(value: unknown): MappingTargetObservation {
  const o = obj(value, ["target", "effectiveClassification", "ancestryFingerprint", "referenceFingerprint", "identityState"]);
  const t = target(o.target), reference = t.kind === "repository" || t.kind === "knowledge";
  requireThat(o.identityState === (reference ? "present_reference" : "active"));
  requireThat(reference ? o.referenceFingerprint !== null : o.referenceFingerprint === null);
  return { target: t, effectiveClassification: privacy(o.effectiveClassification), ancestryFingerprint: hex(o.ancestryFingerprint),
    referenceFingerprint: o.referenceFingerprint === null ? null : hex(o.referenceFingerprint),
    identityState: reference ? "present_reference" : "active" };
}
function nativeObservation(value: unknown): Omit<MappingNativeObservation, "checkedAt" | "fingerprint"> {
  const o = obj(value, ["schema", "projectId", "storeUuid", "revision", "authorityFingerprint", "targets"]);
  requireThat(o.schema === 2 || o.schema === 3, "UNSUPPORTED_FORMAT");
  const targets = array(o.targets, 4000, observedTarget).sort((a, b) => compareTarget(a.target, b.target));
  unique(targets, r => targetKey(r.target));
  const projectId = nativeId(o.projectId), storeUuid = uuid(o.storeUuid);
  requireThat(targets.every(r => r.target.projectId === projectId && r.target.storeUuid === storeUuid));
  return { schema: o.schema, projectId, storeUuid, revision: integer(o.revision, Number.MAX_SAFE_INTEGER - 1, 1),
    authorityFingerprint: hex(o.authorityFingerprint), targets };
}
export function mappingSourceFingerprint(value: Omit<MappingSourceObservation, "checkedAt" | "fingerprint">): MappingDigest {
  const normalized = sourceObservation(data(value)); limit(normalized, MAPPING_LIMITS.observationBytes);
  return hash("lmti.impact.mapping.source-observation.v1", normalized);
}
export function mappingNativeFingerprint(value: Omit<MappingNativeObservation, "checkedAt" | "fingerprint">): MappingDigest {
  const normalized = nativeObservation(data(value)); limit(normalized, MAPPING_LIMITS.observationBytes);
  return hash("lmti.impact.mapping.native-observation.v1", normalized);
}
function authority(value: unknown): MappingSourceAuthority {
  const o = obj(value, ["sourceId", "projectId", "siteId", "environmentId", "kind", "minimumClassification",
    "sourceAuthorityFingerprint", "nativeProjectId", "nativeStoreUuid", "nativeAuthorityFingerprint", "policyVersion"]);
  const projectId = nativeId(o.projectId), nativeProjectId = nativeId(o.nativeProjectId);
  requireThat(projectId === nativeProjectId, "SCOPE_DENIED");
  return { sourceId: id(o.sourceId), projectId, siteId: nativeId(o.siteId), environmentId: nativeId(o.environmentId),
    kind: choice(o.kind, ["manifest", "code", "native"]), minimumClassification: privacy(o.minimumClassification),
    sourceAuthorityFingerprint: hex(o.sourceAuthorityFingerprint), nativeProjectId,
    nativeStoreUuid: uuid(o.nativeStoreUuid), nativeAuthorityFingerprint: hex(o.nativeAuthorityFingerprint),
    policyVersion: legacyText(o.policyVersion, 160) };
}
function capacity(value: unknown): MappingCapacity {
  const o = obj(value, ["registeredSources", "versions", "identities", "keys", "operations", "authoritiesBytes"]);
  const result = { registeredSources: integer(o.registeredSources), versions: integer(o.versions),
    identities: integer(o.identities), keys: integer(o.keys), operations: integer(o.operations),
    authoritiesBytes: integer(o.authoritiesBytes) };
  requireThat(result.registeredSources <= 200 && result.versions <= 1000 && result.identities <= 20000 &&
    result.keys <= 40000 && result.operations <= 2500 && result.authoritiesBytes <= 131072, "BUDGET_EXCEEDED");
  return result;
}
function reservation(value: unknown): MappingIdentityReservation {
  const o = obj(value, ["mappingId", "sourceId", "generation", "target", "createdBatchId", "retiredBatchId"]);
  return { mappingId: uuid(o.mappingId), sourceId: id(o.sourceId), generation: id(o.generation), target: target(o.target),
    createdBatchId: id(o.createdBatchId), retiredBatchId: o.retiredBatchId === null ? null : id(o.retiredBatchId) };
}
function keyReservation(value: unknown): MappingKeyReservation {
  const o = obj(value, ["sourceId", "key", "generation", "mappingId"]);
  return { sourceId: id(o.sourceId), key: text(o.key, 240), generation: id(o.generation), mappingId: uuid(o.mappingId) };
}
function evidenceRecord(value: unknown): ImpactEvidence {
  const o = obj(value, ["id", "locator", "summary", "capturedAt", "privacy"], ["observedAt", "entityId"]);
  const locator = legacyText(o.locator, 512);
  requireThat(!locator.startsWith("/") && !locator.startsWith("\\") && !/^[a-z]+:/iu.test(locator) &&
    !locator.split(/[\\/]/u).includes(".."));
  const result: ImpactEvidence = { id: id(o.id), locator, summary: legacyText(o.summary, 2000),
    capturedAt: date(o.capturedAt), privacy: privacy(o.privacy) };
  if (Object.hasOwn(o, "observedAt")) result.observedAt = date(o.observedAt);
  if (Object.hasOwn(o, "entityId")) result.entityId = id(o.entityId);
  requireThat(!result.observedAt || Date.parse(result.observedAt) <= Date.parse(result.capturedAt));
  return result;
}
function evidenceBinding(value: unknown): MappingEvidenceBinding {
  const o = obj(value, ["mappingId", "evidenceId", "evidenceBatchId", "evidence"]);
  const e = evidenceRecord(o.evidence), evidenceId = id(o.evidenceId);
  requireThat(e.id === evidenceId);
  return { mappingId: uuid(o.mappingId), evidenceId, evidenceBatchId: id(o.evidenceBatchId), evidence: e };
}
function bindingKey(value: Pick<MappingEvidenceBinding, "mappingId" | "evidenceId">): string {
  return canonicalMappingJson([value.mappingId, value.evidenceId]);
}
function snapshot(value: unknown): MappingVersionSnapshot {
  const o = obj(value, ["batchId", "mappingVersion", "payloadDigest", "input", "mappings", "evidenceBindings"]);
  const mappings = array(o.mappings, 2000, row).sort((a, b) => rawOrder(a.mappingId, b.mappingId));
  const bindings = array(o.evidenceBindings, 40000, evidenceBinding).sort((a, b) => rawOrder(bindingKey(a), bindingKey(b)));
  unique(mappings, r => r.mappingId); unique(bindings, bindingKey);
  const expected = mappings.flatMap(r => r.evidenceIds.map(evidenceId => bindingKey({ mappingId: r.mappingId, evidenceId }))).sort(rawOrder);
  requireThat(same(expected, bindings.map(bindingKey)));
  return { batchId: id(o.batchId), mappingVersion: id(o.mappingVersion), payloadDigest: hex(o.payloadDigest),
    input: legacy(o.input), mappings, evidenceBindings: bindings };
}
function prior(value: unknown): MappingBeforeState {
  const o = obj(data(value), ["storeUuid", "graphRevision", "authority", "acceptedImport", "acceptedMapping",
    "latestBatchId", "identities", "keys", "capacity"]);
  const acceptedImport = o.acceptedImport === null ? null : legacy(o.acceptedImport);
  const acceptedMapping = o.acceptedMapping === null ? null : snapshot(o.acceptedMapping);
  requireThat(acceptedMapping === null || acceptedImport !== null && same(acceptedImport, acceptedMapping.input));
  const identities = array(o.identities, 20000, reservation).sort((a, b) => rawOrder(a.mappingId, b.mappingId));
  const keys = array(o.keys, 40000, keyReservation).sort((a, b) => rawOrder(canonicalMappingJson([a.key, a.generation]), canonicalMappingJson([b.key, b.generation])));
  unique(identities, r => r.mappingId); unique(keys, k => canonicalMappingJson([k.sourceId, k.key, k.generation]));
  const cap = capacity(o.capacity);
  requireThat(cap.identities >= identities.length && cap.keys >= keys.length && cap.registeredSources >= 1);
  return { storeUuid: uuid(o.storeUuid), graphRevision: integer(o.graphRevision), authority: authority(o.authority),
    acceptedImport, acceptedMapping, latestBatchId: o.latestBatchId === null ? null : id(o.latestBatchId),
    identities, keys, capacity: cap };
}
function authorizedImport(input: DeepReadonly<ImpactImport>, grant: ImpactGrant, a: MappingSourceAuthority): void {
  requireThat(input.source.id === a.sourceId && input.source.projectId === a.projectId && input.source.siteId === a.siteId &&
    input.source.environmentId === a.environmentId && input.source.kind === a.kind && sourceAllowed(input.source, grant), "SCOPE_DENIED");
  requireThat(grant.allowInternal || [...input.entities, ...input.evidence, ...input.assertions].every(r => r.privacy === "public"), "SCOPE_DENIED");
}
function recordDiff<T>(before: readonly T[], after: readonly T[], key: (r: T) => string): MappingRecordChange<T>[] {
  const old = new Map(before.map(r => [key(r), r])), next = new Map(after.map(r => [key(r), r]));
  const keys = [...new Set([...old.keys(), ...next.keys()])].sort(rawOrder);
  const result: MappingRecordChange<T>[] = [];
  for (const id of keys) {
    const a = old.get(id), b = next.get(id);
    if (a === undefined && b !== undefined) result.push({ kind: "added", id, before: null, after: b as DeepReadonly<T> });
    else if (a !== undefined && b === undefined) result.push({ kind: "retired", id, before: a as DeepReadonly<T>, after: null });
    else if (!same(a, b)) result.push({ kind: "changed", id, before: a as DeepReadonly<T>, after: b as DeepReadonly<T> });
  }
  return result;
}
/** Recompute against the complete original accepted state. Persisting/replaying
 * operations, foreign-source identity ownership and SQLite CAS belong to storage. */
export function transitionMapping(
  before: MappingBeforeState, scope: MappingScope, input: MappingImport, observations: MappingObservations
): MappingTransition {
  const rawScope = obj(data(scope), ["grant", "authority", "grantFingerprint"]);
  let grant: ImpactGrant;
  try { grant = validateGrant(rawScope.grant); } catch { return deny("SCOPE_DENIED"); }
  const a = authority(rawScope.authority);
  requireThat(hex(rawScope.grantFingerprint) === grantFingerprint(grant), "CONFIG_CHANGED");
  requireThat(grant.projectId === a.projectId && grant.siteIds.includes(a.siteId) && grant.environmentIds.includes(a.environmentId) &&
    (grant.allowInternal || a.minimumClassification === "public"), "SCOPE_DENIED");
  const original = prior(before), proposed = normalizeMappingImport(input);
  requireThat(same(original.authority, a), "SCOPE_DENIED");
  authorizedImport(proposed.input, grant, a);
  if (original.acceptedImport) authorizedImport(original.acceptedImport, grant, a);
  const oldRows = original.acceptedMapping?.mappings ?? [], oldBindings = original.acceptedMapping?.evidenceBindings ?? [];
  requireThat(grant.allowInternal || [...oldRows, ...proposed.mappings].every(r => r.classification === "public"), "SCOPE_DENIED");
  requireThat(grant.allowInternal || oldBindings.every(b => b.evidence.privacy === "public"), "SCOPE_DENIED");
  for (const r of [...oldRows, ...proposed.mappings]) {
    requireThat(r.target.projectId === a.nativeProjectId && r.target.storeUuid === a.nativeStoreUuid, "SCOPE_DENIED");
  }
  const obs = obj(data(observations), ["source", "native"]); limit(obs, MAPPING_LIMITS.observationBytes);
  const sourceRaw = obj(obs.source, ["sourceId", "authorityFingerprint", "revision", "digest", "classification", "checkedAt", "fingerprint"]);
  const nativeRaw = obj(obs.native, ["schema", "projectId", "storeUuid", "revision", "authorityFingerprint", "targets", "checkedAt", "fingerprint"]);
  const { checkedAt: sourceTime, fingerprint: sourceHash, ...sourceFields } = sourceRaw;
  const { checkedAt: nativeTime, fingerprint: nativeHash, ...nativeFields } = nativeRaw;
  const source = sourceObservation(sourceFields), native = nativeObservation(nativeFields);
  const checkedAt = date(sourceTime); date(nativeTime);
  requireThat(hex(sourceHash) === mappingSourceFingerprint(source) && hex(nativeHash) === mappingNativeFingerprint(native));
  requireThat(source.sourceId === a.sourceId && source.authorityFingerprint === a.sourceAuthorityFingerprint, "SOURCE_UNAVAILABLE");
  requireThat(native.projectId === a.nativeProjectId && native.storeUuid === a.nativeStoreUuid &&
    native.authorityFingerprint === a.nativeAuthorityFingerprint, "NATIVE_UNAVAILABLE");
  requireThat(grant.allowInternal || source.classification === "public", "SOURCE_UNAVAILABLE");
  const desired = new Map(proposed.mappings.map(r => [r.mappingId, r]));
  for (const r of oldRows) if (!desired.has(r.mappingId)) desired.set(r.mappingId, { ...r, state: "retired" });
  requireThat(desired.size <= 2000, "BUDGET_EXCEEDED");
  const rows = [...desired.values()].sort((x, y) => rawOrder(x.mappingId, y.mappingId));
  const required = new Map([...oldRows, ...rows].map(r => [targetKey(r.target), r.target]));
  const observed = new Map(native.targets.map(t => [targetKey(t.target), t]));
  requireThat(observed.size === required.size && [...required.keys()].every(k => observed.has(k)) &&
    (grant.allowInternal || native.targets.every(t => t.effectiveClassification === "public")), "NATIVE_UNAVAILABLE");
  // Endpoint/authority denial precedes stale version or private identity comparisons.
  requireThat(source.revision === proposed.input.source.revision && source.digest === proposed.input.source.digest, "SOURCE_CHANGED");
  requireThat(Date.parse(proposed.input.source.capturedAt) <= Date.parse(checkedAt) + 60000 &&
    proposed.input.evidence.every(e => Date.parse(e.capturedAt) <= Date.parse(checkedAt) + 60000 &&
      (!e.observedAt || Date.parse(e.observedAt) <= Date.parse(e.capturedAt))));
  requireThat(proposed.expectedAcceptedVersion === (original.acceptedMapping?.mappingVersion ?? null), "VERSION_CONFLICT");
  requireThat(proposed.mappingVersion !== original.acceptedMapping?.mappingVersion, "VERSION_CONFLICT");
  requireThat(original.graphRevision < Number.MAX_SAFE_INTEGER, "BUDGET_EXCEEDED");
  const batchId = "mapping-" + createHash("sha256").update("lmti.impact.mapping.batch.v1\n" + proposed.payloadDigest, "utf8").digest("hex");
  const identities = new Map(original.identities.map(r => [r.mappingId, r]));
  const previous = new Map(oldRows.map(r => [r.mappingId, r]));
  const oldKeysById = new Map<string, Set<string>>();
  const ownersByKey = new Map<string, MappingKeyReservation[]>();
  for (const key of original.keys) {
    const owner = identities.get(key.mappingId);
    requireThat(owner && key.sourceId === a.sourceId && owner.sourceId === a.sourceId && key.generation === owner.generation, "OWNER_UNAVAILABLE");
    if (!oldKeysById.has(key.mappingId)) oldKeysById.set(key.mappingId, new Set());
    oldKeysById.get(key.mappingId)!.add(key.key);
    if (!ownersByKey.has(key.key)) ownersByKey.set(key.key, []);
    ownersByKey.get(key.key)!.push(key);
  }
  for (const r of original.identities) requireThat(r.sourceId === a.sourceId &&
    r.target.projectId === a.projectId && r.target.storeUuid === a.nativeStoreUuid, "OWNER_UNAVAILABLE");
  for (const r of oldRows) {
    const reserved = identities.get(r.mappingId);
    requireThat(reserved && reserved.generation === r.generation && same(reserved.target, r.target) &&
      (r.state !== "active" || reserved.retiredBatchId === null), "OWNER_UNAVAILABLE");
    requireThat([r.externalKey, ...r.aliases].every(k => oldKeysById.get(r.mappingId)?.has(k)), "OWNER_UNAVAILABLE");
  }
  const bindings: MappingEvidenceBinding[] = [];
  const submittedIds = new Set(proposed.mappings.map(r => r.mappingId));
  const oldBindingsById = new Map<string, MappingEvidenceBinding[]>();
  for (const b of oldBindings) {
    if (!oldBindingsById.has(b.mappingId)) oldBindingsById.set(b.mappingId, []);
    oldBindingsById.get(b.mappingId)!.push(b);
  }
  const currentEvidence = new Map(proposed.input.evidence.map(e => [e.id, e]));
  const currentEntities = new Map(proposed.input.entities.map(e => [e.id, e]));
  for (const r of rows) {
    if (submittedIds.has(r.mappingId)) {
      for (const evidenceId of r.evidenceIds) bindings.push({ mappingId: r.mappingId, evidenceId, evidenceBatchId: batchId, evidence: currentEvidence.get(evidenceId)! });
    } else bindings.push(...(oldBindingsById.get(r.mappingId) ?? []));
  }
  bindings.sort((x, y) => rawOrder(bindingKey(x), bindingKey(y)));
  const byMapping = new Map<string, MappingEvidenceBinding[]>();
  for (const b of bindings) { if (!byMapping.has(b.mappingId)) byMapping.set(b.mappingId, []); byMapping.get(b.mappingId)!.push(b); }
  const reserveIdentities: MappingIdentityReservation[] = [], reserveKeys: MappingKeyReservation[] = [], retireOnAccept: string[] = [];
  const replacements: Array<{ oldMappingId: string; newMappingId: string }> = [];
  const replaced = new Set<string>(), activeKeys = new Map<string, string>();
  for (const r of rows) {
    const reserved = identities.get(r.mappingId), old = previous.get(r.mappingId), endpoint = observed.get(targetKey(r.target))!;
    const proof = byMapping.get(r.mappingId) ?? [];
    requireThat(same(proof.map(b => b.evidenceId).sort(rawOrder), [...r.evidenceIds].sort(rawOrder)), "OWNER_UNAVAILABLE");
    const linked = r.impactEntityId === null ? undefined : currentEntities.get(r.impactEntityId);
    const evidenceEntityPrivacy = proof.flatMap(b => b.evidenceBatchId === batchId && b.evidence.entityId
      ? [currentEntities.get(b.evidence.entityId)?.privacy] : []);
    const floorInternal = [a.minimumClassification, source.classification, proposed.input.source.privacy,
      endpoint.effectiveClassification, old?.classification, linked?.privacy,
      ...proof.map(b => b.evidence.privacy), ...evidenceEntityPrivacy].includes("internal");
    requireThat(!floorInternal || r.classification === "internal", "SCOPE_DENIED");
    if (r.kind === "code" || r.kind === "document") requireThat(r.referenceFingerprint === endpoint.referenceFingerprint, "NATIVE_CHANGED");
    if (reserved) {
      requireThat(reserved.generation === r.generation && same(reserved.target, r.target), "IDENTITY_CONFLICT");
      requireThat(reserved.retiredBatchId === null || r.state === "retired", "IDENTITY_CONFLICT");
      requireThat(!old || old.state !== "retired" || r.state === "retired", "IDENTITY_CONFLICT");
    } else {
      requireThat(r.state === "active", "IDENTITY_CONFLICT");
      reserveIdentities.push({ mappingId: r.mappingId, sourceId: a.sourceId, generation: r.generation,
        target: r.target, createdBatchId: batchId, retiredBatchId: null });
    }
    const desiredKeys = new Set([r.externalKey, ...r.aliases]);
    requireThat([...(oldKeysById.get(r.mappingId) ?? [])].every(k => desiredKeys.has(k)), "IDENTITY_CONFLICT");
    if (r.replacesMappingId !== null && r.replacesMappingId !== old?.replacesMappingId) {
      const replacedRow = previous.get(r.replacesMappingId), replacedIdentity = identities.get(r.replacesMappingId);
      requireThat(replacedRow && replacedIdentity && r.state === "active" &&
        replacedRow.generation !== r.generation && !same(replacedIdentity.target, r.target) &&
        desired.get(replacedRow.mappingId)?.state === "retired" && !replaced.has(replacedRow.mappingId), "IDENTITY_CONFLICT");
      requireThat([...desiredKeys].some(k => oldKeysById.get(replacedRow.mappingId)?.has(k)), "IDENTITY_CONFLICT");
      replaced.add(replacedRow.mappingId); replacements.push({ oldMappingId: replacedRow.mappingId, newMappingId: r.mappingId });
    } else if (old) requireThat(r.replacesMappingId === old.replacesMappingId, "IDENTITY_CONFLICT");
    for (const key of desiredKeys) {
      const owners = ownersByKey.get(key) ?? [];
      const sameGeneration = owners.find(k => k.generation === r.generation);
      requireThat(!sameGeneration || sameGeneration.mappingId === r.mappingId, "IDENTITY_CONFLICT");
      const different = owners.filter(k => k.mappingId !== r.mappingId);
      if (r.state === "active" && different.length) {
        const replacementOwner = r.replacesMappingId === null ? undefined : previous.get(r.replacesMappingId);
        requireThat(replacementOwner && oldKeysById.get(replacementOwner.mappingId)?.has(key) &&
          different.every(k => desired.get(k.mappingId)?.state === "retired" || identities.get(k.mappingId)?.retiredBatchId !== null), "IDENTITY_CONFLICT");
      }
      if (!sameGeneration) reserveKeys.push({ sourceId: a.sourceId, key, generation: r.generation, mappingId: r.mappingId });
      if (r.state === "active") {
        requireThat(!activeKeys.has(key) || activeKeys.get(key) === r.mappingId, "IDENTITY_CONFLICT");
        activeKeys.set(key, r.mappingId);
      }
    }
    if (r.state === "retired" && reserved?.retiredBatchId === null) retireOnAccept.push(r.mappingId);
  }
  reserveKeys.sort((x, y) => rawOrder(canonicalMappingJson([x.key, x.generation, x.mappingId]), canonicalMappingJson([y.key, y.generation, y.mappingId])));
  retireOnAccept.sort(rawOrder); replacements.sort((x, y) => rawOrder(x.oldMappingId, y.oldMappingId));
  const cap = original.capacity;
  requireThat(cap.versions + 1 <= 1000 && cap.operations + 1 <= 2500 && cap.identities + reserveIdentities.length <= 20000 &&
    cap.keys + reserveKeys.length <= 40000, "BUDGET_EXCEEDED");
  const oldInput = original.acceptedImport;
  const diff: MappingDiff = {
    source: { before: oldInput?.source ?? null, after: proposed.input.source },
    entities: recordDiff<ImpactEntity>(oldInput?.entities as readonly ImpactEntity[] ?? [], proposed.input.entities as readonly ImpactEntity[], r => r.id),
    evidence: recordDiff<ImpactEvidence>(oldInput?.evidence as readonly ImpactEvidence[] ?? [], proposed.input.evidence as readonly ImpactEvidence[], r => r.id),
    assertions: recordDiff<ImpactAssertion>(oldInput?.assertions as readonly ImpactAssertion[] ?? [], proposed.input.assertions as readonly ImpactAssertion[], r => r.id),
    mappings: recordDiff<MappingRow>(oldRows, rows, r => r.mappingId),
    mappingEvidence: recordDiff<MappingEvidenceBinding>(oldBindings, bindings, bindingKey),
    reservedKeys: reserveKeys, retireMappingIds: retireOnAccept, replacements
  };
  requireThat(!same(diff.source.before, diff.source.after) || diff.entities.length || diff.evidence.length ||
    diff.assertions.length || diff.mappings.length, "VERSION_CONFLICT");
  const candidate: MappingVersionSnapshot = {
    batchId, mappingVersion: proposed.mappingVersion, payloadDigest: proposed.payloadDigest,
    input: proposed.input, mappings: rows, evidenceBindings: bindings
  };
  // Both the submitted complete import and reconstructed complete reviewed state
  // must fit. Historical retirement evidence is not silently truncated.
  limit(candidate, MAPPING_LIMITS.importBytes); limit(diff, MAPPING_LIMITS.reviewBytes);
  return freeze({ candidate, diff, diffDigest: hash("lmti.impact.mapping.diff.v1", diff),
    reserveIdentities, reserveKeys, retireOnAccept, evidenceBindings: bindings });
}

/** Mapping-only normalized read seams; legacy validators and hash domains remain unchanged. */
export function normalizeMappingSourceImport(value: unknown): DeepReadonly<ImpactImport> {
  return freeze(legacy(safeInput(value)));
}
export function normalizeMappingSourceAuthority(value: unknown): MappingSourceAuthority {
  return freeze(authority(safeInput(value)));
}
export function normalizeMappingVersionSnapshot(value: unknown): MappingVersionSnapshot {
  return freeze(snapshot(safeInput(value)));
}
