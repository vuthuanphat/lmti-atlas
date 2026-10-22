# Architecture

> Status: Local-alpha documentation

Planning update 2026-10-13: [master r5](LMTI_MASTER_PLAN.md) prioritizes a
[local browser UI](plans/2026-10-13-web-ui-transition.md) for project MCP setup.
The [React/TypeScript MCP SPA](local-web.md) is implemented with a local package;
default cutover remains gated. The [WEB-01 local Node API](plans/2026-10-13-web-api-execution.md)
and native façade now have authenticated HTTP/native/Python evidence. The [ADR](adr/2026-10-13-web-presentation.md)
preserves C++/SQLite ownership, Python stdio SDK/MCP and TS/Go compatibility.
Profile/library console adapters now exist; Node is a thin coordinator, not a second
domain/storage owner. Qt Widgets remains the compatibility/recovery UI until
parity/cutover; Qt Core/Sql remains in native adapters.

Project MCP profiles are shared by Codex/Cursor within the Agent–project layer. The
[CP-01 slice](plans/2026-10-13-project-mcp-profile.md) implements a typed nonsecret
profile owner, client-specific config adapters and Qt setup/preview/verification.
The [profile ADR](adr/2026-10-13-project-mcp-profile.md) defines the implemented
LMCP owner and Python file-format adapter. [Usage](project-mcp.md) records
merge/apply/restore and probe limits. It is not an enforcement proxy; actual
Cursor/operator/live-provider acceptance is open. Large-project structure,
scoped context and real read-only IoT remain the
broader direction; the human UI supports connections, source management and review.
The implemented architecture below remains the local-alpha boundary.
Observation/network/cache ownership needs an additional ADR; a direct collector
or shared service is conditional on the pilot, not an existing capability.

Before selecting CP-01, the owner authorized r3 execution. The [M1 design](plans/2026-10-13-agent-layer-m1.md)
and [additive boundary ADR](adr/2026-10-13-agent-project-layer.md) specify the
common envelope and local profile. Installed Codex MCP client feasibility has
synthetic evidence. The additive [native read layer](agent-layer.md) now maps
owner snapshots to common envelopes with lookup/paging/relations; existing
interfaces below keep their schemas and owners. Cross-source/live acceptance is open.

LMTI organizes project knowledge and system architecture for AI agents.
Memory, context, privacy, verification and reviewed lessons are independent
foundations; Architecture Studio owns the separate topology/IoT domain.
The [master plan](LMTI_MASTER_PLAN.md) coordinates the current direction and the
[support map](component-support.md) records component ownership.

The accepted local Studio MVP uses a Qt-independent C++20 domain, Qt Core/Sql
storage and JSON adapters, Qt Widgets desktop, and Python SDK/MCP. The SDK calls
the native CLI with fixed arguments and trusted launcher scope. Proposal review
changes the document; save commits a revision. There is no device dispatch.
See the [Studio guide](topology-studio.md) and [ADR](adr/2026-10-11-native-topology.md).

TS remains the project-memory implementation. Go retains experimental memory
compatibility with a separate schema and Node SQLite bridge. Topology and memory
link through context/evidence, not shared schema or direct Agent store handles.
Topology SQLite is unencrypted and supports only nonsecret public/internal
metadata. Same-user launcher grants do not provide an OS sandbox or multi-user
authorization. The Codex-first project-memory pipeline follows below.

Naming note: LMTI is the product name. ATLAS is a legacy/internal codename, and
Project Atlas is the compiled project map artifact produced by `lmti compile`.
The `@atlas/*` packages are internal implementation packages of LMTI during
local alpha.

```text
AI Agent Task
     |
     v
Intent Classifier
     |
     v
Context Router
     |
     v
Memory Core + Project Atlas
     |
     v
Privacy Gate
     |
     v
Verification Metadata
     |
     v
Agent Adapter
     |
     v
AI Agent
     |
     v
Lesson Capture
```

## Layers

### AI Agent Task

The task starts as a short human request such as "fix a failing CLI test".
LMTI treats that request as untrusted input until it is routed through intent,
privacy, and verification checks.

### Intent Classifier

The kernel infers task intent and keywords. This helps route context without
loading the whole repository into the prompt.

### Context Router

The context path selects relevant AMF and memory candidates for the task. It
should prefer small, useful, policy-safe context over broad file dumps.

### Memory Core

Memory stores deliberate project knowledge: lessons, rules, decisions, bugs,
routes, deployment notes, and workflow constraints. Memory is guidance, not
truth.

### Project Atlas

`lmti compile` creates `.lmti/project.amf.json`, the current Project Atlas
artifact. It contains structured repository understanding and source-boundary
metadata.

### Privacy Gate

Privacy gates decide whether memory can be loaded, summarized, blocked, or
exported. Secret and `do_not_prompt` memory must not enter normal agent context.

### Verification Metadata

Verification metadata tells an agent what should be checked before acting. The
target contract is documented in [verification-model.md](verification-model.md).

### Agent Adapter

The current adapter surface is a policy contract: preflight builds a safe
context package and validates adapter manifests through sandbox checks. Codex is
the primary workflow today; other agent runtimes are not implemented as
supported delivery paths yet.

The adapter sandbox checks are policy/manifest validation, not process or OS
isolation. Reference session demos pass in-process memory helpers to local
sample agents and must not be promoted to an external Agent boundary.

### Lesson Capture

After a task, lesson candidates can be proposed through `lmti task done
--lesson ...` or `lmti memory lesson propose`. A candidate becomes durable
project memory only after privacy checks, evidence review, confidence scoring,
and explicit approval. Lessons should be short, safe, and reusable.

## Package Boundaries

```text
packages/types       Shared AMF, memory, privacy, and preflight contracts.
packages/compiler    Project Atlas / AMF compiler.
packages/kernel      Intent inference and AMF Context Pack scoring.
packages/memory      Memory lifecycle, SQLite project memory, retrieval, lessons.
packages/privacy     Redaction, access policy, hard gates, egress scan, audit.
packages/frameworks  Framework detection, commands, risk zones, verify plans.
packages/runtime     Codex context preparation, Action View, runtime orchestration.
packages/security    Tool permission guard.
packages/cli         Command adapter for local workflows.
```

CLI imports the context/action API through `@atlas/runtime/agent`; the package
root retains the reference demo exports for compatibility. Demo session/tool
orchestration is isolated in `demo-runtime.ts`. The MCP TS package remains a
project-memory stub; Python MCP is a topology transport, not its replacement.
