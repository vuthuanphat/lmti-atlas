import { contextPackToCognitiveItems, runCognitiveCycle } from "@atlas/cognition";
import { CliUsageError, parseArgs, parseRole, stringFlag } from "../arguments.js";
import { contextCommand } from "./context.js";
import { printSafeJson } from "../output.js";

export async function runCognition(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case "run":
      await runCognitionCycleCommand(rest, false);
      return;
    case "explain":
      await runCognitionCycleCommand(rest, true);
      return;
    case "state":
      await runCognitionState(rest);
      return;
    default:
      throw new CliUsageError('Usage: lmti cognition <run|explain|state> "<task>"');
  }
}

async function runCognitionCycleCommand(args: string[], explainOnly: boolean): Promise<void> {
  const { positional, flags } = parseArgs(args, {
    adapter: "value",
    "adapter-manifest": "value",
    "include-low-score": "boolean",
    "include-raw": "boolean",
    "include-secret": "boolean",
    "include-secret-meta": "boolean",
    "memory-source": "value",
    "model-target": "value",
    role: "value"
  }, 2);
  const task = positional[0];
  if (!task) {
    throw new CliUsageError(`Usage: lmti cognition ${explainOnly ? "explain" : "run"} "<task>"`);
  }

  const role = parseRole(stringFlag(flags, "role") ?? "developer");
  const context = await contextCommand(process.cwd(), task, {
    amfPath: positional[1],
    includeSecret: false,
    role,
    flags: { ...flags, "include-secret": false }
  });
  const items = contextPackToCognitiveItems(context);
  const result = runCognitiveCycle({
    projectId: context.project,
    task,
    inferredIntent: context.inferredIntent,
    contextItems: items,
    privacyBlocks: context.filteredOut.memories > 0 ? [`${context.filteredOut.memories} memories filtered by privacy or relevance`] : [],
    subscribers: [
      { id: "context_builder", role: "local" },
      { id: "runtime_session", role: "local" },
      { id: "agent_response_planner", role: stringFlag(flags, "model-target") === "external_model" ? "external_model" : "local" },
      { id: "memory_consolidation", role: "local" },
      { id: "insight_engine", role: "local" },
      { id: "privacy_audit", role: "local" }
    ]
  });

  if (explainOnly) {
    printSafeJson(
        {
          task,
          selectedFocus: result.focus.selectedFocus,
          phiEstimate: result.state.integratedInformation.normalizedPhi,
          freeEnergyEstimate: result.state.predictionState.freeEnergyEstimate,
          fragmentationRisk: result.state.integratedInformation.fragmentationRisk,
          predictionError: result.predictionError,
          broadcasts: result.broadcasts,
          recommendedActions: result.recommendedActions,
          explanation: result.state.explanation
        },
        "cognition explain"
    );
    return;
  }

  printSafeJson(result, "cognition");
}

async function runCognitionState(args: string[]): Promise<void> {
  const { positional, flags } = parseArgs(args, {
    adapter: "value",
    "adapter-manifest": "value",
    "include-low-score": "boolean",
    "include-raw": "boolean",
    "include-secret": "boolean",
    "include-secret-meta": "boolean",
    "memory-source": "value",
    "model-target": "value",
    role: "value"
  }, 2);
  const task = positional[0];
  if (!task) {
    console.log(
      JSON.stringify(
        {
          status: "ephemeral",
          message: "Cognitive state is computed per task and not persisted yet.",
          next: 'Run `lmti cognition run "<task>"` or `lmti cognition explain "<task>"`.'
        },
        null,
        2
      )
    );
    return;
  }
  await runCognitionCycleCommand([task, ...Object.entries(flags).flatMap(([key, value]) => (value === true ? [`--${key}`] : [`--${key}`, String(value)]))], false);
}
