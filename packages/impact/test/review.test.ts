import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createSyntheticImpactDemo } from "../src/demo.js";
import { createImpactReport, loadImpactReport, saveImpactReport } from "../src/report.js";
import { createImpactReviewOperator } from "../src/review.js";
import { initializeImpactStore, importImpactSnapshot, readImpactSnapshot, reviewImpactImport, upgradeImpactStore, saveReportRecord, listImpactReportSummaries } from "../src/store.js";
import { digest, stableJson } from "../src/model.js";

const NOW = "2026-10-13T04:00:00.000Z";
const directories: string[] = [];
function temp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "lmti-impact-review-test-")); directories.push(dir); return dir;
}
afterEach(() => {
  const parent = realpathSync(tmpdir());
  for (const dir of directories.splice(0)) {
    const target = realpathSync(dir), relative = path.relative(parent, target);
    if (relative.startsWith("..") || path.isAbsolute(relative) || !path.basename(target).startsWith("lmti-impact-review-test-")) throw new Error("Unexpected fixture cleanup path");
    rmSync(target, { recursive: true, force: true });
  }
});
function fixture() {
  const demo = createSyntheticImpactDemo(NOW), filename = path.join(temp(), "impact.sqlite");
  initializeImpactStore(filename);
  let revision = 0;
  for (const input of [...demo.foundation, demo.imports.A]) {
    const staged = importImpactSnapshot(filename, input, { expectedRevision: revision, actor: "test-operator", now: NOW });
    revision = reviewImpactImport(filename, staged.batchId, { decision: "accept", expectedRevision: staged.graphRevision, reviewer: "test-reviewer", evidenceReviewed: true, now: NOW }).graphRevision;
  }
  const reportOptions = { freshness: demo.checks.A, now: NOW };
  const report = createImpactReport(filename, demo.grant, demo.change, reportOptions);
  saveImpactReport(filename, demo.grant, report, reportOptions);
  const operator = createImpactReviewOperator(filename, demo.grant, { reviewer: "local-human", freshness: () => demo.checks.A, now: () => NOW });
  const request = { reportId: report.id, checklistId: report.checklist[0].id,
    status: "verified" as const, expectedGraphRevision: revision, expectedReviewRevision: 0,
    evidenceSummary: "Owner reviewed the synthetic contract check result.", evidenceRef: "checks/contract-review.md#result" };
  return { ...demo, filename, revision, report, reportOptions, operator, request };
}
function toVersion1(filename: string): void {
  const db = new DatabaseSync(filename);
  try { db.exec("DROP TRIGGER review_events_no_update; DROP TRIGGER review_events_no_delete; DROP TABLE review_events; DROP TABLE review_heads; PRAGMA user_version=1;"); }
  finally { db.close(); }
}
function schemaVersion(filename: string): number {
  const db = new DatabaseSync(filename, { readOnly: true });
  try { return Number(db.prepare("PRAGMA user_version").get()!.user_version); } finally { db.close(); }
}

