import { afterEach, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  createImpactMappingOperator, createImpactMappingReader, initializeImpactStore,
  mappingPayloadDigest, mappingSourceContentFingerprint, MappingError,
  type ImpactImport, type ImpactGrant, type MappingImport, type MappingRow,
  type MappingSourceAuthority, type MappingWriteOutcome, type MappingReader,
} from "@atlas/impact";
import {
  createFixedMappingNativeObserver, mappingNativeAuthorityFingerprint,
} from "../src/impact-mapping-native.js";
import {
  createFixedMappingSourceObserver, mappingSourceAuthorityFingerprint,
} from "../src/impact-mapping-source.js";

// This suite requires the root-prepared, hash-pinned current native28 runtime.
// It never substitutes mocked native replies or direct native SQLite mutations.
const runtime = process.env.LMTI_MAPPING_CURRENT_NATIVE_RUNTIME;
const PROJECT = "factory-monitor", SITE = "factory-demo", NOW = "2026-10-20T04:00:00.000Z";
const roots: string[] = [];
const drains: Array<{ waitForIdle(): Promise<void> }> = [];
function sha(value: string | Buffer) { return createHash("sha256").update(value).digest("hex"); }
function ownedRoot() {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), "lmti-mapping-current-integration-"));
  roots.push(root); return root;
}
function tree(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const scan = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const entry = path.join(dir, name), st = lstatSync(entry);
      if (st.isSymbolicLink()) throw new Error("Unexpected fixture link");
      if (st.isDirectory()) scan(entry);
      else if (st.isFile()) result[path.relative(root, entry).replaceAll("\\", "/")] = sha(readFileSync(entry));
      else throw new Error("Unexpected fixture entry");
    }
  };
  scan(root); return result;
}
afterEach(async () => {
  for (const value of drains.splice(0)) await value.waitForIdle();
  for (const root of roots.splice(0)) {
    const real = realpathSync(root), relative = path.relative(realpathSync(tmpdir()), real);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || lstatSync(root).isSymbolicLink() ||
        !path.basename(real).startsWith("lmti-mapping-current-integration-"))
      throw new Error("Unsafe fixture cleanup");
    rmSync(real, { recursive: true, force: true });
  }
});
function binary(name: string): string {
  if (!runtime || !path.isAbsolute(runtime)) throw new Error("Current native runtime is required");
  const file = path.join(runtime, "bin", name);
  expect(lstatSync(file).isSymbolicLink()).toBe(false); expect(lstatSync(file).isFile()).toBe(true);
  return file;
}
function processEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP", "LANG"])
    if (process.env[key]) env[key] = process.env[key];
  env.PATH = path.join(runtime!, "bin") +
    (process.platform === "win32" && process.env.SystemRoot ? path.delimiter + path.join(process.env.SystemRoot, "System32") : "");
  env.QT_PLUGIN_PATH = path.join(runtime!, "plugins");
  return env;
}
function run(name: string, args: string[], request?: unknown) {
  const result = spawnSync(binary(name), args, { shell: false, windowsHide: true,
    cwd: path.join(runtime!, "bin"), env: processEnv(), timeout: 20000, maxBuffer: 4 * 1024 * 1024,
    input: request === undefined ? undefined : JSON.stringify(request) + "\n", encoding: "utf8" });
  expect(result.error).toBeUndefined(); expect(result.signal).toBeNull(); expect(result.status).toBe(0);
  return result.stdout;
}
function admin(nativeRoot: string, write: boolean, request: unknown): any {
  return JSON.parse(run("lmti-mcp-admin.exe",
    [write ? "--logical-hierarchy-write" : "--logical-hierarchy-read", "--library", path.join(nativeRoot, "library.sqlite"),
      "--project", PROJECT, "--visibility", "internal"], request));
}
function current(nativeRoot: string) {
  const value = admin(nativeRoot, false, { action: "logical-hierarchy-state" });
  expect(value.ok).toBe(true); return value;
}
function commit(nativeRoot: string, changes: unknown[]) {
  const state = current(nativeRoot);
  const preview = admin(nativeRoot, false, { action: "logical-hierarchy-preview",
    proposal: { projectId: PROJECT, expectedRevision: state.projectIdentity.revision, changes } });
  expect(preview.ok).toBe(true);
  const result = admin(nativeRoot, true, { action: "logical-hierarchy-commit", expected: preview.expected });
  expect(result).toMatchObject({ outcome: "confirmed", code: "NONE", detailsAvailable: true });
  return current(nativeRoot);
}
function confirmed(outcome: MappingWriteOutcome) {
  expect(outcome.outcome).toBe("confirmed");
  if (outcome.outcome !== "confirmed") throw new Error("Expected actual fixture owner confirmation");
  return outcome.receipt;
}
async function refused(run: () => Promise<unknown>, code: string) {
  try { await run(); throw new Error("Expected refusal"); }
  catch (error) { expect(error).toBeInstanceOf(MappingError); expect((error as MappingError).code).toBe(code); }
}
function importValue(input: ImpactImport, mappings: readonly MappingRow[], version: string, prior: string | null): MappingImport {
  const value = { schema: "lmti.impact.mapping-import.v1" as const, input, mappings, mappingVersion: version, expectedAcceptedVersion: prior };
  return { ...value, payloadDigest: mappingPayloadDigest(value) };
}
async function fixture(target: { kind: "component" | "subsystem"; id: string } = { kind: "component", id: "monitor-backend" }) {
  const root = ownedRoot(), nativeRoot = path.join(root, "native");
  mkdirSync(nativeRoot);
  run("lmti-mcp-binding-identity-tests.exe", ["--fixture", nativeRoot, "3", "2"]);
  if (target.kind === "subsystem") commit(nativeRoot, [{ kind: "add_subsystem",
    desired: { id: target.id, label: "Temporary native subsystem", parentSubsystemId: "", privacy: "internal" } }]);
  const initial = current(nativeRoot), database = path.join(nativeRoot, "project.sqlite");
  const nativeConfig = { schema: "lmti.impact.mapping-native.v1" as const, executable: binary("lmti-project.exe"),
    executableDigest: sha(readFileSync(binary("lmti-project.exe"))), database, projectId: PROJECT,
    storeUuid: initial.projectIdentity.storeUuid as string, siteId: SITE, environmentId: "test", visibility: "local" as const };
  const sourceConfig = { schema: "lmti.impact.mapping-source.v1" as const, sourceId: "source-a", projectId: PROJECT,
    siteId: SITE, environmentId: "test", root, descriptorFile: "source.json", parserVersion: "manifest-fixture-one",
    policyVersion: "one", kind: "manifest" as const, minimumClassification: "public" as const, allowInternal: true };
  const input: ImpactImport = { schema: "lmti.impact.import.v1",
    source: { id: "source-a", projectId: PROJECT, siteId: SITE, environmentId: "test", kind: "manifest", privacy: "public",
      revision: "one", digest: sha("manifest logical declaration"), capturedAt: NOW, parserVersion: "manifest-fixture-one", complete: true },
    entities: [{ id: "entity-a", sourceKey: "main", kind: "service", label: "Actual manifest fixture", ownerRole: "Fixture", privacy: "public" }],
    evidence: [{ id: "proof-a", entityId: "entity-a", locator: "source.json#entity-a", summary: "Controlled local declaration.", privacy: "public", capturedAt: NOW }],
    assertions: [] };
  writeFileSync(path.join(root, "source.json"), JSON.stringify(input));
  const a: MappingSourceAuthority = { sourceId: "source-a", projectId: PROJECT, siteId: SITE, environmentId: "test",
    kind: "manifest", minimumClassification: "public", sourceAuthorityFingerprint: mappingSourceAuthorityFingerprint(sourceConfig),
    nativeProjectId: PROJECT, nativeStoreUuid: nativeConfig.storeUuid,
    nativeAuthorityFingerprint: mappingNativeAuthorityFingerprint(nativeConfig), policyVersion: "one" };
  const grant: ImpactGrant = { principalId: "integration-reader", projectId: PROJECT, siteIds: [SITE],
    environmentIds: ["test"], allowInternal: true, policyVersion: "one" };
  let authorized = true;
  const fixedRuntime = { authorize() { if (!authorized) throw new MappingError("SCOPE_DENIED"); }, clock: () => NOW };
  const sourceObserver = createFixedMappingSourceObserver(sourceConfig, fixedRuntime);
  const nativeObserver = createFixedMappingNativeObserver(nativeConfig, fixedRuntime);
  drains.push(sourceObserver, nativeObserver);
  let sourceInput = input;
  const file = path.join(root, "impact.sqlite"); initializeImpactStore(file);
  const owner = createImpactMappingOperator({ storePath: file, grant, authorities: [a], clock: () => NOW,
    maintenance: { capabilityId: "fixture-format", policyVersion: "one", backupPath: path.join(root, "impact-backup.sqlite") },
    observers: { authorize: fixedRuntime.authorize, async observe(request) {
      const context = { signal: new AbortController().signal, timeoutMilliseconds: 40000 as const };
      const actualSource = await sourceObserver.observe({ phase: "current", pass: 1, authority: a,
        acceptedImport: sourceInput, expectedContentFingerprint: mappingSourceContentFingerprint(sourceInput) }, context);
      const actualNative = await nativeObserver.observe({ phase: "current", pass: 1, authority: a,
        targets: request.targets, allowInternal: true }, context);
      return { source: actualSource.observation, native: actualNative };
    } } });
  confirmed(owner.upgradeMappings(owner.inspectMappingFormat(), randomUUID()));
  confirmed(owner.registerSource("source-a", owner.inspectMappingFormat().graphRevision, randomUUID()));
  const mapping: MappingRow = { kind: "identity", mappingId: randomUUID(), externalKey: "main", generation: "one", aliases: [],
    state: "active", classification: target.kind === "subsystem" ? "internal" : "public", evidenceIds: ["proof-a"],
    impactEntityId: "entity-a", replacesMappingId: null,
    target: { projectId: PROJECT, storeUuid: nativeConfig.storeUuid, ...target } };
  async function accept(next: ImpactImport, version: string, prior: string | null) {
    sourceInput = next;
    const staged = confirmed(await owner.stageComplete(importValue(next, [mapping], version, prior),
      owner.inspectMappingFormat().graphRevision, randomUUID()));
    return confirmed(await owner.decide(await owner.preview(staged.batchId!), "accept", randomUUID()));
  }
  await accept(input, "version-one", null);
  const pins = owner.inspectMappingFormat();
  const reader: MappingReader = createImpactMappingReader({ storePath: file, storeUuid: pins.storeUuid!,
    sourceIdentityDigest: pins.sourceIdentityDigest, grant, authorities: [a], authorize: fixedRuntime.authorize,
    clock: () => NOW, observers: { source: sourceObserver.observe.bind(sourceObserver), native: nativeObserver.observe.bind(nativeObserver) } });
  drains.push(reader);
  return { root, nativeRoot, input, mapping, reader, owner, sourceConfig, nativeConfig, accept,
    revoke() { authorized = false; } };
}

