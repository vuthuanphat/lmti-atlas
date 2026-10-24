# LMTI MVP Build Spec

Status: historical coding-agent implementation contract candidate
Scope: Coding Agent / Codex local MVP
Goal: replace draft tables with a buildable kernel contract

Current implementation direction is coordinated by [the master plan](LMTI_MASTER_PLAN.md)
and [support map](component-support.md). The keep/cut lists below belong to the
earlier coding-agent slice and do not retire current lesson flows or the
accepted local Studio MVP.

This document is not another vision RFC. It is the first build spec for the
LMTI preflight kernel.

## Production Readiness Verdict

Not production-ready yet.

The architecture is now directionally correct, but production readiness requires
a smaller MVP cut. The first production slice must prove one thing only:

```text
Can LMTI produce a policy-safe context package without leaking blocked memory?
```

Everything that does not directly protect or prove that path is deferred.

Keep in MVP:

```text
metadata-first preflight
effective context role
hard metadata gate
safe content loader
policy-safe ranking
minimal/hybrid context packages
egress scan
redacted explanation
append-only audit
CLI preflight
permission routing issue fixture
acceptance tests
```

Cut from MVP:

```text
dashboard UI
plugin registry
adapter marketplace
vector DB
server mode
full SDK surface
offline reflection daemon
memory consolidation workflow
lesson approval workflow
runtime eval CLI
multi-model adapter suite
six-package preflight battle UI
```

Deferred does not mean rejected. It means "not before the secure preflight path
passes tests."

The MVP is done when a developer can run:

```bash
lmti preflight "permission routing issue" --role developer --model-target external_model
```

and receive a policy-safe context package with selected memories, blocked
memories, predicted failures, executive constraints, explanation, and audit
events.

[SECURITY WARNING] The MVP must fail closed. If memory permission, source
evidence, lifecycle status, or adapter scope is unknown, the memory is not
injected into model context.

Current implementation status in the repository:

```text
lmti preflight exists as the first CLI MVP slice
MemoryMetadata projection exists and does not expose content
hardGateMemoryMetadata exists in packages/privacy
PolicySafeMemoryResult exists in packages/types and packages/memory safe loading
runEgressSecretScan exists in packages/privacy
acceptance test covers secret, deprecated-as-truth, unauthorized role, external model sink, and no raw secret output
adapter sandbox delivery gate exists in lmti preflight
adapter/plugin manifest scope enforcement blocks memory store, secret, audit, filesystem, network, and unsupported scopes in MVP
lmti benchmark preflight exists for hot-path latency measurement
egress fixtures cover private key, AWS key, JWT, database URL, and generic secret assignment
audit log entries now include hash-chain tamper evidence
lmti privacy audit --verify checks audit integrity
lmti privacy audit --retain N archives older audit events
```

Remaining production hardening:

```text
external network adapter execution is still disabled in the MVP sandbox
legacy audit entries created before hash-chain support need archive or migration before full-history verification
latency budget threshold still needs CI enforcement
egress scanner still needs organization-specific fixtures before enterprise use
```

Passing TypeScript build and package tests is required, but it is not enough for
full production. The repository now has the first executable preflight slice and
delivery sandbox; external network adapter execution remains intentionally
locked until an explicit adapter runtime is reviewed.

## 1. Locked MVP Decisions

These decisions are not drafts for the MVP.

1. LMTI is a kernel pipeline, not a memory search command.
2. The hot path is metadata-first.
3. Raw memory content is not loaded until metadata passes policy.
4. Secret, `do_not_prompt`, wrong-project, unauthorized-role, and
   deprecated-as-truth memory are hard blocked before scoring.
5. Cognitive mass ranks only policy-safe memory.
6. Context preflight receives only policy-safe candidates.
7. Context compiler never accepts blocked raw memory.
8. Adapter calls pass through manifest scope validation and egress scan.
9. Audit is internal truth, but not a raw secret dump. Log stable ids, hashes,
   policy facts, and decision reasons instead of secret payloads.
10. Offline reflection, consolidation, decay, and broad eval are async.
11. Adapter/plugin manifests cannot request direct memory store access in MVP.
12. If egress scan or adapter sandbox fails, no context package is delivered.

## 2. MVP Package Ownership

`packages/types` owns contracts only:

```text
ContextRequest
ObserverFrame
MemoryMetadata
PolicyDecision
PolicySafeMemoryResult
ContextCandidate
ContextPackage
ContextDecisionExplanation
AuditEvent
```

`packages/privacy` owns policy decisions:

