import { retrieveMemoryForTask } from "@atlas/memory";
import path from "node:path";
import { promises as fs } from "node:fs";
import { runEgressSecretScan } from "@atlas/privacy";
import { CliUsageError, parseArgs, parseCsv, parseNumberFlag, stringFlag } from "../arguments.js";
import { CliBoundaryMessage, CliStatus, printCliEnvelope, printSafeText, setCliExitCode, writeCliUsage } from "../output.js";
import { assertPathInsideCwd, pathExists } from "../files.js";
import { normalizeGitPath, runGit } from "../git.js";
import { isRecord } from "../values.js";

export async function runPolicy(args: string[], cwd = process.cwd()): Promise<void> {
  const [subcommand, ...rest] = args;
  const { flags } = parseArgs(rest, {
    action: "value",
    json: "boolean",
    path: "value",
    paths: "value"
  }, 0);
  if (subcommand === "list") {
    const data = {
      decisions: ["allow", "warn", "block", "require_user_approval"],
      highRiskActions: ["publish", "deploy", "migration", "memory_export", "destructive_cleanup"]
    };
    if (flags.json) {
      printCliEnvelope("lmti.policy.list", "pass", [], [], data);
      return;
    }
    printSafeText(["LMTI Policy Actions", "", ...data.highRiskActions.map((action) => `- ${action}`)].join("\n"));
    return;
  }
  if (subcommand !== "check") {
    throw new CliUsageError("Usage: lmti policy <check|list> [--action publish] [--json]");
  }
  const action = stringFlag(flags, "action");
  if (!action) {
    writeCliUsage("lmti.policy.check", "Usage: lmti policy check --action <action> [--path <path>] [--json]", Boolean(flags.json));
    return;
  }
  const result = evaluatePolicyAction(action, parseCsv(stringFlag(flags, "path") ?? stringFlag(flags, "paths")), cwd);
  setCliExitCode(result.status);
  if (flags.json) {
    printCliEnvelope("lmti.policy.check", result.status, result.warnings, result.errors, result.data);
    return;
  }
  printSafeText(`LMTI Policy Check\n\nAction: ${action}\nDecision: ${result.data.decision}\nResult: ${result.status.toUpperCase()}`);
}

export async function runConfig(args: string[], cwd = process.cwd()): Promise<void> {
  const [subcommand, ...rest] = args;
  const { flags } = parseArgs(rest, { config: "value", json: "boolean" }, 0);
  if (!["show", "inspect", "validate"].includes(subcommand ?? "")) {
    throw new CliUsageError("Usage: lmti config <show|inspect|validate> [--json]");
  }
  const report = await inspectConfigCommand(cwd, stringFlag(flags, "config"));
  const commandName = `lmti.config.${subcommand}`;
  const status = report.errors.length > 0 ? "error" : report.warnings.length > 0 ? "warn" : "pass";
  setCliExitCode(status);
  if (flags.json) {
    printCliEnvelope(commandName, status, report.warnings, report.errors, report.data);
    return;
  }
  printSafeText([
    subcommand === "validate" ? "LMTI Config Validate" : "LMTI Config",
    "",
    `Path: ${report.data.path ?? "(missing)"}`,
    `Format: ${report.data.format ?? "(unknown)"}`,
    `Exists: ${report.data.exists ? "yes" : "no"}`,
    `Result: ${status.toUpperCase()}`
  ].join("\n"));
}

export async function runAgent(args: string[], cwd = process.cwd()): Promise<void> {
  const [subcommand, ...rest] = args;
  const { positional, flags } = parseArgs(rest, { intent: "value", json: "boolean", limit: "value" }, 1);
  if (subcommand === "inspect") {
    const data = {
      boundary: "CLI/API JSON only",
      directStorageAccess: false,
      rawSQLiteAccess: false,
      secretMemoryAllowed: false,
      commands: ["lmti skill route", "lmti skill show", "lmti memory retrieve", "lmti policy check", "lmti publish check"]
    };
    if (flags.json) {
      printCliEnvelope("lmti.agent.inspect", "pass", [], [], data);
      return;
    }
    printSafeText(["LMTI Agent Boundary", "", ...data.commands.map((command) => `- ${command}`)].join("\n"));
    return;
  }
  if (subcommand !== "context") {
    throw new CliUsageError("Usage: lmti agent <inspect|context> --intent <intent> [--json]");
  }
  const intent = stringFlag(flags, "intent") ?? positional[0];
  if (!intent) {
    writeCliUsage("lmti.agent.context", "Usage: lmti agent context --intent <intent> [--json]", Boolean(flags.json));
    return;
  }
  const results = await retrieveMemoryForTask(intent, {
    cwd,
    privacyMode: "safe",
    limit: parseNumberFlag(flags, "limit", 8)
  });
  const data = { intent, results, privacy: { max: "internal", secret: "blocked", doNotPrompt: "blocked" } };
  if (flags.json) {
    printCliEnvelope("lmti.agent.context", "pass", [], [], data);
    return;
  }
  printSafeText([
    "LMTI Agent Context",
    "",
    `Intent: ${intent}`,
    `Results: ${results.length}`,
    "Privacy: secret and do_not_prompt memory blocked"
  ].join("\n"));
}

