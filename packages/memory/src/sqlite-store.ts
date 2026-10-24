import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { redactText, runEgressSecretScan } from "@atlas/privacy";
import type {
  CommandRunSummary,
  DecisionSummary,
  ErrorSummary,
  Evidence,
  FileTouchSummary,
  LessonApprovalStatus,
  LessonCandidate,
  LessonCandidateType,
  MemoryRecord,
  SourceRef,
  TaskObservation,
  TaskObservationPrivacyStatus,
  TaskOutcome,
  TestRunSummary
} from "@atlas/types";
import { clamp01, normalizeMemoryText, round, tokenizeMemoryText } from "./encode";
import {
  classifyLibraryMemory,
  isLibraryPrivacyLevel,
  isLibraryZone,
  LIBRARY_ZONES,
  normalizeLibraryTags,
  suggestZonesForTask,
  type LibraryClassification,
  type LibraryPrivacyLevel,
  type LibraryZone
} from "./library-algorithm";
import {
  applyLibraryWritePrivacyGate,
  detectLibraryPrivacyFindings,
  filterLibraryMemoryForPrompt
} from "./library-privacy";
import { checkedMemoryFile, MAX_CONTEXT_MEMORY_BYTES, MAX_CONTEXT_MEMORY_RECORDS, requireCompleteMemoryScan } from "./read-boundary";
import { checkedSqliteTarget, type CheckedMemoryPath } from "./storage-boundary";

export const PROJECT_MEMORY_DB_FILE = "project-memory.sqlite";

export interface ProjectMemoryStorageInitResult {
  dbPath: string;
  schemaVersion: number;
}

export interface AddProjectMemoryInput {
  id?: string;
  title?: string;
  content: string;
  source?: string;
  sourceType?: string;
  tags?: string[];
  zone?: LibraryZone;
  privacyLevel?: LibraryPrivacyLevel;
  confidence?: number;
  importance?: number;
  expiresAt?: string;
  status?: ProjectMemoryStatus;
}

export interface ProjectMemoryItem {
  id: string;
  zone: LibraryZone;
  title: string;
  content: string;
  summary: string;
  contentHash: string;
  source?: string;
  sourceType?: string;
  tags: string[];
  privacyLevel: LibraryPrivacyLevel;
  confidence: number;
  importance: number;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt?: string;
  expiresAt?: string;
  status: ProjectMemoryStatus;
  reasons: string[];
}

export type ProjectMemoryStatus = "active" | "archived" | "superseded" | "deleted";

export interface ProjectMemorySearchOptions {
  zones?: LibraryZone[];
  limit?: number;
  privacyMode?: "safe" | "internal";
  includeArchived?: boolean;
  now?: Date;
}

export interface ProjectMemorySearchResult {
  item: ProjectMemoryItem;
  score: number;
  bm25: number;
  mode: "raw" | "summary";
  why: string[];
}

export interface RetrieveMemoryForTaskOptions extends ProjectMemorySearchOptions {}

export type ShortMemoryPriority = "low" | "medium" | "high" | "critical";
export type ShortMemoryStatus = "active" | "expired" | "deleted" | "promoted" | "blocked_by_privacy";

export interface ShortMemoryTtl {
  minutes?: number;
  hours?: number;
  days?: number;
}

export interface CreateShortMemoryNoteInput {
  title: string;
  content: string;
  source?: string;
  sourceType?: string;
  tags?: string[];
  priority?: ShortMemoryPriority;
  ttl?: ShortMemoryTtl;
}

export interface ShortMemoryNote {
  id: string;
  title: string;
  content: string;
  summary: string;
  contentHash: string;
  source?: string;
  sourceType?: string;
  tags: string[];
  priority: ShortMemoryPriority;
  status: ShortMemoryStatus;
  privacyLevel: LibraryPrivacyLevel;
  importanceScore: number;
  promoteScore: number;
  promotedToLongMemoryId?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  lastAccessedAt?: string;
  accessCount: number;
  reasons: string[];
}

export interface ShortMemoryRetrievalNote {
  id: string;
  title: string;
  summary: string;
  tags: string[];
  priority: ShortMemoryPriority;
  expiresAt: string;
  reason: string;
  score: number;
}

export interface RetrieveShortMemoryResult {
  notes: ShortMemoryRetrievalNote[];
  filteredOut: number;
}

export interface RetrieveShortMemoryOptions {
  limit?: number;
  tags?: string[];
  includeExpired?: boolean;
  privacyMode?: "safe" | "internal";
  now?: Date;
}

export interface ShortMemoryExpirationResult {
  expired: number;
  keptForPromotion: number;
}

export interface ShortMemoryCleanupResult {
  deleted: number;
  keptForPromotion: number;
  dryRun: boolean;
  candidateIds: string[];
}

export interface PromoteShortMemoryResult {
  note: ShortMemoryNote;
  longMemory?: ProjectMemoryItem;
  promoted: boolean;
  reason: string;
}

export interface ShortMemoryPromotionEvaluation {
  noteId: string;
  promoteScore: number;
  shouldSuggest: boolean;
  shouldAutoPromote: boolean;
  blocked: boolean;
  reasons: string[];
}

export interface MemoryContextForTaskResult {
  shortMemory: ShortMemoryRetrievalNote[];
  longMemory: ProjectMemorySearchResult[];
  warnings: string[];
}

export interface TaskObservationInput {
  taskId?: string;
  taskTitle: string;
  taskSummary?: string;
  agent?: string;
  filesTouched?: FileTouchSummary[];
  commandsRun?: CommandRunSummary[];
  tests?: TestRunSummary[];
  errors?: ErrorSummary[];
  decisions?: DecisionSummary[];
  outcome?: TaskOutcome;
  sourceRefs?: SourceRef[];
}

export interface LessonProposalInput {
  observation: TaskObservationInput;
  agentProposedLesson?: string;
  lessonType?: LessonCandidateType;
  title?: string;
  appliesTo?: string[];
  suggestedVerification?: string[];
}

export interface LessonProposalResult {
  observation: TaskObservation;
  candidate: LessonCandidate;
}

export interface LessonCandidateListOptions {
  approvalStatus?: LessonApprovalStatus;
  privacyStatus?: TaskObservationPrivacyStatus;
  limit?: number;
}

export interface LessonCandidateReviewSummary {
  total: number;
  pending: number;
  needsReview: number;
  privacyWarnings: number;
  missingEvidence: number;
  highConfidencePending: number;
}

export interface ProjectMemoryStats {
  total: number;
  byZone: Record<LibraryZone, number>;
  byPrivacyLevel: Record<LibraryPrivacyLevel, number>;
  byStatus: Record<ProjectMemoryStatus, number>;
}

export interface ProjectMemoryPrivacyFinding {
  id: string;
  title: string;
  zone: LibraryZone;
  privacyLevel: LibraryPrivacyLevel;
  issue: string;
  recommendation: string;
}

type SqliteValue = string | number | null;

interface ProjectMemoryRow {
  id: string;
  zone: string;
  title: string;
  content: string;
  summary: string;
  content_hash?: string;
  source: string | null;
  source_type: string | null;
  tags: string;
  privacy_level: string;
  confidence: number;
  importance: number;
  created_at: string;
  updated_at: string;
  last_accessed_at: string | null;
  expires_at: string | null;
  status: string;
  reasons: string;
  bm25?: number;
}

interface ShortMemoryRow {
  id: string;
  title: string;
  content: string;
  summary: string | null;
  content_hash?: string;
  source: string | null;
  source_type: string | null;
  tags: string | null;
  priority: string;
  status: string;
  privacy_level: string;
  importance_score: number;
  promote_score: number;
  promoted_to_long_memory_id: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
  last_accessed_at: string | null;
  access_count?: number;
  reasons?: string | null;
  bm25?: number;
}

interface TaskObservationRow {
  id: string;
  task_title: string;
  task_summary: string | null;
  agent: string | null;
  files_touched: string;
  commands_run: string;
  tests: string;
  errors: string;
  decisions: string;
  outcome: string;
  privacy_scan_status: string;
  source_refs: string;
  created_at: string;
}

interface LessonCandidateRow {
  id: string;
  task_id: string;
  lesson_type: string;
  title: string;
  summary: string;
  lesson: string;
  applies_to: string;
  source_refs: string;
  evidence: string;
  confidence: number;
  privacy_status: string;
  approval_status: string;
  verify_required: number;
  suggested_verification: string;
  last_verified_at: string | null;
  created_at: string;
  updated_at: string;
}

const SCHEMA_VERSION = 4;
const DEFAULT_RETRIEVE_LIMIT = 8;
const DEFAULT_SHORT_MEMORY_LIMIT = 8;
const SHORT_MEMORY_PROMOTE_SUGGEST_THRESHOLD = 0.75;
const SHORT_MEMORY_AUTO_PROMOTE_THRESHOLD = 0.9;

/** Owner-only projection for read-only context. Both tables share one snapshot.
 * No schema initialization, expiry, audit, access or reinforcement writes. */
export async function readProjectMemoryRecords(cwd: string, projectId: string): Promise<{ records: MemoryRecord[]; revision: string } | undefined> {
  const dbPath = await checkedMemoryFile(cwd, PROJECT_MEMORY_DB_FILE, 128 * 1024 * 1024);
  if (!dbPath) return undefined;
  await checkedMemoryFile(cwd, `${PROJECT_MEMORY_DB_FILE}-wal`, 128 * 1024 * 1024);
  await checkedMemoryFile(cwd, `${PROJECT_MEMORY_DB_FILE}-shm`, 16 * 1024 * 1024);
  await checkedMemoryFile(cwd, `${PROJECT_MEMORY_DB_FILE}-journal`, 128 * 1024 * 1024);
  const sqlite = await import("node:sqlite");
  const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec("PRAGMA query_only = ON; BEGIN;");
    const version = db.prepare("SELECT MAX(version) AS version FROM memory_migrations").get() as { version: number };
    if (version.version !== SCHEMA_VERSION) throw new Error("MEMORY_SCHEMA_UNSUPPORTED");
    const rows = db.prepare("SELECT * FROM memory_items WHERE status != 'deleted' ORDER BY id LIMIT ?").all(MAX_CONTEXT_MEMORY_RECORDS + 1) as unknown as ProjectMemoryRow[];
    const shortRows = db.prepare("SELECT * FROM short_memory_notes WHERE status NOT IN ('deleted', 'promoted') ORDER BY id LIMIT ?").all(MAX_CONTEXT_MEMORY_RECORDS + 1) as unknown as ShortMemoryRow[];
    requireCompleteMemoryScan([...rows, ...shortRows]);
    if (Buffer.byteLength(JSON.stringify([rows, shortRows])) > MAX_CONTEXT_MEMORY_BYTES) throw new Error("MEMORY_READ_BUDGET_EXCEEDED");
    const records: MemoryRecord[] = [];
    const lessonRevisions: LessonCandidate[] = [];
    for (const row of rows) {
      if (!isLibraryPrivacyLevel(row.privacy_level) || !isProjectMemoryStatus(row.status) || !isLibraryZone(row.zone)) throw new Error("MEMORY_SOURCE_INVALID");
      const item = rowToProjectMemoryItem(row);
      const sourceRefs = item.source ? [item.source] : [];
      const lesson = item.zone === "lesson" || item.sourceType === "lesson_candidate";
      if (lesson) {
        if (!item.source?.startsWith("lesson_candidate:")) continue;
        const candidate = getLessonCandidateSync(db, item.source.slice("lesson_candidate:".length));
        if (!candidate || candidate.approvalStatus !== "approved" || candidate.privacyStatus !== "pass") continue;
        sourceRefs.push(...candidate.sourceRefs.map(ref => ref.ref));
        lessonRevisions.push(candidate);
      }
      records.push({ id: item.id, scope: "long_term", kind: lesson ? "lesson" : item.zone === "deployment" ? "deploy_note" : "system_note", title: item.title, content: item.content, privacySafeSummary: item.summary,
        projectId, sourceRefs, tags: item.tags, importance: item.importance, confidence: item.confidence >= 0.7 ? "high" : item.confidence >= 0.4 ? "medium" : "low",
        sensitivity: item.privacyLevel === "private" ? "confidential" : item.privacyLevel === "do_not_prompt" ? "secret" : item.privacyLevel,
        promptPolicy: item.privacyLevel === "secret" || item.privacyLevel === "do_not_prompt" ? "do_not_prompt" : item.privacyLevel === "public" ? "allow_raw" : "summarize_only",
        createdAt: item.createdAt, updatedAt: item.updatedAt, expiresAt: item.expiresAt, status: item.status === "archived" || item.status === "superseded" ? item.status : "active", version: SCHEMA_VERSION });
    }
    for (const row of shortRows) {
      if (!isLibraryPrivacyLevel(row.privacy_level) || !isShortMemoryStatus(row.status) || !isShortMemoryPriority(row.priority)) throw new Error("MEMORY_SOURCE_INVALID");
      const note = rowToShortMemoryNote(row);
      records.push({ id: note.id, scope: "short_term", kind: "task", title: note.title, content: note.content, privacySafeSummary: note.summary,
        projectId, sourceRefs: note.source ? [note.source] : [], tags: note.tags, importance: note.importanceScore, confidence: "medium",
        sensitivity: note.privacyLevel === "private" ? "confidential" : note.privacyLevel === "do_not_prompt" ? "secret" : note.privacyLevel,
        promptPolicy: note.status === "blocked_by_privacy" || note.privacyLevel === "secret" || note.privacyLevel === "do_not_prompt" ? "do_not_prompt" : note.privacyLevel === "public" ? "allow_raw" : "summarize_only",
        createdAt: note.createdAt, updatedAt: note.updatedAt, expiresAt: note.expiresAt, status: note.status === "expired" ? "archived" : "active", version: SCHEMA_VERSION });
    }
    return { records, revision: createHash("sha256").update(JSON.stringify([rows, shortRows, lessonRevisions])).digest("hex") };
  } finally { db.close(); }
}

export async function initProjectMemoryStorage(cwd = process.cwd()): Promise<ProjectMemoryStorageInitResult> {
  const { target, db } = await initializeProjectMemoryDatabase(cwd);
  try { return { dbPath: target.filename, schemaVersion: SCHEMA_VERSION }; }
  finally { db.close(); }
}