describe("persisted scoped human impact verification", () => {
  it("lists bounded opaque report metadata without reading cached content or changing the store", () => {
    const f = fixture();
    for (let index = 1; index <= 2; index++) {
      const options = { freshness: f.checks.A, now: new Date(Date.parse(NOW) + index * 1000).toISOString() };
      const report = createImpactReport(f.filename, f.grant, { ...f.change, description: `Synthetic change ${index}` }, options);
      saveImpactReport(f.filename, f.grant, report, options);
    }
    const before = readFileSync(f.filename);
    const all = listImpactReportSummaries(f.filename, f.grant);
    expect(all.truncated).toBe(false); expect(all.reports).toHaveLength(3);
    expect(all.reports.at(-1)).toEqual({ id: f.report.id, savedAt: NOW, graphRevision: f.revision });
    expect(all.reports.every(report => Object.keys(report).sort().join() === "graphRevision,id,savedAt")).toBe(true);
    expect(listImpactReportSummaries(f.filename, f.grant, { limit: 2 })).toEqual({ reports: all.reports.slice(0, 2), truncated: true });
    for (const grant of [{ ...f.grant, principalId: "another-principal" }, { ...f.grant, projectId: "another-project" }, { ...f.grant, policyVersion: "revoked" }, { ...f.grant, siteIds: ["other-site"] }])
      expect(listImpactReportSummaries(f.filename, grant)).toEqual({ reports: [], truncated: false });
    for (const limit of [0, 101, 1.5]) expect(() => listImpactReportSummaries(f.filename, f.grant, { limit })).toThrow("INVALID_NUMBER");
    expect(readFileSync(f.filename)).toEqual(before);
    toVersion1(f.filename);
    expect(listImpactReportSummaries(f.filename, f.grant)).toEqual(all);
  });

  it("keeps canonical pending checklist immutable and appends verified, failed and reopened decisions", () => {
    const f = fixture(), initialBytes = readFileSync(f.filename);
    const initial = f.operator.read(f.report.id);
    expect(initial.reviewRevision).toBe(0);
    expect(initial.entries.every(entry => entry.status === "pending")).toBe(true);
    expect(readFileSync(f.filename)).toEqual(initialBytes);
    const verified = f.operator.record(f.request);
    expect(verified.reviewRevision).toBe(1);
    expect(verified.entries[0]).toMatchObject({ status: "verified", reviewer: "local-human", recordedAt: NOW, evidenceRef: f.request.evidenceRef });
    const failed = f.operator.record({ ...f.request, expectedReviewRevision: 1, status: "failed", evidenceSummary: "A second fixture case failed the contract check." });
    const reopened = f.operator.record({ ...f.request, expectedReviewRevision: 2, status: "pending", evidenceSummary: undefined, evidenceRef: undefined });
    expect(failed.reviewRevision).toBe(2);
    expect(reopened.history.map(event => event.status)).toEqual(["verified", "failed", "pending"]);
    expect(reopened.entries[0].status).toBe("pending");
    expect(new Set(reopened.history.map(event => event.id)).size).toBe(3);
    expect(readImpactSnapshot(f.filename, f.grant).graphRevision).toBe(f.revision);
    expect(loadImpactReport(f.filename, f.grant, f.report.id, f.reportOptions)).toEqual(f.report);
    expect(f.report.checklist.every(entry => entry.status === "pending")).toBe(true);
  });

  it("requires evidence and denies injected capabilities, reviewer, clocks and unsafe locators", () => {
    const f = fixture(), before = readFileSync(f.filename);
    for (const status of ["verified", "failed"]) {
      expect(() => f.operator.record({ ...f.request, status, evidenceSummary: undefined })).toThrow("REVIEW_EVIDENCE_REQUIRED");
      expect(() => f.operator.record({ ...f.request, status, evidenceRef: undefined })).toThrow("REVIEW_EVIDENCE_REQUIRED");
    }
    for (const field of ["grant", "reviewer", "recordedAt", "freshness", "allowInternal", "bindingHash"]) {
      expect(() => f.operator.record({ ...f.request, [field]: "forged" })).toThrow("UNKNOWN_REVIEW_FIELD");
    }
    for (const evidenceRef of ["../secrets", "docs/../secret", "C:\\private\\file", "https://example.test/check", "/etc/passwd", "\\\\host\\share"]) {
      expect(() => f.operator.record({ ...f.request, evidenceRef })).toThrow("UNSAFE_REVIEW_REFERENCE");
    }
    expect(() => f.operator.record({ ...f.request, evidenceSummary: "" })).toThrow("INVALID_TEXT");
    expect(() => f.operator.record({ ...f.request, evidenceSummary: `Synthetic fixture ${"sk-" + "x".repeat(30)}` })).toThrow("SENSITIVE_REVIEW_METADATA_DENIED");
    expect(() => f.operator.record({ ...f.request, checklistId: "unknown-task" })).toThrow("CHECKLIST_UNAVAILABLE");
    expect(readFileSync(f.filename)).toEqual(before);
  });

  it("requires optimistic graph and review revisions and rejects duplicate attestations", () => {
    const f = fixture();
    expect(() => f.operator.record({ ...f.request, expectedGraphRevision: f.revision - 1 })).toThrow("IMPACT_REVISION_CONFLICT");
    expect(() => f.operator.record({ ...f.request, expectedReviewRevision: 1 })).toThrow("REVIEW_REVISION_CONFLICT");
    f.operator.record(f.request);
    expect(() => f.operator.record(f.request)).toThrow("REVIEW_REVISION_CONFLICT");
    expect(() => f.operator.record({ ...f.request, expectedReviewRevision: 1 })).toThrow("REVIEW_DUPLICATE");
    expect(f.operator.read(f.report.id).history).toHaveLength(1);
  });

  it("rechecks grant/principal/site policy and captures authority independently of later caller mutation", () => {
    const f = fixture(); f.operator.record(f.request);
    for (const grant of [{ ...f.grant, policyVersion: "revoked" }, { ...f.grant, principalId: "another-principal" }, { ...f.grant, projectId: "another-project" }, { ...f.grant, siteIds: ["another-site"] }, { ...f.grant, allowInternal: false }]) {
      const denied = createImpactReviewOperator(f.filename, grant, { reviewer: "other", freshness: () => f.checks.A, now: () => NOW });
      expect(() => denied.read(f.report.id)).toThrow("REPORT_UNAVAILABLE");
      expect(() => denied.record({ ...f.request, expectedReviewRevision: 1 })).toThrow("REPORT_UNAVAILABLE");
    }
    const supplied = structuredClone(f.grant);
    const allowed = createImpactReviewOperator(f.filename, supplied, { reviewer: "local-human", freshness: () => f.checks.A, now: () => NOW });
    supplied.siteIds.push("unauthorized-site"); supplied.projectId = "other";
    expect(allowed.read(f.report.id).reviewRevision).toBe(1);
  });

  it("invalidates displayed decisions when source bytes change without a graph revision", () => {
    const f = fixture(); f.operator.record(f.request);
    const checks = structuredClone(f.checks.A);
    checks[0].digest = digest("changed owner file bytes");
    const changed = createImpactReviewOperator(f.filename, f.grant, { reviewer: "local-human", freshness: () => checks, now: () => NOW });
    expect(changed.read(f.report.id)).toMatchObject({ current: false, entries: [], history: [], reasons: ["freshness-not-confirmed"] });
    expect(() => changed.record({ ...f.request, expectedReviewRevision: 1 })).toThrow("REPORT_NO_LONGER_CURRENT");
    // History remains stored and only becomes visible with current owner evidence.
    expect(f.operator.read(f.report.id).history).toHaveLength(1);
  });

  it("invalidates decisions when graph source head changes and never transfers them to a new report", () => {
    const f = fixture(); f.operator.record(f.request);
    const staged = importImpactSnapshot(f.filename, f.imports.B, { expectedRevision: f.revision, actor: "local-human", now: NOW });
    expect(f.operator.read(f.report.id)).toMatchObject({ current: false, entries: [], history: [], reasons: ["graph-changed"] });
    expect(() => f.operator.record({ ...f.request, expectedReviewRevision: 1 })).toThrow("REPORT_NO_LONGER_CURRENT");
    reviewImpactImport(f.filename, staged.batchId, { decision: "accept", expectedRevision: staged.graphRevision, reviewer: "local-human", evidenceReviewed: true, now: NOW });
    const updated = createImpactReport(f.filename, f.grant, f.change, { freshness: f.checks.B, now: NOW });
    saveImpactReport(f.filename, f.grant, updated, { freshness: f.checks.B, now: NOW });
    const owner = createImpactReviewOperator(f.filename, f.grant, { reviewer: "local-human", freshness: () => f.checks.B, now: () => NOW });
    expect(owner.read(updated.id)).toMatchObject({ current: true, reviewRevision: 0, history: [] });
  });

  it("refuses unknown or overwritten reports and detects changed cached report contents", () => {
    const f = fixture();
    expect(() => f.operator.read("report-missing")).toThrow("REPORT_UNAVAILABLE");
    const changed = structuredClone(f.report); changed.conclusion = "Changed report content";
    expect(() => saveReportRecord(f.filename, changed.id, changed.grantFingerprint, changed.graphRevision, stableJson(changed), NOW)).toThrow("REPORT_IDENTITY_CONFLICT");
    const db = new DatabaseSync(f.filename);
    try { db.prepare("UPDATE reports SET report_json=? WHERE id=?").run(stableJson(changed), changed.id); } finally { db.close(); }
    expect(() => f.operator.read(f.report.id)).toThrow("REPORT_UNAVAILABLE");
    expect(() => f.operator.record(f.request)).toThrow("REPORT_UNAVAILABLE");
  });

  it("rechecks graph revision atomically if the source changes during freshness observation", () => {
    const f = fixture(); let staged = false;
    const owner = createImpactReviewOperator(f.filename, f.grant, { reviewer: "local-human", now: () => NOW,
      freshness: () => {
        if (!staged) { importImpactSnapshot(f.filename, f.imports.B, { expectedRevision: f.revision, actor: "local-human", now: NOW }); staged = true; }
        return f.checks.A;
      } });
    expect(() => owner.record(f.request)).toThrow("REPORT_NO_LONGER_CURRENT");
    const db = new DatabaseSync(f.filename, { readOnly: true });
    try { expect(db.prepare("SELECT COUNT(*) AS n FROM review_events").get()!.n).toBe(0); } finally { db.close(); }
  });

  it("rolls back when a source changes between the preview and the locked append", () => {
    const f = fixture(); let checks = 0;
    const owner = createImpactReviewOperator(f.filename, f.grant, { reviewer: "local-human", now: () => NOW,
      freshness: () => {
        checks++;
        return checks === 1 ? f.checks.A : [{ ...f.checks.A[0], digest: digest("source edited during review") }, ...f.checks.A.slice(1)];
      } });
    expect(() => owner.record(f.request)).toThrow("REPORT_NO_LONGER_CURRENT");
    expect(checks).toBe(2);
    expect(f.operator.read(f.report.id).history).toEqual([]);
  });

  it("preserves append-only events against accidental UPDATE/DELETE and rejects malformed history", () => {
    const f = fixture(); f.operator.record(f.request);
    const db = new DatabaseSync(f.filename);
    try {
      expect(() => db.exec("DELETE FROM review_events")).toThrow("REVIEW_HISTORY_IMMUTABLE");
      expect(() => db.exec("UPDATE review_events SET record_json='{}'")).toThrow("REVIEW_HISTORY_IMMUTABLE");
      db.exec("UPDATE review_heads SET revision=2");
    } finally { db.close(); }
    expect(() => f.operator.read(f.report.id)).toThrow("INVALID_REVIEW_HISTORY");
  });
});