export async function runCleanup(args: string[], cwd = process.cwd()): Promise<void> {
  const [subcommand, ...rest] = args;
  const { flags } = parseArgs(rest, { json: "boolean" }, 0);
  if (subcommand !== "check") {
    throw new CliUsageError("Usage: lmti cleanup check [--json]");
  }
  const reportPath = path.join(cwd, "docs", "cleanup-report.md");
  const reportExists = await pathExists(reportPath);
  const gitStatus = runGit(cwd, ["status", "--porcelain=v1"]);
  const dirty = gitStatus.ok && gitStatus.stdout.trim().length > 0;
  const checks = [
    { check: "cleanup_report", status: reportExists ? "pass" : "warn", detail: reportExists ? "docs/cleanup-report.md exists" : "cleanup report is missing" },
    { check: "working_tree", status: dirty ? "warn" : "pass", detail: dirty ? "working tree has local changes" : "working tree clean" }
  ];
  const status: CliStatus = checks.some((check) => check.status === "warn") ? "warn" : "pass";
  const warnings = checks.filter((check) => check.status === "warn").map((check) => ({ code: "CONFIG_INVALID", message: check.detail }));
  setCliExitCode(status);
  if (flags.json) {
    printCliEnvelope("lmti.cleanup.check", status, warnings, [], { checks });
    return;
  }
  printSafeText([
    "LMTI Cleanup Check",
    "",
    "| Check | Status | Detail |",
    "|---|---|---|",
    ...checks.map((check) => `| ${check.check} | ${check.status.toUpperCase()} | ${check.detail} |`),
    "",
    `Result: ${status.toUpperCase()}`
  ].join("\n"));
}

function evaluatePolicyAction(action: string, paths: string[], cwd: string): { status: CliStatus; warnings: CliBoundaryMessage[]; errors: CliBoundaryMessage[]; data: { action: string; decision: string; paths: string[] } } {
  const normalized = action.trim().toLowerCase();
  const protectedPaths = paths.filter((entry) => isProtectedCommandPath(path.relative(cwd, path.resolve(cwd, entry))));
  if (protectedPaths.length > 0) {
    return {
      status: "blocked",
      warnings: [],
      errors: [{ code: "PROTECTED_FILE_DETECTED", message: "Protected file path is not allowed through the safety gate." }],
      data: { action: normalized, decision: "block", paths: protectedPaths }
    };
  }
  const highRisk = new Set(["publish", "push", "pull_request", "deploy", "migration", "memory_export", "database_migration", "destructive_cleanup"]);
  if (highRisk.has(normalized)) {
    return {
      status: "warn",
      warnings: [{ code: "POLICY_APPROVAL_REQUIRED", message: "High-risk action requires explicit safety gate approval." }],
      errors: [],
      data: { action: normalized, decision: "require_user_approval", paths }
    };
  }
  return { status: "pass", warnings: [], errors: [], data: { action: normalized, decision: "allow", paths } };
}

function isProtectedCommandPath(filePath: string): boolean {
  return /(^|[/\\])\.env(?:$|[./\\_-])|(^|[/\\])secrets([/\\]|$)|\.(?:pem|key|p12|pfx|token)$/iu.test(filePath);
}

async function inspectConfigCommand(cwd: string, customPath?: string): Promise<{ warnings: CliBoundaryMessage[]; errors: CliBoundaryMessage[]; data: { exists: boolean; path?: string; format?: "toml" | "json"; sections: string[]; keys: string[] } }> {
  const candidates = customPath
    ? [path.resolve(cwd, customPath)]
    : [path.join(cwd, ".lmti", "config.toml"), path.join(cwd, ".lmti", "config.json")];
  let foundPath: string | undefined;
  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      foundPath = candidate;
      break;
    }
  }
  if (!foundPath) {
    return {
      warnings: [],
      errors: [{ code: "CONFIG_INVALID", message: "No LMTI config file was found." }],
      data: { exists: false, sections: [], keys: [] }
    };
  }
  assertPathInsideCwd(cwd, foundPath, "config");
  const content = await fs.readFile(foundPath, "utf8");
  const format = foundPath.endsWith(".toml") ? "toml" : "json";
  const warnings: CliBoundaryMessage[] = [];
  const errors: CliBoundaryMessage[] = [];
  const scan = runEgressSecretScan(content);
  if (scan.blocked) {
    warnings.push({ code: "SECRET_DETECTED", message: "Config contains secret-like material; raw values were not printed." });
  }
  let sections: string[] = [];
  let keys: string[] = [];
  if (format === "json") {
    try {
      const parsed = JSON.parse(content) as unknown;
      keys = isRecord(parsed) ? Object.keys(parsed).sort() : [];
      warnings.push({ code: "CONFIG_INVALID", message: "JSON config is supported for the current TypeScript CLI, but TOML is the target human config format." });
    } catch {
      errors.push({ code: "CONFIG_INVALID", message: "Config JSON is invalid." });
    }
  } else {
    sections = Array.from(content.matchAll(/^\s*\[([^\]]+)\]\s*$/gmu)).map((match) => match[1]).sort();
    keys = Array.from(content.matchAll(/^\s*([A-Za-z0-9_.-]+)\s*=/gmu)).map((match) => match[1]).sort();
  }
  return {
    warnings,
    errors,
    data: {
      exists: true,
      path: normalizeGitPath(path.relative(cwd, foundPath)),
      format,
      sections,
      keys
    }
  };
}
