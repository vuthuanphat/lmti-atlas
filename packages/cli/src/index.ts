#!/usr/bin/env node
import path from "node:path";
import { main } from "./dispatch.js";
import { reportCliError } from "./output.js";

export { contextCommand, preflightCommand } from "./commands/context.js";
export { type PublishPreflightCheck, type PublishPreflightResult, publishPreflightCommand } from "./commands/publish.js";
export { routeSkillCommand } from "./commands/skills.js";
export { type CliMainOptions, main } from "./dispatch.js";
export { type InitCommandOptions, type InitCommandResult, initCommand, compileCommand, migrateCommand, attachCodex } from "./commands/workspace.js";
export { doctorCommand, type SecurityDoctorCheck, type SecurityDoctorReport, doctorSecurityCommand } from "./commands/doctor.js";
export { type ThinkingExperimentResult, thinkingExperimentCommand, benchmarkPreflightCommand } from "./commands/experiments.js";
export { mindContextCommand, mindReflectCommand } from "./commands/mind.js";
export { frameworkDetectCommand } from "./commands/framework.js";
export { rememberCommand, taskDoneCommand } from "./commands/memory-records.js";

if (process.argv[1] && path.basename(process.argv[1]) === "index.js") {
  main(process.argv.slice(2)).catch((error: unknown) => {
    reportCliError(error, process.argv.slice(2));
  });
}
