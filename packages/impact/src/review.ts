import { runEgressSecretScan } from "@atlas/privacy";
import {
  type ImpactGrant, type ImpactReport, type SourceCheck, boundedInteger, digest,
  fail, grantFingerprint, identifier, stableJson, textValue, timestamp, validateGrant
} from "./model.js";
import { revalidateImpactReport } from "./report.js";
import {
  appendReviewRecord, loadReportRecord, readReviewRecords, type ReviewRecordBinding
} from "./store.js";

export type ImpactReviewStatus = "pending" | "verified" | "failed";
export interface ImpactReviewRequest {
  reportId: string; checklistId: string; status: ImpactReviewStatus;
  expectedGraphRevision: number; expectedReviewRevision: number;
  evidenceSummary?: string; evidenceRef?: string;
}
export interface ImpactReviewRecord {
  id: string; reportId: string; checklistId: string; status: ImpactReviewStatus;
  revision: number; graphRevision: number; bindingHash: string;
  reviewer: string; recordedAt: string; evidenceSummary?: string; evidenceRef?: string;
}
export interface ImpactReviewEntry {
  checklistId: string; status: ImpactReviewStatus; reviewer?: string;
  evidenceSummary?: string; evidenceRef?: string; recordedAt?: string; revision?: number;
}
export interface ImpactReviewState {
  schema: "lmti.impact.review.v1"; reportId: string; graphRevision: number;
  reviewRevision: number; current: boolean; reasons: string[];
  entries: ImpactReviewEntry[]; history: ImpactReviewRecord[];
}
export interface ImpactReviewOperatorOptions {
  /** Trusted owner identity. Never supplied by a proposal, Agent or review payload. */
  reviewer: string;
  /** Re-read owner sources for each operation; never use client freshness claims. */
  freshness: () => SourceCheck[];
  now?: () => string;
}
const MAX_REVIEW_EVENTS = 1000;
const REQUEST_FIELDS = ["reportId", "checklistId", "status", "expectedGraphRevision", "expectedReviewRevision", "evidenceSummary", "evidenceRef"];
function metadata(value: unknown): void {
  let encoded: string | undefined;
  try { encoded = JSON.stringify(value); } catch { fail("INVALID_REVIEW_REQUEST"); }
  if (!encoded || Buffer.byteLength(encoded) > 4096 || runEgressSecretScan(encoded).blocked) fail("SENSITIVE_REVIEW_METADATA_DENIED");
}
function status(value: unknown): ImpactReviewStatus {
  if (value !== "pending" && value !== "verified" && value !== "failed") fail("INVALID_REVIEW_STATUS");
  return value;
}
function evidence(value: Record<string, unknown>, state: ImpactReviewStatus): { evidenceSummary?: string; evidenceRef?: string } {
  if (state !== "pending" && (value.evidenceSummary === undefined || value.evidenceRef === undefined)) fail("REVIEW_EVIDENCE_REQUIRED");
  const result: { evidenceSummary?: string; evidenceRef?: string } = {};
  if (value.evidenceSummary !== undefined) result.evidenceSummary = textValue(value.evidenceSummary, 1000);
  if (value.evidenceRef !== undefined) {
    const locator = textValue(value.evidenceRef, 512);
    // References are provenance metadata only. No paths are opened and no URL,
    // absolute path or traversal can turn a review into a filesystem capability.
    if (locator.startsWith("/") || locator.startsWith("\\") || /^[a-z]+:/iu.test(locator) || locator.split(/[\\/]/u).some(part => part === "..")) fail("UNSAFE_REVIEW_REFERENCE");
    result.evidenceRef = locator;
  }
  return result;
}
function request(value: unknown): ImpactReviewRequest {
  metadata(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("INVALID_REVIEW_REQUEST");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !REQUEST_FIELDS.includes(key))) fail("UNKNOWN_REVIEW_FIELD");
  const state = status(input.status);
  return {
    reportId: identifier(input.reportId), checklistId: identifier(input.checklistId), status: state,
    expectedGraphRevision: boundedInteger(input.expectedGraphRevision, 0, Number.MAX_SAFE_INTEGER),
    expectedReviewRevision: boundedInteger(input.expectedReviewRevision, 0, MAX_REVIEW_EVENTS),
    ...evidence(input, state)
  };
}
function binding(report: ImpactReport): ReviewRecordBinding {
  const reportHash = digest(report);
  return { reportId: report.id, reportHash, grantHash: report.grantFingerprint,
    graphRevision: report.graphRevision,
    bindingHash: digest({ reportHash, grantFingerprint: report.grantFingerprint,
      graphRevision: report.graphRevision, sourceVersions: report.sourceVersions }) };
}
function eventIdentity(record: Omit<ImpactReviewRecord, "id">): string {
  return `review-${digest(record).slice(0, 40)}`;
}
function historyRecord(json: string, report: ImpactReport, bound: ReviewRecordBinding, expectedRevision: number): ImpactReviewRecord {
  const value = JSON.parse(json) as ImpactReviewRecord;
  metadata(value);
  const allowed = ["id", "reportId", "checklistId", "status", "revision", "graphRevision", "bindingHash", "reviewer", "recordedAt", "evidenceSummary", "evidenceRef"];
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) fail("INVALID_REVIEW_HISTORY");
  const state = status(value.status);
  const normalized: Omit<ImpactReviewRecord, "id"> = {
    reportId: identifier(value.reportId), checklistId: identifier(value.checklistId), status: state,
    revision: boundedInteger(value.revision, 1, MAX_REVIEW_EVENTS),
    graphRevision: boundedInteger(value.graphRevision, 0, Number.MAX_SAFE_INTEGER),
    bindingHash: textValue(value.bindingHash, 64), reviewer: identifier(value.reviewer),
    recordedAt: timestamp(value.recordedAt), ...evidence(value as unknown as Record<string, unknown>, state)
  };
  if (normalized.reportId !== report.id || normalized.graphRevision !== report.graphRevision || normalized.bindingHash !== bound.bindingHash || normalized.revision !== expectedRevision || !report.checklist.some(task => task.id === normalized.checklistId) || Date.parse(normalized.recordedAt) < Date.parse(report.createdAt) || value.id !== eventIdentity(normalized)) fail("INVALID_REVIEW_HISTORY");
  return { id: value.id, ...normalized };
}

