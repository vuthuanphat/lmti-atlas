# Architecture

> Status: Local-alpha documentation

The current presentation is a **React + Vite local browser workspace** over a
thin authenticated Node.js API. The [browser-only ADR](adr/2026-10-23-browser-only-ui.md)
supersedes the former Qt Widgets UI. Qt Core/Sql remains in the typed C++/SQLite
owners; no desktop executable, GUI runtime or fallback launcher is shipped.

The browser/API coordinate explicit operator intent. Native owners retain
project/library/profile schema, validation, transactions and revision authority.
Python owns client config merge, current-user DPAPI backups/recovery and scoped
stdio SDK/MCP. TypeScript owns compiled project knowledge, memory, privacy and
reviewed impact/mapping stores. Go retains its separate experimental memory
schema through the Node SQLite bridge. Node does not become another native
storage owner, and Agents do not receive raw database handles or operator tokens.

Project MCP profiles generate client configuration for Codex/Cursor. This is
configuration management, not an enforcement proxy or proof of provider access.
The integrated Agent reads native structure, mapped summaries and eligible memory
with source/evidence/freshness. Controlled replay is distinct from live telemetry.
Device execution and arbitrary shell tools are not part of this boundary.

See [current capability parity](web-capabilities.md), [web setup](local-web.md),
[Agent layer](agent-layer.md), [MCP profile](project-mcp.md) and the
[remediation plan](plans/2026-10-23-audit-remediation.md). Historical desktop ADRs,
screenshots and WEB-00 prototypes are evidence of former work, not active UI.

Topology/profile metadata is nonsecret-only. SQLite is not encrypted by this
alpha; filesystem/egress controls are not encryption or an OS sandbox. DPAPI
protects client backup/journal files, not all LMTI stores. External provider,
clean-Windows and independent operator acceptance remain separately recorded.

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
