import type { AdapterManifest, AdapterPrivacyProfile, AccessRole, PreflightResult, ContextRequest, ObserverFrame, ContextPackage, AdapterSandboxResult, PolicySafeMemoryResult, InferredIntent, MemorySearchResult, BlockedMemory, ContextCandidate, AmfDocument } from "@atlas/types";
import { readAmfDocument, readContextMemory } from "@atlas/memory";
import { formatInspection, inspectAmf, inferIntent, buildContextPack } from "@atlas/kernel";
import { deriveEffectiveContextRole, inferSinkRole, createPrivacyContext, runEgressSecretScan, appendAuditEvent, redactText } from "@atlas/privacy";
import { checkCompiledAmfFreshness } from "@atlas/compiler";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { promises as fs } from "node:fs";
import { CliUsageError, FlagValue, parseArgs, parseNumberFlag, parseRole, stringFlag } from "../arguments.js";
import { printSafeJson } from "../output.js";
import { createCliPrivacyContext } from "../privacy-context.js";
import { runPublishPreflight } from "./publish.js";
import { assertPathInsideCwd } from "../files.js";

const DEFAULT_PREFLIGHT_ADAPTER_MANIFEST: AdapterManifest = {
  id: "codex-local-preflight",
  name: "Codex Local Preflight Adapter",
  version: "0.1.0",
  kind: "model",
  scopes: ["context:read"],
  privacy: {
    allowRawSecret: false,
    allowRawConfidential: false,
    requiresEgressScan: true,
    defaultModelTarget: "external_model"
  },
  sandbox: {
    network: false,
    filesystem: "none",
    allowMemoryStore: false,
    timeoutMs: 30_000
  }
};

const DEFAULT_ADAPTER_PRIVACY_PROFILE: AdapterPrivacyProfile = {
  allowRawSecret: false,
  allowRawConfidential: false,
  requiresEgressScan: true,
  defaultModelTarget: "external_model"
};

const KNOWN_ADAPTERS = new Set(["codex", "claude-code", "cursor", "aider", "continue", "mcp", "openai-agents", "langchain", "crewai", "autogen", "generic", "custom"]);

export async function runInspect(args: string[]): Promise<void> {
  const { positional } = parseArgs(args, {  }, 1);
  const amf = await readAmfDocument(positional[0], process.cwd());
  console.log(formatInspection(inspectAmf(amf)));
}

export async function runContext(args: string[]): Promise<void> {
  if (args.length === 0) {
    throw new CliUsageError('Usage: lmti context "<task>" [amfPath] [--include-secret]');
  }

  const { positional, flags } = parseArgs(args, {
    adapter: "value",
    "adapter-manifest": "value",
    "include-low-score": "boolean",
    "include-raw": "boolean",
    "include-secret": "boolean",
    "include-secret-meta": "boolean",
    "memory-source": "value",
    role: "value"
  }, 2);
  const task = positional[0];
  if (!task) throw new CliUsageError('Usage: lmti context "<task>" [amfPath]');
  const amfPath = positional[1];
  const includeSecret = Boolean(flags["include-secret"]);
  const role = parseRole(stringFlag(flags, "role") ?? "developer");
  const contextPack = await contextCommand(process.cwd(), task, { amfPath, includeSecret, role, flags });
  printSafeJson(contextPack, "context");
}

export async function contextCommand(
  cwd: string,
  task: string,
  options: {
    amfPath?: string;
    includeSecret?: boolean;
    role?: AccessRole;
    flags?: Record<string, FlagValue>;
  } = {}
) {
  const flags = options.flags ?? {};
  const adapterManifest = flags.adapter || flags["adapter-manifest"]
    ? await loadAdapterManifest(cwd, stringFlag(flags, "adapter-manifest"), stringFlag(flags, "adapter"))
    : undefined;
  const adapterEffectiveRole = adapterManifest ? deriveEffectiveContextRole(options.role ?? "developer", adapterManifest.privacy.defaultModelTarget) : undefined;
  const includeSecret = adapterManifest ? false : Boolean(options.includeSecret);
  const includeRaw = Boolean(flags["include-raw"]);
  const includeSecretMeta = Boolean(flags["include-secret-meta"]);
  const includeLowScore = Boolean(flags["include-low-score"]);
  const role = adapterEffectiveRole ?? options.role ?? "developer";
  const amf = await readCompiledAmf(cwd, options.amfPath);
  const sourceFreshness = await checkCompiledAmfFreshness(amf, { cwd });
  const inferredIntent = inferIntent(task);
  const memorySelection = await readContextMemory(task, {
    cwd,
    source: parseContextMemorySource(flags),
    includeSecret,
    includeRaw: adapterManifest ? false : includeRaw,
    includeSecretMeta: adapterManifest ? false : includeSecretMeta,
    includeLowScore,
    taskIntent: inferredIntent,
    privacyContext: { ...createCliPrivacyContext(role, flags, "context", "context generation"), projectId: amf.project.name },
    limit: 16
  });
  return buildContextPack(amf, task, {
    memories: memorySelection.results,
    includeSecret,
    includeLowScore,
    inferredIntent,
    memoriesFilteredOut: memorySelection.filteredOut,
    sourceFreshness,
    memorySource: { source: memorySelection.source, completeness: memorySelection.completeness }
  });
}

