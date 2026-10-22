import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, lstatSync, openSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import {
  type ImpactAssertion, type ImpactEntity, type ImpactEvidence, type ImpactGrant,
  type ImpactImport, type ImpactSnapshot, type ImportResult, type SourceDescriptor,
  type SourceState, boundedInteger, digest, fail, grantFingerprint, identifier,
  recordAllowed, sourceAllowed, stableJson, textValue, timestamp, validateGrant,
  validateImport, validatePredicate
} from "./model.js";
import {
  MappingError, MAPPING_LIMITS, canonicalMappingJson, normalizeMappingImport,
  normalizeMappingSourceImport, normalizeMappingSourceAuthority, normalizeMappingVersionSnapshot,
  transitionMapping,
  type MappingOperatorConfig, type MappingOperator, type MappingFormatPreview,
  type MappingWriteOutcome, type MappingReceipt, type MappingOperationScope,
  type MappingReceiptScope, type MappingSourceAuthority, type MappingScope,
  type MappingImport, type MappingBeforeState, type MappingVersionSnapshot,
  type MappingTransition, type MappingReview, type MappingRow,
  type MappingEvidenceBinding, type MappingObservations, type MappingTarget,
} from "./mapping.js";
import type { MappingCurrentCapture } from "./mapping-read.js";