// Desktop reads must not initialize, migrate, expire, log or update access times.
// Storage stays owned by this module; the desktop receives bounded policy-safe values.
export async function readProjectMemorySnapshot(cwd: string, query = "") {
  const dbPath = await checkedMemoryFile(cwd, PROJECT_MEMORY_DB_FILE, 128 * 1024 * 1024);
  if (!dbPath) return { connected: false, memories: [], lessons: [], truncated: false };
  await checkedMemoryFile(cwd, `${PROJECT_MEMORY_DB_FILE}-wal`, 128 * 1024 * 1024);
  await checkedMemoryFile(cwd, `${PROJECT_MEMORY_DB_FILE}-shm`, 16 * 1024 * 1024);
  await checkedMemoryFile(cwd, `${PROJECT_MEMORY_DB_FILE}-journal`, 128 * 1024 * 1024);
  const sqlite = await import("node:sqlite");
  const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec("PRAGMA query_only = ON; BEGIN;");
    const version = db.prepare("SELECT MAX(version) AS version FROM memory_migrations").get() as { version: number };
    if (version.version !== SCHEMA_VERSION) throw new Error("MEMORY_SCHEMA_UNSUPPORTED");
    const rows = queryProjectMemoryRows(db, query, { limit: 201, now: new Date() });
    const memories: Array<{ id: string; title: string; summary: string; zone: string; privacy: string; updatedAt: string }> = [];
    for (const row of rows) {
      const item = rowToProjectMemoryItem(row);
      if (!isLibraryPrivacyLevel(row.privacy_level) || !isProjectMemoryStatus(row.status)) continue;
      if (item.zone === "lesson" || item.sourceType === "lesson_candidate") {
        if (!item.source?.startsWith("lesson_candidate:")) continue;
        const candidate = getLessonCandidateSync(db, item.source.slice("lesson_candidate:".length));
        if (!candidate || candidate.approvalStatus !== "approved" || candidate.privacyStatus !== "pass") continue;
      }
      const gate = filterLibraryMemoryForPrompt(item, { privacyMode: "safe" });
      if (!gate.allowed || !gate.item) continue;
      memories.push({ id: item.id, title: redactText(item.title).slice(0, 240), summary: redactText(gate.item.summary).slice(0, 2000), zone: item.zone, privacy: item.privacyLevel, updatedAt: item.updatedAt });
    }
    const candidates = db.prepare("SELECT * FROM lesson_candidates WHERE privacy_status = 'pass' ORDER BY created_at DESC LIMIT 201").all() as unknown as LessonCandidateRow[];
    const lessons = candidates.filter(row => ["pending", "approved", "rejected"].includes(row.approval_status)).map(rowToLessonCandidate).map(c => ({
      id: c.id, title: redactText(c.title).slice(0, 240), summary: redactText(c.lesson).slice(0, 2000), status: c.approvalStatus,
      fingerprint: createHash("sha256").update(JSON.stringify(c)).digest("hex"),
      evidence: c.evidence.map(e => `${e.type}: ${redactText(e.summary)}`).slice(0, 12),
      confidence: c.confidence, verifyRequired: c.verifyRequired, lastVerifiedAt: c.lastVerifiedAt,
      canApprove: c.approvalStatus === "pending" && c.confidence >= 0.2 && c.evidence.some(e => e.type !== "agent_summary" && e.type !== "privacy_check")
    }));
    return { connected: true, memories: memories.slice(0, 200), lessons: lessons.slice(0, 200), truncated: rows.length > 200 || candidates.length > 200 };
  } finally { db.close(); }
}

export async function reviewDesktopLesson(cwd: string, id: string, fingerprint: string, decision: "approve" | "reject") {
  // An existing supported store is required. No schema creation or migration.
  if (!(await readProjectMemorySnapshot(cwd)).connected) throw new Error("MEMORY_NOT_CONNECTED");
  const target = await checkedSqliteTarget(cwd, PROJECT_MEMORY_DB_FILE, false);
  const db = await openProjectMemoryDatabase(target);
  try {
    db.exec("PRAGMA busy_timeout = 2000; BEGIN IMMEDIATE;");
    const schema = db.prepare("SELECT MAX(version) AS version FROM memory_migrations").get() as { version: number };
    if (schema.version !== SCHEMA_VERSION) throw new Error("MEMORY_SCHEMA_UNSUPPORTED");
    const raw = db.prepare("SELECT approval_status, privacy_status FROM lesson_candidates WHERE id = ?").get(id) as { approval_status: string; privacy_status: string } | undefined;
    const candidate = getLessonCandidateSync(db, id);
    if (!raw || raw.approval_status !== "pending" || raw.privacy_status !== "pass" || !candidate || candidate.approvalStatus !== "pending" || candidate.privacyStatus !== "pass" || createHash("sha256").update(JSON.stringify(candidate)).digest("hex") !== fingerprint) throw new Error("LESSON_STALE_OR_DENIED");
    const now = new Date().toISOString();
    if (decision === "approve") {
      assertCandidateCanBeApproved(candidate);
      if (!candidate.evidence.some(e => e.type !== "agent_summary" && e.type !== "privacy_check")) throw new Error("LESSON_EVIDENCE_REQUIRED");
      const content = lessonCandidateToMemoryContent(candidate);
      const classification = classifyLibraryMemory({ title: candidate.title, content });
      const privacy = applyLibraryWritePrivacyGate({ title: candidate.title, content, summary: classification.summary, privacyLevel: "internal" });
      if (privacy.rawContentBlocked || privacy.privacyLevel === "secret" || privacy.privacyLevel === "do_not_prompt" || runEgressSecretScan(content).blocked) throw new Error("LESSON_PRIVACY_DENIED");
      const item: ProjectMemoryItem = {
        id: randomUUID(), zone: "lesson", title: privacy.title, content: privacy.content, summary: privacy.summary,
        contentHash: hashMemoryContent(privacy.title, privacy.summary, privacy.content), source: `lesson_candidate:${id}`, sourceType: "lesson_candidate",
        tags: ["lesson", "approved", candidate.lessonType], privacyLevel: privacy.privacyLevel, confidence: candidate.confidence, importance: 0.75,
        createdAt: now, updatedAt: now, status: "active", reasons: ["Explicit desktop evidence/privacy review"]
      };
      insertProjectMemoryItem(db, item);
      appendProjectMemoryEvent(db, item.id, "lesson_candidate.approved", { candidateId: id, reviewed: true });
    } else appendProjectMemoryEvent(db, undefined, "lesson_candidate.rejected", { candidateId: id, reviewed: true });
    db.prepare("UPDATE lesson_candidates SET approval_status = ?, updated_at = ? WHERE id = ?").run(decision === "approve" ? "approved" : "rejected", now, id);
    db.exec("COMMIT;");
    return { id, status: decision === "approve" ? "approved" : "rejected" };
  } catch (error) { try { db.exec("ROLLBACK;"); } catch {} throw error; }
  finally { db.close(); }
}

export async function addProjectMemory(input: AddProjectMemoryInput, options: { cwd?: string; now?: Date } = {}): Promise<ProjectMemoryItem> {
  const cwd = options.cwd ?? process.cwd();
  const now = (options.now ?? new Date()).toISOString();
  const { db } = await initializeProjectMemoryDatabase(cwd);
  try {
    const classification = classifyLibraryMemory({
      title: input.title,
      content: input.content,
      source: input.source,
      sourceType: input.sourceType,
      tags: input.tags
    });
    const zone = input.zone ?? classification.zone;
    const privacyLevel = input.privacyLevel ?? classification.privacyLevel;
    const title = input.title?.trim() || classification.summary.split(":")[0] || "Untitled memory";
    const privacy = applyLibraryWritePrivacyGate({
      title,
      content: input.content,
      summary: classification.summary,
      privacyLevel
    });
    const item: ProjectMemoryItem = {
      id: input.id ?? randomUUID(),
      zone,
      title: privacy.title,
      content: privacy.content,
      summary: privacy.summary,
      contentHash: hashMemoryContent(privacy.title, privacy.summary, privacy.content),
      source: input.source,
      sourceType: input.sourceType,
      tags: normalizeLibraryTags([...(input.tags ?? []), ...classification.tags, zone]),
      privacyLevel: privacy.privacyLevel,
      confidence: round(clamp01(input.confidence ?? classification.confidence)),
      importance: round(clamp01(input.importance ?? classification.importance)),
      createdAt: now,
      updatedAt: now,
      expiresAt: input.expiresAt,
      status: input.status ?? "active",
      reasons: [
        ...classification.reasons,
        privacy.rawContentBlocked ? "privacy: raw secret-like content was not stored" : "privacy: write gate passed"
      ]
    };

    insertProjectMemoryItem(db, item);
    appendProjectMemoryEvent(db, item.id, "created", {
      zone: item.zone,
      privacyLevel: item.privacyLevel,
      redacted: privacy.redacted,
      findings: privacy.findings
    });
    for (const event of privacy.events) {
      appendProjectMemoryEvent(db, item.id, event.eventType, event.payload);
    }
    return item;
  } finally {
    db.close();
  }
}

export async function updateProjectMemory(
  id: string,
  patch: Partial<AddProjectMemoryInput>,
  options: { cwd?: string; now?: Date } = {}
): Promise<ProjectMemoryItem> {
  const cwd = options.cwd ?? process.cwd();
  const now = (options.now ?? new Date()).toISOString();
  const { db } = await initializeProjectMemoryDatabase(cwd);
  try {
    const existing = getProjectMemoryItemSync(db, id);
    if (!existing) {
      throw new Error(`Project memory not found: ${id}`);
    }

    const mergedContent = patch.content ?? existing.content;
    const classification = classifyLibraryMemory({
      title: patch.title ?? existing.title,
      content: mergedContent,
      source: patch.source ?? existing.source,
      sourceType: patch.sourceType ?? existing.sourceType,
      tags: patch.tags ?? existing.tags
    });
    const privacy = applyLibraryWritePrivacyGate({
      title: patch.title ?? existing.title,
      content: mergedContent,
      summary: classification.summary,
      privacyLevel: patch.privacyLevel ?? existing.privacyLevel
    });
    const updated: ProjectMemoryItem = {
      ...existing,
      zone: patch.zone ?? existing.zone,
      title: privacy.title,
      content: privacy.content,
      summary: privacy.summary,
      contentHash: hashMemoryContent(privacy.title, privacy.summary, privacy.content),
      source: patch.source ?? existing.source,
      sourceType: patch.sourceType ?? existing.sourceType,
      tags: normalizeLibraryTags([...(patch.tags ?? existing.tags), patch.zone ?? existing.zone]),
      privacyLevel: privacy.privacyLevel,
      confidence: round(clamp01(patch.confidence ?? existing.confidence)),
      importance: round(clamp01(patch.importance ?? existing.importance)),
      updatedAt: now,
      expiresAt: patch.expiresAt ?? existing.expiresAt,
      status: patch.status ?? existing.status,
      reasons: [
        ...classification.reasons,
        privacy.rawContentBlocked ? "privacy: raw secret-like content was not stored" : "privacy: write gate passed"
      ]
    };

    updateProjectMemoryItemSync(db, updated);
    appendProjectMemoryEvent(db, id, "updated", { zone: updated.zone, privacyLevel: updated.privacyLevel, findings: privacy.findings });
    for (const event of privacy.events) {
      appendProjectMemoryEvent(db, id, event.eventType, event.payload);
    }
    return updated;
  } finally {
    db.close();
  }
}

export async function deleteProjectMemory(id: string, options: { cwd?: string } = {}): Promise<boolean> {
  const cwd = options.cwd ?? process.cwd();
  const { db } = await initializeProjectMemoryDatabase(cwd);
  try {
    const existing = getProjectMemoryItemSync(db, id);
    if (!existing) {
      return false;
    }
    appendProjectMemoryEvent(db, id, "deleted", { status: "deleted" });
    db.prepare("DELETE FROM memory_items WHERE id = ?").run(id);
    return true;
  } finally {
    db.close();
  }
}

export async function createShortMemoryNote(input: CreateShortMemoryNoteInput, options: { cwd?: string; now?: Date } = {}): Promise<ShortMemoryNote> {
  const cwd = options.cwd ?? process.cwd();
  const now = options.now ?? new Date();
  const priority = input.priority ?? "medium";
  await expireShortMemoryNotes({ cwd, now });
  const { db } = await initializeProjectMemoryDatabase(cwd);
  try {
    const classification = classifyLibraryMemory({
      title: input.title,
      content: input.content,
      source: input.source,
      sourceType: input.sourceType,
      tags: input.tags
    });
    const privacy = applyLibraryWritePrivacyGate({
      title: input.title,
      content: input.content,
      summary: createShortMemorySummary(input.title, input.content),
      privacyLevel: classification.privacyLevel
    });
    const blockedByPrivacy = privacy.privacyLevel === "do_not_prompt";
    const noteBase = {
      title: privacy.title,
      content: blockedByPrivacy ? "" : privacy.content,
      summary: privacy.summary,
      contentHash: hashMemoryContent(privacy.title, privacy.summary, blockedByPrivacy ? "" : privacy.content),
      priority,
      privacyLevel: privacy.privacyLevel,
      tags: normalizeLibraryTags([...(input.tags ?? []), ...classification.tags, "short-memory"]),
      source: input.source,
      sourceType: input.sourceType
    };
    const importanceScore = calculateShortMemoryImportance({
      priority,
      classification,
      content: `${input.title}\n${input.content}`,
      privacyLevel: privacy.privacyLevel
    });
    const promoteScore = calculateShortMemoryPromoteScore({
      priority,
      classification,
      content: `${input.title}\n${input.content}`,
      importanceScore,
      accessCount: 0,
      privacyLevel: privacy.privacyLevel
    });
    const note: ShortMemoryNote = {
      id: randomUUID(),
      ...noteBase,
      status: blockedByPrivacy ? "blocked_by_privacy" : "active",
      importanceScore,
      promoteScore,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: calculateShortMemoryExpiresAt(now, priority, input.ttl).toISOString(),
      accessCount: 0,
      reasons: [
        ...classification.reasons,
        `priority=${priority}`,
        `ttl=${priorityDefaultTtlHours(priority)}h default unless overridden`,
        privacy.rawContentBlocked ? "privacy: raw secret-like content was not stored" : "privacy: write gate passed",
        promoteScore >= SHORT_MEMORY_PROMOTE_SUGGEST_THRESHOLD ? "promotion: score reached suggestion threshold" : "promotion: temporary note"
      ]
    };

    insertShortMemoryNote(db, note);
    appendShortMemoryEvent(db, note.id, "created", {
      priority,
      privacyLevel: note.privacyLevel,
      promoteScore: note.promoteScore,
      redacted: privacy.redacted,
      findings: privacy.findings
    });
    for (const event of privacy.events) {
      appendShortMemoryEvent(db, note.id, event.eventType, event.payload);
    }
    if (note.promoteScore >= SHORT_MEMORY_PROMOTE_SUGGEST_THRESHOLD && note.status === "active") {
      appendShortMemoryEvent(db, note.id, "promotion_suggested", { promoteScore: note.promoteScore });
    }
    return note;
  } finally {
    db.close();
  }
}