export async function runPreflight(args: string[], cwd = process.cwd()): Promise<void> {
  if (args[0] === "publish") {
    await runPublishPreflight(args.slice(1), cwd);
    return;
  }

  if (args.length === 0) {
    throw new CliUsageError('Usage: lmti preflight "<task>" [amfPath] [--role developer] [--model-target external_model]');
  }

  const { positional, flags } = parseArgs(args, {
    adapter: "value",
    "adapter-manifest": "value",
    "agent-id": "value",
    "include-low-score": "boolean",
    "memory-source": "value",
    "model-target": "value",
    role: "value",
    "token-budget": "value",
    "user-id": "value"
  }, 2);
  const task = positional[0];
  if (!task) throw new CliUsageError('Usage: lmti preflight "<task>" [amfPath]');
  const amfPath = positional[1];
  const role = parseRole(stringFlag(flags, "role") ?? "developer");
  const modelTarget = stringFlag(flags, "model-target");
  const result = await preflightCommand(cwd, task, { amfPath, role, modelTarget, flags });
  printSafeJson(result, "preflight");
}

export async function preflightCommand(
  cwd: string,
  task: string,
  options: {
    amfPath?: string;
    role?: AccessRole;
    modelTarget?: string;
    flags?: Record<string, FlagValue>;
    now?: Date;
  } = {}
): Promise<PreflightResult> {
  const flags = options.flags ?? {};
  const latency = createLatencyTracker();
  const now = options.now ?? new Date();
  const observerRole = options.role ?? "developer";

  const adapterManifest = await loadAdapterManifest(cwd, stringFlag(flags, "adapter-manifest"), stringFlag(flags, "adapter"));
  const modelTarget = options.modelTarget ?? adapterManifest.privacy.defaultModelTarget;
  const amf = await readCompiledAmf(cwd, options.amfPath);
  const sourceFreshness = await checkCompiledAmfFreshness(amf, { cwd, now });
  latency.mark("read_amf");
  const inferredIntent = inferIntent(task);
  const projectId = amf.project.name;
  const sinkRole = inferSinkRole(modelTarget);
  const effectiveContextRole = deriveEffectiveContextRole(observerRole, modelTarget);
  const request: ContextRequest = {
    id: randomUUID(),
    input: task,
    projectId,
    userId: stringFlag(flags, "user-id") ?? "local-user",
    agentId: stringFlag(flags, "agent-id") ?? "codex",
    observerRole,
    modelTarget,
    createdAt: now.toISOString(),
    tokenBudget: flags["token-budget"] === undefined ? undefined : parseNumberFlag(flags, "token-budget", 0)
  };
  const observerFrame: ObserverFrame = {
    observerRole,
    sinkRole,
    effectiveContextRole,
    projectId,
    userId: request.userId,
    agentId: request.agentId,
    modelTarget
  };
  const privacyContext = createPrivacyContext({
    role: effectiveContextRole,
    projectId,
    purpose: "LMTI preflight context package",
    includeSecret: false,
    includeRaw: false,
    command: "preflight",
    timestamp: now.toISOString()
  });
  latency.mark("observer_frame");

  const memorySelection = await readContextMemory(task, {
    cwd, now,
    source: parseContextMemorySource(flags),
    observer: observerFrame,
    privacyContext,
    taskIntent: inferredIntent,
    limit: 16
  });
  const gate = memorySelection.gate;
  const memorySource = { source: memorySelection.source, completeness: memorySelection.completeness };
  latency.mark("retrieve_metadata");
  latency.mark("hard_gate");
  const safeMemory = memorySelection.policySafeCandidates;
  latency.mark("safe_content_loader");
  const selectedMemories = rankPolicySafeMemoryForPreflight(safeMemory, inferredIntent, Boolean(flags["include-low-score"]));
  const contextPack = buildContextPack(amf, task, {
    memories: selectedMemories.map(policySafeMemoryToSearchResult),
    includeSecret: false,
    includeLowScore: Boolean(flags["include-low-score"]),
    inferredIntent,
    memoriesFilteredOut: gate.blocked.length,
    sourceFreshness,
    memorySource
  });
  const riskSignals = detectPreflightRiskSignals(gate.blocked, selectedMemories);
  if (sourceFreshness.status !== "fresh") riskSignals.push(`compiled_context_${sourceFreshness.status}`);
  if (memorySource.completeness !== "complete") riskSignals.push("memory_candidates_incomplete");
  const candidates = generateMvpContextCandidates(request.id, selectedMemories, gate.blocked, riskSignals);
  const selectedCandidate = selectMvpCandidate(candidates);
  const executiveConstraints = createExecutiveConstraints(gate.blocked, riskSignals);
  if (sourceFreshness.status !== "fresh") executiveConstraints.push("Compiled context is stale or unverified; recompile and verify current sources before claiming current behavior or absence of impact.");
  if (memorySource.completeness !== "complete") executiveConstraints.push("Memory retrieval is incomplete; missing candidates do not prove absence of relevant knowledge.");
  const finalContextPackage = compilePreflightContextPackage({
    request,
    candidate: selectedCandidate,
    contextPack,
    selectedMemories,
    blockedMemories: gate.blocked,
    constraints: executiveConstraints
  });
  latency.mark("compile_context");
  const egress = runEgressSecretScan(finalContextPackage);
  latency.mark("egress_scan");
  const adapterSandbox = runAdapterSandbox({
    manifest: adapterManifest,
    contextPackage: finalContextPackage,
    egressBlocked: egress.blocked
  });
  latency.mark("adapter_sandbox");
  const predictedFailures = [
    ...selectedCandidate.predictedFailures,
    ...(egress.blocked ? ["egress scan blocked adapter call"] : []),
    ...adapterSandbox.deniedReasons.map((reason) => `adapter sandbox blocked: ${reason}`)
  ];
  const explanation = {
    selectedMemoryIds: selectedMemories.map((memory) => memory.metadata.id),
    blockedMemories: gate.blocked.map((memory) => ({
      memoryId: memory.memoryId,
      reason: memory.reason,
      safeSummary: memory.safeSummary
    })),
    selectedStrategy: selectedCandidate.strategy,
    why: selectedCandidate.predictedFailures.length > 0 ? selectedCandidate.predictedFailures : ["selected highest-scoring policy-safe MVP package"],
    redactions: [...gate.blocked.map((memory) => memory.reason), ...egress.findings, ...adapterSandbox.deniedReasons]
  };

  const adapterBlocked = !adapterSandbox.allowed;
  await appendAuditEvent(cwd, {
    action: egress.blocked ? "preflight.egress_blocked" : adapterBlocked ? "preflight.adapter_blocked" : "preflight.completed",
    recordId: request.id,
    sensitivity: "internal",
    role: effectiveContextRole,
    decision: egress.blocked || adapterBlocked ? "deny" : "allow",
    command: "preflight",
    reason: egress.blocked
      ? "Context package failed egress scan."
      : adapterBlocked
        ? `Adapter sandbox blocked: ${adapterSandbox.deniedReasons.join(", ")}`
        : "Preflight completed with policy-safe package."
  });
  latency.mark("audit");

  return {
    preflightId: request.id,
    sourceFreshness,
    memorySource,
    request,
    observerFrame,
    inferredIntent,
    selectedMemories,
    blockedMemories: gate.blocked,
    candidates,
    riskSignals,
    predictedFailures,
    executiveConstraints,
    finalContextPackage,
    egress,
    adapterSandbox,
    explanation,
    metrics: {
      metadataCount: gate.allowed.length + gate.blocked.length,
      allowedMemoryCount: gate.allowed.length,
      blockedMemoryCount: gate.blocked.length,
      selectedMemoryCount: selectedMemories.length,
      tokenEstimate: finalContextPackage.tokenEstimate,
      latencyMs: latency.totalMs(),
      phaseLatencyMs: latency.phases()
    }
  };
}

