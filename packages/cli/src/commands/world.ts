import { contextPackToSensoryInputs, contextPackToBeliefs, runWorldModelCycle, estimateComputeCost } from "@atlas/world-model";
import { CliUsageError, parseArgs, parseCsv, parseNumberFlag, parsePromptPolicy, parseRole, parseSensitivity, stringFlag } from "../arguments.js";
import { contextCommand } from "./context.js";
import { printSafeJson } from "../output.js";
import { detectProjectId } from "./memory-records.js";

export async function runWorld(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case "check":
      await runWorldCheck(rest, "check");
      return;
    case "align":
      await runWorldCheck(rest, "align");
      return;
    case "cost":
      await runWorldCost(rest);
      return;
    case "observe":
      await runWorldObserve(rest);
      return;
    default:
      throw new CliUsageError('Usage: lmti world <check|cost|align|observe> "<task or input>"');
  }
}

async function runWorldCheck(args: string[], mode: "check" | "align"): Promise<void> {
  const { positional, flags } = parseArgs(args, {
    adapter: "value",
    "adapter-manifest": "value",
    "include-low-score": "boolean",
    "include-raw": "boolean",
    "include-secret": "boolean",
    "include-secret-meta": "boolean",
    "max-compute-cost": "value",
    "max-files": "value",
    "max-memory-items": "value",
    "max-tokens": "value",
    "memory-source": "value",
    role: "value"
  }, 2);
  const task = positional[0];
  if (!task) {
    throw new CliUsageError(`Usage: lmti world ${mode} "<task>"`);
  }
  const context = await contextCommand(process.cwd(), task, {
    amfPath: positional[1],
    includeSecret: false,
    role: parseRole(stringFlag(flags, "role") ?? "developer"),
    flags: { ...flags, "include-secret": false }
  });
  const inputs = contextPackToSensoryInputs(context);
  const beliefs = contextPackToBeliefs(context);
  const result = runWorldModelCycle({
    projectId: context.project,
    task,
    inputs,
    beliefs,
    budget: {
      maxTokens: parseNumberFlag(flags, "max-tokens", 1800),
      maxFiles: parseNumberFlag(flags, "max-files", 12),
      maxMemoryItems: parseNumberFlag(flags, "max-memory-items", 12),
      maxComputeCost: parseNumberFlag(flags, "max-compute-cost", 80)
    }
  });

  if (mode === "align") {
    printSafeJson(result.alignment, "world align");
    return;
  }

  printSafeJson(
      {
        task,
        blanket: {
          observations: result.blanket.observations.length,
          noiseFiltered: result.blanket.noiseFiltered,
          privacyFiltered: result.blanket.privacyFiltered
        },
        cost: result.cost,
        alignment: {
          predictionError: result.alignment.predictionError,
          uncertainty: result.alignment.uncertainty
        },
        realityCheck: result.realityCheck,
        proposedActions: result.proposedActions.map((action) => ({
          kind: action.kind,
          title: action.title,
          riskLevel: action.riskLevel,
          requiresPermission: action.requiresPermission
        })),
        explanation: result.explanation
      },
      "world check"
  );
}

async function runWorldCost(args: string[]): Promise<void> {
  const { positional, flags } = parseArgs(args, {
    "max-compute-cost": "value",
    "max-files": "value",
    "max-memory-items": "value",
    "max-tokens": "value",
    "source-refs": "value"
  }, 1);
  const task = positional[0];
  if (!task) {
    throw new CliUsageError('Usage: lmti world cost "<task>"');
  }
  const cost = estimateComputeCost(
    { text: task, sourceRefs: parseCsv(stringFlag(flags, "source-refs")) },
    {
      maxTokens: parseNumberFlag(flags, "max-tokens", 1800),
      maxFiles: parseNumberFlag(flags, "max-files", 12),
      maxMemoryItems: parseNumberFlag(flags, "max-memory-items", 12),
      maxComputeCost: parseNumberFlag(flags, "max-compute-cost", 80)
    }
  );
  printSafeJson(cost, "world cost");
}

async function runWorldObserve(args: string[]): Promise<void> {
  const { positional, flags } = parseArgs(args, {
    confidence: "value",
    "project-id": "value",
    "prompt-policy": "value",
    sensitivity: "value",
    "source-refs": "value"
  }, 1);
  const input = positional[0];
  if (!input) {
    throw new CliUsageError('Usage: lmti world observe "<input>"');
  }
  const result = runWorldModelCycle({
    projectId: stringFlag(flags, "project-id") ?? (await detectProjectId()),
    task: input,
    inputs: [{
      id: "cli-input",
      source: "user",
      content: input,
      sourceRefs: parseCsv(stringFlag(flags, "source-refs")),
      timestamp: new Date().toISOString(),
      confidence: parseNumberFlag(flags, "confidence", 0.8),
      sensitivity: parseSensitivity(stringFlag(flags, "sensitivity") ?? "internal"),
      promptPolicy: parsePromptPolicy(stringFlag(flags, "prompt-policy") ?? "summarize_only")
    }]
  });
  printSafeJson(result.blanket, "world observe");
}
