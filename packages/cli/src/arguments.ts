import type { MemoryScope, MemoryKind, MemorySensitivity, AccessRole, PromptPolicy, TaskOutcome, LessonCandidateType, LessonApprovalStatus, TaskObservationPrivacyStatus, FileTouchSummary, CommandRunSummary, TestRunSummary, ErrorSummary, DecisionSummary, SourceRef } from "@atlas/types";
import { type LibraryZone, type LibraryPrivacyLevel, type ShortMemoryPriority } from "@atlas/memory";
import { type CodexActionType, type CodexFileEventType, type CodexSessionStatus, type CodexMemoryUsageType } from "@atlas/runtime/agent";

export class CliUsageError extends Error {
  readonly exitCode = 4 as const;
}

type OptionKind = "boolean" | "value" | "boolean-value";

export type FlagValue = string | boolean;

export function parseArgs(args: string[], schema: Readonly<Record<string, OptionKind>>, maxPositionals = Infinity): { positional: string[]; flags: Record<string, FlagValue> } {
  const positional: string[] = [];
  const flags: Record<string, FlagValue> = Object.create(null);
  let options = true;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (options && arg === "--") { options = false; continue; }
    if (!options || !arg.startsWith("--")) { positional.push(arg); continue; }
    const equal = arg.indexOf("=");
    const key = arg.slice(2, equal < 0 ? undefined : equal);
    if (!Object.hasOwn(schema, key)) throw new CliUsageError(`Unknown option: --${key}`);
    const kind = schema[key];
    const inline = equal < 0 ? undefined : arg.slice(equal + 1);
    if (kind === "value") {
      const value = inline ?? args[index + 1];
      if (value === undefined || (!inline && value.startsWith("--"))) throw new CliUsageError(`Option --${key} requires a value.`);
      flags[key] = value;
      if (inline === undefined) index += 1;
      continue;
    }
    let value = inline;
    // Only this declared compatibility form consumes an adjacent boolean value.
    // Ordinary switches never consume a task, path, identifier or subcommand.
    if (kind === "boolean-value" && value === undefined && /^(true|false|yes|no|1|0)$/i.test(args[index + 1] ?? "")) value = args[++index];
    if (value === undefined) flags[key] = true;
    else if (/^(true|yes|1)$/i.test(value)) flags[key] = true;
    else if (/^(false|no|0)$/i.test(value)) flags[key] = false;
    else throw new CliUsageError(`Option --${key} requires a boolean value.`);
  }
  if (positional.length > maxPositionals) throw new CliUsageError(`Expected at most ${maxPositionals} positional argument(s). Use -- to pass text beginning with --.`);
  return { positional, flags };
}

export function stringFlag(flags: Record<string, FlagValue>, key: string): string | undefined {
  const value = flags[key];
  return typeof value === "string" ? value : undefined;
}

export function requiredStringFlag(flags: Record<string, FlagValue>, key: string, usage: string): string {
  const value = stringFlag(flags, key);
  if (!value) {
    throw new CliUsageError(usage);
  }
  return value;
}

export function parseScope(value: string): MemoryScope {
  if (value === "short_term" || value === "long_term") {
    return value;
  }
  throw new CliUsageError(`Invalid memory scope: ${value}`);
}

export function optionalScope(value?: string): MemoryScope | undefined {
  return value ? parseScope(value) : undefined;
}

export function parseKind(value: string): MemoryKind {
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
  if (allowed.has(value as MemoryKind)) {
    return value as MemoryKind;
  }
  throw new CliUsageError(`Invalid memory kind: ${value}`);
}

export function optionalKind(value?: string): MemoryKind | undefined {
  return value ? parseKind(value) : undefined;
}

export function parseSensitivity(value: string): MemorySensitivity {
  const allowed = new Set<MemorySensitivity>(["public", "internal", "confidential", "secret"]);
  if (allowed.has(value as MemorySensitivity)) {
    return value as MemorySensitivity;
  }
  throw new CliUsageError(`Invalid memory sensitivity: ${value}`);
}

export function parseRole(value: string): AccessRole {
  const allowed = new Set<AccessRole>(["owner", "maintainer", "developer", "agent", "readonly", "external_model"]);
  if (allowed.has(value as AccessRole)) {
    return value as AccessRole;
  }
  throw new CliUsageError(`Invalid access role: ${value}`);
}

export function parsePromptPolicy(value: string): PromptPolicy {
  const allowed = new Set<PromptPolicy>(["allow_raw", "summarize_only", "do_not_prompt"]);
  if (allowed.has(value as PromptPolicy)) {
    return value as PromptPolicy;
  }
  throw new CliUsageError(`Invalid prompt policy: ${value}`);
}

