import path from "node:path";
import { promises as fs } from "node:fs";
import { runEgressSecretScan } from "@atlas/privacy";
import { CliBoundaryMessage, CliStatus, printCliEnvelope, printSafeText, setCliExitCode, writeCliUsage } from "../output.js";
import { CliUsageError, parseArgs } from "../arguments.js";
import { parseTomlBoolean, parseTomlString, parseTomlStringArray } from "../toml.js";
import { assertPathInsideCwd, escapeRegExp } from "../files.js";

interface LmtiSkillDefinition {
  id: string;
  name: string;
  description: string;
  file: string;
  intents: string[];
  requiresPolicy: boolean;
  requiresMemory: boolean;
  riskLevel: "low" | "medium" | "high" | string;
}

interface LmtiSkillRouteOutcome {
  status: CliStatus;
  warnings: CliBoundaryMessage[];
  errors: CliBoundaryMessage[];
  result: {
    request: string;
    intent: string;
    decision: "skill_selected" | "multiple_candidates" | "no_skill_found" | "invalid_registry";
    selectedSkill?: {
      id: string;
      name: string;
      file: string;
      riskLevel: string;
    };
    candidates: Array<{
      id: string;
      score: number;
      intent: string;
      riskLevel: string;
      reason: string;
    }>;
    secondarySkills: Array<{ id: string; reason: string }>;
    requiresPolicy: boolean;
    requiresMemory: boolean;
    requiredPolicyGates: string[];
    recommendedCommands: string[];
    memoryRequest?: {
      intent: string;
      privacyMax: "public" | "internal";
      includeLessons: boolean;
      includeRelatedFiles: boolean;
    };
    reason: string;
  };
}

export async function runSkill(args: string[], cwd = process.cwd()): Promise<void> {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case "list":
      await runSkillList(rest, cwd, "lmti.skill.list");
      return;
    case "route":
      await runSkillRoute(rest, cwd, "lmti.skill.route");
      return;
    case "show":
      await runSkillShow(rest, cwd, "lmti.skill.show");
      return;
    case "validate":
      await runSkillValidate(rest, cwd, "lmti.skill.validate");
      return;
    case "help":
    case "--help":
    case undefined:
      parseArgs(rest, {}, 0);
      printSkillHelp();
      return;
    default:
      throw new CliUsageError("Usage: lmti skill <list|route|show|validate> [--json]");
  }
}

export async function runThoth(args: string[], cwd = process.cwd()): Promise<void> {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case "list":
      await runSkillList(rest, cwd, "lmti.thoth.list");
      return;
    case "route":
      await runSkillRoute(rest, cwd, "lmti.thoth.route");
      return;
    case "show":
      await runSkillShow(rest, cwd, "lmti.thoth.show");
      return;
    case "validate":
      await runSkillValidate(rest, cwd, "lmti.thoth.validate");
      return;
    case "explain":
      await runThothExplain(rest, cwd);
      return;
    case "inspect":
      await runThothInspect(rest, cwd);
      return;
    case "doctor":
      await runThothDoctor(rest, cwd);
      return;
    case "help":
    case "--help":
    case undefined:
      parseArgs(rest, {}, 0);
      printThothHelp();
      return;
    default:
      throw new CliUsageError("Usage: lmti thoth <list|route|explain|show|inspect|validate|doctor> [--json]");
  }
}

async function runSkillList(args: string[], cwd: string, commandName: string): Promise<void> {
  const { flags } = parseArgs(args, { json: "boolean" }, 0);
  const registry = await readSkillRegistry(cwd);
  if (flags.json) {
    printCliEnvelope(commandName, "pass", [], [], { skills: registry });
    return;
  }
  const lines = [
    "LMTI Skills",
    "",
    "| Skill | Intent | Risk | Policy | Memory |",
    "|---|---|---|---|---|",
    ...registry.map((skill) => `| ${skill.id} | ${skill.intents.join(", ")} | ${skill.riskLevel} | ${skill.requiresPolicy ? "yes" : "no"} | ${skill.requiresMemory ? "yes" : "no"} |`)
  ];
  printSafeText(lines.join("\n"));
}