describe("explicit impact schema upgrade", () => {
  it("reads v1 without mutation then upgrades with a separately verified backup", () => {
    const f = fixture(); toVersion1(f.filename);
    const before = readFileSync(f.filename), backupPath = `${f.filename}.v1-backup`;
    expect(initializeImpactStore(f.filename).schemaVersion).toBe(1);
    expect(f.operator.read(f.report.id).reviewRevision).toBe(0);
    expect(readFileSync(f.filename)).toEqual(before);
    expect(() => f.operator.record(f.request)).toThrow("IMPACT_STORE_UPGRADE_REQUIRED");
    expect(readFileSync(f.filename)).toEqual(before);
    expect(upgradeImpactStore(f.filename, { backupPath })).toMatchObject({ schemaVersion: 2, upgraded: true, graphRevision: f.revision, backupPath });
    expect(schemaVersion(backupPath)).toBe(1);
    expect(readImpactSnapshot(backupPath, f.grant)).toEqual(readImpactSnapshot(f.filename, f.grant));
    expect(loadImpactReport(backupPath, f.grant, f.report.id, f.reportOptions)).toEqual(f.report);
    expect(f.operator.record(f.request).reviewRevision).toBe(1);
    expect(upgradeImpactStore(f.filename, { backupPath })).toMatchObject({ upgraded: false });
  });

  it("backs up committed WAL contents rather than copying only the main database", () => {
    const f = fixture(); toVersion1(f.filename);
    const writer = new DatabaseSync(f.filename);
    const backupPath = `${f.filename}.wal-backup`;
    try {
      writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE wal_marker (value TEXT); INSERT INTO wal_marker VALUES('committed-wal-row');");
      upgradeImpactStore(f.filename, { backupPath });
      const backup = new DatabaseSync(backupPath, { readOnly: true });
      try { expect(backup.prepare("SELECT value FROM wal_marker").get()!.value).toBe("committed-wal-row"); } finally { backup.close(); }
    } finally { writer.close(); }
  });

  it("never overwrites a backup or changes unknown schemas", () => {
    const f = fixture(); toVersion1(f.filename);
    const backupPath = `${f.filename}.occupied`, before = readFileSync(f.filename);
    writeFileSync(backupPath, "retained-user-file");
    expect(() => upgradeImpactStore(f.filename, { backupPath })).toThrow("BACKUP_DESTINATION_EXISTS");
    expect(readFileSync(backupPath, "utf8")).toBe("retained-user-file");
    expect(readFileSync(f.filename)).toEqual(before);
    const db = new DatabaseSync(f.filename); db.exec("PRAGMA user_version=99"); db.close();
    expect(() => upgradeImpactStore(f.filename, { backupPath: `${f.filename}.other` })).toThrow("UNSUPPORTED_IMPACT_STORE");
    expect(() => f.operator.read(f.report.id)).toThrow("UNSUPPORTED_IMPACT_STORE");
    expect(schemaVersion(f.filename)).toBe(99);
  });

  it("rolls back partial DDL on failure and keeps the readable original and backup", () => {
    const f = fixture(); toVersion1(f.filename);
    const db = new DatabaseSync(f.filename); db.exec("CREATE TABLE review_events (original TEXT)"); db.close();
    const backupPath = `${f.filename}.failed-upgrade-backup`;
    expect(() => upgradeImpactStore(f.filename, { backupPath })).toThrow();
    expect(schemaVersion(f.filename)).toBe(1);
    expect(schemaVersion(backupPath)).toBe(1);
    const original = new DatabaseSync(f.filename, { readOnly: true });
    try { expect(original.prepare("SELECT name FROM sqlite_master WHERE name='review_heads'").get()).toBeUndefined(); } finally { original.close(); }
    expect(readImpactSnapshot(f.filename, f.grant).graphRevision).toBe(f.revision);
    expect(readImpactSnapshot(backupPath, f.grant).graphRevision).toBe(f.revision);
  });
});