export function optionalLibraryZone(value?: string): LibraryZone | undefined {
  if (!value) {
    return undefined;
  }
  const allowed = new Set<LibraryZone>([
    "architecture",
    "codebase",
    "workflow",
    "deployment",
    "security",
    "decision",
    "lesson",
    "incident",
    "customer",
    "business",
    "prompting",
    "unknown"
  ]);
  if (allowed.has(value as LibraryZone)) {
    return value as LibraryZone;
  }
  throw new CliUsageError(`Invalid library memory zone: ${value}`);
}

export function parseLibraryZones(value?: string): LibraryZone[] | undefined {
  const zones = parseCsv(value).map((zone) => optionalLibraryZone(zone)).filter((zone): zone is LibraryZone => Boolean(zone));
  return zones.length > 0 ? zones : undefined;
}

export function optionalLibraryPrivacyLevel(value?: string): LibraryPrivacyLevel | undefined {
  if (!value) {
    return undefined;
  }
  const allowed = new Set<LibraryPrivacyLevel>(["public", "internal", "private", "secret", "do_not_prompt"]);
  if (allowed.has(value as LibraryPrivacyLevel)) {
    return value as LibraryPrivacyLevel;
  }
  throw new CliUsageError(`Invalid library privacy level: ${value}`);
}

export function parsePrivacyMode(value?: string): "safe" | "internal" {
  if (!value || value === "safe") {
    return "safe";
  }
  if (value === "internal") {
    return "internal";
  }
  throw new CliUsageError(`Invalid privacy mode: ${value}`);
}

export function parseTaskOutcome(value?: string): TaskOutcome {
  if (!value) {
    return "unknown";
  }
  if (value === "pass" || value === "fail" || value === "partial" || value === "unknown") {
    return value;
  }
  throw new CliUsageError(`Invalid task outcome: ${value}`);
}

export function inferOutcomeFlag(flags: Record<string, FlagValue>): string | undefined {
  if (flags.pass) {
    return "pass";
  }
  if (flags.fail) {
    return "fail";
  }
  if (flags.partial) {
    return "partial";
  }
  return undefined;
}

export function parseLessonType(value?: string): LessonCandidateType | undefined {
  if (!value) {
    return undefined;
  }
  const allowed = new Set<LessonCandidateType>([
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
  ]);
  if (allowed.has(value as LessonCandidateType)) {
    return value as LessonCandidateType;
  }
  throw new CliUsageError(`Invalid lesson type: ${value}`);
}

export function parseLessonApprovalStatus(value?: string): LessonApprovalStatus | undefined {
  if (!value) {
    return undefined;
  }
  if (value === "pending" || value === "approved" || value === "rejected" || value === "needs_review") {
    return value;
  }
  throw new CliUsageError(`Invalid lesson approval status: ${value}`);
}

export function parseLessonPrivacyStatus(value?: string): TaskObservationPrivacyStatus | undefined {
  if (!value) {
    return undefined;
  }
  if (value === "pass" || value === "warning" || value === "blocked") {
    return value;
  }
  throw new CliUsageError(`Invalid lesson privacy status: ${value}`);
}

export function parseFileTouchSummaries(value?: string): FileTouchSummary[] {
  return parseCsv(value).map((entry) => {
    const parsed = parseTrailingToken(entry, ["created", "modified", "deleted", "renamed"]);
    return {
      path: parsed.head,
      changeType: (parsed.tail ?? "modified") as FileTouchSummary["changeType"]
    };
  });
}

export function parseCommandRunSummaries(value?: string): CommandRunSummary[] {
  return parseCsv(value).map((entry) => {
    const parsed = parseTrailingNumber(entry);
    const exitCode = parsed.tail;
    return {
      command: parsed.head,
      exitCode,
      status: exitCode === null ? "unknown" : exitCode === 0 ? "pass" : "fail",
      outputRedacted: true
    };
  });
}

export function parseTestRunSummaries(value?: string): TestRunSummary[] {
  return parseCsv(value).map((entry) => {
    const parsed = parseTrailingToken(entry, ["pass", "fail", "unknown"]);
    const status = (parsed.tail ?? "unknown") as TestRunSummary["status"];
    return {
      name: parsed.head,
      status,
      command: parsed.head
    };
  });
}

export function parseErrorSummaries(value?: string): ErrorSummary[] {
  return parseCsv(value).map((entry) => ({
    message: entry,
    severity: "medium"
  }));
}

export function parseDecisionSummaries(value?: string): DecisionSummary[] {
  return parseCsv(value).map((entry) => ({
    decision: entry,
    source: "user"
  }));
}

export function parseSourceRefs(value?: string): SourceRef[] {
  return parseCsv(value).map((entry) => {
    const parsed = parseTrailingToken(entry, ["file", "test", "command", "task", "user", "memory", "other"]);
    return {
      ref: parsed.head,
      kind: (parsed.tail ?? "other") as SourceRef["kind"]
    };
  });
}