export async function retrieveShortMemoryForTask(
  task: string,
  options: RetrieveShortMemoryOptions & { cwd?: string } = {}
): Promise<RetrieveShortMemoryResult> {
  const cwd = options.cwd ?? process.cwd();
  const now = options.now ?? new Date();
  await expireShortMemoryNotes({ cwd, now });
  const { db } = await initializeProjectMemoryDatabase(cwd);
  try {
    const rows = queryShortMemoryRows(db, task, {
      tags: options.tags,
      includeExpired: options.includeExpired,
      limit: MAX_CONTEXT_MEMORY_RECORDS + 1,
      now
    });
    requireCompleteMemoryScan(rows);
    const results: Array<ShortMemoryRetrievalNote & { rawScore: number }> = [];
    let filteredOut = 0;

    for (const row of rows) {
      const note = rowToShortMemoryNote(row);
      const privacy = filterLibraryMemoryForPrompt(
        {
          id: note.id,
          title: note.title,
          content: note.content,
          summary: note.summary,
          privacyLevel: note.privacyLevel
        },
        { privacyMode: options.privacyMode }
      );
      if (!privacy.allowed || !privacy.item) {
        filteredOut += 1;
        appendShortMemoryEvent(db, note.id, "blocked_by_privacy_gate", {
          phase: "retrieve",
          reason: privacy.reason,
          findings: privacy.findings
        });
        continue;
      }

      const score = scoreShortMemoryResult(note, task, Number(row.bm25 ?? 0), options.tags, now);
      if (score <= 0) {
        filteredOut += 1;
        continue;
      }

      updateShortMemoryAccess(db, note.id, now.toISOString());
      appendShortMemoryEvent(db, note.id, "retrieved", {
        query: redactText(task).slice(0, 160),
        score
      });
      results.push({
        id: note.id,
        title: privacy.item.title,
        summary: privacy.item.summary || createShortMemorySummary(note.title, note.content),
        tags: note.tags,
        priority: note.priority,
        expiresAt: note.expiresAt,
        reason: [
          `priority=${note.priority}`,
          `promote_score=${note.promoteScore}`,
          `privacy=${note.privacyLevel}:${privacy.mode}`,
          `score=${score}`
        ].join("; "),
        score,
        rawScore: score
      });
    }

    return {
      notes: results.sort((left, right) => right.rawScore - left.rawScore || left.id.localeCompare(right.id)).slice(0, options.limit ?? DEFAULT_SHORT_MEMORY_LIMIT).map(({ rawScore: _rawScore, ...note }) => note),
      filteredOut
    };
  } finally {
    db.close();
  }
}

export async function expireShortMemoryNotes(
  nowOrOptions: Date | { cwd?: string; now?: Date } = {}
): Promise<ShortMemoryExpirationResult> {
  const options = nowOrOptions instanceof Date ? { now: nowOrOptions } : nowOrOptions;
  const cwd = options.cwd ?? process.cwd();
  const now = options.now ?? new Date();
  const { db } = await initializeProjectMemoryDatabase(cwd);
  try {
    const rows = db.prepare("SELECT * FROM short_memory_notes WHERE status = 'active' AND expires_at <= ?").all(now.toISOString()) as unknown as ShortMemoryRow[];
    let expired = 0;
    let keptForPromotion = 0;
    for (const row of rows) {
      const note = rowToShortMemoryNote(row);
      db.prepare("UPDATE short_memory_notes SET status = 'expired', updated_at = ? WHERE id = ?").run(now.toISOString(), note.id);
      appendShortMemoryEvent(db, note.id, "expired", { promoteScore: note.promoteScore });
      expired += 1;
      if (note.promoteScore >= SHORT_MEMORY_PROMOTE_SUGGEST_THRESHOLD) {
        keptForPromotion += 1;
      }
    }
    return { expired, keptForPromotion };
  } finally {
    db.close();
  }
}

export async function cleanupShortMemoryNotes(
  options: { cwd?: string; now?: Date; deleteExpiredOlderThanHours?: number; dryRun?: boolean } = {}
): Promise<ShortMemoryCleanupResult> {
  const cwd = options.cwd ?? process.cwd();
  const now = options.now ?? new Date();
  const deleteExpiredOlderThanHours = options.deleteExpiredOlderThanHours ?? 24;
  await expireShortMemoryNotes({ cwd, now });
  const { db } = await initializeProjectMemoryDatabase(cwd);
  try {
    const cutoff = new Date(now.getTime() - deleteExpiredOlderThanHours * 3_600_000).toISOString();
    const rows = db.prepare("SELECT * FROM short_memory_notes WHERE status = 'expired' AND expires_at <= ?").all(cutoff) as unknown as ShortMemoryRow[];
    const candidateIds: string[] = [];
    let keptForPromotion = 0;

    for (const row of rows) {
      const note = rowToShortMemoryNote(row);
      if (note.promoteScore >= SHORT_MEMORY_PROMOTE_SUGGEST_THRESHOLD || note.promotedToLongMemoryId) {
        keptForPromotion += 1;
        continue;
      }
      candidateIds.push(note.id);
    }

    if (!options.dryRun) {
      for (const id of candidateIds) {
        appendShortMemoryEvent(db, id, "deleted", { reason: "expired_grace_period_elapsed" });
        db.prepare("DELETE FROM short_memory_notes WHERE id = ?").run(id);
      }
    }

    return {
      deleted: options.dryRun ? 0 : candidateIds.length,
      keptForPromotion,
      dryRun: Boolean(options.dryRun),
      candidateIds
    };
  } finally {
    db.close();
  }
}

export async function evaluateShortMemoryForPromotion(
  noteId: string,
  options: { cwd?: string; now?: Date } = {}
): Promise<ShortMemoryPromotionEvaluation> {
  const cwd = options.cwd ?? process.cwd();
  const { db } = await initializeProjectMemoryDatabase(cwd);
  try {
    const note = getShortMemoryNoteSync(db, noteId);
    if (!note) {
      throw new Error(`Short memory note not found: ${noteId}`);
    }
    const classification = classifyLibraryMemory({
      title: note.title,
      content: `${note.summary}\n${note.content}`,
      source: note.source,
      sourceType: note.sourceType,
      tags: note.tags
    });
    const promoteScore = calculateShortMemoryPromoteScore({
      priority: note.priority,
      classification,
      content: `${note.title}\n${note.summary}\n${note.content}`,
      importanceScore: note.importanceScore,
      accessCount: note.accessCount,
      privacyLevel: note.privacyLevel
    });
    const blocked = note.status === "blocked_by_privacy" || note.privacyLevel === "secret" || note.privacyLevel === "do_not_prompt";
    const reasons = [
      ...classification.reasons,
      `priority=${note.priority}`,
      `access_count=${note.accessCount}`,
      blocked ? "promotion blocked by privacy" : "promotion privacy check passed"
    ];
    db.prepare("UPDATE short_memory_notes SET promote_score = ?, reasons = ?, updated_at = ? WHERE id = ?").run(
      promoteScore,
      JSON.stringify(reasons),
      (options.now ?? new Date()).toISOString(),
      note.id
    );
    appendShortMemoryEvent(db, note.id, "promotion_evaluated", { promoteScore, blocked });
    return {
      noteId,
      promoteScore,
      shouldSuggest: !blocked && promoteScore >= SHORT_MEMORY_PROMOTE_SUGGEST_THRESHOLD,
      shouldAutoPromote: !blocked && promoteScore >= SHORT_MEMORY_AUTO_PROMOTE_THRESHOLD,
      blocked,
      reasons
    };
  } finally {
    db.close();
  }
}

export async function promoteShortMemoryToLongMemory(
  input: { noteId: string; reason?: string; force?: boolean },
  options: { cwd?: string; now?: Date } = {}
): Promise<PromoteShortMemoryResult> {
  const cwd = options.cwd ?? process.cwd();
  const now = options.now ?? new Date();
  const evaluation = await evaluateShortMemoryForPromotion(input.noteId, { cwd, now });
  const { target: databaseTarget, db: initialDb } = await initializeProjectMemoryDatabase(cwd);
  let refreshed: ShortMemoryNote;

  {
    const db = initialDb;
    try {
      const note = getShortMemoryNoteSync(db, input.noteId);
      if (!note) {
        throw new Error(`Short memory note not found: ${input.noteId}`);
      }
      refreshed = note;
      if (refreshed.privacyLevel === "secret" || refreshed.privacyLevel === "do_not_prompt" || refreshed.status === "blocked_by_privacy") {
        appendShortMemoryEvent(db, refreshed.id, "promotion_blocked", { reason: "privacy" });
        return { note: refreshed, promoted: false, reason: "Short memory privacy level blocks promotion." };
      }
      if (!input.force && evaluation.promoteScore < SHORT_MEMORY_PROMOTE_SUGGEST_THRESHOLD) {
        return { note: refreshed, promoted: false, reason: "Promote score below threshold." };
      }
    } finally {
      db.close();
    }
  }

  const durableContent = createDurableKnowledgeFromShortNote(refreshed, input.reason);
  const longMemory = await addProjectMemory(
    {
      title: `Short memory promoted: ${refreshed.title}`,
      content: durableContent,
      source: `short-memory:${refreshed.id}`,
      sourceType: "short_memory_promotion",
      tags: normalizeLibraryTags([...refreshed.tags, "promoted", "short-memory"]),
      importance: Math.max(0.75, evaluation.promoteScore),
      confidence: 0.72
    },
    { cwd, now }
  );

  const db = await openProjectMemoryDatabase(databaseTarget);
  try {
    db.prepare("UPDATE short_memory_notes SET status = 'promoted', promoted_to_long_memory_id = ?, updated_at = ? WHERE id = ?").run(
      longMemory.id,
      now.toISOString(),
      refreshed.id
    );
    appendShortMemoryEvent(db, refreshed.id, "promoted", {
      longMemoryId: longMemory.id,
      reason: redactText(input.reason ?? "promote score threshold met")
    });
    const updated = getShortMemoryNoteSync(db, refreshed.id) ?? { ...refreshed, status: "promoted" as const, promotedToLongMemoryId: longMemory.id };
    return { note: updated, longMemory, promoted: true, reason: "Short memory promoted to long memory." };
  } finally {
    db.close();
  }
}

export async function retrieveMemoryContextForTask(
  task: string,
  options: { cwd?: string; shortLimit?: number; longLimit?: number; privacyMode?: "safe" | "internal"; now?: Date } = {}
): Promise<MemoryContextForTaskResult> {
  const shortMemory = await retrieveShortMemoryForTask(task, {
    cwd: options.cwd,
    limit: options.shortLimit ?? DEFAULT_SHORT_MEMORY_LIMIT,
    privacyMode: options.privacyMode ?? "safe",
    now: options.now
  });
  const longMemory = await retrieveMemoryForTask(task, {
    cwd: options.cwd,
    limit: options.longLimit ?? DEFAULT_RETRIEVE_LIMIT,
    privacyMode: options.privacyMode ?? "safe",
    now: options.now
  });
  return {
    shortMemory: shortMemory.notes,
    longMemory,
    warnings: detectShortLongMemoryWarnings(shortMemory.notes, longMemory)
  };
}

export async function searchProjectMemory(
  query: string,
  options: ProjectMemorySearchOptions & { cwd?: string; preferredZones?: LibraryZone[] } = {}
): Promise<ProjectMemorySearchResult[]> {
  const cwd = options.cwd ?? process.cwd();
  const now = options.now ?? new Date();
  const { db } = await initializeProjectMemoryDatabase(cwd);
  try {
    const zones = options.zones ? uniqueZones(options.zones) : undefined;
    const rows = queryProjectMemoryRows(db, query, {
      zones,
      includeArchived: options.includeArchived,
      limit: MAX_CONTEXT_MEMORY_RECORDS + 1,
      now
    });
    requireCompleteMemoryScan(rows);
    const results: ProjectMemorySearchResult[] = [];
    for (const row of rows) {
      if (!isLibraryPrivacyLevel(row.privacy_level) || !isProjectMemoryStatus(row.status)) throw new Error("MEMORY_SOURCE_INVALID");
      const item = rowToProjectMemoryItem(row);
      // Compatibility search still permits explicitly entered manual lesson
      // notes; a review-backed candidate may never bypass a later rejection.
      if (item.sourceType === "lesson_candidate" || item.source?.startsWith("lesson_candidate:")) {
        if (!item.source?.startsWith("lesson_candidate:")) continue;
        const candidate = getLessonCandidateSync(db, item.source.slice("lesson_candidate:".length));
        if (!candidate || candidate.approvalStatus !== "approved" || candidate.privacyStatus !== "pass") continue;
      }
      const promptGate = filterLibraryMemoryForPrompt(item, { privacyMode: options.privacyMode });
      if (!promptGate.allowed || !promptGate.item) {
        appendProjectMemoryEvent(db, item.id, "blocked_by_privacy_gate", {
          phase: "retrieve",
          reason: promptGate.reason,
          findings: promptGate.findings
        });
        continue;
      }

      const score = scoreProjectMemoryResult(item, query, Number(row.bm25 ?? 0), options.preferredZones ?? zones, now);
      if (score <= 0) {
        continue;
      }
      updateLastAccessed(db, item.id, now.toISOString());
      appendProjectMemoryEvent(db, item.id, "retrieved", {
        mode: promptGate.mode,
        query: redactText(query).slice(0, 160)
      });
      results.push({
        item: promptGate.item,
        score,
        bm25: Number(row.bm25 ?? 0),
        mode: promptGate.mode === "raw" ? "raw" : "summary",
        why: [
          `zone=${item.zone}`,
          `privacy=${item.privacyLevel}:${promptGate.mode}`,
          ...item.reasons.slice(0, 4)
        ]
      });
    }

    return results.sort((left, right) => right.score - left.score || left.item.id.localeCompare(right.item.id)).slice(0, options.limit ?? DEFAULT_RETRIEVE_LIMIT);
  } finally {
    db.close();
  }
}

