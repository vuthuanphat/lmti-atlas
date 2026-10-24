# LMTI Layer

## Author

**Author:** Edgar Vu
**Organization:** Cyno Software
**Project:** LMTI — Long Memory / Project Intelligence Layer

LMTI is created and maintained by **Edgar Vu — Cyno Software**.

LMTI is an independent project intelligence and memory layer for AI Agents. It is connected to the project by context, not by runtime ownership.

## Naming

LMTI is the public product name.

ATLAS is a legacy/internal codename and Project Atlas artifact name. If `@atlas/*`
packages appear in this repository, treat them as internal implementation
packages of LMTI during local alpha.

## Layer Notice

`.lmti/` contains local project intelligence metadata, memory state, caches, and agent-support artifacts.

LMTI is not an application module, backend module, frontend module, business domain module, route layer, service layer, controller layer, or production runtime service.

## Safe Use

Agents may read LMTI metadata for project context, query policy-safe memory, retrieve lessons, compile project indexes, and store safe lesson candidates after task completion.

Agents must not move LMTI into application folders, import LMTI into runtime code, delete memory/index/lesson data during cleanup, or treat LMTI as part of the product feature tree.

When unsure, preserve LMTI as a separate intelligence layer.
