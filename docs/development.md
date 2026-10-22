# Development

> Status: Local-alpha documentation

This document covers local development for contributors.

For the native C++/Qt desktop and Python Agent SDK, see
[Architecture Studio development](topology-studio.md). The commands below
continue to build the existing TypeScript memory/context components.

## Requirements

- Node.js 24 for the full verified TS build/test and memory workflow.
- Corepack with pnpm.
- Existing package `engines >=20` is broad import/CLI metadata, not a claim that
  Node 20 provides `node:sqlite` or passes the complete suite. Use Node 24 for
  SQLite-backed memory, native config loading in Vitest and the CI path.

## Toolchain and verification matrix

| Domain | Toolchain | Verification |
| --- | --- | --- |
| Project memory / CLI | Node 24, pinned pnpm, TypeScript | `corepack pnpm build`, `corepack pnpm test` |
| Go compatibility | Go 1.22+, Node with `node:sqlite` | `go test ./...`; record skipped tests, especially storage |
| Native Studio | C++20/MSVC, CMake 3.24+, Qt 6.12+ | Build/package script and CTest from the [Studio guide](topology-studio.md) |
| Topology Agent | Python 3.11+, packaged native binary | Unittest from the Studio guide; integration skips when `LMTI_TOPOLOGY_BINARY` is missing |
| Local MCP web | Node 24, React/TypeScript/Vite, native/Python owners | `corepack pnpm web:build`; `web:api:test` with native fixture and test Python; isolated browser workflows and [package guide](local-web.md) |

Vitest uses native config loading with `vitest.config.mts`; this avoids an
esbuild config scan of parent directories in restricted workspaces. Record
pass/fail/skip and exact tool versions rather than accepting a green command
whose integration tests did not run. See the [execution report](plans/2026-10-11-cleanup-execution.md).

## Setup

```bash
corepack pnpm install
```

## Build

```bash
corepack pnpm build
```

The build command uses TypeScript project references across packages and apps.

## Test

```bash
corepack pnpm test
```

## CLI Smoke Checks

Run commands that initialize/compile/write state in a disposable fixture
workspace. Do not use the owner's memory or real customer topology as test data.

```bash
node packages/cli/dist/index.js --help
node packages/cli/dist/index.js doctor
node packages/cli/dist/index.js doctor --security
node packages/cli/dist/index.js compile ./examples/sample-project
node packages/cli/dist/index.js context "fix packing label bug"
node packages/cli/dist/index.js preflight "permission routing issue" --role developer --model-target external_model
```

## Privacy Smoke Checks

```bash
node packages/cli/dist/index.js memory privacy-check
node packages/cli/dist/index.js privacy check
```

Do not paste real secrets into test commands. Use obvious fake values if a
fixture requires secret-like text.

Legacy JSON migration is inventory-only while lossless policy/provenance and
lifecycle mapping is incomplete. Use `memory migrate-json --dry-run`; actual
imports fail before opening the target store when legacy records exist.
Topology SQLite is not the destination for project-memory migration.

## Package Notes

The root package is private. Public package distribution is not finalized.

The `lmti` CLI package currently has workspace dependencies, so publishing needs
a deliberate release process before it should be advertised as installable from
the npm registry.

