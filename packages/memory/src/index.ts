import { promises as fs } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type {
  AmfDocument,
  AtlasIndex,
  InferredIntent,
  MemoryConfidence,
  MemoryContextMode,
  MemoryKind,
  MemoryMetadata,
  MemoryPatch,
  MemorySearchResult,
  PolicyDecision,
  PolicySafeMemoryResult,
  PromptPolicy,
  MemoryRecord,
  MemoryScope,
  MemorySearchOptions,
  MemorySensitivity,
  NewMemoryRecord,
  ObserverFrame,
  PrivacyContext
} from "@atlas/types";
import { AMF_VERSION, createEmptyAmf } from "@atlas/types";
import {
  auditSensitiveAccess,
  createPrivacyContext,
  createSafeSummary,
  evaluateAccess,
  hardGateMemoryMetadata,
  redactText
} from "@atlas/privacy";
import type { MemoryAddInput, MemorySearchQuery, MemoryStore } from "./types";
import { summarizeAssociations, reinforceAssociationSet } from "./associations";
import { createConsolidationCandidate, detectSupersession, findSimilarLongTermMemory } from "./consolidate";
import { decayLongTermMemoryRecord } from "./decay";
import { encodeMemory } from "./encode";
import { DEFAULT_CONTEXT_ACTIVATION_THRESHOLD, explainPrivacyDecision, scoreMemoryForRetrieval } from "./retrieval";
import { reinforceMemoryRecord } from "./reinforce";
import { reviewMemoryRecords, type MemoryReviewReport } from "./review";
import { readProjectMemoryRecords } from "./sqlite-store";
import { checkedMemoryFile, MAX_CONTEXT_MEMORY_BYTES, readBoundedMemoryText, requireCompleteMemoryScan } from "./read-boundary";
import { checkedStoragePath, ensureMemoryDirectory, writeMemoryFile } from "./storage-boundary";

export type { MemoryAddInput, MemorySearchQuery, MemoryStore } from "./types";
export type { MemoryRecord, MemorySearchResult };
export { encodeMemory } from "./encode";
export {
  addProjectMemory,
  approveLessonCandidate,
  checkProjectMemoryPrivacy,
  classifyLibraryMemory,
  cleanupShortMemoryNotes,
  createShortMemoryNote,
  deleteProjectMemory,
  evaluateShortMemoryForPromotion,
  expireShortMemoryNotes,
  getProjectMemoryStats,
  getLessonCandidate,
  getLessonCandidateReviewSummary,
  initProjectMemoryStorage,
  readProjectMemorySnapshot,
  reviewDesktopLesson,
  LIBRARY_ZONES,
  listLessonCandidates,
  migrateJsonMemoryToProjectMemory,
  PROJECT_MEMORY_DB_FILE,
  proposeLessonCandidate,
  promoteShortMemoryToLongMemory,
  rejectLessonCandidate,
  retrieveMemoryContextForTask,
  retrieveMemoryForTask,
  retrieveShortMemoryForTask,
  searchProjectMemory,
  suggestZonesForTask,
  updateProjectMemory,
  type AddProjectMemoryInput,
  type CreateShortMemoryNoteInput,
  type LessonCandidateListOptions,
  type LessonCandidateReviewSummary,
  type LessonProposalInput,
  type LessonProposalResult,
  type LibraryClassification,
  type LibraryPrivacyLevel,
  type LibraryZone,
  type MemoryContextForTaskResult,
  type PromoteShortMemoryResult,
  type ProjectMemoryItem,
  type ProjectMemoryPrivacyFinding,
  type ProjectMemorySearchOptions,
  type ProjectMemorySearchResult,
  type ProjectMemoryStats,
  type ProjectMemoryStorageInitResult,
  type RetrieveMemoryForTaskOptions,
  type RetrieveShortMemoryOptions,
  type RetrieveShortMemoryResult,
  type ShortMemoryCleanupResult,
  type ShortMemoryExpirationResult,
  type ShortMemoryNote,
  type ShortMemoryPriority,
  type ShortMemoryPromotionEvaluation,
  type ShortMemoryRetrievalNote,
  type ShortMemoryStatus,
  type ShortMemoryTtl
} from "./sqlite-store";

export const LMTI_DIR = ".lmti";
export const ATLAS_DIR = LMTI_DIR;
export const AMF_FILE = "project.amf.json";
export const INDEX_FILE = "index.json";
export const CONFIG_FILE = "config.json";
export const MEMORY_DIR = "memory";
export const EXPERIMENTS_DIR = "experiments";
export const EVENTS_DIR = "events";
export const SHORT_TERM_MEMORY_FILE = "short-term.json";
export const LONG_TERM_MEMORY_FILE = "long-term.json";
export const LESSONS_MEMORY_FILE = "lessons.json";
export const MEMORY_EVENTS_FILE = "events.jsonl";
export const TASK_EVENTS_FILE = "tasks.jsonl";
const DEFAULT_SHORT_TERM_TTL_MS = 24 * 60 * 60 * 1000;
const CONTEXT_MEMORY_SCORE_THRESHOLD = 3;

export interface InitResult {
  atlasDir: string;
  amfPath: string;
  indexPath: string;
  configPath: string;
  memoryDir: string;
  experimentsDir: string;
  eventsDir: string;
}

export interface LmtiConfig {
  version: "0.1.0";
  kernel: "atlas";
  projectName: string;
  migratedFrom?: "atlas";
  legacyDetected?: boolean;
  privacy: {
    defaultRole: "developer";
    allowSecretExport: false;
    allowExternalModelRawMemory: false;
  };
  codex: {
    attached: boolean;
    agentsFile: "AGENTS.md";
  };
}

export interface MemoryRuntimeOptions {
  cwd?: string;
  now?: Date;
  shortTermTtlMs?: number;
  privacyContext?: PrivacyContext;
}

export interface MemoryPrivacyFinding {
  id: string;
  scope: MemoryScope;
  sensitivity?: string;
  issue: string;
  recommendation: string;
}

export interface ContextMemorySearchResult {
  results: MemorySearchResult[];
  filteredOut: number;
}

export interface MemoryDecayReport {
  removedShortTerm: number;
  updatedLongTerm: number;
  weakenedLongTerm: number;
  archivedLongTerm: number;
}

export interface MemoryConsolidationResult {
  created: Array<{ id: string; title: string; sourceId: string }>;
  reinforced: Array<{ id: string; title: string; sourceId: string }>;
  skipped: Array<{ id: string; title: string; reason: string }>;
}

export interface MemoryReinforcementResult {
  memory: MemoryRecord;
  success: boolean;
}

export interface MemoryExplainEntry {
  id: string;
  title: string;
  kind: MemoryKind;
  sensitivity: MemorySensitivity;
  promptPolicy: PromptPolicy;
  status: MemoryRecord["status"];
  score: number;
  activation: number;
  lexicalScore: number;
  intentScore: number;
  contextCueMatch: number;
  associationScore: number;
  priorityScore: number;
  negativeKeywordPenalty: number;
  privacyPenalty: number;
  privacyDecision: string;
  why: string[];
  filteredOutReason?: string;
}

export interface MemoryExplainResult {
  query: string;
  taskIntent: InferredIntent;
  selected: MemoryExplainEntry[];
  filteredOut: MemoryExplainEntry[];
}

export interface TaskDoneInput {
  title: string;
  summary: string;
  lesson?: string;
  tags?: string[];
  sensitivity?: MemorySensitivity;
  promptPolicy?: PromptPolicy;
  projectId?: string;
  taskIntent?: InferredIntent;
}

export interface TaskDoneEvent {
  title: string;
  summary: string;
  lessonMemoryId?: string;
  tags: string[];
  projectId: string;
  inferredIntent?: InferredIntent;
  recordedAt: string;
}

export interface TaskDoneResult {
  event: TaskDoneEvent;
  lessonMemory?: MemoryRecord;
  suggestion?: string;
}

export interface MemorySanitizationResult {
  mode: MemoryContextMode;
  record?: MemoryRecord;
  reason: string;
}

export interface RetrieveMemoryMetadataOptions extends MemoryRuntimeOptions {
  scope?: MemoryScope;
  kind?: MemoryKind;
}

export interface FetchAllowedMemoryContentOptions extends MemoryRuntimeOptions {
  metadata: MemoryMetadata[];
  privacyContext: PrivacyContext;
  taskIntent: InferredIntent;
  policyDecisions?: PolicyDecision[];
  limit?: number;
}

export interface ReadContextMemoryOptions extends MemorySearchOptions, MemoryRuntimeOptions {
  taskIntent?: InferredIntent;
  source?: "auto" | "sqlite" | "legacy_json";
  observer?: ObserverFrame;
  maxCandidates?: number;
}

export interface ContextMemorySelection extends ContextMemorySearchResult {
  source: "sqlite" | "legacy_json" | "none";
  completeness: "complete";
  revision: string;
  policySafeCandidates: PolicySafeMemoryResult[];
  gate: ReturnType<typeof hardGateMemoryMetadata>;
}

/** One consistent, side-effect-free read for normal context and preflight.
 * Final limits apply after policy-safe scoring. A scan beyond the supported
 * 10,000-record/16-MiB budget fails explicitly instead of claiming completeness.
 */