function createLatencyTracker(): { mark: (phase: string) => void; phases: () => Record<string, number>; totalMs: () => number } {
  const startedAt = Date.now();
  let lastMark = startedAt;
  const phaseLatencyMs: Record<string, number> = {};

  return {
    mark(phase: string) {
      const now = Date.now();
      phaseLatencyMs[phase] = now - lastMark;
      lastMark = now;
    },
    phases() {
      return { ...phaseLatencyMs };
    },
    totalMs() {
      return Date.now() - startedAt;
    }
  };
}

async function loadAdapterManifest(cwd: string, manifestPath?: string, adapterId?: string): Promise<AdapterManifest> {
  if (adapterId) {
    return createKnownAdapterManifest(adapterId);
  }
  if (!manifestPath) {
    return DEFAULT_PREFLIGHT_ADAPTER_MANIFEST;
  }

  const resolved = path.resolve(cwd, manifestPath);
  assertPathInsideCwd(cwd, resolved, "adapter manifest");
  const parsed = JSON.parse(await fs.readFile(resolved, "utf8")) as Partial<AdapterManifest>;
  return normalizeAdapterManifest(parsed);
}

function createKnownAdapterManifest(adapterId: string): AdapterManifest {
  const normalized = adapterId.trim().toLowerCase();
  if (!KNOWN_ADAPTERS.has(normalized)) {
    throw new Error(`Unknown adapter: ${adapterId}`);
  }
  return {
    ...DEFAULT_PREFLIGHT_ADAPTER_MANIFEST,
    id: normalized,
    name: `${normalized} adapter`,
    privacy: { ...DEFAULT_ADAPTER_PRIVACY_PROFILE }
  };
}

