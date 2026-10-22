# Historical coding-agent roadmap

Status: historical research/direction, archived during cleanup on 2026-10-11.
The [current roadmap](../../ROADMAP.md) and [master plan](../LMTI_MASTER_PLAN.md)
coordinate implementation. The original stages below preserve the foundation
goals; they are not a competing backlog or a claim of current capabilities.

LMTI is currently focused on AI coding agents, not a complete AI platform.
The long-term vision is a broader operating memory layer for AI systems, but
the current product focus is local agent workflows.

## Stage 1 - Local Alpha

- Stable CLI workflow from source.
- Project Atlas through `lmti compile`.
- Memory Core for deliberate project lessons, rules, decisions, and short notes.
- Context Router through `lmti context`.
- Privacy Gate and egress scanning.
- Verification metadata contract.
- Lesson Capture through `lmti task done` and `lmti memory lesson`.
- Doctor and Preflight checks.
- Codex-first workflow.
- Full test stability.
- Quickstart and contribution docs.

## Stage 2 - Agent Beta

- Reusable SDK/API around preflight and context assembly.
- Stronger adapter package boundary outside the CLI.
- Local dashboard or terminal UI for context, actions, and risk review.
- More coding-agent workflows beyond Codex.
- Context explanation improvements.
- Benchmark cases based on real agent traces.
- First-class per-context-item verification fields.

## Stage 3 - Public Product

- Package release and installation docs.
- Example repositories.
- Docs site.
- CI integration examples.
- Team policy design.
- Security policy maturity and disclosure process.
- Enterprise/self-hosted options if the local product proves reliable first.

## Not Current Scope

- Production-ready cloud service.
- Enterprise-ready team dashboard.
- Universal support for every AI agent.
- Hosted memory sync.
- Complete broader AI runtime.
- Automatic secret scanning replacement.