export async function readContextMemory(query: string, options: ReadContextMemoryOptions = {}): Promise<ContextMemorySelection> {
  if (typeof query !== "string" || query.length > 16_384) throw new Error("MEMORY_QUERY_INVALID");
  if (options.source !== undefined && !["auto", "sqlite", "legacy_json"].includes(options.source)) throw new Error("MEMORY_SOURCE_INVALID");
  const cwd = options.cwd ?? process.cwd();
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("MEMORY_TIME_INVALID");
  const limit = options.limit ?? 16;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new Error("MEMORY_LIMIT_INVALID");
  const maxCandidates = options.maxCandidates ?? 10_000;
  if (!Number.isSafeInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > 10_000) throw new Error("MEMORY_BUDGET_INVALID");
  const taskIntent = options.taskIntent ?? createUnknownIntent(query);
  const privacyContext = privacyContextForOptions(options, { includeSecret: false, includeRaw: options.includeRaw ?? false, command: "context" });
  const snapshot = await readContextMemoryRecords(cwd, options.source ?? "auto", privacyContext.projectId);
  if (snapshot.records.length > maxCandidates) throw new Error("MEMORY_READ_BUDGET_EXCEEDED");
  const records = snapshot.records.filter(record => (!options.scope || record.scope === options.scope) && (!options.kind || record.kind === options.kind));
  const metadata = records.map(record => {
    const entry = toMemoryMetadata(record, now);
    // SQLite has explicit lifecycle/approval state. A generated tag such as
    // "review" must not reclassify an approved active record as pending.
    if (snapshot.source === "sqlite") entry.status = record.expiresAt && Date.parse(record.expiresAt) <= now.getTime() ? "expired" : record.status ?? "active";
    return entry;
  });
  const observer = options.observer ?? { observerRole: privacyContext.role, sinkRole: privacyContext.role, effectiveContextRole: privacyContext.role, projectId: privacyContext.projectId, modelTarget: privacyContext.role === "external_model" ? "external_model" : "local", userId: "local", agentId: "context" };
  const gate = hardGateMemoryMetadata({ metadata, observer, privacyContext, now });
  gate.allowed = gate.allowed.map(entry => ({
    ...entry,
    projectId: redactText(entry.projectId),
    supersededBy: entry.supersededBy ? redactText(entry.supersededBy) : undefined
  }));
  const byId = new Map(records.map(record => [record.id, record]));
  const decisionIds = new Map(gate.policyDecisions.map(decision => [decision.memoryId, decision.id]));
  const policySafeCandidates: PolicySafeMemoryResult[] = [];
  const ranked: MemorySearchResult[] = [];
  let filteredOut = gate.blocked.length;
  for (const entry of gate.allowed) {
    const record = byId.get(entry.id)!;
    const sanitized = await sanitizeMemoryForContext(record, privacyContext, taskIntent, { cwd, readOnly: true });
    if (!sanitized.record || sanitized.mode === "excluded") { filteredOut += 1; continue; }
    const safeRecord = redactContextRecord(sanitized.record);
    policySafeCandidates.push({ metadata: entry, mode: sanitized.mode, policyDecisionId: decisionIds.get(entry.id)!, scoreInputs: createPolicySafeScoreInputs(entry, safeRecord, sanitized.mode), score: 0, why: [sanitized.reason], ...(sanitized.mode === "raw" ? { safeContent: safeRecord.content } : { safeSummary: safeRecord.content }) });
    const score = scoreMemoryForRetrieval(safeRecord, { query, taskIntent, now });
    if (score.filteredOutReason || score.score < (options.includeLowScore ? 1 : CONTEXT_MEMORY_SCORE_THRESHOLD) || score.activation < (options.includeLowScore ? 0.2 : DEFAULT_CONTEXT_ACTIVATION_THRESHOLD)) { filteredOut += 1; continue; }
    ranked.push({ record: safeRecord, ...score, mode: sanitized.mode, promptPolicy: safeRecord.promptPolicy, why: [...score.why, sanitized.reason] });
  }
  ranked.sort((left, right) => right.score - left.score || (right.activation ?? 0) - (left.activation ?? 0) || right.record.importance - left.record.importance || left.record.id.localeCompare(right.record.id));
  return { source: snapshot.source, completeness: "complete", revision: snapshot.revision, results: ranked.slice(0, limit), filteredOut, policySafeCandidates, gate };
}

function redactContextRecord(record: MemoryRecord): MemoryRecord {
  // Whitelist fields: JSON compatibility records may contain arbitrary extra
  // properties that have never passed a prompt policy or redaction gate.
  return {
    id: record.id, scope: record.scope, kind: record.kind,
    title: redactText(record.title), content: redactText(record.content),
    projectId: redactText(record.projectId), sourceRefs: record.sourceRefs.map(redactText), tags: record.tags.map(redactText),
    importance: record.importance, confidence: record.confidence, sensitivity: record.sensitivity, promptPolicy: record.promptPolicy,
    createdAt: record.createdAt, updatedAt: record.updatedAt, expiresAt: record.expiresAt, version: record.version,
    status: record.status, memoryStrength: record.memoryStrength, baseActivation: record.baseActivation,
    retrievalCount: record.retrievalCount, lastRetrievedAt: record.lastRetrievedAt, lastReinforcedAt: record.lastReinforcedAt,
    decayRate: record.decayRate, stability: record.stability, priorityScore: record.priorityScore,
    privacySafeSummary: record.privacySafeSummary ? redactText(record.privacySafeSummary) : undefined,
    contextCues: record.contextCues?.map(redactText), negativeCues: record.negativeCues?.map(redactText), supersededBy: record.supersededBy ? redactText(record.supersededBy) : undefined,
    associations: record.associations?.map(association => ({ reason: redactText(association.reason), targetMemoryId: redactText(association.targetMemoryId), weight: association.weight, createdAt: association.createdAt }))
  };
}

async function readContextMemoryRecords(cwd: string, source: "auto" | "sqlite" | "legacy_json", projectId: string): Promise<{ records: MemoryRecord[]; source: ContextMemorySelection["source"]; revision: string }> {
  if (source !== "legacy_json") {
    const sqlite = await readProjectMemoryRecords(cwd, projectId);
    if (sqlite) return { ...sqlite, records: validateContextRecords(sqlite.records), source: "sqlite" };
    if (source === "sqlite") throw new Error("MEMORY_SOURCE_UNAVAILABLE");
  }
  const records: MemoryRecord[] = [];
  const digest = createHash("sha256");
  let bytes = 0, present = false;
  for (const name of [SHORT_TERM_MEMORY_FILE, LONG_TERM_MEMORY_FILE, LESSONS_MEMORY_FILE]) {
    const file = await checkedMemoryFile(cwd, name, MAX_CONTEXT_MEMORY_BYTES);
    digest.update(name).update("\0");
    if (!file) { digest.update("missing\0"); continue; }
    present = true;
    const content = await readBoundedMemoryText(file, MAX_CONTEXT_MEMORY_BYTES - bytes);
    bytes += Buffer.byteLength(content);
    if (bytes > MAX_CONTEXT_MEMORY_BYTES) throw new Error("MEMORY_READ_BUDGET_EXCEEDED");
    let parsed: unknown;
    try { parsed = JSON.parse(content); } catch { throw new Error("MEMORY_SOURCE_INVALID"); }
    if (!Array.isArray(parsed)) throw new Error("MEMORY_SOURCE_INVALID");
    records.push(...validateContextRecords(parsed));
    requireCompleteMemoryScan(records);
    digest.update(content).update("\0");
  }
  return { records: validateContextRecords(records), source: present ? "legacy_json" : "none", revision: digest.digest("hex") };
}

function validateContextRecords(values: unknown[]): MemoryRecord[] {
  requireCompleteMemoryScan(values);
  const ids = new Set<string>();
  return values.map(value => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("MEMORY_SOURCE_INVALID");
    const record = value as MemoryRecord;
    if (typeof record.id !== "string" || !/^[a-zA-Z0-9._:-]{1,160}$/.test(record.id) || ids.has(record.id) || typeof record.title !== "string" || typeof record.content !== "string" || !["public", "internal", "confidential", "secret"].includes(record.sensitivity)
      || (record.promptPolicy !== undefined && !["allow_raw", "summarize_only", "do_not_prompt"].includes(record.promptPolicy))
      || (record.status !== undefined && !["active", "weak", "archived", "superseded"].includes(record.status))
      || !Array.isArray(record.tags) || record.tags.some(tag => typeof tag !== "string") || !Array.isArray(record.sourceRefs) || record.sourceRefs.some(ref => typeof ref !== "string")
      || !Number.isFinite(record.importance) || record.importance < 0 || record.importance > 1 || !Number.isFinite(Date.parse(record.createdAt)) || !Number.isFinite(Date.parse(record.updatedAt)) || (record.expiresAt !== undefined && !Number.isFinite(Date.parse(record.expiresAt)))) throw new Error("MEMORY_SOURCE_INVALID");
    if (typeof record.projectId !== "string" || !record.projectId || !["short_term", "long_term"].includes(record.scope)
      || [record.lastRetrievedAt, record.lastReinforcedAt, record.nextReviewAt].some(value => value !== undefined && (typeof value !== "string" || !Number.isFinite(Date.parse(value))))
      || [record.memoryStrength, record.baseActivation, record.retrievalCount, record.decayRate, record.stability, record.priorityScore, record.version, record.reviewIntervalDays, record.easinessFactor, record.reviewCount].some(value => value !== undefined && (typeof value !== "number" || !Number.isFinite(value)))
      || [record.contextCues, record.negativeCues].some(value => value !== undefined && (!Array.isArray(value) || value.some(item => typeof item !== "string")))
      || (record.privacySafeSummary !== undefined && typeof record.privacySafeSummary !== "string")
      || (record.supersededBy !== undefined && typeof record.supersededBy !== "string")
      || (record.associations !== undefined && (!Array.isArray(record.associations) || record.associations.some(item => !item || typeof item.reason !== "string" || typeof item.targetMemoryId !== "string" || !Number.isFinite(item.weight) || !Number.isFinite(Date.parse(item.createdAt)))))) throw new Error("MEMORY_SOURCE_INVALID");
    ids.add(record.id);
    return normalizeStoredMemory(record);
  });
}

export function createDefaultLmtiConfig(): LmtiConfig {
  return {
    version: "0.1.0",
    kernel: "atlas",
    projectName: "",
    privacy: {
      defaultRole: "developer",
      allowSecretExport: false,
      allowExternalModelRawMemory: false
    },
    codex: {
      attached: true,
      agentsFile: "AGENTS.md"
    },
    legacyDetected: false
  };
}

function createPlaceholderAmf(cwd: string): AmfDocument {
  const root = path.resolve(cwd);
  const projectName = path.basename(root);
  return createEmptyAmf({
    name: projectName,
    root: normalizePath(root),
    compiledAt: "",
    atlasVersion: "0.0.0",
    amfVersion: AMF_VERSION,
    compiler: {
      name: "LMTI init placeholder",
      version: "0.1.0"
    },
    sourceBoundary: {
      root: normalizePath(root),
      ignoredDirectories: [],
      ignoredFiles: [],
      maxFileBytes: 0
    },
    checksum: "uncompiled"
  });
}

