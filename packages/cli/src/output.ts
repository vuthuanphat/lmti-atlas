import { runEgressSecretScan, redactText } from "@atlas/privacy";
import { isRecord } from "./values.js";
import { CliUsageError } from "./arguments.js";

export interface CliBoundaryMessage {
  code: string;
  message: string;
  suggestion?: string;
}

export type CliStatus = "pass" | "warn" | "blocked" | "error";

type CliExitCode = 0 | 1 | 2 | 3 | 4 | 5;

export interface CliJsonEnvelope {
  schemaVersion: "lmti.cli.v1";
  command: string;
  status: CliStatus;
  warnings: CliBoundaryMessage[];
  errors: CliBoundaryMessage[];
  data: unknown;
}

const envelopeCommands = new Set(["doctor", "check", "route", "skill", "thoth", "publish", "policy", "config", "agent", "cleanup"]);

export function usesCliJsonEnvelope(argv: string[]): boolean {
  if (argv[0] === "preflight" && argv[1] === "publish") return usesCliJsonEnvelope(["publish", "preflight", ...argv.slice(2)]);
  if (!envelopeCommands.has(argv[0]) &&
      !(argv[0] === "memory" && ["search", "retrieve"].includes(argv[1])) &&
      !(argv[0] === "framework" && argv[1] === "detect")) return false;
  const end = argv.indexOf("--");
  let json = false;
  for (const arg of argv.slice(1, end < 0 ? undefined : end)) {
    if (/^--json(?:=(?:true|yes|1))?$/i.test(arg)) json = true;
    if (/^--json=(?:false|no|0)$/i.test(arg)) json = false;
  }
  return json;
}

export function reportCliError(error: unknown, argv: string[]): void {
  if (argv[0] === "preflight" && argv[1] === "publish") argv = ["publish", "preflight", ...argv.slice(2)];
  const usage = error instanceof CliUsageError;
  process.exitCode = usage ? error.exitCode : 3;
  const message = error instanceof Error ? error.message : String(error);
  if (usesCliJsonEnvelope(argv)) {
    const command = argv[0] === "check" ? "doctor" : argv[0];
    const subcommand = argv[1] && !argv[1].startsWith("-") &&
      ["skill", "thoth", "publish", "policy", "config", "agent", "cleanup", "memory", "framework"].includes(command)
      ? `.${argv[1]}` : "";
    printCliEnvelope(`lmti.${command}${subcommand}`, "error", [], [{code: usage ? "INVALID_USAGE" : "COMMAND_FAILED", message}], {});
  } else {
    console.error(`[LMTI] ${redactText(message)}`);
  }
}

export function printWarnings(warnings: string[]): void {
  for (const warning of Array.from(new Set(warnings))) {
    console.warn(`[LMTI] ${warning}`);
  }
}

export function printSafeJson(value: unknown, label: string): void {
  const serialized = JSON.stringify(redactJsonValue(value), null, 2);
  const scan = runEgressSecretScan(serialized);
  if (scan.blocked) {
    console.warn(`[LMTI] ${label} output matched secret patterns and was redacted before printing.`);
  }
  console.log(serialized);
}

export function printCliEnvelope(command: string, status: CliStatus | string, warnings: CliBoundaryMessage[], errors: CliBoundaryMessage[], data: unknown): void {
  printSafeJson(createCliEnvelope(command, status, warnings, errors, data), command);
}

export function createCliEnvelope(command: string, status: CliStatus | string, warnings: CliBoundaryMessage[] = [], errors: CliBoundaryMessage[] = [], data: unknown = {}): CliJsonEnvelope {
  return {
    schemaVersion: "lmti.cli.v1",
    command,
    status: toCliStatus(status),
    warnings: warnings.map(cleanBoundaryMessage),
    errors: errors.map(cleanBoundaryMessage),
    data: isRecord(data) ? data : { value: data }
  };
}

function cleanBoundaryMessage(message: CliBoundaryMessage): CliBoundaryMessage {
  return {
    code: message.code,
    message: message.message,
    ...(message.suggestion ? { suggestion: message.suggestion } : {})
  };
}

function toCliStatus(status: CliStatus | string): CliStatus {
  if (status === "warning" || status === "warn") {
    return "warn";
  }
  if (status === "blocked" || status === "error" || status === "pass") {
    return status;
  }
  return "error";
}

export function setCliExitCode(status: CliStatus | string): void {
  process.exitCode = exitCodeForCliStatus(toCliStatus(status));
}

function exitCodeForCliStatus(status: CliStatus): CliExitCode {
  switch (status) {
    case "pass":
      return 0;
    case "warn":
      return 1;
    case "blocked":
      return 2;
    case "error":
      return 3;
  }
}

export function writeCliUsage(command: string, usage: string, json: boolean): void {
  process.exitCode = 4;
  if (json) {
    printCliEnvelope(command, "error", [], [{ code: "INVALID_USAGE", message: usage }], {});
    return;
  }
  throw new CliUsageError(usage);
}

export function printSafeText(value: string): void {
  const scan = runEgressSecretScan(value);
  if (scan.blocked) {
    console.warn("[LMTI] text output matched secret patterns and was redacted before printing.");
  }
  console.log(redactText(value));
}

function redactJsonValue(value: unknown): unknown {
  if (typeof value === "string") {
    return redactText(value);
  }
  if (Array.isArray(value)) {
    return value.map(redactJsonValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [redactText(key), redactJsonValue(entry)]));
  }
  return value;
}
