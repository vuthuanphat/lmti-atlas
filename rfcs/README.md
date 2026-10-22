# ATLAS/LMTI RFC Archive

RFCs are archived research notes for ATLAS/LMTI.

They are not current product documentation and they are not implementation
tickets. Some older RFCs use broader "Artificial Mind", "cognitive kernel",
"server", "dashboard", "plugin" or commercial language. Treat that language as
historical vision unless it is restated in the root README or current docs.

For current scope, use:

```text
README.md
ROADMAP.md
docs/architecture.md
docs/privacy-model.md
docs/verification-model.md
docs/adapter-contract.md
docs/cli.md
docs/development.md
```

Current direction is coordinated by `docs/LMTI_MASTER_PLAN.md` and the accepted
`docs/adr/2026-10-11-native-topology.md`. Architecture Studio is the local
topology/IoT application; project memory, privacy, context, verification and
reviewed lessons remain foundations. `docs/component-support.md` identifies
supported and compatibility components. These archived RFCs are not a competing
implementation backlog.

## Research Engineer Rule

Before accepting an RFC, the Research Engineer must ask:

* Why does this need to exist?
* What cognitive problem does it solve?
* What does it refuse to do?
* How does it protect knowledge?
* How does it evolve?
* What are the security risks?
* What are the scaling risks?
* What alternatives were rejected?

## Status Values

```text
Draft
Review
Accepted
Rejected
Superseded
```

## Initial RFC Map

```text
RFC-0001_ARTIFICIAL_MIND.md
RFC-0002_KNOWLEDGE_COMPILER.md
RFC-0003_INTELLIGENCE_GRAPH.md
RFC-0004_MEMORY_SYSTEM.md
RFC-0005_COGNITIVE_PRIVACY.md
RFC-0006_REASONING_ENGINE.md
RFC-0007_EVOLUTION_ENGINE.md
RFC-0008_LMTI_HUMAN_COGNITIVE_STACK.md
RFC-0009_LMTI_COGNITIVE_KERNEL_OPEN_PLATFORM.md
RFC-0010_LMTI_SYSTEM_ARCHITECTURE.md
```

## Acceptance Rule

No RFC is accepted until its security model, replacement boundaries and
evolution path are explicit.