function parseTrailingToken<T extends string>(value: string, allowed: readonly T[]): { head: string; tail?: T } {
  const index = value.lastIndexOf(":");
  if (index <= 0) {
    return { head: value };
  }
  const tail = value.slice(index + 1).trim();
  if (!allowed.includes(tail as T)) {
    return { head: value };
  }
  return { head: value.slice(0, index).trim(), tail: tail as T };
}

function parseTrailingNumber(value: string): { head: string; tail: number | null } {
  const index = value.lastIndexOf(":");
  if (index <= 0) {
    return { head: value, tail: null };
  }
  const tail = Number(value.slice(index + 1).trim());
  if (!Number.isFinite(tail)) {
    return { head: value, tail: null };
  }
  return { head: value.slice(0, index).trim(), tail };
}

export function parseCodexActionType(value: string): CodexActionType {
  const allowed = new Set<CodexActionType>([
    "task_received",
    "intent_detected",
    "memory_context_loaded",
    "file_read",
    "file_modified",
    "file_created",
    "file_deleted",
    "file_renamed",
    "command_run",
    "test_run",
    "build_run",
    "lint_run",
    "error_detected",
    "decision_made",
    "scope_warning",
    "privacy_warning",
    "risk_warning",
    "rollback_suggested",
    "task_completed",
    "reflection_saved"
  ]);
  if (allowed.has(value as CodexActionType)) {
    return value as CodexActionType;
  }
  throw new CliUsageError(`Invalid codex action type: ${value}`);
}

export function actionTypeToFileEvent(type: CodexActionType): CodexFileEventType {
  switch (type) {
    case "file_read":
      return "read";
    case "file_created":
      return "created";
    case "file_deleted":
      return "deleted";
    case "file_renamed":
      return "renamed";
    case "file_modified":
    default:
      return "modified";
  }
}

export function parseCodexSessionStatus(value: string): CodexSessionStatus {
  const allowed = new Set<CodexSessionStatus>(["running", "completed", "failed", "blocked", "rolled_back", "needs_review"]);
  if (allowed.has(value as CodexSessionStatus)) {
    return value as CodexSessionStatus;
  }
  throw new CliUsageError(`Invalid codex session status: ${value}`);
}

export function parseCodexMemoryType(value: string): CodexMemoryUsageType {
  const allowed = new Set<CodexMemoryUsageType>(["short", "long", "guardrail", "task_hint"]);
  if (allowed.has(value as CodexMemoryUsageType)) {
    return value as CodexMemoryUsageType;
  }
  throw new CliUsageError(`Invalid codex memory type: ${value}`);
}

export function parseShortMemoryPriority(value: string): ShortMemoryPriority {
  if (value === "low" || value === "medium" || value === "high" || value === "critical") {
    return value;
  }
  throw new CliUsageError(`Invalid short memory priority: ${value}`);
}

export function parseShortMemoryTtl(flags: Record<string, FlagValue>): { minutes?: number; hours?: number; days?: number } | undefined {
  const minutes = optionalNumberFlag(flags, "ttl-minutes");
  const hours = optionalNumberFlag(flags, "ttl-hours");
  const days = optionalNumberFlag(flags, "ttl-days");
  return minutes === undefined && hours === undefined && days === undefined ? undefined : { minutes, hours, days };
}

export function parseNowFlag(flags: Record<string, FlagValue>): Date | undefined {
  const value = stringFlag(flags, "now");
  if (!value) {
    return undefined;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new CliUsageError(`Invalid ISO date for --now: ${value}`);
  }
  return parsed;
}

export function parseConfidence(value: string): "low" | "medium" | "high" {
  if (value === "low" || value === "medium" || value === "high") {
    return value;
  }
  throw new CliUsageError(`Invalid memory confidence: ${value}`);
}

export function parseCsv(value?: string): string[] {
  return value
    ? value
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
    : [];
}

export function parseNumberFlag(flags: Record<string, FlagValue>, key: string, fallback: number): number {
  const value = stringFlag(flags, key);
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new CliUsageError(`Invalid number for --${key}.`);
  return parsed;
}

function optionalNumberFlag(flags: Record<string, FlagValue>, key: string): number | undefined {
  const value = stringFlag(flags, key);
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new CliUsageError(`Invalid number for --${key}: ${value}`);
  }
  return parsed;
}

export function parseBooleanFlag(flags: Record<string, FlagValue>, key: string, fallback = true): boolean {
  const value = flags[key];
  if (value === undefined) {
    return fallback;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return value.toLowerCase() === "true" || value === "1" || value.toLowerCase() === "yes";
  }
  return false;
}