```text
inferSinkRole
deriveEffectiveContextRole
hardGateMemoryMetadata
redactText
runEgressSecretScan
```

`packages/memory` owns memory storage and safe loading:

```text
retrieveMemoryMetadata
fetchAllowedMemoryContent
searchMemoryForContext legacy path
```

`packages/kernel` owns AMF context scoring and compiled context packs:

```text
inferIntent
buildContextPack
MindKernel
```

`packages/cli` owns the MVP preflight orchestration and developer commands:

```text
lmti preflight
lmti preflight --adapter-manifest adapter.json
lmti benchmark preflight
lmti privacy audit --verify
lmti privacy audit --retain N
preflightCommand
rankPolicySafeMemoryForPreflight
generateMvpContextCandidates
compilePreflightContextPackage
```

## 3. Core Type Contracts

These are the minimum contracts needed before implementation starts.

```ts
export type Role =
  | "owner"
  | "maintainer"
  | "developer"
  | "agent"
  | "readonly"
  | "external_model";

export type MemorySensitivity = "public" | "internal" | "confidential" | "secret";
export type PromptPolicy = "allow_raw" | "summarize_only" | "do_not_prompt";

export interface ContextRequest {
  id: string;
  input: string;
  projectId: string;
  userId: string;
  agentId: string;
  observerRole: Role;
  modelTarget: string;
  tokenBudget: number;
  createdAt: string;
}

export interface ObserverFrame {
  id: string;
  requestId: string;
  projectId: string;
  userId: string;
  agentId: string;
  observerRole: Role;
  sinkRole: Role;
  effectiveContextRole: Role;
  modelTarget: string;
}

export interface MemoryMetadata {
  id: string;
  scope: "short_term" | "long_term";
  kind: string;
  title: string;
  projectId: string;
  sourceRefs: string[];
  tags: string[];
  importance: number;
  confidence: "low" | "medium" | "high";
  sensitivity: MemorySensitivity;
  promptPolicy: PromptPolicy;
  status: "active" | "deprecated" | "expired" | "pending" | "rejected";
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  version: number;
}

export interface PolicyDecision {
  id: string;
  memoryId: string;
  action: "read_metadata" | "read_content" | "inject_context" | "summarize_context";
  effect: "allow" | "summarize" | "block";
  reason: string;
  policyVersion: string;
  memoryVersion: number;
  createdAt: string;
}

export interface PolicySafeMemoryResult {
  metadata: MemoryMetadata;
  mode: "raw" | "summary" | "metadata_only";
  safeContent?: string;
  safeSummary?: string;
  policyDecisionId: string;
  scoreInputs: string[];
  score: number;
  why: string[];
}

export interface BlockedMemory {
  memoryId: string;
  path: string;
  reason:
    | "secret"
    | "do_not_prompt"
    | "wrong_project"
    | "unauthorized_role"
    | "deprecated_as_truth"
    | "expired"
    | "pending_review"
    | "missing_source";
  safeSummary: string;
  policyDecisionId: string;
}

export interface ContextCandidate {
  id: string;
  strategy: "minimal_safe" | "hybrid";
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
  strategy: "minimal_safe" | "hybrid";
  system: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  constraints: string[];
  blockedMemorySummary: string[];
  tokenEstimate: number;
  policyDecisionIds: string[];
}
```

## 4. Hot Path Pseudocode

This is the MVP pipeline implemented by `preflightCommand`.

```ts
export async function preflightCommand(cwd, task, options): Promise<PreflightResult> {
  const amf = await readCompiledAmf(cwd, options.amfPath);
  const intent = inferIntent(task);

  const observer = {
    observerRole,
    sinkRole: inferSinkRole(modelTarget),
    effectiveContextRole: deriveEffectiveContextRole(observerRole, modelTarget),
    projectId: amf.project.name
  };

  const metadata = await retrieveMemoryMetadata({ cwd, now });

  const gate = hardGateMemoryMetadata({ metadata, observer, privacyContext, now });

  const safeMemory = await fetchAllowedMemoryContent({
    cwd,
    metadata: gate.allowed,
    privacyContext,
    taskIntent: intent,
    policyDecisions: gate.policyDecisions
  });

  const selectedMemories = rankPolicySafeMemoryForPreflight(safeMemory, intent);
  const contextPack = buildContextPack(amf, task, { memories: selectedMemories });
  const candidates = generateMvpContextCandidates(selectedMemories, gate.blocked);
  const selected = selectMvpCandidate(candidates);
  const context = compilePreflightContextPackage(selected, contextPack, gate.blocked);

  const egress = runEgressSecretScan(context);
  await appendAuditEvent(cwd, egress.blocked ? "preflight.egress_blocked" : "preflight.completed");

  return {
    preflightId,
    inferredIntent: intent,
    observerFrame: observer,
    selectedMemories,
    blockedMemories: gate.blocked,
    finalContextPackage: context,
    egress,
    explanation
  };
}
```

