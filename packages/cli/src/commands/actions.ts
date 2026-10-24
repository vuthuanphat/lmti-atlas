import { getCodexActionStats, startCodexSession, logCodexFileEvent, logCodexAction, logCodexCommandEvent, logCodexDecision, logCodexMemoryUsage, logCodexReflection, endCodexSession, listCodexSessions, getCodexSessionDetail, renderCodexSessionDetailHtml, listCodexRiskItems, getCodexReplay, getCodexSession, renderCodexReplayHtml } from "@atlas/runtime/agent";
import { printSafeJson, printSafeText } from "../output.js";
import { CliUsageError, actionTypeToFileEvent, parseArgs, parseCodexActionType, parseCodexMemoryType, parseCodexSessionStatus, parseCsv, parseNumberFlag, requiredStringFlag, stringFlag } from "../arguments.js";

export async function runActions(args: string[], cwd: string): Promise<void> {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case "start":
      await runActionsStart(rest, cwd);
      return;
    case "log":
      await runActionsLog(rest, cwd);
      return;
    case "command":
      await runActionsCommand(rest, cwd);
      return;
    case "decision":
      await runActionsDecision(rest, cwd);
      return;
    case "memory":
      await runActionsMemory(rest, cwd);
      return;
    case "reflection":
      await runActionsReflection(rest, cwd);
      return;
    case "end":
      await runActionsEnd(rest, cwd);
      return;
    case "list":
      await runActionsList(rest, cwd);
      return;
    case "show":
      await runActionsShow(rest, cwd);
      return;
    case "risks":
      await runActionsRisks(rest, cwd);
      return;
    case "replay":
      await runActionsReplay(rest, cwd);
      return;
    case "stats":
      parseArgs(rest, {  }, 0);
      printSafeJson(await getCodexActionStats({ cwd }), "actions stats");
      return;
    default:
      throw new CliUsageError('Usage: lmti actions <start|log|command|decision|memory|reflection|end|list|show|risks|replay|stats>');
  }
}

async function runActionsStart(args: string[], cwd: string): Promise<void> {
  const { flags } = parseArgs(args, { branch: "value", intent: "value", task: "value" }, 0);
  const task = stringFlag(flags, "task");
  if (!task) {
    throw new CliUsageError('Usage: lmti actions start --task "..."');
  }
  printSafeJson(
    await startCodexSession({
      cwd,
      task,
      branch: stringFlag(flags, "branch"),
      intent: stringFlag(flags, "intent")
    }),
    "actions start"
  );
}

async function runActionsLog(args: string[], cwd: string): Promise<void> {
  const { flags } = parseArgs(args, {
    command: "value",
    detail: "value",
    "diff-summary": "value",
    file: "value",
    "lines-added": "value",
    "lines-removed": "value",
    "session-id": "value",
    title: "value",
    type: "value"
  }, 0);
  const sessionId = requiredStringFlag(flags, "session-id", "Usage: lmti actions log --session-id <id> --type file_read --file <path>");
  const type = parseCodexActionType(stringFlag(flags, "type") ?? "decision_made");
  const file = stringFlag(flags, "file");
  const title = stringFlag(flags, "title") ?? type;

  if (file && type.startsWith("file_")) {
    const eventType = actionTypeToFileEvent(type);
    printSafeJson(
      await logCodexFileEvent({
        cwd,
        sessionId,
        filePath: file,
        eventType,
        diffSummary: stringFlag(flags, "diff-summary"),
        linesAdded: parseNumberFlag(flags, "lines-added", 0),
        linesRemoved: parseNumberFlag(flags, "lines-removed", 0)
      }),
      "actions log"
    );
    return;
  }

  printSafeJson(
    await logCodexAction({
      cwd,
      sessionId,
      actionType: type,
      title,
      detail: stringFlag(flags, "detail"),
      filePath: file,
      command: stringFlag(flags, "command")
    }),
    "actions log"
  );
}

async function runActionsCommand(args: string[], cwd: string): Promise<void> {
  const { flags } = parseArgs(args, {
    command: "value",
    cwd: "value",
    "duration-ms": "value",
    "error-summary": "value",
    "exit-code": "value",
    "output-summary": "value",
    "session-id": "value"
  }, 0);
  const sessionId = requiredStringFlag(flags, "session-id", "Usage: lmti actions command --session-id <id> --command \"npm test\" --exit-code 0");
  const command = requiredStringFlag(flags, "command", "Usage: lmti actions command --session-id <id> --command \"npm test\" --exit-code 0");
  printSafeJson(
    await logCodexCommandEvent({
      cwd,
      sessionId,
      command,
      commandCwd: stringFlag(flags, "cwd"),
      exitCode: flags["exit-code"] === undefined ? undefined : parseNumberFlag(flags, "exit-code", 0),
      durationMs: flags["duration-ms"] === undefined ? undefined : parseNumberFlag(flags, "duration-ms", 0),
      outputSummary: stringFlag(flags, "output-summary"),
      errorSummary: stringFlag(flags, "error-summary")
    }),
    "actions command"
  );
}

