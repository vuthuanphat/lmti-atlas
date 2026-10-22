# Cleanup Report

> Status: Local-alpha documentation

Date: 2026-07-02. Status of tables below: historical audit.

Current cleanup evidence is in the [2026-10-11 execution report](plans/2026-10-11-cleanup-execution.md)
and [component support map](component-support.md). The original findings below
are preserved; they do not override the accepted native topology ADR.

Scope: safe cleanup scan before further feature work. This pass does not delete,
rewrite, force-push, or migrate data. It classifies the repository and records
cleanup candidates for review.

Guiding rule:

```text
Clean first, change carefully, preserve behavior.
```

## Strict Repository Audit

| Path | Category | Action | Reason | Risk |
|---|---|---|---|---|
| `README.md` | docs | refactor | Product definition is active public positioning; duplicate wording was removed and Go identity checks were aligned to it. | Medium if command lists drift from implementation. |
| `ROADMAP.md` | roadmap-only | keep | Separates current local workflow from not-current-scope items. | Low; keep universal-agent wording only under not-current-scope. |
| `SECURITY.md` | docs | keep | Root security entry point; private reporting contact is still a release TODO. | Medium until contact path is finalized. |
| `docs/security.md` and `docs/security/*` | docs | keep | Defines privacy levels, adapter boundaries, threat model, and checklist. | Medium; audit commands must stay aligned with actual CLI status. |
| `docs/thoth.md` | docs | keep | Defines Thoth as skill routing only and separates primary from diagnostic commands. | Low. |
| `docs/skills.md` | docs | keep | Defines `skill.md` as instruction contract, not code or memory. | Low; keep secret scans active. |
| `docs/agent-usage.md` | docs | keep | JSON-first flow for routing, selected skill loading, safe memory, and policy gates. | Medium if agents treat diagnostics as required workflow. |
| `docs/cli.md` | docs | keep | Main command map for TypeScript CLI plus experimental Go core. | Medium; must mark Go core and diagnostics honestly. |
| `docs/roadmap.md` | roadmap-only | keep | Go/SQLite/TOML/JSON-boundary migration plan and deferred technologies. | Low. |
| `docs/cleanup-report.md` | docs | refactor | Audit table now uses the strict `Action` format requested for cleanup work. | Low. |
| `docs/reality-checklist.md` | docs | keep | Manual checklist for claims not fully covered by automated tests. | Low. |
| Legacy ATLAS architecture and sprint docs | legacy | manual-review | Preserve history; treat artificial-mind language as archive/vision only. | High if published without archive context. |
| `docs/LMTI_MVP_BUILD_SPEC.md` | legacy | manual-review | Contains MVP acceptance language and command claims that should be checked before public docs reuse. | Medium. |
| `docs/NEURAL_ARCHITECTURE_AUDIT.md` | experimental | manual-review | Useful critique, but name can imply broader AI architecture than current product scope. | Medium. |
| `skills/registry.toml` | active | keep | Current Thoth registry source. | Medium if registry and skill files diverge. |
| `skills/**/*.md` | active | keep | Operation instructions for agents; not executable code and not memory. | Medium if commands in skills become stale. |
| `prompts/` | unknown | manual-review | Requested scan target, but no `prompts/` directory exists in this workspace. | Low. |
| Go core paths | core | refactor | Experimental foundation for config, storage, policy, memory, publish, adapter, and Thoth. | Medium until Go tests run locally. |
| `packages/*` | active | keep | Current working TypeScript local-alpha implementation and tests. | Medium if Go docs imply replacement before parity. |
| `.lmti/*` runtime state | unsafe | manual-review | Local generated state and memory; do not print raw or publish. | High leakage risk if mishandled. |
| Legacy local paths | legacy/unused | manual-review | Do not delete without owner confirmation and worktree review. | Medium to high depending on hidden local state. |

## Current Structure

