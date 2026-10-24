import { createHash } from "node:crypto";
import { runEgressSecretScan } from "@atlas/privacy";

export const IMPACT_SCHEMA = "lmti.impact.import.v1" as const;
export const REPORT_SCHEMA = "lmti.impact.report.v1" as const;
export const RULES_VERSION = "lmti.impact.rules.1" as const;
export const ENTITY_KINDS = ["code_unit", "service", "deployment", "machine", "device", "datastore", "business_step"] as const;
export const PREDICATES = ["implemented_by", "instance_of", "runs_on", "depends_on", "calls", "reads_from", "writes_to", "uses"] as const;
export const CHANGE_CATEGORIES = ["code", "contract", "config", "version", "availability", "unknown"] as const;
export type EntityKind = typeof ENTITY_KINDS[number];
export type Predicate = typeof PREDICATES[number];
export type ChangeCategory = typeof CHANGE_CATEGORIES[number];
export type Classification = "public" | "internal";
export type Freshness = "fresh" | "stale" | "unknown";
export type AssertionBasis = "desired" | "observed" | "inferred";
export interface SourceDescriptor {
  id: string; projectId: string; siteId: string; environmentId: string;
  privacy: Classification; kind: "manifest" | "code" | "native";
  revision: string; digest: string; capturedAt: string; parserVersion: string;
  complete: true; maxAgeSeconds?: number;
}
export interface ImpactEntity {
  id: string; sourceKey: string; kind: EntityKind; label: string; ownerRole: string;
  privacy: Classification; version?: string;
}
export interface ImpactEvidence {
  id: string; locator: string; summary: string; capturedAt: string;
  observedAt?: string; entityId?: string; privacy: Classification;
}
export interface ImpactAssertion {
  id: string; subjectId: string; predicate: Predicate; objectId: string;
  basis: AssertionBasis; polarity: "supports" | "denies";
  evidenceIds: string[]; applicableChanges: ChangeCategory[];
  privacy: Classification; contract?: string;
}
export interface ImpactImport {
  schema: typeof IMPACT_SCHEMA; source: SourceDescriptor;
  entities: ImpactEntity[]; evidence: ImpactEvidence[]; assertions: ImpactAssertion[];
}
/** Only a trusted launcher/operator constructs grants. They are not tool arguments. */
export interface ImpactGrant {
  principalId: string; projectId: string; siteIds: string[]; environmentIds: string[];
  allowInternal: boolean; policyVersion: string;
}
/** Fresh owner observations, not client claims. Missing observations are unknown. */
export interface SourceCheck {
  sourceId: string; status: "available" | "deleted" | "unavailable";
  checkedAt: string; revision?: string; digest?: string;
}
export interface ChangeRequest {
  entityId: string; description: string; category: ChangeCategory;
  baselineRevision: string; proposedRevision?: string; diffDigest?: string;
  mode: "prospective" | "current-observed"; targetDeploymentIds: string[];
}
export interface ImpactBudgets {
  maxNodes?: number; maxEdges?: number; maxDepth?: number;
  maxFindings?: number; maxBytes?: number; maxMilliseconds?: number;
}
export interface SourceState {
  source: SourceDescriptor; batchId: string; reviewState: "accepted";
  reviewedAt: string; reviewer: string; headRevision: string; headDigest: string;
  headStatus: "available" | "deleted" | "unavailable";
}
export interface Owned<T> { record: T; sourceId: string; batchId: string; }
export interface ImpactSnapshot {
  schema: "lmti.impact.snapshot.v1"; graphRevision: number; grantFingerprint: string;
  sources: SourceState[]; entities: Owned<ImpactEntity>[];
  evidence: Owned<ImpactEvidence>[]; assertions: Owned<ImpactAssertion>[];
}
export interface PathStep {
  assertionId: string; fromId: string; toId: string; predicate: Predicate;
  sourceId: string; evidenceIds: string[]; basis: AssertionBasis;
  freshness: Freshness; conflict: boolean;
}
export interface ImpactFinding {
  entity: ImpactEntity; disposition: "potentially_affected" | "associated_context" | "unresolved";
  path: PathStep[]; reasons: string[]; conditionalOnDeployment: string[];
}
export interface VerificationTask {
  id: string; entityId?: string; assertionIds: string[]; reason: string;
  ownerRole: string; requiredEvidence: string; status: "pending";
}
export interface ImpactReport {
  schema: typeof REPORT_SCHEMA; id: string; createdAt: string; input: ChangeRequest;
  inputDigest: string; graphRevision: number; rulesVersion: string;
  budgets: Required<ImpactBudgets>;
  grantFingerprint: string; policyVersion: string; principalId: string;
  sourceVersions: Array<{sourceId: string; revision: string; digest: string; freshness: Freshness; reason: string; checkedAt?: string}>;
  freshnessCheckedAt: string; findings: ImpactFinding[]; checklist: VerificationTask[];
  unknowns: string[]; coverage: { traversal: "complete" | "incomplete"; knowledge: "not_proven_complete"; reasons: string[]; visitedNodes: number; examinedEdges: number; presentationTruncated: boolean };
  conclusion: string;
}
export interface ImportResult { batchId: string; graphRevision: number; idempotent: boolean; state: "pending" | "accepted" | "rejected"; delta: { added: string[]; changed: string[]; removed: string[] }; }
export class ImpactError extends Error {
  constructor(public readonly code: string) { super(code); this.name = "ImpactError"; }
}
export function fail(code: string): never { throw new ImpactError(code); }
export function digest(value: unknown): string { return createHash("sha256").update(stableJson(value)).digest("hex"); }
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("INVALID_INPUT");
  const obj = value as Record<string, unknown>;
  if (Object.keys(obj).some(key => !fields.includes(key))) fail("UNKNOWN_FIELD");
  return obj;
}
export function textValue(value: unknown, max = 512): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/u.test(value)) fail("INVALID_TEXT");
  return value;
}
export function identifier(value: unknown): string {
  const id = textValue(value, 100);
  if (!/^[A-Za-z][A-Za-z0-9._:-]*$/u.test(id)) fail("INVALID_ID");
  return id;
}
export function timestamp(value: unknown): string {
  const result = textValue(value, 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(result) || !Number.isFinite(Date.parse(result))) fail("INVALID_TIME");
  if (new Date(result).toISOString().replace(".000Z", "Z") !== result.replace(".000Z", "Z")) fail("INVALID_TIME");
  return result;
}
function hash(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) fail("INVALID_DIGEST");
  return value;
}
function enumeration<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T)) fail("INVALID_ENUM");
  return value as T;
}
function list<T>(value: unknown, convert: (item: unknown) => T, max: number, min = 0): T[] {
  if (!Array.isArray(value) || value.length > max || value.length < min) fail("INVALID_LIST");
  return value.map(convert);
}
function uniqueIds<T>(rows: T[], get: (row: T) => string) {
  if (new Set(rows.map(get)).size !== rows.length) fail("DUPLICATE_ID");
}
function classification(value: unknown): Classification { return enumeration(value, ["public", "internal"]); }
function safeMetadata(value: unknown) {
  let encoded: string;
  try { encoded = JSON.stringify(value); } catch { fail("INVALID_INPUT"); }
  if (!encoded! || Buffer.byteLength(encoded!) > 4 * 1024 * 1024) fail("INPUT_SIZE_DENIED");
  if (runEgressSecretScan(encoded!).blocked) fail("SENSITIVE_METADATA_DENIED");
}
function source(value: unknown): SourceDescriptor {
  const o = object(value, ["id", "projectId", "siteId", "environmentId", "privacy", "kind", "revision", "digest", "capturedAt", "parserVersion", "complete", "maxAgeSeconds"]);
  if (o.complete !== true) fail("INCOMPLETE_SOURCE_DENIED");
  const result: SourceDescriptor = { id: identifier(o.id), projectId: identifier(o.projectId), siteId: identifier(o.siteId), environmentId: identifier(o.environmentId), privacy: classification(o.privacy), kind: enumeration(o.kind, ["manifest", "code", "native"]), revision: textValue(o.revision, 160), digest: hash(o.digest), capturedAt: timestamp(o.capturedAt), parserVersion: textValue(o.parserVersion, 80), complete: true };
  if (o.maxAgeSeconds !== undefined) result.maxAgeSeconds = boundedInteger(o.maxAgeSeconds, 1, 31_536_000);
  return result;
}
export function boundedInteger(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) fail("INVALID_NUMBER");
  return value;
}
export function validateImport(value: unknown): ImpactImport {
  safeMetadata(value);
  const o = object(value, ["schema", "source", "entities", "evidence", "assertions"]);
  if (o.schema !== IMPACT_SCHEMA) fail("UNSUPPORTED_IMPORT_SCHEMA");
  const entities = list(o.entities, raw => {
    const e = object(raw, ["id", "sourceKey", "kind", "label", "ownerRole", "privacy", "version"]);
    const record: ImpactEntity = { id: identifier(e.id), sourceKey: textValue(e.sourceKey, 240), kind: enumeration(e.kind, ENTITY_KINDS), label: textValue(e.label, 240), ownerRole: textValue(e.ownerRole, 100), privacy: classification(e.privacy) };
    if (e.version !== undefined) record.version = textValue(e.version, 160);
    return record;
  }, 2000);
  const evidence = list(o.evidence, raw => {
    const e = object(raw, ["id", "locator", "summary", "capturedAt", "observedAt", "entityId", "privacy"]);
    const locator = textValue(e.locator, 512);
    if (locator.startsWith("/") || locator.startsWith("\\") || /^[a-z]+:/iu.test(locator) || locator.split(/[\\/]/u).some(s => s === "..") || locator.includes("\0")) fail("UNSAFE_LOCATOR");
    const record: ImpactEvidence = { id: identifier(e.id), locator, summary: textValue(e.summary, 2000), capturedAt: timestamp(e.capturedAt), privacy: classification(e.privacy) };
    if (e.observedAt !== undefined) record.observedAt = timestamp(e.observedAt);
    if (e.entityId !== undefined) record.entityId = identifier(e.entityId);
    return record;
  }, 5000);
  const assertions = list(o.assertions, raw => {
    const a = object(raw, ["id", "subjectId", "predicate", "objectId", "basis", "polarity", "evidenceIds", "applicableChanges", "privacy", "contract"]);
    const record: ImpactAssertion = { id: identifier(a.id), subjectId: identifier(a.subjectId), predicate: enumeration(a.predicate, PREDICATES), objectId: identifier(a.objectId), basis: enumeration(a.basis, ["desired", "observed", "inferred"]), polarity: enumeration(a.polarity, ["supports", "denies"]), evidenceIds: list(a.evidenceIds, identifier, 20, 1), applicableChanges: list(a.applicableChanges, v => enumeration(v, CHANGE_CATEGORIES), CHANGE_CATEGORIES.length, 1), privacy: classification(a.privacy) };
    uniqueIds(record.evidenceIds, v => v); uniqueIds(record.applicableChanges, v => v);
    if (a.contract !== undefined) record.contract = textValue(a.contract, 500);
    return record;
  }, 5000);
  uniqueIds(entities, e => e.id); uniqueIds(entities, e => e.sourceKey); uniqueIds(evidence, e => e.id); uniqueIds(assertions, a => a.id);
  const evidenceIds = new Set(evidence.map(e => e.id));
  const entityIds = new Set(entities.map(e => e.id));
  if (evidence.some(e => e.entityId !== undefined && !entityIds.has(e.entityId))) fail("EVIDENCE_ENTITY_REFERENCE_MISSING");
  if (assertions.some(a => a.evidenceIds.some(id => !evidenceIds.has(id)))) fail("EVIDENCE_REFERENCE_MISSING");
  return { schema: IMPACT_SCHEMA, source: source(o.source), entities, evidence, assertions };
}
export function validateGrant(value: unknown): ImpactGrant {
  const g = object(value, ["principalId", "projectId", "siteIds", "environmentIds", "allowInternal", "policyVersion"]);
  if (typeof g.allowInternal !== "boolean") fail("INVALID_GRANT");
  const result = { principalId: identifier(g.principalId), projectId: identifier(g.projectId), siteIds: list(g.siteIds, identifier, 30, 1), environmentIds: list(g.environmentIds, identifier, 30, 1), allowInternal: g.allowInternal, policyVersion: textValue(g.policyVersion, 160) };
  uniqueIds(result.siteIds, v => v); uniqueIds(result.environmentIds, v => v);
  return result;
}
export function grantFingerprint(grant: ImpactGrant): string { return digest({ ...grant, siteIds: [...grant.siteIds].sort(), environmentIds: [...grant.environmentIds].sort() }); }
export function sourceAllowed(source: SourceDescriptor, grant: ImpactGrant): boolean {
  return source.projectId === grant.projectId && grant.siteIds.includes(source.siteId) && grant.environmentIds.includes(source.environmentId) && (grant.allowInternal || source.privacy === "public");
}
export function recordAllowed(privacy: Classification, grant: ImpactGrant): boolean { return grant.allowInternal || privacy === "public"; }
export function validateChange(value: unknown): ChangeRequest {
  safeMetadata(value);
  const c = object(value, ["entityId", "description", "category", "baselineRevision", "proposedRevision", "diffDigest", "mode", "targetDeploymentIds"]);
  const result: ChangeRequest = { entityId: identifier(c.entityId), description: textValue(c.description, 2000), category: enumeration(c.category, CHANGE_CATEGORIES), baselineRevision: textValue(c.baselineRevision, 160), mode: enumeration(c.mode, ["prospective", "current-observed"]), targetDeploymentIds: list(c.targetDeploymentIds, identifier, 100) };
  uniqueIds(result.targetDeploymentIds, v => v);
  if (c.proposedRevision !== undefined) result.proposedRevision = textValue(c.proposedRevision, 160);
  if (c.diffDigest !== undefined) result.diffDigest = hash(c.diffDigest);
  return result;
}
export function validateSourceChecks(value: unknown): SourceCheck[] {
  const result = list(value, raw => {
    const c = object(raw, ["sourceId", "status", "checkedAt", "revision", "digest"]);
    const result: SourceCheck = { sourceId: identifier(c.sourceId), status: enumeration(c.status, ["available", "deleted", "unavailable"]), checkedAt: timestamp(c.checkedAt) };
    if (c.revision !== undefined) result.revision = textValue(c.revision, 160);
    if (c.digest !== undefined) result.digest = hash(c.digest);
    if (result.status === "available" && (!result.revision || !result.digest)) fail("INVALID_SOURCE_CHECK");
    return result;
  }, 200);
  uniqueIds(result, c => c.sourceId);
  return result;
}
export function validatePredicate(a: ImpactAssertion, entities: Map<string, ImpactEntity>) {
  const left = entities.get(a.subjectId), right = entities.get(a.objectId);
  if (!left || !right) fail("ENTITY_REFERENCE_MISSING");
  if (a.subjectId === a.objectId) fail("SELF_RELATION_DENIED");
  const valid = a.predicate === "implemented_by" ? left.kind === "service" && right.kind === "code_unit"
    : a.predicate === "instance_of" ? left.kind === "deployment" && right.kind === "service"
    : a.predicate === "runs_on" ? left.kind === "deployment" && ["machine", "device"].includes(right.kind)
    : a.predicate === "reads_from" || a.predicate === "writes_to" ? ["service", "deployment"].includes(left.kind) && right.kind === "datastore"
    : a.predicate === "calls" ? ["service", "deployment", "device"].includes(left.kind) && ["service", "deployment"].includes(right.kind)
    : a.predicate === "uses" ? ["service", "deployment"].includes(left.kind) && ["device", "datastore"].includes(right.kind)
    : ["service", "deployment", "device", "business_step"].includes(left.kind);
  if (!valid) fail("INVALID_RELATION_TYPES");
}
