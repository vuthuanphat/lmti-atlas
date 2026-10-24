import { desktopBridgeCommand, readDesktopRequest } from "./desktop-bridge";
import { CliUsageError, parseArgs } from "./arguments.js";
import { routeSkillCommand, runSkill, runThoth } from "./commands/skills.js";
import { runAttach, runCompile, runInit, runMigrate } from "./commands/workspace.js";
import { runDoctor } from "./commands/doctor.js";
import { runContext, runInspect, runPreflight } from "./commands/context.js";
import { runPublish } from "./commands/publish.js";
import { runAgent, runCleanup, runConfig, runPolicy } from "./commands/operator.js";
import { runBenchmark, runExperiment } from "./commands/experiments.js";
import { runMemory } from "./commands/memory.js";
import { runMind } from "./commands/mind.js";
import { runFramework } from "./commands/framework.js";
import { runActions } from "./commands/actions.js";
import { runCognition } from "./commands/cognition.js";
import { runWorld } from "./commands/world.js";
import { runRemember, runTask } from "./commands/memory-records.js";
import { runPrivacy } from "./commands/privacy.js";
import { printHelp } from "./help.js";
import { reportCliError, usesCliJsonEnvelope } from "./output.js";

export interface CliMainOptions {
  cwd?: string;
}

export async function main(argv: string[], options: CliMainOptions = {}): Promise<void> {
  try {
    await dispatch(argv, options);
  } catch (error) {
    // These friendly commands already publish lmti.cli.v1. Private bridge,
    // Impact and native-owner protocols keep their own error contracts.
    if (usesCliJsonEnvelope(argv)) {
      reportCliError(error, argv);
      return;
    }
    throw error;
  }
}

async function dispatch(argv: string[], options: CliMainOptions): Promise<void> {
  const [command, ...args] = argv;
  const cwd = options.cwd ?? process.cwd();

  switch (command) {
    case "drive-desktop":
      if (args.length || Number(process.versions.node.split(".")[0]) < 24) {
        process.exitCode = 3;
        return;
      }
      await (await import("./drive-command.js")).runDriveDesktop({
        enabled: process.env.LMTI_STUDIO_ALLOW_GOOGLE_DRIVE === "1",
        clientId: process.env.LMTI_GOOGLE_CLIENT_ID,
        clientSecret: process.env.LMTI_GOOGLE_CLIENT_SECRET
      });
      return;
    case "impact":
      if (Number(process.versions.node.split(".")[0]) < 24) throw new CliUsageError("The impact pilot requires Node.js 24 or later.");
      await (await import("./impact-command.js")).runImpactCommand(args);
      return;
    case "agent-context":
      if (args.length) throw new CliUsageError("agent-context accepts a versioned request on stdin only.");
      try {
        const { agentContextCommand, readAgentContextRequest } = await import("./agent-context.js");
        console.log(JSON.stringify(await agentContextCommand(await readAgentContextRequest())));
      } catch {
        console.log(JSON.stringify({ schema: "lmti.agent.knowledge.v1", error: "KNOWLEDGE_REQUEST_DENIED" }));
        process.exitCode = 3;
      }
      return;
    case "desktop-bridge":
      if (args.length) throw new CliUsageError("desktop-bridge accepts a versioned request on stdin only.");
      try {
        console.log(JSON.stringify(await desktopBridgeCommand(await readDesktopRequest(), {
          allowLessonReview: process.env.LMTI_STUDIO_ALLOW_LESSON_REVIEW === "1", route: routeSkillCommand
        })));
      } catch {
        console.log(JSON.stringify({ schema: "lmti.desktop.knowledge.v1", error: "KNOWLEDGE_REQUEST_DENIED" }));
        process.exitCode = 3;
      }
      return;
    case "init":
      await runInit(args);
      return;
    case "check":
      await runDoctor(args, cwd);
      return;
    case "route":
      await runSkill(["route", ...args], cwd);
      return;
    case "compile":
      await runCompile(args);
      return;
    case "migrate":
      await runMigrate(args);
      return;
    case "doctor":
      await runDoctor(args, cwd);
      return;
    case "inspect":
      await runInspect(args);
      return;
    case "context":
      await runContext(args);
      return;
    case "preflight":
      await runPreflight(args, cwd);
      return;
    case "publish":
      await runPublish(args, cwd);
      return;
    case "skill":
      await runSkill(args, cwd);
      return;
    case "thoth":
      await runThoth(args, cwd);
      return;
    case "policy":
      await runPolicy(args, cwd);
      return;
    case "config":
      await runConfig(args, cwd);
      return;
    case "agent":
      await runAgent(args, cwd);
      return;
    case "cleanup":
      await runCleanup(args, cwd);
      return;
    case "attach":
      await runAttach(args);
      return;
    case "experiment":
      await runExperiment(args);
      return;
    case "memory":
      await runMemory(args);
      return;
    case "mind":
      await runMind(args);
      return;
    case "framework":
      await runFramework(args);
      return;
    case "actions":
      await runActions(args, cwd);
      return;
    case "cognition":
      await runCognition(args);
      return;
    case "world":
      await runWorld(args);
      return;
    case "remember":
      await runRemember(args);
      return;
    case "task":
      await runTask(args);
      return;
    case "privacy":
      await runPrivacy(args);
      return;
    case "benchmark":
      await runBenchmark(args);
      return;
    case "help":
    case "--help":
    case "-h":
    case undefined:
      parseArgs(args, {}, 0);
      printHelp();
      return;
    default:
      process.exitCode = 4;
      throw new CliUsageError(`Unknown command: ${command}`);
  }
}