function normalizeAdapterManifest(input: Partial<AdapterManifest>): AdapterManifest {
  if (!input.id || !input.name || !input.version || !input.kind || !Array.isArray(input.scopes) || !input.sandbox) {
    throw new Error("Invalid adapter manifest: id, name, version, kind, scopes and sandbox are required.");
  }
  if (!["model", "tool", "plugin"].includes(input.kind)) {
    throw new Error(`Invalid adapter manifest kind: ${input.kind}`);
  }
  if (!["none", "read", "write"].includes(input.sandbox.filesystem)) {
    throw new Error(`Invalid adapter sandbox filesystem mode: ${input.sandbox.filesystem}`);
  }

  return {
    id: input.id,
    name: input.name,
    version: input.version,
    kind: input.kind,
    scopes: Array.from(new Set(input.scopes)),
    privacy: normalizeAdapterPrivacyProfile(input.privacy),
    sandbox: {
      network: Boolean(input.sandbox.network),
      filesystem: input.sandbox.filesystem,
      allowMemoryStore: Boolean(input.sandbox.allowMemoryStore),
      timeoutMs: Number(input.sandbox.timeoutMs)
    }
  };
}

function normalizeAdapterPrivacyProfile(input?: Partial<AdapterPrivacyProfile>): AdapterPrivacyProfile {
  const defaultModelTarget = input?.defaultModelTarget === "local" ? "local" : "external_model";
  return {
    allowRawSecret: Boolean(input?.allowRawSecret),
    allowRawConfidential: Boolean(input?.allowRawConfidential),
    requiresEgressScan: input?.requiresEgressScan !== false,
    defaultModelTarget
  };
}

function runAdapterSandbox(input: {
  manifest: AdapterManifest;
  contextPackage: ContextPackage;
  egressBlocked: boolean;
}): AdapterSandboxResult {
  const deniedReasons = validateAdapterManifestScope(input.manifest);
  if (input.egressBlocked) {
    deniedReasons.push("egress_scan_blocked");
  }

  const allowed = deniedReasons.length === 0;
  return {
    allowed,
    adapterId: input.manifest.id,
    manifest: input.manifest,
    deniedReasons,
    deliveredContextPackageId: allowed ? input.contextPackage.id : undefined,
    deliveredPolicyDecisionIds: allowed ? input.contextPackage.policyDecisionIds : []
  };
}

