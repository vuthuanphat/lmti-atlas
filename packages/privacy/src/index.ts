import { randomUUID } from "node:crypto";
import { appendAuditEvent } from "./audit";
export { AUDIT_FILE, PRIVACY_DIR, appendAuditEvent, readAuditEvents, verifyAuditIntegrity, retainAuditEvents } from "./audit";
import type {
  AccessDecision,
  AccessRole,
  BlockedMemory,
  ContextEgressScan,
  HardGateReason,
  MemoryMetadata,
  MetadataGateResult,
  ObserverFrame,
  PolicyDecision,
  PrivacyContext,
  PrivacyEvaluation,
  PrivacyPolicy,
  PrivacyProtectedRecord,
  SensitivityLevel
} from "@atlas/types";

export const PREFLIGHT_POLICY_VERSION = "preflight-policy-0.1.0";

const POLICIES: Record<SensitivityLevel, PrivacyPolicy> = {
  public: {
    id: "privacy-public",
    name: "Public",
    description: "Public cognition may be exported by default.",
    sensitivity: "public",
    allowedRoles: ["owner", "maintainer", "developer", "agent", "readonly", "external_model"],
    defaultDecision: "allow",
    allowRawExport: true,
    allowContextExport: true,
    requireAudit: false,
    requireExplicitFlag: false
  },
  internal: {
    id: "privacy-internal",
    name: "Internal",
    description: "Internal cognition is visible to trusted project roles.",
    sensitivity: "internal",
    allowedRoles: ["owner", "maintainer", "developer", "agent"],
    defaultDecision: "deny",
    allowRawExport: true,
    allowContextExport: true,
    requireAudit: false,
    requireExplicitFlag: false
  },
  confidential: {
    id: "privacy-confidential",
    name: "Confidential",
    description: "Confidential cognition is summarized by default and audited.",
    sensitivity: "confidential",
    allowedRoles: ["owner", "maintainer", "developer", "agent", "readonly", "external_model"],
    defaultDecision: "summarize",
    allowRawExport: false,
    allowContextExport: true,
    requireAudit: true,
    requireExplicitFlag: false
  },
  secret: {
    id: "privacy-secret",
    name: "Secret",
    description: "Secret cognition is denied by default and requires owner opt-in.",
    sensitivity: "secret",
    allowedRoles: ["owner"],
    defaultDecision: "deny",
    allowRawExport: false,
    allowContextExport: false,
    requireAudit: true,
    requireExplicitFlag: true
  }
};

export function createPrivacyContext(input: Partial<PrivacyContext> = {}): PrivacyContext {
  return {
    role: input.role ?? "developer",
    projectId: input.projectId ?? "default",
    purpose: input.purpose ?? "local ATLAS command",
    includeSecret: input.includeSecret ?? false,
    includeRaw: input.includeRaw ?? false,
    command: input.command ?? "unknown",
    timestamp: input.timestamp ?? new Date().toISOString()
  };
}

export function inferSinkRole(modelTarget: string): AccessRole {
  const normalized = modelTarget.trim().toLowerCase();
  if (normalized === "local" || normalized.startsWith("local:") || normalized.startsWith("codex:local")) {
    return "agent";
  }
  return "external_model";
}

export function deriveEffectiveContextRole(observerRole: AccessRole, modelTarget: string): AccessRole {
  const sinkRole = inferSinkRole(modelTarget);
  return stricterRole(observerRole, sinkRole);
}

export function hardGateMemoryMetadata(input: {
  metadata: MemoryMetadata[];
  observer: ObserverFrame;
  privacyContext: PrivacyContext;
  now?: Date;
}): MetadataGateResult {
  const allowed: MemoryMetadata[] = [];
  const blocked: BlockedMemory[] = [];
  const policyDecisions: PolicyDecision[] = [];
  const now = input.now ?? new Date();

  for (const memory of input.metadata) {
    const reason = getHardBlockReason(memory, input.observer, input.privacyContext, now);
    if (reason) {
      const decision = createPolicyDecision(memory, "read_content", "block", reason);
      policyDecisions.push(decision);
      blocked.push(createBlockedMemory(memory, reason, decision.id));
      continue;
    }

    const evaluation = evaluateAccess(memory, input.privacyContext);
    const effect = evaluation.decision === "summarize" ? "summarize" : "allow";
    policyDecisions.push(createPolicyDecision(memory, "read_content", effect, evaluation.reason));
    allowed.push(memory);
  }

  return { allowed, blocked, policyDecisions };
}