const APPLICATION_ID = 0x4c4d4950; // LMIP; not LMPR, topology or project-memory.
const SCHEMA_VERSION = 2;
const REVIEW_SCHEMA_SQL = `
  CREATE TABLE review_heads (report_id TEXT PRIMARY KEY REFERENCES reports(id),
    binding_hash TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision >= 0));
  CREATE TABLE review_events (report_id TEXT NOT NULL REFERENCES review_heads(report_id),
    revision INTEGER NOT NULL CHECK(revision > 0), record_json TEXT NOT NULL,
    PRIMARY KEY(report_id, revision));
  CREATE TRIGGER review_events_no_update BEFORE UPDATE ON review_events
    BEGIN SELECT RAISE(ABORT, 'REVIEW_HISTORY_IMMUTABLE'); END;
  CREATE TRIGGER review_events_no_delete BEFORE DELETE ON review_events
    BEGIN SELECT RAISE(ABORT, 'REVIEW_HISTORY_IMMUTABLE'); END;
`;
const LEGACY_SCHEMA_SQL = `
      CREATE TABLE metadata (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL);
      INSERT INTO metadata VALUES(1, 0);
      CREATE TABLE sources (id TEXT PRIMARY KEY, scope_json TEXT NOT NULL,
        latest_batch_id TEXT NOT NULL, accepted_batch_id TEXT, status TEXT NOT NULL);
      CREATE TABLE imports (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, content_hash TEXT NOT NULL,
        source_json TEXT NOT NULL, state TEXT NOT NULL, imported_at TEXT NOT NULL, actor TEXT NOT NULL,
        reviewed_at TEXT, reviewer TEXT, delta_json TEXT NOT NULL);
      CREATE TABLE entity_identity (id TEXT PRIMARY KEY, source_id TEXT NOT NULL);
      CREATE TABLE entity_keys (source_id TEXT NOT NULL, source_key TEXT NOT NULL, entity_id TEXT NOT NULL,
        PRIMARY KEY(source_id, source_key));
      CREATE TABLE entities (batch_id TEXT NOT NULL REFERENCES imports(id), id TEXT NOT NULL,
        kind TEXT NOT NULL, privacy TEXT NOT NULL, record_json TEXT NOT NULL, PRIMARY KEY(batch_id,id));
      CREATE TABLE evidence (batch_id TEXT NOT NULL REFERENCES imports(id), id TEXT NOT NULL,
        privacy TEXT NOT NULL, record_json TEXT NOT NULL, PRIMARY KEY(batch_id,id));
      CREATE TABLE assertions (batch_id TEXT NOT NULL REFERENCES imports(id), id TEXT NOT NULL,
        subject_id TEXT NOT NULL, predicate TEXT NOT NULL, object_id TEXT NOT NULL,
        privacy TEXT NOT NULL, record_json TEXT NOT NULL, PRIMARY KEY(batch_id,id));
      CREATE INDEX assertion_subject ON assertions(subject_id);
      CREATE INDEX assertion_object ON assertions(object_id);
      CREATE INDEX imports_source ON imports(source_id);
      CREATE TABLE history (revision INTEGER PRIMARY KEY, event TEXT NOT NULL, actor TEXT NOT NULL,
        at TEXT NOT NULL, source_id TEXT NOT NULL, batch_id TEXT NOT NULL);
      CREATE TABLE reports (id TEXT PRIMARY KEY, grant_hash TEXT NOT NULL, graph_revision INTEGER NOT NULL,
        report_json TEXT NOT NULL, saved_at TEXT NOT NULL);
      ${REVIEW_SCHEMA_SQL}
`;
type Row = Record<string, string | number | null>;
function checkedPath(filename: string, create = false): string {
  if (!path.isAbsolute(filename)) fail("ABSOLUTE_STORE_PATH_REQUIRED");
  const resolved = path.resolve(filename);
  const parent = realpathSync(path.dirname(resolved));
  const canonical = path.join(parent, path.basename(resolved));
  if ([resolved, canonical].some(p => p.split(/[\\/]/u).some(s => s.toLowerCase() === ".lmti"))) fail("MEMORY_STORE_BOUNDARY_DENIED");
  if (!existsSync(canonical)) {
    if (!create) fail("IMPACT_STORE_UNAVAILABLE");
    return canonical;
  }
  if (lstatSync(canonical).isSymbolicLink() || !statSync(canonical).isFile() || statSync(canonical).size > 256 * 1024 * 1024) fail("STORE_BOUNDARY_DENIED");
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = canonical + suffix;
    if (existsSync(sidecar) && (lstatSync(sidecar).isSymbolicLink() || !statSync(sidecar).isFile() || statSync(sidecar).size > 256 * 1024 * 1024)) fail("STORE_BOUNDARY_DENIED");
  }
  return canonical;
}
function openStore(filename: string, write = false): DatabaseSync {
  const db = new DatabaseSync(checkedPath(filename), { readOnly: !write });
  try {
    const app = db.prepare("PRAGMA application_id").get() as Row;
    const version = db.prepare("PRAGMA user_version").get() as Row;
    if (app.application_id !== APPLICATION_ID || ![1, 2, 3].includes(Number(version.user_version))) fail("UNSUPPORTED_IMPACT_STORE");
    db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;");
    if (!write) db.exec("PRAGMA query_only = ON;");
    if (Number(version.user_version) === 3) mappingSchema(db);
    return db;
  } catch (error) { db.close(); throw error; }
}
export function initializeImpactStore(filename: string): { path: string; schemaVersion: number; graphRevision: number } {
  const target = checkedPath(filename, true);
  if (existsSync(target)) {
    const db = openStore(target);
    try { return { path: target, schemaVersion: schemaVersion(db), graphRevision: revision(db) }; } finally { db.close(); }
  }
  // Exclusive creation prevents opening/truncating another application's file.
  closeSync(openSync(target, "wx", 0o600));
  const db = new DatabaseSync(target);
  try {
    db.exec(`BEGIN IMMEDIATE;
      PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = ${SCHEMA_VERSION};
      ${LEGACY_SCHEMA_SQL}
      COMMIT;`);
    return { path: target, schemaVersion: SCHEMA_VERSION, graphRevision: 0 };
  } finally { db.close(); }
}
function schemaVersion(db: DatabaseSync): number {
  return Number((db.prepare("PRAGMA user_version").get() as Row).user_version);
}
/** Explicit owner operation. Reads never migrate a v1 file or create a backup. */
export function upgradeImpactStore(filename: string, options: { backupPath: string }): { path: string; schemaVersion: number; graphRevision: number; upgraded: boolean; backupPath?: string } {
  const target = checkedPath(filename), db = openStore(target, true);
  try {
    if (schemaVersion(db) >= SCHEMA_VERSION) return { path: target, schemaVersion: schemaVersion(db), graphRevision: revision(db), upgraded: false };
    const backupPath = checkedPath(options.backupPath, true);
    if (target.toLowerCase() === backupPath.toLowerCase() || existsSync(backupPath)) fail("BACKUP_DESTINATION_EXISTS");
    const dataVersion = Number((db.prepare("PRAGMA data_version").get() as Row).data_version);
    // VACUUM INTO includes committed WAL contents. A byte-copy of the main file
    // could silently omit them. Exclusive reservation prevents overwriting data.
    closeSync(openSync(backupPath, "wx", 0o600));
    db.prepare("VACUUM INTO ?").run(backupPath);
    const backup = openStore(backupPath);
    try {
      const check = backup.prepare("PRAGMA integrity_check").get() as Row;
      if (schemaVersion(backup) !== 1 || check.integrity_check !== "ok") fail("BACKUP_VERIFICATION_FAILED");
    } finally { backup.close(); }
    db.exec("BEGIN IMMEDIATE");
    try {
      // If another writer changed anything after the backup started, leave the
      // original untouched and require a new backup, never a partial migration.
      if (schemaVersion(db) !== 1 || Number((db.prepare("PRAGMA data_version").get() as Row).data_version) !== dataVersion) fail("MIGRATION_REVISION_CONFLICT");
      db.exec(`${REVIEW_SCHEMA_SQL} PRAGMA user_version = ${SCHEMA_VERSION};`);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    return { path: target, schemaVersion: SCHEMA_VERSION, graphRevision: revision(db), upgraded: true, backupPath };
  } finally { db.close(); }
}
function revision(db: DatabaseSync): number {
  return boundedInteger((db.prepare("SELECT revision FROM metadata WHERE id=1").get() as Row).revision, 0, Number.MAX_SAFE_INTEGER);
}
function expectRevision(db: DatabaseSync, expected: number) {
  if (revision(db) !== boundedInteger(expected, 0, Number.MAX_SAFE_INTEGER)) fail("IMPACT_REVISION_CONFLICT");
}
function mutate<T>(filename: string, callback: (db: DatabaseSync) => T): T {
  const db = openStore(filename, true);
  try {
    db.exec("BEGIN IMMEDIATE");
    try { const result = callback(db); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  } finally { db.close(); }
}
function bump(db: DatabaseSync, event: string, actor: string, sourceId: string, batchId: string, at: string): number {
  const next = revision(db) + 1;
  db.prepare("UPDATE metadata SET revision=? WHERE id=1").run(next);
  db.prepare("INSERT INTO history VALUES(?,?,?,?,?,?)").run(next, event, actor, at, sourceId, batchId);
  return next;
}
function readBatch(db: DatabaseSync, batchId: string): ImpactImport {
  const row = db.prepare("SELECT source_json FROM imports WHERE id=?").get(batchId) as Row | undefined;
  if (!row) fail("INVALID_IMPACT_STORE");
  const records = (table: "entities" | "evidence" | "assertions") => (db.prepare(`SELECT record_json FROM ${table} WHERE batch_id=? ORDER BY id`).all(batchId) as Row[]).map(r => JSON.parse(String(r.record_json)));
  try { return validateImport({ schema: "lmti.impact.import.v1", source: JSON.parse(String(row.source_json)), entities: records("entities"), evidence: records("evidence"), assertions: records("assertions") }); }
  catch { fail("INVALID_IMPACT_STORE"); }
}
function normalizeImport(input: ImpactImport): ImpactImport {
  return { ...input, entities: [...input.entities].sort((a, b) => a.id.localeCompare(b.id)), evidence: [...input.evidence].sort((a, b) => a.id.localeCompare(b.id)), assertions: input.assertions.map(a => ({ ...a, evidenceIds: [...a.evidenceIds].sort(), applicableChanges: [...a.applicableChanges].sort() })).sort((a, b) => a.id.localeCompare(b.id)) };
}
function delta(before: ImpactImport | undefined, after: ImpactImport): ImportResult["delta"] {
  // Evidence and endpoint metadata changes also require review of supported
  // assertions, even if the relation's own serialized fields are unchanged.
  const fingerprints = (input: ImpactImport | undefined) => {
    const evidence = new Map(input?.evidence.map(e => [e.id, e]) ?? []);
    const entities = new Map(input?.entities.map(e => [e.id, e]) ?? []);
    return new Map((input?.assertions ?? []).map(a => [a.id, digest([a, a.evidenceIds.map(id => evidence.get(id)), entities.get(a.subjectId), entities.get(a.objectId)])]));
  };
  const previous = fingerprints(before), next = fingerprints(after);
  return { added: [...next.keys()].filter(id => !previous.has(id)), changed: [...next.keys()].filter(id => previous.has(id) && previous.get(id) !== next.get(id)), removed: [...previous.keys()].filter(id => !next.has(id)) };
}
function existingEntityMap(db: DatabaseSync, excludeSource: string): Map<string, { record: ImpactEntity; source: SourceDescriptor }> {
  const result = new Map<string, { record: ImpactEntity; source: SourceDescriptor }>();
  const rows = db.prepare("SELECT accepted_batch_id FROM sources WHERE id != ? AND accepted_batch_id IS NOT NULL").all(excludeSource) as Row[];
  for (const row of rows) {
    const batch = readBatch(db, String(row.accepted_batch_id));
    for (const e of batch.entities) result.set(e.id, { record: e, source: batch.source });
  }
  return result;
}
export function importImpactSnapshot(filename: string, value: unknown, options: { expectedRevision: number; actor: string; now?: string }): ImportResult {
  const input = normalizeImport(validateImport(value)), actor = identifier(options.actor), now = timestamp(options.now ?? new Date().toISOString());
  if (Date.parse(input.source.capturedAt) > Date.parse(now) + 60_000 || input.evidence.some(e => Date.parse(e.capturedAt) > Date.parse(now) + 60_000 || (e.observedAt && Date.parse(e.observedAt) > Date.parse(e.capturedAt)))) fail("FUTURE_EVIDENCE_DENIED");
  const contentHash = digest(input), batchId = `batch-${contentHash}`;
  return mutate(filename, db => {
    expectRevision(db, options.expectedRevision);
    refuseManagedSource(db, input.source.id);
    const already = db.prepare("SELECT state,delta_json FROM imports WHERE id=?").get(batchId) as Row | undefined;
    if (already) return { batchId, graphRevision: revision(db), idempotent: true, state: already.state as ImportResult["state"], delta: JSON.parse(String(already.delta_json)) };
    return stageImportOnConnection(db, input, { mode: "legacy", batchId, contentHash, actor, now });
  });
}
function stageImportOnConnection(db: DatabaseSync, input: ImpactImport, options: { mode: "legacy" | "mapping_managed"; batchId: string; contentHash: string; actor: string; now: string }): ImportResult {
  const { mode, batchId, contentHash, actor, now } = options;
    const head = db.prepare("SELECT * FROM sources WHERE id=?").get(input.source.id) as Row | undefined;
    if (!head && Number((db.prepare("SELECT COUNT(*) AS n FROM sources").get() as Row).n) >= 200) fail("SOURCE_CAPACITY_EXCEEDED");
    if (head) {
      const previous = JSON.parse(String(head.scope_json)) as SourceDescriptor;
      if (["projectId", "siteId", "environmentId", "kind"].some(k => previous[k as keyof SourceDescriptor] !== input.source[k as keyof SourceDescriptor])) fail("SOURCE_IDENTITY_CONFLICT");
      const latest = readBatch(db, String(head.latest_batch_id));
      // Revision labels may stay unchanged for a dirty checkout, but a reused
      // digest cannot represent different records or policy/schema metadata.
      if (mode === "legacy" && latest.source.digest === input.source.digest) fail("SOURCE_DIGEST_REUSED");
    }
    const foreign = existingEntityMap(db, input.source.id);
    const all = new Map([...foreign].map(([id, e]) => [id, e.record]));
    for (const e of input.entities) {
      const owner = db.prepare("SELECT source_id FROM entity_identity WHERE id=?").get(e.id) as Row | undefined;
      const key = db.prepare("SELECT entity_id FROM entity_keys WHERE source_id=? AND source_key=?").get(input.source.id, e.sourceKey) as Row | undefined;
      if (foreign.has(e.id) || (owner && owner.source_id !== input.source.id) || (key && key.entity_id !== e.id)) fail("ENTITY_IDENTITY_CONFLICT");
      all.set(e.id, e);
    }
    for (const a of input.assertions) {
      validatePredicate(a, all);
      for (const id of [a.subjectId, a.objectId]) {
        const foreignRecord = foreign.get(id);
        if (foreignRecord && ["projectId", "siteId", "environmentId"].some(k => foreignRecord.source[k as keyof SourceDescriptor] !== input.source[k as keyof SourceDescriptor])) fail("CROSS_SCOPE_REFERENCE_DENIED");
      }
    }
    // Evidence/assertion IDs are source-owned; collisions never join unrelated facts.
    for (const [table, records] of [["evidence", input.evidence], ["assertions", input.assertions]] as const) {
      const query = db.prepare(`SELECT 1 FROM ${table} r JOIN imports i ON i.id=r.batch_id WHERE r.id=? AND i.source_id != ? LIMIT 1`);
      if (records.some(r => query.get(r.id, input.source.id))) fail("RECORD_IDENTITY_CONFLICT");
    }
    const before = head?.accepted_batch_id ? readBatch(db, String(head.accepted_batch_id)) : undefined;
    const changes = delta(before, input);
    db.prepare("INSERT INTO imports VALUES(?,?,?,?,?,?,?,?,?,?)").run(batchId, input.source.id, contentHash, stableJson(input.source), "pending", now, actor, null, null, stableJson(changes));
    const insertEntity = db.prepare("INSERT INTO entities VALUES(?,?,?,?,?)");
    for (const e of input.entities) {
      db.prepare("INSERT OR IGNORE INTO entity_identity VALUES(?,?)").run(e.id, input.source.id);
      db.prepare("INSERT OR IGNORE INTO entity_keys VALUES(?,?,?)").run(input.source.id, e.sourceKey, e.id);
      insertEntity.run(batchId, e.id, e.kind, e.privacy, stableJson(e));
    }
    const insertEvidence = db.prepare("INSERT INTO evidence VALUES(?,?,?,?)");
    for (const e of input.evidence) insertEvidence.run(batchId, e.id, e.privacy, stableJson(e));
    const insertAssertion = db.prepare("INSERT INTO assertions VALUES(?,?,?,?,?,?,?)");
    for (const a of input.assertions) insertAssertion.run(batchId, a.id, a.subjectId, a.predicate, a.objectId, a.privacy, stableJson(a));
    db.prepare("INSERT INTO sources VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET scope_json=excluded.scope_json,latest_batch_id=excluded.latest_batch_id,status='available'").run(input.source.id, stableJson(input.source), batchId, null, "available");
    const graphRevision = bump(db, "import-staged", actor, input.source.id, batchId, now);
    return { batchId, graphRevision, idempotent: false, state: "pending", delta: changes };
}
export function reviewImpactImport(filename: string, batchId: string, options: { decision: "accept" | "reject"; expectedRevision: number; reviewer: string; evidenceReviewed: true; grant?: ImpactGrant; now?: string }): { graphRevision: number; state: "accepted" | "rejected" } {
  identifier(batchId); const reviewer = identifier(options.reviewer), now = timestamp(options.now ?? new Date().toISOString());
  const grant = options.grant === undefined ? undefined : validateGrant(options.grant);
  if (options.evidenceReviewed !== true || !["accept", "reject"].includes(options.decision)) fail("EXPLICIT_REVIEW_REQUIRED");
  return mutate(filename, db => {
    expectRevision(db, options.expectedRevision);
    const row = db.prepare("SELECT * FROM imports WHERE id=?").get(batchId) as Row | undefined;
    if (!row || row.state !== "pending") fail("IMPORT_NOT_REVIEWABLE");
    refuseManagedSource(db, String(row.source_id));
    const head = db.prepare("SELECT * FROM sources WHERE id=?").get(String(row.source_id)) as Row;
    if (grant) {
      const input = readBatch(db, batchId), currentSource = JSON.parse(String(head.scope_json)) as SourceDescriptor;
      if (!sourceAllowed(input.source, grant) || !sourceAllowed(currentSource, grant) || [...input.entities, ...input.evidence, ...input.assertions].some(r => !recordAllowed(r.privacy, grant))) fail("REVIEW_SCOPE_DENIED");
      const visibleIds = new Set(input.entities.map(e => e.id));
      for (const s of scopedSourceStates(db, grant)) if (s.source.id !== input.source.id) {
        for (const e of readBatch(db, s.batchId).entities) if (recordAllowed(e.privacy, grant)) visibleIds.add(e.id);
      }
      if (input.assertions.some(a => !visibleIds.has(a.subjectId) || !visibleIds.has(a.objectId))) fail("REVIEW_SCOPE_DENIED");
    }
    if (head.latest_batch_id !== batchId) fail("IMPORT_SUPERSEDED");
    if (Date.parse(now) < Date.parse(String(row.imported_at))) fail("INVALID_REVIEW_TIME");
    if (options.decision === "accept") {
      const input = readBatch(db, batchId), foreign = existingEntityMap(db, input.source.id);
      const all = new Map([...foreign].map(([id, e]) => [id, e.record]));
      for (const e of input.entities) all.set(e.id, e);
      for (const a of input.assertions) validatePredicate(a, all);
      // Other sources may still refer to removed entities. Keep their assertions
      // in history; readers omit dangling edges and report incomplete knowledge.
      db.prepare("UPDATE sources SET accepted_batch_id=? WHERE id=?").run(batchId, row.source_id);
    }
    const state = options.decision === "accept" ? "accepted" : "rejected";
    db.prepare("UPDATE imports SET state=?,reviewed_at=?,reviewer=? WHERE id=?").run(state, now, reviewer, batchId);
    return { graphRevision: bump(db, `import-${state}`, reviewer, String(row.source_id), batchId, now), state };
  });
}
export function recordImpactSourceStatus(filename: string, sourceId: string, status: "deleted" | "unavailable", options: { expectedRevision: number; actor: string; now?: string }): number {
  identifier(sourceId); identifier(options.actor); const now = timestamp(options.now ?? new Date().toISOString());
  if (!["deleted", "unavailable"].includes(status)) fail("INVALID_SOURCE_STATUS");
  return mutate(filename, db => {
    expectRevision(db, options.expectedRevision);
    const source = db.prepare("SELECT latest_batch_id FROM sources WHERE id=?").get(sourceId) as Row | undefined;
    if (!source) fail("SOURCE_UNAVAILABLE");
    db.prepare("UPDATE sources SET status=? WHERE id=?").run(status, sourceId);
    return bump(db, `source-${status}`, options.actor, sourceId, String(source.latest_batch_id), now);
  });
}
function scopedSourceStates(db: DatabaseSync, grant: ImpactGrant): SourceState[] {
  const rows = db.prepare("SELECT s.*, i.source_json, i.reviewed_at, i.reviewer FROM sources s JOIN imports i ON s.accepted_batch_id=i.id ORDER BY s.id").all() as Row[];
  const result: SourceState[] = [];
  for (const row of rows) {
    const source = JSON.parse(String(row.source_json)) as SourceDescriptor;
    const head = JSON.parse(String(row.scope_json)) as SourceDescriptor;
    // Both present source policy and accepted historical policy must allow read.
    if (!sourceAllowed(source, grant) || !sourceAllowed(head, grant)) continue;
    result.push({ source, batchId: String(row.accepted_batch_id), reviewState: "accepted", reviewedAt: String(row.reviewed_at), reviewer: String(row.reviewer), headRevision: head.revision, headDigest: head.digest, headStatus: row.status as SourceState["headStatus"] });
  }
  return result;
}
export function readImpactSnapshot(filename: string, value: ImpactGrant): ImpactSnapshot {
  const grant = validateGrant(value), db = openStore(filename);
  try {
    db.exec("BEGIN");
    const snapshot: ImpactSnapshot = { schema: "lmti.impact.snapshot.v1", graphRevision: revision(db), grantFingerprint: grantFingerprint(grant), sources: scopedSourceStates(db, grant), entities: [], evidence: [], assertions: [] };
    for (const source of snapshot.sources) {
      const batch = readBatch(db, source.batchId);
      for (const record of batch.entities) if (recordAllowed(record.privacy, grant)) snapshot.entities.push({ record, sourceId: source.source.id, batchId: source.batchId });
      for (const record of batch.evidence) if (recordAllowed(record.privacy, grant)) snapshot.evidence.push({ record, sourceId: source.source.id, batchId: source.batchId });
      for (const record of batch.assertions) if (recordAllowed(record.privacy, grant)) snapshot.assertions.push({ record, sourceId: source.source.id, batchId: source.batchId });
    }
    const entityIds = new Set(snapshot.entities.map(e => e.record.id));
    snapshot.evidence = snapshot.evidence.filter(e => e.record.entityId === undefined || entityIds.has(e.record.entityId));
    const evidenceIds = new Set(snapshot.evidence.map(e => e.record.id));
    // No hidden counts, edge endpoint IDs or evidence references escape this boundary.
    snapshot.assertions = snapshot.assertions.filter(a => entityIds.has(a.record.subjectId) && entityIds.has(a.record.objectId) && a.record.evidenceIds.every(id => evidenceIds.has(id)));
    const neededEvidence = new Set(snapshot.assertions.flatMap(a => a.record.evidenceIds));
    snapshot.evidence = snapshot.evidence.filter(e => neededEvidence.has(e.record.id) || (e.record.entityId !== undefined && entityIds.has(e.record.entityId)));
    db.exec("COMMIT");
    return snapshot;
  } finally { db.close(); }
}
export function lookupImpactEntity(filename: string, grant: ImpactGrant, entityId: string): ImpactSnapshot["entities"][number] {
  identifier(entityId);
  const result = readImpactSnapshot(filename, grant).entities.find(e => e.record.id === entityId);
  if (!result) fail("ENTITY_UNAVAILABLE");
  return result;
}
export function getImpactEvidence(filename: string, grant: ImpactGrant, evidenceId: string): ImpactSnapshot["evidence"][number] & { sourceRevision: string; sourceDigest: string; reviewedAt: string } {
  identifier(evidenceId); const snapshot = readImpactSnapshot(filename, grant);
  const result = snapshot.evidence.find(e => e.record.id === evidenceId);
  if (!result) fail("EVIDENCE_UNAVAILABLE");
  const source = snapshot.sources.find(s => s.source.id === result.sourceId)!;
  return { ...result, sourceRevision: source.source.revision, sourceDigest: source.source.digest, reviewedAt: source.reviewedAt };
}
/** Operator review inventory, scoped just like reads; returns no raw store handle. */
export function listImpactImports(filename: string, value: ImpactGrant): Array<{ batchId: string; source: SourceDescriptor; state: string; importedAt: string; delta: ImportResult["delta"] }> {
  const grant = validateGrant(value), db = openStore(filename);
  try {
    const rows = db.prepare("SELECT i.*,s.scope_json FROM imports i JOIN sources s ON s.id=i.source_id ORDER BY i.imported_at,i.id").all() as Row[];
    return rows.flatMap(row => {
      const source = JSON.parse(String(row.source_json)) as SourceDescriptor;
      if (!sourceAllowed(source, grant) || !sourceAllowed(JSON.parse(String(row.scope_json)) as SourceDescriptor, grant)) return [];
      // Delta IDs are operator metadata, filtered to each record's current grant.
      const batch = readBatch(db, String(row.id));
      const acceptedEntities = new Set<string>();
      for (const s of scopedSourceStates(db, grant)) {
        if (s.source.id === batch.source.id) continue;
        for (const e of readBatch(db, s.batchId).entities) if (recordAllowed(e.privacy, grant)) acceptedEntities.add(e.id);
      }
      for (const e of batch.entities) if (recordAllowed(e.privacy, grant)) acceptedEntities.add(e.id);
      const evidenceIds = new Set(batch.evidence.filter(e => recordAllowed(e.privacy, grant) && (e.entityId === undefined || acceptedEntities.has(e.entityId))).map(e => e.id));
      const publicIds = new Set(batch.assertions.filter(a => recordAllowed(a.privacy, grant) && acceptedEntities.has(a.subjectId) && acceptedEntities.has(a.objectId) && a.evidenceIds.every(id => evidenceIds.has(id))).map(a => a.id));
      const changes = JSON.parse(String(row.delta_json)) as ImportResult["delta"];
      return [{ batchId: String(row.id), source, state: String(row.state), importedAt: String(row.imported_at), delta: { added: changes.added.filter(id => publicIds.has(id)), changed: changes.changed.filter(id => publicIds.has(id)), removed: grant.allowInternal ? changes.removed : [] } }];
    });
  } finally { db.close(); }
}
export function readImpactImport(filename: string, value: ImpactGrant, batchId: string): ImpactImport {
  const grant = validateGrant(value); identifier(batchId); const db = openStore(filename);
  try {
    const row = db.prepare("SELECT i.id,s.scope_json FROM imports i JOIN sources s ON s.id=i.source_id WHERE i.id=?").get(batchId) as Row | undefined;
    if (!row || !sourceAllowed(JSON.parse(String(row.scope_json)) as SourceDescriptor, grant)) fail("IMPORT_UNAVAILABLE");
    const batch = readBatch(db, batchId);
    if (!sourceAllowed(batch.source, grant)) fail("IMPORT_UNAVAILABLE");
    const entityIds = new Set<string>();
    for (const state of scopedSourceStates(db, grant)) if (state.source.id !== batch.source.id) {
      for (const e of readBatch(db, state.batchId).entities) if (recordAllowed(e.privacy, grant)) entityIds.add(e.id);
    }
    const entities = batch.entities.filter(e => recordAllowed(e.privacy, grant));
    for (const e of entities) entityIds.add(e.id);
    const evidence = batch.evidence.filter(e => recordAllowed(e.privacy, grant) && (e.entityId === undefined || entityIds.has(e.entityId))), evidenceIds = new Set(evidence.map(e => e.id));
    const assertions = batch.assertions.filter(a => recordAllowed(a.privacy, grant) && entityIds.has(a.subjectId) && entityIds.has(a.objectId) && a.evidenceIds.every(id => evidenceIds.has(id)));
    const needed = new Set(assertions.flatMap(a => a.evidenceIds));
    return { ...batch, entities, evidence: evidence.filter(e => needed.has(e.id) || (e.entityId !== undefined && entityIds.has(e.entityId))), assertions };
  } finally { db.close(); }
}
export function readImpactHistory(filename: string, value: ImpactGrant): Array<{ revision: number; event: string; actor: string; at: string; sourceId: string; batchId: string }> {
  const grant = validateGrant(value), db = openStore(filename);
  try {
    const rows = db.prepare("SELECT h.*,s.scope_json,i.source_json FROM history h JOIN sources s ON s.id=h.source_id JOIN imports i ON i.id=h.batch_id ORDER BY h.revision").all() as Row[];
    return rows.flatMap(r => sourceAllowed(JSON.parse(String(r.scope_json)) as SourceDescriptor, grant) && sourceAllowed(JSON.parse(String(r.source_json)) as SourceDescriptor, grant) ? [{ revision: Number(r.revision), event: String(r.event), actor: String(r.actor), at: String(r.at), sourceId: String(r.source_id), batchId: String(r.batch_id) }] : []);
  } finally { db.close(); }
}
export function saveReportRecord(filename: string, reportId: string, grantHash: string, graphRevision: number, json: string, now: string): void {
  mutate(filename, db => {
    expectRevision(db, graphRevision);
    const prior = db.prepare("SELECT * FROM reports WHERE id=?").get(reportId) as Row | undefined;
    if (prior) {
      if (prior.grant_hash !== grantHash || prior.graph_revision !== graphRevision || prior.report_json !== json) fail("REPORT_IDENTITY_CONFLICT");
      return;
    }
    db.prepare("INSERT INTO reports VALUES(?,?,?,?,?)").run(reportId, grantHash, graphRevision, json, now);
  });
}
/** Internal store boundary; use the scoped operator in review.ts. */
export interface ReviewRecordBinding {
  reportId: string; reportHash: string; grantHash: string; graphRevision: number; bindingHash: string;
}
function checkReviewBinding(db: DatabaseSync, binding: ReviewRecordBinding): void {
  expectRevision(db, binding.graphRevision);
  const row = db.prepare("SELECT * FROM reports WHERE id=? AND grant_hash=?").get(binding.reportId, binding.grantHash) as Row | undefined;
  if (!row || row.graph_revision !== binding.graphRevision || digest(JSON.parse(String(row.report_json))) !== binding.reportHash) fail("REPORT_UNAVAILABLE");
}
/** v1 read compatibility: a report has no operator review events until upgraded. */
export function readReviewRecords(filename: string, binding: ReviewRecordBinding): { reviewRevision: number; records: string[] } {
  const db = openStore(filename);
  try {
    db.exec("BEGIN");
    checkReviewBinding(db, binding);
    if (schemaVersion(db) === 1) { db.exec("COMMIT"); return { reviewRevision: 0, records: [] }; }
    const head = db.prepare("SELECT * FROM review_heads WHERE report_id=?").get(binding.reportId) as Row | undefined;
    if (head && head.binding_hash !== binding.bindingHash) fail("REVIEW_BINDING_MISMATCH");
    const records = (db.prepare("SELECT record_json FROM review_events WHERE report_id=? ORDER BY revision LIMIT 1001").all(binding.reportId) as Row[]).map(row => String(row.record_json));
    db.exec("COMMIT");
    return { reviewRevision: Number(head?.revision ?? 0), records };
  } finally { db.close(); }
}
/** Appends one event atomically; report/graph and review revisions are independent. */
export function appendReviewRecord(filename: string, binding: ReviewRecordBinding, expectedReviewRevision: number, json: string, recheckFreshness: () => void): void {
  mutate(filename, db => {
    if (schemaVersion(db) < SCHEMA_VERSION) fail("IMPACT_STORE_UPGRADE_REQUIRED");
    checkReviewBinding(db, binding);
    const head = db.prepare("SELECT * FROM review_heads WHERE report_id=?").get(binding.reportId) as Row | undefined;
    if (head && head.binding_hash !== binding.bindingHash) fail("REVIEW_BINDING_MISMATCH");
    const previous = Number(head?.revision ?? 0);
    if (previous !== boundedInteger(expectedReviewRevision, 0, Number.MAX_SAFE_INTEGER - 1)) fail("REVIEW_REVISION_CONFLICT");
    if (previous >= 1000) fail("REVIEW_CAPACITY_EXCEEDED");
    const record = JSON.parse(json) as { reportId: string; revision: number; bindingHash: string };
    if (record.reportId !== binding.reportId || record.bindingHash !== binding.bindingHash || record.revision !== previous + 1) fail("INVALID_REVIEW_RECORD");
    // Only the trusted owner provides this callback. It must be read-only. The
    // graph write lock stays held while live source evidence is checked again.
    recheckFreshness();
    if (!head) db.prepare("INSERT INTO review_heads VALUES(?,?,0)").run(binding.reportId, binding.bindingHash);
    db.prepare("INSERT INTO review_events VALUES(?,?,?)").run(binding.reportId, previous + 1, json);
    db.prepare("UPDATE review_heads SET revision=? WHERE report_id=?").run(previous + 1, binding.reportId);
  });
}
export function loadReportRecord(filename: string, reportId: string, grantHash: string): string {
  identifier(reportId); const db = openStore(filename);
  try {
    const row = db.prepare("SELECT report_json FROM reports WHERE id=? AND grant_hash=?").get(reportId, grantHash) as Row | undefined;
    if (!row) fail("REPORT_UNAVAILABLE");
    return textValue(row.report_json, 2 * 1024 * 1024);
  } finally { db.close(); }
}
export interface ImpactReportSummary { id: string; savedAt: string; graphRevision: number; }
/**
 * Opaque saved-report inventory for the exact current principal/policy scope.
 * No cached source labels, change text, findings or evidence leave this reader.
 * A listed report still requires canonical/freshness checks when it is opened.
 */
export function listImpactReportSummaries(filename: string, value: ImpactGrant, options: { limit?: number } = {}): { reports: ImpactReportSummary[]; truncated: boolean } {
  const grant = validateGrant(value), limit = boundedInteger(options.limit ?? 50, 1, 100);
  const db = openStore(filename);
  try {
    const rows = db.prepare("SELECT id,saved_at,graph_revision FROM reports WHERE grant_hash=? ORDER BY saved_at DESC,id DESC LIMIT ?")
      .all(grantFingerprint(grant), limit + 1) as Row[];
    return { reports: rows.slice(0, limit).map(row => ({ id: identifier(row.id), savedAt: timestamp(row.saved_at),
      graphRevision: boundedInteger(row.graph_revision, 0, Number.MAX_SAFE_INTEGER) })), truncated: rows.length > limit };
  } finally { db.close(); }
}


// Mapping storage is an additive LMIP owner. No DatabaseSync escapes this file.
const MAPPING_SCHEMA_SQL = `
CREATE TABLE mapping_store_identity (id INTEGER PRIMARY KEY CHECK(id=1), store_uuid TEXT NOT NULL,
 upgrade_operation_id TEXT NOT NULL, prior_snapshot_digest TEXT NOT NULL);
CREATE TABLE mapping_authorities (source_id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
 site_id TEXT NOT NULL, environment_id TEXT NOT NULL, source_kind TEXT NOT NULL CHECK(source_kind IN ('manifest','code','native')),
 minimum_classification TEXT NOT NULL CHECK(minimum_classification IN ('public','internal')),
 source_fingerprint TEXT NOT NULL, native_project_id TEXT NOT NULL, native_store_uuid TEXT NOT NULL,
 native_fingerprint TEXT NOT NULL, policy_version TEXT NOT NULL);
CREATE TABLE mapping_versions (batch_id TEXT PRIMARY KEY REFERENCES imports(id), source_id TEXT NOT NULL REFERENCES mapping_authorities(source_id),
 mapping_version TEXT NOT NULL, payload_digest TEXT NOT NULL, expected_accepted_version TEXT,
 source_fingerprint TEXT NOT NULL, native_fingerprint TEXT NOT NULL, native_revision INTEGER NOT NULL,
 diff_json TEXT NOT NULL, stage_operation_id TEXT NOT NULL, UNIQUE(source_id,mapping_version));
CREATE TABLE mapping_identity (mapping_id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES mapping_authorities(source_id),
 generation TEXT NOT NULL, project_id TEXT NOT NULL, store_uuid TEXT NOT NULL, target_kind TEXT NOT NULL,
 target_id TEXT NOT NULL, created_batch_id TEXT NOT NULL REFERENCES imports(id), retired_batch_id TEXT REFERENCES imports(id));
CREATE TABLE mapping_keys (source_id TEXT NOT NULL, external_key TEXT NOT NULL, generation TEXT NOT NULL,
 mapping_id TEXT NOT NULL REFERENCES mapping_identity(mapping_id), created_batch_id TEXT NOT NULL REFERENCES imports(id),
 PRIMARY KEY(source_id,external_key,generation));
CREATE TABLE mapping_rows (batch_id TEXT NOT NULL REFERENCES mapping_versions(batch_id), mapping_id TEXT NOT NULL REFERENCES mapping_identity(mapping_id),
 external_key TEXT NOT NULL, generation TEXT NOT NULL, aliases_json TEXT NOT NULL,
 classification TEXT NOT NULL CHECK(classification IN ('public','internal')),
 state TEXT NOT NULL CHECK(state IN ('active','retired')), impact_entity_id TEXT, replaces_mapping_id TEXT REFERENCES mapping_identity(mapping_id),
 payload_kind TEXT NOT NULL CHECK(payload_kind IN ('identity','code','document','memory')),
 project_id TEXT NOT NULL, store_uuid TEXT NOT NULL, target_kind TEXT NOT NULL, target_id TEXT NOT NULL,
 selection TEXT, reference_fingerprint TEXT, disclosure TEXT, submitted INTEGER NOT NULL CHECK(submitted IN (0,1)),
 PRIMARY KEY(batch_id,mapping_id),
 CHECK((payload_kind='identity' AND target_kind IN ('component','asset','subsystem','site','area','environment') AND selection IS NULL AND reference_fingerprint IS NULL AND disclosure IS NULL)
 OR (payload_kind='code' AND target_kind='repository' AND selection IS NOT NULL AND reference_fingerprint IS NOT NULL AND disclosure IS NULL)
 OR (payload_kind='document' AND target_kind='knowledge' AND selection IS NOT NULL AND reference_fingerprint IS NOT NULL AND disclosure IS NULL)
 OR (payload_kind='memory' AND target_kind='component' AND selection IS NULL AND reference_fingerprint IS NULL AND disclosure='owner_safe_summary')));
CREATE TABLE mapping_evidence (batch_id TEXT NOT NULL, mapping_id TEXT NOT NULL, evidence_id TEXT NOT NULL, evidence_batch_id TEXT NOT NULL,
 PRIMARY KEY(batch_id,mapping_id,evidence_id), FOREIGN KEY(batch_id,mapping_id) REFERENCES mapping_rows(batch_id,mapping_id),
 FOREIGN KEY(evidence_batch_id,evidence_id) REFERENCES evidence(batch_id,id));
CREATE TABLE mapping_operations (operation_id TEXT PRIMARY KEY, action TEXT NOT NULL CHECK(action IN ('upgrade','register_source','stage','accept','reject')),
 request_digest TEXT NOT NULL, scope_json TEXT NOT NULL, receipt_json TEXT NOT NULL);
CREATE TRIGGER mapping_operations_no_update BEFORE UPDATE ON mapping_operations BEGIN SELECT RAISE(ABORT, 'MAPPING_RECEIPT_IMMUTABLE'); END;
CREATE TRIGGER mapping_operations_no_delete BEFORE DELETE ON mapping_operations BEGIN SELECT RAISE(ABORT, 'MAPPING_RECEIPT_IMMUTABLE'); END;
CREATE INDEX mapping_versions_source ON mapping_versions(source_id);
CREATE INDEX mapping_identity_source ON mapping_identity(source_id);
CREATE INDEX mapping_keys_identity ON mapping_keys(mapping_id);
`;
const mappingTables = ['mapping_store_identity','mapping_authorities','mapping_versions','mapping_identity','mapping_keys','mapping_rows','mapping_evidence','mapping_operations'] as const;
const legacyTables = ['metadata','sources','imports','entity_identity','entity_keys','entities','evidence','assertions','history','reports','review_heads','review_events'] as const;
const expectedSchemas = new Map<number, Row[]>();
function mFail(code: import('./mapping.js').MappingCode): never { throw new MappingError(code); }
function mHash(domain: string, value: unknown): string { return createHash('sha256').update(domain+'\n'+canonicalMappingJson(value)).digest('hex'); }
function mInteger(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) mFail('INVALID_INPUT');
  return value;
}
function mUuid(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 36 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value) || value === '00000000-0000-0000-0000-000000000000') mFail('INVALID_INPUT');
  return value;
}
function mHex(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 64 || !/^[0-9a-f]{64}$/u.test(value)) mFail('OWNER_UNAVAILABLE');
  return value;
}
function mJson<T>(json: unknown): T {
  if (typeof json !== 'string' || Buffer.byteLength(json) > MAPPING_LIMITS.reviewBytes) mFail('OWNER_UNAVAILABLE');
  try { const result = JSON.parse(json); canonicalMappingJson(result); return result as T; } catch { return mFail('OWNER_UNAVAILABLE'); }
}
function mBounded<T>(rows: T[], max: number): T[] { if (rows.length > max) mFail('BUDGET_EXCEEDED'); return rows; }
function mSchemaRows(db: DatabaseSync): Row[] {
  return mBounded(db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name LIMIT 4097").all() as Row[], 4096);
}
function mSql(value: unknown): string { return typeof value === 'string' ? value.trim().replace(/\s+/gu, ' ') : ''; }
function mappingSchema(db: DatabaseSync): void {
  const version = schemaVersion(db);
  if (![1,2,3].includes(version)) mFail('UNSUPPORTED_FORMAT');
  let expected = expectedSchemas.get(version);
  if (!expected) {
    const ref = new DatabaseSync(':memory:');
    try {
      ref.exec(LEGACY_SCHEMA_SQL);
      if (version === 1) ref.exec('DROP TRIGGER review_events_no_update; DROP TRIGGER review_events_no_delete; DROP TABLE review_events; DROP TABLE review_heads;');
      if (version === 3) ref.exec(MAPPING_SCHEMA_SQL);
      expected = mSchemaRows(ref); expectedSchemas.set(version, expected);
    } finally { ref.close(); }
  }
  const actual = mSchemaRows(db), owned = new Set<string>([...legacyTables,...mappingTables]);
  for (const row of expected) {
    const found = actual.find(x => x.name === row.name);
    if (!found || found.type !== row.type || found.tbl_name !== row.tbl_name || mSql(found.sql) !== mSql(row.sql)) mFail('UNSUPPORTED_FORMAT');
  }
  for (const row of actual) {
    if ((owned.has(String(row.name)) || owned.has(String(row.tbl_name))) && !expected.some(x => x.name === row.name)) mFail('UNSUPPORTED_FORMAT');
    if (version < 3 && String(row.name).startsWith('mapping_')) mFail('UNSUPPORTED_FORMAT');
  }
}
function refuseManagedSource(db: DatabaseSync, sourceId: string): void {
  if (schemaVersion(db) === 3 && db.prepare('SELECT 1 FROM mapping_authorities WHERE source_id=?').get(sourceId)) fail('MAPPING_SOURCE_MANAGED');
}
function mStoreId(db: DatabaseSync): string {
  if (schemaVersion(db) !== 3) mFail('UNSUPPORTED_FORMAT');
  return mUuid((db.prepare('SELECT store_uuid FROM mapping_store_identity WHERE id=1').get() as Row | undefined)?.store_uuid);
}
function mFileIdentity(filename: string): string {
  const target = checkedPath(filename), stat = statSync(target, { bigint: true });
  return mHash('lmti.impact.mapping.file.v1', { path: target, dev: stat.dev.toString(), ino: stat.ino.toString(), birthtimeNs: stat.birthtimeNs.toString() });
}
function mSnapshot(db: DatabaseSync): { ownedSnapshotDigest: string; schemaCatalogDigest: string } {
  mappingSchema(db);
  const schemaCatalogDigest = mHash('lmti.impact.mapping.catalog.v1', mSchemaRows(db));
  const hash = createHash('sha256').update('lmti.impact.mapping.owned-snapshot.v1\n');
  let bytes = 0;
  const tables: readonly string[] = schemaVersion(db) === 3 ? [...legacyTables,...mappingTables] : schemaVersion(db) === 1 ? legacyTables.slice(0,-2) : legacyTables;
  for (const table of tables) {
    const columns = db.prepare(`PRAGMA table_info("${table}")`).all() as Row[];
    const keys = columns.filter(c => Number(c.pk) > 0).sort((a,b) => Number(a.pk)-Number(b.pk)).map(c => `"${c.name}"`);
    hash.update(canonicalMappingJson([table, columns])+'\n');
    for (const row of db.prepare(`SELECT * FROM "${table}" ORDER BY ${keys.join(',')}`).iterate()) {
      const encoded = canonicalMappingJson(row); bytes += Buffer.byteLength(encoded);
      if (bytes > MAPPING_LIMITS.logicalStoreBytes) mFail('BUDGET_EXCEEDED');
      hash.update(encoded+'\n');
    }
  }
  return { ownedSnapshotDigest: hash.digest('hex'), schemaCatalogDigest };
}
function mFormat(db: DatabaseSync, filename: string): MappingFormatPreview {
  const first = mFileIdentity(filename), snapshot = mSnapshot(db);
  if (mFileIdentity(filename) !== first) mFail('CONFIG_CHANGED');
  return { schema: 'lmti.impact.mapping.format.v1', applicationId: APPLICATION_ID,
    schemaVersion: schemaVersion(db) as 1|2|3, storeUuid: schemaVersion(db) === 3 ? mStoreId(db) : null,
    graphRevision: revision(db), sourceIdentityDigest: first, ...snapshot };
}
function mCount(db: DatabaseSync, table: typeof mappingTables[number], max: number): number {
  const n = Number((db.prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM ${table} LIMIT ?)`).get(max+1) as Row).n);
  if (n > max) mFail('BUDGET_EXCEEDED'); return n;
}
function mWriteLimit(db: DatabaseSync): void {
  const pageSize = Number((db.prepare('PRAGMA page_size').get() as Row).page_size);
  db.exec(`PRAGMA max_page_count=${Math.floor(MAPPING_LIMITS.logicalStoreBytes/pageSize)}`);
  if (Number((db.prepare('PRAGMA page_count').get() as Row).page_count)*pageSize > MAPPING_LIMITS.logicalStoreBytes) mFail('BUDGET_EXCEEDED');
}
function mClose(db: DatabaseSync): void { try { db.close(); } catch { /* No fallible post-commit readback. */ } }
function mRollback(db: DatabaseSync): void { try { db.exec('ROLLBACK'); } catch { /* Preserve original failure/unknown. */ } }
function mCommit(db: DatabaseSync, receipt: MappingReceipt, scope: MappingOperationScope, mutateRows: () => void): MappingWriteOutcome {
  const receiptJson = canonicalMappingJson(receipt), scopeJson = canonicalMappingJson(scope);
  if (Buffer.byteLength(receiptJson) > MAPPING_LIMITS.receiptBytes) mFail('BUDGET_EXCEEDED');
  if (mCount(db,'mapping_operations',MAPPING_LIMITS.operations) >= MAPPING_LIMITS.operations) mFail('BUDGET_EXCEEDED');
  const success: MappingWriteOutcome = { outcome: 'confirmed', receipt, replayed: false };
  const unknown: MappingWriteOutcome = { outcome: 'unknown', operationId: receipt.operationId, action: receipt.action, code: 'RECOVERY_REQUIRED', receipt: null };
  mutateRows();
  db.prepare('INSERT INTO mapping_operations VALUES(?,?,?,?,?)').run(receipt.operationId,receipt.action,receipt.requestDigest,scopeJson,receiptJson);
  try { db.exec('COMMIT'); } catch { mRollback(db); return unknown; }
  return success;
}

function mAuthorityRow(row: Row): MappingSourceAuthority {
  return { sourceId: String(row.source_id), projectId: String(row.project_id), siteId: String(row.site_id), environmentId: String(row.environment_id),
    kind: row.source_kind as MappingSourceAuthority['kind'], minimumClassification: row.minimum_classification as MappingSourceAuthority['minimumClassification'],
    sourceAuthorityFingerprint: String(row.source_fingerprint), nativeProjectId: String(row.native_project_id), nativeStoreUuid: String(row.native_store_uuid),
    nativeAuthorityFingerprint: String(row.native_fingerprint), policyVersion: String(row.policy_version) };
}
function mTarget(row: Row): MappingTarget {
  return { projectId: String(row.project_id), storeUuid: String(row.store_uuid), kind: row.target_kind as MappingTarget['kind'], id: String(row.target_id) };
}
function mEvidence(db: DatabaseSync, batchId: string): MappingEvidenceBinding[] {
  const rows = mBounded(db.prepare('SELECT m.mapping_id,m.evidence_id,m.evidence_batch_id,e.record_json FROM mapping_evidence m JOIN evidence e ON e.batch_id=m.evidence_batch_id AND e.id=m.evidence_id WHERE m.batch_id=? ORDER BY m.mapping_id,m.evidence_id LIMIT 40001').all(batchId) as Row[], 40000);
  return rows.map(r => ({ mappingId: String(r.mapping_id), evidenceId: String(r.evidence_id), evidenceBatchId: String(r.evidence_batch_id), evidence: mJson<ImpactEvidence>(r.record_json) }));
}
function mRows(db: DatabaseSync, batchId: string, submittedOnly = false): MappingRow[] {
  const rows = mBounded(db.prepare(`SELECT * FROM mapping_rows WHERE batch_id=? ${submittedOnly ? 'AND submitted=1' : ''} ORDER BY mapping_id LIMIT 2001`).all(batchId) as Row[], 2000);
  const evidence = mEvidence(db,batchId);
  return rows.map(r => {
    const common = { mappingId: String(r.mapping_id), externalKey: String(r.external_key), generation: String(r.generation), aliases: mJson<string[]>(r.aliases_json),
      classification: r.classification as MappingRow['classification'], evidenceIds: evidence.filter(e => e.mappingId === r.mapping_id).map(e => e.evidenceId),
      state: r.state as MappingRow['state'], impactEntityId: r.impact_entity_id === null ? null : String(r.impact_entity_id), replacesMappingId: r.replaces_mapping_id === null ? null : String(r.replaces_mapping_id),
      kind: String(r.payload_kind), target: mTarget(r) };
    if (r.payload_kind === 'code' || r.payload_kind === 'document') return { ...common, selection: String(r.selection), referenceFingerprint: String(r.reference_fingerprint) } as MappingRow;
    if (r.payload_kind === 'memory') return { ...common, disclosure: 'owner_safe_summary' } as MappingRow;
    return common as MappingRow;
  });
}
function mVersion(db: DatabaseSync, batchId: string): MappingVersionSnapshot | null {
  const row = db.prepare('SELECT * FROM mapping_versions WHERE batch_id=?').get(batchId) as Row | undefined;
  if (!row) return null;
  return { batchId, mappingVersion: String(row.mapping_version), payloadDigest: String(row.payload_digest), input: readBatch(db,batchId), mappings: mRows(db,batchId), evidenceBindings: mEvidence(db,batchId) };
}
function mInput(db: DatabaseSync, batchId: string): MappingImport {
  const row = db.prepare('SELECT * FROM mapping_versions WHERE batch_id=?').get(batchId) as Row | undefined;
  if (!row) mFail('SCOPE_DENIED');
  return normalizeMappingImport({ schema: 'lmti.impact.mapping-import.v1', input: readBatch(db,batchId), mappingVersion: row.mapping_version,
    payloadDigest: row.payload_digest, expectedAcceptedVersion: row.expected_accepted_version, mappings: mRows(db,batchId,true) });
}
function mBefore(db: DatabaseSync, authority: MappingSourceAuthority, excludeBatch = ''): MappingBeforeState {
  const head = db.prepare('SELECT * FROM sources WHERE id=?').get(authority.sourceId) as Row | undefined;
  const accepted = head?.accepted_batch_id ? String(head.accepted_batch_id) : null;
  const identityRows = mBounded(db.prepare('SELECT * FROM mapping_identity WHERE source_id=? AND created_batch_id != ? ORDER BY mapping_id LIMIT 20001').all(authority.sourceId,excludeBatch) as Row[],20000);
  const keyRows = mBounded(db.prepare('SELECT * FROM mapping_keys WHERE source_id=? AND created_batch_id != ? ORDER BY external_key,generation LIMIT 40001').all(authority.sourceId,excludeBatch) as Row[],40000);
  const authorities = mBounded(db.prepare('SELECT * FROM mapping_authorities ORDER BY source_id LIMIT 201').all() as Row[],200);
  const excludedIdentities = excludeBatch ? Number((db.prepare('SELECT COUNT(*) AS n FROM mapping_identity WHERE created_batch_id=?').get(excludeBatch) as Row).n) : 0;
  const excludedKeys = excludeBatch ? Number((db.prepare('SELECT COUNT(*) AS n FROM mapping_keys WHERE created_batch_id=?').get(excludeBatch) as Row).n) : 0;
  const excludedVersion = excludeBatch && db.prepare('SELECT 1 FROM mapping_versions WHERE batch_id=?').get(excludeBatch) ? 1 : 0;
  return { storeUuid: mStoreId(db), graphRevision: revision(db), authority,
    acceptedImport: accepted ? readBatch(db,accepted) : null, acceptedMapping: accepted ? mVersion(db,accepted) : null,
    latestBatchId: head ? String(head.latest_batch_id) : null,
    identities: identityRows.map(r => ({ mappingId: String(r.mapping_id), sourceId: String(r.source_id), generation: String(r.generation), target: mTarget(r), createdBatchId: String(r.created_batch_id), retiredBatchId: r.retired_batch_id === null ? null : String(r.retired_batch_id) })),
    keys: keyRows.map(r => ({ sourceId: String(r.source_id), key: String(r.external_key), generation: String(r.generation), mappingId: String(r.mapping_id) })),
    capacity: { registeredSources: authorities.length, versions: mCount(db,'mapping_versions',1000)-excludedVersion, identities: mCount(db,'mapping_identity',20000)-excludedIdentities, keys: mCount(db,'mapping_keys',40000)-excludedKeys, operations: mCount(db,'mapping_operations',2500), authoritiesBytes: Buffer.byteLength(canonicalMappingJson(authorities.map(mAuthorityRow))) } };
}
function mRequestedTargets(before: MappingBeforeState, input: MappingImport): MappingTarget[] {
  const rows = [...(before.acceptedMapping?.mappings ?? []),...input.mappings];
  const targets = new Map<string,MappingTarget>();
  for (const row of rows) targets.set(canonicalMappingJson([row.target.projectId,row.target.storeUuid,row.target.kind,row.target.id]), row.target);
  return [...targets].sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([,v]) => v);
}
function mInsertTransition(db: DatabaseSync, input: MappingImport, transition: MappingTransition, observations: MappingObservations, operationId: string): void {
  const batch = transition.candidate.batchId, source = input.input.source.id;
  // SQL reservation ownership is global even though the pure original view is source-scoped.
  for (const identity of transition.reserveIdentities) if (db.prepare('SELECT 1 FROM mapping_identity WHERE mapping_id=?').get(identity.mappingId)) mFail('IDENTITY_CONFLICT');
  db.prepare('INSERT INTO mapping_versions VALUES(?,?,?,?,?,?,?,?,?,?)').run(batch,source,input.mappingVersion,input.payloadDigest,input.expectedAcceptedVersion,
    observations.source.fingerprint,observations.native.fingerprint,observations.native.revision,canonicalMappingJson(transition.diff),operationId);
  for (const i of transition.reserveIdentities) db.prepare('INSERT INTO mapping_identity VALUES(?,?,?,?,?,?,?,?,?)').run(i.mappingId,i.sourceId,i.generation,i.target.projectId,i.target.storeUuid,i.target.kind,i.target.id,batch,null);
  for (const k of transition.reserveKeys) db.prepare('INSERT INTO mapping_keys VALUES(?,?,?,?,?)').run(k.sourceId,k.key,k.generation,k.mappingId,batch);
  const supplied = new Set(input.mappings.map(r => r.mappingId));
  for (const r of transition.candidate.mappings) db.prepare('INSERT INTO mapping_rows VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(batch,r.mappingId,r.externalKey,r.generation,
    canonicalMappingJson(r.aliases),r.classification,r.state,r.impactEntityId,r.replacesMappingId,r.kind,r.target.projectId,r.target.storeUuid,r.target.kind,r.target.id,
    'selection' in r ? r.selection : null,'referenceFingerprint' in r ? r.referenceFingerprint : null,'disclosure' in r ? r.disclosure : null,supplied.has(r.mappingId) ? 1 : 0);
  for (const e of transition.evidenceBindings) {
    const row = db.prepare('SELECT e.record_json,i.source_id FROM evidence e JOIN imports i ON i.id=e.batch_id WHERE e.batch_id=? AND e.id=?').get(e.evidenceBatchId,e.evidenceId) as Row | undefined;
    if (!row || row.source_id !== source || canonicalMappingJson(mJson(row.record_json)) !== canonicalMappingJson(e.evidence)) mFail('IDENTITY_CONFLICT');
    db.prepare('INSERT INTO mapping_evidence VALUES(?,?,?,?)').run(batch,e.mappingId,e.evidenceId,e.evidenceBatchId);
  }
}
function mClassification(input: MappingImport, before?: MappingBeforeState): 'public'|'internal' {
  const imports = [input.input,...(before?.acceptedImport ? [before.acceptedImport] : [])];
  return imports.some(i => i.source.privacy === 'internal' || [...i.entities,...i.evidence,...i.assertions].some(r => r.privacy === 'internal'))
    || [...input.mappings,...(before?.acceptedMapping?.mappings ?? [])].some(r => r.classification === 'internal')
    || before?.acceptedMapping?.evidenceBindings.some(e => e.evidence.privacy === 'internal') ? 'internal' : 'public';
}

/** Package-private facade: returns typed operations, never a SQL handle. */
export function createMappingStoreOperator(config: MappingOperatorConfig): MappingOperator {
  const grant = config.grant as ImpactGrant, grantHash = grantFingerprint(grant);
  const configured = new Map(config.authorities.map(a => [a.sourceId,a]));
  const authorize = () => config.observers.authorize();
  function currentAuthority(sourceId: string): MappingSourceAuthority {
    const a = configured.get(sourceId);
    if (!a || grant.projectId !== a.projectId || !grant.siteIds.includes(a.siteId) || !grant.environmentIds.includes(a.environmentId) || (!grant.allowInternal && a.minimumClassification === 'internal')) mFail('SCOPE_DENIED');
    return a;
  }
  function registered(db: DatabaseSync, sourceId: string): MappingSourceAuthority {
    const a = currentAuthority(sourceId), row = db.prepare('SELECT * FROM mapping_authorities WHERE source_id=?').get(sourceId) as Row | undefined;
    if (!row || canonicalMappingJson(mAuthorityRow(row)) !== canonicalMappingJson(a)) mFail('SCOPE_DENIED');
    return a;
  }
  function scope(a: MappingSourceAuthority, classification: 'public'|'internal'): MappingReceiptScope {
    if (!grant.allowInternal && classification === 'internal') mFail('SCOPE_DENIED');
    return { authority: a, grantFingerprint: grantHash, principalId: grant.principalId, classification };
  }
  function maintenance(): MappingOperationScope {
    if (!config.maintenance) mFail('SCOPE_DENIED');
    return { kind: 'maintenance', capabilityId: config.maintenance.capabilityId, policyVersion: config.maintenance.policyVersion, principalId: grant.principalId, grantFingerprint: grantHash };
  }
  function canReadScope(value: MappingOperationScope): boolean {
    if (value?.kind === 'maintenance') return !!config.maintenance && canonicalMappingJson(value) === canonicalMappingJson(maintenance());
    if (value?.kind !== 'source' || !value.scope || Object.keys(value).sort().join() !== 'kind,scope' ||
        Object.keys(value.scope).sort().join() !== 'authority,classification,grantFingerprint,principalId' ||
        !['public','internal'].includes(value.scope.classification) ||
        value.scope.principalId !== grant.principalId || value.scope.grantFingerprint !== grantHash || (!grant.allowInternal && value.scope.classification !== 'public')) return false;
    try { return canonicalMappingJson(currentAuthority(value.scope.authority.sourceId)) === canonicalMappingJson(value.scope.authority); } catch { return false; }
  }
  function receiptRow(db: DatabaseSync, operationId: string): { receipt: MappingReceipt; scope: MappingOperationScope } | null {
    const row = db.prepare('SELECT * FROM mapping_operations WHERE operation_id=?').get(operationId) as Row | undefined;
    if (!row) return null;
    const original = mJson<MappingOperationScope>(row.scope_json);
    if (!canReadScope(original)) return null;
    const result = mJson<MappingReceipt>(row.receipt_json);
    const keys = ['schema','operationId','action','requestDigest','storeUuid','sourceId','batchId','mappingVersion','payloadDigest','graphRevisionBefore','graphRevisionAfter','decision','committedAt','upgrade'];
    if (!result || Object.keys(result).sort().join() !== keys.sort().join() || result.schema !== 'lmti.impact.mapping.receipt.v1' || result.operationId !== operationId || result.action !== row.action || result.requestDigest !== row.request_digest || result.storeUuid !== mStoreId(db) || Buffer.byteLength(String(row.receipt_json)) > 8192) mFail('OWNER_UNAVAILABLE');
    mUuid(result.operationId); mUuid(result.storeUuid); mInteger(result.graphRevisionBefore); mInteger(result.graphRevisionAfter); timestamp(result.committedAt);
    mHex(result.requestDigest);
    const decisions = { upgrade: 'format_upgraded', register_source: 'source_registered', stage: 'pending', accept: 'accepted', reject: 'rejected' } as const;
    if (typeof result.action !== 'string' || !Object.hasOwn(decisions,result.action) || result.decision !== decisions[result.action] || (result.action === 'upgrade' ? result.graphRevisionAfter !== result.graphRevisionBefore : result.graphRevisionAfter !== result.graphRevisionBefore+1)) mFail('OWNER_UNAVAILABLE');
    if (result.action === 'upgrade') {
      if (result.sourceId !== null || result.batchId !== null || result.mappingVersion !== null || result.payloadDigest !== null ||
          !result.upgrade || Object.keys(result.upgrade).sort().join() !== 'backupIdentityDigest,backupSnapshotDigest,originalSnapshotDigest') mFail('OWNER_UNAVAILABLE');
      mHex(result.upgrade.originalSnapshotDigest); mHex(result.upgrade.backupSnapshotDigest); mHex(result.upgrade.backupIdentityDigest);
      if (result.upgrade.originalSnapshotDigest !== result.upgrade.backupSnapshotDigest) mFail('OWNER_UNAVAILABLE');
    } else {
      identifier(result.sourceId);
      if (result.upgrade !== null) mFail('OWNER_UNAVAILABLE');
      if (result.action === 'register_source') {
        if (result.batchId !== null || result.mappingVersion !== null || result.payloadDigest !== null) mFail('OWNER_UNAVAILABLE');
      } else {
        identifier(result.batchId); identifier(result.mappingVersion); mHex(result.payloadDigest);
        if (result.batchId !== 'mapping-'+createHash('sha256').update('lmti.impact.mapping.batch.v1\n'+result.payloadDigest).digest('hex')) mFail('OWNER_UNAVAILABLE');
      }
    }
    if (original.kind === 'source' && result.sourceId !== original.scope.authority.sourceId) mFail('OWNER_UNAVAILABLE');
    if (original.kind === 'maintenance' && (result.action !== 'upgrade' || result.sourceId !== null)) mFail('OWNER_UNAVAILABLE');
    return { receipt: result, scope: original };
  }
  function replay(db: DatabaseSync, operationId: string, action: MappingReceipt['action'], requestDigest: string): MappingWriteOutcome | null {
    const exists = db.prepare('SELECT 1 FROM mapping_operations WHERE operation_id=?').get(operationId);
    if (!exists) return null;
    const old = receiptRow(db,operationId);
    if (!old) mFail('SCOPE_DENIED');
    if (old.receipt.action !== action || old.receipt.requestDigest !== requestDigest) mFail('VERSION_CONFLICT');
    return { outcome: 'confirmed', receipt: old.receipt, replayed: true };
  }
  function baseReceipt(db: DatabaseSync, action: MappingReceipt['action'], operationId: string, requestDigest: string, sourceId: string | null, input: MappingImport | null, at: string): MappingReceipt {
    const previous = mInteger(revision(db), Number.MAX_SAFE_INTEGER-1);
    const decision = { upgrade: 'format_upgraded', register_source: 'source_registered', stage: 'pending', accept: 'accepted', reject: 'rejected' } as const;
    return { schema: 'lmti.impact.mapping.receipt.v1', operationId, action, requestDigest, storeUuid: mStoreId(db), sourceId,
      batchId: input ? 'mapping-'+createHash('sha256').update('lmti.impact.mapping.batch.v1\n'+input.payloadDigest).digest('hex') : null,
      mappingVersion: input?.mappingVersion ?? null, payloadDigest: input?.payloadDigest ?? null,
      graphRevisionBefore: previous, graphRevisionAfter: previous+1, decision: decision[action], committedAt: at, upgrade: null };
  }
  function begin(write: boolean): DatabaseSync {
    const db = openStore(config.storePath,write);
    try {
      if (schemaVersion(db) !== 3) mFail('UNSUPPORTED_FORMAT');
      if (write) mWriteLimit(db);
      db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
      // The schema accepted for this operation must be the schema protected by
      // its transaction, not only the catalog observed while opening the file.
      mappingSchema(db);
      return db;
    } catch (error) { mClose(db); throw error; }
  }
  function mExpected(db: DatabaseSync, expected: number): void { if (revision(db) !== mInteger(expected)) mFail('REVISION_CONFLICT'); }
  function requireCompleteVisibility(db: DatabaseSync, input: MappingImport, before: MappingBeforeState, a: MappingSourceAuthority): void {
    if (input.input.source.id !== a.sourceId || ['projectId','siteId','environmentId','kind'].some(k => input.input.source[k as keyof SourceDescriptor] !== (k === 'kind' ? a.kind : a[k as keyof MappingSourceAuthority]))) mFail('SCOPE_DENIED');
    scope(a,mClassification(input,before));
    const head = db.prepare('SELECT scope_json FROM sources WHERE id=?').get(a.sourceId) as Row|undefined;
    if (head && !sourceAllowed(mJson<SourceDescriptor>(head.scope_json),grant)) mFail('SCOPE_DENIED');
    const foreignVisible = new Set<string>();
    for (const state of scopedSourceStates(db,grant)) if (state.source.id !== a.sourceId) {
      for (const entity of readBatch(db,state.batchId).entities) if (recordAllowed(entity.privacy,grant)) foreignVisible.add(entity.id);
    }
    for (const full of [input.input,...(before.acceptedImport ? [before.acceptedImport] : [])]) {
      if (!sourceAllowed(full.source,grant) || [...full.entities,...full.evidence,...full.assertions].some(row=>!recordAllowed(row.privacy,grant))) mFail('SCOPE_DENIED');
      const visible = new Set([...foreignVisible,...full.entities.map(row=>row.id)]);
      if (full.assertions.some(row=>!visible.has(row.subjectId)||!visible.has(row.objectId))) mFail('SCOPE_DENIED');
    }
  }
  async function observe(db: DatabaseSync, phase: 'stage'|'preview'|'accept', a: MappingSourceAuthority, before: MappingBeforeState, input: MappingImport): Promise<MappingObservations> {
    requireCompleteVisibility(db,input,before,a);
    const controller = new AbortController();
    const result = await config.observers.observe({ phase, authority: a, sourceRevision: input.input.source.revision, sourceDigest: input.input.source.digest, targets: mRequestedTargets(before,input) }, { signal: controller.signal, timeoutMilliseconds: 30000 });
    authorize(); return result;
  }
  function transition(before: MappingBeforeState, a: MappingSourceAuthority, input: MappingImport, observations: MappingObservations): MappingTransition {
    return transitionMapping(before,{ grant,authority:a,grantFingerprint:grantHash } satisfies MappingScope,input,observations);
  }
  function buildReview(db: DatabaseSync, a: MappingSourceAuthority, input: MappingImport, before: MappingBeforeState, changed: MappingTransition, observations: MappingObservations): MappingReview {
    const content = { schema: 'lmti.impact.mapping.review.v1' as const, storeUuid: mStoreId(db), graphRevision: revision(db), scope: scope(a,mClassification(input,before)),
      batchId: changed.candidate.batchId, mappingVersion: input.mappingVersion, payloadDigest: input.payloadDigest, expectedAcceptedVersion: input.expectedAcceptedVersion,
      sourceFingerprint: observations.source.fingerprint, nativeFingerprint: observations.native.fingerprint, nativeRevision: observations.native.revision, diff: changed.diff, diffDigest: changed.diffDigest };
    const result: MappingReview = { ...content, reviewDigest: mHash('lmti.impact.mapping.review.v1',content) };
    if (Buffer.byteLength(canonicalMappingJson(result)) > MAPPING_LIMITS.reviewBytes) mFail('BUDGET_EXCEEDED');
    return result;
  }
  function checkLatest(db: DatabaseSync, batchId: string, sourceId: string): void {
    const row = db.prepare('SELECT i.state,s.latest_batch_id FROM imports i JOIN sources s ON s.id=i.source_id WHERE i.id=? AND i.source_id=?').get(batchId,sourceId) as Row | undefined;
    if (!row || row.state !== 'pending' || row.latest_batch_id !== batchId) mFail('VERSION_CONFLICT');
  }
  return {
    inspectMappingFormat() {
      authorize(); maintenance(); const db = openStore(config.storePath);
      try { db.exec('BEGIN'); const result = mFormat(db,config.storePath); authorize(); db.exec('COMMIT'); return result; }
      finally { mClose(db); }
    },
    upgradeMappings(expected,operationId) {
      mUuid(operationId); canonicalMappingJson(expected); authorize(); const originalScope = maintenance();
      const requestDigest = mHash('lmti.impact.mapping.operation.v1',{ action:'upgrade',expected,operationId,backupPath:config.maintenance!.backupPath });
      const db = openStore(config.storePath,true);
      try {
        if (schemaVersion(db) === 3) { const prior = replay(db,operationId,'upgrade',requestDigest); if (prior) return prior; mFail('UNSUPPORTED_FORMAT'); }
        if (schemaVersion(db) !== 2 || expected.schemaVersion !== 2 || expected.storeUuid !== null) mFail('UNSUPPORTED_FORMAT');
        db.exec('BEGIN'); const actual = mFormat(db,config.storePath); db.exec('COMMIT');
        if (canonicalMappingJson(actual) !== canonicalMappingJson(expected)) mFail('CONFIG_CHANGED');
        const dataVersion = Number((db.prepare('PRAGMA data_version').get() as Row).data_version);
        const destination = checkedPath(config.maintenance!.backupPath,true);
        if (destination.toLowerCase() === checkedPath(config.storePath).toLowerCase() || existsSync(destination)) mFail('BACKUP_CONFLICT');
        closeSync(openSync(destination,'wx',0o600));
        db.prepare('VACUUM INTO ?').run(destination);
        const backup = openStore(destination);
        let verified: ReturnType<typeof mSnapshot>;
        try {
          backup.exec('BEGIN');
          if (schemaVersion(backup) !== 2 || (backup.prepare('PRAGMA integrity_check').get() as Row).integrity_check !== 'ok') mFail('BACKUP_VERIFICATION_FAILED');
          verified = mSnapshot(backup);
          if (verified.ownedSnapshotDigest !== expected.ownedSnapshotDigest || verified.schemaCatalogDigest !== expected.schemaCatalogDigest) mFail('BACKUP_VERIFICATION_FAILED');
          backup.exec('COMMIT');
        } finally { mClose(backup); }
        const storeUuid = randomUUID(), at = timestamp(config.clock());
        const receipt: MappingReceipt = { schema:'lmti.impact.mapping.receipt.v1', operationId,action:'upgrade',requestDigest,storeUuid,
          sourceId:null,batchId:null,mappingVersion:null,payloadDigest:null,graphRevisionBefore:expected.graphRevision,graphRevisionAfter:expected.graphRevision,
          decision:'format_upgraded',committedAt:at,upgrade:{ originalSnapshotDigest:expected.ownedSnapshotDigest,backupSnapshotDigest:verified.ownedSnapshotDigest,backupIdentityDigest:mFileIdentity(destination) } };
        const receiptJson = canonicalMappingJson(receipt), scopeJson = canonicalMappingJson(originalScope);
        if (Buffer.byteLength(receiptJson)>8192) mFail('BUDGET_EXCEEDED');
        const success: MappingWriteOutcome = { outcome:'confirmed',receipt,replayed:false };
        const unknown: MappingWriteOutcome = { outcome:'unknown',operationId,action:'upgrade',code:'RECOVERY_REQUIRED',receipt:null };
        mWriteLimit(db); db.exec('BEGIN IMMEDIATE'); authorize();
        if (Number((db.prepare('PRAGMA data_version').get() as Row).data_version)!==dataVersion || canonicalMappingJson(mFormat(db,config.storePath))!==canonicalMappingJson(expected)) mFail('CONFIG_CHANGED');
        db.exec(MAPPING_SCHEMA_SQL);
        db.prepare('INSERT INTO mapping_store_identity VALUES(1,?,?,?)').run(storeUuid,operationId,expected.ownedSnapshotDigest);
        db.prepare('INSERT INTO mapping_operations VALUES(?,?,?,?,?)').run(operationId,'upgrade',requestDigest,scopeJson,receiptJson);
        db.exec('PRAGMA user_version=3');
        try { db.exec('COMMIT'); } catch { mRollback(db); return unknown; }
        return success;
      } catch(error) { mRollback(db); throw error; } finally { mClose(db); }
    },
    registerSource(sourceId,expectedGraphRevision,operationId) {
      identifier(sourceId); mInteger(expectedGraphRevision); mUuid(operationId); authorize();
      const requestDigest=mHash('lmti.impact.mapping.operation.v1',{action:'register_source',sourceId,expectedGraphRevision,operationId}),db=begin(true);
      try {
        const old=replay(db,operationId,'register_source',requestDigest); if(old){mRollback(db);return old;}
        const a=currentAuthority(sourceId); mExpected(db,expectedGraphRevision);
        if(db.prepare('SELECT 1 FROM mapping_authorities WHERE source_id=?').get(sourceId))mFail('VERSION_CONFLICT');
        if(mCount(db,'mapping_authorities',200)>=200)mFail('BUDGET_EXCEEDED');
        const all=mBounded(db.prepare('SELECT * FROM mapping_authorities ORDER BY source_id LIMIT 201').all() as Row[],200).map(mAuthorityRow);
        if(Buffer.byteLength(canonicalMappingJson([...all,a]))>131072)mFail('BUDGET_EXCEEDED');
        const head=db.prepare('SELECT scope_json FROM sources WHERE id=?').get(sourceId) as Row|undefined;
        if(head){
          const prior=mJson<SourceDescriptor>(head.scope_json);
          if(!sourceAllowed(prior,grant))mFail('SCOPE_DENIED');
          if(['projectId','siteId','environmentId','kind'].some(k=>prior[k as keyof SourceDescriptor]!==a[k as keyof MappingSourceAuthority]))mFail('IDENTITY_CONFLICT');
        }
        const at=timestamp(config.clock()),receipt=baseReceipt(db,'register_source',operationId,requestDigest,sourceId,null,at);
        authorize(); return mCommit(db,receipt,{kind:'source',scope:scope(a,a.minimumClassification)},()=>{
          db.prepare('INSERT INTO mapping_authorities VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(a.sourceId,a.projectId,a.siteId,a.environmentId,a.kind,a.minimumClassification,a.sourceAuthorityFingerprint,a.nativeProjectId,a.nativeStoreUuid,a.nativeAuthorityFingerprint,a.policyVersion);
          bump(db,'mapping-source-registered',grant.principalId,sourceId,'',at);
        });
      }catch(error){mRollback(db);throw error;}finally{mClose(db);}
    },
    async stageComplete(value,expectedGraphRevision,operationId) {
      const input=normalizeMappingImport(value);mInteger(expectedGraphRevision);mUuid(operationId);authorize();
      const requestDigest=mHash('lmti.impact.mapping.operation.v1',{action:'stage',input,expectedGraphRevision,operationId}),db=begin(true);
      try{
        const old=replay(db,operationId,'stage',requestDigest);if(old){mRollback(db);return old;}
        const a=registered(db,input.input.source.id);
        const version=db.prepare('SELECT stage_operation_id,payload_digest FROM mapping_versions WHERE source_id=? AND mapping_version=?').get(a.sourceId,input.mappingVersion) as Row|undefined;
        if(version){const original=receiptRow(db,String(version.stage_operation_id));if(!original)mFail('SCOPE_DENIED');if(version.payload_digest!==input.payloadDigest)mFail('VERSION_CONFLICT');mRollback(db);return{outcome:'confirmed',receipt:original.receipt,replayed:true};}
        mExpected(db,expectedGraphRevision);const before=mBefore(db,a),observations=await observe(db,'stage',a,before,input),changed=transition(before,a,input,observations);
        const at=timestamp(config.clock()),receipt=baseReceipt(db,'stage',operationId,requestDigest,a.sourceId,input,at);
        // Validate complete review size at staging too, before any first DML.
        buildReview(db,a,input,before,changed,observations);authorize();
        return mCommit(db,receipt,{kind:'source',scope:scope(a,mClassification(input,before))},()=>{
          stageImportOnConnection(db,validateImport(input.input),{mode:'mapping_managed',batchId:changed.candidate.batchId,contentHash:input.payloadDigest,actor:grant.principalId,now:at});
          mInsertTransition(db,input,changed,observations,operationId);
        });
      }catch(error){mRollback(db);throw error;}finally{mClose(db);}
    },
    async preview(batchId) {
      identifier(batchId);authorize();const db=begin(false);
      try{
        const row=db.prepare('SELECT source_id FROM mapping_versions WHERE batch_id=?').get(batchId) as Row|undefined;if(!row)mFail('SCOPE_DENIED');
        const a=registered(db,String(row.source_id));checkLatest(db,batchId,a.sourceId);
        const input=mInput(db,batchId),before=mBefore(db,a,batchId),observations=await observe(db,'preview',a,before,input),changed=transition(before,a,input,observations);
        const result=buildReview(db,a,input,before,changed,observations);authorize();db.exec('COMMIT');return result;
      }finally{mClose(db);}
    },
    async decide(review,decision,operationId) {
      mUuid(operationId);canonicalMappingJson(review);if(decision!=='accept'&&decision!=='reject')mFail('INVALID_INPUT');authorize();
      const requestDigest=mHash('lmti.impact.mapping.operation.v1',{action:decision,review,operationId}),db=begin(true);
      try{
        const old=replay(db,operationId,decision,requestDigest);if(old){mRollback(db);return old;}
        if(!review||review.schema!=='lmti.impact.mapping.review.v1'||!canReadScope({kind:'source',scope:review.scope}))mFail('SCOPE_DENIED');
        const {reviewDigest,...body}=review;if(mHash('lmti.impact.mapping.review.v1',body)!==reviewDigest)mFail('INVALID_INPUT');
        if(review.storeUuid!==mStoreId(db))mFail('CONFIG_CHANGED');mExpected(db,review.graphRevision);
        const a=registered(db,review.scope.authority.sourceId);checkLatest(db,review.batchId,a.sourceId);
        const input=mInput(db,review.batchId),before=mBefore(db,a,review.batchId);requireCompleteVisibility(db,input,before,a);
        const persisted=db.prepare('SELECT diff_json FROM mapping_versions WHERE batch_id=?').get(review.batchId) as Row;
        if(input.mappingVersion!==review.mappingVersion||input.payloadDigest!==review.payloadDigest||input.expectedAcceptedVersion!==review.expectedAcceptedVersion||mHash('lmti.impact.mapping.diff.v1',review.diff)!==review.diffDigest||canonicalMappingJson(mJson(persisted.diff_json))!==canonicalMappingJson(review.diff))mFail('CONFIG_CHANGED');
        let changed:MappingTransition|null=null;
        if(decision==='accept'){
          const observations=await observe(db,'accept',a,before,input);changed=transition(before,a,input,observations);
          if(observations.source.fingerprint!==review.sourceFingerprint)mFail('SOURCE_CHANGED');
          if(observations.native.fingerprint!==review.nativeFingerprint||observations.native.revision!==review.nativeRevision)mFail('NATIVE_CHANGED');
          if(canonicalMappingJson(buildReview(db,a,input,before,changed,observations))!==canonicalMappingJson(review))mFail('CONFIG_CHANGED');
          const foreign=existingEntityMap(db,a.sourceId),all=new Map([...foreign].map(([id,e])=>[id,e.record]));
          for(const e of input.input.entities)all.set(e.id,e as ImpactEntity);for(const assertion of input.input.assertions)validatePredicate(assertion as ImpactAssertion,all);
        }
        const at=timestamp(config.clock()),receipt=baseReceipt(db,decision,operationId,requestDigest,a.sourceId,input,at);authorize();
        return mCommit(db,receipt,{kind:'source',scope:scope(a,mClassification(input,before))},()=>{
          if(decision==='accept'){
            db.prepare('UPDATE sources SET accepted_batch_id=? WHERE id=?').run(review.batchId,a.sourceId);
            for(const id of changed!.retireOnAccept)db.prepare('UPDATE mapping_identity SET retired_batch_id=? WHERE mapping_id=? AND retired_batch_id IS NULL').run(review.batchId,id);
          }
          db.prepare('UPDATE imports SET state=?,reviewed_at=?,reviewer=? WHERE id=?').run(decision==='accept'?'accepted':'rejected',at,grant.principalId,review.batchId);
          bump(db,decision==='accept'?'mapping-accepted':'mapping-rejected',grant.principalId,a.sourceId,review.batchId,at);
        });
      }catch(error){mRollback(db);throw error;}finally{mClose(db);}
    },
    receipt(operationId) {
      mUuid(operationId);authorize();const db=begin(false);
      try{const result=receiptRow(db,operationId)?.receipt??null;authorize();db.exec('COMMIT');return result;}finally{mClose(db);}
    },
  };
}

/** Package-private current-reader seam. The returned data owns its complete
 * snapshot; no DatabaseSync, statement, cursor or transaction crosses an await.
 * Foreign policy queries are restricted to this source's assertion endpoints. */
export function captureMappingCurrent(options: {
  storePath: string; storeUuid: string; sourceIdentityDigest: string;
  grant: ImpactGrant; authority: MappingSourceAuthority; authorize: () => void;
}): MappingCurrentCapture {
  const cap=4194304, grant=options.grant, authority=options.authority;
  let db:DatabaseSync|undefined;
  let charged=0;
  const dependencies:unknown[]=[];
  const same=(a:unknown,b:unknown)=>canonicalMappingJson(a)===canonicalMappingJson(b);
  function charge(bytes:number):void {
    if(!Number.isSafeInteger(bytes)||bytes<0)mFail('OWNER_UNAVAILABLE');
    charged+=bytes;if(charged>cap)mFail('BUDGET_EXCEEDED');
  }
  function data<T>(raw:unknown):T {
    if(typeof raw!=='string')mFail('OWNER_UNAVAILABLE');
    charge(Buffer.byteLength(raw));return mJson<T>(raw);
  }
  function stored<T>(operation:()=>T):T {
    try{return operation();}
    catch(error){if(error instanceof MappingError&&error.code==='BUDGET_EXCEEDED')throw error;return mFail('OWNER_UNAVAILABLE');}
  }
  function source(raw:unknown):SourceDescriptor {
    return stored(()=>normalizeMappingSourceImport({schema:'lmti.impact.import.v1',
      source:data(raw),entities:[],evidence:[],assertions:[]}).source as SourceDescriptor);
  }
  function visible(s:SourceDescriptor):void {
    if(!sourceAllowed(s,grant))mFail('SOURCE_UNAVAILABLE');
  }
  function selected(s:SourceDescriptor):void {
    visible(s);
    if(s.id!==authority.sourceId||s.projectId!==authority.projectId||s.siteId!==authority.siteId||
        s.environmentId!==authority.environmentId||s.kind!==authority.kind)mFail('SOURCE_UNAVAILABLE');
  }
  function policy(privacy:ImpactEntity['privacy']):void {
    if(!recordAllowed(privacy,grant))mFail('SOURCE_UNAVAILABLE');
  }
  function countBytes(sql:string,args:readonly string[],max:number):number {
    const row=db!.prepare(sql).get(...args) as Row;
    const n=Number(row.n),bytes=Number(row.bytes);
    if(!Number.isSafeInteger(n)||n<0)mFail('OWNER_UNAVAILABLE');
    if(n>max)mFail('BUDGET_EXCEEDED');
    charge(bytes);return n;
  }
  function dependency(value:unknown):void {
    charge(Buffer.byteLength(canonicalMappingJson(value)));
    dependencies.push(value);
  }
  try{
    options.authorize();
    if(mFileIdentity(options.storePath)!==options.sourceIdentityDigest)mFail('CONFIG_CHANGED');
    db=openStore(options.storePath);
    db.exec('BEGIN');
    if(schemaVersion(db)!==3)mFail('UNSUPPORTED_FORMAT');
    mappingSchema(db);
    const storeUuid=stored(()=>mStoreId(db!));
    if(storeUuid!==options.storeUuid)mFail('CONFIG_CHANGED');
    const registered=db.prepare('SELECT * FROM mapping_authorities WHERE source_id=?').get(authority.sourceId) as Row|undefined;
    if(!registered)mFail('SOURCE_UNAVAILABLE');
    const actual=stored(()=>normalizeMappingSourceAuthority(mAuthorityRow(registered)));
    if(!same(actual,authority))mFail('CONFIG_CHANGED');
    const headRow=db.prepare('SELECT * FROM sources WHERE id=?').get(authority.sourceId) as Row|undefined;
    if(!headRow||headRow.status!=='available'||typeof headRow.accepted_batch_id!=='string')mFail('SOURCE_UNAVAILABLE');
    const head=source(headRow.scope_json);selected(head);
    const batchId=stored(()=>identifier(headRow.accepted_batch_id));
    const importRow=db.prepare('SELECT id,source_id,source_json,state,reviewed_at,reviewer,content_hash FROM imports WHERE id=?').get(batchId) as Row|undefined;
    const versionRow=db.prepare('SELECT source_id,mapping_version,payload_digest,expected_accepted_version FROM mapping_versions WHERE batch_id=?').get(batchId) as Row|undefined;
    if(!importRow||importRow.state!=='accepted'||importRow.source_id!==authority.sourceId||
        !versionRow||versionRow.source_id!==authority.sourceId)mFail('SOURCE_UNAVAILABLE');
    if(importRow.content_hash!==versionRow.payload_digest||
        batchId!=='mapping-'+createHash('sha256').update('lmti.impact.mapping.batch.v1\n'+mHex(versionRow.payload_digest)).digest('hex'))mFail('OWNER_UNAVAILABLE');
    const acceptedSource=source(importRow.source_json);selected(acceptedSource);
    if(head.revision!==acceptedSource.revision||head.digest!==acceptedSource.digest)mFail('SOURCE_CHANGED');

    // Charge bounded selected rows before materializing their JSON. This is a
    // logical read/capture budget, not a SQLite VFS byte or elapsed-time claim.
    for(const [table,max] of [['entities',2000],['evidence',5000],['assertions',5000]] as const)
      countBytes(`SELECT COUNT(*) n,COALESCE(SUM(LENGTH(CAST(record_json AS BLOB))),0) bytes FROM ${table} WHERE batch_id=?`,[batchId],max);
    const mappingCount=countBytes(`SELECT COUNT(*) n,COALESCE(SUM(LENGTH(CAST(
      mapping_id||external_key||generation||aliases_json||classification||state||
      COALESCE(impact_entity_id,'')||COALESCE(replaces_mapping_id,'')||payload_kind||
      project_id||store_uuid||target_kind||target_id||COALESCE(selection,'')||
      COALESCE(reference_fingerprint,'')||COALESCE(disclosure,'') AS BLOB))),0) bytes
      FROM mapping_rows WHERE batch_id=?`,[batchId],2000);
    const bindingCount=countBytes(`SELECT COUNT(*) n,COALESCE(SUM(LENGTH(CAST(e.record_json AS BLOB))),0) bytes
      FROM mapping_evidence m LEFT JOIN evidence e ON e.batch_id=m.evidence_batch_id AND e.id=m.evidence_id
      WHERE m.batch_id=?`,[batchId],40000);
    const records=(table:'entities'|'evidence'|'assertions')=>
      (db!.prepare(`SELECT record_json FROM ${table} WHERE batch_id=? ORDER BY id`).all(batchId) as Row[]).map(r=>mJson(r.record_json));
    const input=stored(()=>normalizeMappingSourceImport({schema:'lmti.impact.import.v1',source:acceptedSource,
      entities:records('entities'),evidence:records('evidence'),assertions:records('assertions')}));
    for(const row of [...input.entities,...input.evidence,...input.assertions])policy(row.privacy);
    const mappings=stored(()=>mRows(db!,batchId)),bindings=stored(()=>mEvidence(db!,batchId));
    if(mappings.length!==mappingCount||bindings.length!==bindingCount)mFail('OWNER_UNAVAILABLE');
    const accepted=stored(()=>normalizeMappingVersionSnapshot({batchId,mappingVersion:versionRow.mapping_version,
      payloadDigest:versionRow.payload_digest,input,mappings,evidenceBindings:bindings}));
    // Recompute the exact submitted digest separately from derived retirements.
    stored(()=>normalizeMappingImport({schema:'lmti.impact.mapping-import.v1',input,
      mappingVersion:versionRow.mapping_version,payloadDigest:versionRow.payload_digest,
      expectedAcceptedVersion:versionRow.expected_accepted_version,mappings:mRows(db!,batchId,true)}));
    const reviewedAt=stored(()=>timestamp(importRow.reviewed_at));
    stored(()=>identifier(importRow.reviewer));

    const identityQuery=db.prepare('SELECT * FROM mapping_identity WHERE mapping_id=?');
    const keyQuery=db.prepare('SELECT mapping_id FROM mapping_keys WHERE source_id=? AND external_key=? AND generation=?');
    const byMapping=new Map(accepted.mappings.map(r=>[r.mappingId,r]));
    for(const row of accepted.mappings){
      policy(row.classification);
      if(row.target.projectId!==authority.nativeProjectId||row.target.storeUuid!==authority.nativeStoreUuid)mFail('OWNER_UNAVAILABLE');
      const identity=identityQuery.get(row.mappingId) as Row|undefined;
      if(!identity||identity.source_id!==authority.sourceId||identity.generation!==row.generation||
          !same(mTarget(identity),row.target)||
          (row.state==='active'?identity.retired_batch_id!==null:identity.retired_batch_id===null))mFail('OWNER_UNAVAILABLE');
      stored(()=>identifier(identity.created_batch_id));
      if(identity.retired_batch_id!==null)stored(()=>identifier(identity.retired_batch_id));
      for(const key of [row.externalKey,...row.aliases]){
        const reserved=keyQuery.get(authority.sourceId,key,row.generation) as Row|undefined;
        if(!reserved||reserved.mapping_id!==row.mappingId)mFail('OWNER_UNAVAILABLE');
      }
      dependency(identity);
    }
    // Only referenced foreign endpoints are inspected. Their complete imports,
    // unrelated sources, report payloads and mapping histories are never loaded.
    const localIds=new Set(input.entities.map(e=>e.id)),foreign=new Set<string>();
    for(const assertion of input.assertions)for(const id of [assertion.subjectId,assertion.objectId])
      if(!localIds.has(id))foreign.add(id);
    const foreignQuery=db.prepare(`SELECT s.id source_id,s.scope_json,s.status,s.accepted_batch_id,
      i.source_id import_source_id,i.source_json,i.state,e.record_json,e.privacy,e.kind FROM entity_identity x
      JOIN sources s ON s.id=x.source_id JOIN imports i ON i.id=s.accepted_batch_id
      JOIN entities e ON e.batch_id=i.id AND e.id=x.id WHERE x.id=?`);
    for(const id of [...foreign].sort()){
      const row=foreignQuery.get(id) as Row|undefined;
      if(!row||row.source_id===authority.sourceId||row.state!=='accepted'||row.status!=='available')mFail('SOURCE_UNAVAILABLE');
      if(row.import_source_id!==row.source_id)mFail('OWNER_UNAVAILABLE');
      const prior=source(row.source_json),current=source(row.scope_json);visible(prior);visible(current);
      if(prior.id!==row.source_id||current.id!==row.source_id)mFail('OWNER_UNAVAILABLE');
      const entity=stored(()=>normalizeMappingSourceImport({schema:'lmti.impact.import.v1',source:prior,
        entities:[data(row.record_json)],evidence:[],assertions:[]}).entities[0]);
      if(entity.id!==id||entity.privacy!==row.privacy||entity.kind!==row.kind)mFail('OWNER_UNAVAILABLE');
      policy(entity.privacy);dependency(row);
    }
    // Historical retirement evidence remains tied to its original batch. Its
    // source and associated entity privacy still constrain a complete capture.
    const evidenceFloor:MappingCurrentCapture['evidenceFloor'][number][]=[];
    const origins=new Map<string,SourceDescriptor>(),associated=new Map<string,ImpactEntity>();
    const originQuery=db.prepare('SELECT source_id,source_json,state FROM imports WHERE id=?');
    const entityQuery=db.prepare('SELECT record_json,privacy,kind FROM entities WHERE batch_id=? AND id=?');
    for(const binding of accepted.evidenceBindings){
      const mapping=byMapping.get(binding.mappingId);
      if(!mapping||(mapping.state==='active'&&binding.evidenceBatchId!==batchId))mFail('OWNER_UNAVAILABLE');
      let origin=origins.get(binding.evidenceBatchId);
      if(!origin){
        const row=originQuery.get(binding.evidenceBatchId) as Row|undefined;
        if(!row||row.source_id!==authority.sourceId||row.state!=='accepted')mFail('OWNER_UNAVAILABLE');
        origin=source(row.source_json);selected(origin);origins.set(binding.evidenceBatchId,origin);
        dependency({batchId:binding.evidenceBatchId,source:origin});
      }
      const classifications=[origin.privacy,binding.evidence.privacy];
      policy(binding.evidence.privacy);
      if(binding.evidence.entityId!==undefined){
        const key=canonicalMappingJson([binding.evidenceBatchId,binding.evidence.entityId]);
        let entity=associated.get(key);
        if(!entity){
          const row=entityQuery.get(binding.evidenceBatchId,binding.evidence.entityId) as Row|undefined;
          if(!row)mFail('OWNER_UNAVAILABLE');
          entity=stored(()=>normalizeMappingSourceImport({schema:'lmti.impact.import.v1',source:origin!,
            entities:[data(row.record_json)],evidence:[],assertions:[]}).entities[0]) as ImpactEntity;
          if(entity.id!==binding.evidence.entityId||entity.privacy!==row.privacy||entity.kind!==row.kind)mFail('OWNER_UNAVAILABLE');
          associated.set(key,entity);dependency({key,entity});
        }
        policy(entity.privacy);classifications.push(entity.privacy);
      }
      evidenceFloor.push({mappingId:binding.mappingId,evidenceId:binding.evidenceId,
        classification:classifications.includes('internal')?'internal':'public'});
    }
    const graphRevision=stored(()=>revision(db!));
    const body={storeUuid,graphRevision,authority:actual,head,accepted,reviewedAt,evidenceFloor};
    if(Buffer.byteLength(canonicalMappingJson(body))>cap)mFail('BUDGET_EXCEEDED');
    const token=mHash('lmti.impact.mapping.current-store.v1',{...body,headRow,
      review:{state:importRow.state,reviewedAt,reviewer:importRow.reviewer,contentHash:importRow.content_hash},
      dependencies});
    if(mFileIdentity(options.storePath)!==options.sourceIdentityDigest)mFail('CONFIG_CHANGED');
    options.authorize();
    db.exec('COMMIT');
    return {...body,token};
  }catch(error){
    if(db)mRollback(db);
    if(error instanceof MappingError&&['UNSUPPORTED_FORMAT','SOURCE_UNAVAILABLE','SOURCE_CHANGED',
      'CONFIG_CHANGED','SCOPE_DENIED','BUDGET_EXCEEDED'].includes(error.code))throw error;
    return mFail('OWNER_UNAVAILABLE');
  }finally{if(db)mClose(db);}
}