export async function retrieveMemoryForTask(
  task: string,
  options: RetrieveMemoryForTaskOptions & { cwd?: string } = {}
): Promise<ProjectMemorySearchResult[]> {
  const zones = suggestZonesForTask(task, options.zones);
  return searchProjectMemory(task, {
    ...options,
    zones,
    preferredZones: zones,
    limit: options.limit ?? DEFAULT_RETRIEVE_LIMIT,
    privacyMode: options.privacyMode ?? "safe"
  });
}

async function storeTaskObservation(
  input: TaskObservationInput,
  options: { cwd?: string; now?: Date } = {}
): Promise<TaskObservation> {
  const cwd = options.cwd ?? process.cwd();
  const now = (options.now ?? new Date()).toISOString();
  const observation = sanitizeTaskObservation(input, now);
  const { db } = await initializeProjectMemoryDatabase(cwd);
  try {
    db.prepare(`
      INSERT OR REPLACE INTO task_observations (
        id, task_title, task_summary, agent, files_touched, commands_run,
        tests, errors, decisions, outcome, privacy_scan_status, source_refs,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      observation.taskId,
      observation.taskTitle,
      observation.taskSummary ?? null,
      observation.agent ?? null,
      JSON.stringify(observation.filesTouched),
      JSON.stringify(observation.commandsRun),
      JSON.stringify(observation.tests),
      JSON.stringify(observation.errors),
      JSON.stringify(observation.decisions),
      observation.outcome,
      observation.privacyScanStatus,
      JSON.stringify(observation.sourceRefs),
      observation.createdAt
    );
    return observation;
  } finally {
    db.close();
  }
}

export async function proposeLessonCandidate(
  input: LessonProposalInput,
  options: { cwd?: string; now?: Date } = {}
): Promise<LessonProposalResult> {
  const cwd = options.cwd ?? process.cwd();
  const now = (options.now ?? new Date()).toISOString();
  const observation = await storeTaskObservation(input.observation, { cwd, now: options.now });
  const evidence = buildEvidence(observation, input.agentProposedLesson);
  const privacyStatus = strongestPrivacyStatus(observation.privacyScanStatus, privacyStatusForCandidate(input, evidence));
  const lesson = createCandidateLesson(observation, input.agentProposedLesson);
  const title = sanitizeText(input.title ?? observation.taskTitle, 120);
  const appliesTo = sanitizeStringList(input.appliesTo?.length ? input.appliesTo : [
    ...observation.filesTouched.map((file) => file.path),
    ...observation.sourceRefs.map((ref) => ref.ref)
  ], 20, 160);
  const confidence = scoreLessonCandidate({
    observation,
    evidence,
    privacyStatus,
    onlyAgentSummary: isOnlyAgentSummary(evidence)
  });
  const suggestedVerification = createSuggestedVerification(observation, confidence, privacyStatus, input.suggestedVerification);
  const verifyRequired = confidence < 0.8 || observation.outcome !== "pass" || !observation.tests.some((test) => test.status === "pass") || privacyStatus !== "pass";
  const approvalStatus: LessonApprovalStatus = privacyStatus === "blocked" || confidence < 0.2 ? "needs_review" : "pending";
  const candidate: LessonCandidate = {
    id: randomUUID(),
    taskId: observation.taskId,
    lessonType: input.lessonType ?? inferLessonType(observation, lesson),
    title,
    summary: sanitizeText(observation.taskSummary ?? observation.taskTitle, 500),
    lesson,
    appliesTo,
    sourceRefs: observation.sourceRefs,
    evidence,
    confidence,
    privacyStatus,
    approvalStatus,
    verifyRequired,
    suggestedVerification,
    lastVerifiedAt: null,
    createdAt: now,
    updatedAt: now
  };

  const { db } = await initializeProjectMemoryDatabase(cwd);
  try {
    insertLessonCandidateSync(db, candidate);
    appendProjectMemoryEvent(db, undefined, "lesson_candidate.created", {
      candidateId: candidate.id,
      taskId: candidate.taskId,
      privacyStatus: candidate.privacyStatus,
      approvalStatus: candidate.approvalStatus,
      confidence: candidate.confidence,
      evidence: candidate.evidence.map((entry) => ({ type: entry.type, ref: entry.ref }))
    });
    return { observation, candidate };
  } finally {
    db.close();
  }
}

export async function listLessonCandidates(
  options: LessonCandidateListOptions & { cwd?: string } = {}
): Promise<LessonCandidate[]> {
  const cwd = options.cwd ?? process.cwd();
  const { db } = await initializeProjectMemoryDatabase(cwd);
  try {
    const where: string[] = [];
    const params: SqliteValue[] = [];
    if (options.approvalStatus) {
      where.push("approval_status = ?");
      params.push(options.approvalStatus);
    }
    if (options.privacyStatus) {
      where.push("privacy_status = ?");
      params.push(options.privacyStatus);
    }
    params.push(options.limit ?? 20);
    const rows = db.prepare(`
      SELECT * FROM lesson_candidates
      ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY created_at DESC
      LIMIT ?
    `).all(...params) as unknown as LessonCandidateRow[];
    return rows.map(rowToLessonCandidate);
  } finally {
    db.close();
  }
}

export async function getLessonCandidate(
  id: string,
  options: { cwd?: string } = {}
): Promise<LessonCandidate | undefined> {
  const cwd = options.cwd ?? process.cwd();
  const { db } = await initializeProjectMemoryDatabase(cwd);
  try {
    return getLessonCandidateSync(db, id);
  } finally {
    db.close();
  }
}

export async function approveLessonCandidate(
  id: string,
  options: { cwd?: string; now?: Date } = {}
): Promise<{ candidate: LessonCandidate; memory: ProjectMemoryItem }> {
  const cwd = options.cwd ?? process.cwd();
  const now = (options.now ?? new Date()).toISOString();
  const { target: databaseTarget, db } = await initializeProjectMemoryDatabase(cwd);
  try {
    const candidate = getLessonCandidateSync(db, id);
    if (!candidate) {
      throw new Error(`Lesson candidate not found: ${id}`);
    }
    const existingMemory = getProjectMemoryItemBySourceSync(db, `lesson_candidate:${candidate.id}`);
    if (candidate.approvalStatus === "approved" && existingMemory) {
      return { candidate, memory: existingMemory };
    }
    assertCandidateCanBeApproved(candidate);
  } finally {
    db.close();
  }

  const candidate = await getLessonCandidate(id, { cwd });
  if (!candidate) {
    throw new Error(`Lesson candidate not found: ${id}`);
  }
  const memory = await addProjectMemory(
    {
      title: candidate.title,
      content: lessonCandidateToMemoryContent(candidate),
      source: `lesson_candidate:${candidate.id}`,
      sourceType: "lesson_candidate",
      tags: normalizeLibraryTags(["lesson", "approved", candidate.lessonType, ...candidate.appliesTo.flatMap((value) => tokenizeMemoryText(value).slice(0, 2))]),
      zone: "lesson",
      privacyLevel: candidate.privacyStatus === "pass" ? "internal" : "private",
      confidence: candidate.confidence,
      importance: candidate.confidence >= 0.8 ? 0.9 : 0.75
    },
    { cwd, now: options.now }
  );

  const updateDb = await openProjectMemoryDatabase(databaseTarget);
  try {
    updateDb.prepare(`
      UPDATE lesson_candidates
      SET approval_status = 'approved',
          updated_at = ?
      WHERE id = ?
    `).run(now, candidate.id);
    appendProjectMemoryEvent(updateDb, memory.id, "lesson_candidate.approved", {
      candidateId: candidate.id,
      confidence: candidate.confidence,
      privacyStatus: candidate.privacyStatus
    });
    const approved = getLessonCandidateSync(updateDb, id);
    if (!approved) {
      throw new Error(`Lesson candidate not found after approval: ${id}`);
    }
    return { candidate: approved, memory };
  } finally {
    updateDb.close();
  }
}

export async function rejectLessonCandidate(
  id: string,
  options: { cwd?: string; now?: Date } = {}
): Promise<LessonCandidate> {
  const cwd = options.cwd ?? process.cwd();
  const now = (options.now ?? new Date()).toISOString();
  const { db } = await initializeProjectMemoryDatabase(cwd);
  try {
    const candidate = getLessonCandidateSync(db, id);
    if (!candidate) {
      throw new Error(`Lesson candidate not found: ${id}`);
    }
    db.prepare(`
      UPDATE lesson_candidates
      SET approval_status = 'rejected',
          updated_at = ?
      WHERE id = ?
    `).run(now, id);
    appendProjectMemoryEvent(db, undefined, "lesson_candidate.rejected", { candidateId: id });
    const rejected = getLessonCandidateSync(db, id);
    if (!rejected) {
      throw new Error(`Lesson candidate not found after rejection: ${id}`);
    }
    return rejected;
  } finally {
    db.close();
  }
}

export async function getLessonCandidateReviewSummary(options: { cwd?: string } = {}): Promise<LessonCandidateReviewSummary> {
  const cwd = options.cwd ?? process.cwd();
  const candidates = await listLessonCandidates({ cwd, limit: 500 });
  return {
    total: candidates.length,
    pending: candidates.filter((candidate) => candidate.approvalStatus === "pending").length,
    needsReview: candidates.filter((candidate) => candidate.approvalStatus === "needs_review").length,
    privacyWarnings: candidates.filter((candidate) => candidate.privacyStatus !== "pass").length,
    missingEvidence: candidates.filter((candidate) => candidate.evidence.length === 0).length,
    highConfidencePending: candidates.filter((candidate) => candidate.confidence >= 0.8 && candidate.approvalStatus === "pending").length
  };
}

export async function getProjectMemoryStats(options: { cwd?: string } = {}): Promise<ProjectMemoryStats> {
  const cwd = options.cwd ?? process.cwd();
  const { db } = await initializeProjectMemoryDatabase(cwd);
  try {
    const rows = db.prepare("SELECT zone, privacy_level, status, COUNT(*) AS total FROM memory_items GROUP BY zone, privacy_level, status").all() as Array<{
      zone: string;
      privacy_level: string;
      status: string;
      total: number;
    }>;
    const stats = createEmptyStats();
    for (const row of rows) {
      const total = Number(row.total);
      stats.total += total;
      if (isLibraryZone(row.zone)) {
        stats.byZone[row.zone] += total;
      }
      if (isLibraryPrivacyLevel(row.privacy_level)) {
        stats.byPrivacyLevel[row.privacy_level] += total;
      }
      if (isProjectMemoryStatus(row.status)) {
        stats.byStatus[row.status] += total;
      }
    }
    return stats;
  } finally {
    db.close();
  }
}

export async function checkProjectMemoryPrivacy(options: { cwd?: string } = {}): Promise<ProjectMemoryPrivacyFinding[]> {
  const cwd = options.cwd ?? process.cwd();
  const { db } = await initializeProjectMemoryDatabase(cwd);
  try {
    const rows = db.prepare("SELECT * FROM memory_items WHERE status != 'deleted'").all() as unknown as ProjectMemoryRow[];
    const findings: ProjectMemoryPrivacyFinding[] = [];
    for (const row of rows) {
      const item = rowToProjectMemoryItem(row);
      const detected = detectLibraryPrivacyFindings(`${item.title}\n${item.content}\n${item.summary}`);
      if (detected.length > 0 && item.privacyLevel !== "secret" && item.privacyLevel !== "do_not_prompt") {
        findings.push({
          id: item.id,
          title: redactText(item.title),
          zone: item.zone,
          privacyLevel: item.privacyLevel,
          issue: `secret-like pattern(s) detected: ${detected.join(", ")}`,
          recommendation: "Update this memory to secret or do_not_prompt and keep only a redacted summary."
        });
      }
    }
    return findings;
  } finally {
    db.close();
  }
}

export async function migrateJsonMemoryToProjectMemory(
  options: { cwd?: string; now?: Date; dryRun?: boolean } = {}
): Promise<{ imported: number; skipped: number; blocked: number; dryRun: boolean; warnings: string[] }> {
  const cwd = options.cwd ?? process.cwd();
  // The SQLite model cannot losslessly represent legacy project scope, prompt
  // policy, provenance, lifecycle and lesson review. Inventory only until the
  // dedicated migration contract is implemented; never silently downgrade data.
  const files = [
    path.resolve(cwd, ".lmti", "memory", "long-term.json"),
    path.resolve(cwd, ".lmti", "memory", "lessons.json"),
    path.resolve(cwd, ".lmti", "memory", "short-term.json")
  ];
  let blocked = 0;

  for (const file of files) {
    let raw: string;
    try {
      const checked = await checkedMemoryFile(cwd, path.basename(file), 16 * 1024 * 1024);
      if (!checked) continue;
      const handle = await fs.open(checked, "r");
      try {
        const maxBytes = 16 * 1024 * 1024;
        if ((await handle.stat()).size > maxBytes) {
          throw new Error("LEGACY_MEMORY_INVALID: input exceeds the migration inventory limit.");
        }
        // Bound allocation/read even if another process grows the file after stat.
        const bytes = Buffer.alloc(maxBytes + 1);
        let length = 0;
        while (length < bytes.length) {
          const result = await handle.read(bytes, length, bytes.length - length, null);
          if (result.bytesRead === 0) break;
          length += result.bytesRead;
        }
        if (length > maxBytes) {
          throw new Error("LEGACY_MEMORY_INVALID: input exceeds the migration inventory limit.");
        }
        raw = bytes.subarray(0, length).toString("utf8");
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      if (error instanceof Error && error.message.startsWith("LEGACY_MEMORY_INVALID:")) throw error;
      throw new Error("LEGACY_MEMORY_INVALID: cannot read migration input.");
    }
    let records: unknown;
    try {
      records = JSON.parse(raw);
    } catch {
      throw new Error("LEGACY_MEMORY_INVALID: migration input must be a JSON array.");
    }
    if (!Array.isArray(records) || records.length > 10_000 ||
        records.some((record) => record === null || typeof record !== "object" || Array.isArray(record))) {
      throw new Error("LEGACY_MEMORY_INVALID: migration input must be a bounded array of records.");
    }
    blocked += records.length;
  }

  if (blocked > 0 && !options.dryRun) {
    throw new Error("LEGACY_MEMORY_MIGRATION_BLOCKED: lossless policy, provenance and lifecycle mapping is required. Use --dry-run for inventory; keep the original stores.");
  }
  return {
    imported: 0,
    skipped: 0,
    blocked,
    dryRun: Boolean(options.dryRun),
    warnings: blocked > 0 ? ["Legacy import writes are blocked pending a lossless reviewed migration."] : []
  };
}

function projectMemorySchemaVersion(db: DatabaseSync): number {
  const migrations = db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'memory_migrations'").get();
  if (!migrations) return 0;
  const row = db.prepare("SELECT MAX(version) AS version FROM memory_migrations").get() as { version: unknown };
  const version = row.version ?? 0;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 0 || version > SCHEMA_VERSION) {
    throw new Error("MEMORY_SCHEMA_UNSUPPORTED");
  }
  return version;
}

function applyProjectMemorySchema(db: DatabaseSync): void {
  const currentVersion = projectMemorySchemaVersion(db);
  db.exec("PRAGMA journal_mode = WAL;");
  if (currentVersion === SCHEMA_VERSION) return;

  db.exec("BEGIN IMMEDIATE;");
  try {
    // A different writer may have completed the migration while we waited.
    const version = projectMemorySchemaVersion(db);
    if (version === SCHEMA_VERSION) {
      db.exec("COMMIT;");
      return;
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memory_items (
        id TEXT PRIMARY KEY,
        zone TEXT NOT NULL CHECK (zone IN ('architecture','codebase','workflow','deployment','security','decision','lesson','incident','customer','business','prompting','unknown')),
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        summary TEXT NOT NULL,
        content_hash TEXT NOT NULL DEFAULT '',
        source TEXT,
        source_type TEXT,
        tags TEXT NOT NULL DEFAULT '[]',
        privacy_level TEXT NOT NULL CHECK (privacy_level IN ('public','internal','private','secret','do_not_prompt')),
        confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
        importance REAL NOT NULL CHECK (importance >= 0 AND importance <= 1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_accessed_at TEXT,
        expires_at TEXT,
        status TEXT NOT NULL CHECK (status IN ('active','archived','superseded','deleted')),
        reasons TEXT NOT NULL DEFAULT '[]'
      );

      CREATE INDEX IF NOT EXISTS idx_memory_items_zone ON memory_items(zone);
      CREATE INDEX IF NOT EXISTS idx_memory_items_privacy ON memory_items(privacy_level);
      CREATE INDEX IF NOT EXISTS idx_memory_items_status ON memory_items(status);
      CREATE INDEX IF NOT EXISTS idx_memory_items_source ON memory_items(source);

      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
        title,
        summary,
        content,
        tags,
        content='memory_items',
        content_rowid='rowid'
      );

      CREATE TRIGGER IF NOT EXISTS memory_items_ai AFTER INSERT ON memory_items BEGIN
        INSERT INTO memory_fts(rowid, title, summary, content, tags)
        VALUES (new.rowid, new.title, new.summary, new.content, new.tags);
      END;

      CREATE TRIGGER IF NOT EXISTS memory_items_ad AFTER DELETE ON memory_items BEGIN
        INSERT INTO memory_fts(memory_fts, rowid, title, summary, content, tags)
        VALUES ('delete', old.rowid, old.title, old.summary, old.content, old.tags);
      END;

      CREATE TRIGGER IF NOT EXISTS memory_items_au AFTER UPDATE ON memory_items BEGIN
        INSERT INTO memory_fts(memory_fts, rowid, title, summary, content, tags)
        VALUES ('delete', old.rowid, old.title, old.summary, old.content, old.tags);
        INSERT INTO memory_fts(rowid, title, summary, content, tags)
        VALUES (new.rowid, new.title, new.summary, new.content, new.tags);
      END;

      CREATE TABLE IF NOT EXISTS memory_links (
        id TEXT PRIMARY KEY,
        from_memory_id TEXT NOT NULL,
        to_memory_id TEXT NOT NULL,
        relation_type TEXT NOT NULL CHECK (relation_type IN ('related_to','caused_by','fixes','supersedes','depends_on','contradicts')),
        created_at TEXT NOT NULL,
        UNIQUE(from_memory_id, to_memory_id, relation_type),
        FOREIGN KEY (from_memory_id) REFERENCES memory_items(id) ON DELETE CASCADE,
        FOREIGN KEY (to_memory_id) REFERENCES memory_items(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS memory_events (
        id TEXT PRIMARY KEY,
        memory_id TEXT,
        event_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (memory_id) REFERENCES memory_items(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS short_memory_notes (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        summary TEXT,
        content_hash TEXT NOT NULL DEFAULT '',
        source TEXT,
        source_type TEXT,
        tags TEXT NOT NULL DEFAULT '[]',
        priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','critical')),
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired','deleted','promoted','blocked_by_privacy')),
        privacy_level TEXT NOT NULL DEFAULT 'internal' CHECK (privacy_level IN ('public','internal','private','secret','do_not_prompt')),
        importance_score REAL NOT NULL DEFAULT 0 CHECK (importance_score >= 0 AND importance_score <= 1),
        promote_score REAL NOT NULL DEFAULT 0 CHECK (promote_score >= 0 AND promote_score <= 1),
        promoted_to_long_memory_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        last_accessed_at TEXT,
        access_count INTEGER NOT NULL DEFAULT 0,
        reasons TEXT NOT NULL DEFAULT '[]',
        FOREIGN KEY (promoted_to_long_memory_id) REFERENCES memory_items(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_short_memory_status ON short_memory_notes(status);
      CREATE INDEX IF NOT EXISTS idx_short_memory_priority ON short_memory_notes(priority);
      CREATE INDEX IF NOT EXISTS idx_short_memory_expires ON short_memory_notes(expires_at);
      CREATE INDEX IF NOT EXISTS idx_short_memory_promote_score ON short_memory_notes(promote_score);

      CREATE VIRTUAL TABLE IF NOT EXISTS short_memory_notes_fts USING fts5(
        title,
        summary,
        content,
        tags,
        content='short_memory_notes',
        content_rowid='rowid'
      );

      CREATE TRIGGER IF NOT EXISTS short_memory_notes_ai AFTER INSERT ON short_memory_notes BEGIN
        INSERT INTO short_memory_notes_fts(rowid, title, summary, content, tags)
        VALUES (new.rowid, new.title, COALESCE(new.summary, ''), new.content, new.tags);
      END;

      CREATE TRIGGER IF NOT EXISTS short_memory_notes_ad AFTER DELETE ON short_memory_notes BEGIN
        INSERT INTO short_memory_notes_fts(short_memory_notes_fts, rowid, title, summary, content, tags)
        VALUES ('delete', old.rowid, old.title, COALESCE(old.summary, ''), old.content, old.tags);
      END;

      CREATE TRIGGER IF NOT EXISTS short_memory_notes_au AFTER UPDATE ON short_memory_notes BEGIN
        INSERT INTO short_memory_notes_fts(short_memory_notes_fts, rowid, title, summary, content, tags)
        VALUES ('delete', old.rowid, old.title, COALESCE(old.summary, ''), old.content, old.tags);
        INSERT INTO short_memory_notes_fts(rowid, title, summary, content, tags)
        VALUES (new.rowid, new.title, COALESCE(new.summary, ''), new.content, new.tags);
      END;

      CREATE TABLE IF NOT EXISTS short_memory_events (
        id TEXT PRIMARY KEY,
        note_id TEXT,
        event_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (note_id) REFERENCES short_memory_notes(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS task_observations (
        id TEXT PRIMARY KEY,
        task_title TEXT NOT NULL,
        task_summary TEXT,
        agent TEXT,
        files_touched TEXT NOT NULL DEFAULT '[]',
        commands_run TEXT NOT NULL DEFAULT '[]',
        tests TEXT NOT NULL DEFAULT '[]',
        errors TEXT NOT NULL DEFAULT '[]',
        decisions TEXT NOT NULL DEFAULT '[]',
        outcome TEXT NOT NULL CHECK (outcome IN ('pass','fail','partial','unknown')),
        privacy_scan_status TEXT NOT NULL CHECK (privacy_scan_status IN ('pass','warning','blocked')),
        source_refs TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS lesson_candidates (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        lesson_type TEXT NOT NULL CHECK (lesson_type IN ('bug_fix','architecture','security','testing','deployment','workflow','permission','data_model','cli','other')),
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        lesson TEXT NOT NULL,
        applies_to TEXT NOT NULL DEFAULT '[]',
        source_refs TEXT NOT NULL DEFAULT '[]',
        evidence TEXT NOT NULL DEFAULT '[]',
        confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
        privacy_status TEXT NOT NULL CHECK (privacy_status IN ('pass','warning','blocked')),
        approval_status TEXT NOT NULL CHECK (approval_status IN ('pending','approved','rejected','needs_review')),
        verify_required INTEGER NOT NULL DEFAULT 1,
        suggested_verification TEXT NOT NULL DEFAULT '[]',
        last_verified_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES task_observations(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_lesson_candidates_approval ON lesson_candidates(approval_status);
      CREATE INDEX IF NOT EXISTS idx_lesson_candidates_privacy ON lesson_candidates(privacy_status);
      CREATE INDEX IF NOT EXISTS idx_lesson_candidates_task ON lesson_candidates(task_id);
    `);
    db.prepare("INSERT OR IGNORE INTO memory_migrations(version, name, applied_at) VALUES (?, ?, ?)").run(
      1,
      "project_operating_memory_sqlite_fts5",
      new Date().toISOString()
    );
    db.prepare("INSERT OR IGNORE INTO memory_migrations(version, name, applied_at) VALUES (?, ?, ?)").run(
      2,
      "short_memory_notes_sqlite_fts5",
      new Date().toISOString()
    );
    if (version < 3) applyContentHashMigration(db);
    db.prepare("INSERT OR IGNORE INTO memory_migrations(version, name, applied_at) VALUES (?, ?, ?)").run(
      3,
      "memory_content_hashes",
      new Date().toISOString()
    );
    db.prepare("INSERT OR IGNORE INTO memory_migrations(version, name, applied_at) VALUES (?, ?, ?)").run(
      4,
      "lesson_proposal_pipeline",
      new Date().toISOString()
    );
    db.exec("COMMIT;");
  } catch (error) {
    try { db.exec("ROLLBACK;"); } catch { /* preserve the migration failure */ }
    throw error;
  }
}