function validateAdapterManifestScope(manifest: AdapterManifest): string[] {
  const deniedReasons: string[] = [];
  const scopes = new Set(manifest.scopes);

  if (!scopes.has("context:read")) {
    deniedReasons.push("missing_context_read_scope");
  }
  if (!manifest.privacy.requiresEgressScan) {
    deniedReasons.push("egress_scan_required");
  }
  if (manifest.privacy.allowRawSecret) {
    deniedReasons.push("raw_secret_adapter_output_forbidden");
  }
  if (manifest.privacy.allowRawConfidential) {
    deniedReasons.push("raw_confidential_adapter_output_forbidden");
  }

  for (const forbidden of ["memory:read", "memory:write", "secret:read", "audit:read"] as const) {
    if (scopes.has(forbidden)) {
      deniedReasons.push(`forbidden_scope_${forbidden}`);
    }
  }

  const unsupportedScopes = manifest.scopes.filter((scope) => scope !== "context:read");
  for (const scope of unsupportedScopes) {
    if (!scope.startsWith("memory:") && scope !== "secret:read" && scope !== "audit:read") {
      deniedReasons.push(`unsupported_mvp_scope_${scope}`);
    }
  }

  if (manifest.sandbox.allowMemoryStore) {
    deniedReasons.push("direct_memory_store_access_forbidden");
  }
  if (manifest.sandbox.network) {
    deniedReasons.push("network_sandbox_disabled_for_mvp");
  }
  if (manifest.sandbox.filesystem !== "none") {
    deniedReasons.push("filesystem_sandbox_disabled_for_mvp");
  }
  if (!Number.isFinite(manifest.sandbox.timeoutMs) || manifest.sandbox.timeoutMs < 1 || manifest.sandbox.timeoutMs > 30_000) {
    deniedReasons.push("invalid_or_excessive_timeout");
  }

  return Array.from(new Set(deniedReasons));
}

function parseContextMemorySource(flags: Record<string, FlagValue>): "auto" | "sqlite" | "legacy_json" {
  const source = stringFlag(flags, "memory-source") ?? "auto";
  if (source !== "auto" && source !== "sqlite" && source !== "legacy_json") throw new CliUsageError("--memory-source must be auto, sqlite, or legacy_json.");
  return source;
}

function rankPolicySafeMemoryForPreflight(memory: PolicySafeMemoryResult[], intent: InferredIntent, includeLowScore: boolean): PolicySafeMemoryResult[] {
  const minScore = includeLowScore ? 1 : 3;
  return memory
    .map((entry) => {
      const scored = scorePolicySafeMemory(entry, intent);
      return {
        ...entry,
        score: scored.score,
        why: [...entry.why, ...scored.why]
      };
    })
    .filter((entry) => entry.score >= minScore)
    .sort((left, right) => right.score - left.score || right.metadata.importance - left.metadata.importance || left.metadata.id.localeCompare(right.metadata.id))
    .slice(0, 16);
}

function scorePolicySafeMemory(memory: PolicySafeMemoryResult, intent: InferredIntent): { score: number; why: string[] } {
  const corpus = normalizeForPreflight(memory.scoreInputs.join(" "));
  let score = 0;
  const why: string[] = [];

  if (intent.primaryIntent !== "unknown" && corpus.includes(normalizeForPreflight(intent.primaryIntent))) {
    score += 4;
    why.push(`matched primary intent ${intent.primaryIntent}`);
  }

  for (const secondary of intent.secondaryIntents) {
    if (corpus.includes(normalizeForPreflight(secondary))) {
      score += 2;
      why.push(`matched secondary intent ${secondary}`);
    }
  }

  let keywordWeight = 0;
  for (const keyword of intent.keywords) {
    const normalized = normalizeForPreflight(keyword);
    if (normalized && corpus.includes(normalized)) {
      keywordWeight += normalized.length > 3 ? 2 : 1;
    }
  }
  if (keywordWeight > 0) {
    score += keywordWeight;
    why.push(`matched ${keywordWeight} keyword weight`);
  }

  let penalty = 0;
  for (const keyword of intent.negativeKeywords) {
    const normalized = normalizeForPreflight(keyword);
    if (normalized && corpus.includes(normalized)) {
      penalty += 5;
    }
  }
  if (penalty > 0) {
    score -= penalty;
    why.push(`penalized ${penalty} negative keyword weight`);
  }

  score += Math.round(memory.metadata.importance * 2);
  score += Math.round((memory.metadata.priorityScore ?? 0) * 3);
  score += Math.round((memory.metadata.baseActivation ?? 0) * 0.5);
  return { score: Math.max(0, score), why };
}

