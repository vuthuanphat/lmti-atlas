import type { MemoryRecord } from "@atlas/types";
import { inferIntent } from "@atlas/kernel";
import { createMemory, recordTaskDone, proposeLessonCandidate, readAmfDocument } from "@atlas/memory";
import { redactText } from "@atlas/privacy";
import { printSafeJson } from "../output.js";
import { CliUsageError, inferOutcomeFlag, parseArgs, parseCommandRunSummaries, parseConfidence, parseCsv, parseDecisionSummaries, parseErrorSummaries, parseFileTouchSummaries, parseKind, parseLessonType, parseNumberFlag, parsePromptPolicy, parseSensitivity, parseSourceRefs, parseTaskOutcome, parseTestRunSummaries, stringFlag } from "../arguments.js";

export async function runRemember(args: string[]): Promise<void> {
  const memory = await rememberCommand(process.cwd(), args);
  warnIfSensitive(memory);
  printSafeJson(safeMemoryForCli(memory), "remember");
}

export async function rememberCommand(cwd: string, args: string[]): Promise<MemoryRecord> {
  const { flags } = parseArgs(args, {
    confidence: "value",
    content: "value",
    importance: "value",
    kind: "value",
    "project-id": "value",
    "prompt-policy": "value",
    sensitivity: "value",
    "source-refs": "value",
    tags: "value",
    title: "value"
  }, 0);
  const title = stringFlag(flags, "title");
  const content = stringFlag(flags, "content");
  if (!title || !content) {
    throw new CliUsageError('Usage: lmti remember --kind rule --title "..." --content "..." --tags a,b --sensitivity internal --prompt-policy summarize_only');
  }

  const inferred = inferIntent(`${title} ${content}`);
  const tags = Array.from(new Set([...parseCsv(stringFlag(flags, "tags")), inferred.primaryIntent, ...inferred.secondaryIntents].filter((tag) => tag && tag !== "unknown")));
  const kind = parseKind(stringFlag(flags, "kind") ?? "rule");

  if (kind === "lesson") {
    throw new Error("Use `lmti memory lesson propose` for lessons so they pass privacy/evidence/confidence review before approval.");
  }

  return createMemory(
    {
      scope: "long_term",
      kind,
      title,
      content,
      projectId: stringFlag(flags, "project-id") ?? (await detectProjectId()),
      sourceRefs: parseCsv(stringFlag(flags, "source-refs")),
      tags,
      importance: parseNumberFlag(flags, "importance", 0.8),
      confidence: parseConfidence(stringFlag(flags, "confidence") ?? "medium"),
      sensitivity: parseSensitivity(stringFlag(flags, "sensitivity") ?? "internal"),
      promptPolicy: parsePromptPolicy(stringFlag(flags, "prompt-policy") ?? "summarize_only")
    },
    { cwd }
  );
}

export async function runTask(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  if (subcommand !== "done") {
    throw new CliUsageError('Usage: lmti task done --title "<task title>" --summary "<what changed>" [--lesson "<lesson learned>"]');
  }
  const result = await taskDoneCommand(process.cwd(), rest);
  printSafeJson(result.event, "task done");
  if (result.lessonMemory) {
    printSafeJson(safeMemoryForCli(result.lessonMemory), "task lesson");
  }
  if (result.lessonCandidate) {
    printSafeJson(result.lessonCandidate, "task lesson candidate");
  }
  if (result.suggestion) {
    console.log(result.suggestion);
  }
}

export async function taskDoneCommand(cwd: string, args: string[]) {
  const { flags } = parseArgs(args, {
    agent: "value",
    "agent-lesson": "value",
    "applies-to": "value",
    commands: "value",
    "commands-run": "value",
    decisions: "value",
    errors: "value",
    fail: "boolean",
    files: "value",
    "files-touched": "value",
    lesson: "value",
    "lesson-type": "value",
    outcome: "value",
    partial: "boolean",
    pass: "boolean",
    "project-id": "value",
    "prompt-policy": "value",
    "propose-lesson": "boolean",
    sensitivity: "value",
    "source-refs": "value",
    "suggested-verification": "value",
    summary: "value",
    tags: "value",
    "task-id": "value",
    tests: "value",
    title: "value",
    type: "value"
  }, 0);
  const title = stringFlag(flags, "title");
  const summary = stringFlag(flags, "summary");
  if (!title || !summary) {
    throw new CliUsageError('Usage: lmti task done --title "<task title>" --summary "<what changed>" [--lesson "<lesson learned>"]');
  }

  const taskIntent = inferIntent(`${title} ${summary} ${stringFlag(flags, "lesson") ?? ""}`);
  const proposedLesson = stringFlag(flags, "lesson") ?? stringFlag(flags, "agent-lesson");
  const result = await recordTaskDone(
    {
      title,
      summary,
      lesson: undefined,
      tags: parseCsv(stringFlag(flags, "tags")),
      sensitivity: parseSensitivity(stringFlag(flags, "sensitivity") ?? "internal"),
      promptPolicy: parsePromptPolicy(stringFlag(flags, "prompt-policy") ?? "summarize_only"),
      projectId: stringFlag(flags, "project-id") ?? (await detectProjectId()),
      taskIntent
    },
    { cwd }
  );

  if (!proposedLesson && !flags["propose-lesson"]) {
    return { ...result, lessonCandidate: undefined };
  }

  const proposal = await proposeLessonCandidate(
    {
      observation: {
        taskId: stringFlag(flags, "task-id"),
        taskTitle: title,
        taskSummary: summary,
        agent: stringFlag(flags, "agent") ?? "codex",
        filesTouched: parseFileTouchSummaries(stringFlag(flags, "files-touched") ?? stringFlag(flags, "files")),
        commandsRun: parseCommandRunSummaries(stringFlag(flags, "commands") ?? stringFlag(flags, "commands-run")),
        tests: parseTestRunSummaries(stringFlag(flags, "tests")),
        errors: parseErrorSummaries(stringFlag(flags, "errors")),
        decisions: parseDecisionSummaries(stringFlag(flags, "decisions")),
        outcome: parseTaskOutcome(stringFlag(flags, "outcome") ?? inferOutcomeFlag(flags)),
        sourceRefs: parseSourceRefs(stringFlag(flags, "source-refs"))
      },
      agentProposedLesson: proposedLesson,
      lessonType: parseLessonType(stringFlag(flags, "type") ?? stringFlag(flags, "lesson-type")),
      appliesTo: parseCsv(stringFlag(flags, "applies-to")),
      suggestedVerification: parseCsv(stringFlag(flags, "suggested-verification"))
    },
    { cwd }
  );

  return {
    ...result,
    suggestion: undefined,
    lessonCandidate: proposal.candidate
  };
}

export async function detectProjectId(): Promise<string> {
  try {
    const amf = await readAmfDocument(undefined, process.cwd());
    return amf.project.name;
  } catch {
    return "default";
  }
}

export function warnIfSensitive(memory: MemoryRecord): void {
  if (memory.sensitivity === "confidential" || memory.sensitivity === "secret") {
    console.warn(`[LMTI] Stored ${memory.sensitivity} memory. Raw content is withheld from CLI output.`);
  }
}

export function safeMemoryForCli(memory: MemoryRecord): MemoryRecord {
  if (memory.sensitivity === "secret") {
    return { ...memory, content: "[REDACTED]" };
  }
  if (memory.sensitivity === "confidential") {
    return { ...memory, content: "Confidential memory stored; content withheld." };
  }
  return { ...memory, title: redactText(memory.title), content: redactText(memory.content) };
}