export function evaluateAccess(record: PrivacyProtectedRecord, privacyContext: PrivacyContext): PrivacyEvaluation {
  const policy = POLICIES[record.sensitivity];

  if (record.sensitivity === "public") {
    return { decision: "allow", policy, reason: "Public cognition is allowed by default." };
  }

  if (record.sensitivity === "internal") {
    if (privacyContext.role === "external_model") {
      return { decision: "summarize", policy, reason: "External models receive summarized internal cognition by default." };
    }
    if (policy.allowedRoles.includes(privacyContext.role)) {
      return { decision: "allow", policy, reason: "Internal cognition allowed for trusted project role." };
    }
    return { decision: "deny", policy, reason: "Role is not allowed to read internal cognition." };
  }

  if (record.sensitivity === "confidential") {
    if (privacyContext.role === "external_model") {
      return { decision: "summarize", policy, reason: "External models cannot receive raw confidential cognition." };
    }
    if ((privacyContext.role === "owner" || privacyContext.role === "maintainer") && privacyContext.includeRaw) {
      return { decision: "allow", policy, reason: "Privileged role explicitly requested raw confidential cognition." };
    }
    return { decision: "summarize", policy, reason: "Confidential cognition is summarized by default." };
  }

  if (privacyContext.role === "owner" && privacyContext.includeSecret && privacyContext.includeRaw) {
    return { decision: "allow", policy, reason: "Owner explicitly requested secret cognition." };
  }

  return { decision: "deny", policy, reason: "Secret cognition is denied unless owner explicitly includes secrets." };
}

export function canReadRaw(record: PrivacyProtectedRecord, privacyContext: PrivacyContext): boolean {
  return evaluateAccess(record, privacyContext).decision === "allow";
}

export function canExportToContext(record: PrivacyProtectedRecord, privacyContext: PrivacyContext): boolean {
  const evaluation = evaluateAccess(record, privacyContext);
  if (evaluation.decision === "deny") {
    return false;
  }
  if (record.sensitivity === "secret") {
    return privacyContext.role === "owner" && privacyContext.includeSecret;
  }
  return evaluation.policy.allowContextExport;
}

export function shouldRedact(record: PrivacyProtectedRecord, privacyContext: PrivacyContext): boolean {
  const decision = evaluateAccess(record, privacyContext).decision;
  return decision === "redact" || decision === "deny";
}

export function shouldSummarize(record: PrivacyProtectedRecord, privacyContext: PrivacyContext): boolean {
  return evaluateAccess(record, privacyContext).decision === "summarize";
}

export function redactSecrets(text: string): string {
  let redacted = text;
  for (const pattern of SECRET_REDACTION_PATTERNS) {
    redacted = redacted.replace(pattern.regex, pattern.replacement);
  }
  return redacted;
}

export function redactPII(text: string): string {
  const protectedText = protectOpaqueIdentifiers(text);
  const redacted = protectedText.value
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]")
    .replace(/(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?)?\d{3,4}[\s.-]?\d{4}\b/g, "[REDACTED_PHONE]");
  return protectedText.restore(redacted);
}

export function redactText(text: string): string {
  return redactPII(redactSecrets(text));
}

export function hasSecretLikeMaterial(text: string): boolean {
  return SECRET_EGRESS_PATTERNS.some((pattern) => pattern.regex.test(text));
}

export function runEgressSecretScan(context: unknown): ContextEgressScan {
  const serialized = typeof context === "string" ? context : JSON.stringify(context);
  const findings: string[] = [];

  for (const pattern of SECRET_EGRESS_PATTERNS) {
    if (pattern.regex.test(serialized)) {
      findings.push(pattern.id);
    }
  }

  return {
    blocked: findings.length > 0,
    findings,
    redactedPreview: redactText(serialized).slice(0, 2000)
  };
}

