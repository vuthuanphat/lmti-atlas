import {
  type ChangeRequest, type ImpactAssertion, type ImpactBudgets, type ImpactFinding,
  type ImpactGrant, type ImpactReport, type ImpactSnapshot, type PathStep,
  type SourceCheck, type SourceState, type Freshness, REPORT_SCHEMA, RULES_VERSION,
  boundedInteger, digest, fail, grantFingerprint, stableJson, timestamp,
  validateChange, validateGrant, validateSourceChecks
} from "./model.js";
import { loadReportRecord, readImpactSnapshot, saveReportRecord } from "./store.js";
import { runEgressSecretScan } from "@atlas/privacy";

export interface ReportOptions {
  /** Obtained by trusted owner adapters now; never accept these from an Agent. */
  freshness?: SourceCheck[];
  budgets?: ImpactBudgets;
  now?: string;
}
export function sourceFreshness(source: SourceState, check: SourceCheck | undefined, now: string): { freshness: Freshness; reason: string } {
  if (source.headStatus === "deleted") return { freshness: "stale", reason: "source-deleted" };
  if (source.headStatus === "unavailable") return { freshness: "unknown", reason: "source-unavailable" };
  if (source.headDigest !== source.source.digest || source.headRevision !== source.source.revision) return { freshness: "stale", reason: "source-update-awaits-review" };
  if (!check) return { freshness: "unknown", reason: "source-not-checked" };
  const elapsed = Date.parse(now) - Date.parse(check.checkedAt);
  if (elapsed < -60_000 || elapsed > 300_000) return { freshness: "unknown", reason: "source-check-not-current" };
  if (check.status === "deleted") return { freshness: "stale", reason: "source-deleted" };
  if (check.status === "unavailable") return { freshness: "unknown", reason: "source-unavailable" };
  if (check.digest !== source.source.digest || check.revision !== source.source.revision) return { freshness: "stale", reason: "source-fingerprint-changed" };
  if (source.source.maxAgeSeconds !== undefined && Date.parse(now) - Date.parse(source.source.capturedAt) > source.source.maxAgeSeconds * 1000) return { freshness: "stale", reason: "source-observation-expired" };
  return { freshness: "fresh", reason: "source-fingerprint-checked" };
}
function budgets(input: ImpactBudgets = {}): Required<ImpactBudgets> {
  if (Object.keys(input).some(k => !["maxNodes", "maxEdges", "maxDepth", "maxFindings", "maxBytes", "maxMilliseconds"].includes(k))) fail("INVALID_BUDGET");
  return {
    maxNodes: boundedInteger(input.maxNodes ?? 2000, 1, 10000),
    maxEdges: boundedInteger(input.maxEdges ?? 20000, 1, 100000),
    maxDepth: boundedInteger(input.maxDepth ?? 24, 1, 64),
    maxFindings: boundedInteger(input.maxFindings ?? 200, 1, 2000),
    maxBytes: boundedInteger(input.maxBytes ?? 512 * 1024, 4096, 2 * 1024 * 1024),
    maxMilliseconds: boundedInteger(input.maxMilliseconds ?? 1000, 1, 10000)
  };
}
function conflictingAssertions(assertions: ImpactAssertion[]): Set<string> {
  const result = new Set<string>(), groups = new Map<string, ImpactAssertion[]>();
  for (const a of assertions) {
    const key = `${a.subjectId}\0${a.predicate}\0${a.objectId}\0${a.basis}`;
    const values = groups.get(key) ?? []; values.push(a); groups.set(key, values);
  }
  for (const values of groups.values()) if (new Set(values.map(a => a.polarity)).size > 1) for (const a of values) result.add(a.id);
  const instances = new Map<string, ImpactAssertion[]>();
  for (const a of assertions.filter(a => a.predicate === "instance_of" && a.polarity === "supports")) {
    const key = `${a.subjectId}\0${a.basis}`, values = instances.get(key) ?? [];
    values.push(a); instances.set(key, values);
  }
  for (const values of instances.values()) if (new Set(values.map(a => a.objectId)).size > 1) for (const a of values) result.add(a.id);
  return result;
}
/** One representative evidence path per candidate, not every simple path. */
export function buildImpactReport(snapshot: ImpactSnapshot, value: ChangeRequest, options: ReportOptions & { grant: ImpactGrant }): ImpactReport {
  const started = performance.now(), grant = validateGrant(options.grant), change = validateChange(value);
  if (snapshot.grantFingerprint !== grantFingerprint(grant)) fail("SNAPSHOT_GRANT_MISMATCH");
  const now = timestamp(options.now ?? new Date().toISOString()), limits = budgets(options.budgets);
  const checks = new Map(validateSourceChecks(options.freshness ?? []).map(c => [c.sourceId, c]));
  const entities = new Map(snapshot.entities.map(e => [e.record.id, e]));
  const evidence = new Map(snapshot.evidence.map(e => [e.record.id, e]));
  const seed = entities.get(change.entityId);
  if (!seed || change.targetDeploymentIds.some(id => entities.get(id)?.record.kind !== "deployment")) fail("ENTITY_UNAVAILABLE");
  const sources = new Map(snapshot.sources.map(s => [s.source.id, s]));
  const states = new Map(snapshot.sources.map(s => [s.source.id, sourceFreshness(s, checks.get(s.source.id), now)]));
  const sourceVersions = snapshot.sources.map(s => ({ sourceId: s.source.id, revision: s.source.revision, digest: s.source.digest, ...states.get(s.source.id)!, ...(checks.has(s.source.id) ? { checkedAt: checks.get(s.source.id)!.checkedAt } : {}) }));
  const unknowns = new Set<string>(), coverageReasons = new Set<string>();
  if (!change.proposedRevision && !change.diffDigest) unknowns.add("proposed-change-not-pinned");
  if (change.category === "unknown") unknowns.add("change-category-unknown");
  const seedSource = sources.get(seed.sourceId)!;
  const baselineMatches = seed.record.version === change.baselineRevision || seedSource.source.revision === change.baselineRevision;
  if (!baselineMatches) unknowns.add("baseline-revision-does-not-match-source");
  const rolloutNeeded = change.mode === "prospective" && ["code_unit", "service"].includes(seed.record.kind);
  if (rolloutNeeded && change.targetDeploymentIds.length === 0) unknowns.add("rollout-target-not-specified");
  const conflicts = conflictingAssertions(snapshot.assertions.map(a => a.record));
  const adjacency = new Map<string, Array<{ assertion: ImpactSnapshot["assertions"][number]; to: string; context: boolean }>>();
  function add(from: string, to: string, assertion: ImpactSnapshot["assertions"][number], context = false) {
    const list = adjacency.get(from) ?? []; list.push({ assertion, to, context }); adjacency.set(from, list);
  }
  for (const owned of [...snapshot.assertions].sort((a, b) => a.record.id.localeCompare(b.record.id))) {
    const a = owned.record;
    if (a.polarity !== "supports") continue;
    if (change.category !== "unknown" && !a.applicableChanges.includes(change.category) && !a.applicableChanges.includes("unknown")) continue;
    if (["depends_on", "calls", "reads_from", "writes_to", "implemented_by"].includes(a.predicate)) add(a.objectId, a.subjectId, owned);
    else if (a.predicate === "instance_of") {
      if (change.mode === "current-observed" || change.targetDeploymentIds.includes(a.subjectId)) add(a.objectId, a.subjectId, owned);
    } else if (a.predicate === "runs_on") {
      add(a.subjectId, a.objectId, owned, true);
      if (["availability", "config", "unknown"].includes(change.category)) add(a.objectId, a.subjectId, owned);
    } else if (a.predicate === "uses") {
      add(a.objectId, a.subjectId, owned);
      if (["contract", "config", "availability", "unknown"].includes(change.category)) add(a.subjectId, a.objectId, owned);
    }
  }
  type QueueEntry = { id: string; path: PathStep[]; unresolved: boolean; reasons: string[] };
  const seedState = states.get(seed.sourceId)!;
  const seedReasons = !baselineMatches ? ["baseline-revision-does-not-match-source"] : [];
  if (seedState.freshness !== "fresh") seedReasons.push(seedState.reason);
  const queue: QueueEntry[] = [{ id: change.entityId, path: [], unresolved: seedReasons.length > 0, reasons: seedReasons }];
  const visited = new Map<string, number>([[change.entityId, seedReasons.length ? 1 : 2]]);
  const found = new Map<string, ImpactFinding>();
  let examinedEdges = 0, cursor = 0;
  while (cursor < queue.length) {
    if (performance.now() - started > limits.maxMilliseconds) { coverageReasons.add("time-budget"); break; }
    const current = queue[cursor++], outgoing = adjacency.get(current.id) ?? [];
    if (current.path.length >= limits.maxDepth && outgoing.length) { coverageReasons.add("depth-budget"); continue; }
    for (const edge of outgoing) {
      if (examinedEdges >= limits.maxEdges) { coverageReasons.add("edge-budget"); break; }
      examinedEdges++;
      const a = edge.assertion.record, entity = entities.get(edge.to)!;
      const sourceState = states.get(edge.assertion.sourceId)!;
      const entityState = states.get(entity.sourceId)!;
      const reasons = [...current.reasons];
      if (sourceState.freshness !== "fresh") reasons.push(sourceState.reason);
      if (entityState.freshness !== "fresh") reasons.push(entityState.reason);
      if (a.basis === "inferred") reasons.push("inferred-relation-needs-review");
      if (conflicts.has(a.id)) reasons.push("contradictory-source-assertions");
      if (change.mode === "current-observed" && a.basis !== "observed") reasons.push("desired-is-not-observed");
      if (a.basis === "observed" && a.evidenceIds.some(id => !evidence.get(id)?.record.observedAt)) reasons.push("observation-time-unknown");
      // A logical service dependency does not identify which instance serves a
      // consumer. Only a deployment-scoped path establishes rollout routing.
      if (rolloutNeeded && entities.get(current.id)?.record.kind === "service" && a.predicate !== "instance_of") reasons.push("consumer-deployment-routing-unverified");
      if (a.predicate === "instance_of") {
        if (!entity.record.version) reasons.push("deployment-version-unknown");
        else if (entity.record.version !== change.baselineRevision) reasons.push("deployment-baseline-mismatch");
      }
      const unresolved = current.unresolved || reasons.length > 0;
      const disposition: ImpactFinding["disposition"] = edge.context ? "associated_context" : unresolved ? "unresolved" : "potentially_affected";
      const step: PathStep = { assertionId: a.id, fromId: current.id, toId: edge.to, predicate: a.predicate, sourceId: edge.assertion.sourceId, evidenceIds: [...a.evidenceIds], basis: a.basis, freshness: sourceState.freshness, conflict: conflicts.has(a.id) };
      const trace = [...current.path, step];
      if (edge.to === change.entityId || current.path.some(p => p.fromId === edge.to)) continue;
      if (!visited.has(edge.to) && visited.size >= limits.maxNodes) { coverageReasons.add("node-budget"); continue; }
      const score = disposition === "potentially_affected" ? 3 : disposition === "unresolved" ? 2 : 1;
      const prior = found.get(edge.to), priorScore = prior?.disposition === "potentially_affected" ? 3 : prior?.disposition === "unresolved" ? 2 : prior ? 1 : 0;
      const routedTargets = trace.map(p => p.toId).filter(id => change.targetDeploymentIds.includes(id));
      if (score > priorScore) found.set(edge.to, { entity: entity.record, disposition, path: trace, reasons: [...new Set(reasons)], conditionalOnDeployment: change.mode === "prospective" ? [...new Set(routedTargets)] : [] });
      if (!edge.context) {
        const strength = unresolved ? 1 : 2;
        if ((visited.get(edge.to) ?? 0) < strength) { visited.set(edge.to, strength); queue.push({ id: edge.to, path: trace, unresolved, reasons: [...new Set(reasons)] }); }
      } else if (!visited.has(edge.to)) visited.set(edge.to, 0);
    }
    if (coverageReasons.has("edge-budget")) break;
  }
  if (![...found.values()].some(f => f.entity.kind === "business_step")) unknowns.add("business-workflow-mapping-not-established");
  if (rolloutNeeded && change.targetDeploymentIds.some(id => !found.has(id))) unknowns.add("rollout-target-mapping-not-established");
  if (found.size === 0) unknowns.add("no-supported-path-found");
  for (const source of sourceVersions) if (source.freshness !== "fresh") unknowns.add(source.reason);
  const ordered = [...found.values()].sort((a, b) => {
    const rank = (f: ImpactFinding) => f.disposition === "unresolved" ? 0 : f.entity.kind === "business_step" ? 1 : f.disposition === "potentially_affected" ? 2 : 3;
    return rank(a) - rank(b) || a.path.length - b.path.length || a.entity.id.localeCompare(b.entity.id);
  });
  const presentationTruncated = ordered.length > limits.maxFindings;
  const findings = ordered.slice(0, limits.maxFindings);
  const checklist = findings.filter(f => f.disposition !== "associated_context").map(f => ({ id: `verify-${digest([change, f.entity.id]).slice(0, 20)}`, entityId: f.entity.id, assertionIds: f.path.map(p => p.assertionId), reason: f.reasons.length ? f.reasons.join("; ") : "Confirm the changed contract and deployment with the responsible owner.", ownerRole: f.entity.ownerRole, requiredEvidence: "Current scoped source revision, observed deployment version and explicit owner verification; no automated device execution.", status: "pending" as const }));
  for (const reason of [...unknowns].sort()) checklist.push({ id: `verify-${digest([change, reason]).slice(0, 20)}`, entityId: change.entityId, assertionIds: [], reason, ownerRole: seed.record.ownerRole, requiredEvidence: "Owner-reviewed source or mapping that resolves this gap.", status: "pending" });
  const report: ImpactReport = {
    schema: REPORT_SCHEMA, id: `report-${digest([change, snapshot.graphRevision, snapshot.grantFingerprint, sourceVersions, RULES_VERSION, limits, now]).slice(0, 40)}`,
    createdAt: now, input: change, inputDigest: digest(change), graphRevision: snapshot.graphRevision,
    rulesVersion: RULES_VERSION, budgets: limits, grantFingerprint: snapshot.grantFingerprint, policyVersion: grant.policyVersion, principalId: grant.principalId,
    sourceVersions, freshnessCheckedAt: now, findings, checklist, unknowns: [...unknowns].sort(),
    coverage: { traversal: coverageReasons.size ? "incomplete" : "complete", knowledge: "not_proven_complete", reasons: [...coverageReasons].sort(), visitedNodes: visited.size, examinedEdges, presentationTruncated },
    conclusion: change.mode === "prospective"
      ? "Potential impact is conditional on the specified rollout. Paths describe evidence within the authorized snapshot. No path is not proof of no impact or permission to deploy."
      : "Evidence paths describe the authorized snapshot. Desired or inferred relations do not establish current observed impact. No path is not proof of no impact."
  };
  if (presentationTruncated) report.coverage.reasons.push("presentation-limit");
  while (Buffer.byteLength(stableJson(report)) > limits.maxBytes && (report.findings.length || report.checklist.length)) {
    if (report.findings.length) report.findings.pop();
    else report.checklist.pop();
    report.coverage.presentationTruncated = true;
    if (!report.coverage.reasons.includes("byte-budget")) report.coverage.reasons.push("byte-budget");
  }
  const retained = new Set(report.findings.map(f => f.entity.id));
  report.checklist = report.checklist.filter(c => c.entityId === change.entityId || (c.entityId && retained.has(c.entityId)));
  if (Buffer.byteLength(stableJson(report)) > limits.maxBytes) fail("REPORT_BYTE_BUDGET_EXCEEDED");
  return report;
}
export function createImpactReport(filename: string, grant: ImpactGrant, change: ChangeRequest, options: ReportOptions = {}): ImpactReport {
  return buildImpactReport(readImpactSnapshot(filename, grant), change, { ...options, grant });
}
export function saveImpactReport(filename: string, grant: ImpactGrant, report: ImpactReport, options: ReportOptions = {}): { id: string } {
  const checked = revalidateImpactReport(filename, grant, report, options);
  if (!checked.current) fail("REPORT_NO_LONGER_CURRENT");
  saveReportRecord(filename, report.id, report.grantFingerprint, report.graphRevision, stableJson(report), timestamp(options.now ?? new Date().toISOString()));
  return { id: report.id };
}
/** Fails closed on policy/rules/revision changes; never returns stale report content. */
export function revalidateImpactReport(filename: string, value: ImpactGrant, report: ImpactReport, options: ReportOptions = {}): { current: boolean; reasons: string[] } {
  const grant = validateGrant(value);
  const encoded = JSON.stringify(report);
  if (!encoded || Buffer.byteLength(encoded) > 2 * 1024 * 1024 || runEgressSecretScan(encoded).blocked) fail("REPORT_UNAVAILABLE");
  if (!report || report.schema !== REPORT_SCHEMA || report.grantFingerprint !== grantFingerprint(grant) || report.principalId !== grant.principalId || report.policyVersion !== grant.policyVersion) fail("REPORT_UNAVAILABLE");
  const snapshot = readImpactSnapshot(filename, grant), reasons = new Set<string>();
  const now = timestamp(options.now ?? new Date().toISOString());
  const checks = new Map(validateSourceChecks(options.freshness ?? []).map(c => [c.sourceId, c]));
  if (report.rulesVersion !== RULES_VERSION) reasons.add("rules-changed");
  if (report.graphRevision !== snapshot.graphRevision) reasons.add("graph-changed");
  if (report.inputDigest !== digest(validateChange(report.input))) fail("REPORT_UNAVAILABLE");
  if (reasons.size) return { current: false, reasons: [...reasons].sort() };
  if (!Array.isArray(report.sourceVersions) || report.sourceVersions.length !== snapshot.sources.length || new Set(report.sourceVersions.map(s => s.sourceId)).size !== snapshot.sources.length) fail("REPORT_UNAVAILABLE");
  const currentSources = new Map(snapshot.sources.map(s => [s.source.id, s]));
  const originalChecks: SourceCheck[] = [];
  for (const previous of report.sourceVersions) {
    const source = currentSources.get(previous.sourceId);
    if (!source || source.source.digest !== previous.digest || source.source.revision !== previous.revision) fail("REPORT_UNAVAILABLE");
    if (sourceFreshness(source, checks.get(source.source.id), now).freshness !== "fresh") reasons.add("freshness-not-confirmed");
    // A historical unknown/stale report must be generated again to become a
    // current report. Fresh checks alone cannot silently promote its contents.
    if (previous.freshness !== "fresh" || !previous.checkedAt) reasons.add("original-report-freshness-not-confirmed");
    else originalChecks.push({ sourceId: source.source.id, status: "available", revision: source.source.revision, digest: source.source.digest, checkedAt: timestamp(previous.checkedAt) });
  }
  if (reasons.size) return { current: false, reasons: [...reasons].sort() };
  const createdAt = timestamp(report.createdAt);
  if (Date.parse(createdAt) > Date.parse(now) + 60_000) fail("REPORT_UNAVAILABLE");
  // Store every query budget, then recompute the complete canonical result.
  // This checks direction, disposition, checklist, source coverage and prose,
  // not merely the existence of endpoint IDs in an authorized graph.
  const canonical = buildImpactReport(snapshot, report.input, { grant, now: createdAt, freshness: originalChecks, budgets: budgets(report.budgets) });
  if (stableJson(canonical) !== stableJson(report)) fail("REPORT_UNAVAILABLE");
  return { current: true, reasons: [] };
}
export function loadImpactReport(filename: string, grant: ImpactGrant, reportId: string, options: ReportOptions = {}): ImpactReport {
  const checkedGrant = validateGrant(grant);
  const report = JSON.parse(loadReportRecord(filename, reportId, grantFingerprint(checkedGrant))) as ImpactReport;
  if (!revalidateImpactReport(filename, checkedGrant, report, options).current) fail("REPORT_NO_LONGER_CURRENT");
  return report;
}
