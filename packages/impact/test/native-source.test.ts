import { describe, expect, it } from "vitest";
import { compileNativeProjectSource, nativeEntityId, validateNativeProjectSnapshot } from "../src/native-source";

function fixture() {
  return { schema: "lmti.project.snapshot.v1", projectId: "project-one", revision: 1, site: "warehouse", external: true, complete: true, semantics: "declared",
    components: [{ id: "consumer", label: "Consumer", kind: "service", privacy: "public" }, { id: "provider", label: "Provider", kind: "service", privacy: "public" }],
    assets: [{ id: "gateway", label: "Gateway", kind: "gateway", site: "warehouse", privacy: "public" }, { id: "scanner", label: "Scanner", kind: "sensor", site: "warehouse", privacy: "public" }],
    releases: [{ id: "release-one", label: "1.0", componentId: "provider", state: "draft", privacy: "public" }],
    bindings: [{ id: "binding-one", assetId: "gateway", componentId: "provider", desiredReleaseId: "release-one", privacy: "public" }],
    dependencies: [{ id: "dependency-one", from: "consumer", to: "provider", contract: "Desired label contract", privacy: "public" }],
    connections: [{ id: "link-one", from: "gateway", to: "scanner", protocol: "ethernet", privacy: "public" }] };
}
const options = { environmentId: "development", capturedAt: "2026-10-13T00:00:00Z" };
describe("native owner snapshot impact adapter", () => {
  it("maps declared component dependencies and desired deployments without inferring topology causality or installed state", () => {
    const result = compileNativeProjectSource(fixture(), options), { snapshot } = result;
    expect(snapshot.source).toMatchObject({ kind: "native", projectId: "project-one", siteId: "warehouse", revision: "1" });
    expect(snapshot.entities.map(entity => entity.kind).sort()).toEqual(["deployment", "device", "machine", "service", "service"]);
    expect(snapshot.entities.find(entity => entity.kind === "deployment")?.version).toBeUndefined();
    expect(snapshot.assertions).toHaveLength(3);
    expect(snapshot.assertions.every(assertion => assertion.basis === "desired")).toBe(true);
    expect(snapshot.assertions.find(assertion => assertion.predicate === "depends_on")).toMatchObject({ subjectId: nativeEntityId(snapshot.source.id, "component", "consumer"), objectId: nativeEntityId(snapshot.source.id, "component", "provider") });
    const scanner = nativeEntityId(snapshot.source.id, "asset", "scanner");
    expect(snapshot.assertions.some(assertion => [assertion.subjectId, assertion.objectId].includes(scanner))).toBe(false);
    expect(result.limits.some(limit => limit.includes("Physical topology"))).toBe(true);
    expect(snapshot.evidence.every(evidence => !evidence.observedAt)).toBe(true);
  });
  it("normalizes order, fingerprints owner content and revision, and preserves identities across rename", () => {
    const before = compileNativeProjectSource(fixture(), options);
    const reordered = fixture(); reordered.components.reverse(); reordered.assets.reverse();
    expect(compileNativeProjectSource(reordered, options)).toEqual(before);
    const changed = fixture(); changed.components[0].label = "Renamed consumer"; changed.revision = 2;
    const after = compileNativeProjectSource(changed, options);
    expect(after.snapshot.entities.map(entity => entity.id)).toEqual(before.snapshot.entities.map(entity => entity.id));
    expect(after.fingerprint).not.toBe(before.fingerprint);
    expect(compileNativeProjectSource(fixture(), { ...options, capturedAt: "2026-10-13T00:01:00Z" }).fingerprint).toBe(before.fingerprint);
  });
  it("rejects scope, privacy, references and unexpected raw fields before creating an import", () => {
    const wrongSite = fixture(); wrongSite.assets[0].site = "other";
    expect(() => validateNativeProjectSnapshot(wrongSite)).toThrow("NATIVE_SCOPE_DENIED");
    const wrongPrivacy = fixture(); wrongPrivacy.components[0].privacy = "internal";
    expect(() => validateNativeProjectSnapshot(wrongPrivacy)).toThrow("NATIVE_PRIVACY_DENIED");
    const wrongRef = fixture(); wrongRef.bindings[0].assetId = "hidden";
    expect(() => validateNativeProjectSnapshot(wrongRef)).toThrow("NATIVE_REFERENCE_DENIED");
    const raw = fixture(); Object.assign(raw.assets[0], { config: "raw device configuration" });
    expect(() => validateNativeProjectSnapshot(raw)).toThrow("NATIVE_SNAPSHOT_INVALID");
    expect(() => validateNativeProjectSnapshot({ ...fixture(), semantics: "observed" })).toThrow("NATIVE_SNAPSHOT_INVALID");
    expect(() => validateNativeProjectSnapshot({ ...fixture(), complete: false })).toThrow("NATIVE_SNAPSHOT_INVALID");
  });
  it("does not promote internal parent evidence or confuse identical IDs across scopes", () => {
    const internal = fixture(); internal.external = false; internal.components[1].privacy = "internal";
    expect(() => validateNativeProjectSnapshot(internal)).toThrow("NATIVE_PRIVACY_DENIED");
    const first = compileNativeProjectSource(fixture(), options), second = compileNativeProjectSource({ ...fixture(), projectId: "other-project" }, options);
    expect(new Set([...first.snapshot.entities, ...second.snapshot.entities].map(entity => entity.id)).size).toBe(10);
    const emptyLocal = { ...fixture(), external: false, components: [], assets: [], releases: [], bindings: [], dependencies: [], connections: [] };
    expect(compileNativeProjectSource(emptyLocal, options).snapshot.source.privacy).toBe("internal");
  });
  it("rejects a snapshot that exceeds impact capacities instead of silently cutting candidates", () => {
    const large = fixture();
    large.assets = Array.from({ length: 2000 }, (_, index) => ({ id: `asset-${index}`, label: "Asset", kind: "sensor", site: "warehouse", privacy: "public" }));
    large.bindings = []; large.connections = [];
    expect(() => compileNativeProjectSource(large, options)).toThrow("INVALID_LIST");
  });
});
