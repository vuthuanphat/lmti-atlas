import assert from "node:assert/strict";
import test from "node:test";
import { aggregateEffort, effortTemplate } from "./impact-effort.mjs";

// These numbers exist only to test arithmetic. They are not measured pilot effort.
function arithmeticFixture() {
  const log = effortTemplate();
  Object.assign(log.protocol, { locked: true, oracleVersion: "unit-test-only", reviewerId: "fictional-reviewer", repetitionRationale: "Arithmetic fixture, not a benchmark." });
  log.setup = { baseline: [{ personId: "engineer", minutes: 20 }], lmti: [{ personId: "engineer", minutes: 100 }] };
  for (const run of log.runs) {
    for (const arm of ["baseline", "lmti"]) {
      Object.assign(run[arm], { status: "completed", dataRevision: "unit-fixture-A", modelVersion: "none-unit-test", budgetId: "unit-budget" });
      run[arm].effort = { update: [], staleConflict: [], repair: [], review: [
        { personId: "engineer", minutes: arm === "baseline" ? 10 : 4 },
        { personId: "reviewer", minutes: arm === "baseline" ? 5 : 2 },
      ] };
      Object.keys(run[arm].quality).forEach(key => { run[arm].quality[key] = key === "reviewed" ? true : key === "truePositive" ? 2 : 0; });
      run[arm].wallClockMinutes = 4;
    }
  }
  return log;
}

test("blank human template remains insufficient evidence with unknown savings", () => {
  const result = aggregateEffort(effortTemplate());
  assert.equal(result.status, "insufficient_evidence");
  assert.equal(result.coldReductionPercent, null);
  assert.equal(result.targetAssessment, "not_evaluable");
  assert.equal(result.personMinutes.lmti.cold, null);
});

test("adds every worker's minutes even in parallel and includes setup in cold cost", () => {
  const result = aggregateEffort(arithmeticFixture());
  assert.equal(result.personMinutes.baseline.operating, 300);
  assert.equal(result.personMinutes.baseline.wallClockMinutes, 80);
  assert.equal(result.personMinutes.lmti.operating, 120);
  assert.equal(result.personMinutes.baseline.cold, 320);
  assert.equal(result.personMinutes.lmti.cold, 220);
  assert.equal(result.coldReductionPercent, 31.25);
  assert.equal(result.operatingReductionPercent, 60);
  assert.deepEqual(result.savingsDistributionPersonMinutes, { count: 20, min: 9, median: 9, max: 9 });
  assert.equal(result.holdoutSavingsDistributionPersonMinutes.count, 8);
});

test("does not hide setup costs behind attractive operating savings", () => {
  const log = arithmeticFixture();
  log.setup.lmti[0].minutes = 300;
  const result = aggregateEffort(log);
  assert.equal(result.operatingReductionPercent, 60);
  assert.equal(result.coldReductionPercent, -31.25);
  assert.equal(result.targetAssessment, "not_met_in_logged_workload");
});

test("keeps failed/timeout runs and recovery time in the denominator and quality gate", () => {
  const log = arithmeticFixture();
  log.runs[4].lmti.status = "timeout";
  log.runs[4].lmti.effort.repair = [{ personId: "engineer", minutes: 80 }];
  log.runs[4].lmti.quality.seriousFailures = 1;
  const result = aggregateEffort(log);
  assert.equal(result.recordedPairs, 20);
  assert.equal(result.personMinutes.lmti.failedOrTimedOutRuns, 1);
  assert.equal(result.personMinutes.lmti.operating, 200);
  assert.equal(result.qualityGate, false);
  assert.equal(result.targetAssessment, "not_met_in_logged_workload");
});

test("missing effort, a missing pair or incompatible comparison conditions cannot yield a win", () => {
  for (const modify of [log => { log.runs[0].lmti.effort.repair = null; },
    log => { log.runs.pop(); }, log => { log.runs[2].lmti.budgetId = "different-budget"; },
    log => { log.runs[2].baseline = null; }, log => { log.runs[2].lmti.quality.reviewed = false; }]) {
    const log = arithmeticFixture(); modify(log);
    const result = aggregateEffort(log);
    assert.equal(result.status, "insufficient_evidence");
    assert.equal(result.targetAssessment, "not_evaluable");
    assert.equal(result.coldReductionPercent, null);
  }
});

test("rejects duplicate runs, split changes, negative durations and silent extra effort categories", () => {
  for (const modify of [log => { log.runs.push(structuredClone(log.runs[0])); },
    log => { log.runs[12].split = "development"; }, log => { log.setup.lmti[0].minutes = -1; },
    log => { log.runs[1].lmti.effort.hidden = []; }]) {
    const log = arithmeticFixture(); modify(log);
    assert.throws(() => aggregateEffort(log), /INVALID_EFFORT_LOG/);
  }
});

test("a critical miss, disclosure, or lower recall prevents a positive assessment", () => {
  for (const metric of ["criticalMisses", "unauthorizedDisclosures", "falseNegative", "evidenceErrors", "unknownHandlingErrors"]) {
    const log = arithmeticFixture(); log.runs[19].lmti.quality[metric] = 1;
    const result = aggregateEffort(log);
    assert.equal(result.status, "complete_logged_workload");
    assert.equal(result.qualityGate, false);
    assert.equal(result.targetAssessment, "not_met_in_logged_workload");
  }
});

test("development improvements cannot conceal a holdout quality regression", () => {
  const log = arithmeticFixture();
  log.runs[0].baseline.quality.falseNegative = 10;
  log.runs[12].lmti.quality.falseNegative = 1;
  const result = aggregateEffort(log);
  assert.ok(result.quality.lmti.recall > result.quality.baseline.recall);
  assert.ok(result.qualityBySplit.holdout.lmti.recall < result.qualityBySplit.holdout.baseline.recall);
  assert.equal(result.qualityGate, false);
});