/**
 * Operator-only capability created by a trusted launcher, outside model tools.
 * A verification records a human claim with evidence; it does not approve device
 * execution, promote a graph assertion or alter the canonical report checklist.
 */
export function createImpactReviewOperator(filename: string, value: ImpactGrant, options: ImpactReviewOperatorOptions): {
  read(reportId: string): ImpactReviewState;
  record(value: unknown): ImpactReviewState;
} {
  // Copy authority so later caller mutation cannot silently broaden this handle.
  const grant = validateGrant(structuredClone(value)), reviewer = identifier(options.reviewer);
  const freshness = options.freshness, clock = options.now ?? (() => new Date().toISOString());
  if (typeof freshness !== "function" || typeof clock !== "function") fail("INVALID_REVIEW_OPERATOR");
  function read(reportId: string, at: string): { report: ImpactReport; state: ImpactReviewState; bound: ReviewRecordBinding } {
    identifier(reportId);
    const report = JSON.parse(loadReportRecord(filename, reportId, grantFingerprint(grant))) as ImpactReport;
    if (report.id !== reportId) fail("REPORT_UNAVAILABLE");
    const checked = revalidateImpactReport(filename, grant, report, { freshness: freshness(), now: at });
    const bound = binding(report);
    const state: ImpactReviewState = { schema: "lmti.impact.review.v1", reportId, graphRevision: report.graphRevision,
      reviewRevision: 0, current: checked.current, reasons: checked.reasons, entries: [], history: [] };
    // An old verification is never presented as a current checked box. Revoked
    // grants already failed before this point; stale records remain in storage.
    if (!checked.current) return { report, state, bound };
    const stored = readReviewRecords(filename, bound);
    if (stored.records.length > MAX_REVIEW_EVENTS || stored.records.length !== stored.reviewRevision) fail("INVALID_REVIEW_HISTORY");
    state.reviewRevision = stored.reviewRevision;
    state.history = stored.records.map((json, index) => historyRecord(json, report, bound, index + 1));
    let previousTime = Date.parse(report.createdAt);
    for (const event of state.history) {
      const time = Date.parse(event.recordedAt);
      if (time < previousTime || time > Date.parse(at) + 60_000) fail("INVALID_REVIEW_HISTORY");
      previousTime = time;
    }
    const latest = new Map(state.history.map(event => [event.checklistId, event]));
    state.entries = report.checklist.map(task => {
      const event = latest.get(task.id);
      return event ? { checklistId: task.id, status: event.status, reviewer: event.reviewer,
        recordedAt: event.recordedAt, revision: event.revision,
        ...(event.evidenceSummary ? { evidenceSummary: event.evidenceSummary } : {}),
        ...(event.evidenceRef ? { evidenceRef: event.evidenceRef } : {}) }
        : { checklistId: task.id, status: "pending" };
    });
    return { report, state, bound };
  }
  return {
    read(reportId) { return read(reportId, timestamp(clock())).state; },
    record(value) {
      const input = request(value), now = timestamp(clock());
      const { report, state, bound } = read(input.reportId, now);
      if (!state.current) fail("REPORT_NO_LONGER_CURRENT");
      if (input.expectedGraphRevision !== report.graphRevision) fail("IMPACT_REVISION_CONFLICT");
      if (input.expectedReviewRevision !== state.reviewRevision) fail("REVIEW_REVISION_CONFLICT");
      if (!report.checklist.some(task => task.id === input.checklistId)) fail("CHECKLIST_UNAVAILABLE");
      if (state.reviewRevision >= MAX_REVIEW_EVENTS) fail("REVIEW_CAPACITY_EXCEEDED");
      const previous = state.history.filter(event => event.checklistId === input.checklistId).at(-1);
      if (previous && previous.status === input.status && previous.evidenceSummary === input.evidenceSummary && previous.evidenceRef === input.evidenceRef && previous.reviewer === reviewer) fail("REVIEW_DUPLICATE");
      if (Date.parse(now) < Date.parse(state.history.at(-1)?.recordedAt ?? report.createdAt)) fail("INVALID_REVIEW_TIME");
      const record: Omit<ImpactReviewRecord, "id"> = {
        reportId: report.id, checklistId: input.checklistId, status: input.status,
        revision: state.reviewRevision + 1, graphRevision: report.graphRevision,
        bindingHash: bound.bindingHash, reviewer, recordedAt: now,
        ...(input.evidenceSummary ? { evidenceSummary: input.evidenceSummary } : {}),
        ...(input.evidenceRef ? { evidenceRef: input.evidenceRef } : {})
      };
      const event = { id: eventIdentity(record), ...record };
      appendReviewRecord(filename, bound, input.expectedReviewRevision, stableJson(event), () => {
        if (!revalidateImpactReport(filename, grant, report, { freshness: freshness(), now }).current) fail("REPORT_NO_LONGER_CURRENT");
      });
      // Recheck the owner source after committing. A concurrent source change
      // invalidates presentation without deleting the append-only human event.
      return read(report.id, now).state;
    }
  };
}