function applyContentHashMigration(db: DatabaseSync): void {
  if (!sqliteColumnExists(db, "memory_items", "content_hash")) {
    db.exec("ALTER TABLE memory_items ADD COLUMN content_hash TEXT NOT NULL DEFAULT '';");
  }
  if (!sqliteColumnExists(db, "short_memory_notes", "content_hash")) {
    db.exec("ALTER TABLE short_memory_notes ADD COLUMN content_hash TEXT NOT NULL DEFAULT '';");
  }

  const memoryRows = db.prepare("SELECT id, title, summary, content FROM memory_items WHERE content_hash = ''").all() as Array<{
    id: string;
    title: string;
    summary: string;
    content: string;
  }>;
  for (const row of memoryRows) {
    db.prepare("UPDATE memory_items SET content_hash = ? WHERE id = ?").run(
      hashMemoryContent(row.title, row.summary, row.content),
      row.id
    );
  }

  const shortRows = db.prepare("SELECT id, title, summary, content FROM short_memory_notes WHERE content_hash = ''").all() as Array<{
    id: string;
    title: string;
    summary: string | null;
    content: string;
  }>;
  for (const row of shortRows) {
    db.prepare("UPDATE short_memory_notes SET content_hash = ? WHERE id = ?").run(
      hashMemoryContent(row.title, row.summary ?? "", row.content),
      row.id
    );
  }
}

function sqliteColumnExists(db: DatabaseSync, tableName: string, columnName: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === columnName);
}

