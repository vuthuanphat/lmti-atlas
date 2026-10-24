import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type ImpactGrant, type ImpactImport, digest,
} from "../src/model.js";
import {
  MappingError, MAPPING_LIMITS, mappingPayloadDigest,
  type MappingImport, type MappingNativeObservation, type MappingObservationRequest,
  type MappingObservations, type MappingOperatorConfig,
  type MappingReceipt, type MappingRow, type MappingSourceAuthority,
  type MappingSourceObservation, type MappingWriteOutcome,
} from "../src/mapping.js";
import { createImpactMappingOperator } from "../src/mapping-owner.js";
import {
  initializeImpactStore, upgradeImpactStore, importImpactSnapshot,
  reviewImpactImport, readImpactSnapshot, readImpactImport, readImpactHistory,
  listImpactImports, listImpactReportSummaries,
} from "../src/store.js";
import { createSyntheticImpactDemo } from "../src/demo.js";
import { createImpactReport, saveImpactReport, loadImpactReport } from "../src/report.js";
import { createImpactReviewOperator } from "../src/review.js";

// Real LMIP/SQLite tests. Native/source observations below are typed fixture
// closures, not a claim that the native-reference transport has been integrated.
const NOW = "2026-10-20T04:00:00.000Z";
const PROJECT = "mapping-project";
const NATIVE_UUID = "e0d4d6ce-df72-44dd-a8f5-0c56bf83f504";
const OLD_TABLES = [
  "metadata", "sources", "imports", "entity_identity", "entity_keys", "entities",
  "evidence", "assertions", "history", "reports", "review_heads", "review_events",
] as const;
const MAPPING_TABLES = [
  "mapping_store_identity", "mapping_authorities", "mapping_versions",
  "mapping_identity", "mapping_keys", "mapping_rows", "mapping_evidence",
  "mapping_operations",
] as const;
const directories: string[] = [];
function temporary(): string {
  const directory = mkdtempSync(path.join(realpathSync(tmpdir()), "lmti-mapping-owner-test-"));
  directories.push(directory);
  return directory;
}
afterEach(() => {
  const parent = realpathSync(tmpdir());
  for (const directory of directories.splice(0)) {
    if (lstatSync(directory).isSymbolicLink()) throw new Error("Redirected fixture cleanup");
    const target = realpathSync(directory), relative = path.relative(parent, target);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative) ||
        !path.basename(target).startsWith("lmti-mapping-owner-test-"))
      throw new Error("Unexpected fixture cleanup path");
    rmSync(target, { recursive: true, force: true });
  }
});
function sha(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function dataJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(dataJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${dataJson(object[key])}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Non-data fixture value");
  return encoded;
}
function readDb<T>(filename: string, inspect: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(filename, { readOnly: true });
  try { return inspect(db); } finally { db.close(); }
}
function editDb(filename: string, edit: (db: DatabaseSync) => void): void {
  const db = new DatabaseSync(filename);
  try { edit(db); } finally { db.close(); }
}
function revision(filename: string): number {
  return readDb(filename, db => Number(db.prepare("SELECT revision FROM metadata WHERE id=1").get()!.revision));
}
function schema(filename: string): number {
  return readDb(filename, db => Number(db.prepare("PRAGMA user_version").get()!.user_version));
}
function rows(filename: string, table: typeof OLD_TABLES[number] | typeof MAPPING_TABLES[number]): string[] {
  return readDb(filename, db => db.prepare(`SELECT * FROM "${table}"`).all().map(dataJson).sort());
}
function owned(filename: string, includeMapping = true): unknown {
  return readDb(filename, db => {
    const catalog = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name").all();
    const present = new Set(catalog.filter(row => row.type === "table").map(row => String(row.name)));
    const result: Record<string, unknown> = {};
    for (const table of [...OLD_TABLES, ...(includeMapping ? MAPPING_TABLES : [])])
      if (present.has(table)) result[table] = db.prepare(`SELECT * FROM "${table}"`).all().map(dataJson).sort();
    return { application: db.prepare("PRAGMA application_id").get()!.application_id,
      schema: db.prepare("PRAGMA user_version").get()!.user_version, catalog: catalog.map(dataJson), rows: result };
  });
}
function oldRows(filename: string): Record<string, string[]> {
  return readDb(filename, db => {
    const names = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(row => String(row.name)));
    return Object.fromEntries(OLD_TABLES.filter(name => names.has(name))
      .map(name => [name, db.prepare(`SELECT * FROM "${name}"`).all().map(dataJson).sort()]));
  });
}
function confirmed(value: MappingWriteOutcome): MappingReceipt {
  expect(value.outcome).toBe("confirmed");
  if (value.outcome !== "confirmed") throw new Error("Expected a confirmed fixture write");
  expect(Buffer.byteLength(JSON.stringify(value.receipt))).toBeLessThanOrEqual(8192);
  return value.receipt;
}
function denied(run: () => unknown, code: string): void {
  try { run(); throw new Error("Expected mapping refusal"); }
  catch (error) {
    expect(error).toBeInstanceOf(MappingError);
    expect((error as MappingError).code).toBe(code);
    expect((error as Error).message).toBe(code);
  }
}
async function deniedAsync(run: () => Promise<unknown>, code: string): Promise<void> {
  try { await run(); throw new Error("Expected mapping refusal"); }
  catch (error) {
    expect(error).toBeInstanceOf(MappingError);
    expect((error as MappingError).code).toBe(code);
    expect((error as Error).message).toBe(code);
  }
}
function grant(): ImpactGrant {
  return { principalId: "mapping-reviewer", projectId: PROJECT, siteIds: ["site-a"],
    environmentIds: ["test"], allowInternal: true, policyVersion: "policy-one" };
}
function authority(sourceId = "source-a"): MappingSourceAuthority {
  return { sourceId, projectId: PROJECT, siteId: "site-a", environmentId: "test",
    kind: "manifest", minimumClassification: "public",
    sourceAuthorityFingerprint: sha(`fixed-source:${sourceId}`), nativeProjectId: PROJECT,
    nativeStoreUuid: NATIVE_UUID, nativeAuthorityFingerprint: sha("fixed-native"),
    policyVersion: "policy-one" };
}
function input(sourceId = "source-a", version = "source-revision-one"): ImpactImport {
  const service = `${sourceId}-service`, code = `${sourceId}-code`, evidence = `${sourceId}-evidence`;
  return {
    schema: "lmti.impact.import.v1",
    source: { id: sourceId, projectId: PROJECT, siteId: "site-a", environmentId: "test",
      privacy: "public", kind: "manifest", revision: version,
      digest: sha(`source-bytes:${sourceId}:${version}`), capturedAt: NOW,
      parserVersion: "fixture-one", complete: true },
    entities: [
      { id: service, sourceKey: "service:main", kind: "service", label: "Source service", ownerRole: "Fixture", privacy: "public" },
      { id: code, sourceKey: "code:main", kind: "code_unit", label: "Source code", ownerRole: "Fixture", privacy: "public" },
    ],
    evidence: [{ id: evidence, locator: "fixture/source.json#service", summary: "Fixture declaration only.",
      capturedAt: NOW, entityId: service, privacy: "public" }],
    assertions: [{ id: `${sourceId}-assertion`, subjectId: service, predicate: "implemented_by",
      objectId: code, basis: "desired", polarity: "supports", evidenceIds: [evidence],
      applicableChanges: ["code"], privacy: "public" }],
  };
}
function association(sourceId = "source-a", id = randomUUID()): Extract<MappingRow, { kind: "identity" }> {
  return { kind: "identity", mappingId: id, externalKey: "service:main", generation: "generation-one",
    aliases: [], classification: "public", evidenceIds: [`${sourceId}-evidence`],
    state: "active", impactEntityId: `${sourceId}-service`, replacesMappingId: null,
    target: { projectId: PROJECT, storeUuid: NATIVE_UUID, kind: "component", id: "component-a" } };
}
function imported(source: ImpactImport, mappings: readonly MappingRow[], version = "mapping-one",
  accepted: string | null = null): MappingImport {
  const value = { schema: "lmti.impact.mapping-import.v1" as const, input: source,
    expectedAcceptedVersion: accepted, mappingVersion: version, mappings };
  return { ...value, payloadDigest: mappingPayloadDigest(value) };
}
// Independently framed valid observations from the frozen mapping contract. These are not
// native endpoint readers and are never used as an independent native oracle.
function observations(request: MappingObservationRequest): MappingObservations {
  const sourceValue = {
    sourceId: request.authority.sourceId, authorityFingerprint: request.authority.sourceAuthorityFingerprint,
    revision: request.sourceRevision, digest: request.sourceDigest, classification: "public" as const,
  };
  const nativeValue = {
    schema: 2 as const, projectId: request.authority.nativeProjectId,
    storeUuid: request.authority.nativeStoreUuid, revision: 1,
    authorityFingerprint: request.authority.nativeAuthorityFingerprint,
    targets: request.targets.map(target => ({ target, effectiveClassification: "public" as const,
      ancestryFingerprint: sha(`ancestry:${target.kind}:${target.id}`),
      referenceFingerprint: target.kind === "repository" || target.kind === "knowledge" ? sha(`reference:${target.id}`) : null,
      identityState: target.kind === "repository" || target.kind === "knowledge" ? "present_reference" as const : "active" as const })),
  };
  return {
    source: { ...sourceValue, checkedAt: NOW,
      fingerprint: sha("lmti.impact.mapping.source-observation.v1\n" + dataJson(sourceValue)) },
    native: { ...nativeValue, checkedAt: NOW,
      fingerprint: sha("lmti.impact.mapping.native-observation.v1\n" + dataJson(nativeValue)) },
  };
}
interface Control {
  authorized: boolean;
  requests: MappingObservationRequest[];
  signals?: AbortSignal[];
  transform?: (value: MappingObservations, request: MappingObservationRequest) => MappingObservations;
  wait?: (request: MappingObservationRequest) => Promise<void>;
}
function configuration(filename: string, backup: string, control: Control,
  authorities: readonly MappingSourceAuthority[] = [authority()], suppliedGrant = grant()): MappingOperatorConfig {
  return { storePath: filename, grant: suppliedGrant, authorities, clock: () => NOW,
    maintenance: { capabilityId: "fixed-maintenance", policyVersion: "policy-one", backupPath: backup },
    observers: {
      authorize() { if (!control.authorized) throw new MappingError("SCOPE_DENIED"); },
      async observe(request, context) {
        expect(context.timeoutMilliseconds).toBe(30000);
        expect(context.signal).toBeInstanceOf(AbortSignal);
        control.requests.push(structuredClone(request));
        control.signals?.push(context.signal);
        await control.wait?.(request);
        const value = observations(request);
        return control.transform ? control.transform(value, request) : value;
      },
    },
  };
}
function fixture(upgrade = true, authorities: readonly MappingSourceAuthority[] = [authority()]) {
  const directory = temporary(), filename = path.join(directory, "impact.sqlite"),
    backup = path.join(directory, "format-two-backup.sqlite");
  initializeImpactStore(filename);
  const control: Control = { authorized: true, requests: [] };
  const config = configuration(filename, backup, control, authorities);
  const owner = createImpactMappingOperator(config);
  const protectedFiles = ["native-sentinel.sqlite", "memory-sentinel.sqlite", "source-sentinel.txt"]
    .map(name => path.join(directory, name));
  protectedFiles.forEach((file, index) => writeFileSync(file, `unopened independent fixture ${index}`));
  const protectedBytes = protectedFiles.map(file => readFileSync(file));
  const upgradeId = randomUUID();
  if (upgrade) confirmed(owner.upgradeMappings(owner.inspectMappingFormat(), upgradeId));
  return { directory, filename, backup, control, config, owner, upgradeId,
    assertProtected() { protectedFiles.forEach((file, index) => expect(readFileSync(file)).toEqual(protectedBytes[index])); } };
}
function enroll(f: ReturnType<typeof fixture>, sourceId = "source-a"): MappingReceipt {
  return confirmed(f.owner.registerSource(sourceId, revision(f.filename), randomUUID()));
}
async function accepted(f: ReturnType<typeof fixture>, value: MappingImport) {
  const staged = confirmed(await f.owner.stageComplete(value, revision(f.filename), randomUUID()));
  const review = await f.owner.preview(staged.batchId!);
  const receipt = confirmed(await f.owner.decide(review, "accept", randomUUID()));
  return { staged, review, receipt };
}
function rewriteObservation(value: MappingObservations,
  change: { source?: Partial<MappingSourceObservation>; native?: Partial<MappingNativeObservation> }): MappingObservations {
  const source = { ...value.source, ...change.source }, native = { ...value.native, ...change.native };
  const { fingerprint: _s, checkedAt: _sc, ...sourceStable } = source;
  const { fingerprint: _n, checkedAt: _nc, ...nativeStable } = native;
  return {
    source: { ...source, fingerprint: sha("lmti.impact.mapping.source-observation.v1\n" + dataJson(sourceStable)) },
    native: { ...native, fingerprint: sha("lmti.impact.mapping.native-observation.v1\n" + dataJson(nativeStable)) },
  };
}
function richLegacyFixture() {
  const directory = temporary(), filename = path.join(directory, "legacy.sqlite"),
    backup = path.join(directory, "legacy-format-two.sqlite");
  const demo = createSyntheticImpactDemo(NOW);
  initializeImpactStore(filename);
  for (const source of [...demo.foundation, demo.imports.A]) {
    const staged = importImpactSnapshot(filename, source, {
      expectedRevision: revision(filename), actor: "fixture-operator", now: NOW,
    });
    reviewImpactImport(filename, staged.batchId, { decision: "accept",
      expectedRevision: staged.graphRevision, reviewer: "fixture-reviewer", evidenceReviewed: true, now: NOW });
  }
  for (const [sourceId, reject] of [["legacy-rejected", true], ["legacy-pending", false]] as const) {
    const source = input(sourceId);
    Object.assign(source.source, { projectId: demo.grant.projectId,
      siteId: demo.grant.siteIds[0], environmentId: demo.grant.environmentIds[0] });
    const staged = importImpactSnapshot(filename, source, {
      expectedRevision: revision(filename), actor: "fixture-operator", now: NOW,
    });
    if (reject) reviewImpactImport(filename, staged.batchId, { decision: "reject",
      expectedRevision: staged.graphRevision, reviewer: "fixture-reviewer", evidenceReviewed: true, now: NOW });
  }
  const reportOptions = { freshness: demo.checks.A, now: NOW };
  const report = createImpactReport(filename, demo.grant, demo.change, reportOptions);
  saveImpactReport(filename, demo.grant, report, reportOptions);
  const reviewer = createImpactReviewOperator(filename, demo.grant, {
    reviewer: "fixture-reviewer", freshness: () => demo.checks.A, now: () => NOW,
  });
  const reviewRequest = { reportId: report.id, checklistId: report.checklist[0].id,
    status: "verified" as const, expectedGraphRevision: revision(filename), expectedReviewRevision: 0,
    evidenceSummary: "Independent fixture review.", evidenceRef: "checks/fixture.md#result" };
  reviewer.record(reviewRequest);
  reviewer.record({ ...reviewRequest, expectedReviewRevision: 1, status: "pending",
    evidenceSummary: undefined, evidenceRef: undefined });
  const control: Control = { authorized: true, requests: [] };
  const config = configuration(filename, backup, control, [], demo.grant);
  return { directory, filename, backup, demo, report, reportOptions, reviewer, reviewRequest,
    control, config, owner: createImpactMappingOperator(config) };
}
function legacyVersionOne(filename: string): void {
  editDb(filename, db => db.exec("DROP TRIGGER review_events_no_update; DROP TRIGGER review_events_no_delete; DROP TABLE review_events; DROP TABLE review_heads; PRAGMA user_version=1;"));
}