export async function initAtlasStorage(cwd = process.cwd()): Promise<InitResult> {
  const atlasDir = path.resolve(cwd, ATLAS_DIR);
  const memoryDir = path.join(atlasDir, MEMORY_DIR);
  const experimentsDir = path.join(atlasDir, EXPERIMENTS_DIR);
  const eventsDir = path.join(atlasDir, EVENTS_DIR);
  await ensureMemoryDirectory(cwd, ".lmti/cache");
  await ensureMemoryDirectory(cwd, ".lmti/logs");
  await ensureMemoryDirectory(cwd, ".lmti/memory");
  await ensureMemoryDirectory(cwd, ".lmti/experiments");
  await ensureMemoryDirectory(cwd, ".lmti/events");

  const indexPath = path.join(atlasDir, INDEX_FILE);
  const amfPath = path.join(atlasDir, AMF_FILE);
  const configPath = path.join(atlasDir, CONFIG_FILE);
  await ensureFile(cwd, configPath, JSON.stringify(createDefaultLmtiConfig(), null, 2));
  await ensureFile(cwd, amfPath, JSON.stringify(createPlaceholderAmf(cwd), null, 2));
  await ensureJsonArray(cwd, path.join(memoryDir, SHORT_TERM_MEMORY_FILE));
  await ensureJsonArray(cwd, path.join(memoryDir, LONG_TERM_MEMORY_FILE));
  await ensureJsonArray(cwd, path.join(memoryDir, LESSONS_MEMORY_FILE));
  await ensureFile(cwd, path.join(memoryDir, MEMORY_EVENTS_FILE), "");
  await ensureFile(cwd, path.join(eventsDir, TASK_EVENTS_FILE), "");

  await ensureFile(cwd, indexPath, JSON.stringify({
    version: "0.1.0", projectName: "", amfPath, compiledAt: "",
    files: 0, modules: 0, dependencies: 0, risks: 0
  }, null, 2));

  return { atlasDir, amfPath, indexPath, configPath, memoryDir, experimentsDir, eventsDir };
}

export async function writeAmfDocument(amf: AmfDocument, cwd = process.cwd()): Promise<InitResult> {
  const storage = await initAtlasStorage(cwd);
  await writeOwnedFile(cwd, storage.amfPath, JSON.stringify(amf, null, 2));

  const index: AtlasIndex = {
    version: amf.project.amfVersion,
    projectName: amf.project.name,
    amfPath: storage.amfPath,
    compiledAt: amf.project.compiledAt,
    files: amf.files.length,
    modules: amf.modules.length,
    dependencies: amf.dependencies.length,
    risks: amf.risks.length
  };

  await writeOwnedFile(cwd, storage.indexPath, JSON.stringify(index, null, 2));
  await appendEvent(cwd, {
    event: "compile",
    projectName: amf.project.name,
    compiledAt: amf.project.compiledAt,
    files: amf.files.length,
    modules: amf.modules.length,
    risks: amf.risks.length
  });

  return storage;
}

export async function readAmfDocument(amfPath?: string, cwd = process.cwd()): Promise<AmfDocument> {
  const resolved = amfPath ? path.resolve(cwd, amfPath) : path.resolve(cwd, ATLAS_DIR, AMF_FILE);
  const content = await fs.readFile(resolved, "utf8");
  return JSON.parse(content) as AmfDocument;
}

export async function appendEvent(cwd: string, event: Record<string, unknown>): Promise<void> {
  const atlasDir = path.resolve(cwd, ATLAS_DIR);
  await ensureMemoryDirectory(cwd, ".lmti/logs");
  const line = JSON.stringify({ ...event, recordedAt: new Date().toISOString() });
  await writeOwnedFile(cwd, path.join(atlasDir, "logs", "events.log"), `${line}\n`, "append");
}

export async function createMemory(record: NewMemoryRecord, options: MemoryRuntimeOptions = {}): Promise<MemoryRecord> {
  const cwd = options.cwd ?? process.cwd();
  await initAtlasStorage(cwd);
  await decayMemory(options);

  const now = (options.now ?? new Date()).toISOString();
  const encoded = encodeMemory(
    {
      kind: record.kind,
      title: record.title,
      content: record.content,
      tags: record.tags,
      sourceRefs: record.sourceRefs,
      importance: record.importance,
      confidence: record.confidence,
      sensitivity: record.sensitivity,
      promptPolicy: record.promptPolicy
    },
    {
      taskIntent: record.inferredIntent,
      taskDoneLesson: record.kind === "lesson"
    }
  );
  const memory: MemoryRecord = {
    id: record.id ?? randomUUID(),
    scope: record.scope,
    kind: record.kind,
    title: encoded.title,
    content: encoded.content,
    projectId: record.projectId.trim(),
    sourceRefs: record.sourceRefs ?? [],
    tags: Array.from(new Set([...(record.tags ?? []), ...encoded.tags])),
    importance: clampImportance(record.importance),
    confidence: record.confidence,
    sensitivity: encoded.sensitivity,
    promptPolicy: normalizePromptPolicy(record.promptPolicy ?? encoded.promptPolicy, encoded.sensitivity),
    createdAt: record.createdAt ?? now,
    updatedAt: record.updatedAt ?? now,
    expiresAt:
      record.scope === "short_term"
        ? record.expiresAt ?? new Date((options.now ?? new Date()).getTime() + (options.shortTermTtlMs ?? DEFAULT_SHORT_TERM_TTL_MS)).toISOString()
        : record.expiresAt,
    memoryStrength: record.memoryStrength ?? encoded.memoryStrength,
    baseActivation: record.baseActivation ?? encoded.baseActivation,
    retrievalCount: record.retrievalCount ?? 0,
    lastRetrievedAt: record.lastRetrievedAt,
    lastReinforcedAt: record.lastReinforcedAt,
    decayRate: record.decayRate ?? encoded.decayRate,
    stability: record.stability ?? encoded.stability,
    priorityScore: record.priorityScore ?? encoded.priorityScore,
    emotionalWeight: record.emotionalWeight,
    contextCues: record.contextCues ?? encoded.contextCues,
    associations: record.associations ?? [],
    supersededBy: record.supersededBy,
    status: record.status ?? "active",
    nextReviewAt: record.nextReviewAt ?? new Date((options.now ?? new Date()).getTime() + Math.max(1, Math.ceil(encoded.memoryStrength / 6)) * 86_400_000).toISOString(),
    reviewIntervalDays: record.reviewIntervalDays ?? Math.max(1, Math.ceil(encoded.memoryStrength / 6)),
    easinessFactor: record.easinessFactor ?? 2.3,
    reviewCount: record.reviewCount ?? 0,
    negativeCues: record.negativeCues ?? [],
    inferredIntent: record.inferredIntent ?? encoded.inferredIntent,
    privacySafeSummary: record.privacySafeSummary ?? encoded.privacySafeSummary,
    version: record.version ?? 1
  };

  validateMemory(memory);
  if (memory.scope === "long_term") {
    await markSupersededMemory(memory, cwd);
  }
  const records = memory.kind === "lesson" ? await readLessonMemory(cwd) : await readMemoryScope(memory.scope, cwd);
  records.push(memory);
  if (memory.kind === "lesson") {
    await writeLessonMemory(records, cwd);
  } else {
    await writeMemoryScope(memory.scope, records, cwd);
  }
  await appendMemoryEvent(cwd, { event: "memory.create", id: memory.id, scope: memory.scope, kind: memory.kind });
  return memory;
}