async function runSkillRoute(args: string[], cwd: string, commandName: string): Promise<void> {
  const { positional, flags } = parseArgs(args, { json: "boolean" }, Infinity);
  const request = positional.join(" ").trim();
  if (!request) {
    writeCliUsage(commandName, `Usage: ${commandName.replace(/\./gu, " ")} "<task>" [--json]`, Boolean(flags.json));
    return;
  }
  const outcome = await routeSkillCommand(cwd, request);
  setCliExitCode(outcome.status);
  if (flags.json) {
    printCliEnvelope(commandName, outcome.status, outcome.warnings, outcome.errors, outcome.result);
    return;
  }
  printSkillRoute(outcome);
}

async function runSkillShow(args: string[], cwd: string, commandName: string): Promise<void> {
  const { positional, flags } = parseArgs(args, { json: "boolean" }, 1);
  const id = positional[0];
  if (!id) {
    writeCliUsage(commandName, `Usage: ${commandName.replace(/\./gu, " ")} <skill-id> [--json]`, Boolean(flags.json));
    return;
  }
  const result = await loadSkillContentCommand(cwd, id);
  setCliExitCode(result.status);
  if (flags.json) {
    printCliEnvelope(commandName, result.status, result.warnings, result.errors, result.data);
    return;
  }
  if (result.errors.length > 0) {
    printSafeText(result.errors.map((error) => `${error.code}: ${error.message}`).join("\n"));
    return;
  }
  printSafeText(result.data.content);
}

async function runSkillValidate(args: string[], cwd: string, commandName: string): Promise<void> {
  const { flags } = parseArgs(args, { json: "boolean" }, 0);
  const report = await validateSkillsCommand(cwd);
  setCliExitCode(report.status);
  if (flags.json) {
    printCliEnvelope(commandName, report.status, report.warnings, report.errors, report.data);
    return;
  }
  const lines = [
    "LMTI Skill Validation",
    "",
    "| Check | Status | Detail |",
    "|---|---|---|",
    ...report.data.checks.map((check) => `| ${check.check} | ${check.status.toUpperCase()} | ${check.detail.replace(/\|/gu, "\\|")} |`),
    "",
    `Result: ${report.status.toUpperCase()}`
  ];
  printSafeText(lines.join("\n"));
}

async function runThothExplain(args: string[], cwd: string): Promise<void> {
  const { positional, flags } = parseArgs(args, { json: "boolean" }, Infinity);
  const request = positional.join(" ").trim();
  if (!request) {
    writeCliUsage("lmti.thoth.explain", 'Usage: lmti thoth explain "<task>" [--json]', Boolean(flags.json));
    return;
  }
  const outcome = await routeSkillCommand(cwd, request);
  const explanation = {
    request,
    selectedSkill: outcome.result.selectedSkill?.id,
    intent: outcome.result.intent,
    why: outcome.result.reason,
    recommendedFlow: outcome.result.recommendedCommands
  };
  setCliExitCode(outcome.status);
  if (flags.json) {
    printCliEnvelope("lmti.thoth.explain", outcome.status, outcome.warnings, outcome.errors, explanation);
    return;
  }
  printSafeText([
    "LMTI Thoth Explain",
    "",
    `Intent: ${explanation.intent}`,
    `Selected skill: ${explanation.selectedSkill ?? "none"}`,
    `Why: ${explanation.why}`,
    "",
    "Recommended flow:",
    ...explanation.recommendedFlow.map((step, index) => `${index + 1}. ${step}`)
  ].join("\n"));
}

async function runThothInspect(args: string[], cwd: string): Promise<void> {
  const { positional, flags } = parseArgs(args, { json: "boolean" }, 1);
  const id = positional[0];
  if (!id) {
    writeCliUsage("lmti.thoth.inspect", "Usage: lmti thoth inspect <skill-id> [--json]", Boolean(flags.json));
    return;
  }
  const registry = await readSkillRegistry(cwd);
  const skill = registry.find((item) => item.id === id);
  const status: CliStatus = skill ? "pass" : "error";
  const errors = skill ? [] : [{ code: "THOTH_SKILL_NOT_FOUND", message: "Skill id was not found in skills/registry.toml." }];
  setCliExitCode(status);
  if (flags.json) {
    printCliEnvelope("lmti.thoth.inspect", status, [], errors, { skill });
    return;
  }
  printSafeText(skill ? [`Skill: ${skill.id}`, `File: ${skill.file}`, `Risk: ${skill.riskLevel}`, `Intents: ${skill.intents.join(", ")}`].join("\n") : errors[0].message);
}