| Group | Paths | Status | Notes |
| --- | --- | --- | --- |
| core | `packages/*`, `apps/*` | keep | Current TypeScript implementation and tests. Do not remove while Go core is being introduced. |
| core | `cmd/lmti`, `internal/*`, `pkg/contract`, `go.mod` | keep | New Go Core skeleton for typed runtime, policy, storage, output, and contracts. Needs Go toolchain verification. |
| core | `schemas/` | keep | JSON Boundary schemas for CLI, memory, adapter, and config validation. JSON is boundary only, not memory storage. |
| docs | `README.md`, `docs/`, `SECURITY.md`, `CONTRIBUTING.md`, `ROADMAP.md`, `CHANGELOG.md` | keep | Product, security, architecture, and open-source readiness docs. |
| config | `package.json`, `pnpm-workspace.yaml`, `tsconfig*.json`, package `tsconfig.json` files | keep | Active Node/TypeScript workspace config. |
| legacy | `.atlas/`, docs with `ATLAS-*`, `rfcs/RFC-0001...RFC-0010` | keep temporarily | Legacy/internal ATLAS material. The standalone `philosophy/` notes were removed after owner confirmation. |
| legacy | `packages/*` using `@atlas/*` namespace | keep temporarily | Internal local-alpha namespace. Documented as implementation detail of LMTI. |
| experimental | `experiments/`, `apps/playground/`, `apps/codex-assistant/`, `papers/`, `research/` | isolate | Useful research/playground material; should not be considered core runtime. |
| generated | `node_modules/`, `.pnpm-store/`, `dist/`, `build/`, `*.tsbuildinfo`, coverage output | ignore | Generated/dependency/build output. Keep ignored and out of publish branches. |
| generated | `.lmti/project.amf.json`, `.lmti/index.json` | local runtime | Generated local runtime data; ignored by Git and must not be published. |
| unsafe | `.lmti/config.json`, `.lmti/memory/`, `.lmti/runtime/`, `.lmti/privacy/`, `.lmti/logs/` | protect | May contain local/private memory, config, audit, or logs. Do not print contents or publish. |
| unsafe | `.env`, `.env.*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.token`, `secrets/`, `credentials/` | block | Protected by `.gitignore` and publish preflight. |
| unused-candidate | `core-contract/`, `core-runtime/` | review | Empty skeletons from an abandoned Protobuf/Core Runtime direction. Confirm before removal. |
| unused-candidate | `atlas-publish-repo/` | review | Local publish experiment/worktree candidate. Do not delete until owner confirms it has no unpushed work. |

## JSON Inventory

JSON is allowed for CLI output, import/export, schema validation, adapter
boundary, TypeScript package metadata, and test fixtures.

| JSON Use | Paths | Action |
| --- | --- | --- |
| package/config | `package.json`, package `package.json`, `tsconfig*.json` | keep |
| JSON Boundary schema | `schemas/*.schema.json` | keep |
| LMTI identity metadata | `.lmti/layer.json` | keep tracked metadata only |
| generated/local runtime | `.lmti/project.amf.json`, `.lmti/index.json`, `.lmti/config.json` | do not publish; migrate/replace config with TOML over time |
| legacy memory | legacy JSON memory paths in `packages/memory` compatibility code | keep until `lmti migrate from-json` is fully canonical |
| test fixtures | JSON strings in tests | keep; ensure they do not contain real secrets |

Cleanup rule: do not delete legacy JSON memory before a verified SQLite import,
backup, and migration report exist.

## Command Reality Matrix