## 5. Hard Gate Rules

Hard gate runs on metadata, before content load and before scoring.

```ts
function hardGateMemoryMetadata(input: {
  metadata: MemoryMetadata[];
  observer: ObserverFrame;
  intent: TaskIntent;
}): MetadataGateResult {
  const allowed: MemoryMetadata[] = [];
  const blocked: BlockedMemory[] = [];

  for (const memory of input.metadata) {
    if (memory.projectId && memory.projectId !== input.observer.projectId) {
      blocked.push(block(memory, "wrong_project"));
      continue;
    }

    if (memory.promptPolicy === "do_not_prompt") {
      blocked.push(block(memory, "do_not_prompt"));
      continue;
    }

    if (memory.sensitivity === "secret") {
      blocked.push(block(memory, "secret"));
      continue;
    }

    if (memory.status === "deprecated") {
      blocked.push(block(memory, "deprecated_as_truth"));
      continue;
    }

    if (memory.status === "pending" || memory.status === "rejected") {
      blocked.push(block(memory, "pending_review"));
      continue;
    }

    if (!roleCanUseMemory(input.observer.effectiveContextRole, memory)) {
      blocked.push(block(memory, "unauthorized_role"));
      continue;
    }

    allowed.push(memory);
  }

  return { allowed, blocked };
}
```

This is deliberately strict. Later versions may allow secret metadata for owner
local inspection, but the model-bound preflight path must not.

## 6. Effective Context Role

The observer and the sink are different things.

```text
observerRole = who asks LMTI
sinkRole = where the context goes
effectiveContextRole = the stricter of observerRole and sinkRole
```

Examples:

```text
developer + local CLI inspect -> developer
developer + external model -> external_model
owner + external model -> external_model
owner + local audit dashboard -> owner
agent + Codex local adapter -> agent
```

MVP rule:

```ts
function inferSinkRole(modelTarget: string): Role {
  if (modelTarget.startsWith("local:")) return "agent";
  if (modelTarget.startsWith("codex:local")) return "agent";
  return "external_model";
}
```

This prevents a developer command from accidentally giving developer-level raw
memory to an external model.

## 7. Context Candidate Strategies

Production MVP builds only these candidates:

```text
minimal_safe
hybrid
```

Do not build separate `keyword`, `intent`, `role_permission`, or `lesson`
packages in the first production slice. Those signals are scoring inputs inside
`hybrid`, not separate package products.

Candidate generation input is `PolicySafeMemoryResult[]`, not raw
`MemoryRecord[]`.

`minimal_safe` must contain:

```text
task summary
critical permission rule summaries
critical negative lessons
blocked memory summary
executive constraints
next action suggestion
```

If all richer packages fail preflight, `minimal_safe` is the fallback.

V1 can add separate package strategies after the MVP proves that hard gates,
egress scan, and explanations are reliable.

## 8. Scoring Contract

Hard blockers are structural, not score penalties.

```ts
interface PackageScore {
  packageId: string;
  blocked: boolean;
  blockReason?: string;
  finalScore: number;
  components: {
    taskRelevance: number;
    privacySafety: number;
    roleSafety: number;
    lessonCoverage: number;
    failurePrevention: number;
    actionability: number;
    noisePenalty: number;
    contradictionPenalty: number;
    staleMemoryPenalty: number;
  };
}
```

If `blocked === true`, `finalScore` is ignored.

MVP hard blockers:

```text
raw secret included
do_not_prompt included
wrong project memory included
unauthorized role memory included
deprecated memory used as truth
missing policy decision id
missing source evidence for high-risk task
egress scan failed
```

## 9. CLI Contract

MVP command:

```bash
lmti preflight "permission routing issue" --role developer --model-target external_model
```

Required output shape:

```json
{
  "preflightId": "pf_...",
  "intent": {},
  "observerFrame": {
    "observerRole": "developer",
    "sinkRole": "external_model",
    "effectiveContextRole": "external_model"
  },
  "attentionFocus": {},
  "selectedMemories": [],
  "blockedMemories": [],
  "riskSignals": [],
  "predictedFailures": [],
  "executiveConstraints": [],
  "finalContextPackage": {},
  "explanation": {},
  "metrics": {}
}
```