async function runThothDoctor(args: string[], cwd: string): Promise<void> {
  const { flags } = parseArgs(args, { json: "boolean" }, 0);
  const report = await validateSkillsCommand(cwd);
  setCliExitCode(report.status);
  if (flags.json) {
    printCliEnvelope("lmti.thoth.doctor", report.status, report.warnings, report.errors, report.data);
    return;
  }
  printSafeText(`LMTI Thoth Doctor\n\nResult: ${report.status.toUpperCase()}\nSkills checked: ${report.data.skillsChecked}`);
}

export async function routeSkillCommand(cwd: string, request: string): Promise<LmtiSkillRouteOutcome> {
  let registry: LmtiSkillDefinition[];
  try {
    registry = await readSkillRegistry(cwd);
  } catch (error) {
    return {
      status: "error",
      warnings: [],
      errors: [{ code: "THOTH_REGISTRY_MISSING", message: error instanceof Error ? error.message : String(error) }],
      result: {
        request,
        intent: "unknown",
        decision: "invalid_registry",
        candidates: [],
        secondarySkills: [],
        requiresPolicy: false,
        requiresMemory: false,
        requiredPolicyGates: [],
        recommendedCommands: [],
        reason: "Skill registry could not be loaded."
      }
    };
  }

  const scored = registry
    .map((skill) => scoreSkillForRequest(skill, request))
    .filter((skill) => skill.score > 0)
    .sort((left, right) => right.score - left.score || riskLevelRank(right.skill.riskLevel) - riskLevelRank(left.skill.riskLevel) || left.skill.id.localeCompare(right.skill.id));

  if (scored.length === 0) {
    return {
      status: "warn",
      warnings: [{ code: "THOTH_NO_SKILL_FOUND", message: "No suitable skill was found for this request." }],
      errors: [],
      result: {
        request,
        intent: "unknown",
        decision: "no_skill_found",
        candidates: [],
        secondarySkills: [],
        requiresPolicy: false,
        requiresMemory: false,
        requiredPolicyGates: [],
        recommendedCommands: [],
        reason: "No registered skill matched this request."
      }
    };
  }

  const selected = scored[0];
  const secondary = scored.slice(1);
  const status: CliStatus = secondary.length > 0 ? "warn" : "pass";
  const selectedSkill = selected.skill;
  return {
    status,
    warnings: secondary.length > 0 ? [{ code: "THOTH_MULTIPLE_SKILLS_MATCHED", message: "More than one skill matched the request. LMTI selected the highest-risk relevant skill first." }] : [],
    errors: [],
    result: {
      request,
      intent: selected.intent,
      decision: secondary.length > 0 ? "multiple_candidates" : "skill_selected",
      selectedSkill: {
        id: selectedSkill.id,
        name: selectedSkill.name,
        file: selectedSkill.file,
        riskLevel: selectedSkill.riskLevel
      },
      candidates: scored.map((item) => ({
        id: item.skill.id,
        score: Math.round(item.score) / 100,
        intent: item.intent,
        riskLevel: item.skill.riskLevel,
        reason: item.reason
      })),
      secondarySkills: secondary.map((item) => ({
        id: item.skill.id,
        reason: `${item.skill.id} matched too, but ${selectedSkill.id} has higher priority for this request.`
      })),
      requiresPolicy: selectedSkill.requiresPolicy,
      requiresMemory: selectedSkill.requiresMemory,
      requiredPolicyGates: policyGatesForSkill(selectedSkill),
      recommendedCommands: recommendedCommandsForSkill(selectedSkill, selected.intent),
      memoryRequest: selectedSkill.requiresMemory
        ? { intent: selected.intent, privacyMax: "internal", includeLessons: true, includeRelatedFiles: true }
        : undefined,
      reason: selected.reason
    }
  };
}