| Command or family | Implemented | Tested in this pass | Docs status |
|---|---|---|---|
| `lmti init` | TypeScript yes; Go core yes | TypeScript build/test passed; Go not run | Current TS command; Go core experimental. |
| `lmti check` | TypeScript yes; Go core yes | TypeScript build/test passed; Go not run | Friendly alias for `lmti doctor`. |
| `lmti compile` | TypeScript yes | TypeScript build/test passed | Current TS command. |
| `lmti inspect` | TypeScript yes | TypeScript build/test passed | Current TS command. |
| `lmti context "<task>"` | TypeScript yes | TypeScript build/test passed | Current TS command; context is guidance, not truth. |
| `lmti preflight "<task>"` | TypeScript yes | TypeScript build/test passed | Current MVP policy-safe context path. |
| `lmti publish check` | TypeScript yes; Go core yes | TypeScript build/test passed; Go not run | Friendly safety gate before publish/PR/release/remote changes. |
| `lmti publish preflight` | TypeScript yes; Go core yes | TypeScript build/test passed; Go not run | Advanced alias for publish check. |
| `lmti doctor` | TypeScript yes; Go core yes | TypeScript build/test passed; Go not run | Current TS command; Go core experimental. |
| `lmti memory ...` | TypeScript yes; Go core add/search/retrieve/stats | TypeScript build/test passed; Go not run | Full lifecycle remains TypeScript; Go core is partial foundation. |
| `lmti migrate from-json` | Go core yes | Go not run | Implemented but migration must be reviewed before deleting legacy JSON. |
| `lmti route "<task>"` | TypeScript yes; Go core yes | TypeScript build/test passed; Go not run | Friendly alias for `lmti skill route`. |
| `lmti skill list/route/show/validate` | TypeScript yes; Go core yes | TypeScript build/test passed; Go not run | Primary user-friendly skill routing surface. |
| `lmti thoth list/route/show/validate/doctor` | TypeScript yes; Go core yes | TypeScript build/test passed; Go not run | Advanced Thoth surface. |
| `lmti thoth explain/inspect` | TypeScript yes; Go core yes | TypeScript build/test passed; Go not run | Diagnostic/local-alpha only. |
| `lmti policy check/list` | TypeScript yes | TypeScript build/test passed | Read-only policy decision reporting. |
| `lmti config show/inspect/validate` | TypeScript yes | TypeScript build/test passed | Shape-only config inspection; no raw values printed. |
| `lmti agent inspect/context` | TypeScript yes | TypeScript build/test passed | Safe agent boundary/context commands. |
| `lmti cleanup check` | TypeScript yes | TypeScript build/test passed | Read-only cleanup readiness check. |
| `lmti adapter inspect` | Go core yes | Go not run | Diagnostic contract inspection. |
| `lmti adapter list/test` | No | Not applicable | Planned only. |
| Protobuf, gRPC, multi-language SDKs | No | Not applicable | Deferred; not current scope. |
| Distributed platform, hosted sync, enterprise cloud | No | Not applicable | Roadmap only; not current product capability. |

## Illusion Cleanup Findings

- LMTI docs now consistently describe the product as a local AI memory, safety,
  and skill-routing layer, not a complete AI framework or autonomous brain.
- Thoth docs now state that Thoth routes to `skill.md`; it does not solve
  tasks, execute actions, replace agents, retrieve raw memory, or bypass policy.
- Repository-facing content was standardized to English in current docs,
  examples, tests, and runtime-visible strings found by this pass.
- `skill.md` docs describe skills as operation instructions, not executable
  modules, memory records, or policy decisions.
- Policy wording remains a safety decision layer; publish, deploy, private
  memory, sensitive-file access, and migration paths require gates.
- Older ATLAS docs still contain artificial-mind and reusable-understanding
  language by design, but they are marked as research archive material. Treat
  them as historical context until reviewed for public docs reuse.
- `docs/reality-checklist.md` was added because automated tests do not cover
  every documentation reality claim.

## Duplicate Or Overlapping Code Areas

| Capability | Current Locations | Cleanup Direction | Risk |
| --- | --- | --- | --- |
| JSON output formatting | TS CLI and Go output helpers | Keep TS behavior stable; route important `--json` outputs through `lmti.cli.v1`. | Breaking tests or agent integrations if changed all at once. |
| Thoth JSON envelope | Go Thoth and output helpers | Keep envelope shape aligned; preserve `lmti.thoth.v1` until migration is explicit. | Medium if changed without schema migration. |
| Git publish checks | `packages/cli/src/index.ts` | Later split into `internal/gitcheck` or Go `internal/publish`. | Low if extracted with tests; high if changed before parity tests. |
| privacy/secret scanning | `packages/privacy`, `packages/memory`, `packages/cli` | Keep centralized privacy package for TS; mirror minimal Go policy only after tests. | High if duplicate rules diverge. |
| legacy JSON migration | Memory store, TS migration, Go migration | Keep Go path; add TypeScript parity before deprecating old command. | Medium; must preserve old memory. |
| config loading | `.lmti/config.json`, root docs, Go `internal/config` | Introduce `.lmti/config.toml` without breaking current JSON config consumers. | Medium; current commands still read JSON. |

## Deprecated Or Review Candidates