function policySafeMemoryToSearchResult(memory: PolicySafeMemoryResult): MemorySearchResult {
  return {
    record: {
      id: memory.metadata.id,
      scope: memory.metadata.scope,
      kind: memory.metadata.kind,
      title: memory.metadata.title,
      content: memory.safeContent ?? memory.safeSummary ?? "",
      projectId: memory.metadata.projectId,
      sourceRefs: memory.metadata.sourceRefs,
      tags: memory.metadata.tags,
      importance: memory.metadata.importance,
      confidence: memory.metadata.confidence,
      sensitivity: memory.metadata.sensitivity,
      promptPolicy: memory.metadata.promptPolicy,
      createdAt: memory.metadata.createdAt,
      updatedAt: memory.metadata.updatedAt,
      expiresAt: memory.metadata.expiresAt,
      memoryStrength: memory.metadata.memoryStrength,
      baseActivation: memory.metadata.baseActivation,
      retrievalCount: memory.metadata.retrievalCount,
      lastRetrievedAt: memory.metadata.lastRetrievedAt,
      lastReinforcedAt: memory.metadata.lastReinforcedAt,
      decayRate: memory.metadata.decayRate,
      stability: memory.metadata.stability,
      priorityScore: memory.metadata.priorityScore,
      contextCues: memory.metadata.contextCues,
      supersededBy: memory.metadata.supersededBy,
      status:
        memory.metadata.status === "active" ||
        memory.metadata.status === "weak" ||
        memory.metadata.status === "archived" ||
        memory.metadata.status === "superseded"
          ? memory.metadata.status
          : "active",
      nextReviewAt: memory.metadata.nextReviewAt,
      reviewIntervalDays: memory.metadata.reviewIntervalDays,
      easinessFactor: memory.metadata.easinessFactor,
      reviewCount: memory.metadata.reviewCount,
      version: memory.metadata.version
    },
    score: memory.score,
    activation: memory.metadata.baseActivation,
    baseActivation: memory.metadata.baseActivation,
    priorityScore: memory.metadata.priorityScore,
    mode: memory.mode,
    promptPolicy: memory.metadata.promptPolicy,
    why: memory.why
  };
}

function detectPreflightRiskSignals(blockedMemories: BlockedMemory[], selectedMemories: PolicySafeMemoryResult[]): string[] {
  const signals = new Set<string>();
  for (const blocked of blockedMemories) {
    signals.add(`blocked_${blocked.reason}`);
  }
  if (selectedMemories.some((memory) => memory.mode === "summary" || memory.mode === "metadata_only")) {
    signals.add("raw_memory_withheld");
  }
  if (selectedMemories.length === 0) {
    signals.add("no_policy_safe_memory_selected");
  }
  return Array.from(signals);
}

function generateMvpContextCandidates(
  requestId: string,
  selectedMemories: PolicySafeMemoryResult[],
  blockedMemories: BlockedMemory[],
  riskSignals: string[]
): ContextCandidate[] {
  const policyDecisionIds = selectedMemories.map((memory) => memory.policyDecisionId);
  const missingPolicyDecision = policyDecisionIds.some((id) => id.startsWith("missing-policy-decision:"));
  const minimal: ContextCandidate = {
    id: `${requestId}:minimal_safe`,
    strategy: "minimal_safe",
    memoryIds: [],
    policyDecisionIds: [],
    tokenEstimate: estimateTokens([...riskSignals, ...blockedMemories.map((memory) => memory.safeSummary)].join("\n")),
    score: selectedMemories.length === 0 ? 2 : 1,
    predictedFailures: blockedMemories.length > 0 ? ["blocked memory present; minimal package remains available"] : [],
    blocked: false
  };
  const hybrid: ContextCandidate = {
    id: `${requestId}:hybrid`,
    strategy: "hybrid",
    memoryIds: selectedMemories.map((memory) => memory.metadata.id),
    policyDecisionIds,
    tokenEstimate: estimateTokens(selectedMemories.flatMap((memory) => [memory.metadata.title, memory.safeContent ?? memory.safeSummary ?? ""]).join("\n")),
    score: selectedMemories.reduce((sum, memory) => sum + memory.score, 0),
    predictedFailures: riskSignals.includes("raw_memory_withheld") ? ["some memory was summarized or metadata-only by policy"] : [],
    blocked: missingPolicyDecision,
    blockReason: missingPolicyDecision ? "missing_policy_decision_id" : undefined
  };
  return [minimal, hybrid];
}