export async function listMemory(scope?: MemoryScope, options: MemoryRuntimeOptions = {}): Promise<MemoryRecord[]> {
  const cwd = options.cwd ?? process.cwd();
  await initAtlasStorage(cwd);
  await decayMemory(options);
  const records = scope ? (scope === "long_term" ? [...(await readMemoryScope(scope, cwd)), ...(await readLessonMemory(cwd))] : await readMemoryScope(scope, cwd)) : await readAllMemory(cwd);
  const visible = await applyPrivacy(records, options);
  return visible.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function getMemory(id: string, options: MemoryRuntimeOptions = {}): Promise<MemoryRecord | undefined> {
  const records = await readAllMemory(options.cwd ?? process.cwd());
  return records.find((record) => record.id === id);
}

export async function updateMemory(id: string, patch: MemoryPatch, options: MemoryRuntimeOptions = {}): Promise<MemoryRecord> {
  const cwd = options.cwd ?? process.cwd();
  await initAtlasStorage(cwd);
  await decayMemory(options);

  const all = await readAllMemory(cwd);
  const existing = all.find((record) => record.id === id);
  if (!existing) {
    throw new Error(`Memory not found: ${id}`);
  }

  const updated: MemoryRecord = {
    ...existing,
    ...patch,
    id: existing.id,
    title: patch.title?.trim() ?? existing.title,
    content: patch.content?.trim() ?? existing.content,
    projectId: patch.projectId?.trim() ?? existing.projectId,
    importance: patch.importance === undefined ? existing.importance : clampImportance(patch.importance),
    updatedAt: (options.now ?? new Date()).toISOString(),
    version: existing.version + 1
  };

  validateMemory(updated);
  const without = all.filter((record) => record.id !== id);
  await writeAllMemory([...without, updated], cwd);
  await appendMemoryEvent(cwd, { event: "memory.update", id: updated.id, scope: updated.scope, kind: updated.kind });
  return updated;
}

export async function deleteMemory(id: string, options: MemoryRuntimeOptions = {}): Promise<boolean> {
  const cwd = options.cwd ?? process.cwd();
  await initAtlasStorage(cwd);
  const all = await readAllMemory(cwd);
  const next = all.filter((record) => record.id !== id);
  if (next.length === all.length) {
    return false;
  }
  await writeAllMemory(next, cwd);
  await appendMemoryEvent(cwd, { event: "memory.delete", id });
  return true;
}

export async function searchMemory(
  query: string,
  options: MemorySearchOptions & MemoryRuntimeOptions = {}
): Promise<MemorySearchResult[]> {
  const cwd = options.cwd ?? process.cwd();
  await initAtlasStorage(cwd);
  if (!options.includeExpired) {
    await decayMemory(options);
  }

  const keywords = tokenize(query);
  const records = options.scope ? await readMemoryScope(options.scope, cwd) : await readAllMemory(cwd);
  const scored = records
    .filter((record) => options.includeExpired || !isExpired(record, options.now ?? new Date()))
    .filter((record) => !options.kind || record.kind === options.kind)
    .map((record) => ({
      record,
      score: scoreMemory(record, keywords)
    }))
    .filter((result) => result.score > 0)
    .sort((left, right) => right.score - left.score || right.record.importance - left.record.importance);

  const privacyContext = privacyContextForOptions(options, {
    includeSecret: options.includeSecret ?? options.privacyContext?.includeSecret ?? false,
    command: options.privacyContext?.command ?? "memory search"
  });
  const visible: MemorySearchResult[] = [];
  for (const result of scored) {
    const sanitized = await applyPrivacyToRecord(result.record, { ...options, privacyContext });
    if (sanitized) {
      visible.push({ ...result, record: sanitized });
    }
    if (visible.length >= (options.limit ?? 20)) {
      break;
    }
  }
  return visible;
}

export async function retrieveMemoryMetadata(options: RetrieveMemoryMetadataOptions = {}): Promise<MemoryMetadata[]> {
  const cwd = options.cwd ?? process.cwd();
  await initAtlasStorage(cwd);
  await decayMemory(options);
  const records = options.scope
    ? options.scope === "long_term"
      ? [...(await readMemoryScope(options.scope, cwd)), ...(await readLessonMemory(cwd))]
      : await readMemoryScope(options.scope, cwd)
    : await readAllMemory(cwd);

  return records.filter((record) => !options.kind || record.kind === options.kind).map((record) => toMemoryMetadata(record, options.now ?? new Date()));
}

export async function fetchAllowedMemoryContent(options: FetchAllowedMemoryContentOptions): Promise<PolicySafeMemoryResult[]> {
  const cwd = options.cwd ?? process.cwd();
  await initAtlasStorage(cwd);
  const records = await readAllMemory(cwd);
  const byId = new Map(records.map((record) => [record.id, record]));
  const decisionByMemoryId = new Map((options.policyDecisions ?? []).map((decision) => [decision.memoryId, decision.id]));
  const results: PolicySafeMemoryResult[] = [];

  for (const metadata of options.metadata) {
    const record = byId.get(metadata.id);
    if (!record) {
      continue;
    }

    const sanitized = await sanitizeMemoryForContext(record, options.privacyContext, options.taskIntent, {
      cwd,
      score: 0,
      why: ["passed metadata hard gate"]
    });
    if (!sanitized.record || sanitized.mode === "excluded") {
      continue;
    }

    const safeResult: PolicySafeMemoryResult = {
      metadata,
      mode: sanitized.mode,
      policyDecisionId: decisionByMemoryId.get(metadata.id) ?? `missing-policy-decision:${metadata.id}`,
      scoreInputs: createPolicySafeScoreInputs(metadata, sanitized.record, sanitized.mode),
      score: 0,
      why: [sanitized.reason]
    };

    if (sanitized.mode === "raw") {
      safeResult.safeContent = sanitized.record.content;
    } else if (sanitized.mode === "summary") {
      safeResult.safeSummary = sanitized.record.content;
    } else {
      safeResult.safeSummary = `${metadata.sensitivity} memory metadata only; raw content withheld.`;
    }

    results.push(safeResult);
    if (results.length >= (options.limit ?? 16)) {
      break;
    }
  }

  return results;
}

export async function searchMemoryForContext(
  query: string,
  options: MemorySearchOptions & MemoryRuntimeOptions & { taskIntent?: InferredIntent } = {}
): Promise<ContextMemorySearchResult> {
  const cwd = options.cwd ?? process.cwd();
  await initAtlasStorage(cwd);
  if (!options.includeExpired) {
    await decayMemory(options);
  }

  const taskIntent = options.taskIntent ?? createUnknownIntent(query);
  const privacyContext = privacyContextForOptions(options, {
    includeSecret: options.includeSecret ?? false,
    includeRaw: options.includeRaw ?? false,
    command: options.privacyContext?.command ?? "context"
  });
  const records = options.scope ? (options.scope === "long_term" ? [...(await readMemoryScope(options.scope, cwd)), ...(await readLessonMemory(cwd))] : await readMemoryScope(options.scope, cwd)) : await readAllMemory(cwd);
  const scored = records
    .filter((record) => options.includeExpired || !isExpired(record, options.now ?? new Date()))
    .filter((record) => !options.kind || record.kind === options.kind)
    .map((record) => ({
      record,
      ...scoreMemoryForRetrieval(record, {
        query,
        taskIntent,
        now: options.now ?? new Date()
      })
    }))
    .sort((left, right) => right.score - left.score || right.activation - left.activation || right.record.importance - left.record.importance);

  const results: MemorySearchResult[] = [];
  let filteredOut = 0;
  const minScore = options.includeLowScore ? 1 : CONTEXT_MEMORY_SCORE_THRESHOLD;
  const minActivation = options.includeLowScore ? 0.2 : DEFAULT_CONTEXT_ACTIVATION_THRESHOLD;

  for (const candidate of scored) {
    if (candidate.filteredOutReason || candidate.score < minScore || candidate.activation < minActivation) {
      filteredOut += 1;
      continue;
    }

    const sanitized = await sanitizeMemoryForContext(candidate.record, privacyContext, taskIntent, {
      cwd,
      includeSecretMeta: Boolean(options.includeSecretMeta),
      score: candidate.score,
      why: candidate.why
    });
    if (!sanitized.record || sanitized.mode === "excluded") {
      filteredOut += 1;
      continue;
    }

    results.push({
      record: sanitized.record,
      score: candidate.score,
      mode: sanitized.mode,
      promptPolicy: sanitized.record.promptPolicy,
      why: [...candidate.why, sanitized.reason],
      intentMatch: candidate.intentScore,
      keywordMatch: candidate.lexicalScore,
      lexicalScore: candidate.lexicalScore,
      activation: candidate.activation,
      baseActivation: candidate.baseActivation,
      associationScore: candidate.associationScore,
      priorityScore: candidate.priorityScore,
      contextCueMatch: candidate.contextCueMatch,
      negativeKeywordPenalty: candidate.negativeKeywordPenalty,
      privacyPenalty: candidate.privacyPenalty
    });

    if (results.length >= (options.limit ?? 16)) {
      break;
    }
  }

  if (results.length > 0) {
    await reinforceRetrievedMemories(
      results.map((result) => result.record.id),
      {
        cwd,
        now: options.now ?? new Date(),
        reason: `co-retrieved for ${taskIntent.primaryIntent} context`
      }
    );
  }

  return { results, filteredOut };
}

export async function sanitizeMemoryForContext(
  memory: MemoryRecord,
  privacyContext: PrivacyContext,
  taskIntent: InferredIntent,
  options: { cwd?: string; includeSecretMeta?: boolean; score?: number; why?: string[]; readOnly?: boolean } = {}
): Promise<MemorySanitizationResult> {
  const promptPolicy = normalizePromptPolicy(memory.promptPolicy, memory.sensitivity);
  const normalized = normalizeStoredMemory({ ...memory, promptPolicy });
  const cwd = options.cwd ?? process.cwd();

  const audit = async (mode: MemoryContextMode, reason: string) => {
    if (!options.readOnly) await appendContextPrivacyAudit(cwd, normalized, privacyContext, mode, reason, taskIntent, options.score);
  };

  if (promptPolicy === "do_not_prompt") {
    await audit("excluded", "do_not_prompt memory filtered from context");
    return { mode: "excluded", reason: "do_not_prompt memory filtered from context" };
  }

  if (normalized.sensitivity === "secret") {
    if (privacyContext.role === "owner" && options.includeSecretMeta) {
      const safeSummary = "secret memory metadata only; raw content withheld.";
      await audit("metadata_only", "secret memory exposed as metadata only");
      return {
        mode: "metadata_only",
        reason: "secret memory metadata only for owner",
        record: {
          ...normalized,
          content: "",
          privacySafeSummary: safeSummary,
          promptPolicy
        }
      };
    }
    await audit("excluded", "secret memory filtered from normal context");
    return { mode: "excluded", reason: "secret memory filtered from normal context" };
  }

  if (normalized.sensitivity === "confidential") {
    const safeSummary = createSafeSummary(normalized);
    await audit("summary", "confidential memory summarized; raw blocked");
    return {
      mode: "summary",
      reason: "confidential memory summarized; raw blocked",
      record: {
        ...normalized,
        content: safeSummary,
        privacySafeSummary: safeSummary,
        promptPolicy
      }
    };
  }

  if (normalized.sensitivity === "internal") {
    if (privacyContext.role === "owner" && privacyContext.includeRaw) {
      await audit("raw", "owner requested raw internal memory");
      return {
        mode: "raw",
        reason: "owner requested raw internal memory",
        record: {
          ...normalized,
          content: redactText(normalized.content),
          promptPolicy
        }
      };
    }
    const safeSummary = createTaskRelevantSummary(normalized, taskIntent);
    return {
      mode: "summary",
      reason: "internal memory summarized by default",
      record: {
        ...normalized,
        content: safeSummary,
        privacySafeSummary: safeSummary,
        promptPolicy: "summarize_only"
      }
    };
  }

  if (promptPolicy === "summarize_only") {
    const safeSummary = createTaskRelevantSummary(normalized, taskIntent);
    return {
      mode: "summary",
      reason: "public memory requested summarize_only",
      record: {
        ...normalized,
        content: safeSummary,
        privacySafeSummary: safeSummary,
        promptPolicy
      }
    };
  }

  return {
    mode: "raw",
    reason: "public allow_raw memory included",
    record: {
      ...normalized,
      content: redactText(normalized.content),
      promptPolicy
    }
  };
}

export async function promoteMemory(id: string, options: MemoryRuntimeOptions = {}): Promise<MemoryRecord> {
  const existing = await getMemory(id, options);
  if (!existing) {
    throw new Error(`Memory not found: ${id}`);
  }
  if (existing.scope === "long_term") {
    return existing;
  }
  return updateMemory(
    id,
    {
      scope: "long_term",
      expiresAt: undefined
    },
    options
  );
}

export async function recordTaskDone(input: TaskDoneInput, options: MemoryRuntimeOptions = {}): Promise<TaskDoneResult> {
  const cwd = options.cwd ?? process.cwd();
  await initAtlasStorage(cwd);
  const tags = Array.from(new Set([...(input.tags ?? []), ...intentTags(input.taskIntent)]));
  const projectId = input.projectId?.trim() || "default";
  let lessonMemory: MemoryRecord | undefined;

  if (input.lesson?.trim()) {
    lessonMemory = await createMemory(
      {
        scope: "long_term",
        kind: "lesson",
        title: input.title.trim(),
        content: input.lesson.trim(),
        projectId,
        sourceRefs: [],
        tags,
        importance: 0.8,
        confidence: "medium",
        sensitivity: input.sensitivity ?? "internal",
        promptPolicy: input.promptPolicy ?? "summarize_only"
      },
      options
    );
  }

  const event: TaskDoneEvent = {
    title: input.title.trim(),
    summary: input.summary.trim(),
    lessonMemoryId: lessonMemory?.id,
    tags,
    projectId,
    inferredIntent: input.taskIntent,
    recordedAt: (options.now ?? new Date()).toISOString()
  };
  await appendTaskEvent(cwd, event);

  return {
    event,
    lessonMemory,
    suggestion: lessonMemory ? undefined : createRememberSuggestion(input.title, input.summary, tags)
  };
}

export async function consolidateMemory(options: MemoryRuntimeOptions = {}): Promise<MemoryConsolidationResult> {
  const cwd = options.cwd ?? process.cwd();
  await initAtlasStorage(cwd);
  await decayMemory(options);
  const now = options.now ?? new Date();
  const shortTerm = await readMemoryScope("short_term", cwd);
  const longTerm = [...(await readMemoryScope("long_term", cwd)), ...(await readLessonMemory(cwd))];
  const result: MemoryConsolidationResult = { created: [], reinforced: [], skipped: [] };
  const consolidatedSourceIds = new Set<string>();

  for (const source of shortTerm) {
    const encoded = encodeMemory(
      {
        kind: source.kind === "task" ? "lesson" : source.kind,
        title: source.title,
        content: source.privacySafeSummary ?? source.content,
        tags: source.tags,
        sourceRefs: source.sourceRefs,
        importance: source.importance,
        confidence: source.confidence,
        sensitivity: source.sensitivity,
        promptPolicy: source.promptPolicy
      },
      {
        taskIntent: source.inferredIntent,
        taskDoneLesson: source.kind === "task"
      }
    );
    const candidate = createConsolidationCandidate(source, encoded);
    if (!candidate.shouldConsolidate) {
      result.skipped.push({ id: source.id, title: redactText(source.title), reason: candidate.reason });
      continue;
    }

    const existing = findSimilarLongTermMemory(encoded, longTerm);
    if (existing) {
      const reinforced = await reinforceMemory(existing.id, { ...options, now, success: true, intensity: 1.4 });
      result.reinforced.push({ id: reinforced.memory.id, title: redactText(reinforced.memory.title), sourceId: source.id });
      consolidatedSourceIds.add(source.id);
      continue;
    }

    const created = await createMemory(
      {
        scope: "long_term",
        kind: source.kind === "task" ? "lesson" : source.kind,
        title: encoded.title,
        content: encoded.privacySafeSummary,
        projectId: source.projectId,
        sourceRefs: Array.from(new Set([...source.sourceRefs, source.id])),
        tags: encoded.tags,
        importance: Math.max(source.importance, encoded.priorityScore),
        confidence: source.confidence,
        sensitivity: encoded.sensitivity === "secret" ? "confidential" : encoded.sensitivity,
        promptPolicy: encoded.sensitivity === "secret" ? "summarize_only" : encoded.promptPolicy,
        memoryStrength: encoded.memoryStrength,
        baseActivation: encoded.baseActivation,
        decayRate: encoded.decayRate,
        stability: encoded.stability,
        priorityScore: encoded.priorityScore,
        contextCues: encoded.contextCues,
        inferredIntent: encoded.inferredIntent,
        privacySafeSummary: encoded.privacySafeSummary
      },
      { ...options, now }
    );
    result.created.push({ id: created.id, title: redactText(created.title), sourceId: source.id });
    consolidatedSourceIds.add(source.id);
  }

  if (consolidatedSourceIds.size > 0) {
    await writeMemoryScope(
      "short_term",
      shortTerm.filter((record) => !consolidatedSourceIds.has(record.id)),
      cwd
    );
    await appendMemoryEvent(cwd, {
      event: "memory.consolidate",
      created: result.created.length,
      reinforced: result.reinforced.length,
      skipped: result.skipped.length
    });
  }

  return result;
}

export async function reinforceMemory(
  id: string,
  options: MemoryRuntimeOptions & { success: boolean; intensity?: number } = { success: true }
): Promise<MemoryReinforcementResult> {
  const cwd = options.cwd ?? process.cwd();
  await initAtlasStorage(cwd);
  const all = await readAllMemory(cwd);
  const existing = all.find((record) => record.id === id);
  if (!existing) {
    throw new Error(`Memory not found: ${id}`);
  }
  const memory = reinforceMemoryRecord(existing, {
    success: options.success,
    now: options.now,
    intensity: options.intensity
  });
  const next = all.map((record) => (record.id === id ? memory : record));
  await writeAllMemory(next, cwd);
  await appendMemoryEvent(cwd, { event: "memory.reinforce", id, success: options.success });
  return { memory, success: options.success };
}

export async function getMemoryAssociations(id: string, options: MemoryRuntimeOptions = {}): Promise<ReturnType<typeof summarizeAssociations>> {
  const memory = await getMemory(id, options);
  if (!memory) {
    throw new Error(`Memory not found: ${id}`);
  }
  return summarizeAssociations(memory).map((association) => ({
    ...association,
    reason: redactText(association.reason)
  }));
}

export async function reviewMemory(options: MemoryRuntimeOptions = {}): Promise<MemoryReviewReport> {
  const cwd = options.cwd ?? process.cwd();
  await initAtlasStorage(cwd);
  await decayMemory(options);
  const report = reviewMemoryRecords(await readAllMemory(cwd), options.now ?? new Date());
  return {
    due: report.due.map((item) => ({ ...item, title: redactText(item.title) })),
    weak: report.weak.map((item) => ({ ...item, title: redactText(item.title) })),
    conflicts: report.conflicts.map((item) => ({ ...item, title: redactText(item.title) })),
    archiveCandidates: report.archiveCandidates.map((item) => ({ ...item, title: redactText(item.title) }))
  };
}

export async function explainMemory(
  query: string,
  options: MemorySearchOptions & MemoryRuntimeOptions & { taskIntent?: InferredIntent } = {}
): Promise<MemoryExplainResult> {
  const cwd = options.cwd ?? process.cwd();
  await initAtlasStorage(cwd);
  await decayMemory(options);
  const taskIntent = options.taskIntent ?? createUnknownIntent(query);
  const privacyContext = privacyContextForOptions(options, {
    includeSecret: options.includeSecret ?? false,
    includeRaw: options.includeRaw ?? false,
    command: options.privacyContext?.command ?? "memory explain"
  });
  const records = options.scope ? (options.scope === "long_term" ? [...(await readMemoryScope(options.scope, cwd)), ...(await readLessonMemory(cwd))] : await readMemoryScope(options.scope, cwd)) : await readAllMemory(cwd);
  const entries = records
    .filter((record) => !options.kind || record.kind === options.kind)
    .map((record) => {
      const score = scoreMemoryForRetrieval(record, { query, taskIntent, now: options.now ?? new Date() });
      const promptPolicy = normalizePromptPolicy(record.promptPolicy, record.sensitivity);
      const privacyDecision = explainPrivacyDecision({
        sensitivity: record.sensitivity,
        promptPolicy,
        role: privacyContext.role,
        includeRaw: privacyContext.includeRaw,
        includeSecret: privacyContext.includeSecret
      });
      const privacyBlocked = privacyDecision.startsWith("blocked");
      const activationBlocked = score.activation < (options.includeLowScore ? 0.2 : DEFAULT_CONTEXT_ACTIVATION_THRESHOLD);
      const scoreBlocked = score.score < (options.includeLowScore ? 1 : CONTEXT_MEMORY_SCORE_THRESHOLD);
      const filteredOutReason = score.filteredOutReason ?? (privacyBlocked ? privacyDecision : activationBlocked ? "activation below threshold" : scoreBlocked ? "score below threshold" : undefined);
      return {
        id: record.id,
        title: redactText(record.title),
        kind: record.kind,
        sensitivity: record.sensitivity,
        promptPolicy,
        status: record.status,
        score: score.score,
        activation: score.activation,
        lexicalScore: score.lexicalScore,
        intentScore: score.intentScore,
        contextCueMatch: score.contextCueMatch,
        associationScore: score.associationScore,
        priorityScore: score.priorityScore,
        negativeKeywordPenalty: score.negativeKeywordPenalty,
        privacyPenalty: score.privacyPenalty,
        privacyDecision,
        why: score.why,
        filteredOutReason
      };
    })
    .sort((left, right) => right.score - left.score || right.activation - left.activation);

  const selected = entries.filter((entry) => !entry.filteredOutReason).slice(0, options.limit ?? 16);
  const filteredOut = entries.filter((entry) => entry.filteredOutReason).slice(0, options.limit ?? 16);
  return { query, taskIntent, selected, filteredOut };
}

export async function decayMemoryLifecycle(options: MemoryRuntimeOptions = {}): Promise<MemoryDecayReport> {
  const cwd = options.cwd ?? process.cwd();
  await initMemoryFiles(cwd);
  const now = options.now ?? new Date();
  const shortTerm = await readMemoryScope("short_term", cwd);
  const active = shortTerm.filter((record) => !isExpired(record, now));
  const removed = shortTerm.length - active.length;
  if (removed > 0) {
    await writeMemoryScope("short_term", active, cwd);
  }

  const longTerm = [...(await readMemoryScope("long_term", cwd)), ...(await readLessonMemory(cwd))];
  const decayed = longTerm.map((record) => decayLongTermMemoryRecord(record, now));
  const updatedLongTerm = decayed.filter((result) => result.changed).map((result) => result.record);
  let weakenedLongTerm = 0;
  let archivedLongTerm = 0;

  if (updatedLongTerm.length > 0) {
    const byId = new Map(updatedLongTerm.map((record) => [record.id, record]));
    const next = longTerm.map((record) => byId.get(record.id) ?? record);
    weakenedLongTerm = updatedLongTerm.filter((record) => record.status === "weak").length;
    archivedLongTerm = updatedLongTerm.filter((record) => record.status === "archived").length;
    await writeAllMemory([...active, ...next], cwd);
  }

  if (removed > 0 || updatedLongTerm.length > 0) {
    await appendMemoryEvent(cwd, {
      event: "memory.decay",
      removedShortTerm: removed,
      updatedLongTerm: updatedLongTerm.length,
      weakenedLongTerm,
      archivedLongTerm
    });
  }

  return {
    removedShortTerm: removed,
    updatedLongTerm: updatedLongTerm.length,
    weakenedLongTerm,
    archivedLongTerm
  };
}

export async function decayMemory(options: MemoryRuntimeOptions = {}): Promise<number> {
  return (await decayMemoryLifecycle(options)).removedShortTerm;
}

export async function checkMemoryPrivacy(options: MemoryRuntimeOptions = {}): Promise<MemoryPrivacyFinding[]> {
  const cwd = options.cwd ?? process.cwd();
  await initAtlasStorage(cwd);
  const records = await readAllMemory(cwd);
  const findings: MemoryPrivacyFinding[] = [];

  for (const record of records) {
    if (!record.sensitivity) {
      findings.push({
        id: record.id,
        scope: record.scope,
        issue: "Memory is missing mandatory sensitivity.",
        recommendation: "Set sensitivity to public, internal, confidential or secret."
      });
    }

    const redacted = redactText(record.content);
    if (redacted !== record.content && record.sensitivity !== "secret") {
      findings.push({
        id: record.id,
        scope: record.scope,
        sensitivity: record.sensitivity,
        issue: "Memory content appears to contain unredacted sensitive material.",
        recommendation: "Mark as secret or rewrite content with secrets removed."
      });
    }
  }

  return findings;
}

export class InMemoryStore implements MemoryStore {
  private records = new Map<string, MemoryRecord>();

  async add(record: MemoryRecord): Promise<MemoryRecord> {
    const copy = { ...record, sourceRefs: [...record.sourceRefs], tags: [...record.tags] };
    this.records.set(copy.id, copy);
    return copy;
  }

  async get(id: string): Promise<MemoryRecord | undefined> {
    const record = this.records.get(id);
    return record ? { ...record, sourceRefs: [...record.sourceRefs], tags: [...record.tags] } : undefined;
  }

  async list(scope?: MemoryScope): Promise<MemoryRecord[]> {
    return Array.from(this.records.values())
      .filter((record) => !scope || record.scope === scope)
      .map((record) => ({ ...record, sourceRefs: [...record.sourceRefs], tags: [...record.tags] }))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async search(query: string, options: MemorySearchQuery = {}): Promise<MemorySearchResult[]> {
    const keywords = tokenize(query);
    const tagFilters = new Set(options.tags ?? []);
    const records = await this.list(options.scope);
    return records
      .filter((record) => tagFilters.size === 0 || record.tags.some((tag) => tagFilters.has(tag)))
      .map((record) => ({ record, score: scoreMemory(record, keywords) }))
      .filter((result) => result.score > 0)
      .sort((left, right) => right.score - left.score || right.record.importance - left.record.importance)
      .slice(0, options.limit ?? 20);
  }

  async clear(scope?: MemoryScope): Promise<void> {
    if (!scope) {
      this.records.clear();
      return;
    }

    for (const [id, record] of this.records.entries()) {
      if (record.scope === scope) {
        this.records.delete(id);
      }
    }
  }
}

export class ShortTermMemory {
  constructor(
    private readonly store: MemoryStore = new InMemoryStore(),
    private readonly options: { projectId?: string; ttlMs?: number } = {}
  ) {}

  async add(input: MemoryAddInput): Promise<MemoryRecord> {
    return this.store.add(createRuntimeMemoryRecord("short_term", input, this.options));
  }

  async search(query: string, options: Omit<MemorySearchQuery, "scope"> = {}): Promise<MemorySearchResult[]> {
    return this.store.search(query, { ...options, scope: "short_term" });
  }

  async list(): Promise<MemoryRecord[]> {
    return this.store.list("short_term");
  }

  async clear(): Promise<void> {
    await this.store.clear("short_term");
  }

  getStore(): MemoryStore {
    return this.store;
  }
}

export class LongTermMemory {
  constructor(
    private readonly store: MemoryStore = new InMemoryStore(),
    private readonly options: { projectId?: string } = {}
  ) {}

  async add(input: MemoryAddInput): Promise<MemoryRecord> {
    return this.store.add(createRuntimeMemoryRecord("long_term", input, this.options));
  }

  async search(query: string, options: Omit<MemorySearchQuery, "scope"> = {}): Promise<MemorySearchResult[]> {
    return this.store.search(query, { ...options, scope: "long_term" });
  }

  async list(): Promise<MemoryRecord[]> {
    return this.store.list("long_term");
  }

  async clear(): Promise<void> {
    await this.store.clear("long_term");
  }

  getStore(): MemoryStore {
    return this.store;
  }
}

function createRuntimeMemoryRecord(
  scope: MemoryScope,
  input: MemoryAddInput,
  options: { projectId?: string; ttlMs?: number }
): MemoryRecord {
  const now = new Date().toISOString();
  const sourceRefs = input.sourceRefs ?? (input.source ? [input.source] : []);
  const encoded = encodeMemory({
    kind: normalizeKind(input.kind),
    title: input.title,
    content: input.content,
    tags: input.tags,
    sourceRefs,
    importance: input.importance,
    confidence: input.confidence,
    sensitivity: input.sensitivity
  });
  const expiresAt =
    scope === "short_term"
      ? input.expiresAt ?? new Date(Date.now() + (options.ttlMs ?? DEFAULT_SHORT_TERM_TTL_MS)).toISOString()
      : undefined;

  return {
    id: input.id ?? randomUUID(),
    scope,
    kind: normalizeKind(input.kind),
    title: encoded.title,
    content: encoded.content,
    projectId: input.projectId ?? options.projectId ?? "runtime",
    sourceRefs,
    tags: Array.from(new Set([...(input.tags ?? []), ...encoded.tags])),
    importance: clampImportance(input.importance ?? 0.5),
    confidence: normalizeConfidence(input.confidence),
    sensitivity: encoded.sensitivity,
    promptPolicy: encoded.promptPolicy,
    createdAt: input.createdAt ?? now,
    updatedAt: now,
    expiresAt,
    memoryStrength: encoded.memoryStrength,
    baseActivation: encoded.baseActivation,
    retrievalCount: 0,
    decayRate: encoded.decayRate,
    stability: encoded.stability,
    priorityScore: encoded.priorityScore,
    contextCues: encoded.contextCues,
    associations: [],
    status: "active",
    reviewIntervalDays: Math.max(1, Math.ceil(encoded.memoryStrength / 6)),
    easinessFactor: 2.3,
    reviewCount: 0,
    negativeCues: [],
    inferredIntent: encoded.inferredIntent,
    privacySafeSummary: encoded.privacySafeSummary,
    version: 1
  };
}

function normalizeKind(kind?: MemoryKind): MemoryKind {
  return kind ?? "system_note";
}

function normalizeStoredMemory(record: MemoryRecord): MemoryRecord {
  const raw = record as Partial<MemoryRecord> & {
    type?: string;
    summary?: string;
    source?: string;
    project?: string;
    privacy?: string[];
  };
  const sensitivity = normalizeSensitivity(raw.sensitivity ?? sensitivityFromLegacyPrivacy(raw.privacy));
  const kind = normalizeMemoryKind(raw.kind ?? raw.type);
  const title = typeof raw.title === "string" && raw.title.trim() ? raw.title : "Untitled memory";
  const content = typeof raw.content === "string" ? raw.content : typeof raw.summary === "string" ? raw.summary : "";
  const sourceRefs = Array.isArray(raw.sourceRefs) ? raw.sourceRefs : typeof raw.source === "string" ? [raw.source] : [];
  const tags = Array.isArray(raw.tags) ? raw.tags : [];
  const createdAt = raw.createdAt ?? raw.updatedAt ?? new Date(0).toISOString();
  const updatedAt = raw.updatedAt ?? raw.createdAt ?? new Date(0).toISOString();
  const encoded = encodeMemory({
    kind,
    title,
    content,
    tags,
    sourceRefs,
    importance: raw.importance,
    confidence: normalizeLegacyConfidence(raw.confidence),
    sensitivity,
    promptPolicy: normalizeLegacyPromptPolicy(raw.promptPolicy)
  });
  const effectiveSensitivity = encoded.sensitivity;
  return {
    ...record,
    id: raw.id ?? randomUUID(),
    scope: raw.scope === "short_term" || raw.scope === "long_term" ? raw.scope : "long_term",
    kind,
    title,
    content,
    projectId: typeof raw.projectId === "string" ? raw.projectId : typeof raw.project === "string" ? raw.project : "default",
    sourceRefs,
    tags: tags.length > 0 ? tags : encoded.tags,
    importance: typeof raw.importance === "number" ? raw.importance : 0.5,
    confidence: normalizeLegacyConfidence(raw.confidence),
    sensitivity: effectiveSensitivity,
    promptPolicy: normalizePromptPolicy(normalizeLegacyPromptPolicy(raw.promptPolicy), effectiveSensitivity),
    createdAt,
    updatedAt,
    expiresAt: raw.expiresAt,
    memoryStrength: typeof raw.memoryStrength === "number" ? raw.memoryStrength : encoded.memoryStrength,
    baseActivation: typeof raw.baseActivation === "number" ? raw.baseActivation : encoded.baseActivation,
    retrievalCount: typeof raw.retrievalCount === "number" ? raw.retrievalCount : 0,
    lastRetrievedAt: raw.lastRetrievedAt,
    lastReinforcedAt: raw.lastReinforcedAt,
    decayRate: typeof raw.decayRate === "number" ? raw.decayRate : encoded.decayRate,
    stability: typeof raw.stability === "number" ? raw.stability : encoded.stability,
    priorityScore: typeof raw.priorityScore === "number" ? raw.priorityScore : encoded.priorityScore,
    emotionalWeight: raw.emotionalWeight,
    contextCues: Array.isArray(raw.contextCues) ? raw.contextCues : encoded.contextCues,
    associations: Array.isArray(raw.associations) ? raw.associations : [],
    supersededBy: raw.supersededBy,
    status: normalizeMemoryStatus(raw.status),
    nextReviewAt: raw.nextReviewAt,
    reviewIntervalDays: typeof raw.reviewIntervalDays === "number" ? raw.reviewIntervalDays : Math.max(1, Math.ceil(encoded.memoryStrength / 6)),
    easinessFactor: typeof raw.easinessFactor === "number" ? raw.easinessFactor : 2.3,
    reviewCount: typeof raw.reviewCount === "number" ? raw.reviewCount : 0,
    negativeCues: Array.isArray(raw.negativeCues) ? raw.negativeCues : [],
    inferredIntent: raw.inferredIntent ?? encoded.inferredIntent,
    privacySafeSummary: raw.privacySafeSummary ?? encoded.privacySafeSummary,
    version: typeof raw.version === "number" ? raw.version : 1
  };
}

function normalizeMemoryKind(kind?: string): MemoryKind {
  const allowed = new Set<MemoryKind>([
    "task",
    "decision",
    "rule",
    "lesson",
    "bug",
    "risk",
    "route",
    "permission",
    "deploy_note",
    "debug_note",
    "summary",
    "preference",
    "experience",
    "system_note"
  ]);
  if (allowed.has(kind as MemoryKind)) {
    return kind as MemoryKind;
  }
  if (kind === "deploy" || kind === "deployment") {
    return "deploy_note";
  }
  return "system_note";
}

function normalizeMemoryStatus(status?: string): MemoryRecord["status"] {
  if (status === "active" || status === "weak" || status === "archived" || status === "superseded") {
    return status;
  }
  return "active";
}

function normalizeLegacyConfidence(confidence?: string): MemoryConfidence {
  return confidence === "low" || confidence === "medium" || confidence === "high" ? confidence : "medium";
}

function sensitivityFromLegacyPrivacy(privacy?: string[]): MemorySensitivity | undefined {
  if (!Array.isArray(privacy)) {
    return undefined;
  }
  if (privacy.includes("secret")) {
    return "secret";
  }
  if (privacy.includes("confidential")) {
    return "confidential";
  }
  if (privacy.includes("public")) {
    return "public";
  }
  return "internal";
}

function normalizeLegacyPromptPolicy(promptPolicy?: PromptPolicy | string): PromptPolicy | undefined {
  if (promptPolicy === "never_prompt_raw") {
    return "do_not_prompt";
  }
  if (promptPolicy === "allow_raw" || promptPolicy === "summarize_only" || promptPolicy === "do_not_prompt") {
    return promptPolicy;
  }
  return undefined;
}

function toMemoryMetadata(record: MemoryRecord, now: Date): MemoryMetadata {
  const normalized = normalizeStoredMemory(record);
  return {
    id: normalized.id,
    scope: normalized.scope,
    kind: normalized.kind,
    title: redactText(normalized.title),
    projectId: normalized.projectId,
    sourceRefs: normalized.sourceRefs.map(redactText),
    tags: normalized.tags.map(redactText),
    importance: normalized.importance,
    confidence: normalized.confidence,
    sensitivity: normalized.sensitivity,
    promptPolicy: normalizePromptPolicy(normalized.promptPolicy, normalized.sensitivity),
    status: deriveMemoryStatus(normalized, now),
    memoryStrength: normalized.memoryStrength,
    baseActivation: normalized.baseActivation,
    retrievalCount: normalized.retrievalCount,
    lastRetrievedAt: normalized.lastRetrievedAt,
    lastReinforcedAt: normalized.lastReinforcedAt,
    decayRate: normalized.decayRate,
    stability: normalized.stability,
    priorityScore: normalized.priorityScore,
    contextCues: normalized.contextCues?.map(redactText),
    supersededBy: normalized.supersededBy,
    nextReviewAt: normalized.nextReviewAt,
    reviewIntervalDays: normalized.reviewIntervalDays,
    easinessFactor: normalized.easinessFactor,
    reviewCount: normalized.reviewCount,
    createdAt: normalized.createdAt,
    updatedAt: normalized.updatedAt,
    expiresAt: normalized.expiresAt,
    version: normalized.version
  };
}

function deriveMemoryStatus(record: MemoryRecord, now: Date): MemoryMetadata["status"] {
  if (record.expiresAt && new Date(record.expiresAt).getTime() <= now.getTime()) {
    return "expired";
  }

  if (record.status === "archived" || record.status === "superseded" || record.status === "weak") {
    return record.status;
  }

  const markers = [record.title, ...record.tags].join(" ").toLowerCase();
  if (/\bdeprecated\b|\bobsolete\b|\bsuperseded\b/.test(markers)) {
    return "deprecated";
  }
  if (/\bpending\b|\breview\b|\bunverified\b/.test(markers)) {
    return "pending";
  }
  if (/\brejected\b|\binvalid\b/.test(markers)) {
    return "rejected";
  }
  if (record.status === "active") {
    return "active";
  }
  return "active";
}

function createPolicySafeScoreInputs(metadata: MemoryMetadata, record: MemoryRecord, mode: MemoryContextMode): string[] {
  const base = [
    metadata.kind,
    metadata.title,
    metadata.projectId,
    ...metadata.tags,
    ...metadata.sourceRefs
  ];

  if (mode === "raw" || mode === "summary") {
    base.push(record.content);
  }

  return base.map(redactText);
}

function normalizePromptPolicy(promptPolicy: PromptPolicy | undefined, sensitivity: MemorySensitivity): PromptPolicy {
  if (promptPolicy === "allow_raw" || promptPolicy === "summarize_only" || promptPolicy === "do_not_prompt") {
    return promptPolicy;
  }
  if (sensitivity === "public") {
    return "allow_raw";
  }
  if (sensitivity === "secret") {
    return "do_not_prompt";
  }
  return "summarize_only";
}

function normalizeConfidence(confidence?: MemoryConfidence): MemoryConfidence {
  return confidence ?? "medium";
}

function normalizeSensitivity(sensitivity?: MemorySensitivity): MemorySensitivity {
  return sensitivity ?? "internal";
}

async function initMemoryFiles(cwd: string): Promise<void> {
  const memoryDir = path.resolve(cwd, ATLAS_DIR, MEMORY_DIR);
  await ensureMemoryDirectory(cwd, ".lmti/memory");
  await ensureJsonArray(cwd, path.join(memoryDir, SHORT_TERM_MEMORY_FILE));
  await ensureJsonArray(cwd, path.join(memoryDir, LONG_TERM_MEMORY_FILE));
  await ensureJsonArray(cwd, path.join(memoryDir, LESSONS_MEMORY_FILE));
  await ensureFile(cwd, path.join(memoryDir, MEMORY_EVENTS_FILE), "");
}

async function readAllMemory(cwd: string): Promise<MemoryRecord[]> {
  const [shortTerm, longTerm, lessons] = await Promise.all([readMemoryScope("short_term", cwd), readMemoryScope("long_term", cwd), readLessonMemory(cwd)]);
  return [...shortTerm, ...longTerm, ...lessons];
}

async function writeAllMemory(records: MemoryRecord[], cwd: string): Promise<void> {
  await writeMemoryScope(
    "short_term",
    records.filter((record) => record.scope === "short_term"),
    cwd
  );
  await writeMemoryScope(
    "long_term",
    records.filter((record) => record.scope === "long_term" && record.kind !== "lesson"),
    cwd
  );
  await writeLessonMemory(records.filter((record) => record.kind === "lesson"), cwd);
}

async function markSupersededMemory(newMemory: MemoryRecord, cwd: string): Promise<void> {
  const existing = await readAllMemory(cwd);
  const superseded = detectSupersession(newMemory, existing);
  if (!superseded) {
    return;
  }

  const now = newMemory.updatedAt;
  const next = existing.map((record) =>
    record.id === superseded.id
      ? {
          ...record,
          status: "superseded" as const,
          supersededBy: newMemory.id,
          updatedAt: now,
          version: record.version + 1
        }
      : record
  );
  await writeAllMemory(next, cwd);
  await appendMemoryEvent(cwd, { event: "memory.supersede", id: superseded.id, supersededBy: newMemory.id });
}

async function reinforceRetrievedMemories(ids: string[], options: { cwd: string; now: Date; reason: string }): Promise<void> {
  const uniqueIds = Array.from(new Set(ids));
  if (uniqueIds.length === 0) {
    return;
  }

  const all = await readAllMemory(options.cwd);
  const active = new Set(uniqueIds);
  let next = all.map((record) =>
    active.has(record.id)
      ? reinforceMemoryRecord(record, {
          success: true,
          now: options.now,
          intensity: 0.6
        })
      : record
  );
  next = reinforceAssociationSet(next, uniqueIds, options.reason, options.now.toISOString());
  await writeAllMemory(next, options.cwd);
  await appendMemoryEvent(options.cwd, { event: "memory.retrieve_reinforce", ids: uniqueIds });
}

async function readMemoryScope(scope: MemoryScope, cwd: string): Promise<MemoryRecord[]> {
  await initMemoryFiles(cwd);
  const checked = await checkedStoragePath(cwd, path.relative(path.resolve(cwd), memoryFilePath(cwd, scope)), { kind: "file", private: true });
  await checked.recheck();
  const content = await fs.readFile(checked.filename, "utf8");
  return (JSON.parse(content) as MemoryRecord[]).map(normalizeStoredMemory);
}

async function writeMemoryScope(scope: MemoryScope, records: MemoryRecord[], cwd: string): Promise<void> {
  await initMemoryFiles(cwd);
  await writeOwnedFile(cwd, memoryFilePath(cwd, scope), JSON.stringify(records, null, 2));
}

async function readLessonMemory(cwd: string): Promise<MemoryRecord[]> {
  await initMemoryFiles(cwd);
  const checked = await checkedStoragePath(cwd, `.lmti/memory/${LESSONS_MEMORY_FILE}`, { kind: "file", private: true });
  await checked.recheck();
  const content = await fs.readFile(checked.filename, "utf8");
  return (JSON.parse(content) as MemoryRecord[]).map(normalizeStoredMemory);
}

async function writeLessonMemory(records: MemoryRecord[], cwd: string): Promise<void> {
  await initMemoryFiles(cwd);
  await writeOwnedFile(cwd, path.resolve(cwd, ATLAS_DIR, MEMORY_DIR, LESSONS_MEMORY_FILE), JSON.stringify(records, null, 2));
}

function memoryFilePath(cwd: string, scope: MemoryScope): string {
  const file = scope === "short_term" ? SHORT_TERM_MEMORY_FILE : LONG_TERM_MEMORY_FILE;
  return path.resolve(cwd, ATLAS_DIR, MEMORY_DIR, file);
}

async function applyPrivacy(records: MemoryRecord[], options: MemoryRuntimeOptions): Promise<MemoryRecord[]> {
  const visible: MemoryRecord[] = [];
  for (const record of records) {
    const sanitized = await applyPrivacyToRecord(record, options);
    if (sanitized) {
      visible.push(sanitized);
    }
  }
  return visible;
}

async function applyPrivacyToRecord(record: MemoryRecord, options: MemoryRuntimeOptions): Promise<MemoryRecord | undefined> {
  const cwd = options.cwd ?? process.cwd();
  const privacyContext = privacyContextForOptions(options);
  const evaluation = evaluateAccess(record, privacyContext);
  await auditSensitiveAccess(cwd, record, privacyContext, evaluation.decision, evaluation.reason);

  if (evaluation.decision === "deny") {
    return undefined;
  }

  if (evaluation.decision === "summarize") {
    return {
      ...record,
      title: redactText(record.title),
      content: createSafeSummary(record)
    };
  }

  if (record.sensitivity === "secret" && privacyContext.role === "owner" && privacyContext.includeSecret && privacyContext.includeRaw) {
    return record;
  }

  return {
    ...record,
    title: redactText(record.title),
    content: redactText(record.content)
  };
}

function privacyContextForOptions(options: MemoryRuntimeOptions, overrides: Partial<PrivacyContext> = {}): PrivacyContext {
  return createPrivacyContext({
    ...options.privacyContext,
    includeSecret: overrides.includeSecret ?? options.privacyContext?.includeSecret ?? false,
    includeRaw: overrides.includeRaw ?? options.privacyContext?.includeRaw ?? false,
    command: overrides.command ?? options.privacyContext?.command ?? "memory",
    timestamp: options.now?.toISOString() ?? options.privacyContext?.timestamp
  });
}

async function appendMemoryEvent(cwd: string, event: Record<string, unknown>): Promise<void> {
  await initMemoryFiles(cwd);
  const line = JSON.stringify({ ...event, recordedAt: new Date().toISOString() });
  await writeOwnedFile(cwd, path.resolve(cwd, ATLAS_DIR, MEMORY_DIR, MEMORY_EVENTS_FILE), `${line}\n`, "append");
}

async function appendTaskEvent(cwd: string, event: TaskDoneEvent): Promise<void> {
  const eventsDir = path.resolve(cwd, ATLAS_DIR, EVENTS_DIR);
  await ensureMemoryDirectory(cwd, ".lmti/events");
  await writeOwnedFile(cwd, path.join(eventsDir, TASK_EVENTS_FILE), `${JSON.stringify(event)}\n`, "append");
}

function intentTags(taskIntent?: InferredIntent): string[] {
  if (!taskIntent) {
    return [];
  }
  return [taskIntent.primaryIntent, ...taskIntent.secondaryIntents].filter((intent) => intent !== "unknown");
}

function createRememberSuggestion(title: string, summary: string, tags: string[]): string {
  const safeTitle = title.replace(/"/g, "'");
  const safeSummary = summary.replace(/"/g, "'");
  const tagArg = tags.length > 0 ? tags.join(",") : "lesson";
  return `Should this be proposed as a project lesson? Use lmti memory lesson propose --task "${safeTitle}" --summary "${safeSummary}" --lesson "<lesson>" --applies-to ${tagArg}`;
}

async function ensureJsonArray(cwd: string, filePath: string): Promise<void> {
  await ensureFile(cwd, filePath, "[]");
}

async function ensureFile(cwd: string, filePath: string, content: string): Promise<void> {
  await writeOwnedFile(cwd, filePath, content, "ensure");
}

async function writeOwnedFile(cwd: string, filename: string, content: string,
  mode: "replace" | "append" | "ensure" = "replace"): Promise<void> {
  await writeMemoryFile(cwd, path.relative(path.resolve(cwd), filename), content, mode);
}

function validateMemory(record: MemoryRecord): void {
  if (!record.title) {
    throw new Error("Memory title is required.");
  }
  if (!record.content) {
    throw new Error("Memory content is required.");
  }
  if (!record.projectId) {
    throw new Error("Memory projectId is required.");
  }
  if (record.scope === "long_term" && record.expiresAt) {
    throw new Error("Long-term memory must not expire automatically.");
  }
  if (record.promptPolicy && !["allow_raw", "summarize_only", "do_not_prompt"].includes(record.promptPolicy)) {
    throw new Error(`Invalid prompt policy: ${record.promptPolicy}`);
  }
  if (record.status && !["active", "weak", "archived", "superseded"].includes(record.status)) {
    throw new Error(`Invalid memory status: ${record.status}`);
  }
}

function isExpired(record: MemoryRecord, now: Date): boolean {
  return Boolean(record.expiresAt && new Date(record.expiresAt).getTime() <= now.getTime());
}

function clampImportance(value: number): number {
  if (!Number.isFinite(value)) {
    return 0.5;
  }
  return Math.max(0, Math.min(1, value));
}

function scoreMemory(record: MemoryRecord, keywords: string[]): number {
  if (keywords.length === 0) {
    return 0;
  }
  if (record.status === "archived" || record.status === "superseded") {
    return 0;
  }
  const corpus = normalizeSearchText([record.title, record.content, record.kind, record.scope, record.projectId, ...record.tags, ...record.sourceRefs].join(" "));
  let score = 0;
  for (const keyword of keywords) {
    if (corpus.includes(keyword)) {
      score += keyword.length > 3 ? 2 : 1;
    }
  }
  return score + record.importance;
}

function scoreContextMemory(
  record: MemoryRecord,
  taskIntent: InferredIntent,
  now: Date
): { score: number; why: string[]; intentMatch: number; keywordMatch: number; negativeKeywordPenalty: number } {
  const corpus = normalizeSearchText([record.title, record.content, record.kind, record.scope, record.projectId, ...record.tags, ...record.sourceRefs].join(" "));
  const why: string[] = [];
  let intentMatch = 0;
  let keywordMatch = 0;
  let negativeKeywordPenalty = 0;

  const primaryTerms = [taskIntent.primaryIntent, ...intentKeywords(taskIntent.primaryIntent)];
  if (taskIntent.primaryIntent !== "unknown" && primaryTerms.some((term) => corpus.includes(normalizeSearchText(term)))) {
    intentMatch = 1;
    why.push(`matched primary intent ${taskIntent.primaryIntent}`);
  }

  for (const secondary of taskIntent.secondaryIntents) {
    const terms = [secondary, ...intentKeywords(secondary)];
    if (terms.some((term) => corpus.includes(normalizeSearchText(term)))) {
      intentMatch += 0.5;
      why.push(`matched secondary intent ${secondary}`);
    }
  }

  for (const keyword of taskIntent.keywords) {
    const normalized = normalizeSearchText(keyword);
    if (normalized && corpus.includes(normalized)) {
      keywordMatch += normalized.length > 3 ? 2 : 1;
    }
  }
  if (keywordMatch > 0) {
    why.push(`matched ${keywordMatch} keyword weight`);
  }

  for (const keyword of taskIntent.negativeKeywords) {
    const normalized = normalizeSearchText(keyword);
    if (normalized && corpus.includes(normalized)) {
      negativeKeywordPenalty += 1;
    }
  }
  if (negativeKeywordPenalty > 0) {
    why.push(`penalized ${negativeKeywordPenalty} negative keyword match`);
  }

  const memoryKindWeight = memoryKindWeightForIntent(record.kind, taskIntent);
  if (memoryKindWeight > 0) {
    why.push(`${record.kind} memory fits task intent`);
  }

  const routeMatch = routeMatchForIntent(corpus, taskIntent);
  if (routeMatch > 0) {
    why.push("matched route/API clue");
  }

  const recencyWeight = recencyWeightFor(record, now);
  const importanceWeight = record.importance * 2;
  const score = intentMatch * 5 + routeMatch * 4 + memoryKindWeight + keywordMatch + recencyWeight + importanceWeight - negativeKeywordPenalty * 8;

  return {
    score: Math.max(0, Math.round(score * 10) / 10),
    why,
    intentMatch,
    keywordMatch,
    negativeKeywordPenalty
  };
}

function memoryKindWeightForIntent(kind: MemoryKind, taskIntent: InferredIntent): number {
  const intents = new Set([taskIntent.primaryIntent, ...taskIntent.secondaryIntents]);
  if (kind === "permission" && intents.has("permission")) {
    return 4;
  }
  if (kind === "route" && intents.has("routing")) {
    return 4;
  }
  if ((kind === "deploy_note" || kind === "risk") && intents.has("deploy")) {
    return 3;
  }
  if ((kind === "debug_note" || kind === "bug" || kind === "risk") && (intents.has("debug") || intents.has("bugfix"))) {
    return 3;
  }
  if ((kind === "lesson" || kind === "rule" || kind === "decision") && taskIntent.primaryIntent !== "unknown") {
    return 2;
  }
  return 0;
}

function routeMatchForIntent(corpus: string, taskIntent: InferredIntent): number {
  const intents = new Set([taskIntent.primaryIntent, ...taskIntent.secondaryIntents]);
  if ((intents.has("routing") || intents.has("api") || intents.has("permission")) && (/\/[a-z0-9_-]+/i.test(corpus) || corpus.includes("endpoint") || corpus.includes("route"))) {
    return 1;
  }
  return 0;
}

function recencyWeightFor(record: MemoryRecord, now: Date): number {
  const updatedAt = new Date(record.updatedAt).getTime();
  if (!Number.isFinite(updatedAt)) {
    return 0;
  }
  const ageMs = now.getTime() - updatedAt;
  if (ageMs < 0) {
    return 0;
  }
  if (ageMs <= 7 * 24 * 60 * 60 * 1000) {
    return 1;
  }
  if (ageMs <= 30 * 24 * 60 * 60 * 1000) {
    return 0.5;
  }
  return 0;
}

function intentKeywords(intent: InferredIntent["primaryIntent"]): string[] {
  switch (intent) {
    case "permission":
      return ["permission", "403", "forbidden", "least privilege", "role", "access"];
    case "routing":
      return ["route", "routing", "redirect", "path", "url"];
    case "dashboard":
      return ["dashboard", "summary", "agent"];
    case "deploy":
      return ["deploy", "build", "env", "logs", "release"];
    case "debug":
      return ["debug", "error", "risk", "module", "trace"];
    case "bugfix":
      return ["bug", "fix", "error"];
    case "api":
      return ["api", "endpoint", "request", "response"];
    case "partner":
      return ["partner"];
    case "privacy":
      return ["privacy", "secret", "confidential", "prompt"];
    case "memory":
      return ["memory", "lesson", "rule", "decision"];
    default:
      return [intent];
  }
}

function createUnknownIntent(query: string): InferredIntent {
  return {
    primaryIntent: "unknown",
    secondaryIntents: [],
    keywords: tokenize(query),
    negativeKeywords: [],
    confidence: 0
  };
}

function createTaskRelevantSummary(record: MemoryRecord, taskIntent: InferredIntent): string {
  const intentLabel = [taskIntent.primaryIntent, ...taskIntent.secondaryIntents].filter((intent) => intent !== "unknown").join(", ") || "task";
  const tags = record.tags.length > 0 ? ` Tags: ${record.tags.slice(0, 6).join(", ")}.` : "";
  return `${record.sensitivity} ${record.kind} memory "${redactText(record.title)}" matched ${intentLabel}.${tags} Raw content withheld by prompt policy.`;
}

async function appendContextPrivacyAudit(
  cwd: string,
  memory: MemoryRecord,
  privacyContext: PrivacyContext,
  mode: MemoryContextMode,
  reason: string,
  taskIntent: InferredIntent,
  score?: number
): Promise<void> {
  const shouldLog =
    memory.sensitivity === "confidential" ||
    memory.sensitivity === "secret" ||
    normalizePromptPolicy(memory.promptPolicy, memory.sensitivity) === "do_not_prompt" ||
    (memory.sensitivity === "internal" && mode === "raw");
  if (!shouldLog) {
    return;
  }

  const logsDir = path.resolve(cwd, ATLAS_DIR, "logs");
  await ensureMemoryDirectory(cwd, ".lmti/logs");
  await writeOwnedFile(
    cwd, path.join(logsDir, "privacy-audit.jsonl"),
    `${JSON.stringify({
      event: "memory.context_privacy",
      memoryId: memory.id,
      title: redactText(memory.title),
      sensitivity: memory.sensitivity,
      promptPolicy: normalizePromptPolicy(memory.promptPolicy, memory.sensitivity),
      mode,
      role: privacyContext.role,
      command: privacyContext.command,
      reason,
      primaryIntent: taskIntent.primaryIntent,
      score,
      recordedAt: new Date().toISOString()
    })}\n`,
    "append"
  );
}

function tokenize(query: string): string[] {
  const stopWords = new Set(["the", "and", "for", "with", "that", "this", "from", "into", "fix", "bug"]);
  return Array.from(
    new Set(
      normalizeSearchText(query)
        .split(/[^a-z0-9_]+/i)
        .map((part) => part.trim())
        .filter((part) => part.length >= 2 && !stopWords.has(part))
    )
  );
}

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}
