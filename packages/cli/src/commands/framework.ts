import { listFrameworkAdapters, ensureFrameworkConfig, detectFramework, renderFrameworkDetectionHtml, formatFrameworkDetection, getFrameworkAdapter, renderFrameworkCommandsHtml, renderFrameworkRiskZonesHtml, createFrameworkVerificationPlan, renderFrameworkVerificationHtml, createMonorepoMap, renderMonorepoMapHtml } from "@atlas/frameworks";
import { printSafeJson, printSafeText } from "../output.js";
import { CliUsageError, parseArgs, parseCsv, stringFlag } from "../arguments.js";

export async function runFramework(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case "detect":
      await runFrameworkDetect(rest);
      return;
    case "list":
      parseArgs(rest, {  }, 0);
      printSafeJson(listFrameworkAdapters().map((adapter) => ({ name: adapter.name, language: adapter.language })), "framework list");
      return;
    case "info":
      await runFrameworkInfo(rest);
      return;
    case "commands":
      await runFrameworkCommands(rest);
      return;
    case "risk-zones":
      await runFrameworkRiskZones(rest);
      return;
    case "verify-plan":
      await runFrameworkVerifyPlan(rest);
      return;
    case "monorepo-map":
      await runFrameworkMonorepoMap(rest);
      return;
    default:
      throw new CliUsageError('Usage: lmti framework <detect|list|info|commands|risk-zones|verify-plan|monorepo-map>');
  }
}

export async function frameworkDetectCommand(cwd: string) {
  await ensureFrameworkConfig(cwd);
  return detectFramework({ repoRoot: cwd });
}

async function runFrameworkDetect(args: string[]): Promise<void> {
  const { flags } = parseArgs(args, { html: "boolean", json: "boolean" }, 0);
  const result = await frameworkDetectCommand(process.cwd());
  if (flags.html) {
    printSafeText(renderFrameworkDetectionHtml(result));
    return;
  }
  if (flags.json) {
    printSafeJson(result, "framework detect");
    return;
  }
  printSafeText(formatFrameworkDetection(result));
}

async function runFrameworkInfo(args: string[]): Promise<void> {
  const { positional, flags } = parseArgs(args, { framework: "value" }, 1);
  const detection = await detectFramework({ repoRoot: process.cwd() });
  const name = positional[0] ?? stringFlag(flags, "framework") ?? detection.primaryFramework;
  const adapter = getFrameworkAdapter(name);
  if (!adapter) {
    throw new Error(`Unknown framework adapter: ${name}`);
  }
  printSafeJson({
    name: adapter.name,
    language: adapter.language,
    active: adapter.name === detection.primaryFramework,
    detected: detection.primaryFramework,
    confidence: detection.confidence
  }, "framework info");
}

async function runFrameworkCommands(args: string[]): Promise<void> {
  const { positional, flags } = parseArgs(args, { framework: "value", html: "boolean" }, 1);
  const detection = await detectFramework({ repoRoot: process.cwd() });
  const name = positional[0] ?? stringFlag(flags, "framework") ?? detection.primaryFramework;
  const adapter = getFrameworkAdapter(name) ?? getFrameworkAdapter("generic");
  if (!adapter) {
    throw new Error(`Unknown framework adapter: ${name}`);
  }
  const commands = await adapter.getDefaultCommands(process.cwd());
  if (flags.html) {
    printSafeText(renderFrameworkCommandsHtml({ framework: adapter.name, commands }));
    return;
  }
  printSafeJson({ framework: adapter.name, commands }, "framework commands");
}

async function runFrameworkRiskZones(args: string[]): Promise<void> {
  const { positional, flags } = parseArgs(args, { framework: "value", html: "boolean" }, 1);
  const detection = await detectFramework({ repoRoot: process.cwd() });
  const name = positional[0] ?? stringFlag(flags, "framework") ?? detection.primaryFramework;
  const adapter = getFrameworkAdapter(name) ?? getFrameworkAdapter("generic");
  if (!adapter) {
    throw new Error(`Unknown framework adapter: ${name}`);
  }
  const zones = await adapter.getRiskZones(process.cwd());
  if (flags.html) {
    printSafeText(renderFrameworkRiskZonesHtml({ framework: adapter.name, zones }));
    return;
  }
  printSafeJson({ framework: adapter.name, zones }, "framework risk-zones");
}

async function runFrameworkVerifyPlan(args: string[]): Promise<void> {
  const { flags } = parseArgs(args, {
    files: "value",
    framework: "value",
    html: "boolean",
    "risk-level": "value",
    task: "value"
  }, 0);
  const task = stringFlag(flags, "task");
  if (!task) {
    throw new CliUsageError('Usage: lmti framework verify-plan --task "..." [--files "a,b"]');
  }
  const detection = await detectFramework({ repoRoot: process.cwd() });
  const plan = await createFrameworkVerificationPlan({
    framework: stringFlag(flags, "framework") ?? detection.primaryFramework,
    task,
    filesChanged: parseCsv(stringFlag(flags, "files")),
    riskLevel: stringFlag(flags, "risk-level") ?? "medium",
    repoRoot: process.cwd()
  });
  if (flags.html) {
    printSafeText(renderFrameworkVerificationHtml(plan));
    return;
  }
  printSafeJson(plan, "framework verify-plan");
}

async function runFrameworkMonorepoMap(args: string[]): Promise<void> {
  const { flags } = parseArgs(args, { html: "boolean" }, 0);
  const map = await createMonorepoMap({ repoRoot: process.cwd() });
  if (flags.html) {
    printSafeText(renderMonorepoMapHtml(map));
    return;
  }
  printSafeJson(map, "framework monorepo-map");
}