async function readSkillRegistry(cwd: string): Promise<LmtiSkillDefinition[]> {
  const registryPath = path.join(cwd, "skills", "registry.toml");
  const text = await fs.readFile(registryPath, "utf8");
  const skills = parseSkillRegistryToml(text);
  if (skills.length === 0) {
    throw new Error("skills/registry.toml contains no skills.");
  }
  return skills;
}

function parseSkillRegistryToml(text: string): LmtiSkillDefinition[] {
  const blocks = text.split(/\[\[skills\]\]/u).slice(1);
  return blocks.map((block) => {
    const raw: Record<string, string> = {};
    for (const line of block.split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }
      const match = trimmed.match(/^([a-z_]+)\s*=\s*(.+)$/u);
      if (match) {
        raw[match[1]] = match[2].trim();
      }
    }
    return {
      id: parseTomlString(raw.id),
      name: parseTomlString(raw.name),
      description: parseTomlString(raw.description),
      file: parseTomlString(raw.file),
      intents: parseTomlStringArray(raw.intents),
      requiresPolicy: parseTomlBoolean(raw.requires_policy),
      requiresMemory: parseTomlBoolean(raw.requires_memory),
      riskLevel: parseTomlString(raw.risk_level)
    };
  }).filter((skill) => skill.id && skill.file);
}

function scoreSkillForRequest(skill: LmtiSkillDefinition, request: string): { skill: LmtiSkillDefinition; score: number; intent: string; reason: string } {
  const normalizedRequest = normalizeCommandText(request);
  let score = 0;
  let bestIntent = "unknown";
  for (const intent of skill.intents) {
    const canonical = canonicalSkillIntent(intent);
    const normalizedIntent = normalizeCommandText(intent);
    if (normalizedIntent && normalizedRequest.includes(normalizedIntent)) {
      score += 40;
      bestIntent = canonical;
    }
    const aliases = skillIntentAliases(canonical);
    for (const alias of aliases) {
      if (normalizedRequest.includes(alias)) {
        score += 18;
        bestIntent = canonical;
      }
    }
  }
  const corpus = normalizeCommandText(`${skill.id} ${skill.name} ${skill.description}`);
  for (const token of normalizedRequest.split(" ").filter((part) => part.length > 2)) {
    if (corpus.includes(token)) {
      score += 3;
    }
  }
  if (score > 0) {
    score += riskLevelRank(skill.riskLevel) * 2;
  }
  return { skill, score, intent: bestIntent, reason: routeReasonForIntent(bestIntent) };
}

function normalizeCommandText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_]+/gu, " ").replace(/\s+/gu, " ").trim();
}

function canonicalSkillIntent(intent: string): string {
  const normalized = normalizeCommandText(intent).replace(/\s/gu, "_");
  if (["publish", "push", "pull_request", "open_source", "release"].includes(normalized)) return "publish";
  if (["cleanup", "refactor", "remove_unused", "organize_repo"].includes(normalized)) return "repo_cleanup";
  if (["security", "secret_scan", "privacy", "leak_check"].includes(normalized)) return "security";
  if (["memory", "context", "lesson", "retrieve"].includes(normalized)) return "memory";
  if (["migrate", "json_to_sqlite", "storage_upgrade"].includes(normalized)) return "migration";
  if (["readme", "docs", "documentation", "publish_docs"].includes(normalized)) return "documentation";
  if (["doctor", "health_check", "validate_setup"].includes(normalized)) return "doctor";
  if (["adapter", "agent_adapter", "plugin"].includes(normalized)) return "adapter";
  return normalized || "unknown";
}

function skillIntentAliases(intent: string): string[] {
  switch (intent) {
    case "publish":
      return ["publish", "push", "pull request", "pr", "open source", "release", "remote"];
    case "repo_cleanup":
      return ["cleanup", "clean up", "refactor", "unused", "organize", "stabilize"];
    case "security":
      return ["security", "secret", "privacy", "leak", "protected file"];
    case "memory":
      return ["memory", "context", "lesson", "retrieve"];
    case "migration":
      return ["migrate", "migration", "json", "sqlite", "storage"];
    case "documentation":
      return ["docs", "documentation", "readme", "commands"];
    case "doctor":
      return ["doctor", "health", "validate", "diagnose"];
    case "adapter":
      return ["adapter", "agent", "plugin", "connector"];
    default:
      return [];
  }
}

