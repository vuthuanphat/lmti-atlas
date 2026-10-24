# @atlas/runtime

Experimental local runtime helpers for LMTI.

The CLI uses `@atlas/runtime/agent` for project-memory context and Action View;
this entry point does not load the session demo runtime. `@atlas/runtime/demo`
contains `CoreRuntime` and sample session/tool orchestration. The package root
continues exporting both surfaces for existing reference apps. These are
project-memory helpers, separate from the native Studio topology runtime.

This package supports local demos and Codex-facing helper flows. It
orchestrates sessions, sample agents, memory, context loading, tool execution
and security enforcement without requiring an external LLM.

It is not a production runtime and should not be presented as a complete AI
platform.

## Codex Context Orchestrator

The runtime owns `prepareCodexContext` and `reflectAfterTask`, the orchestration
layer between memory retrieval and Codex prompt context.

It:

* routes task intent into `security`, `deployment`, `memory_system`, `database`,
  `erp_workflow`, `ui_ux`, `seo_content` and related categories;
* selects relevant memory zones before retrieval;
* retrieves Short Memory and Long Memory through `@atlas/memory`;
* reranks candidates by intent, zone, keyword match, recency, priority,
  guardrail relevance, repo state and anti-noise penalties;
* rejects duplicate, noisy, weak or over-budget memory with reasons;
* detects Short/Long conflict warnings;
* reflects after a task and saves only reusable lessons or nearby checkpoints.

CLI:

```bash
lmti mind context "fix packing label bug"
lmti mind explain "fix permission routing"
lmti mind reflect --task "implement short memory" --summary "Added TTL notes and promotion flow"
lmti mind debug "write sample packing workflow prompt"
```

All output remains privacy-gated and redacted before it reaches terminal or
Codex-facing context.

`prepareAgentContext` accepts a `FrameworkDetectionResult` from
`@atlas/frameworks`. The Mind Orchestrator then boosts memory from the active
framework and rejects unrelated framework memory, for example avoiding Next.js
middleware lessons during a Laravel middleware task.

## Codex Action View

`@atlas/runtime` also owns the local Action View observability service. It uses
SQLite at `.lmti/actions/codex-actions.sqlite` to track:

* Codex sessions and final status.
* Timeline actions.
* File read/modify/create/delete/rename events.
* Command execution summaries and exit codes.
* Decisions with related files and memory ids.
* Memory context usage.
* Post-task reflections.
* Scope and risk analysis.
* Replay-safe timeline snapshots.

The service exports `startCodexSession`, `logCodexAction`,
`logCodexFileEvent`, `logCodexCommandEvent`, `logCodexDecision`,
`logCodexMemoryUsage`, `logCodexReflection`, `endCodexSession`,
`evaluateCodexScope`, `analyzeCodexRisk`, `getCodexSessionDetail`,
`getCodexReplay` and safe HTML renderers for dashboard/session/replay views.

It does not store full raw file contents or long command output. Diff and output
summaries are redacted before persistence and before HTML/API output.

Typical flow:

```bash
lmti actions start --task "fix permission routing"
lmti actions log --session-id <id> --type file_modified --file src/auth/middleware.ts --diff-summary "Adjusted role guard"
lmti actions command --session-id <id> --command "npm test" --exit-code 0 --output-summary "tests passed"
lmti actions decision --session-id <id> --decision "Keep least privilege" --related-files src/auth/middleware.ts
lmti actions memory --session-id <id> --memory-id <memory-id> --memory-type long --used-in-decision
lmti actions reflection --session-id <id> --summary "Fixed route safely" --tests-run "npm test"
lmti actions end --session-id <id> --status completed
lmti actions show <id>
lmti actions replay <id> --html
lmti actions risks
```

For future UI integration, call the runtime service directly:

* `listCodexSessions` and `getCodexActionStats` power the dashboard list.
* `getCodexSessionDetail` powers a session detail page.
* `getCodexReplay` powers deterministic replay.
* `listCodexRiskItems` powers review queues.
* `renderCodexActionDashboardHtml`, `renderCodexSessionDetailHtml` and
  `renderCodexReplayHtml` are local safe renderers for CLI/internal views.

Security boundary: Action View records operational evidence, not raw knowledge.
The SQLite database is local plaintext today, so callers must keep passing only
redacted summaries, metadata, file paths and memory ids. Full file contents,
credentials and private documents should stay outside action logs.

For framework-aware review, call `analyzeCodexRiskWithFramework` with the
detection result from `@atlas/frameworks`. It merges Action View evidence with
framework risk zones and verification plans without changing the existing sync
`analyzeCodexRisk` API.
