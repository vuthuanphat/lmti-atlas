import { proposeLessonCandidate, listLessonCandidates, getLessonCandidate, approveLessonCandidate, rejectLessonCandidate } from "@atlas/memory";
import { CliUsageError, inferOutcomeFlag, parseArgs, parseCommandRunSummaries, parseCsv, parseDecisionSummaries, parseErrorSummaries, parseFileTouchSummaries, parseLessonApprovalStatus, parseLessonPrivacyStatus, parseLessonType, parseNowFlag, parseNumberFlag, parseSourceRefs, parseTaskOutcome, parseTestRunSummaries, stringFlag } from "../arguments.js";
import { printSafeJson } from "../output.js";

export async function runProjectMemoryLesson(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case "propose":
      await runProjectMemoryLessonPropose(rest);
      return;
    case "candidates":
    case "list":
      await runProjectMemoryLessonCandidates(rest);
      return;
    case "show":
      await runProjectMemoryLessonShow(rest);
      return;
    case "approve":
      await runProjectMemoryLessonApprove(rest);
      return;
    case "reject":
      await runProjectMemoryLessonReject(rest);
      return;
    default:
      throw new CliUsageError("Usage: lmti memory lesson <propose|candidates|show|approve|reject>");
  }
}

async function runProjectMemoryLessonPropose(args: string[]): Promise<void> {
  const { positional, flags } = parseArgs(args, {
    agent: "value",
    "agent-lesson": "value",
    "applies-to": "value",
    "candidate-title": "value",
    commands: "value",
    "commands-run": "value",
    decisions: "value",
    errors: "value",
    fail: "boolean",
    files: "value",
    "files-touched": "value",
    lesson: "value",
    "lesson-type": "value",
    now: "value",
    outcome: "value",
    partial: "boolean",
    pass: "boolean",
    "source-refs": "value",
    "suggested-verification": "value",
    summary: "value",
    task: "value",
    "task-id": "value",
    "task-summary": "value",
    tests: "value",
    title: "value",
    type: "value"
  }, 1);
  const taskTitle = stringFlag(flags, "task") ?? stringFlag(flags, "title") ?? positional[0];
  if (!taskTitle) {
    throw new CliUsageError('Usage: lmti memory lesson propose --task "..." [--lesson "..."] [--files-touched src/a.ts] [--commands "npm test:0"] [--tests "npm test:pass"]');
  }

  const result = await proposeLessonCandidate(
    {
      observation: {
        taskId: stringFlag(flags, "task-id"),
        taskTitle,
        taskSummary: stringFlag(flags, "summary") ?? stringFlag(flags, "task-summary"),
        agent: stringFlag(flags, "agent") ?? "codex",
        filesTouched: parseFileTouchSummaries(stringFlag(flags, "files-touched") ?? stringFlag(flags, "files")),
        commandsRun: parseCommandRunSummaries(stringFlag(flags, "commands") ?? stringFlag(flags, "commands-run")),
        tests: parseTestRunSummaries(stringFlag(flags, "tests")),
        errors: parseErrorSummaries(stringFlag(flags, "errors")),
        decisions: parseDecisionSummaries(stringFlag(flags, "decisions")),
        outcome: parseTaskOutcome(stringFlag(flags, "outcome") ?? inferOutcomeFlag(flags)),
        sourceRefs: parseSourceRefs(stringFlag(flags, "source-refs"))
      },
      agentProposedLesson: stringFlag(flags, "agent-lesson") ?? stringFlag(flags, "lesson"),
      lessonType: parseLessonType(stringFlag(flags, "type") ?? stringFlag(flags, "lesson-type")),
      title: stringFlag(flags, "candidate-title") ?? stringFlag(flags, "title") ?? taskTitle,
      appliesTo: parseCsv(stringFlag(flags, "applies-to")),
      suggestedVerification: parseCsv(stringFlag(flags, "suggested-verification"))
    },
    { cwd: process.cwd(), now: parseNowFlag(flags) }
  );
  printSafeJson(result, "memory lesson propose");
}

async function runProjectMemoryLessonCandidates(args: string[]): Promise<void> {
  const { flags } = parseArgs(args, {
    "approval-status": "value",
    limit: "value",
    "privacy-status": "value",
    status: "value"
  }, 0);
  const candidates = await listLessonCandidates({
    cwd: process.cwd(),
    approvalStatus: parseLessonApprovalStatus(stringFlag(flags, "approval-status") ?? stringFlag(flags, "status")),
    privacyStatus: parseLessonPrivacyStatus(stringFlag(flags, "privacy-status")),
    limit: parseNumberFlag(flags, "limit", 20)
  });
  printSafeJson(candidates, "memory lesson candidates");
}

async function runProjectMemoryLessonShow(args: string[]): Promise<void> {
  const { positional, flags } = parseArgs(args, { id: "value" }, 1);
  const id = stringFlag(flags, "id") ?? positional[0];
  if (!id) {
    throw new CliUsageError("Usage: lmti memory lesson show <candidate-id>");
  }
  const candidate = await getLessonCandidate(id, { cwd: process.cwd() });
  if (!candidate) {
    throw new Error(`Lesson candidate not found: ${id}`);
  }
  printSafeJson(candidate, "memory lesson show");
}

async function runProjectMemoryLessonApprove(args: string[]): Promise<void> {
  const { positional, flags } = parseArgs(args, { id: "value", now: "value" }, 1);
  const id = stringFlag(flags, "id") ?? positional[0];
  if (!id) {
    throw new CliUsageError("Usage: lmti memory lesson approve <candidate-id>");
  }
  const result = await approveLessonCandidate(id, {
    cwd: process.cwd(),
    now: parseNowFlag(flags)
  });
  printSafeJson(result, "memory lesson approve");
}

async function runProjectMemoryLessonReject(args: string[]): Promise<void> {
  const { positional, flags } = parseArgs(args, { id: "value", now: "value" }, 1);
  const id = stringFlag(flags, "id") ?? positional[0];
  if (!id) {
    throw new CliUsageError("Usage: lmti memory lesson reject <candidate-id>");
  }
  const candidate = await rejectLessonCandidate(id, {
    cwd: process.cwd(),
    now: parseNowFlag(flags)
  });
  printSafeJson(candidate, "memory lesson reject");
}