The CLI must not print raw blocked memory. `blockedMemories` contains safe
summaries only.

## 10. Demo Fixture

The first fixture is fixed.

Input:

```text
permission routing issue
```

Memory pool:

```text
logo guideline
dashboard UI color
route /dashboard/summary
partner route /partner
admin route /admin
permission rule partner/admin/staff
previous bug partner 403
lesson least privilege
company profile
API dashboard summary
coding convention
secret API key
deprecated memory partner uses /dashboard
```

Expected selected:

```text
route /dashboard/summary
partner route /partner
admin route /admin
permission rule partner/admin/staff
previous bug partner 403
lesson least privilege
API dashboard summary
coding convention only if code change needed
```

Expected blocked:

```text
secret API key -> secret
deprecated partner /dashboard -> deprecated_as_truth
```

Expected rejected:

```text
logo guideline
dashboard UI color
company profile
```

Expected constraints:

```text
Do not change 403 to 200 before verifying role.
Check /partner for partner users and /admin for admin users.
Check permission rule partner/admin/staff.
Do not widen partner into admin permissions.
Do not inject or print secrets.
Do not use deprecated partner /dashboard memory as truth.
```

## 11. Acceptance Tests

These tests define MVP correctness.

```text
Given a secret memory with perfect keyword match
When preflight runs
Then the memory is hard blocked before scoring
And no raw content reaches ranking, preflight, compiler, or adapter.
```

```text
Given a do_not_prompt memory
When preflight runs
Then it is blocked at metadata gate
And the explanation says only "do_not_prompt memory blocked".
```

```text
Given developer role and external model target
When observer frame is created
Then effectiveContextRole is external_model.
```

```text
Given deprecated partner /dashboard memory
When task is permission routing issue
Then it is blocked as deprecated_as_truth
And it may appear only in blocked memory summary.
```

```text
Given a package candidate with missing policyDecisionIds
When MVP candidate selection runs
Then the package is structurally blocked.
```

```text
Given a compiled context containing a secret-like string
When runEgressSecretScan runs
Then adapter call is blocked
And audit records context.egress_blocked.
```

```text
Given an adapter or plugin manifest requesting memory:read
When lmti preflight prepares adapter delivery
Then adapterSandbox.allowed is false
And no context package id is delivered.
```

```text
Given an adapter or plugin manifest with allowMemoryStore=true
When lmti preflight prepares adapter delivery
Then adapterSandbox.allowed is false
And audit records preflight.adapter_blocked.
```

```text
Given private key, AWS key, JWT, database URL, or generic secret assignment fixtures
When runEgressSecretScan runs
Then the context package is blocked and redactedPreview does not contain the raw secret.
```

```text
Given audit events written by appendAuditEvent
When lmti privacy audit --verify runs
Then hash-chain integrity is valid unless an event was tampered.
```

```text
Given more audit events than the retention limit
When lmti privacy audit --retain N runs
Then older events are archived and the retained chain remains verifiable.
```

```text
Given lmti benchmark preflight with multiple runs
When the benchmark completes
Then p50, p95, average, min, max, and phase latencies are reported.
```

## 12. Implementation Order

Build in this exact order.

1. Add core types in `packages/types`.
2. Add effective context role in `packages/privacy`.
3. Add metadata projection in `packages/memory`.
4. Add metadata hard gate in `packages/privacy`.
5. Add safe content loader in `packages/memory`.
6. Add `PolicySafeMemoryResult` safe loading in `packages/memory`.
7. Add `lmti preflight` orchestration in `packages/cli`.
8. Add MVP context candidates and structural hard blockers.
9. Add egress secret scan before adapter output.
10. Add `lmti preflight` CLI command.
11. Add demo fixture.
12. Add acceptance tests.

Dashboard UI, plugin registry, vector DB, server mode, reflection daemon, and
consolidation workflow are outside this MVP. They require a separate RFC and
production gate after this spec passes.

## 13. Definition Of Done

The MVP is done only when:

```text
secret_block_rate = 1.0
do_not_prompt_injection_rate = 0
deprecated_as_truth_usage_rate = 0
blocked_raw_fetch_rate = 0
egress_leak_block_rate = 1.0 for known fixtures
context package contains policyDecisionIds for every included memory
explanation contains no raw blocked content
audit contains no raw secret payload
CLI output contains no raw blocked memory
permission routing issue fixture passes
```

This is the first buildable slice of LMTI's policy-safe preflight path.