function routeReasonForIntent(intent: string): string {
  switch (intent) {
    case "publish":
      return "Publishing, pushing, PR, open-source, or release work requires publish checks first.";
    case "repo_cleanup":
      return "The request is about cleanup or refactoring while preserving behavior.";
    case "security":
      return "Security or secret-handling wording has priority because unsafe context can leak data.";
    case "memory":
      return "The request asks for memory or context retrieval through privacy gates.";
    case "migration":
      return "The request involves JSON, SQLite, storage, or migration behavior.";
    case "documentation":
      return "The request is documentation-oriented.";
    case "doctor":
      return "The request is a system health or validation check.";
    case "adapter":
      return "The request concerns adapter or agent integration boundaries.";
    default:
      return "The request matched registered skill metadata.";
  }
}

function riskLevelRank(risk: string): number {
  if (risk === "high") return 3;
  if (risk === "medium") return 2;
  if (risk === "low") return 1;
  return 0;
}

function policyGatesForSkill(skill: LmtiSkillDefinition): string[] {
  if (!skill.requiresPolicy) {
    return [];
  }
  switch (skill.id) {
    case "publish-preflight":
      return ["GitRemotePolicy", "BranchHistoryPolicy", "ProtectedFilesPolicy", "SecretLeakPolicy"];
    case "security-check":
      return ["SecretLeakPolicy", "PrivacyBoundaryPolicy", "ProtectedFilesPolicy"];
    case "migration-from-json":
      return ["MigrationDryRunPolicy", "SecretImportPolicy", "StorageBackupPolicy"];
    case "repo-cleanup":
      return ["ProtectedFilesPolicy", "BehaviorPreservationPolicy"];
    case "adapter":
      return ["AdapterManifestPolicy", "SandboxScopePolicy"];
    default:
      return ["DefaultSafetyPolicy"];
  }
}

function recommendedCommandsForSkill(skill: LmtiSkillDefinition, intent: string): string[] {
  switch (skill.id) {
    case "publish-preflight":
      return ["lmti publish check"];
    case "repo-cleanup":
      return ["lmti skill show repo-cleanup", "lmti cleanup check"];
    case "security-check":
      return ["lmti doctor --security --json", "lmti publish check --json"];
    case "memory-retrieval":
      return [`lmti memory retrieve --intent ${intent} --json`];
    case "migration-from-json":
      return ["lmti migrate from-json --dry-run", "lmti migrate from-json"];
    case "documentation":
      return ["lmti skill show documentation"];
    case "doctor":
      return ["lmti doctor --json"];
    case "adapter":
      return ["lmti skill show adapter", "lmti agent inspect --json"];
    default:
      return [`lmti skill show ${skill.id}`];
  }
}

async function loadSkillContentCommand(cwd: string, id: string): Promise<{ status: CliStatus; warnings: CliBoundaryMessage[]; errors: CliBoundaryMessage[]; data: { skill?: LmtiSkillDefinition; content: string } }> {
  const registry = await readSkillRegistry(cwd);
  const skill = registry.find((item) => item.id === id);
  if (!skill) {
    return {
      status: "error",
      warnings: [],
      errors: [{ code: "THOTH_SKILL_NOT_FOUND", message: "Skill id was not found in skills/registry.toml." }],
      data: { content: "" }
    };
  }
  const skillPath = path.resolve(cwd, skill.file);
  assertPathInsideCwd(cwd, skillPath, "skill file");
  const statResult = await fs.stat(skillPath);
  if (statResult.size > 128 * 1024) {
    return {
      status: "error",
      warnings: [],
      errors: [{ code: "THOTH_SKILL_INVALID", message: `${skill.file} is unusually large for a skill.md file.` }],
      data: { skill, content: "" }
    };
  }
  const content = await fs.readFile(skillPath, "utf8");
  const scan = runEgressSecretScan(content);
  if (scan.blocked) {
    return {
      status: "blocked",
      warnings: [],
      errors: [{ code: "SECRET_DETECTED", message: `${skill.file} contains secret-like material and will not be printed.` }],
      data: { skill, content: "" }
    };
  }
  return { status: "pass", warnings: [], errors: [], data: { skill, content } };
}

