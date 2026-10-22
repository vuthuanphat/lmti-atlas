// Synthetic local performance evidence, not a business-quality benchmark.
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir, cpus } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createImpactReport, digest, importImpactSnapshot, initializeImpactStore, reviewImpactImport } from "../dist/index.js";

const directory = mkdtempSync(path.join(tmpdir(), "lmti-impact-benchmark-"));
try {
  const database = path.join(directory, "impact.sqlite"), now = new Date().toISOString();
  const grant = { principalId: "benchmark", projectId: "synthetic-load", siteIds: ["site"], environmentIds: ["test"], allowInternal: true, policyVersion: "fixture-1" };
  const entities = Array.from({ length: 1000 }, (_, n) => ({ id: `service-${n}`, sourceKey: `service:${n}`, kind: "service", label: `Synthetic service ${n}`, ownerRole: "Fixture reviewer", privacy: "public", version: "A" }));
  const assertions = [];
  function edge(subject, object) {
    assertions.push({ id: `relation-${assertions.length}`, subjectId: `service-${subject}`, objectId: `service-${object}`, predicate: "depends_on", basis: "observed", polarity: "supports", evidenceIds: ["fixture-adjacency"], applicableChanges: ["contract"], privacy: "public" });
  }
  for (let n = 1; n < 1000; n++) edge(n, 0);
  for (let n = 0; n < 1000; n++) for (let offset = 1; offset <= 4; offset++) edge(n, (n + offset) % 1000);
  edge(0, 7);
  const input = { schema: "lmti.impact.import.v1", source: { id: "fixture-source", projectId: grant.projectId, siteId: "site", environmentId: "test", privacy: "public", kind: "manifest", revision: "A", digest: digest([entities, assertions]), capturedAt: now, parserVersion: "stress-fixture-1", complete: true }, entities, evidence: [{ id: "fixture-adjacency", locator: "generated-adjacency.json", summary: "Deterministically generated synthetic dependency adjacency. Not observations from equipment.", capturedAt: now, observedAt: now, privacy: "public" }], assertions };
  initializeImpactStore(database);
  const staged = importImpactSnapshot(database, input, { actor: "fixture-operator", expectedRevision: 0, now });
  reviewImpactImport(database, staged.batchId, { decision: "accept", expectedRevision: staged.graphRevision, reviewer: "fixture-reviewer", evidenceReviewed: true, now });
  const change = { entityId: "service-0", description: "Synthetic provider contract change", category: "contract", baselineRevision: "A", proposedRevision: "B", mode: "current-observed", targetDeploymentIds: [] };
  const options = { now, freshness: [{ sourceId: input.source.id, status: "available", checkedAt: now, revision: "A", digest: input.source.digest }], budgets: { maxMilliseconds: 10000, maxFindings: 1000, maxBytes: 2 * 1024 * 1024 } };
  const durations = [];
  let last;
  for (let n = 0; n < 17; n++) {
    const start = performance.now();
    last = createImpactReport(database, grant, change, options);
    const elapsed = performance.now() - start;
    if (n >= 2) durations.push(elapsed);
    if (last.coverage.traversal !== "complete" || last.findings.length !== 999) throw new Error("Benchmark traversal did not complete all authorized candidates");
  }
  durations.sort((a, b) => a - b);
  console.log(JSON.stringify({ schema: "lmti.impact.performance.v1", synthetic: true, node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model, entities: entities.length, assertions: assertions.length, runs: durations.length, warmups: 2, sourceReadIncluded: true, p50Milliseconds: Math.round(durations[Math.floor(durations.length / 2)]), p95Milliseconds: Math.round(durations[Math.ceil(durations.length * .95) - 1]), maxMilliseconds: Math.round(durations.at(-1)), visitedNodes: last.coverage.visitedNodes, examinedEdges: last.coverage.examinedEdges, findings: last.findings.length, traversal: last.coverage.traversal, businessOracle: "not-reviewed", humanEffortSavings: "not-measured" }, null, 2));
} finally {
  const canonical = realpathSync(directory);
  const relative = path.relative(realpathSync(tmpdir()), canonical);
  if (path.dirname(relative) !== "." || !path.basename(relative).startsWith("lmti-impact-benchmark-")) throw new Error("Unsafe benchmark cleanup target");
  rmSync(canonical, { recursive: true, force: true });
}
