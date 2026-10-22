import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, realpathSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  createSyntheticImpactDemo, initializeImpactStore, importImpactSnapshot, reviewImpactImport,
  readImpactSnapshot, lookupImpactEntity, getImpactEvidence, listImpactImports,
  readImpactImport, readImpactHistory, createImpactReport, saveImpactReport,
  loadImpactReport, revalidateImpactReport, recordImpactSourceStatus, digest,
  type ImpactImport, type ImpactGrant, type SourceCheck
} from "../src/index.js";

const NOW = "2026-10-12T04:00:00.000Z";
const directories: string[] = [];
function temp() { const dir = mkdtempSync(path.join(tmpdir(), "lmti-impact-test-")); directories.push(dir); return dir; }
afterEach(() => {
  const parent = realpathSync(tmpdir());
  for (const dir of directories.splice(0)) {
    const target = realpathSync(dir), relative = path.relative(parent, target);
    if (relative.startsWith("..") || path.isAbsolute(relative) || !path.basename(target).startsWith("lmti-impact-test-")) throw new Error("Unexpected fixture cleanup path");
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
  return { ...demo, filename, revision };
}
function revised(input: ImpactImport, revision: string): ImpactImport {
  const result = structuredClone(input); result.source.revision = revision;
  result.source.digest = digest({ ...result, source: { ...result.source, digest: undefined } });
  return result;
}
function check(input: ImpactImport): SourceCheck { return { sourceId: input.source.id, status: "available", checkedAt: NOW, revision: input.source.revision, digest: input.source.digest }; }
function accept(filename: string, input: ImpactImport, revision: number) {
  const staged = importImpactSnapshot(filename, input, { expectedRevision: revision, actor: "test-operator", now: NOW });
  return reviewImpactImport(filename, staged.batchId, { decision: "accept", expectedRevision: staged.graphRevision, reviewer: "test-reviewer", evidenceReviewed: true, now: NOW }).graphRevision;
}

describe("scoped evidence impact store", () => {
  it("creates a distinct store, rejects foreign/memory locations and never initializes a missing reader", () => {
    const dir = temp(), missing = path.join(dir, "missing.sqlite"), demo = createSyntheticImpactDemo(NOW);
    expect(() => readImpactSnapshot(missing, demo.grant)).toThrow("IMPACT_STORE_UNAVAILABLE");
    const foreign = path.join(dir, "foreign.sqlite"), db = new DatabaseSync(foreign);
    db.exec("CREATE TABLE user_data(value TEXT); INSERT INTO user_data VALUES('retained')"); db.close();
    const before = readFileSync(foreign);
    expect(() => initializeImpactStore(foreign)).toThrow("UNSUPPORTED_IMPACT_STORE");
    expect(readFileSync(foreign)).toEqual(before);
    mkdirSync(path.join(dir, ".lmti"));
    expect(() => initializeImpactStore(path.join(dir, ".lmti", "impact.sqlite"))).toThrow("MEMORY_STORE_BOUNDARY_DENIED");
  });
  it("stages and reviews source A/B/C atomically, preserves history and does not auto-verify imported observations", () => {
    const f = fixture(), before = readImpactSnapshot(f.filename, f.grant);
    const staged = importImpactSnapshot(f.filename, f.imports.B, { expectedRevision: f.revision, actor: "test-operator", now: NOW });
    expect(staged.delta.changed).toContain("scanner-contract");
    expect(listImpactImports(f.filename, f.grant).find(i => i.batchId === staged.batchId)?.state).toBe("pending");
    expect(readImpactImport(f.filename, f.grant, staged.batchId).source.revision).toBe("B");
    expect(readImpactSnapshot(f.filename, f.grant).entities).toEqual(before.entities);
    const stale = createImpactReport(f.filename, f.grant, f.change, { freshness: f.checks.B, now: NOW });
    expect(stale.sourceVersions.find(s => s.sourceId === f.imports.A.source.id)?.freshness).toBe("stale");
    expect(stale.findings.find(x => x.entity.id === "dispatch-confirmation")?.disposition).toBe("unresolved");
    const review = reviewImpactImport(f.filename, staged.batchId, { decision: "accept", expectedRevision: staged.graphRevision, reviewer: "test-reviewer", evidenceReviewed: true, now: NOW });
    expect(lookupImpactEntity(f.filename, f.grant, "barcode-scanner").record.label).toBe("Package identifier scanner");
    expect(getImpactEvidence(f.filename, f.grant, "evidence-scanner-contract")).not.toHaveProperty("verifiedAt");
    expect(readImpactHistory(f.filename, f.grant)).toHaveLength(6);
    const fresh = createImpactReport(f.filename, f.grant, f.change, { freshness: f.checks.B, now: NOW });
    expect(fresh.findings.find(x => x.entity.id === "dispatch-confirmation")?.disposition).toBe("potentially_affected");
    accept(f.filename, f.imports.C, review.graphRevision);
    expect(getImpactEvidence(f.filename, f.grant, "evidence-scanner-contract").record.observedAt).toBe(NOW);
    expect(readImpactHistory(f.filename, f.grant)).toHaveLength(8);
  });
  it("is idempotent independent of array insertion order and rejects stale review writers", () => {
    const f = fixture(), reordered = structuredClone(f.imports.A);
    reordered.entities.reverse(); reordered.assertions.reverse(); reordered.evidence.reverse();
    const result = importImpactSnapshot(f.filename, reordered, { expectedRevision: f.revision, actor: "test-operator", now: NOW });
    expect(result.idempotent).toBe(true); expect(result.graphRevision).toBe(f.revision);
    const staged = importImpactSnapshot(f.filename, f.imports.B, { expectedRevision: f.revision, actor: "test-operator", now: NOW });
    expect(() => reviewImpactImport(f.filename, staged.batchId, { decision: "accept", expectedRevision: f.revision, reviewer: "test-reviewer", evidenceReviewed: true, now: NOW })).toThrow("IMPACT_REVISION_CONFLICT");
    expect(readImpactSnapshot(f.filename, f.grant).graphRevision).toBe(staged.graphRevision);
  });
  it("rejects corrupt/incomplete imports, forged identity and unsafe locators without overwriting accepted state", () => {
    const f = fixture(), original = readFileSync(f.filename);
    const malformed = structuredClone(f.imports.B) as unknown as Record<string, any>;
    malformed.source.complete = false;
    expect(() => importImpactSnapshot(f.filename, malformed, { expectedRevision: f.revision, actor: "test-operator", now: NOW })).toThrow("INCOMPLETE_SOURCE_DENIED");
    const locator = structuredClone(f.imports.B); locator.evidence[0].locator = "../../private.txt";
    expect(() => importImpactSnapshot(f.filename, locator, { expectedRevision: f.revision, actor: "test-operator", now: NOW })).toThrow("UNSAFE_LOCATOR");
    const identity = structuredClone(f.imports.B); identity.entities.push({ ...f.foundation[0].entities[0], sourceKey: "forged-code" });
    expect(() => importImpactSnapshot(f.filename, identity, { expectedRevision: f.revision, actor: "test-operator", now: NOW })).toThrow("ENTITY_IDENTITY_CONFLICT");
    expect(readFileSync(f.filename)).toEqual(original);
  });
  it("retains stale state after reject and requires an explicit review acknowledgement", () => {
    const f = fixture(), staged = importImpactSnapshot(f.filename, f.imports.B, { expectedRevision: f.revision, actor: "test-operator", now: NOW });
    expect(() => reviewImpactImport(f.filename, staged.batchId, { decision: "accept", expectedRevision: staged.graphRevision, reviewer: "test-reviewer", evidenceReviewed: false as true, now: NOW })).toThrow("EXPLICIT_REVIEW_REQUIRED");
    reviewImpactImport(f.filename, staged.batchId, { decision: "reject", expectedRevision: staged.graphRevision, reviewer: "test-reviewer", evidenceReviewed: true, now: NOW });
    expect(createImpactReport(f.filename, f.grant, f.change, { freshness: f.checks.A, now: NOW }).sourceVersions.find(s => s.sourceId === f.imports.A.source.id)?.freshness).toBe("stale");
  });
  it("stable identities survive reviewed labels and source keys, with tombstones retained", () => {
    const f = fixture(), next = structuredClone(f.imports.B);
    next.entities.find(e => e.id === "barcode-scanner")!.sourceKey = "renamed:scanner";
    const updated = revised(next, "renamed"), rev = accept(f.filename, updated, f.revision);
    expect(lookupImpactEntity(f.filename, f.grant, "barcode-scanner").record.sourceKey).toBe("renamed:scanner");
    recordImpactSourceStatus(f.filename, updated.source.id, "deleted", { expectedRevision: rev, actor: "test-operator", now: NOW });
    expect(createImpactReport(f.filename, f.grant, f.change, { freshness: [check(f.foundation[0]), check(updated)], now: NOW }).unknowns).toContain("source-deleted");
    expect(readImpactHistory(f.filename, f.grant).at(-1)?.event).toBe("source-deleted");
  });
});

describe("deterministic evidence paths and privacy", () => {
  it("returns directed code→service→selected deployment→workflow and keeps the host as context only", () => {
    const f = fixture(), before = readFileSync(f.filename);
    const report = createImpactReport(f.filename, f.grant, f.change, { freshness: f.checks.A, now: NOW });
    const workflow = report.findings.find(x => x.entity.id === "dispatch-confirmation")!;
    expect(workflow.disposition).toBe("potentially_affected");
    expect(workflow.path.map(p => p.assertionId)).toEqual(["code-mapping", "label-instance", "dispatch-step"]);
    expect(workflow.conditionalOnDeployment).toEqual(["label-deployment"]);
    expect(report.findings.find(x => x.entity.id === "warehouse-gateway")?.disposition).toBe("associated_context");
    expect(report.findings.some(x => x.entity.id === "metrics-service" || x.entity.id === "metrics-deployment")).toBe(false);
    expect(report.findings.some(x => x.entity.id === "warehouse-db")).toBe(false);
    expect(report.coverage.traversal).toBe("complete");
    expect(report.coverage.knowledge).toBe("not_proven_complete");
    expect(readFileSync(f.filename)).toEqual(before);
    expect(createImpactReport(f.filename, f.grant, f.change, { freshness: f.checks.A, now: NOW })).toEqual(report);
  });
  it("does not invent rollout to unselected instances or current observed state from desired declarations", () => {
    const f = fixture();
    const unspecified = createImpactReport(f.filename, f.grant, { ...f.change, targetDeploymentIds: [] }, { freshness: f.checks.A, now: NOW });
    expect(unspecified.findings.some(x => x.entity.kind === "deployment")).toBe(false);
    expect(unspecified.unknowns).toContain("rollout-target-not-specified");
    const observed = createImpactReport(f.filename, f.grant, { ...f.change, mode: "current-observed" }, { freshness: f.checks.A, now: NOW });
    expect(observed.findings.filter(x => x.disposition !== "associated_context").every(x => x.disposition === "unresolved")).toBe(true);
    expect(observed.findings[0].reasons).toContain("desired-is-not-observed");
  });
  it("treats missing/changed source checks and mismatched baselines as unresolved", () => {
    const f = fixture();
    expect(createImpactReport(f.filename, f.grant, f.change, { now: NOW }).unknowns).toContain("source-not-checked");
    const changed = [{ ...f.checks.A[0], digest: digest("unimported dirty checkout") }, f.checks.A[1]];
    expect(createImpactReport(f.filename, f.grant, f.change, { freshness: changed, now: NOW }).findings.every(x => x.disposition !== "potentially_affected")).toBe(true);
    const wrong = createImpactReport(f.filename, f.grant, { ...f.change, baselineRevision: "other" }, { freshness: f.checks.A, now: NOW });
    expect(wrong.unknowns).toContain("baseline-revision-does-not-match-source");
  });
  it("retains conflicting evidence and inferred paths for verification", () => {
    const f = fixture(), next = structuredClone(f.imports.B);
    next.assertions.push({ ...next.assertions.find(a => a.id === "scanner-contract")!, id: "scanner-denial", polarity: "denies" });
    next.assertions.find(a => a.id === "dispatch-step")!.basis = "inferred";
    const input = revised(next, "conflict"), revision = accept(f.filename, input, f.revision);
    expect(revision).toBeGreaterThan(f.revision);
    const report = createImpactReport(f.filename, f.grant, f.change, { freshness: [check(f.foundation[0]), check(input)], now: NOW });
    expect(report.findings.find(x => x.entity.id === "barcode-scanner")?.reasons).toContain("contradictory-source-assertions");
    expect(report.findings.find(x => x.entity.id === "dispatch-confirmation")?.reasons).toContain("inferred-relation-needs-review");
  });
  it("never exposes denied endpoints, evidence or delta IDs through public reads", () => {
    const f = fixture(), next = structuredClone(f.imports.B);
    next.entities.find(e => e.id === "barcode-scanner")!.privacy = "internal";
    next.evidence.find(e => e.id === "evidence-dispatch-step")!.privacy = "internal";
    next.evidence.find(e => e.id === "evidence-label-host")!.entityId = "barcode-scanner";
    const input = revised(next, "private"), staged = importImpactSnapshot(f.filename, input, { expectedRevision: f.revision, actor: "test-operator", now: NOW });
    const external = { ...f.grant, allowInternal: false };
    const candidate = readImpactImport(f.filename, external, staged.batchId);
    expect(JSON.stringify(candidate)).not.toContain("barcode-scanner");
    expect(candidate.assertions.some(a => a.id === "dispatch-step")).toBe(false);
    expect(listImpactImports(f.filename, external).find(i => i.batchId === staged.batchId)?.delta.changed).not.toContain("scanner-contract");
    reviewImpactImport(f.filename, staged.batchId, { decision: "accept", expectedRevision: staged.graphRevision, reviewer: "test-reviewer", evidenceReviewed: true, now: NOW });
    expect(() => lookupImpactEntity(f.filename, external, "barcode-scanner")).toThrow("ENTITY_UNAVAILABLE");
    expect(() => getImpactEvidence(f.filename, external, "evidence-dispatch-step")).toThrow("EVIDENCE_UNAVAILABLE");
    expect(() => getImpactEvidence(f.filename, external, "evidence-label-host")).toThrow("EVIDENCE_UNAVAILABLE");
    const report = createImpactReport(f.filename, external, f.change, { freshness: [check(f.foundation[0]), check(input)], now: NOW });
    expect(JSON.stringify(report)).not.toMatch(/barcode-scanner|evidence-dispatch-step|scanner-contract/u);
    expect(report.unknowns).toContain("business-workflow-mapping-not-established");
  });
  it("denies cross-project/site/environment queries without distinguishing missing from forbidden IDs", () => {
    const f = fixture();
    for (const grant of [{ ...f.grant, projectId: "other" }, { ...f.grant, siteIds: ["other"] }, { ...f.grant, environmentIds: ["production"] }]) {
      expect(() => createImpactReport(f.filename, grant, f.change, { freshness: f.checks.A, now: NOW })).toThrow("ENTITY_UNAVAILABLE");
      expect(readImpactHistory(f.filename, grant)).toEqual([]);
      expect(listImpactImports(f.filename, grant)).toEqual([]);
    }
  });
  it("finds late records before presentation limits and terminates cyclic graphs with explicit budget state", () => {
    const f = fixture(), next = structuredClone(f.imports.B);
    for (let n = 0; n < 250; n++) {
      next.entities.push({ id: `extra-${n}`, sourceKey: `extra:${n}`, kind: "service", label: `Unrelated ${n}`, ownerRole: "Fixture", privacy: "public" });
    }
    next.assertions.push({ ...next.assertions.find(a => a.id === "scanner-contract")!, id: "cycle-back", subjectId: "label-service", objectId: "barcode-scanner" });
    next.entities.reverse(); next.assertions.reverse();
    const input = revised(next, "large"), revision = accept(f.filename, input, f.revision);
    const opts = { freshness: [check(f.foundation[0]), check(input)], now: NOW };
    const report = createImpactReport(f.filename, f.grant, f.change, opts);
    expect(report.findings.some(x => x.entity.id === "dispatch-confirmation")).toBe(true);
    expect(report.coverage.visitedNodes).toBeLessThan(10);
    const limited = createImpactReport(f.filename, f.grant, f.change, { ...opts, budgets: { maxDepth: 1 } });
    expect(limited.coverage.traversal).toBe("incomplete"); expect(limited.coverage.reasons).toContain("depth-budget");
    const shown = createImpactReport(f.filename, f.grant, f.change, { ...opts, budgets: { maxFindings: 1 } });
    expect(shown.coverage.presentationTruncated).toBe(true);
    expect(shown.findings[0].entity.id).toBe("dispatch-confirmation");
    expect(readImpactSnapshot(f.filename, f.grant).graphRevision).toBe(revision);
  });
  it("persists reports only explicitly and rechecks freshness, revisions and revoked grants at open/export", () => {
    const f = fixture(), options = { freshness: f.checks.A, now: NOW };
    const report = createImpactReport(f.filename, f.grant, f.change, options);
    saveImpactReport(f.filename, f.grant, report, options);
    expect(loadImpactReport(f.filename, f.grant, report.id, options)).toEqual(report);
    expect(revalidateImpactReport(f.filename, f.grant, report, { now: NOW }).current).toBe(false);
    expect(() => loadImpactReport(f.filename, { ...f.grant, policyVersion: "revoked" }, report.id, options)).toThrow("REPORT_UNAVAILABLE");
    expect(() => loadImpactReport(f.filename, { ...f.grant, principalId: "other" }, report.id, options)).toThrow("REPORT_UNAVAILABLE");
    importImpactSnapshot(f.filename, f.imports.B, { expectedRevision: f.revision, actor: "test-operator", now: NOW });
    expect(revalidateImpactReport(f.filename, f.grant, report, options).reasons).toContain("graph-changed");
    expect(() => loadImpactReport(f.filename, f.grant, report.id, options)).toThrow("REPORT_NO_LONGER_CURRENT");
  });
  it("does not propagate a logical service consumer as a routed deployment fact", () => {
    const f = fixture(), next = structuredClone(f.imports.B);
    next.assertions.find(a => a.id === "scanner-contract")!.objectId = "label-service";
    const input = revised(next, "logical-routing"); accept(f.filename, input, f.revision);
    const report = createImpactReport(f.filename, f.grant, f.change, { freshness: [check(f.foundation[0]), check(input)], now: NOW });
    const scanner = report.findings.find(x => x.entity.id === "barcode-scanner")!;
    expect(scanner.disposition).toBe("unresolved");
    expect(scanner.reasons).toContain("consumer-deployment-routing-unverified");
    expect(scanner.conditionalOnDeployment).toEqual([]);
  });
  it("distinguishes an unlinked rollout target and a mismatched deployed revision", () => {
    const f = fixture(), options = { freshness: f.checks.A, now: NOW };
    const unlinked = createImpactReport(f.filename, f.grant, { ...f.change, targetDeploymentIds: ["metrics-deployment"] }, options);
    expect(unlinked.unknowns).toContain("rollout-target-mapping-not-established");
    expect(unlinked.findings.some(x => x.entity.id === "metrics-deployment")).toBe(false);
    const next = structuredClone(f.imports.B); next.entities.find(e => e.id === "label-deployment")!.version = "old-release";
    const input = revised(next, "old-release"); accept(f.filename, input, f.revision);
    const mismatched = createImpactReport(f.filename, f.grant, f.change, { freshness: [check(f.foundation[0]), check(input)], now: NOW });
    expect(mismatched.findings.find(x => x.entity.id === "dispatch-confirmation")?.reasons).toContain("deployment-baseline-mismatch");
  });
  it("includes evidence-only changes in the source review delta", () => {
    const f = fixture(), next = structuredClone(f.imports.A);
    next.evidence.find(e => e.id === "evidence-scanner-contract")!.summary = "A changed fixture declaration still requires review.";
    const input = revised(next, "evidence-update"), staged = importImpactSnapshot(f.filename, input, { expectedRevision: f.revision, actor: "test-operator", now: NOW });
    expect(staged.delta.changed).toEqual(["scanner-contract"]);
  });
  it("reports unavailable/expired observation checks and never imports future observations", () => {
    const f = fixture();
    const unavailable = createImpactReport(f.filename, f.grant, f.change, { freshness: [{ sourceId: f.imports.A.source.id, status: "unavailable", checkedAt: NOW }, f.checks.A[0]], now: NOW });
    expect(unavailable.unknowns).toContain("source-unavailable");
    const old = createImpactReport(f.filename, f.grant, f.change, { freshness: f.checks.A, now: "2026-10-12T04:06:00.000Z" });
    expect(old.unknowns).toContain("source-check-not-current");
    const future = structuredClone(f.imports.B); future.evidence[0].observedAt = "2026-10-13T00:00:00.000Z";
    expect(() => importImpactSnapshot(f.filename, future, { expectedRevision: f.revision, actor: "test-operator", now: NOW })).toThrow("FUTURE_EVIDENCE_DENIED");
  });
  it("makes node/edge/presentation limits explicit without claiming absence of impact", () => {
    const f = fixture(), options = { freshness: f.checks.A, now: NOW };
    for (const [budget, reason] of [[{ maxNodes: 1 }, "node-budget"], [{ maxEdges: 1 }, "edge-budget"]] as const) {
      const report = createImpactReport(f.filename, f.grant, f.change, { ...options, budgets: budget });
      expect(report.coverage.traversal).toBe("incomplete"); expect(report.coverage.reasons).toContain(reason);
      expect(report.conclusion).toContain("No path is not proof of no impact");
    }
    const small = createImpactReport(f.filename, f.grant, f.change, { ...options, budgets: { maxBytes: 4096 } });
    expect(Buffer.byteLength(JSON.stringify(small))).toBeLessThanOrEqual(4096);
    expect(small.coverage.presentationTruncated).toBe(true);
  });
  it("rechecks cached authorized entity/path metadata and rejects injected cache fields", () => {
    const f = fixture(), options = { freshness: f.checks.A, now: NOW }, report = createImpactReport(f.filename, f.grant, f.change, options);
    const forged = structuredClone(report);
    forged.findings[0].entity.label = "Metadata not in the authorized snapshot";
    expect(() => saveImpactReport(f.filename, f.grant, forged, options)).toThrow("REPORT_UNAVAILABLE");
    const extra = structuredClone(report) as any; extra.findings[0].path[0].privateLocator = "private/file";
    expect(() => saveImpactReport(f.filename, f.grant, extra, options)).toThrow("REPORT_UNAVAILABLE");
    const variants = [
      { ...structuredClone(report), sourceVersions: [], findings: [], checklist: [], conclusion: "No impact. Safe to deploy." },
      { ...structuredClone(report), findings: [] },
      { ...structuredClone(report), conclusion: "No impact. Safe to deploy." },
      { ...structuredClone(report), checklist: [] }
    ];
    for (const altered of variants) expect(() => saveImpactReport(f.filename, f.grant, altered, options)).toThrow("REPORT_UNAVAILABLE");
    const wrongDisposition = structuredClone(report); wrongDisposition.findings[0].disposition = "associated_context";
    expect(() => saveImpactReport(f.filename, f.grant, wrongDisposition, options)).toThrow("REPORT_UNAVAILABLE");
    const reversed = structuredClone(report), step = reversed.findings[0].path[0];
    [step.fromId, step.toId] = [step.toId, step.fromId];
    expect(() => saveImpactReport(f.filename, f.grant, reversed, options)).toThrow("REPORT_UNAVAILABLE");
  });
  it("checks reviewer scope inside the transaction and cannot approve a filtered view of hidden records", () => {
    const f = fixture(), next = structuredClone(f.imports.B);
    next.entities.find(e => e.id === "barcode-scanner")!.privacy = "internal";
    const input = revised(next, "review-scope"), staged = importImpactSnapshot(f.filename, input, { expectedRevision: f.revision, actor: "test-operator", now: NOW });
    for (const grant of [{ ...f.grant, siteIds: ["revoked-site"] }, { ...f.grant, allowInternal: false }]) {
      expect(() => reviewImpactImport(f.filename, staged.batchId, { decision: "accept", expectedRevision: staged.graphRevision, reviewer: "test-reviewer", evidenceReviewed: true, grant, now: NOW })).toThrow("REVIEW_SCOPE_DENIED");
      expect(readImpactSnapshot(f.filename, f.grant).graphRevision).toBe(staged.graphRevision);
    }
    expect(reviewImpactImport(f.filename, staged.batchId, { decision: "accept", expectedRevision: staged.graphRevision, reviewer: "test-reviewer", evidenceReviewed: true, grant: f.grant, now: NOW }).state).toBe("accepted");
  });
});