async function validateSkillsCommand(cwd: string): Promise<{ status: CliStatus; warnings: CliBoundaryMessage[]; errors: CliBoundaryMessage[]; data: { skillsChecked: number; checks: Array<{ check: string; status: CliStatus; detail: string }> } }> {
  const checks: Array<{ check: string; status: CliStatus; detail: string }> = [];
  let registry: LmtiSkillDefinition[] = [];
  try {
    registry = await readSkillRegistry(cwd);
    checks.push({ check: "registry", status: "pass", detail: `${registry.length} skills registered` });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "error",
      warnings: [],
      errors: [{ code: "THOTH_REGISTRY_MISSING", message }],
      data: { skillsChecked: 0, checks: [{ check: "registry", status: "error", detail: message }] }
    };
  }

  const duplicateIds = registry.map((skill) => skill.id).filter((id, index, ids) => ids.indexOf(id) !== index);
  checks.push({
    check: "duplicate_ids",
    status: duplicateIds.length > 0 ? "error" : "pass",
    detail: duplicateIds.length > 0 ? `duplicate ids: ${Array.from(new Set(duplicateIds)).join(", ")}` : "no duplicate skill ids"
  });

  const requiredSections = ["Purpose", "When to use", "Inputs needed", "Required commands", "Safety rules", "Block conditions", "Output expected"];
  for (const skill of registry) {
    const result = await loadSkillContentCommand(cwd, skill.id);
    if (result.errors.length > 0) {
      checks.push({ check: `skill:${skill.id}`, status: result.status, detail: result.errors.map((error) => error.message).join("; ") });
      continue;
    }
    const missing = requiredSections.filter((section) => !new RegExp(`^##\\s+${escapeRegExp(section)}\\b`, "imu").test(result.data.content));
    checks.push({
      check: `skill:${skill.id}`,
      status: missing.length > 0 ? "warn" : "pass",
      detail: missing.length > 0 ? `missing sections: ${missing.join(", ")}` : "required sections present"
    });
  }

  const errors = checks.filter((check) => check.status === "error").map((check) => ({ code: "THOTH_SKILL_INVALID", message: check.detail }));
  const warnings = checks.filter((check) => check.status === "warn").map((check) => ({ code: "THOTH_SKILL_INVALID", message: check.detail }));
  return {
    status: errors.length > 0 ? "error" : warnings.length > 0 ? "warn" : "pass",
    warnings,
    errors,
    data: { skillsChecked: registry.length, checks }
  };
}

function printSkillRoute(outcome: LmtiSkillRouteOutcome): void {
  const selected = outcome.result.selectedSkill;
  const lines = [
    "LMTI Skill Route",
    "",
    `Intent: ${outcome.result.intent}`,
    `Selected skill: ${selected ? selected.id : "none"}`,
    `Reason: ${outcome.result.reason}`,
    `Result: ${outcome.status.toUpperCase()}`
  ];
  if (outcome.result.recommendedCommands.length > 0) {
    lines.push("", "Recommended commands:", ...outcome.result.recommendedCommands.map((command) => `- ${command}`));
  }
  printSafeText(lines.join("\n"));
}

function printSkillHelp(): void {
  printSafeText(`Usage:
  lmti skill list [--json]
  lmti skill route "<task>" [--json]
  lmti skill show <skill-id> [--json]
  lmti skill validate [--json]

Description:
  Selects and loads skill.md instructions. These commands do not modify files.`);
}

function printThothHelp(): void {
  printSafeText(`Usage:
  lmti thoth <list|route|explain|show|inspect|validate|doctor> [--json]

Description:
  Advanced skill-routing commands. Thoth routes skills only; it does not execute tasks.`);
}
