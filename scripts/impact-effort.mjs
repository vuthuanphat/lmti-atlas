import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CASE_IDS = Array.from({ length: 20 }, (_, index) => `C${String(index + 1).padStart(2, "0")}`);
const PHASES = ["update", "staleConflict", "review", "repair"];
const QUALITY = ["truePositive", "falsePositive", "falseNegative", "evidenceErrors", "unknownHandlingErrors", "criticalMisses", "seriousFailures", "unauthorizedDisclosures"];
const ARMS = ["baseline", "lmti"];
const invalid = () => { throw new Error("INVALID_EFFORT_LOG"); };
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const label = value => typeof value === "string" && value.trim().length > 0 && value.length <= 160 && !/[\x00-\x1f\x7f]/u.test(value);
const missing = value => value === null || value === undefined;
const rounded = value => value === null ? null : Math.round(value * 10000) / 10000;

export function effortTemplate() {
  const unknownEffort = () => [{ personId: "engineer", minutes: null }, { personId: "domain-reviewer", minutes: null }];
  const arm = () => ({
    status: "unmeasured", dataRevision: null, modelVersion: null, budgetId: null,
    effort: Object.fromEntries(PHASES.map(phase => [phase, unknownEffort()])),
    quality: { reviewed: false, ...Object.fromEntries(QUALITY.map(metric => [metric, null])) },
    wallClockMinutes: null,
  });
  return {
    schema: "lmti.impact.effort.v1",
    protocol: { id: "impact-evaluation-pending", locked: false, oracleVersion: null, reviewerId: null,
      repetitions: 1, repetitionRationale: null, maxRecallDrop: 0, maxPrecisionDrop: 0 },
    setup: { baseline: unknownEffort(), lmti: unknownEffort() },
    runs: CASE_IDS.map((caseId, index) => ({ caseId, split: index < 12 ? "development" : "holdout", repetition: 1,
      baseline: arm(), lmti: arm() })),
  };
}