// If the env is set, fixture/loader/process failures are failures, never skips.
// Root's reviewed runner sets this env and verifies all four case names unskipped.
describe.skipIf(!runtime)("current mappings: real LMIP + fixed manifest + native28", () => {
  it("serves a complete current read through actual owners and preserves all store/source bytes", async () => {
    const f = await fixture(), before = tree(f.root), result = await f.reader.readCurrent({ sourceId: "source-a" });
    expect(result.complete).toBe(true); expect(result.mappings).toHaveLength(1);
    expect(result.nativeObservation.targets[0].target.id).toBe("monitor-backend");
    expect(result.mappings[0].mapping.mappingId).toBe(f.mapping.mappingId);
    expect(result.evidenceBindings[0].evidenceBatchId).toBe(result.accepted.batchId);
    expect(tree(f.root)).toEqual(before);
    run("lmti-mcp-binding-identity-tests.exe", ["--mutate", f.nativeRoot, "replace-project"]);
    const replaced = tree(f.root);
    await refused(() => f.reader.readCurrent({ sourceId: "source-a" }), "NATIVE_CHANGED");
    expect(tree(f.root)).toEqual(replaced);
  }, 40000);
  it("uses fresh native revision and ancestor privacy after actual reviewed native commits", async () => {
    const f = await fixture(), first = await f.reader.readCurrent({ sourceId: "source-a" });
    const oldImpact = sha(readFileSync(path.join(f.root, "impact.sqlite")));
    let state = commit(f.nativeRoot, [{ kind: "add_subsystem",
      desired: { id: "internal-area", label: "Internal subsystem", parentSubsystemId: "", privacy: "internal" } }]);
    const newer = await f.reader.readCurrent({ sourceId: "source-a" });
    expect(newer.nativeObservation.revision).toBe(first.nativeObservation.revision + 1);
    expect(newer.mappings[0].mapping).toEqual(first.mappings[0].mapping);
    expect(newer.mappings[0].effectiveClassification).toBe("public");
    const component = state.projection.components.find((r: any) => r.value.id === "monitor-backend");
    state = commit(f.nativeRoot, [{ kind: "set_component_membership", expectedComponent: component.value,
      expected: component.membership, desiredSubsystemId: "internal-area" }]);
    const internal = await f.reader.readCurrent({ sourceId: "source-a" });
    expect(internal.nativeObservation.revision).toBe(state.projectIdentity.revision);
    expect(internal.mappings[0].effectiveClassification).toBe("internal");
    expect(internal.mappings[0].mapping.classification).toBe("public");
    expect(sha(readFileSync(path.join(f.root, "impact.sqlite")))).toBe(oldImpact);
  }, 40000);
  it("withholds edited manifest bytes then serves an explicitly accepted refresh under unchanged authority", async () => {
    const f = await fixture(), first = await f.reader.readCurrent({ sourceId: "source-a" });
    const changed = structuredClone(f.input); changed.entities[0].label = "Changed manifest declaration";
    writeFileSync(path.join(f.root, "source.json"), JSON.stringify(changed));
    const dirty = tree(f.root);
    await refused(() => f.reader.readCurrent({ sourceId: "source-a" }), "SOURCE_CHANGED");
    expect(tree(f.root)).toEqual(dirty);
    await f.accept(changed, "version-two", "version-one");
    const next = await f.reader.readCurrent({ sourceId: "source-a" });
    expect(next.accepted.mappingVersion).toBe("version-two");
    expect(next.authorityFingerprint).toBe(first.authorityFingerprint);
    expect(next.sourceContentFingerprint).not.toBe(first.sourceContentFingerprint);
    expect(next.sourceObservation.revision).toBe(first.sourceObservation.revision);
    expect(next.sourceObservation.digest).toBe(first.sourceObservation.digest);
  }, 40000);
  it("withholds a genuinely retired native endpoint without changing accepted history", async () => {
    const f = await fixture({ kind: "subsystem", id: "temporary-subsystem" });
    const first = await f.reader.readCurrent({ sourceId: "source-a" });
    const state = current(f.nativeRoot), subsystem = state.projection.subsystems.find((r: any) => r.value.id === "temporary-subsystem");
    commit(f.nativeRoot, [{ kind: "retire_empty_subsystem", expected: subsystem.value }]);
    const before = tree(f.root);
    await refused(() => f.reader.readCurrent({ sourceId: "source-a" }), "NATIVE_UNAVAILABLE");
    expect(tree(f.root)).toEqual(before);
    expect(f.owner.inspectMappingFormat().graphRevision).toBe(first.graphRevision);
  }, 40000);
});
