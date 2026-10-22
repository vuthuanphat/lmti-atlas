import {
  AGENT_MAPPING_LIMITS, agentMappingArguments, agentMappingCommand,
  agentMappingError, encodeAgentMappingResult, readAgentMappingRequest,
} from "../packages/cli/src/agent-mapping.js";
import { performance } from "node:perf_hooks";

// One fixed read. No general CLI dispatch, operator factory or write action.
const controller = new AbortController();
const abort = () => controller.abort();
const deadline = performance.now() + AGENT_MAPPING_LIMITS.commandMilliseconds;
const timer = setTimeout(abort, AGENT_MAPPING_LIMITS.commandMilliseconds);
process.once("SIGTERM", abort);
process.once("SIGINT", abort);
process.once("disconnect", abort);
let outputFailed = false;
let outputStarted = false;
const outputError = () => { outputFailed = true; abort(); };
process.stdout.on("error", outputError);
try {
  const args = agentMappingArguments(process.argv);
  const request = await readAgentMappingRequest(process.stdin, controller.signal);
  const result = await agentMappingCommand(args, request, { signal: controller.signal });
  if (controller.signal.aborted || outputFailed) throw new Error("OWNER_UNAVAILABLE");
  const frame = encodeAgentMappingResult(result);
  if (controller.signal.aborted || outputFailed || performance.now() > deadline) throw new Error("OWNER_UNAVAILABLE");
  outputStarted = true;
  await new Promise<void>((resolve, reject) => process.stdout.write(frame, error => error ? reject(error) : resolve()));
} catch (error) {
  abort();
  process.exitCode = 3;
  if (!outputFailed && !outputStarted) {
    const frame = JSON.stringify(agentMappingError(error)) + "\n";
    try { await new Promise<void>(resolve => process.stdout.write(frame, () => resolve())); }
    catch { /* A failed stdout has no second channel or raw exception output. */ }
  }
} finally {
  clearTimeout(timer);
  process.removeListener("SIGTERM", abort);
  process.removeListener("SIGINT", abort);
  process.removeListener("disconnect", abort);
  // Keep the harmless listener installed through process shutdown.
  process.stdin.pause();
}