export function redactBySensitivity<T extends PrivacyProtectedRecord>(record: T, privacyContext: PrivacyContext): T {
  const evaluation = evaluateAccess(record, privacyContext);
  if (evaluation.decision === "allow") {
    return {
      ...record,
      content: redactText(record.content ?? "")
    };
  }
  if (evaluation.decision === "summarize") {
    return {
      ...record,
      content: createSafeSummary(record)
    };
  }
  return {
    ...record,
    content: "[REDACTED]"
  };
}

export function createSafeSummary(record: PrivacyProtectedRecord): string {
  const title = record.title ? ` "${redactText(record.title)}"` : "";
  return `${record.sensitivity} memory${title}; raw content withheld by Cognitive Privacy Layer.`;
}

export async function auditSensitiveAccess(
  cwd: string,
  record: PrivacyProtectedRecord,
  privacyContext: PrivacyContext,
  decision: AccessDecision,
  reason: string
): Promise<void> {
  if (record.sensitivity !== "confidential" && record.sensitivity !== "secret") {
    return;
  }
  await appendAuditEvent(cwd, {
    action: "memory.access",
    recordId: record.id,
    sensitivity: record.sensitivity,
    role: privacyContext.role,
    decision,
    command: privacyContext.command,
    reason
  });
}

const ROLE_STRENGTH: Record<AccessRole, number> = {
  external_model: 0,
  readonly: 1,
  agent: 2,
  developer: 3,
  maintainer: 4,
  owner: 5
};

