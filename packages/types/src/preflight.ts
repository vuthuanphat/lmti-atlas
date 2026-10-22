import type { AccessRole } from "./privacy";
import type { ContextMemorySource, ContextSourceFreshness } from "./index";
import type {
  InferredIntent,
  MemoryConfidence,
  MemoryContextMode,
  MemoryKind,
  MemoryScope,
  MemorySensitivity,
  PromptPolicy
} from "./memory";

export type MemoryLifecycleStatus = "active" | "weak" | "archived" | "superseded" | "deprecated" | "pending" | "rejected" | "expired";

export type HardGateReason =
  | "secret"
  | "do_not_prompt"
  | "wrong_project"
  | "unauthorized_role"
  | "deprecated_as_truth"
  | "archived"
  | "expired"
  | "pending_review"
  | "missing_source";

export type PolicyAction = "read_metadata" | "read_content" | "inject_context" | "summarize_context";

export type PolicyEffect = "allow" | "summarize" | "block";

export interface ContextRequest {
  id: string;
  input: string;
  projectId: string;
  userId: string;
  agentId: string;
  observerRole: AccessRole;
  modelTarget: string;
  createdAt: string;
  tokenBudget?: number;
}

export interface ObserverFrame {
  observerRole: AccessRole;
  sinkRole: AccessRole;
  effectiveContextRole: AccessRole;
  projectId: string;
  userId: string;
  agentId: string;
  modelTarget: string;
}

export interface MemoryMetadata {
  id: string;
  scope: MemoryScope;
  kind: MemoryKind;
  title: string;
  projectId: string;
  sourceRefs: string[];
  tags: string[];
  importance: number;
  confidence: MemoryConfidence;
  sensitivity: MemorySensitivity;
  promptPolicy: PromptPolicy;
  status: MemoryLifecycleStatus;
  memoryStrength?: number;
  baseActivation?: number;
  retrievalCount?: number;
  lastRetrievedAt?: string;
  lastReinforcedAt?: string;
  decayRate?: number;
  stability?: number;
  priorityScore?: number;
  contextCues?: string[];
  supersededBy?: string;
  nextReviewAt?: string;
  reviewIntervalDays?: number;
  easinessFactor?: number;
  reviewCount?: number;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  version: number;
}

export interface PolicyDecision {
  id: string;
  memoryId: string;
  action: PolicyAction;
  effect: PolicyEffect;
  reason: string;
  policyVersion: string;
  memoryVersion: number;
  createdAt: string;
}

export interface BlockedMemory {
  memoryId: string;
  path: string;
  reason: HardGateReason;
  safeSummary: string;
  policyDecisionId: string;
}

export interface MetadataGateResult {
  allowed: MemoryMetadata[];
  blocked: BlockedMemory[];
  policyDecisions: PolicyDecision[];
}

export interface PolicySafeMemoryResult {
  metadata: MemoryMetadata;
  mode: Exclude<MemoryContextMode, "excluded">;
  safeContent?: string;
  safeSummary?: string;
  policyDecisionId: string;
  scoreInputs: string[];
  score: number;
  why: string[];
}

export type ContextCandidateStrategy = "minimal_safe" | "hybrid";

export interface ContextCandidate {
  id: string;
  strategy: ContextCandidateStrategy;
  memoryIds: string[];
  policyDecisionIds: string[];
  tokenEstimate: number;
  score: number;
  predictedFailures: string[];
  blocked: boolean;
  blockReason?: string;
}

export interface ContextPackage {
  id: string;
  requestId: string;
  strategy: ContextCandidateStrategy;
  system: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  constraints: string[];
  blockedMemorySummary: string[];
  tokenEstimate: number;
  policyDecisionIds: string[];
}

export interface ContextEgressScan {
  blocked: boolean;
  findings: string[];
  redactedPreview: string;
}

export interface ContextDecisionExplanation {
  selectedMemoryIds: string[];
  blockedMemories: Array<{ memoryId: string; reason: HardGateReason; safeSummary: string }>;
  selectedStrategy: ContextCandidateStrategy;
  why: string[];
  redactions: string[];
}

export type AdapterScope =
  | "context:read"
  | "memory:read"
  | "memory:write"
  | "secret:read"
  | "audit:read"
  | "tool:execute"
  | "filesystem:read"
  | "filesystem:write"
  | "network";

export type AdapterKind = "model" | "tool" | "plugin";

export interface AdapterPrivacyProfile {
  allowRawSecret: boolean;
  allowRawConfidential: boolean;
  requiresEgressScan: boolean;
  defaultModelTarget: "external_model" | "local";
}

export interface AdapterManifest {
  id: string;
  name: string;
  version: string;
  kind: AdapterKind;
  scopes: AdapterScope[];
  privacy: AdapterPrivacyProfile;
  sandbox: {
    network: boolean;
    filesystem: "none" | "read" | "write";
    allowMemoryStore: boolean;
    timeoutMs: number;
  };
}

export interface AdapterSandboxResult {
  allowed: boolean;
  adapterId: string;
  manifest: AdapterManifest;
  deniedReasons: string[];
  deliveredContextPackageId?: string;
  deliveredPolicyDecisionIds: string[];
}

export interface PreflightResult {
  preflightId: string;
  sourceFreshness?: ContextSourceFreshness;
  memorySource?: ContextMemorySource;
  request: ContextRequest;
  observerFrame: ObserverFrame;
  inferredIntent: InferredIntent;
  selectedMemories: PolicySafeMemoryResult[];
  blockedMemories: BlockedMemory[];
  candidates: ContextCandidate[];
  riskSignals: string[];
  predictedFailures: string[];
  executiveConstraints: string[];
  finalContextPackage: ContextPackage;
  egress: ContextEgressScan;
  adapterSandbox: AdapterSandboxResult;
  explanation: ContextDecisionExplanation;
  metrics: {
    metadataCount: number;
    allowedMemoryCount: number;
    blockedMemoryCount: number;
    selectedMemoryCount: number;
    tokenEstimate: number;
    latencyMs: number;
    phaseLatencyMs: Record<string, number>;
  };
}