function selectMvpCandidate(candidates: ContextCandidate[]): ContextCandidate {
  return candidates
    .filter((candidate) => !candidate.blocked)
    .sort((left, right) => right.score - left.score || right.memoryIds.length - left.memoryIds.length)[0] ?? candidates[0];
}

function createExecutiveConstraints(blockedMemories: BlockedMemory[], riskSignals: string[]): string[] {
  const constraints = [
    "Do not inject or print raw secret memory.",
    "Do not use blocked or deprecated memory as truth.",
    "Respect the effective context role before adapter output."
  ];
  if (blockedMemories.some((memory) => memory.reason === "unauthorized_role")) {
    constraints.push("Do not widen role access to make memory retrieval succeed.");
  }
  if (riskSignals.includes("raw_memory_withheld")) {
    constraints.push("Use summaries only where raw memory was withheld by policy.");
  }
  return constraints;
}

function compilePreflightContextPackage(input: {
  request: ContextRequest;
  candidate: ContextCandidate;
  contextPack: ReturnType<typeof buildContextPack>;
  selectedMemories: PolicySafeMemoryResult[];
  blockedMemories: BlockedMemory[];
  constraints: string[];
}): ContextPackage {
  const contextSummary = JSON.stringify(
    {
      project: input.contextPack.project,
      source: input.contextPack.source,
      memorySource: input.contextPack.memorySource,
      inferredIntent: input.contextPack.inferredIntent,
      relatedModules: input.contextPack.relatedModules,
      relatedFiles: input.contextPack.relatedFiles,
      relatedApi: input.contextPack.relatedApi,
      relatedDatabase: input.contextPack.relatedDatabase,
      knownRules: input.contextPack.knownRules,
      risks: input.contextPack.risks,
      relatedShortTermMemories: input.contextPack.relatedShortTermMemories,
      relatedLongTermMemories: input.contextPack.relatedLongTermMemories,
      recommendedSteps: input.contextPack.recommendedSteps
    },
    null,
    2
  );
  const memoryPolicySummary = input.selectedMemories
    .map((memory) => `${memory.metadata.id}: ${memory.mode}; decision=${memory.policyDecisionId}; score=${memory.score}`)
    .join("\n");
  const blockedMemorySummary = input.blockedMemories.map((memory) => memory.safeSummary);
  const system = [
    "You are receiving a policy-safe LMTI context package.",
    "Use only included context and constraints.",
    "Blocked memory summaries are warnings, not source truth."
  ].join(" ");
  const content = redactText(
    [
      `Task: ${input.request.input}`,
      `Strategy: ${input.candidate.strategy}`,
      "Executive constraints:",
      ...input.constraints.map((constraint) => `- ${constraint}`),
      "Selected memory policy:",
      memoryPolicySummary || "No policy-safe memory selected.",
      "Blocked memory summary:",
      ...blockedMemorySummary.map((summary) => `- ${summary}`),
      "Compiled context:",
      contextSummary
    ].join("\n")
  );

  return {
    id: randomUUID(),
    requestId: input.request.id,
    strategy: input.candidate.strategy,
    system,
    messages: [
      { role: "system", content: system },
      { role: "user", content }
    ],
    constraints: input.constraints,
    blockedMemorySummary,
    tokenEstimate: estimateTokens(content),
    policyDecisionIds: input.candidate.policyDecisionIds
  };
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function normalizeForPreflight(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

export async function readCompiledAmf(cwd: string, amfPath?: string): Promise<AmfDocument> {
  try {
    const amf = await readAmfDocument(amfPath, cwd);
    if (!amf.project.compiledAt || amf.project.checksum === "uncompiled") {
      throw new Error("Project mind has not been compiled yet. Run `lmti compile` first.");
    }
    return amf;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("Project mind not found. Run `lmti compile` first.");
    }
    throw error;
  }
}
