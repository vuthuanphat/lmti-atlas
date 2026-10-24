import type { AccessRole } from "@atlas/types";
import { createPrivacyContext } from "@atlas/privacy";
import { FlagValue } from "./arguments.js";

export function createCliPrivacyContext(role: AccessRole, flags: Record<string, FlagValue>, command: string, purpose: string) {
  return createPrivacyContext({
    role,
    projectId: "local",
    purpose,
    includeSecret: Boolean(flags["include-secret"]),
    includeRaw: Boolean(flags["include-raw"]),
    command
  });
}
