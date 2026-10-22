import { prepareCodexContext, reflectAfterTask } from "@atlas/runtime/agent";
import { printSafeJson } from "../output.js";
import { CliUsageError, parseArgs, parseCsv, parseNumberFlag, parsePrivacyMode, stringFlag } from "../arguments.js";

export async function runMind(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case "context":
      printSafeJson(await mindContextCommand(process.cwd(), rest, false), "mind context");
      return;
    case "explain":
    case "debug":
      printSafeJson(await mindContextCommand(process.cwd(), rest, true), `mind ${subcommand}`);
      return;
    case "reflect":
      printSafeJson(await mindReflectCommand(process.cwd(), rest), "mind reflect");
      return;
    default:
      throw new CliUsageError('Usage: lmti mind <context|explain|reflect|debug> "<task>"');
  }
}

export async function mindContextCommand(cwd: string, args: string[], includeReasoning = false) {
  const { positional, flags } = parseArgs(args, {
    branch: "value",
    "dirty-files": "value",
    framework: "value",
    "include-reasoning": "boolean",
    intent: "value",
    "max-context-chars": "value",
    "max-long-memories": "value",
    "max-short-notes": "value",
    "package-manager": "value",
    "privacy-mode": "value",
    "recent-files": "value",
    task: "value"
  }, 1);
  const task = positional[0] ?? stringFlag(flags, "task");
  if (!task) {
    throw new CliUsageError('Usage: lmti mind context "<task>" [--max-context-chars 6000]');
  }
  return prepareCodexContext({
    task,
    cwd,
    userIntent: stringFlag(flags, "intent"),
    repoState: {
      branch: stringFlag(flags, "branch"),
      dirtyFiles: parseCsv(stringFlag(flags, "dirty-files")),
      recentFiles: parseCsv(stringFlag(flags, "recent-files")),
      packageManager: stringFlag(flags, "package-manager"),
      framework: stringFlag(flags, "framework")
    },
    options: {
      maxShortNotes: parseNumberFlag(flags, "max-short-notes", 5),
      maxLongMemories: parseNumberFlag(flags, "max-long-memories", 7),
      maxContextChars: parseNumberFlag(flags, "max-context-chars", 6000),
      privacyMode: parsePrivacyMode(stringFlag(flags, "privacy-mode")),
      includeReasoning: includeReasoning || Boolean(flags["include-reasoning"])
    }
  });
}

export async function mindReflectCommand(cwd: string, args: string[]) {
  const { flags } = parseArgs(args, {
    "bugs-found": "value",
    "decisions-made": "value",
    "files-changed": "value",
    risks: "value",
    summary: "value",
    task: "value",
    "tests-run": "value"
  }, 0);
  const task = stringFlag(flags, "task");
  if (!task) {
    throw new CliUsageError('Usage: lmti mind reflect --task "..." [--summary "..."]');
  }
  return reflectAfterTask({
    task,
    cwd,
    filesChanged: parseCsv(stringFlag(flags, "files-changed")),
    summary: stringFlag(flags, "summary"),
    bugsFound: parseCsv(stringFlag(flags, "bugs-found")),
    decisionsMade: parseCsv(stringFlag(flags, "decisions-made")),
    testsRun: parseCsv(stringFlag(flags, "tests-run")),
    risks: parseCsv(stringFlag(flags, "risks"))
  });
}