function insertProjectMemoryItem(db: DatabaseSync, item: ProjectMemoryItem): void {
  db.prepare(`
    INSERT INTO memory_items (
      id, zone, title, content, summary, source, source_type, tags, privacy_level,
      confidence, importance, created_at, updated_at, last_accessed_at, expires_at, status, reasons, content_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(...itemToSqliteValues(item));
}

function updateProjectMemoryItemSync(db: DatabaseSync, item: ProjectMemoryItem): void {
  db.prepare(`
    UPDATE memory_items SET
      zone = ?,
      title = ?,
      content = ?,
      summary = ?,
      source = ?,
      source_type = ?,
      tags = ?,
      privacy_level = ?,
      confidence = ?,
      importance = ?,
      updated_at = ?,
      expires_at = ?,
      status = ?,
      reasons = ?,
      content_hash = ?
    WHERE id = ?
  `).run(
    item.zone,
    item.title,
    item.content,
    item.summary,
    item.source ?? null,
    item.sourceType ?? null,
    JSON.stringify(item.tags),
    item.privacyLevel,
    item.confidence,
    item.importance,
    item.updatedAt,
    item.expiresAt ?? null,
    item.status,
    JSON.stringify(item.reasons),
    item.contentHash,
    item.id
  );
}

function insertShortMemoryNote(db: DatabaseSync, note: ShortMemoryNote): void {
  db.prepare(`
    INSERT INTO short_memory_notes (
      id, title, content, summary, source, source_type, tags, priority, status,
      privacy_level, importance_score, promote_score, promoted_to_long_memory_id,
      created_at, updated_at, expires_at, last_accessed_at, access_count, reasons, content_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    note.id,
    note.title,
    note.content,
    note.summary,
    note.source ?? null,
    note.sourceType ?? null,
    JSON.stringify(note.tags),
    note.priority,
    note.status,
    note.privacyLevel,
    note.importanceScore,
    note.promoteScore,
    note.promotedToLongMemoryId ?? null,
    note.createdAt,
    note.updatedAt,
    note.expiresAt,
    note.lastAccessedAt ?? null,
    note.accessCount,
    JSON.stringify(note.reasons),
    note.contentHash
  );
}

function getProjectMemoryItemSync(db: DatabaseSync, id: string): ProjectMemoryItem | undefined {
  const row = db.prepare("SELECT * FROM memory_items WHERE id = ?").get(id) as unknown as ProjectMemoryRow | undefined;
  return row ? rowToProjectMemoryItem(row) : undefined;
}

function getProjectMemoryItemBySourceSync(db: DatabaseSync, source: string): ProjectMemoryItem | undefined {
  const row = db.prepare("SELECT * FROM memory_items WHERE source = ? AND status != 'deleted' LIMIT 1").get(source) as unknown as ProjectMemoryRow | undefined;
  return row ? rowToProjectMemoryItem(row) : undefined;
}

function getShortMemoryNoteSync(db: DatabaseSync, id: string): ShortMemoryNote | undefined {
  const row = db.prepare("SELECT * FROM short_memory_notes WHERE id = ?").get(id) as unknown as ShortMemoryRow | undefined;
  return row ? rowToShortMemoryNote(row) : undefined;
}

function queryProjectMemoryRows(
  db: DatabaseSync,
  query: string,
  options: { zones?: LibraryZone[]; includeArchived?: boolean; limit: number; now: Date }
): ProjectMemoryRow[] {
  const ftsQuery = buildFtsQuery(query);
  if (!ftsQuery) {
    return listProjectMemoryRows(db, options);
  }

  const statusSql = options.includeArchived ? "i.status != 'deleted'" : "i.status = 'active'";
  const zoneSql = options.zones && options.zones.length > 0 ? `AND i.zone IN (${options.zones.map(() => "?").join(", ")})` : "";
  const params: SqliteValue[] = [ftsQuery, options.now.toISOString(), ...(options.zones ?? []), options.limit];
  try {
    return db.prepare(`
      SELECT i.*, bm25(memory_fts) AS bm25
      FROM memory_fts
      JOIN memory_items i ON i.rowid = memory_fts.rowid
      WHERE memory_fts MATCH ?
        AND ${statusSql}
        AND (i.expires_at IS NULL OR i.expires_at > ?)
        ${zoneSql}
      ORDER BY bm25(memory_fts)
      LIMIT ?
    `).all(...params) as unknown as ProjectMemoryRow[];
  } catch {
    return fallbackLikeRows(db, query, options);
  }
}

function listProjectMemoryRows(
  db: DatabaseSync,
  options: { zones?: LibraryZone[]; includeArchived?: boolean; limit: number; now: Date }
): ProjectMemoryRow[] {
  const statusSql = options.includeArchived ? "status != 'deleted'" : "status = 'active'";
  const zoneSql = options.zones && options.zones.length > 0 ? `AND zone IN (${options.zones.map(() => "?").join(", ")})` : "";
  const params: SqliteValue[] = [options.now.toISOString(), ...(options.zones ?? []), options.limit];
  return db.prepare(`
    SELECT *, 0 AS bm25
    FROM memory_items
    WHERE ${statusSql}
      AND (expires_at IS NULL OR expires_at > ?)
      ${zoneSql}
    ORDER BY importance DESC, updated_at DESC
    LIMIT ?
  `).all(...params) as unknown as ProjectMemoryRow[];
}

function fallbackLikeRows(
  db: DatabaseSync,
  query: string,
  options: { zones?: LibraryZone[]; includeArchived?: boolean; limit: number; now: Date }
): ProjectMemoryRow[] {
  const tokens = tokenizeMemoryText(query).slice(0, 8);
  if (tokens.length === 0) {
    return listProjectMemoryRows(db, options);
  }
  const likeSql = tokens.map(() => "(title LIKE ? OR summary LIKE ? OR content LIKE ? OR tags LIKE ?)").join(" OR ");
  const statusSql = options.includeArchived ? "status != 'deleted'" : "status = 'active'";
  const zoneSql = options.zones && options.zones.length > 0 ? `AND zone IN (${options.zones.map(() => "?").join(", ")})` : "";
  const likeParams = tokens.flatMap((token) => {
    const value = `%${token}%`;
    return [value, value, value, value];
  });
  return db.prepare(`
    SELECT *, 0 AS bm25
    FROM memory_items
    WHERE ${statusSql}
      AND (expires_at IS NULL OR expires_at > ?)
      AND (${likeSql})
      ${zoneSql}
    ORDER BY importance DESC, updated_at DESC
    LIMIT ?
  `).all(options.now.toISOString(), ...likeParams, ...(options.zones ?? []), options.limit) as unknown as ProjectMemoryRow[];
}

function queryShortMemoryRows(
  db: DatabaseSync,
  query: string,
  options: { tags?: string[]; includeExpired?: boolean; limit: number; now: Date }
): ShortMemoryRow[] {
  const ftsQuery = buildFtsQuery(query);
  if (!ftsQuery) {
    return listShortMemoryRows(db, options);
  }

  const statusSql = options.includeExpired ? "n.status IN ('active','expired')" : "n.status = 'active' AND n.expires_at > ?";
  const tagSql = options.tags && options.tags.length > 0 ? `AND (${options.tags.map(() => "n.tags LIKE ?").join(" OR ")})` : "";
  const params: SqliteValue[] = options.includeExpired ? [ftsQuery, ...tagLikeParams(options.tags), options.limit] : [ftsQuery, options.now.toISOString(), ...tagLikeParams(options.tags), options.limit];
  try {
    return db.prepare(`
      SELECT n.*, bm25(short_memory_notes_fts) AS bm25
      FROM short_memory_notes_fts
      JOIN short_memory_notes n ON n.rowid = short_memory_notes_fts.rowid
      WHERE short_memory_notes_fts MATCH ?
        AND ${statusSql}
        ${tagSql}
        AND n.status NOT IN ('deleted','blocked_by_privacy','promoted')
      ORDER BY bm25(short_memory_notes_fts)
      LIMIT ?
    `).all(...params) as unknown as ShortMemoryRow[];
  } catch {
    return fallbackShortLikeRows(db, query, options);
  }
}

function listShortMemoryRows(
  db: DatabaseSync,
  options: { tags?: string[]; includeExpired?: boolean; limit: number; now: Date }
): ShortMemoryRow[] {
  const statusSql = options.includeExpired ? "status IN ('active','expired')" : "status = 'active' AND expires_at > ?";
  const tagSql = options.tags && options.tags.length > 0 ? `AND (${options.tags.map(() => "tags LIKE ?").join(" OR ")})` : "";
  const params: SqliteValue[] = options.includeExpired ? [...tagLikeParams(options.tags), options.limit] : [options.now.toISOString(), ...tagLikeParams(options.tags), options.limit];
  return db.prepare(`
    SELECT *, 0 AS bm25
    FROM short_memory_notes
    WHERE ${statusSql}
      ${tagSql}
      AND status NOT IN ('deleted','blocked_by_privacy','promoted')
    ORDER BY
      CASE priority WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC,
      updated_at DESC
    LIMIT ?
  `).all(...params) as unknown as ShortMemoryRow[];
}

function fallbackShortLikeRows(
  db: DatabaseSync,
  query: string,
  options: { tags?: string[]; includeExpired?: boolean; limit: number; now: Date }
): ShortMemoryRow[] {
  const tokens = tokenizeMemoryText(query).slice(0, 8);
  if (tokens.length === 0) {
    return listShortMemoryRows(db, options);
  }
  const likeSql = tokens.map(() => "(title LIKE ? OR summary LIKE ? OR content LIKE ? OR tags LIKE ?)").join(" OR ");
  const statusSql = options.includeExpired ? "status IN ('active','expired')" : "status = 'active' AND expires_at > ?";
  const tagSql = options.tags && options.tags.length > 0 ? `AND (${options.tags.map(() => "tags LIKE ?").join(" OR ")})` : "";
  const likeParams = tokens.flatMap((token) => {
    const value = `%${token}%`;
    return [value, value, value, value];
  });
  const params: SqliteValue[] = options.includeExpired
    ? [...likeParams, ...tagLikeParams(options.tags), options.limit]
    : [options.now.toISOString(), ...likeParams, ...tagLikeParams(options.tags), options.limit];
  return db.prepare(`
    SELECT *, 0 AS bm25
    FROM short_memory_notes
    WHERE ${statusSql}
      AND (${likeSql})
      ${tagSql}
      AND status NOT IN ('deleted','blocked_by_privacy','promoted')
    ORDER BY
      CASE priority WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC,
      updated_at DESC
    LIMIT ?
  `).all(...params) as unknown as ShortMemoryRow[];
}

function scoreProjectMemoryResult(item: ProjectMemoryItem, query: string, bm25: number, preferredZones: LibraryZone[] | undefined, now: Date): number {
  const corpus = normalizeMemoryText([item.title, item.summary, item.content, item.zone, ...item.tags].join(" "));
  const tokens = tokenizeMemoryText(query);
  const lexical = tokens.reduce((score, token) => score + (corpus.includes(token) ? (token.length > 3 ? 1.2 : 0.8) : 0), 0);
  const zoneBonus = preferredZones?.includes(item.zone) ? 2.4 : 0;
  const bm25Score = Math.max(0, -bm25);
  const recency = recencyScore(item.updatedAt, now);
  const privacyPenalty = item.privacyLevel === "private" ? 0.4 : 0;
  const noisePenalty = noisyMemoryPenalty(query, corpus);
  return round(Math.max(0, bm25Score + lexical + zoneBonus + item.importance * 3 + item.confidence * 1.5 + recency - privacyPenalty - noisePenalty));
}

function scoreShortMemoryResult(note: ShortMemoryNote, query: string, bm25: number, requestedTags: string[] | undefined, now: Date): number {
  const corpus = normalizeMemoryText([note.title, note.summary, note.content, ...note.tags].join(" "));
  const tokens = tokenizeMemoryText(query);
  const lexical = tokens.reduce((score, token) => score + (corpus.includes(token) ? (token.length > 3 ? 1.2 : 0.8) : 0), 0);
  const bm25Score = Math.max(0, -bm25);
  const priority = priorityWeight(note.priority) * 2.1;
  const tagMatch = tagMatchScore(note.tags, [...tokens, ...(requestedTags ?? [])]);
  const recency = shortMemoryRecencyScore(note.createdAt, now);
  const access = Math.min(1.2, Math.log1p(note.accessCount) * 0.35);
  const promote = note.promoteScore * 1.1;
  const noisePenalty = noisyMemoryPenalty(query, corpus);
  return round(Math.max(0, bm25Score + lexical + priority + tagMatch + recency + access + promote - noisePenalty));
}

function noisyMemoryPenalty(query: string, corpus: string): number {
  const normalizedQuery = normalizeMemoryText(query);
  if (/\b(403|permission|forbidden|role|auth)\b/i.test(normalizedQuery) && /\b(logo|brand|asset|color|colour)\b/i.test(corpus)) {
    return 10;
  }
  if (/\bdeploy|production|release|rollback\b/i.test(normalizedQuery) && /\b(logo|brand|color|copywriting)\b/i.test(corpus)) {
    return 8;
  }
  return 0;
}

function recencyScore(updatedAt: string, now: Date): number {
  const updated = new Date(updatedAt).getTime();
  if (!Number.isFinite(updated)) {
    return 0;
  }
  const ageDays = Math.max(0, (now.getTime() - updated) / 86_400_000);
  if (ageDays <= 7) {
    return 1;
  }
  if (ageDays <= 30) {
    return 0.5;
  }
  return 0;
}

function itemToSqliteValues(item: ProjectMemoryItem): SqliteValue[] {
  return [
    item.id,
    item.zone,
    item.title,
    item.content,
    item.summary,
    item.source ?? null,
    item.sourceType ?? null,
    JSON.stringify(item.tags),
    item.privacyLevel,
    item.confidence,
    item.importance,
    item.createdAt,
    item.updatedAt,
    item.lastAccessedAt ?? null,
    item.expiresAt ?? null,
    item.status,
    JSON.stringify(item.reasons),
    item.contentHash
  ];
}

function rowToProjectMemoryItem(row: ProjectMemoryRow): ProjectMemoryItem {
  return {
    id: row.id,
    zone: isLibraryZone(row.zone) ? row.zone : "unknown",
    title: row.title,
    content: row.content,
    summary: row.summary,
    contentHash: row.content_hash || hashMemoryContent(row.title, row.summary, row.content),
    source: row.source ?? undefined,
    sourceType: row.source_type ?? undefined,
    tags: safeJsonArray(row.tags),
    privacyLevel: isLibraryPrivacyLevel(row.privacy_level) ? row.privacy_level : "internal",
    confidence: Number(row.confidence),
    importance: Number(row.importance),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastAccessedAt: row.last_accessed_at ?? undefined,
    expiresAt: row.expires_at ?? undefined,
    status: isProjectMemoryStatus(row.status) ? row.status : "active",
    reasons: safeJsonArray(row.reasons)
  };
}

function rowToShortMemoryNote(row: ShortMemoryRow): ShortMemoryNote {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    summary: row.summary ?? createShortMemorySummary(row.title, row.content),
    contentHash: row.content_hash || hashMemoryContent(row.title, row.summary ?? "", row.content),
    source: row.source ?? undefined,
    sourceType: row.source_type ?? undefined,
    tags: safeJsonArray(row.tags ?? "[]"),
    priority: isShortMemoryPriority(row.priority) ? row.priority : "medium",
    status: isShortMemoryStatus(row.status) ? row.status : "active",
    privacyLevel: isLibraryPrivacyLevel(row.privacy_level) ? row.privacy_level : "internal",
    importanceScore: Number(row.importance_score),
    promoteScore: Number(row.promote_score),
    promotedToLongMemoryId: row.promoted_to_long_memory_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    lastAccessedAt: row.last_accessed_at ?? undefined,
    accessCount: Number(row.access_count ?? 0),
    reasons: safeJsonArray(row.reasons ?? "[]")
  };
}