async function runActionsDecision(args: string[], cwd: string): Promise<void> {
  const { flags } = parseArgs(args, {
    alternatives: "value",
    confidence: "value",
    decision: "value",
    reason: "value",
    "related-files": "value",
    "related-memory-ids": "value",
    "session-id": "value"
  }, 0);
  const sessionId = requiredStringFlag(flags, "session-id", "Usage: lmti actions decision --session-id <id> --decision \"...\" --reason \"...\"");
  const decision = requiredStringFlag(flags, "decision", "Usage: lmti actions decision --session-id <id> --decision \"...\" --reason \"...\"");
  printSafeJson(
    await logCodexDecision({
      cwd,
      sessionId,
      decision,
      reason: stringFlag(flags, "reason"),
      alternatives: parseCsv(stringFlag(flags, "alternatives")),
      relatedFiles: parseCsv(stringFlag(flags, "related-files")),
      relatedMemoryIds: parseCsv(stringFlag(flags, "related-memory-ids")),
      confidence: parseNumberFlag(flags, "confidence", 0.5)
    }),
    "actions decision"
  );
}

async function runActionsMemory(args: string[], cwd: string): Promise<void> {
  const { flags } = parseArgs(args, {
    "memory-id": "value",
    "memory-type": "value",
    reason: "value",
    role: "value",
    "session-id": "value",
    "used-in-decision": "boolean"
  }, 0);
  const sessionId = requiredStringFlag(flags, "session-id", "Usage: lmti actions memory --session-id <id> --memory-id <id> --memory-type long");
  const memoryId = requiredStringFlag(flags, "memory-id", "Usage: lmti actions memory --session-id <id> --memory-id <id> --memory-type long");
  printSafeJson(
    await logCodexMemoryUsage({
      cwd,
      sessionId,
      memoryId,
      memoryType: parseCodexMemoryType(stringFlag(flags, "memory-type") ?? "long"),
      role: stringFlag(flags, "role"),
      reason: stringFlag(flags, "reason"),
      usedInDecision: Boolean(flags["used-in-decision"])
    }),
    "actions memory"
  );
}

async function runActionsReflection(args: string[], cwd: string): Promise<void> {
  const { flags } = parseArgs(args, {
    "bugs-found": "value",
    "files-changed": "value",
    "lessons-created": "value",
    "long-memories-created": "value",
    "risks-remaining": "value",
    "session-id": "value",
    "short-notes-created": "value",
    summary: "value",
    "tests-run": "value"
  }, 0);
  const sessionId = requiredStringFlag(flags, "session-id", "Usage: lmti actions reflection --session-id <id> --summary \"...\"");
  printSafeJson(
    await logCodexReflection({
      cwd,
      sessionId,
      taskSummary: stringFlag(flags, "summary"),
      filesChanged: parseCsv(stringFlag(flags, "files-changed")),
      testsRun: parseCsv(stringFlag(flags, "tests-run")),
      bugsFound: parseCsv(stringFlag(flags, "bugs-found")),
      lessonsCreated: parseCsv(stringFlag(flags, "lessons-created")),
      shortNotesCreated: parseCsv(stringFlag(flags, "short-notes-created")),
      longMemoriesCreated: parseCsv(stringFlag(flags, "long-memories-created")),
      risksRemaining: parseCsv(stringFlag(flags, "risks-remaining"))
    }),
    "actions reflection"
  );
}

async function runActionsEnd(args: string[], cwd: string): Promise<void> {
  const { flags } = parseArgs(args, { "session-id": "value", status: "value", summary: "value" }, 0);
  const sessionId = requiredStringFlag(flags, "session-id", "Usage: lmti actions end --session-id <id> --status completed");
  printSafeJson(
    await endCodexSession({
      cwd,
      sessionId,
      status: parseCodexSessionStatus(stringFlag(flags, "status") ?? "completed"),
      summary: stringFlag(flags, "summary")
    }),
    "actions end"
  );
}

async function runActionsList(args: string[], cwd: string): Promise<void> {
  const { flags } = parseArgs(args, { limit: "value", status: "value" }, 0);
  printSafeJson(
    await listCodexSessions({
      cwd,
      status: stringFlag(flags, "status") ? parseCodexSessionStatus(stringFlag(flags, "status") ?? "running") : undefined,
      limit: parseNumberFlag(flags, "limit", 50)
    }),
    "actions list"
  );
}

async function runActionsShow(args: string[], cwd: string): Promise<void> {
  const { positional, flags } = parseArgs(args, { html: "boolean", "session-id": "value" }, 1);
  const sessionId = positional[0] ?? stringFlag(flags, "session-id");
  if (!sessionId) {
    throw new CliUsageError("Usage: lmti actions show <session-id>");
  }
  const detail = await getCodexSessionDetail(sessionId, { cwd });
  if (flags.html) {
    printSafeText(renderCodexSessionDetailHtml(detail));
    return;
  }
  printSafeJson(detail, "actions show");
}

async function runActionsRisks(args: string[], cwd: string): Promise<void> {
  const { flags } = parseArgs(args, { limit: "value" }, 0);
  printSafeJson(await listCodexRiskItems({ cwd, limit: parseNumberFlag(flags, "limit", 50) }), "actions risks");
}

async function runActionsReplay(args: string[], cwd: string): Promise<void> {
  const { positional, flags } = parseArgs(args, { html: "boolean", "session-id": "value" }, 1);
  const sessionId = positional[0] ?? stringFlag(flags, "session-id");
  if (!sessionId) {
    throw new CliUsageError("Usage: lmti actions replay <session-id>");
  }
  const replay = await getCodexReplay(sessionId, { cwd });
  if (flags.html) {
    const session = await getCodexSession(sessionId, { cwd });
    if (!session) {
      throw new Error(`Codex session not found: ${sessionId}`);
    }
    printSafeText(renderCodexReplayHtml({ session, replay }));
    return;
  }
  printSafeJson(replay, "actions replay");
}
