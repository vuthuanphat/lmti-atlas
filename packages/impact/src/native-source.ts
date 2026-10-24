import { digest, fail, identifier, textValue, timestamp, validateImport, type Classification, type ImpactImport, type Predicate } from "./model.js";

export const NATIVE_SOURCE_ADAPTER_VERSION = "lmti.native-project.adapter.1";
type Row = Record<string, string>;
export interface NativeProjectSnapshot {
  schema: "lmti.project.snapshot.v1"; projectId: string; revision: number; site: string;
  external: boolean; complete: true; semantics: "declared";
  components: Row[]; assets: Row[]; releases: Row[]; bindings: Row[]; dependencies: Row[]; connections: Row[];
}
const rowFields = {
  components: ["id", "label", "kind", "privacy"], assets: ["id", "label", "kind", "site", "privacy"],
  releases: ["id", "label", "componentId", "state", "privacy"],
  bindings: ["id", "assetId", "componentId", "desiredReleaseId", "privacy"],
  dependencies: ["id", "from", "to", "contract", "privacy"], connections: ["id", "from", "to", "protocol", "privacy"]
} as const;
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("NATIVE_SNAPSHOT_INVALID");
  const obj = value as Record<string, unknown>;
  if (Object.keys(obj).some(key => !keys.includes(key)) || keys.some(key => !(key in obj))) fail("NATIVE_SNAPSHOT_INVALID");
  return obj;
}
/** Validate the owner projection; never open or interpret native SQLite here. */
export function validateNativeProjectSnapshot(value: unknown): NativeProjectSnapshot {
  let encoded: string;
  try { encoded = JSON.stringify(value); } catch { fail("NATIVE_SNAPSHOT_INVALID"); }
  if (!encoded! || Buffer.byteLength(encoded!) > 4 * 1024 * 1024) fail("NATIVE_SNAPSHOT_SIZE_DENIED");
  const raw = object(value, ["schema", "projectId", "revision", "site", "external", "complete", "semantics", ...Object.keys(rowFields)]);
  if (raw.schema !== "lmti.project.snapshot.v1" || raw.complete !== true || raw.semantics !== "declared" || typeof raw.external !== "boolean" || !Number.isSafeInteger(raw.revision) || Number(raw.revision) < 1) fail("NATIVE_SNAPSHOT_INVALID");
  const result: NativeProjectSnapshot = { schema: raw.schema, projectId: identifier(raw.projectId), revision: Number(raw.revision), site: identifier(raw.site), external: raw.external, complete: true, semantics: "declared", components: [], assets: [], releases: [], bindings: [], dependencies: [], connections: [] };
  for (const key of Object.keys(rowFields) as Array<keyof typeof rowFields>) {
    const rows = raw[key];
    if (!Array.isArray(rows) || rows.length > (key === "connections" ? 50_000 : key === "assets" ? 10_000 : 2000)) fail("NATIVE_SNAPSHOT_SIZE_DENIED");
    result[key] = rows.map(value => {
      const row = object(value, rowFields[key]);
      const output: Row = {};
      for (const field of rowFields[key]) {
        if (field === "privacy") {
          if (!["public", "internal"].includes(String(row[field])) || (raw.external && row[field] !== "public")) fail("NATIVE_PRIVACY_DENIED");
          output[field] = String(row[field]);
        } else if (["id", "componentId", "assetId", "desiredReleaseId", "from", "to", "site"].includes(field)) output[field] = identifier(row[field]);
        else if (field === "contract" && row[field] === "") output[field] = "";
        else output[field] = textValue(row[field], field === "contract" ? 500 : 240);
      }
      return output;
    }).sort((a, b) => a.id.localeCompare(b.id));
    if (new Set(result[key].map(row => row.id)).size !== result[key].length) fail("NATIVE_DUPLICATE_ID");
  }
  const components = new Map(result.components.map(row => [row.id, row])), assets = new Map(result.assets.map(row => [row.id, row])), releases = new Map(result.releases.map(row => [row.id, row]));
  function referenced(row: Row, refs: Array<Row | undefined>) {
    if (refs.some(ref => !ref)) fail("NATIVE_REFERENCE_DENIED");
    if (row.privacy === "public" && refs.some(ref => ref!.privacy !== "public")) fail("NATIVE_PRIVACY_DENIED");
  }
  for (const asset of result.assets) if (asset.site !== result.site) fail("NATIVE_SCOPE_DENIED");
  for (const release of result.releases) referenced(release, [components.get(release.componentId)]);
  for (const binding of result.bindings) {
    referenced(binding, [assets.get(binding.assetId), components.get(binding.componentId), releases.get(binding.desiredReleaseId)]);
    if (releases.get(binding.desiredReleaseId)!.componentId !== binding.componentId) fail("NATIVE_REFERENCE_DENIED");
  }
  for (const edge of result.dependencies) { referenced(edge, [components.get(edge.from), components.get(edge.to)]); if (edge.from === edge.to) fail("NATIVE_REFERENCE_DENIED"); }
  for (const edge of result.connections) referenced(edge, [assets.get(edge.from), assets.get(edge.to)]);
  return result;
}
export function nativeSourceId(snapshot: Pick<NativeProjectSnapshot, "projectId" | "site" | "external">, environmentId: string): string {
  return `native-${digest([snapshot.projectId, snapshot.site, snapshot.external, identifier(environmentId)]).slice(0, 32)}`;
}
export function nativeEntityId(sourceId: string, category: "component" | "asset" | "binding", id: string): string {
  return `native-${category}-${digest([identifier(sourceId), identifier(id)]).slice(0, 32)}`;
}
/** Desired declarations only. Physical connections are deliberately not causal edges. */
export function compileNativeProjectSource(value: unknown, options: { environmentId: string; capturedAt: string }): { snapshot: ImpactImport; native: NativeProjectSnapshot; fingerprint: string; limits: string[] } {
  const native = validateNativeProjectSnapshot(value), environmentId = identifier(options.environmentId), capturedAt = timestamp(options.capturedAt);
  const fingerprint = digest({ adapter: NATIVE_SOURCE_ADAPTER_VERSION, native, environmentId });
  const sourceId = nativeSourceId(native, environmentId), id = (category: "component" | "asset" | "binding", value: string) => nativeEntityId(sourceId, category, value);
  // The native envelope intentionally omits root metadata. A local projection
  // can belong to an internal project even when it contains zero rows; only an
  // owner-approved external projection establishes public source classification.
  const privacy: Classification = native.external ? "public" : "internal";
  const snapshot: ImpactImport = { schema: "lmti.impact.import.v1", source: { id: sourceId, projectId: native.projectId, siteId: native.site, environmentId, privacy, kind: "native", revision: String(native.revision), digest: fingerprint, capturedAt, parserVersion: NATIVE_SOURCE_ADAPTER_VERSION, complete: true }, entities: [], evidence: [], assertions: [] };
  function evidence(key: string, summary: string, row: Row, entityId?: string): string {
    const evidenceId = `native-evidence-${digest([sourceId, key]).slice(0, 32)}`;
    snapshot.evidence.push({ id: evidenceId, locator: `native-project/${key}`, summary, capturedAt, privacy: row.privacy as Classification, ...(entityId ? { entityId } : {}) });
    return evidenceId;
  }
  for (const component of native.components) {
    const entityId = id("component", component.id);
    snapshot.entities.push({ id: entityId, sourceKey: `component:${component.id}`, kind: "service", label: component.label, ownerRole: "Project component owner", privacy: component.privacy as Classification });
    evidence(`component/${component.id}`, "Native owner declares this software component; implementation and runtime state are not observed.", component, entityId);
  }
  for (const asset of native.assets) {
    const entityId = id("asset", asset.id);
    snapshot.entities.push({ id: entityId, sourceKey: `asset:${asset.id}`, kind: ["server", "gateway", "computer", "machine"].includes(asset.kind.toLowerCase()) ? "machine" : "device", label: asset.label, ownerRole: "Project asset owner", privacy: asset.privacy as Classification });
    evidence(`asset/${asset.id}`, "Native owner declares this asset in the selected site; availability and installed state remain unknown.", asset, entityId);
  }
  function assertion(row: Row, suffix: string, subjectId: string, predicate: Predicate, objectId: string, evidenceId: string) {
    snapshot.assertions.push({ id: `native-assertion-${digest([sourceId, suffix, row.id]).slice(0, 32)}`, subjectId, predicate, objectId, basis: "desired", polarity: "supports", evidenceIds: [evidenceId], applicableChanges: ["code", "contract", "config", "version", "availability", "unknown"], privacy: row.privacy as Classification, ...(row.contract ? { contract: row.contract } : {}) });
  }
  for (const binding of native.bindings) {
    const entityId = id("binding", binding.id);
    snapshot.entities.push({ id: entityId, sourceKey: `binding:${binding.id}`, kind: "deployment", label: `Desired deployment ${binding.id}`, ownerRole: "Project deployment owner", privacy: binding.privacy as Classification });
    const proof = evidence(`binding/${binding.id}`, `Desired binding references release ${binding.desiredReleaseId}. This is a desired declaration, not an observed installation or pinned deployed version.`, binding, entityId);
    assertion(binding, "instance_of", entityId, "instance_of", id("component", binding.componentId), proof);
    assertion(binding, "runs_on", entityId, "runs_on", id("asset", binding.assetId), proof);
  }
  for (const edge of native.dependencies) {
    const proof = evidence(`dependency/${edge.id}`, "Native owner declares a consumer-to-provider component dependency. Deployment routing and business workflow require separate reviewed evidence.", edge);
    assertion(edge, "depends_on", id("component", edge.from), "depends_on", id("component", edge.to), proof);
  }
  return { snapshot: validateImport(snapshot), native, fingerprint, limits: ["Declared architecture only; no observed deployments or device execution.", "Physical topology connections are not imported as causal dependencies.", "Component dependencies do not establish deployment routing or business workflow."] };
}