/** Pure accounting only. Logged numbers and oracle approval still require human review. */
export function aggregateEffort(input) {
  if (!object(input) || input.schema !== "lmti.impact.effort.v1" || !object(input.protocol) || !object(input.setup) || !Array.isArray(input.runs) || input.runs.length > 200) invalid();
  const protocol = input.protocol;
  if (!label(protocol.id) || typeof protocol.locked !== "boolean" || !Number.isInteger(protocol.repetitions) || protocol.repetitions < 1 || protocol.repetitions > 10) invalid();
  const reasons = new Set();
  if (!protocol.locked || !label(protocol.oracleVersion) || !label(protocol.reviewerId)) reasons.add("oracle_or_protocol_not_reviewed_and_locked");
  if (protocol.repetitions < 3 && !label(protocol.repetitionRationale)) reasons.add("reduced_repetitions_not_explained");
  for (const threshold of ["maxRecallDrop", "maxPrecisionDrop"]) {
    if (missing(protocol[threshold])) reasons.add("quality_threshold_missing");
    else if (typeof protocol[threshold] !== "number" || !Number.isFinite(protocol[threshold]) || protocol[threshold] < 0 || protocol[threshold] > 1) invalid();
  }
  function effort(entries) {
    if (missing(entries)) { reasons.add("person_minutes_missing"); return { known: 0, complete: false }; }
    if (!Array.isArray(entries) || entries.length > 100) invalid();
    let known = 0, complete = true;
    for (const entry of entries) {
      if (!object(entry) || !label(entry.personId) || Object.keys(entry).some(key => !["personId", "minutes"].includes(key))) invalid();
      if (missing(entry.minutes)) { complete = false; reasons.add("person_minutes_missing"); }
      else if (typeof entry.minutes !== "number" || !Number.isFinite(entry.minutes) || entry.minutes < 0 || entry.minutes > 1_000_000) invalid();
      else known += entry.minutes;
    }
    return { known, complete };
  }
  const totals = Object.fromEntries(ARMS.map(arm => [arm, { setup: effort(input.setup[arm]), operatingKnown: 0, operatingComplete: true, failures: 0, wallClockKnown: 0, wallClockComplete: true }]));
  const qualityTotals = Object.fromEntries(ARMS.map(arm => [arm, Object.fromEntries(QUALITY.map(metric => [metric, 0]))]));
  const splitQuality = Object.fromEntries(["development", "holdout"].map(split => [split, structuredClone(qualityTotals)]));
  let qualityComplete = true;
  const seen = new Set(), paired = [];
  for (const run of input.runs) {
    if (!object(run) || !CASE_IDS.includes(run.caseId) || !Number.isInteger(run.repetition) || run.repetition < 1 || run.repetition > protocol.repetitions) invalid();
    const expectedSplit = Number(run.caseId.slice(1)) <= 12 ? "development" : "holdout";
    const key = `${run.caseId}:${run.repetition}`;
    if (run.split !== expectedSplit || seen.has(key)) invalid();
    seen.add(key);
    const pair = { caseId: run.caseId, repetition: run.repetition, split: run.split };
    for (const arm of ARMS) {
      const value = run[arm];
      if (!object(value)) { reasons.add("paired_run_missing"); totals[arm].operatingComplete = false; qualityComplete = false; pair[arm] = null; continue; }
      if (!["unmeasured", "completed", "failed", "timeout"].includes(value.status)) invalid();
      if (value.status === "unmeasured") reasons.add("run_unmeasured");
      if (["failed", "timeout"].includes(value.status)) totals[arm].failures += 1;
      if (!object(value.effort)) { reasons.add("person_minutes_missing"); totals[arm].operatingComplete = false; pair[arm] = null; }
      else {
        if (Object.keys(value.effort).some(phase => !PHASES.includes(phase))) invalid();
        const phases = PHASES.map(phase => effort(value.effort[phase]));
        const known = phases.reduce((sum, phase) => sum + phase.known, 0);
        const complete = phases.every(phase => phase.complete) && value.status !== "unmeasured";
        totals[arm].operatingKnown += known;
        totals[arm].operatingComplete &&= complete;
        pair[arm] = complete ? known : null;
      }
      for (const condition of ["dataRevision", "modelVersion", "budgetId"]) {
        if (!label(value[condition])) reasons.add("comparison_conditions_missing");
      }
      if (!object(value.quality) || value.quality.reviewed !== true) {
        qualityComplete = false; reasons.add("quality_review_missing");
      } else {
        for (const metric of QUALITY) {
          const count = value.quality[metric];
          if (missing(count)) { qualityComplete = false; reasons.add("quality_measurement_missing"); }
          else if (!Number.isSafeInteger(count) || count < 0 || count > 1_000_000) invalid();
          else { qualityTotals[arm][metric] += count; splitQuality[run.split][arm][metric] += count; }
        }
      }
      if (missing(value.wallClockMinutes)) totals[arm].wallClockComplete = false;
      else if (typeof value.wallClockMinutes !== "number" || !Number.isFinite(value.wallClockMinutes) || value.wallClockMinutes < 0 || value.wallClockMinutes > 1_000_000) invalid();
      else totals[arm].wallClockKnown += value.wallClockMinutes;
    }
    if (object(run.baseline) && object(run.lmti)) {
      for (const condition of ["dataRevision", "modelVersion", "budgetId"]) {
        if (label(run.baseline[condition]) && label(run.lmti[condition]) && run.baseline[condition] !== run.lmti[condition]) reasons.add("paired_conditions_differ");
      }
    }
    pair.savedPersonMinutes = pair.baseline === null || pair.lmti === null ? null : rounded(pair.baseline - pair.lmti);
    paired.push(pair);
  }
  const expectedPairs = 20 * protocol.repetitions;
  if (seen.size !== expectedPairs) reasons.add("registered_workload_incomplete");
  const personMinutes = Object.fromEntries(ARMS.map(arm => {
    const t = totals[arm];
    const operating = t.operatingComplete && seen.size === expectedPairs ? t.operatingKnown : null;
    return [arm, {
      setup: t.setup.complete ? rounded(t.setup.known) : null,
      operating: rounded(operating),
      cold: operating !== null && t.setup.complete ? rounded(operating + t.setup.known) : null,
      recordedKnown: rounded(t.setup.known + t.operatingKnown),
      failedOrTimedOutRuns: t.failures,
      wallClockMinutes: t.wallClockComplete && seen.size === expectedPairs ? rounded(t.wallClockKnown) : null,
    }];
  }));
  if (personMinutes.baseline.cold === 0) reasons.add("baseline_cold_effort_is_zero");
  const ratio = (numerator, denominator) => denominator === 0 ? null : numerator / denominator;
  const summarizeQuality = totals => Object.fromEntries(ARMS.map(arm => {
    const q = totals[arm];
    return [arm, { ...q, recall: ratio(q.truePositive, q.truePositive + q.falseNegative), precision: ratio(q.truePositive, q.truePositive + q.falsePositive) }];
  }));
  const quality = qualityComplete && seen.size === expectedPairs ? summarizeQuality(qualityTotals) : null;
  const qualityBySplit = quality ? Object.fromEntries(Object.entries(splitQuality).map(([split, totals]) => [split, summarizeQuality(totals)])) : null;
  if (quality && [quality, qualityBySplit.holdout].some(group => ARMS.some(arm => group[arm].recall === null || group[arm].precision === null))) reasons.add("quality_denominator_is_zero");
  const complete = reasons.size === 0;
  const reduction = phase => complete && personMinutes.baseline[phase] > 0 ? rounded(100 * (personMinutes.baseline[phase] - personMinutes.lmti[phase]) / personMinutes.baseline[phase]) : null;
  const coldReductionPercent = reduction("cold"), operatingReductionPercent = reduction("operating");
  const qualityPass = complete && quality && [quality, qualityBySplit.holdout].every(group =>
    group.lmti.criticalMisses === 0 && group.lmti.seriousFailures === 0 && group.lmti.unauthorizedDisclosures === 0 &&
    group.lmti.recall + protocol.maxRecallDrop >= group.baseline.recall && group.lmti.precision + protocol.maxPrecisionDrop >= group.baseline.precision &&
    group.lmti.evidenceErrors <= group.baseline.evidenceErrors && group.lmti.unknownHandlingErrors <= group.baseline.unknownHandlingErrors);
  function distribution(values) {
    const sorted = values.filter(value => value !== null).sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length ? { count: sorted.length, min: rounded(sorted[0]), median: rounded(sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2), max: rounded(sorted.at(-1)) } : null;
  }
  return {
    schema: "lmti.impact.effort-summary.v1",
    status: complete ? "complete_logged_workload" : "insufficient_evidence",
    reasons: [...reasons].sort(), registeredCases: 20, recordedPairs: seen.size, expectedPairs,
    personMinutes, quality, qualityBySplit, coldReductionPercent, operatingReductionPercent,
    targetReductionPercent: 20,
    targetAssessment: !complete ? "not_evaluable" :
      (totals.baseline.setup.known + totals.baseline.operatingKnown - totals.lmti.setup.known - totals.lmti.operatingKnown) /
      (totals.baseline.setup.known + totals.baseline.operatingKnown) >= 0.2 && qualityPass ? "met_in_logged_workload" : "not_met_in_logged_workload",
    qualityGate: complete ? Boolean(qualityPass) : null,
    savingsDistributionPersonMinutes: complete ? distribution(paired.map(pair => pair.savedPersonMinutes)) : null,
    holdoutSavingsDistributionPersonMinutes: complete ? distribution(paired.filter(pair => pair.split === "holdout").map(pair => pair.savedPersonMinutes)) : null,
    pairs: paired,
    interpretation: "Accounting of supplied logs only; not independent verification, production approval, or proof of general safety. Parallel workers' minutes are added. Failed runs are retained.",
  };
}

async function main(args) {
  if (args.length === 1 && args[0] === "--template") return effortTemplate();
  if (args.length === 2 && args[0] === "--template") {
    await writeFile(path.resolve(args[1]), `${JSON.stringify(effortTemplate(), null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    return { status: "unmeasured_template_created", measurements: "pending" };
  }
  if (args.length !== 1 || args[0].startsWith("--")) throw new Error("USAGE: node scripts/impact-effort.mjs <log.json> | --template");
  const filename = path.resolve(args[0]);
  if ((await stat(filename)).size > 2 * 1024 * 1024) invalid();
  const bytes = await readFile(filename);
  if (bytes.length > 2 * 1024 * 1024) invalid();
  return aggregateEffort(JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/u, "")));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch(() => {
    process.stderr.write("INVALID_EFFORT_LOG: provide a bounded valid log file, or use --template.\n");
    process.exitCode = 2;
  });
}