const SECRET_EGRESS_PATTERNS: Array<{ id: string; regex: RegExp }> = [
  { id: "private_key", regex: /-----BEGIN\s+(?:RSA\s+|EC\s+|OPENSSH\s+)?PRIVATE\s+KEY-----/i },
  { id: "openai_api_key", regex: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/ },
  { id: "anthropic_api_key", regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { id: "github_token", regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/ },
  { id: "stripe_key", regex: /\b(?:sk|pk)_(?:test|live)_[A-Za-z0-9_]{8,}\b/ },
  { id: "aws_access_key", regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: "aws_secret_key", regex: /\baws[_-]?secret[_-]?access[_-]?key\b\s*[:=]\s*["']?[^"'\s]{16,}/i },
  { id: "jwt", regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { id: "database_url", regex: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s"']+/i },
  { id: "oauth_secret", regex: /\b(?:client[_-]?secret|oauth[_-]?secret)\b\s*[:=]\s*["']?[^"'\s]{8,}/i },
  { id: "cookie_or_session", regex: /\b(?:cookie|set-cookie|session(?:[_-]?id)?|session[_-]?secret)\b\s*[:=]\s*["']?[^"'\s;]{8,}/i },
  { id: "secret_assignment", regex: /\b(api[_-]?key|secret|token|password|passwd|private[_-]?key)\b\s*[:=]\s*["']?[^"'\s]{8,}/i }
];

const SECRET_REDACTION_PATTERNS: Array<{ regex: RegExp; replacement: string }> = [
  {
    regex: /-----BEGIN\s+(?:RSA\s+|EC\s+|OPENSSH\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(?:RSA\s+|EC\s+|OPENSSH\s+)?PRIVATE\s+KEY-----/gi,
    replacement: "[REDACTED_PRIVATE_KEY]"
  },
  { regex: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g, replacement: "[REDACTED_OPENAI_API_KEY]" },
  { regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, replacement: "[REDACTED_ANTHROPIC_API_KEY]" },
  { regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g, replacement: "[REDACTED_GITHUB_TOKEN]" },
  { regex: /\b(?:sk|pk)_(?:test|live)_[A-Za-z0-9_]{8,}\b/g, replacement: "[REDACTED_STRIPE_KEY]" },
  { regex: /\bAKIA[0-9A-Z]{16}\b/g, replacement: "[REDACTED_AWS_KEY]" },
  { regex: /\baws[_-]?secret[_-]?access[_-]?key\b\s*[:=]\s*["']?[^"'\s<>]{16,}/gi, replacement: "aws_secret_access_key=[REDACTED]" },
  { regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, replacement: "[REDACTED_JWT]" },
  { regex: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s"'<>]+/gi, replacement: "[REDACTED_DATABASE_URL]" },
  { regex: /\b(?:client[_-]?secret|oauth[_-]?secret)\b\s*[:=]\s*["']?[^"'\s<>]{8,}/gi, replacement: "oauth_secret=[REDACTED]" },
  { regex: /\b(?:cookie|set-cookie|session(?:[_-]?id)?|session[_-]?secret)\b\s*[:=]\s*["']?[^"'\s;<>]{8,}/gi, replacement: "session=[REDACTED]" },
  { regex: /\b(api[_-]?key|secret|token|password|passwd|private[_-]?key)\b\s*[:=]\s*["']?[^"'\s<>]+/gi, replacement: "$1=[REDACTED]" },
  { regex: /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|COOKIE|SESSION)[A-Z0-9_]*)\s*=\s*["']?[^"'\s<>]+/g, replacement: "$1=[REDACTED]" }
];

const OPAQUE_IDENTIFIER_PATTERNS = [
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi
];

function protectOpaqueIdentifiers(text: string): { value: string; restore: (value: string) => string } {
  const values: string[] = [];
  let protectedValue = text;

  for (const pattern of OPAQUE_IDENTIFIER_PATTERNS) {
    protectedValue = protectedValue.replace(pattern, (match) => {
      const placeholder = `__LMTI_OPAQUE_ID_${values.length}__`;
      values.push(match);
      return placeholder;
    });
  }

  return {
    value: protectedValue,
    restore(value: string): string {
      return values.reduce((result, original, index) => result.replaceAll(`__LMTI_OPAQUE_ID_${index}__`, original), value);
    }
  };
}

function stricterRole(left: AccessRole, right: AccessRole): AccessRole {
  return ROLE_STRENGTH[left] <= ROLE_STRENGTH[right] ? left : right;
}

function getHardBlockReason(
  memory: MemoryMetadata,
  observer: ObserverFrame,
  privacyContext: PrivacyContext,
  now: Date
): HardGateReason | undefined {
  if (memory.sensitivity === "secret") {
    return "secret";
  }
  if (memory.promptPolicy === "do_not_prompt") {
    return "do_not_prompt";
  }
  if (memory.projectId && memory.projectId !== observer.projectId) {
    return "wrong_project";
  }
  if (memory.status === "deprecated" || memory.status === "superseded") {
    return "deprecated_as_truth";
  }
  if (memory.status === "archived") {
    return "archived";
  }
  if (memory.status === "pending" || memory.status === "rejected") {
    return "pending_review";
  }
  if (memory.status === "expired" || (memory.expiresAt && new Date(memory.expiresAt).getTime() <= now.getTime())) {
    return "expired";
  }
  if (evaluateAccess(memory, privacyContext).decision === "deny") {
    return "unauthorized_role";
  }
  return undefined;
}

function createPolicyDecision(
  memory: MemoryMetadata,
  action: PolicyDecision["action"],
  effect: PolicyDecision["effect"],
  reason: string
): PolicyDecision {
  return {
    id: randomUUID(),
    memoryId: memory.id,
    action,
    effect,
    reason,
    policyVersion: PREFLIGHT_POLICY_VERSION,
    memoryVersion: memory.version,
    createdAt: new Date().toISOString()
  };
}

function createBlockedMemory(memory: MemoryMetadata, reason: HardGateReason, policyDecisionId: string): BlockedMemory {
  return {
    memoryId: memory.id,
    path: `${memory.scope}:${memory.id}`,
    reason,
    safeSummary: safeBlockedSummary(memory, reason),
    policyDecisionId
  };
}

function safeBlockedSummary(memory: MemoryMetadata, reason: HardGateReason): string {
  if (reason === "secret" || reason === "do_not_prompt") {
    return `${reason} memory blocked; raw content and sensitive title withheld.`;
  }
  return `${reason} memory "${redactText(memory.title)}" blocked; raw content withheld.`;
}
