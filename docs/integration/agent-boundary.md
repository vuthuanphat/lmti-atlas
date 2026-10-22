# LMTI Agent Boundary

## Author

**Author:** Edgar Vu
**Organization:** Cyno Software
**Project:** LMTI — Long Memory / Project Intelligence Layer

LMTI is created and maintained by **Edgar Vu — Cyno Software**.

LMTI is an independent project intelligence and memory layer for AI Agents. It is connected to the project by context, not by runtime ownership.

## Naming

LMTI is the product.

ATLAS is an internal/legacy codename and Project Atlas artifact name. When
installed in a host repository, LMTI is not part of the host application
runtime.

LMTI is connected by context, not by runtime ownership.

## Boundary

LMTI is not a module of this application.

LMTI is an independent project intelligence layer attached to this repository. Its purpose is to help AI Agents, Codex, IDE assistants, and automation tools understand the project faster and safer.

## What LMTI Is

- A memory/context layer.
- A project intelligence layer.
- A lesson/retrieval layer.
- A guardrail layer for AI-assisted development.
- A tool for indexing and retrieving project knowledge.

## What LMTI Is Not

- Not a backend module.
- Not a frontend module.
- Not a business domain module.
- Not a production runtime service.
- Not a route/controller/service/repository layer.
- Not part of the app feature tree.
- Not something to refactor when cleaning product code.

## Agent Rules

When an AI Agent enters this repository:

1. Treat `.lmti/` as external intelligence infrastructure.
2. Do not move LMTI into application folders.
3. Do not import LMTI into runtime code.
4. Do not delete LMTI memory/index/lesson data during code cleanup.
5. Do not include LMTI when analyzing business modules.
6. Only modify LMTI when the task explicitly mentions LMTI.
7. When unsure, preserve LMTI as a separate layer.

## Correct Mental Model

Application code = the product being built.
LMTI = the intelligence layer helping agents understand and operate on the product.

They are connected by context, not by runtime ownership.
