import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type ImpactGrant, type ImpactImport } from "../src/model.js";
import {
  MappingError, mappingPayloadDigest, type MappingImport, type MappingNativeObservation,
  type MappingObservationRequest, type MappingRow, type MappingSourceAuthority,
  type MappingWriteOutcome,
} from "../src/mapping.js";
import { createImpactMappingOperator } from "../src/mapping-owner.js";
import {
  createImpactMappingReader, mappingCurrentFingerprint, mappingReadAuthorityFingerprint,
  mappingSourceContentFingerprint, MAPPING_READ_LIMITS,
  type MappingReader, type MappingReaderConfig, type MappingReadObservers, type MappingSourceReadRequest,
  type MappingNativeReadRequest,
} from "../src/mapping-read.js";
import {
  initializeImpactStore, importImpactSnapshot, reviewImpactImport,
  recordImpactSourceStatus, readImpactSnapshot,
} from "../src/store.js";

// Actual LMIP transactions and persisted owner lifecycle. Source/native callbacks
// here are independently framed controlled observations, not native process proof.
const NOW = "2026-10-20T04:00:00.000Z", PROJECT = "reader-project";
const UUID = "f0d4d6ce-df72-44dd-a8f5-0c56bf83f504";
const roots: string[] = [];
const readers: MappingReader[] = [];
const releases: Array<() => void> = [];
function sha(value: string | Buffer) { return createHash("sha256").update(value).digest("hex"); }
function json(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(json).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().map(k => `${JSON.stringify(k)}:${json(o[k])}`).join(",")}}`;
  }
  const result = JSON.stringify(value); if (result === undefined) throw new Error("Non-data fixture");
  return result;
}
function temp() {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), "lmti-mapping-read-test-"));
  roots.push(root); return root;
}
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const reader of readers.splice(0)) await reader.waitForIdle();
  vi.useRealTimers();
  for (const root of roots.splice(0)) {
    const real = realpathSync(root), relative = path.relative(realpathSync(tmpdir()), real);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative) ||
        lstatSync(root).isSymbolicLink() || !path.basename(real).startsWith("lmti-mapping-read-test-"))
      throw new Error("Unsafe fixture cleanup");
    rmSync(real, { recursive: true, force: true });
  }
});
function dbRead<T>(file: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return fn(db); } finally { db.close(); }
}
function edit(file: string, fn: (db: DatabaseSync) => void) {
  const db = new DatabaseSync(file); try { fn(db); } finally { db.close(); }
}
function revision(file: string) { return dbRead(file, db => Number(db.prepare("SELECT revision FROM metadata WHERE id=1").get()!.revision)); }
function files(root: string) {
  return Object.fromEntries(readdirSync(root).sort().map(name => {
    const file = path.join(root, name);
    if (!lstatSync(file).isFile()) throw new Error("Unexpected fixture entry");
    return [name, sha(readFileSync(file))];
  }));
}
function confirm(outcome: MappingWriteOutcome) {
  expect(outcome.outcome).toBe("confirmed");
  if (outcome.outcome !== "confirmed") throw new Error("Fixture owner refused");
  return outcome.receipt;
}
async function refuses(run: () => Promise<unknown>, code: string) {
  try { await run(); throw new Error("Expected refusal"); }
  catch (error) { expect(error).toBeInstanceOf(MappingError); expect((error as MappingError).code).toBe(code); }
}
function authority(kind: "manifest" | "native" = "manifest"): MappingSourceAuthority {
  return { sourceId: "source-a", projectId: PROJECT, siteId: "site-a", environmentId: "test", kind,
    minimumClassification: "public", sourceAuthorityFingerprint: sha("fixed source"),
    nativeProjectId: PROJECT, nativeStoreUuid: UUID, nativeAuthorityFingerprint: sha("fixed native"), policyVersion: "one" };
}
function source(kind: "manifest" | "native" = "manifest"): ImpactImport {
  return { schema: "lmti.impact.import.v1",
    source: { id: "source-a", projectId: PROJECT, siteId: "site-a", environmentId: "test", kind,
      revision: "source-one", digest: sha("source bytes"), privacy: "public", capturedAt: NOW, parserVersion: "fixture-one", complete: true },
    entities: [{ id: "entity-a", sourceKey: "entity-a", kind: "service", label: "Source entity", ownerRole: "Fixture", privacy: "public" }],
    evidence: [{ id: "proof-a", entityId: "entity-a", locator: "source.json#entity-a", summary: "Fixture declaration.", privacy: "public", capturedAt: NOW }],
    assertions: [] };
}
function row(id = randomUUID()): MappingRow {
  return { mappingId: id, kind: "identity", externalKey: id, generation: "one", aliases: [], state: "active",
    classification: "public", evidenceIds: ["proof-a"], impactEntityId: "entity-a", replacesMappingId: null,
    target: { projectId: PROJECT, storeUuid: UUID, kind: "component", id: "component-a" } };
}
function imported(input: ImpactImport, mappings: readonly MappingRow[], version: string, prior: string | null): MappingImport {
  const value = { schema: "lmti.impact.mapping-import.v1" as const, input, mappings, mappingVersion: version, expectedAcceptedVersion: prior };
  return { ...value, payloadDigest: mappingPayloadDigest(value) };
}
function native(authority: MappingSourceAuthority, targets: MappingNativeReadRequest["targets"], rev = 1,
  classification: "public" | "internal" = "public", time = NOW): MappingNativeObservation {
  const fields = { schema: 2 as const, projectId: authority.nativeProjectId, storeUuid: authority.nativeStoreUuid,
    revision: rev, authorityFingerprint: authority.nativeAuthorityFingerprint,
    targets: targets.map(target => ({ target, effectiveClassification: classification,
      ancestryFingerprint: sha(`ancestry:${target.kind}:${target.id}`),
      referenceFingerprint: target.kind === "repository" || target.kind === "knowledge" ? sha(`reference:${target.id}`) : null,
      identityState: target.kind === "repository" || target.kind === "knowledge" ? "present_reference" as const : "active" as const })) };
  return { ...fields, checkedAt: time, fingerprint: sha("lmti.impact.mapping.native-observation.v1\n" + json(fields)) };
}
function observedSource(a: MappingSourceAuthority, input: ImpactImport, time = NOW) {
  const fields = { sourceId: a.sourceId, authorityFingerprint: a.sourceAuthorityFingerprint,
    revision: input.source.revision, digest: input.source.digest, classification: input.source.privacy };
  return { ...fields, checkedAt: time, fingerprint: sha("lmti.impact.mapping.source-observation.v1\n" + json(fields)) };
}
async function fixture(options: { kind?: "manifest" | "native"; input?: ImpactImport; rows?: MappingRow[]; accept?: boolean } = {}) {
  const root = temp(), file = path.join(root, "impact.sqlite"), a = authority(options.kind);
  const input = options.input ?? source(options.kind), mappings = options.rows ?? [row()];
  const grant: ImpactGrant = { principalId: "fixture-reader", projectId: PROJECT, siteIds: ["site-a"], environmentIds: ["test"], allowInternal: true, policyVersion: "one" };
  initializeImpactStore(file);
  const owner = createImpactMappingOperator({ storePath: file, grant, authorities: [a], clock: () => NOW,
    maintenance: { capabilityId: "fixture-format", policyVersion: "one", backupPath: path.join(root, "backup.sqlite") },
    observers: { authorize() {}, async observe(r: MappingObservationRequest) {
      return { source: observedSource(a, { ...input, source: { ...input.source, revision: r.sourceRevision, digest: r.sourceDigest } }),
        native: native(a, r.targets) };
    } } });
  confirm(owner.upgradeMappings(owner.inspectMappingFormat(), randomUUID()));
  confirm(owner.registerSource(a.sourceId, revision(file), randomUUID()));
  async function stage(value: MappingImport) { return confirm(await owner.stageComplete(value, revision(file), randomUUID())); }
  async function accept(value: MappingImport) {
    const staged = await stage(value); return confirm(await owner.decide(await owner.preview(staged.batchId!), "accept", randomUUID()));
  }
  if (options.accept !== false) await accept(imported(input, mappings, "version-one", null));
  const pins = owner.inspectMappingFormat();
  const calls: Array<MappingSourceReadRequest | MappingNativeReadRequest> = [];
  const state = { input, nativeRevision: 9, nativeClass: "public" as "public" | "internal", authorized: true, now: NOW };
  const observers: MappingReadObservers = {
    async source(request, context) {
      expect(context.timeoutMilliseconds).toBe(40000); expect(context.signal).toBeInstanceOf(AbortSignal);
      calls.push(request);
      return { observation: observedSource(a, state.input, state.now),
        contentFingerprint: sha("lmti.impact.mapping.source-content.v1\n" + json(state.input)) };
    },
    async native(request, context) {
      expect(context.timeoutMilliseconds).toBe(40000); expect(context.signal).toBeInstanceOf(AbortSignal);
      calls.push(request); return native(a, request.targets, state.nativeRevision, state.nativeClass, state.now);
    },
  };
  const config: MappingReaderConfig = { storePath: file, storeUuid: pins.storeUuid!, sourceIdentityDigest: pins.sourceIdentityDigest,
    grant, authorities: [a], observers, authorize() { if (!state.authorized) throw new MappingError("SCOPE_DENIED"); },
    clock: () => state.now };
  return { root, file, a, input, mappings, grant, owner, pins, stage, accept, calls, state, config,
    reader: (change: Partial<MappingReaderConfig> = {}) => {
      const reader = createImpactMappingReader({ ...config, ...change }); readers.push(reader); return reader;
    } };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; }); releases.push(resolve); return { promise, resolve };
}

describe("accepted-current mapping reader: actual LMIP with controlled observations", () => {
  it("returns current active evidence, not staging columns, and changes no files", async () => {
    const f = await fixture(), before = files(f.root), reader = f.reader();
    const result = await reader.readCurrent({ sourceId: "source-a" });
    expect(Object.keys(result).sort()).toEqual(["schema","storeUuid","graphRevision","sourceId","grantFingerprint",
      "authorityFingerprint","accepted","source","sourceObservation","sourceContentFingerprint","nativeObservation",
      "mappings","evidenceBindings","complete","checkedAt","fingerprint"].sort());
    expect(result.nativeObservation.revision).toBe(9); // Stage/accept observed revision 1.
    expect(result.mappings.map(r => r.mapping.mappingId)).toEqual([f.mappings[0].mappingId]);
    expect(result.evidenceBindings).toHaveLength(1);
    expect(result.evidenceBindings[0].evidenceBatchId).toBe(result.accepted.batchId);
    expect(result.accepted.reviewedAt).toBe(NOW);
    expect(result.authorityFingerprint).toBe(mappingReadAuthorityFingerprint(f.a));
    expect(result.sourceContentFingerprint).toBe(mappingSourceContentFingerprint(f.input));
    const { fingerprint, ...content } = result;
    expect(fingerprint).toBe(mappingCurrentFingerprint(content));
    expect(f.calls.map(r => [("acceptedImport" in r) ? "source" : "native", r.pass]).sort())
      .toEqual([["native",1],["native",2],["source",1],["source",2]].sort());
    expect(f.calls.filter((r): r is MappingNativeReadRequest => "targets" in r).every(r => r.allowInternal === true)).toBe(true);
    expect(reader.isIdle()).toBe(true); expect(files(f.root)).toEqual(before);
  });
  it("keeps an accepted mapping while an unchanged-source candidate is pending or rejected", async () => {
    const f = await fixture(), changed = { ...f.mappings[0], aliases: ["new-alias"] };
    const pending = await f.stage(imported(f.input, [changed], "version-two", "version-one"));
    expect((await f.reader().readCurrent({ sourceId: "source-a" })).mappings[0].mapping.aliases).toEqual([]);
    confirm(await f.owner.decide(await f.owner.preview(pending.batchId!), "reject", randomUUID()));
    expect((await f.reader().readCurrent({ sourceId: "source-a" })).accepted.mappingVersion).toBe("version-one");
  });
  it("observes active endpoints only and distinguishes a complete retired source from unavailable", async () => {
    const f = await fixture();
    await f.accept(imported(f.input, [], "version-two", "version-one"));
    const before = files(f.root), result = await f.reader().readCurrent({ sourceId: "source-a" });
    expect(result.complete).toBe(true); expect(result.mappings).toEqual([]); expect(result.evidenceBindings).toEqual([]);
    const nativeCalls = f.calls.filter((r): r is MappingNativeReadRequest => "targets" in r);
    expect(nativeCalls).toHaveLength(2); expect(nativeCalls.every(r => r.targets.length === 0)).toBe(true);
    expect(files(f.root)).toEqual(before);
    recordImpactSourceStatus(f.file, "source-a", "unavailable", { expectedRevision: revision(f.file), actor: "fixture" });
    await refuses(() => f.reader().readCurrent({ sourceId: "source-a" }), "SOURCE_UNAVAILABLE");
  });
  it("rejects changed full source content even with an unchanged declared revision and digest", async () => {
    const f = await fixture(); f.state.input = structuredClone(f.input); f.state.input.entities[0].label = "Dirty content";
    expect(f.state.input.source).toEqual(f.input.source);
    await refuses(() => f.reader().readCurrent({ sourceId: "source-a" }), "SOURCE_CHANGED");
  });
  it("enforces accepted and stricter current-head age ceilings independently", async () => {
    const old = source(); old.source.maxAgeSeconds = 5;
    const f = await fixture({ input: old }); f.state.now = "2026-10-20T04:00:10.000Z";
    await refuses(() => f.reader().readCurrent({ sourceId: "source-a" }), "SOURCE_CHANGED");
    const g = await fixture(), shorter = structuredClone(g.input); shorter.source.maxAgeSeconds = 5;
    await g.stage(imported(shorter, g.mappings, "version-two", "version-one"));
    g.state.now = "2026-10-20T04:00:10.000Z";
    expect(shorter.source.revision).toBe(g.input.source.revision); expect(shorter.source.digest).toBe(g.input.source.digest);
    await refuses(() => g.reader().readCurrent({ sourceId: "source-a" }), "SOURCE_CHANGED");
  });
  it("elevates current native privacy and withholds a complete source from a Public-only reader", async () => {
    const f = await fixture();
    const publicResult = await f.reader({ grant: { ...f.grant, allowInternal: false } }).readCurrent({ sourceId: "source-a" });
    expect(publicResult.mappings[0].effectiveClassification).toBe("public");
    expect(f.calls.filter((r): r is MappingNativeReadRequest => "targets" in r).every(r => r.allowInternal === false)).toBe(true);
    f.state.nativeClass = "internal";
    const result = await f.reader().readCurrent({ sourceId: "source-a" });
    expect(result.mappings[0].mapping.classification).toBe("public");
    expect(result.mappings[0].effectiveClassification).toBe("internal");
    await refuses(() => f.reader({ grant: { ...f.grant, allowInternal: false } }).readCurrent({ sourceId: "source-a" }), "NATIVE_UNAVAILABLE");
  });
  it("retains evidence-associated entity privacy even when the mapping has no linked entity", async () => {
    const input = source(); input.entities[0].privacy = "internal";
    const mapping: MappingRow = { ...row(), classification: "internal", impactEntityId: null };
    const f = await fixture({ input, rows: [mapping] });
    expect((await f.reader().readCurrent({ sourceId: "source-a" })).mappings[0].effectiveClassification).toBe("internal");
    await refuses(() => f.reader({ grant: { ...f.grant, allowInternal: false } }).readCurrent({ sourceId: "source-a" }), "SOURCE_UNAVAILABLE");
  });
  it("withholds a complete source when a referenced foreign endpoint's current head becomes Internal", async () => {
    const input = source();
    input.assertions = [{ id: "calls-foreign", subjectId: "entity-a", predicate: "calls", objectId: "foreign-entity",
      basis: "desired", polarity: "supports", evidenceIds: ["proof-a"], applicableChanges: ["code"], privacy: "public" }];
    const f = await fixture({ input, accept: false });
    const foreign: ImpactImport = { schema: "lmti.impact.import.v1",
      source: { ...input.source, id: "source-b", revision: "foreign-one", digest: sha("foreign one") },
      entities: [{ ...input.entities[0], id: "foreign-entity", sourceKey: "foreign-entity" }],
      evidence: [{ ...input.evidence[0], id: "foreign-proof", entityId: "foreign-entity" }], assertions: [] };
    const foreignBatch = importImpactSnapshot(f.file, foreign, { expectedRevision: revision(f.file), actor: "fixture", now: NOW });
    reviewImpactImport(f.file, foreignBatch.batchId, { decision: "accept", expectedRevision: revision(f.file),
      reviewer: "fixture", evidenceReviewed: true, grant: f.grant, now: NOW });
    await f.accept(imported(input, f.mappings, "version-one", null));
    const reader = f.reader({ grant: { ...f.grant, allowInternal: false } });
    expect((await reader.readCurrent({ sourceId: "source-a" })).complete).toBe(true);
    const changed = structuredClone(foreign);
    changed.source = { ...changed.source, revision: "foreign-two", digest: sha("foreign two"), privacy: "internal" };
    importImpactSnapshot(f.file, changed, { expectedRevision: revision(f.file), actor: "fixture", now: NOW });
    // The accepted foreign entity stays Public. Only its fresh source head
    // changes, so checking the accepted endpoint alone would disclose source A.
    const head = dbRead(f.file, db => db.prepare("SELECT accepted_batch_id,latest_batch_id FROM sources WHERE id=?").get("source-b")!);
    expect(head.accepted_batch_id).toBe(foreignBatch.batchId);
    expect(head.latest_batch_id).not.toBe(foreignBatch.batchId);
    const before = files(f.root), calls = f.calls.length;
    await refuses(() => reader.readCurrent({ sourceId: "source-a" }), "SOURCE_UNAVAILABLE");
    expect(f.calls.length).toBe(calls); expect(files(f.root)).toEqual(before);
  });
  it("refuses reference drift without treating new ancestry alone as a historical mismatch", async () => {
    const r = row();
    const code: MappingRow = { ...r, kind: "code", selection: "src/a.ts", referenceFingerprint: sha("reference:repository-a"),
      target: { ...r.target, kind: "repository", id: "repository-a" } };
    const f = await fixture({ rows: [code] }), original = f.config.observers.native;
    const changed: MappingReadObservers = { ...f.config.observers, async native(request, context) {
      const result = await original(request, context), fields = { ...result, targets: result.targets.map(t => ({ ...t, referenceFingerprint: sha("changed reference") })) };
      const { checkedAt, fingerprint: _hash, ...stable } = fields;
      return { ...stable, checkedAt, fingerprint: sha("lmti.impact.mapping.native-observation.v1\n" + json(stable)) };
    } };
    await refuses(() => f.reader({ observers: changed }).readCurrent({ sourceId: "source-a" }), "NATIVE_CHANGED");
  });
  it("refuses unavailable and native-kind sources before calling either observer", async () => {
    const f = await fixture({ accept: false });
    for (const sourceId of ["source-a", "unknown"]) await refuses(() => f.reader().readCurrent({ sourceId }), "SOURCE_UNAVAILABLE");
    expect(f.calls).toEqual([]);
    const g = await fixture({ kind: "native" });
    await refuses(() => g.reader().readCurrent({ sourceId: "source-a" }), "UNSUPPORTED_MAPPING"); expect(g.calls).toEqual([]);
  });
  it("refuses a changed accepted snapshot during the first observation and performs no retry", async () => {
    const f = await fixture(), started = deferred(), release = deferred(), original = f.config.observers.source;
    const reader = f.reader({ observers: { ...f.config.observers, async source(r, c) {
      if (r.pass === 1) { started.resolve(); await release.promise; } return original(r, c);
    } } });
    const pending = reader.readCurrent({ sourceId: "source-a" }); await started.promise;
    const next = { ...f.mappings[0], aliases: ["approved-alias"] };
    await f.accept(imported(f.input, [next], "version-two", "version-one")); release.resolve();
    await refuses(() => pending, "CONFIG_CHANGED");
    expect(f.calls.filter(r => r.pass === 2)).toEqual([]);
    expect((await f.reader().readCurrent({ sourceId: "source-a" })).mappings[0].mapping.aliases).toEqual(["approved-alias"]);
  });
  it("detects source and native changes between the two observation passes", async () => {
    for (const kind of ["source", "native"] as const) {
      const f = await fixture(), original = f.config.observers[kind];
      const reader = f.reader({ observers: { ...f.config.observers, [kind]: async (r: never, c: never) => {
        const value = await original(r, c);
        if ((r as MappingSourceReadRequest).pass === 1) {
          if (kind === "source") { f.state.input = structuredClone(f.input); f.state.input.entities[0].label = "Changed after first sample"; }
          else f.state.nativeRevision += 1;
        }
        return value;
      } } as MappingReadObservers });
      await refuses(() => reader.readCurrent({ sourceId: "source-a" }), kind === "source" ? "SOURCE_CHANGED" : "NATIVE_CHANGED");
    }
  });
  it("latches authorization revocation across waits and refuses later reads before observers", async () => {
    const f = await fixture(), started = deferred(), release = deferred(), original = f.config.observers.source;
    const reader = f.reader({ observers: { ...f.config.observers, async source(r, c) {
      started.resolve(); await release.promise; return original(r, c);
    } } });
    const pending = reader.readCurrent({ sourceId: "source-a" }); await started.promise; f.state.authorized = false; release.resolve();
    await refuses(() => pending, "SCOPE_DENIED"); f.state.authorized = true; const calls = f.calls.length;
    await refuses(() => reader.readCurrent({ sourceId: "source-a" }), "SCOPE_DENIED"); expect(f.calls.length).toBe(calls);
  });
  it("retains BUSY after caller cancellation until both controlled workers actually settle", async () => {
    const f = await fixture(), started = deferred(), release = deferred(), controller = new AbortController();
    const old = f.config.observers.source, reader = f.reader({ observers: { ...f.config.observers, async source(r, c) {
      started.resolve(); await release.promise; return old(r, c);
    } } });
    const pending = reader.readCurrent({ sourceId: "source-a" }, { signal: controller.signal });
    await started.promise; controller.abort(); await refuses(() => pending, "OWNER_UNAVAILABLE");
    expect(reader.isIdle()).toBe(false);
    await refuses(() => reader.readCurrent({ sourceId: "source-a" }), "BUSY");
    let drained = false; const drain = reader.waitForIdle().then(() => { drained = true; });
    await Promise.resolve(); expect(drained).toBe(false); release.resolve(); await drain;
    expect(reader.isIdle()).toBe(true);
  });
  it("bounds observation timeout without releasing an unsettled worker or latching ordinary timeout as revocation", async () => {
    const f = await fixture(), started = deferred(), release = deferred(), old = f.config.observers.source;
    vi.useFakeTimers();
    const reader = f.reader({ observers: { ...f.config.observers, async source(r, c) {
      started.resolve(); await release.promise; return old(r, c);
    } } });
    const pending = reader.readCurrent({ sourceId: "source-a" }); const assertion = refuses(() => pending, "OWNER_UNAVAILABLE");
    await started.promise; await vi.advanceTimersByTimeAsync(40001); await assertion;
    expect(reader.isIdle()).toBe(false); release.resolve(); await reader.waitForIdle(); vi.useRealTimers();
    expect((await reader.readCurrent({ sourceId: "source-a" })).complete).toBe(true);
  });
  it("rejects copied-store physical replacement and old schemas without creating repair artifacts", async () => {
    const f = await fixture(), reader = f.reader(), moved = path.join(f.root, "retained.sqlite");
    // Both fixed paths are inside the verified test-owned directory; move one file only.
    const root = realpathSync(f.root);
    for (const file of [f.file, moved]) expect(path.dirname(path.resolve(file))).toBe(root);
    expect(lstatSync(f.file).isSymbolicLink()).toBe(false);
    renameSync(f.file, moved); copyFileSync(moved, f.file); const before = files(f.root);
    await refuses(() => reader.readCurrent({ sourceId: "source-a" }), "CONFIG_CHANGED");
    expect(f.calls).toEqual([]); expect(files(f.root)).toEqual(before);
    const legacyRoot = temp(), legacy = path.join(legacyRoot, "legacy.sqlite"); initializeImpactStore(legacy);
    const legacyBefore = files(legacyRoot);
    const stat = statSync(legacy, { bigint: true });
    const physical = sha("lmti.impact.mapping.file.v1\n" + json({ path: legacy,
      dev: stat.dev.toString(), ino: stat.ino.toString(), birthtimeNs: stat.birthtimeNs.toString() }));
    await refuses(() => f.reader({ storePath: legacy, sourceIdentityDigest: physical }).readCurrent({ sourceId: "source-a" }), "UNSUPPORTED_FORMAT");
    expect(files(legacyRoot)).toEqual(legacyBefore);
  });
  it("observes a real WAL current-head change without modifying or checkpointing the store", async () => {
    const f = await fixture(), writer = new DatabaseSync(f.file);
    try {
      writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; BEGIN IMMEDIATE");
      writer.prepare("UPDATE sources SET status='deleted' WHERE id=?").run("source-a");
      writer.exec("COMMIT");
      const main = readFileSync(f.file), wal = readFileSync(`${f.file}-wal`);
      await refuses(() => f.reader().readCurrent({ sourceId: "source-a" }), "SOURCE_UNAVAILABLE");
      expect(readFileSync(f.file)).toEqual(main); expect(readFileSync(`${f.file}-wal`)).toEqual(wal);
    } finally { writer.close(); }
  });
  it("strictly rejects malformed query/capability and broken persisted evidence without native disclosure", async () => {
    const f = await fixture(), reader = f.reader();
    for (const query of [{ sourceId: "source-a", path: f.file }, { sourceId: ["source-a"] }, { sourceId: "source-a\n" }, { sourceId: "" }])
      await refuses(() => reader.readCurrent(query as never), "INVALID_INPUT");
    for (const options of [{ path: f.file }, { signal: "fake" }, null])
      await refuses(() => reader.readCurrent({ sourceId: "source-a" }, options as never), "INVALID_INPUT");
    const missing = f.reader({ storePath: path.join(f.root, "never-created.sqlite") });
    await refuses(() => missing.readCurrent({ sourceId: "" }), "INVALID_INPUT");
    expect(readdirSync(f.root)).not.toContain("never-created.sqlite");
    expect(f.calls).toEqual([]);
    const tooMany = Array.from({ length: 201 }, (_, i) => ({ ...f.a, sourceId: `source-${i}` }));
    expect(() => f.reader({ authorities: tooMany })).toThrow();
    const oversized = source();
    oversized.evidence = Array.from({ length: 1500 }, (_, i) => ({ ...oversized.evidence[0],
      id: `large-proof-${i}`, summary: "界".repeat(1000) }));
    // Count and per-field sizes remain valid: this isolates the complete 4MiB
    // source-content budget rather than an unrelated row/string limit.
    expect(oversized.evidence.length).toBeLessThan(5000);
    expect(Buffer.byteLength(JSON.stringify(oversized))).toBeGreaterThan(MAPPING_READ_LIMITS.sourceDocumentBytes);
    expect(() => mappingSourceContentFingerprint(oversized)).toThrow("BUDGET_EXCEEDED");
    edit(f.file, db => { db.prepare("UPDATE evidence SET record_json=? WHERE id=?").run('{"id":"proof-a"}', "proof-a"); });
    await refuses(() => f.reader().readCurrent({ sourceId: "source-a" }), "OWNER_UNAVAILABLE"); expect(f.calls).toEqual([]);
  });
  it("keeps time out of stable fingerprints while binding accepted source and evidence times", async () => {
    const f = await fixture(), a = await f.reader().readCurrent({ sourceId: "source-a" });
    f.state.now = "2026-10-20T04:00:01.000Z"; const b = await f.reader().readCurrent({ sourceId: "source-a" });
    expect(a.checkedAt).not.toBe(b.checkedAt); expect(a.fingerprint).toBe(b.fingerprint);
    const { fingerprint: _hash, ...body } = b;
    const changed = { ...body, accepted: { ...body.accepted, reviewedAt: f.state.now } };
    expect(mappingCurrentFingerprint(changed)).not.toBe(a.fingerprint);
    expect(readImpactSnapshot(f.file, f.grant).entities).toHaveLength(1);
  });
  it("bounds an oversized persisted private capture before parsing rows or calling observers", async () => {
    const f = await fixture();
    // Controlled noncanonical storage fixture: JSON whitespace expands one
    // otherwise identical record. This exercises raw capture-byte admission,
    // not admission of a legal maximal owner-generated public result.
    const raw = JSON.stringify(f.input.evidence[0]) + " ".repeat(MAPPING_READ_LIMITS.captureBytes + 1);
    expect(JSON.parse(raw)).toEqual(f.input.evidence[0]);
    expect(Buffer.byteLength(raw)).toBeGreaterThan(4194304);
    edit(f.file, db => { db.prepare("UPDATE evidence SET record_json=? WHERE id=?").run(raw, "proof-a"); });
    const before = files(f.root);
    await refuses(() => f.reader().readCurrent({ sourceId: "source-a" }), "BUDGET_EXCEEDED");
    expect(f.calls).toEqual([]); expect(files(f.root)).toEqual(before);
  });
});
