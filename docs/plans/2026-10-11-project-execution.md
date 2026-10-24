# Software/hardware Projects — execution evidence

Date: 2026-10-11. Implemented local alpha under the
[approved direction](2026-10-11-software-hardware-projects.md).
No push, PR, release, device execution, source-store retirement or user memory
migration was performed. Earlier dirty working-tree changes are retained.

## Delivered scope

| Stage | Evidence / status |
| --- | --- |
| S0 | Typed model, validation/storage/context/proposal contracts and [project ADR](../adr/2026-10-11-project-document.md) recorded; working Qt pages supersede initial wireframes for the delivered slice |
| S1 | Projects landing, explicit synthetic demo, name/goal/privacy, recent catalog, whole-document SQLite save/open/revision and shared Undo/Redo; topology import saves only to a new project file |
| S2 | Software/repo refs, targets/releases, device bindings, dependency contracts, Hardware inventory with software/work details and a separate typed software/hardware graph |
| S3 | Work board/filter, linked objects, checklist/evidence, milestone dates/criteria/operator acceptance and transparent Done/total progress |
| S4 | Native project CLI, scoped Python SDK/MCP, bounded context/declared impact and review/blocked work proposals; KnowledgeRef is reference-only, privacy-reviewed source memory bridge NOT implemented |
| S5 | Automated native/UI/Python/TS/Go checks and native storage/context benchmark; manual operator, actual product MCP-client setup, clean Windows packaging and GUI frame-time/RAM measurements remain gates |

This is the initial project-management MVP, not completion of every item in the
broader S0–S5 plan. Task priority/assignee/archive workflow, component references
to multiple repositories, cross-project assets, source-aware memory retrieval,
pagination/lookup beyond context windows and schema upgrade/recovery remain
future refinements. Current milestone acceptance is a local operator record,
not multi-user approval or production certification.

## Architecture and safety

- `native/core/project.cpp` owns Qt-independent typed models and validation;
  separate `lmti_project_core`/`lmti_project_storage` targets preserve ownership.
- LMPR schema 1 differs from topology v1 and all memory schemas. SQLite has
  typed columns, foreign keys, prepared values and atomic revision checks.
- ProjectWindow owns the document. The embedded existing Window borrows its
  topology and commits via the project validator; shared history snapshots all
  domains. Standalone topology UI remains available with `--legacy`.
- Imports preserve topology metadata/IDs/site/privacy/layout and retain source
  file fingerprint/revision; the source file is unchanged. Save as cannot replace
  an existing file or silently create another project ID in the catalog.
- New metadata defaults internal; external context requires public project,
  public parent references and the granted device site. Locators/raw knowledge
  are not exported. Unsupported/corrupt schemas and invalid metadata fail closed.
- Agent proposals are non-writing data with expected project/revision/old state;
  only review/blocked work states are allowed. UI review requires a clean saved
  snapshot, then separate Apply and Save. Approved release metadata is immutable.
- Validation Done needs evidence. Accepted milestones need evidence, all linked
  tasks Done and at least one linked task; reopening tasks requires reopening
  acceptance. No auto-acceptance from counts/dates is performed.
- Project/catalog SQLite is unencrypted and supports nonsecret metadata only.
  No arbitrary shell/Git/build command, raw store handle, firmware deployment or
  device action was added. Existing memory/privacy/lesson stores remain intact.

## Local checks

| Check | Result |
| --- | --- |
| MSVC/Qt Release build | Passed, new core/storage/CLI/desktop/test targets |
| CTest | 4/4 executable suites: topology core, topology storage, project domain/storage, desktop QtTest including project lifecycle/import/shared history |
| Python unittest | 12/12, no skip; includes both native runtimes and real topology/project MCP stdio processes |
| TS build / Vitest | Passed; 188/188, 0 pending, no source changes to TS command contracts |
| Go | 26 test passes, 0 test skips; compatibility path retained |
| C++ formatting | Installed clang-format 19.1.5 with repository `.clang-format`; no formatter dependency installed |

The initial shell lacked a pnpm shim on PATH; TS verification used the already
cached pnpm 10.13.1 JavaScript entry point, without downloading dependencies.
Qt deployment warnings about optional DX compiler/VCINSTALLDIR are logged;
the Widgets/SQL package is built and rendered locally, not clean-machine proven.
No hosted CI result is claimed; the existing native CI now includes the project
binary for Python integration tests.

Native benchmark fixture: **100 components, 200 assets, 500 bindings, 500 work
items**, 30 context samples with limit 200. On this dev machine the recorded
sample gave save **147.7 ms**, open **100.2 ms**, context p95 **135.0 ms**, payload
**131,879 bytes**, database **348,160 bytes**. These are local synthetic storage/
context measurements, not GUI frame time, network performance or OT readiness.
Output is in ignored `build/project-benchmark.json`; timing can vary by run.
This run overlapped synthetic UI rendering and SDK process checks.

Build, package, render and smoke data use ignored build fixtures. UI screenshots
in docs contain only the explicit synthetic demo. No raw chat/customer data,
secrets or memory content are stored as lessons.
The packaged desktop rendered Overview, Software, Hardware, Relationships and
Work with the Windows Qt platform; images were visually inspected for readable
labels and visible software/device/work relationships. This is local rendering
evidence, not completion of the broader manual acceptance gates below.
The final packaged `--demo` launch reported InputReady, Responding and a nonzero
window handle with title `LMTI · Factory Monitor *`; it was left open for review.
The existing toolbar-era window was not closed or overwritten.

## Remaining gates

1. Privacy-reviewed memory bridge with source fingerprint/evidence verification;
   current references must not be called compiled understanding retrieval.
2. Bounded direct lookup/pagination, richer work management and release/target
   compatibility evidence workflows; current desired versions remain unknown
   as observations even when operators attach evidence.
3. Real operator acceptance and a configured product Agent/MCP client, including
   unsaved-vs-saved context and stale proposal rejection.
4. Clean-machine runtime/license verification, hosted CI, source-publication
   preflight, and GUI frame-time/RAM/load benchmarks before distributing/piloting.
5. Explicit schema migration/consistent backup/recovery before upgrading LMPR
   or retiring stores; connectivity/telemetry/encryption/RBAC/dispatch stay gated.

Lesson candidates for privacy/evidence review, not automatically saved: project
identity is not a site or repo path; desired bindings cannot prove deployed
software; operator acceptance needs evidence beyond task counts; legacy import
must preserve its source and use an explicit format boundary.
