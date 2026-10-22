import { initAtlasStorage, EXPERIMENTS_DIR } from "@atlas/memory";
import { buildContextPack } from "@atlas/kernel";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { AmfDocument, FileEntry, ModuleEntry } from "@atlas/types";
import { printSafeJson } from "../output.js";
import { migrateLegacyIfLmtiMissing } from "./workspace.js";
import { preflightCommand, readCompiledAmf } from "./context.js";
import { CliUsageError, parseArgs, parseNumberFlag, parseRole, stringFlag } from "../arguments.js";

export async function runExperiment(args: string[]): Promise<void> {
  const [kind, ...rest] = args;
  if (kind !== "thinking" || rest.length === 0) {
    throw new CliUsageError('Usage: lmti experiment thinking "<task>"');
  }

  const { positional } = parseArgs(rest, {});
  const task = positional.join(" ");
  if (!task) throw new CliUsageError('Usage: lmti experiment thinking "<task>"');
  const result = await thinkingExperimentCommand(process.cwd(), task);
  printSafeJson(result, "experiment");
}

export interface ThinkingExperimentResult {
  task: string;
  baseline: {
    estimatedFilesToInspect: number;
  };
  lmti: {
    selectedFiles: string[];
    selectedModules: string[];
    estimatedFilesToInspect: number;
  };
  reduction: {
    filesReduced: number;
    percent: number;
  };
}

export async function thinkingExperimentCommand(cwd: string, task: string): Promise<ThinkingExperimentResult> {
  await migrateLegacyIfLmtiMissing(cwd);
  const storage = await initAtlasStorage(cwd);
  const amf = await readCompiledAmf(cwd);
  const contextPack = buildContextPack(amf, task);
  const selectedFiles = contextPack.relatedFiles.map((file) => file.path);
  const selectedModules = contextPack.relatedModules.map((module) => module.name);
  const baselineFiles = estimateBaselineFiles(amf, task);
  const lmtiEstimatedFiles = selectedFiles.length;
  const filesReduced = Math.max(0, baselineFiles.length - lmtiEstimatedFiles);
  const percent = baselineFiles.length === 0 ? 0 : Math.round((filesReduced / baselineFiles.length) * 100);
  const result: ThinkingExperimentResult = {
    task,
    baseline: {
      estimatedFilesToInspect: baselineFiles.length
    },
    lmti: {
      selectedFiles,
      selectedModules,
      estimatedFilesToInspect: lmtiEstimatedFiles
    },
    reduction: {
      filesReduced,
      percent
    }
  };

  await fs.mkdir(path.join(storage.atlasDir, EXPERIMENTS_DIR), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(storage.atlasDir, EXPERIMENTS_DIR, "EXP-0001-thinking.json"), JSON.stringify(result, null, 2), { encoding: "utf8", mode: 0o600 });
  return result;
}

function estimateBaselineFiles(amf: AmfDocument, task: string): FileEntry[] {
  const keywords = tokenizeExperiment(task);
  if (keywords.length === 0) {
    return amf.files.slice(0, Math.min(amf.files.length, 20));
  }

  const moduleByName = new Map(amf.modules.map((module) => [module.name, module]));
  const matchedPaths = new Set<string>();

  for (const file of amf.files) {
    if (scoreFileForExperiment(file, keywords) > 0) {
      matchedPaths.add(file.path);
      addModuleFiles(moduleByName.get(file.module), matchedPaths);
    }
  }

  for (const rule of amf.rules) {
    if (scoreTextForExperiment(keywords, [rule.text, rule.source]) > 0) {
      matchedPaths.add(rule.source.split(":")[0]);
    }
  }

  for (const risk of amf.risks) {
    if (risk.file && scoreTextForExperiment(keywords, [risk.type, risk.message, risk.recommendation, risk.file]) > 0) {
      matchedPaths.add(risk.file);
    }
  }

  for (const entry of [...amf.api, ...amf.database]) {
    if (scoreTextForExperiment(keywords, [entry.name, entry.kind, entry.source, entry.summary]) > 0) {
      matchedPaths.add(entry.source.split(":")[0]);
    }
  }

  const files = amf.files.filter((file) => matchedPaths.has(file.path));
  if (files.length > 0) {
    return files;
  }

  return amf.files.slice(0, Math.min(amf.files.length, 20));
}

function addModuleFiles(module: ModuleEntry | undefined, paths: Set<string>): void {
  if (!module) {
    return;
  }
  for (const file of module.files) {
    paths.add(file);
  }
}

function scoreFileForExperiment(file: FileEntry, keywords: string[]): number {
  return scoreTextForExperiment(keywords, [file.path, file.module, file.kind, file.summary, ...file.riskFlags]);
}

function scoreTextForExperiment(keywords: string[], values: string[]): number {
  const corpus = normalizeExperimentText(values.join(" "));
  return keywords.reduce((score, keyword) => score + (corpus.includes(keyword) ? 1 : 0), 0);
}

function tokenizeExperiment(task: string): string[] {
  const stopWords = new Set(["the", "and", "for", "with", "that", "this", "from", "into", "fix", "bug"]);
  return Array.from(
    new Set(
      normalizeExperimentText(task)
        .split(/[^a-z0-9_]+/i)
        .map((part) => part.trim())
        .filter((part) => part.length >= 2 && !stopWords.has(part))
    )
  );
}

function normalizeExperimentText(value: string): string {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

export async function runBenchmark(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  if (subcommand !== "preflight") {
    throw new CliUsageError('Usage: lmti benchmark preflight "<task>" [--runs 5]');
  }

  const result = await benchmarkPreflightCommand(process.cwd(), rest);
  printSafeJson(result, "benchmark preflight");
}

export async function benchmarkPreflightCommand(cwd: string, args: string[]) {
  const { positional, flags } = parseArgs(args, {
    adapter: "value",
    "adapter-manifest": "value",
    "agent-id": "value",
    "include-low-score": "boolean",
    "memory-source": "value",
    "model-target": "value",
    role: "value",
    runs: "value",
    "token-budget": "value",
    "user-id": "value"
  }, 2);
  const task = positional[0];
  if (!task) {
    throw new CliUsageError('Usage: lmti benchmark preflight "<task>" [--runs 5]');
  }

  const runs = Math.max(1, Math.min(50, Math.floor(parseNumberFlag(flags, "runs", 5))));
  const samples = [];
  for (let index = 0; index < runs; index += 1) {
    const result = await preflightCommand(cwd, task, {
      amfPath: positional[1],
      role: parseRole(stringFlag(flags, "role") ?? "developer"),
      modelTarget: stringFlag(flags, "model-target") ?? "external_model",
      flags
    });
    samples.push({
      run: index + 1,
      latencyMs: result.metrics.latencyMs,
      phaseLatencyMs: result.metrics.phaseLatencyMs,
      adapterAllowed: result.adapterSandbox.allowed,
      egressBlocked: result.egress.blocked
    });
  }

  const latencies = samples.map((sample) => sample.latencyMs).sort((left, right) => left - right);
  return {
    task,
    runs,
    minLatencyMs: latencies[0],
    maxLatencyMs: latencies[latencies.length - 1],
    averageLatencyMs: Math.round((latencies.reduce((sum, value) => sum + value, 0) / latencies.length) * 100) / 100,
    p50LatencyMs: percentile(latencies, 0.5),
    p95LatencyMs: percentile(latencies, 0.95),
    samples
  };
}

function percentile(sortedValues: number[], percentileValue: number): number {
  if (sortedValues.length === 0) {
    return 0;
  }
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil(sortedValues.length * percentileValue) - 1));
  return sortedValues[index];
}