| Candidate | Proposed Label | Required Review Before Removal |
| --- | --- | --- |
| `.atlas/` | legacy | Confirm migration to `.lmti` and no unique AMF/state remains. |
| `docs/ATLAS-*`, old RFC naming | legacy docs | Preserve history or move to `docs/legacy/` after naming review. |
| `core-contract/`, `core-runtime/` empty dirs | unused | Remove only after confirming no hidden/untracked files are needed. |
| `atlas-publish-repo/` | experimental/local publish | Confirm it is not a worktree with unpushed changes. |
| `experiments/` | experimental | Keep isolated; do not load as core runtime. |
| `apps/playground/`, `apps/codex-assistant/` | experimental app surfaces | Keep while useful, but exclude from core-runtime claims. |

## Security Scan Summary

The cleanup scan checked tracked/visible paths for secret-like filename classes
without printing file contents.

| Check | Result | Notes |
| --- | --- | --- |
| `.env`, key, cert, token filenames | no tracked matches from `rg --files` scan | Keep `.gitignore` and publish preflight blocking active. |
| SQLite/database filenames | no tracked matches from `rg --files` scan | Local `.lmti` sqlite paths remain ignored/protected. |
| `.lmti` runtime files | present locally | Treat as unsafe/local. Do not publish raw runtime data. |
| publish preflight | currently blocked | Origin still points to legacy/private `/atlas`; `LICENSE` is missing; working tree is dirty. |

## Safe Cleanup Plan

1. Keep current TypeScript implementation and tests intact.
2. Treat Go Core files as additive foundation only until Go toolchain and parity
   tests are available.
3. Do not remove legacy JSON memory paths until `lmti migrate from-json` has
   verified backup, import, privacy blocking, and report generation.
4. Do not remove `.atlas/` or `atlas-publish-repo/` without owner confirmation.
5. Normalize important JSON CLI outputs gradually through `lmti.cli.v1`.
6. Add TypeScript parity for `lmti migrate from-json` before deprecating
   `memory migrate-json`.
7. Add TOML config loading in parallel with current JSON config; switch only
   after doctor tests cover both paths.

## Risks If Removed Incorrectly

- Removing `.atlas/` too early can lose legacy AMF context needed for migration.
- Removing JSON compatibility paths can strand old memory before SQLite import.
- Changing all CLI JSON output at once can break tests and agent automation.
- Publishing while `origin` points to `/atlas` can recreate the wrong-repo PR
  problem.
- Publishing without `LICENSE` leaves open-source readiness incomplete.
- Letting agents read SQLite directly bypasses privacy gates.

## Verification In This Reality Pass

Checks run for this cleanup/report pass:

- Documentation scan covered `README.md`, `ROADMAP.md`, `SECURITY.md`, `docs/`,
  and `skills/`. `prompts/` does not exist in this workspace.
- English standardization scan found no non-ASCII text in scoped
  repository-facing paths after cleanup.
- Risk-wording scan found remaining artificial-mind language only in
  legacy/research ATLAS docs or explicit "not current scope" statements.
- Command-mention scan was used to classify implemented, diagnostic, planned,
  and deferred commands.
- JSON schema parse smoke check passed for schema files present in this phase.
- SQLite bridge smoke check passed through Node `node:sqlite`, then the smoke
  database was removed.
- Secret-pattern scan over newly added/changed core docs, skills, schemas, and
  Go files found no high-confidence real secret.
- Trailing-whitespace scan found no new issues.
- `git diff --check` passed with CRLF warnings only.
- `npm.cmd run build` passed.
- `npm.cmd test` passed: 17 test files and 185 tests.
- Go toolchain is not available in PATH, so Go build/test/gofmt remains
  unverified locally.

## Strict Cleanup Pass - 2026-07-02

- Repository structure, README, ROADMAP, SECURITY, docs, skills, Go command
  routing, and JSON output paths were inspected before code edits.
- Baseline verification before the final cleanup edits passed:
  `npm.cmd run build`, `npm.cmd test`, schema parse, English scan, and
  high-confidence secret-pattern scan.
- Small cleanup edits only: removed duplicated README product definition,
  aligned README architecture wording and CLI package metadata, and aligned Go
  help, doctor, and publish identity checks with the current product phrase.
- No files were moved or deleted.
- No heavy dependencies, new architecture, Protobuf, gRPC, SDK, remote, publish,
  or Git history changes were introduced.

## Not Done In This Pass

- No files or directories were deleted.
- No Git history or remotes were changed.
- No legacy JSON memory was migrated or removed.
- No direct storage access was added for agents.
- No heavy dependencies were added.