function rowToTaskObservation(row: TaskObservationRow): TaskObservation {
  return {
    taskId: row.id,
    taskTitle: row.task_title,
    taskSummary: row.task_summary ?? undefined,
    agent: row.agent ?? undefined,
    filesTouched: safeJsonValue<FileTouchSummary[]>(row.files_touched, []),
    commandsRun: safeJsonValue<CommandRunSummary[]>(row.commands_run, []),
    tests: safeJsonValue<TestRunSummary[]>(row.tests, []),
    errors: safeJsonValue<ErrorSummary[]>(row.errors, []),
    decisions: safeJsonValue<DecisionSummary[]>(row.decisions, []),
    outcome: isTaskOutcome(row.outcome) ? row.outcome : "unknown",
    privacyScanStatus: isPrivacyStatus(row.privacy_scan_status) ? row.privacy_scan_status : "warning",
    sourceRefs: safeJsonValue<SourceRef[]>(row.source_refs, []),
    createdAt: row.created_at
  };
}

function rowToLessonCandidate(row: LessonCandidateRow): LessonCandidate {
  return {
    id: row.id,
    taskId: row.task_id,
    lessonType: isLessonType(row.lesson_type) ? row.lesson_type : "other",
    title: row.title,
    summary: row.summary,
    lesson: row.lesson,
    appliesTo: safeJsonArray(row.applies_to),
    sourceRefs: safeJsonValue<SourceRef[]>(row.source_refs, []),
    evidence: safeJsonValue<Evidence[]>(row.evidence, []),
    confidence: round(clamp01(Number(row.confidence))),
    privacyStatus: isPrivacyStatus(row.privacy_status) ? row.privacy_status : "warning",
    approvalStatus: isApprovalStatus(row.approval_status) ? row.approval_status : "needs_review",
    verifyRequired: Boolean(row.verify_required),
    suggestedVerification: safeJsonArray(row.suggested_verification),
    lastVerifiedAt: row.last_verified_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function insertLessonCandidateSync(db: DatabaseSync, candidate: LessonCandidate): void {
  db.prepare(`
    INSERT INTO lesson_candidates (
      id, task_id, lesson_type, title, summary, lesson, applies_to, source_refs,
      evidence, confidence, privacy_status, approval_status, verify_required,
      suggested_verification, last_verified_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    candidate.id,
    candidate.taskId,
    candidate.lessonType,
    candidate.title,
    candidate.summary,
    candidate.lesson,
    JSON.stringify(candidate.appliesTo),
    JSON.stringify(candidate.sourceRefs),
    JSON.stringify(candidate.evidence),
    candidate.confidence,
    candidate.privacyStatus,
    candidate.approvalStatus,
    candidate.verifyRequired ? 1 : 0,
    JSON.stringify(candidate.suggestedVerification),
    candidate.lastVerifiedAt,
    candidate.createdAt,
    candidate.updatedAt
  );
}

function getLessonCandidateSync(db: DatabaseSync, id: string): LessonCandidate | undefined {
  const row = db.prepare("SELECT * FROM lesson_candidates WHERE id = ?").get(id) as unknown as LessonCandidateRow | undefined;
  return row ? rowToLessonCandidate(row) : undefined;
}

function sanitizeTaskObservation(input: TaskObservationInput, now: string): TaskObservation {
  const rawPrivacy = privacyStatusForRawInput(input);
  const filesTouched = (input.filesTouched ?? []).map(sanitizeFileTouchSummary);
  const commandsRun = (input.commandsRun ?? []).map(sanitizeCommandRunSummary);
  const tests = (input.tests ?? []).map(sanitizeTestRunSummary);
  const errors = (input.errors ?? []).map(sanitizeErrorSummary);
  const decisions = (input.decisions ?? []).map(sanitizeDecisionSummary);
  const sourceRefs = (input.sourceRefs ?? []).map(sanitizeSourceRef);
  const sanitizedPrivacy = privacyStatusForRawInput({ filesTouched, commandsRun, tests, errors, decisions, sourceRefs });
  return {
    taskId: sanitizeIdentifier(input.taskId) ?? randomUUID(),
    taskTitle: sanitizeText(input.taskTitle, 160) || "Untitled task",
    taskSummary: input.taskSummary ? sanitizeText(input.taskSummary, 800) : undefined,
    agent: input.agent ? sanitizeText(input.agent, 80) : undefined,
    filesTouched,
    commandsRun,
    tests,
    errors,
    decisions,
    outcome: input.outcome ?? "unknown",
    privacyScanStatus: strongestPrivacyStatus(rawPrivacy, sanitizedPrivacy),
    sourceRefs,
    createdAt: now
  };
}

function sanitizeFileTouchSummary(input: FileTouchSummary): FileTouchSummary {
  return {
    path: sanitizePath(input.path),
    changeType: isFileChangeType(input.changeType) ? input.changeType : "modified",
    changeSummary: input.changeSummary ? sanitizeText(input.changeSummary, 500) : undefined,
    riskLevel: input.riskLevel
  };
}

function sanitizeCommandRunSummary(input: CommandRunSummary): CommandRunSummary {
  return {
    command: sanitizeText(input.command, 240),
    exitCode: typeof input.exitCode === "number" ? input.exitCode : null,
    status: isRunStatus(input.status) ? input.status : "unknown",
    outputSummary: input.outputSummary ? sanitizeText(input.outputSummary, 600) : undefined,
    outputRedacted: true
  };
}

function sanitizeTestRunSummary(input: TestRunSummary): TestRunSummary {
  return {
    name: sanitizeText(input.name, 160) || "test",
    status: isRunStatus(input.status) ? input.status : "unknown",
    command: input.command ? sanitizeText(input.command, 240) : undefined,
    summary: input.summary ? sanitizeText(input.summary, 500) : undefined
  };
}

function sanitizeErrorSummary(input: ErrorSummary): ErrorSummary {
  return {
    message: sanitizeText(input.message, 500),
    source: input.source ? sanitizeText(input.source, 160) : undefined,
    severity: input.severity
  };
}

function sanitizeDecisionSummary(input: DecisionSummary): DecisionSummary {
  return {
    decision: sanitizeText(input.decision, 500),
    reason: input.reason ? sanitizeText(input.reason, 500) : undefined,
    source: input.source ? sanitizeText(input.source, 160) : undefined
  };
}

function sanitizeSourceRef(input: SourceRef): SourceRef {
  return {
    ref: sanitizePath(input.ref),
    kind: input.kind ?? "other"
  };
}

function buildEvidence(observation: TaskObservation, agentProposedLesson?: string): Evidence[] {
  const evidence: Evidence[] = [];
  for (const file of observation.filesTouched) {
    evidence.push({
      type: "file_changed",
      ref: file.path,
      summary: file.changeSummary ?? `${file.changeType} ${file.path}`,
      confidence: file.riskLevel === "high" ? 0.7 : 0.8
    });
  }
  for (const command of observation.commandsRun) {
    evidence.push({
      type: "command_exit_code",
      ref: command.command,
      summary: `Command finished with ${command.exitCode === null ? "unknown exit code" : `exit code ${command.exitCode}`}.`,
      confidence: command.exitCode === 0 ? 0.85 : 0.55
    });
  }
  for (const test of observation.tests) {
    evidence.push({
      type: test.status === "pass" ? "test_passed" : "test_failed",
      ref: test.command ?? test.name,
      summary: test.summary ?? `${test.name} ${test.status}.`,
      confidence: test.status === "pass" ? 0.9 : 0.65
    });
  }
  for (const error of observation.errors) {
    evidence.push({
      type: "error_observed",
      ref: error.source ?? "task_error",
      summary: error.message,
      confidence: error.severity === "high" ? 0.75 : 0.6
    });
  }
  for (const decision of observation.decisions) {
    evidence.push({
      type: "user_instruction",
      ref: decision.source ?? "decision",
      summary: decision.reason ? `${decision.decision} (${decision.reason})` : decision.decision,
      confidence: 0.72
    });
  }
  if (agentProposedLesson?.trim()) {
    evidence.push({
      type: "agent_summary",
      ref: "agent_proposed_lesson",
      summary: sanitizeText(agentProposedLesson, 500),
      confidence: 0.35
    });
  }
  evidence.push({
    type: "privacy_check",
    ref: "lmti_privacy_gate",
    summary: observation.privacyScanStatus === "pass" ? "Privacy gate passed." : `Privacy gate returned ${observation.privacyScanStatus}.`,
    confidence: observation.privacyScanStatus === "pass" ? 0.8 : 0.5
  });
  return evidence.map((entry) => ({
    ...entry,
    ref: sanitizeText(entry.ref, 240),
    summary: sanitizeText(entry.summary, 600),
    confidence: round(clamp01(entry.confidence))
  }));
}

function createCandidateLesson(observation: TaskObservation, agentProposedLesson?: string): string {
  if (agentProposedLesson?.trim()) {
    return sanitizeText(agentProposedLesson, 900);
  }
  if (observation.decisions[0]) {
    return sanitizeText(`Reuse this decision after similar tasks: ${observation.decisions[0].decision}`, 900);
  }
  if (observation.errors[0] && observation.tests.some((test) => test.status === "pass")) {
    return sanitizeText(`When this error appears again, verify the affected files and rerun the passing test before treating it as fixed: ${observation.errors[0].message}`, 900);
  }
  const files = observation.filesTouched.map((file) => file.path).slice(0, 3).join(", ");
  const tests = observation.tests.filter((test) => test.status === "pass").map((test) => test.command ?? test.name).slice(0, 2).join(", ");
  if (files && tests) {
    return sanitizeText(`When changing ${files}, verify the behavior with ${tests} before recording the task as complete.`, 900);
  }
  return sanitizeText(`Review evidence from "${observation.taskTitle}" before turning this task pattern into durable project memory.`, 900);
}

function scoreLessonCandidate(input: {
  observation: TaskObservation;
  evidence: Evidence[];
  privacyStatus: TaskObservationPrivacyStatus;
  onlyAgentSummary: boolean;
}): number {
  let score = 0;
  if (input.observation.tests.some((test) => test.status === "pass")) score += 0.25;
  if (input.observation.filesTouched.length > 0 || input.observation.sourceRefs.length > 0) score += 0.2;
  if (input.observation.commandsRun.some((command) => command.exitCode === 0)) score += 0.2;
  if (input.observation.decisions.length > 0 || input.observation.sourceRefs.some((ref) => ref.kind === "user")) score += 0.15;
  if (input.privacyStatus === "pass") score += 0.1;
  if (input.onlyAgentSummary) score -= 0.3;
  if (input.observation.outcome === "partial" || input.observation.outcome === "unknown") score -= 0.4;
  if (input.observation.outcome === "fail") score -= 0.25;
  if (input.privacyStatus === "warning") score -= 0.6;
  if (input.privacyStatus === "blocked") score = Math.min(score - 0.8, 0.19);
  if (input.evidence.length === 0) score -= 0.4;
  return round(clamp01(score));
}

function createSuggestedVerification(
  observation: TaskObservation,
  confidence: number,
  privacyStatus: TaskObservationPrivacyStatus,
  requested?: string[]
): string[] {
  const steps = new Set<string>(sanitizeStringList(requested ?? [], 12, 80));
  if (observation.filesTouched.length > 0) steps.add("read_source_file");
  if (observation.commandsRun.length > 0 || observation.tests.length > 0) steps.add("run_tests");
  if (observation.filesTouched.length > 0) steps.add("inspect_change_summary");
  steps.add("privacy_check");
  if (confidence < 0.8 || privacyStatus !== "pass") steps.add("review_evidence");
  return Array.from(steps);
}

function inferLessonType(observation: TaskObservation, lesson: string): LessonCandidateType {
  const corpus = normalizeMemoryText(`${observation.taskTitle} ${observation.taskSummary ?? ""} ${lesson} ${observation.filesTouched.map((file) => file.path).join(" ")}`);
  if (/\b(permission|403|forbidden|role|auth|least privilege)\b/i.test(corpus)) return "permission";
  if (/\b(secret|privacy|token|credential|security)\b/i.test(corpus)) return "security";
  if (/\b(test|vitest|jest|playwright|coverage)\b/i.test(corpus)) return "testing";
  if (/\b(deploy|production|release|docker|ci|rollback)\b/i.test(corpus)) return "deployment";
  if (/\b(schema|database|migration|sql|prisma)\b/i.test(corpus)) return "data_model";
  if (/\b(cli|command|flag|terminal)\b/i.test(corpus)) return "cli";
  if (/\b(architecture|boundary|module|package)\b/i.test(corpus)) return "architecture";
  if (/\b(bug|fix|error|failed|failure)\b/i.test(corpus)) return "bug_fix";
  if (/\b(workflow|process|route|approval)\b/i.test(corpus)) return "workflow";
  return "other";
}

function privacyStatusForCandidate(input: LessonProposalInput, evidence: Evidence[]): TaskObservationPrivacyStatus {
  return privacyStatusForRawInput({
    title: input.title,
    lesson: input.agentProposedLesson,
    appliesTo: input.appliesTo,
    suggestedVerification: input.suggestedVerification,
    evidence
  });
}

function privacyStatusForRawInput(input: unknown): TaskObservationPrivacyStatus {
  const serialized = JSON.stringify(input ?? {});
  const egress = runEgressSecretScan(serialized);
  if (egress.blocked || hasSensitivePath(serialized)) {
    return "blocked";
  }
  return redactText(serialized) === serialized ? "pass" : "warning";
}

function strongestPrivacyStatus(left: TaskObservationPrivacyStatus, right: TaskObservationPrivacyStatus): TaskObservationPrivacyStatus {
  if (left === "blocked" || right === "blocked") return "blocked";
  if (left === "warning" || right === "warning") return "warning";
  return "pass";
}

function isOnlyAgentSummary(evidence: Evidence[]): boolean {
  const substantive = evidence.filter((entry) => entry.type !== "privacy_check");
  return substantive.length === 1 && substantive[0]?.type === "agent_summary";
}

function assertCandidateCanBeApproved(candidate: LessonCandidate): void {
  if (candidate.approvalStatus === "rejected") {
    throw new Error("Rejected lesson candidates cannot be approved.");
  }
  if (candidate.privacyStatus === "blocked") {
    throw new Error("Privacy-blocked lesson candidates cannot be approved.");
  }
  if (candidate.evidence.length === 0) {
    throw new Error("Lesson candidates without evidence cannot be approved.");
  }
  if (candidate.confidence < 0.2) {
    throw new Error("Low-confidence lesson candidates require review and cannot be approved yet.");
  }
}

function lessonCandidateToMemoryContent(candidate: LessonCandidate): string {
  return [
    `Lesson: ${candidate.lesson}`,
    `Task: ${candidate.summary}`,
    `Confidence: ${candidate.confidence}`,
    `Privacy: ${candidate.privacyStatus}`,
    `Verification required: ${candidate.verifyRequired ? "yes" : "no"}`,
    `Last verified at: ${candidate.lastVerifiedAt ?? "not verified"}`,
    candidate.sourceRefs.length > 0 ? `Source refs: ${candidate.sourceRefs.map((ref) => ref.ref).join(", ")}` : undefined,
    "Evidence:",
    ...candidate.evidence.map((entry) => `- ${entry.type}: ${entry.summary} (${entry.ref})`),
    "Suggested verification:",
    ...candidate.suggestedVerification.map((step) => `- ${step}`)
  ].filter(Boolean).join("\n");
}

function sanitizeText(value: string, maxLength: number): string {
  return redactText(String(value ?? "").replace(/\s+/g, " ").trim()).slice(0, maxLength);
}

function sanitizePath(value: string): string {
  const text = sanitizeText(value, 240).replace(/\\/g, "/");
  return hasSensitivePath(text) ? "[REDACTED_SENSITIVE_PATH]" : text;
}

function sanitizeStringList(values: string[], limit: number, maxLength: number): string[] {
  return Array.from(new Set(values.map((value) => sanitizeText(value, maxLength)).filter(Boolean))).slice(0, limit);
}

function sanitizeIdentifier(value?: string): string | undefined {
  const sanitized = value ? sanitizeText(value, 120) : undefined;
  return sanitized && /^[A-Za-z0-9_.:-]+$/.test(sanitized) ? sanitized : undefined;
}

function hasSensitivePath(value: string): boolean {
  return /(^|[/\\])\.env($|[./\\])|private[_-]?key|secret|credential|id_rsa|id_ed25519|wp-config\.php|\.npmrc|\.yarnrc/i.test(value);
}

function safeJsonValue<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function isTaskOutcome(value: string): value is TaskOutcome {
  return value === "pass" || value === "fail" || value === "partial" || value === "unknown";
}

function isPrivacyStatus(value: string): value is TaskObservationPrivacyStatus {
  return value === "pass" || value === "warning" || value === "blocked";
}

function isApprovalStatus(value: string): value is LessonApprovalStatus {
  return value === "pending" || value === "approved" || value === "rejected" || value === "needs_review";
}

function isLessonType(value: string): value is LessonCandidateType {
  return [
    "bug_fix",
    "architecture",
    "security",
    "testing",
    "deployment",
    "workflow",
    "permission",
    "data_model",
    "cli",
    "other"
  ].includes(value);
}

function isFileChangeType(value: string): value is FileTouchSummary["changeType"] {
  return value === "created" || value === "modified" || value === "deleted" || value === "renamed";
}

function isRunStatus(value: string): value is CommandRunSummary["status"] {
  return value === "pass" || value === "fail" || value === "unknown";
}

function appendProjectMemoryEvent(db: DatabaseSync, memoryId: string | undefined, eventType: string, payload: Record<string, unknown>): void {
  const safePayload = redactText(JSON.stringify(payload));
  db.prepare("INSERT INTO memory_events(id, memory_id, event_type, payload, created_at) VALUES (?, ?, ?, ?, ?)").run(
    randomUUID(),
    memoryId ?? null,
    eventType,
    safePayload,
    new Date().toISOString()
  );
}

function appendShortMemoryEvent(db: DatabaseSync, noteId: string | undefined, eventType: string, payload: Record<string, unknown>): void {
  const safePayload = redactText(JSON.stringify(payload));
  db.prepare("INSERT INTO short_memory_events(id, note_id, event_type, payload, created_at) VALUES (?, ?, ?, ?, ?)").run(
    randomUUID(),
    noteId ?? null,
    eventType,
    safePayload,
    new Date().toISOString()
  );
}

function linkProjectMemoriesSync(db: DatabaseSync, fromMemoryId: string, toMemoryId: string, relationType: string): void {
  db.prepare(`
    INSERT OR IGNORE INTO memory_links(id, from_memory_id, to_memory_id, relation_type, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(randomUUID(), fromMemoryId, toMemoryId, relationType, new Date().toISOString());
}

function updateLastAccessed(db: DatabaseSync, id: string, now: string): void {
  db.prepare("UPDATE memory_items SET last_accessed_at = ?, updated_at = updated_at WHERE id = ?").run(now, id);
}

function updateShortMemoryAccess(db: DatabaseSync, id: string, now: string): void {
  db.prepare("UPDATE short_memory_notes SET last_accessed_at = ?, access_count = access_count + 1 WHERE id = ?").run(now, id);
}

async function initializeProjectMemoryDatabase(cwd: string): Promise<{ target: CheckedMemoryPath; db: DatabaseSync }> {
  const target = await checkedSqliteTarget(cwd, PROJECT_MEMORY_DB_FILE, true);
  const db = await openProjectMemoryDatabase(target);
  try {
    applyProjectMemorySchema(db);
    return { target, db };
  } catch (error) {
    db.close();
    throw error;
  }
}

async function openProjectMemoryDatabase(target: CheckedMemoryPath): Promise<DatabaseSync> {
  const sqlite = await import("node:sqlite");
  // Reuse this operation's parent/main identities, and inspect current sidecars.
  await target.recheck();
  const db = new sqlite.DatabaseSync(target.filename);
  try {
    db.exec("PRAGMA foreign_keys = ON;");
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function buildFtsQuery(query: string): string {
  const tokens = tokenizeMemoryText(query)
    .filter((token) => /^[a-z0-9_/-]+$/i.test(token))
    .slice(0, 12);
  return tokens.map((token) => `"${token.replace(/"/g, "\"\"")}"`).join(" OR ");
}

function hashMemoryContent(title: string, summary: string, content: string): string {
  return createHash("sha256")
    .update(`${title}\n${summary}\n${content}`, "utf8")
    .digest("hex");
}

function safeJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map((entry) => String(entry)) : [];
  } catch {
    return [];
  }
}

function tagLikeParams(tags?: string[]): string[] {
  return (tags ?? []).map((tag) => `%${normalizeMemoryText(tag)}%`);
}

function calculateShortMemoryExpiresAt(now: Date, priority: ShortMemoryPriority, ttl?: ShortMemoryTtl): Date {
  const ttlMs = ttlToMs(ttl);
  if (ttlMs > 0) {
    return new Date(now.getTime() + ttlMs);
  }
  return new Date(now.getTime() + priorityDefaultTtlHours(priority) * 3_600_000);
}

function ttlToMs(ttl?: ShortMemoryTtl): number {
  if (!ttl) {
    return 0;
  }
  const minutes = ttl.minutes ?? 0;
  const hours = ttl.hours ?? 0;
  const days = ttl.days ?? 0;
  return Math.max(0, minutes * 60_000 + hours * 3_600_000 + days * 86_400_000);
}

function priorityDefaultTtlHours(priority: ShortMemoryPriority): number {
  switch (priority) {
    case "low":
      return 6;
    case "high":
      return 72;
    case "critical":
      return 168;
    case "medium":
    default:
      return 24;
  }
}

function priorityWeight(priority: ShortMemoryPriority): number {
  switch (priority) {
    case "low":
      return 0.25;
    case "medium":
      return 0.5;
    case "high":
      return 0.78;
    case "critical":
      return 1;
  }
}

function calculateShortMemoryImportance(input: {
  priority: ShortMemoryPriority;
  classification: LibraryClassification;
  content: string;
  privacyLevel: LibraryPrivacyLevel;
}): number {
  const normalized = normalizeMemoryText(input.content);
  let score = priorityWeight(input.priority) * 0.35 + input.classification.importance * 0.4 + input.classification.confidence * 0.15;
  if (/\b(current|todo|next|debug|test|build|file|changed|constraint)\b/i.test(normalized)) {
    score += 0.08;
  }
  if (input.privacyLevel === "secret" || input.privacyLevel === "do_not_prompt") {
    score -= 0.15;
  }
  return round(clamp01(score));
}

function calculateShortMemoryPromoteScore(input: {
  priority: ShortMemoryPriority;
  classification: LibraryClassification;
  content: string;
  importanceScore: number;
  accessCount: number;
  privacyLevel: LibraryPrivacyLevel;
}): number {
  const normalized = normalizeMemoryText(input.content);
  const longTermZones = new Set<LibraryZone>(["security", "deployment", "architecture", "decision", "lesson", "incident", "workflow", "business"]);
  let score = input.importanceScore * 0.35 + priorityWeight(input.priority) * 0.22 + Math.min(0.16, Math.log1p(input.accessCount) * 0.04);
  if (longTermZones.has(input.classification.zone)) {
    score += 0.12;
  }
  if (/\b(bug|incident|security|deploy|deployment|architecture|decision|lesson|rule|permission|403|least privilege)\b/i.test(normalized)) {
    score += 0.13;
  }
  if (/\b(remember|important|long-term|rule|lesson)\b/i.test(normalized)) {
    score += 0.14;
  }
  if (/\b(temp|temporary|one-time|build output|latest test|intermediate|scratch)\b/i.test(normalized)) {
    score -= 0.2;
  }
  if (input.privacyLevel === "secret" || input.privacyLevel === "do_not_prompt") {
    score = Math.min(score, 0.35);
  }
  return round(clamp01(score));
}

function createShortMemorySummary(title: string, content: string): string {
  const compact = redactText(content).replace(/\s+/g, " ").trim();
  const firstSentence = compact.split(/[.!?]\s/u)[0] || compact;
  const summary = `${redactText(title)}: ${firstSentence}`.trim();
  return summary.length <= 260 ? summary : `${summary.slice(0, 259).trim()}...`;
}

function createDurableKnowledgeFromShortNote(note: ShortMemoryNote, reason?: string): string {
  const title = redactText(note.title);
  const summary = redactText(note.summary || note.content);
  const rationale = reason ? `Promotion reason: ${redactText(reason)}` : `Promotion reason: promote score ${note.promoteScore}.`;
  return [
    `Promoted project knowledge from short memory.`,
    `Subject: ${title}`,
    `Durable summary: ${summary}`,
    `Tags: ${note.tags.slice(0, 10).join(", ")}`,
    rationale
  ].join("\n");
}

function tagMatchScore(noteTags: string[], queryTags: string[]): number {
  const tags = new Set(noteTags.map(normalizeMemoryText));
  let score = 0;
  for (const tag of queryTags.map(normalizeMemoryText)) {
    if (tag && tags.has(tag)) {
      score += 0.65;
    }
  }
  return Math.min(2.6, score);
}

function shortMemoryRecencyScore(createdAt: string, now: Date): number {
  const created = new Date(createdAt).getTime();
  if (!Number.isFinite(created)) {
    return 0;
  }
  const ageHours = Math.max(0, (now.getTime() - created) / 3_600_000);
  if (ageHours <= 1) {
    return 1.4;
  }
  if (ageHours <= 6) {
    return 1;
  }
  if (ageHours <= 24) {
    return 0.6;
  }
  if (ageHours <= 72) {
    return 0.25;
  }
  return 0;
}

function detectShortLongMemoryWarnings(shortMemory: ShortMemoryRetrievalNote[], longMemory: ProjectMemorySearchResult[]): string[] {
  const warnings: string[] = [];
  for (const short of shortMemory) {
    const shortText = normalizeMemoryText(`${short.title} ${short.summary} ${short.tags.join(" ")}`);
    if (!/\b(now|instead|no longer|not|contradicts|different|fails|new|temporary)\b/i.test(shortText)) {
      continue;
    }
    for (const long of longMemory) {
      const longText = normalizeMemoryText(`${long.item.title} ${long.item.summary} ${long.item.tags.join(" ")}`);
      const overlap = tokenizeMemoryText(shortText).filter((token) => token.length > 3 && longText.includes(token)).length;
      if (overlap >= 2) {
        warnings.push(`Short memory "${short.title}" may conflict with long memory "${long.item.title}". Prefer long memory for durable rules and short memory for current-task constraints.`);
      }
    }
  }
  return Array.from(new Set(warnings)).slice(0, 8);
}

function uniqueZones(zones: LibraryZone[]): LibraryZone[] {
  return Array.from(new Set(zones.filter(isLibraryZone)));
}

function isShortMemoryPriority(value: string): value is ShortMemoryPriority {
  return ["low", "medium", "high", "critical"].includes(value);
}

function isShortMemoryStatus(value: string): value is ShortMemoryStatus {
  return ["active", "expired", "deleted", "promoted", "blocked_by_privacy"].includes(value);
}

function isProjectMemoryStatus(value: string): value is ProjectMemoryStatus {
  return ["active", "archived", "superseded", "deleted"].includes(value);
}

function createEmptyStats(): ProjectMemoryStats {
  return {
    total: 0,
    byZone: {
      architecture: 0,
      codebase: 0,
      workflow: 0,
      deployment: 0,
      security: 0,
      decision: 0,
      lesson: 0,
      incident: 0,
      customer: 0,
      business: 0,
      prompting: 0,
      unknown: 0
    },
    byPrivacyLevel: {
      public: 0,
      internal: 0,
      private: 0,
      secret: 0,
      do_not_prompt: 0
    },
    byStatus: {
      active: 0,
      archived: 0,
      superseded: 0,
      deleted: 0
    }
  };
}

export type { LibraryClassification, LibraryPrivacyLevel, LibraryZone };
export { classifyLibraryMemory, LIBRARY_ZONES, suggestZonesForTask };