describe("reviewed mapping public owner over real SQLite", () => {
  it("requires separate maintenance and never implicitly upgrades or creates a missing store", async () => {
    const f = fixture(false), before = readFileSync(f.filename);
    const sourceOnly = createImpactMappingOperator({ ...f.config, maintenance: null });
    denied(() => sourceOnly.inspectMappingFormat(), "SCOPE_DENIED");
    denied(() => sourceOnly.upgradeMappings(f.owner.inspectMappingFormat(), randomUUID()), "SCOPE_DENIED");
    denied(() => f.owner.registerSource("source-a", 0, randomUUID()), "UNSUPPORTED_FORMAT");
    await deniedAsync(() => f.owner.stageComplete(imported(input(), [association()]), 0, randomUUID()), "UNSUPPORTED_FORMAT");
    expect(readFileSync(f.filename)).toEqual(before);
    expect(schema(f.filename)).toBe(2); expect(existsSync(f.backup)).toBe(false);
    const absent = path.join(f.directory, "missing.sqlite");
    expect(() => createImpactMappingOperator({ ...f.config, storePath: absent }).inspectMappingFormat()).toThrow(MappingError);
    expect(existsSync(absent)).toBe(false); f.assertProtected();
  });

  it("registers fixed source authority independently and atomically stages then accepts one full import", async () => {
    const f = fixture(), prior = revision(f.filename), registered = enroll(f);
    expect(registered.action).toBe("register_source");
    expect(registered.graphRevisionAfter).toBe(prior + 1);
    expect(listImpactImports(f.filename, grant())).toEqual([]);
    denied(() => f.owner.registerSource("not-configured", revision(f.filename), randomUUID()), "SCOPE_DENIED");
    const row = association(), value = imported(input(), [row]), before = revision(f.filename);
    const stageId = randomUUID(), staged = confirmed(await f.owner.stageComplete(value, before, stageId));
    expect(staged).toMatchObject({ action: "stage", decision: "pending", mappingVersion: "mapping-one",
      payloadDigest: value.payloadDigest, graphRevisionBefore: before, graphRevisionAfter: before + 1 });
    expect(readImpactSnapshot(f.filename, grant()).sources).toEqual([]);
    const review = await f.owner.preview(staged.batchId!);
    expect(review.diff.mappings).toEqual([{ kind: "added", id: row.mappingId, before: null, after: row }]);
    expect(review.diff.entities).toHaveLength(2); expect(review.diff.evidence).toHaveLength(1);
    expect(review.diff.assertions).toHaveLength(1);
    expect(review.diff.mappingEvidence).toEqual([{
      kind: "added", id: dataJson([row.mappingId, value.input.evidence[0].id]), before: null,
      after: { mappingId: row.mappingId, evidenceId: value.input.evidence[0].id,
        evidenceBatchId: staged.batchId, evidence: value.input.evidence[0] },
    }]);
    const result = confirmed(await f.owner.decide(review, "accept", randomUUID()));
    expect(result).toMatchObject({ action: "accept", decision: "accepted",
      graphRevisionBefore: staged.graphRevisionAfter, graphRevisionAfter: staged.graphRevisionAfter + 1 });
    expect(readImpactSnapshot(f.filename, grant()).sources[0].batchId).toBe(staged.batchId);
    expect(f.control.requests.map(request => request.phase)).toEqual(["stage", "preview", "accept"]);
    expect(f.owner.receipt(stageId)).toEqual(staged);
    f.assertProtected();
  });

  it("replays durable original receipts before stale graph CAS without allocating a new version receipt", async () => {
    const f = fixture(true, [authority(), authority("source-b")]); enroll(f);
    const value = imported(input(), [association()]), stageId = randomUUID(), expected = revision(f.filename);
    const staged = confirmed(await f.owner.stageComplete(value, expected, stageId));
    enroll(f, "source-b"); // Unrelated legitimate revision invalidates incoming CAS.
    const reopened = createImpactMappingOperator(f.config), before = owned(f.filename);
    const sameOperation = await reopened.stageComplete(value, expected, stageId);
    expect(sameOperation).toEqual({ outcome: "confirmed", receipt: staged, replayed: true });
    const unusedId = randomUUID(), sameVersion = await reopened.stageComplete(value, expected, unusedId);
    expect(sameVersion).toEqual({ outcome: "confirmed", receipt: staged, replayed: true });
    expect(reopened.receipt(stageId)).toEqual(staged);
    expect(reopened.receipt(unusedId)).toBeNull();
    expect(owned(f.filename)).toEqual(before);
    const changed = structuredClone(input()); changed.entities[0].label = "Changed mapping snapshot";
    await deniedAsync(() => reopened.stageComplete(imported(changed, value.mappings), expected, stageId), "VERSION_CONFLICT");
    expect(owned(f.filename)).toEqual(before); f.assertProtected();
  });

  it("authorizes persisted original scope before historical receipt lookup and exact replay", async () => {
    const f = fixture(), row = association(); enroll(f);
    const value = imported(input(), [row]), stageId = randomUUID(), expected = revision(f.filename);
    const staged = confirmed(await f.owner.stageComplete(value, expected, stageId)), before = owned(f.filename);
    for (const changed of [
      { ...grant(), principalId: "another-reviewer" }, { ...grant(), policyVersion: "revoked-policy" },
      { ...grant(), siteIds: ["other-site"] }, { ...grant(), environmentIds: ["other-environment"] },
    ]) {
      const narrowed = createImpactMappingOperator({ ...f.config, grant: changed });
      expect(narrowed.receipt(stageId)).toBeNull();
      expect(narrowed.receipt(randomUUID())).toBeNull();
      await deniedAsync(() => narrowed.stageComplete(value, expected, stageId), "SCOPE_DENIED");
    }
    f.control.authorized = false;
    denied(() => f.owner.receipt(stageId), "SCOPE_DENIED");
    await deniedAsync(() => f.owner.stageComplete(value, expected, stageId), "SCOPE_DENIED");
    f.control.authorized = true;
    expect(createImpactMappingOperator(f.config).receipt(stageId)).toEqual(staged);
    expect(owned(f.filename)).toEqual(before);
  });

  it("keeps a real writer reservation across the asynchronous observer and refuses operator reentry", async () => {
    const f = fixture(); enroll(f);
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    f.control.wait = async request => { if (request.phase === "stage") { enter(); await released; } };
    const promise = f.owner.stageComplete(imported(input(), [association()]), revision(f.filename), randomUUID());
    try {
      await Promise.race([entered, promise.then(() => { throw new Error("Write settled without the required observation"); })]);
      denied(() => f.owner.receipt(randomUUID()), "BUSY");
      await deniedAsync(() => f.owner.preview("batch-not-present"), "BUSY");
      const rival = new DatabaseSync(f.filename);
      try {
        rival.exec("PRAGMA busy_timeout=0");
        expect(() => rival.exec("BEGIN IMMEDIATE")).toThrow();
        expect(rival.prepare("SELECT revision FROM metadata").get()!.revision).toBe(revision(f.filename));
      } finally { rival.close(); }
    } finally { release(); await promise; }
    confirmed(await promise);
    expect(f.owner.receipt(randomUUID())).toBeNull();
  });

  it("rechecks authorization after a suspended observation before any staged reservation", async () => {
    const f = fixture(); enroll(f); const before = owned(f.filename);
    f.control.wait = async () => { f.control.authorized = false; };
    await deniedAsync(() => f.owner.stageComplete(imported(input(), [association()]), revision(f.filename), randomUUID()), "SCOPE_DENIED");
    f.control.authorized = true; delete f.control.wait;
    expect(owned(f.filename)).toEqual(before);
    confirmed(await f.owner.stageComplete(imported(input(), [association()]), revision(f.filename), randomUUID()));
  });

  it("rolls back a timed-out observer but keeps BUSY until the late worker settles and discards its result", async () => {
    const f = fixture(); enroll(f);
    const before = owned(f.filename), value = imported(input(), [association()]), operationId = randomUUID();
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    f.control.signals = [];
    f.control.wait = async request => { if (request.phase === "stage") { enter(); await released; } };
    vi.useFakeTimers();
    const result = f.owner.stageComplete(value, revision(f.filename), operationId)
      .then(value => ({ value, error: null }), error => ({ value: null, error }));
    try {
      await Promise.race([entered, result.then(() => { throw new Error("Owner settled without entering the observer"); })]);
      await vi.advanceTimersByTimeAsync(30000);
      const timedOut = await result;
      expect(timedOut.value).toBeNull();
      expect(timedOut.error).toBeInstanceOf(MappingError);
      expect((timedOut.error as MappingError).code).toBe("OWNER_UNAVAILABLE");
      expect(f.control.signals).toHaveLength(1);
      expect(f.control.signals[0].aborted).toBe(true);
      expect(owned(f.filename)).toEqual(before);
      denied(() => f.owner.receipt(operationId), "BUSY");
      await deniedAsync(() => f.owner.preview("not-a-batch"), "BUSY");
      const rival = new DatabaseSync(f.filename);
      try {
        rival.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
        expect(rival.prepare("SELECT revision FROM metadata").get()!.revision).toBe(revision(f.filename));
        rival.exec("ROLLBACK");
      } finally { rival.close(); }
      release();
      await vi.advanceTimersByTimeAsync(0); // Flush the late worker's promise chain.
      expect(f.control.requests).toHaveLength(1);
      expect(f.owner.receipt(operationId)).toBeNull();
      expect(owned(f.filename)).toEqual(before);
      delete f.control.wait;
      confirmed(await f.owner.stageComplete(value, revision(f.filename), randomUUID()));
      expect(f.control.requests).toHaveLength(2); // One separate deliberate retry.
    } finally {
      release();
      try { await vi.advanceTimersByTimeAsync(0); await result; }
      finally { vi.useRealTimers(); }
    }
  });

  it("captures trusted configuration and the complete request before an asynchronous callback can mutate caller objects", async () => {
    const f = fixture();
    const expectedAuthority = structuredClone(f.config.authorities[0]);
    const suppliedGrant = f.config.grant as ImpactGrant;
    const suppliedAuthority = f.config.authorities[0] as { nativeStoreUuid: string; sourceAuthorityFingerprint: string };
    suppliedGrant.projectId = "caller-mutated-project";
    suppliedGrant.siteIds.push("caller-added-site");
    suppliedAuthority.nativeStoreUuid = randomUUID();
    suppliedAuthority.sourceAuthorityFingerprint = sha("caller-mutated-authority");
    enroll(f);
    const source = input(), row = association(), originalRow = structuredClone(row);
    const value = imported(source, [row]), originalDigest = value.payloadDigest;
    f.control.wait = async request => {
      if (request.phase !== "stage") return;
      source.entities[0].label = "Caller changed label during observation";
      (row as { externalKey: string }).externalKey = "caller-changed-key";
    };
    const staged = confirmed(await f.owner.stageComplete(value, revision(f.filename), randomUUID()));
    delete f.control.wait;
    expect(staged.payloadDigest).toBe(originalDigest);
    const review = await f.owner.preview(staged.batchId!);
    expect(review.scope.authority).toEqual(expectedAuthority);
    expect(review.scope.principalId).toBe("mapping-reviewer");
    expect(review.diff.entities.find(change => change.id === "source-a-service")!.after!.label).toBe("Source service");
    expect(review.diff.mappings).toEqual([{ kind: "added", id: originalRow.mappingId, before: null, after: originalRow }]);
    expect(f.control.requests.every(request => request.authority.projectId === PROJECT &&
      request.authority.nativeStoreUuid === NATIVE_UUID)).toBe(true);
  });

  it("refuses fresh source/native drift during accept but permits authorized offline rejection", async () => {
    for (const changed of ["source", "native"] as const) {
      const f = fixture(); enroll(f);
      const staged = confirmed(await f.owner.stageComplete(imported(input(), [association()]), revision(f.filename), randomUUID()));
      const review = await f.owner.preview(staged.batchId!), before = owned(f.filename);
      f.control.transform = value => changed === "source"
        ? rewriteObservation(value, { source: { digest: sha("different source bytes, same revision") } })
        : rewriteObservation(value, { native: { revision: value.native.revision + 1 } });
      await deniedAsync(() => f.owner.decide(review, "accept", randomUUID()), changed === "source" ? "SOURCE_CHANGED" : "NATIVE_CHANGED");
      expect(owned(f.filename)).toEqual(before);
      f.control.wait = async () => { throw new MappingError("NATIVE_UNAVAILABLE"); };
      const calls = f.control.requests.length;
      const rejected = confirmed(await f.owner.decide(review, "reject", randomUUID()));
      expect(rejected.decision).toBe("rejected");
      expect(f.control.requests).toHaveLength(calls);
      expect(readImpactSnapshot(f.filename, grant()).sources).toEqual([]);
    }
  });

  it("enforces the effective classification floor even for an Internal-capable operator", async () => {
    for (const floor of ["native", "source", "evidence"] as const) {
      const f = fixture(); enroll(f); const before = owned(f.filename);
      const source = input();
      if (floor === "evidence") source.evidence[0].privacy = "internal";
      f.control.transform = value => floor === "native"
        ? rewriteObservation(value, { native: { targets: value.native.targets.map(target => ({ ...target, effectiveClassification: "internal" })) } })
        : floor === "source" ? rewriteObservation(value, { source: { classification: "internal" } }) : value;
      await deniedAsync(() => f.owner.stageComplete(imported(source, [association()]), revision(f.filename), randomUUID()), "SCOPE_DENIED");
      expect(owned(f.filename)).toEqual(before);
      const row = { ...association(), classification: "internal" as const };
      confirmed(await f.owner.stageComplete(imported(source, [row]), revision(f.filename), randomUUID()));
    }
  });

  it("authorizes complete candidate and prior assertion endpoints against foreign accepted source, record and current-head policy", async () => {
    for (const hiddenBy of ["source", "record", "current-head", "prior-accepted"] as const) {
      const f = fixture(); enroll(f);
      const publicGrant = { ...grant(), allowInternal: false };
      const owner = createImpactMappingOperator({ ...f.config, grant: publicGrant });
      const foreign = input("foreign-source");
      if (hiddenBy === "source") foreign.source.privacy = "internal";
      if (hiddenBy === "record") foreign.entities.find(entity => entity.kind === "code_unit")!.privacy = "internal";
      const foreignStage = importImpactSnapshot(f.filename, foreign, {
        expectedRevision: revision(f.filename), actor: "foreign-owner", now: NOW,
      });
      reviewImpactImport(f.filename, foreignStage.batchId, { decision: "accept",
        expectedRevision: foreignStage.graphRevision, reviewer: "foreign-owner", evidenceReviewed: true, now: NOW });
      const source = input(), row = association();
      source.assertions[0].objectId = "foreign-source-code";
      if (hiddenBy === "prior-accepted") {
        const staged = confirmed(await owner.stageComplete(imported(source, [row]), revision(f.filename), randomUUID()));
        confirmed(await owner.decide(await owner.preview(staged.batchId!), "accept", randomUUID()));
      }
      if (hiddenBy === "current-head" || hiddenBy === "prior-accepted") {
        const hiddenHead = input("foreign-source", "foreign-hidden-head");
        hiddenHead.source.privacy = "internal";
        importImpactSnapshot(f.filename, hiddenHead, {
          expectedRevision: revision(f.filename), actor: "foreign-owner", now: NOW,
        }); // Latest current policy is Internal while accepted bytes remain Public.
      }
      expect(readImpactSnapshot(f.filename, publicGrant).entities.some(entity => entity.record.id === "foreign-source-code")).toBe(false);
      const proposed = hiddenBy === "prior-accepted"
        ? imported({ ...source, assertions: [] }, [{ ...row, aliases: ["extra-alias"] }], "mapping-two", "mapping-one")
        : imported(source, [row]);
      const before = owned(f.filename), operationId = randomUUID();
      await deniedAsync(() => owner.stageComplete(proposed, revision(f.filename), operationId), "SCOPE_DENIED");
      expect(owner.receipt(operationId)).toBeNull();
      expect(owned(f.filename)).toEqual(before);
      f.assertProtected();
    }
  });

  it("persists mapping-only correction and complete omission while reserving identities across reopen", async () => {
    const f = fixture(); enroll(f);
    const source = input(), row = association();
    const first = await accepted(f, imported(source, [row]));
    const renamed = { ...row, externalKey: "service:renamed", aliases: ["service:main"] };
    const second = await accepted(f, imported(source, [renamed], "mapping-two", "mapping-one"));
    expect(second.staged.batchId).not.toBe(first.staged.batchId);
    expect(second.review.diff.mappings).toEqual([{ kind: "changed", id: row.mappingId, before: row, after: renamed }]);
    expect(second.review.diff.entities).toEqual([]);
    const third = await accepted(f, imported(source, [], "mapping-three", "mapping-two"));
    expect(third.review.diff.retireMappingIds).toEqual([row.mappingId]);
    expect(third.review.diff.mappings[0]).toMatchObject({ kind: "changed", before: renamed, after: { ...renamed, state: "retired" } });
    const before = owned(f.filename), reopened = createImpactMappingOperator(f.config);
    await deniedAsync(() => reopened.stageComplete(imported(source, [renamed], "mapping-four", "mapping-three"),
      revision(f.filename), randomUUID()), "IDENTITY_CONFLICT");
    expect(owned(f.filename)).toEqual(before);
    expect(reopened.receipt(third.receipt.operationId)).toEqual(third.receipt); f.assertProtected();
  });

  it("retains the original evidence batch through multiple omitted versions without retiring another source at the same endpoint", async () => {
    const f = fixture(true, [authority(), authority("source-b")]); enroll(f); enroll(f, "source-b");
    const row = association(), original = input();
    const first = await accepted(f, imported(original, [row]));
    const other = association("source-b");
    expect(other.target).toEqual(row.target);
    const secondSource = await accepted(f, imported(input("source-b"), [other]));
    const otherSnapshot = readImpactImport(f.filename, grant(), secondSource.staged.batchId!);
    const beforeCollision = owned(f.filename);
    const foreignId = { ...association("source-b", row.mappingId), externalKey: "other:foreign-id" };
    await deniedAsync(() => f.owner.stageComplete(imported(input("source-b"), [foreignId], "mapping-two", "mapping-one"),
      revision(f.filename), randomUUID()), "IDENTITY_CONFLICT");
    expect(owned(f.filename)).toEqual(beforeCollision);
    const binding = (batchId: string, mappingId: string) => readDb(f.filename, db =>
      db.prepare("SELECT m.mapping_id,m.evidence_id,m.evidence_batch_id,e.record_json FROM mapping_evidence m JOIN evidence e ON e.batch_id=m.evidence_batch_id AND e.id=m.evidence_id WHERE m.batch_id=? AND m.mapping_id=?")
        .all(batchId, mappingId).map(value => ({ mappingId: value.mapping_id, evidenceId: value.evidence_id,
          evidenceBatchId: value.evidence_batch_id, evidence: JSON.parse(String(value.record_json)) })));
    const expected = [{ mappingId: row.mappingId, evidenceId: original.evidence[0].id,
      evidenceBatchId: first.staged.batchId, evidence: original.evidence[0] }];
    expect(binding(first.staged.batchId!, row.mappingId)).toEqual(expected);
    const omitted = input("source-a", "source-revision-two");
    omitted.entities = []; omitted.evidence = []; omitted.assertions = [];
    const retirement = await accepted(f, imported(omitted, [], "mapping-two", "mapping-one"));
    expect(retirement.review.diff.retireMappingIds).toEqual([row.mappingId]);
    expect(retirement.review.diff.mappingEvidence).toEqual([]);
    expect(binding(retirement.staged.batchId!, row.mappingId)).toEqual(expected);
    const thirdInput = { ...omitted, source: { ...omitted.source, revision: "source-revision-three",
      digest: sha("third original source version with no entities") } };
    const third = await accepted(f, imported(thirdInput, [], "mapping-three", "mapping-two"));
    expect(third.review.diff.retireMappingIds).toEqual([]);
    expect(binding(third.staged.batchId!, row.mappingId)).toEqual(expected);
    expect(binding(secondSource.staged.batchId!, other.mappingId)[0].evidenceBatchId).toBe(secondSource.staged.batchId);
    expect(readImpactImport(f.filename, grant(), secondSource.staged.batchId!)).toEqual(otherSnapshot);
    expect(readImpactSnapshot(f.filename, grant()).sources.find(source => source.source.id === "source-b")!.batchId)
      .toBe(secondSource.staged.batchId);
    const reopened = createImpactMappingOperator(f.config);
    expect(reopened.receipt(third.receipt.operationId)).toEqual(third.receipt);
    const before = owned(f.filename);
    await deniedAsync(() => reopened.stageComplete(imported(original, [row], "mapping-four", "mapping-three"),
      revision(f.filename), randomUUID()), "IDENTITY_CONFLICT");
    expect(owned(f.filename)).toEqual(before);
  });

  it("keeps pending/rejected reservations and blocks legacy writer bypass for managed sources", async () => {
    const f = fixture(); enroll(f);
    const row = association(), value = imported(input(), [row]);
    const staged = confirmed(await f.owner.stageComplete(value, revision(f.filename), randomUUID()));
    const reviewed = await f.owner.preview(staged.batchId!);
    const pending = owned(f.filename);
    expect(() => reviewImpactImport(f.filename, staged.batchId!, { decision: "accept",
      expectedRevision: revision(f.filename), reviewer: "old-writer", evidenceReviewed: true, now: NOW })).toThrow();
    expect(owned(f.filename)).toEqual(pending);
    confirmed(await f.owner.decide(reviewed, "reject", randomUUID()));
    const before = owned(f.filename), reopened = createImpactMappingOperator(f.config);
    const differentIdentity = { ...association(), target: { ...row.target, id: "component-b" } };
    await deniedAsync(() => reopened.stageComplete(imported(input(), [differentIdentity], "mapping-two"),
      revision(f.filename), randomUUID()), "IDENTITY_CONFLICT");
    expect(() => importImpactSnapshot(f.filename, input("source-a", "legacy-bypass"), {
      expectedRevision: revision(f.filename), actor: "old-writer", now: NOW,
    })).toThrow();
    expect(() => reviewImpactImport(f.filename, staged.batchId!, { decision: "accept",
      expectedRevision: revision(f.filename), reviewer: "old-writer", evidenceReviewed: true, now: NOW })).toThrow();
    expect(owned(f.filename)).toEqual(before);
  });

  it("binds migration to old raw payloads even when reports change without graph revision", () => {
    const f = fixture(false), expected = f.owner.inspectMappingFormat(), originalRevision = revision(f.filename);
    editDb(f.filename, db => db.prepare("INSERT INTO reports VALUES(?,?,?,?,?)")
      .run("fixture-report", "0".repeat(64), originalRevision, "{ \"retained\" : true }", NOW));
    const afterForeignWrite = owned(f.filename);
    denied(() => f.owner.upgradeMappings(expected, randomUUID()), "CONFIG_CHANGED");
    expect(schema(f.filename)).toBe(2); expect(revision(f.filename)).toBe(originalRevision);
    expect(owned(f.filename)).toEqual(afterForeignWrite);
    if (existsSync(f.backup)) expect(schema(f.backup)).toBe(2);
  });

  it("keeps an occupied backup and refuses unexpected attached triggers before their side effects", async () => {
    const occupied = fixture(false); writeFileSync(occupied.backup, "retained backup sentinel");
    const before = owned(occupied.filename);
    denied(() => occupied.owner.upgradeMappings(occupied.owner.inspectMappingFormat(), randomUUID()), "BACKUP_CONFLICT");
    expect(readFileSync(occupied.backup, "utf8")).toBe("retained backup sentinel");
    expect(owned(occupied.filename)).toEqual(before);
    const f = fixture(); enroll(f);
    editDb(f.filename, db => db.exec("CREATE TABLE extension_marker(value TEXT); CREATE TRIGGER unexpected_import_trigger AFTER INSERT ON imports BEGIN INSERT INTO extension_marker VALUES('trigger executed'); END;"));
    const withTrigger = owned(f.filename);
    await expect(f.owner.stageComplete(imported(input(), [association()]), revision(f.filename), randomUUID())).rejects.toBeInstanceOf(MappingError);
    expect(readDb(f.filename, db => db.prepare("SELECT COUNT(*) AS n FROM extension_marker").get()!.n)).toBe(0);
    expect(owned(f.filename)).toEqual(withTrigger);
  });

  it("preserves rich legacy data, exact immutable triggers and report behavior through explicit format three", () => {
    const f = richLegacyFixture(), before = oldRows(f.filename);
    const snapshot = readImpactSnapshot(f.filename, f.demo.grant);
    const history = readImpactHistory(f.filename, f.demo.grant);
    const imports = listImpactImports(f.filename, f.demo.grant);
    const reports = listImpactReportSummaries(f.filename, f.demo.grant);
    const triggerSql = readDb(f.filename, db => db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' ORDER BY name").all());
    const operationId = randomUUID(), result = confirmed(f.owner.upgradeMappings(f.owner.inspectMappingFormat(), operationId));
    expect(schema(f.filename)).toBe(3); expect(schema(f.backup)).toBe(2);
    expect(result).toMatchObject({ action: "upgrade", decision: "format_upgraded",
      graphRevisionBefore: snapshot.graphRevision, graphRevisionAfter: snapshot.graphRevision });
    expect(result.upgrade).not.toBeNull();
    expect(result.upgrade!.originalSnapshotDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.upgrade?.originalSnapshotDigest).toBe(result.upgrade?.backupSnapshotDigest);
    expect(oldRows(f.filename)).toEqual(before); expect(oldRows(f.backup)).toEqual(before);
    expect(readImpactSnapshot(f.filename, f.demo.grant)).toEqual(snapshot);
    expect(readImpactHistory(f.filename, f.demo.grant)).toEqual(history);
    expect(listImpactImports(f.filename, f.demo.grant)).toEqual(imports);
    expect(listImpactReportSummaries(f.filename, f.demo.grant)).toEqual(reports);
    expect(loadImpactReport(f.filename, f.demo.grant, f.report.id, f.reportOptions)).toEqual(f.report);
    expect(f.reviewer.read(f.report.id).history).toHaveLength(2);
    expect(readDb(f.filename, db => db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND name LIKE 'review_events_%' ORDER BY name").all())).toEqual(triggerSql);
    editDb(f.filename, db => {
      expect(() => db.exec("DELETE FROM review_events")).toThrow("REVIEW_HISTORY_IMMUTABLE");
      expect(() => db.exec("UPDATE review_events SET record_json='{}'")).toThrow("REVIEW_HISTORY_IMMUTABLE");
    });
    expect(f.reviewer.record({ ...f.reviewRequest, expectedReviewRevision: 2 }).reviewRevision).toBe(3);
    expect(createImpactMappingOperator(f.config).receipt(operationId)).toEqual(result);
    const beforeOldUpgrade = owned(f.filename), unusedBackup = path.join(f.directory, "must-not-exist.sqlite");
    expect(initializeImpactStore(f.filename).schemaVersion).toBe(3);
    expect(upgradeImpactStore(f.filename, { backupPath: unusedBackup })).toMatchObject({ schemaVersion: 3, upgraded: false });
    expect(existsSync(unusedBackup)).toBe(false); expect(owned(f.filename)).toEqual(beforeOldUpgrade);
  });

  it("keeps old format one readable and requires the two explicit upgrade steps", () => {
    const f = richLegacyFixture(); legacyVersionOne(f.filename);
    const before = readFileSync(f.filename), snapshot = readImpactSnapshot(f.filename, f.demo.grant);
    expect(initializeImpactStore(f.filename).schemaVersion).toBe(1);
    expect(f.owner.inspectMappingFormat()).toMatchObject({ schemaVersion: 1, storeUuid: null });
    expect(f.reviewer.read(f.report.id).reviewRevision).toBe(0);
    denied(() => f.owner.upgradeMappings(f.owner.inspectMappingFormat(), randomUUID()), "UNSUPPORTED_FORMAT");
    expect(readFileSync(f.filename)).toEqual(before); expect(existsSync(f.backup)).toBe(false);
    const oldBackup = path.join(f.directory, "format-one.sqlite");
    expect(upgradeImpactStore(f.filename, { backupPath: oldBackup })).toMatchObject({ schemaVersion: 2, upgraded: true });
    expect(schema(oldBackup)).toBe(1);
    confirmed(f.owner.upgradeMappings(f.owner.inspectMappingFormat(), randomUUID()));
    expect(schema(f.filename)).toBe(3); expect(schema(f.backup)).toBe(2);
    expect(readImpactSnapshot(f.filename, f.demo.grant)).toEqual(snapshot);
    expect(readImpactSnapshot(oldBackup, f.demo.grant)).toEqual(snapshot);
  });

  it("backs up committed owned rows present only in WAL while a real keeper connection remains open", () => {
    const f = richLegacyFixture(), keeper = new DatabaseSync(f.filename);
    let reading = false;
    try {
      expect(keeper.prepare("PRAGMA journal_mode=WAL").get()!.journal_mode).toBe("wal");
      keeper.exec("PRAGMA wal_autocheckpoint=0; BEGIN"); reading = true;
      // An idle connection alone does not pin a WAL read snapshot. Perform a
      // real read before the second connection commits the new report.
      const reportCount = keeper.prepare("SELECT COUNT(*) AS count FROM reports").get()!.count;
      const options = { freshness: f.demo.checks.A, now: "2026-10-20T04:00:01.000Z" };
      const walReport = createImpactReport(f.filename, f.demo.grant,
        { ...f.demo.change, description: "Distinct fixture report committed into WAL." }, options);
      expect(walReport.id).not.toBe(f.report.id);
      saveImpactReport(f.filename, f.demo.grant, walReport, options);
      expect(keeper.prepare("SELECT COUNT(*) AS count FROM reports").get()!.count).toBe(reportCount);
      expect(keeper.prepare("SELECT id FROM reports WHERE id=?").get(walReport.id)).toBeUndefined();
      expect(readDb(f.filename, db => db.prepare("SELECT id FROM reports WHERE id=?").get(walReport.id))!.id).toBe(walReport.id);
      expect(existsSync(`${f.filename}-wal`)).toBe(true);
      expect(readFileSync(`${f.filename}-wal`).length).toBeGreaterThan(32);
      const mainOnly = path.join(f.directory, "main-file-only.sqlite");
      writeFileSync(mainOnly, readFileSync(f.filename));
      expect(readDb(mainOnly, db => db.prepare("SELECT id FROM reports WHERE id=?").get(walReport.id))).toBeUndefined();
      const before = oldRows(f.filename), originalRevision = revision(f.filename);
      const expected = f.owner.inspectMappingFormat();
      const receipt = confirmed(f.owner.upgradeMappings(expected, randomUUID()));
      expect(receipt.upgrade).not.toBeNull();
      expect(receipt.upgrade?.originalSnapshotDigest).toBe(receipt.upgrade?.backupSnapshotDigest);
      expect(oldRows(f.backup)).toEqual(before); expect(oldRows(f.filename)).toEqual(before);
      expect(schema(f.backup)).toBe(2); expect(revision(f.filename)).toBe(originalRevision);
      expect(readDb(f.backup, db => db.prepare("SELECT id FROM reports WHERE id=?").get(walReport.id))!.id).toBe(walReport.id);
      expect(loadImpactReport(f.backup, f.demo.grant, walReport.id, options)).toEqual(walReport);
    } finally {
      try { if (reading) keeper.exec("ROLLBACK"); } finally { keeper.close(); }
    }
  });

  it("keeps unrelated legacy imports and their hashes usable after mapping enrollment on format three", async () => {
    const f = fixture(); enroll(f);
    await accepted(f, imported(input(), [association()]));
    const unrelated = input("unmanaged-source");
    const staged = importImpactSnapshot(f.filename, unrelated, {
      expectedRevision: revision(f.filename), actor: "old-operator", now: NOW,
    });
    // Fixed independent ASCII canonical vector, calculated without importing
    // production digest/normalization. Preserve old batch identity on format 3.
    const normalized = { ...unrelated, entities: [...unrelated.entities].sort((a, b) => a.id.localeCompare(b.id)),
      evidence: [...unrelated.evidence], assertions: [...unrelated.assertions] };
    const expectedDigest = "c0739e7cf442f6fd41ecf9d42044918cd7142d3fce10ba4b4cf319a6560db992";
    expect(digest(normalized)).toBe(expectedDigest);
    expect(staged.batchId).toBe(`batch-${expectedDigest}`);
    reviewImpactImport(f.filename, staged.batchId, { decision: "accept",
      expectedRevision: staged.graphRevision, reviewer: "old-reviewer", evidenceReviewed: true, now: NOW });
    expect(readImpactImport(f.filename, grant(), staged.batchId)).toEqual(normalized);
    const fresh = revision(f.filename), before = owned(f.filename);
    expect(importImpactSnapshot(f.filename, unrelated, { expectedRevision: fresh, actor: "old-operator", now: NOW }))
      .toMatchObject({ batchId: staged.batchId, idempotent: true });
    expect(() => importImpactSnapshot(f.filename, unrelated, { expectedRevision: fresh - 1, actor: "old-operator", now: NOW }))
      .toThrow("IMPACT_REVISION_CONFLICT");
    expect(owned(f.filename)).toEqual(before);
  });

  it("counts durable source registrations across operator recreation and refuses the next global slot", () => {
    const all = Array.from({ length: MAPPING_LIMITS.sources }, (_, index) => authority(`source-${String(index).padStart(3, "0")}`));
    const f = fixture(true, all);
    expect(Buffer.byteLength(dataJson(all))).toBeLessThanOrEqual(MAPPING_LIMITS.authoritiesBytes);
    for (const item of all) confirmed(f.owner.registerSource(item.sourceId, revision(f.filename), randomUUID()));
    expect(rows(f.filename, "mapping_authorities")).toHaveLength(200);
    const extra = authority("source-over-cap"), reopened = createImpactMappingOperator({
      ...f.config, authorities: [extra],
    }), before = owned(f.filename), operationId = randomUUID();
    denied(() => reopened.registerSource(extra.sourceId, revision(f.filename), operationId), "BUDGET_EXCEEDED");
    expect(reopened.receipt(operationId)).toBeNull();
    expect(owned(f.filename)).toEqual(before); f.assertProtected();
  }, 30000);
});
