import { verifyAuditIntegrity, retainAuditEvents, readAuditEvents } from "@atlas/privacy";
import { checkMemoryPrivacy } from "@atlas/memory";
import { CliUsageError, parseArgs, parseNumberFlag } from "../arguments.js";
import { printSafeJson } from "../output.js";

export async function runPrivacy(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  const { flags } = parseArgs(rest, subcommand === "audit" ? {limit: "value",retain: "value",verify: "boolean"} : {}, 0);

  switch (subcommand) {
    case "audit":
      if (flags.verify) {
        printSafeJson(await verifyAuditIntegrity(process.cwd()), "privacy audit verify");
        return;
      }
      if (flags.retain !== undefined) {
        printSafeJson(await retainAuditEvents(process.cwd(), parseNumberFlag(flags, "retain", 1000)), "privacy audit retain");
        return;
      }
      printSafeJson(await readAuditEvents(process.cwd(), parseNumberFlag(flags, "limit", 50)), "privacy audit");
      return;
    case "check":
      printSafeJson(await checkMemoryPrivacy({ cwd: process.cwd() }), "privacy check");
      return;
    default:
      throw new CliUsageError("Usage: lmti privacy <audit|check>");
  }
}
