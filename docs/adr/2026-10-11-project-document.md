# Local software/hardware project documents

Date: 2026-10-11. Status: implemented local-alpha decision under the owner's
approved software/hardware project plan; production acceptance remains gated.

## Decision

One typed C++ ProjectDocument composes ProjectInfo, topology, repositories,
components, targets, releases, bindings, dependencies, work, milestones,
verification and knowledge references. Project identity differs from a site,
repository locator and Project Atlas. The domain remains Qt-independent.

The project SQLite adapter owns application ID `0x4c4d5052` (LMPR), schema 1.
The legacy topology schema/application ID is unchanged. Explicit versioned
readers reject other domains and unsupported versions. Existing memory stores
and TypeScript/Go commands are retained.

Topology revision is the project document's sole saved revision. Save validates
the whole document, uses foreign keys/prepared values and one BEGIN IMMEDIATE
transaction, and compares project ID plus expected revision before replacement.
Approved release metadata is immutable. Referenced rows cannot be deleted
silently. Undo/Redo snapshots cover software, work and topology together.
The embedded topology editor borrows its owner's typed topology and commits
edits through the project validator; it has no project-store handle.

The legacy portable recent catalog, application ID `0x4c4d4341` (LMCA), schema 1,
retains its compatible limit of 30 recent locators. The 2026-10-12
[library decision](../plans/2026-10-12-project-library.md) adds a separate LMLB
`0x4c4d4c42`, schema 1, `project-library.sqlite` beside it in `data/`. It retains
up to 500 project IDs, labels, document/folder locators, pins and last-open times;
canonical folder keys are unique (case-insensitive on Windows). First use imports
old recent refs only when no library exists, leaving the source unchanged.
Removal deletes the index reference, never files. Neither index contains domain
authority or is sent to Agents. Save as selects a new authoritative locator for
the same identity and keeps pins/folder association, not a second project.
Portable installation needs a writable data directory; machine-wide installation
and profile directory policy need a separate packaging decision.

Topology v1 may be edited with explicit `--legacy`, including v1 configuration
proposals. The project UI imports it into an unsaved project instead, keeps
asset/link IDs, site, privacy, layout and configuration, and records a source-file
fingerprint plus source revision. Save requires a new file; source remains intact.
The fingerprint identifies the source file, not a consistent live-WAL backup;
retiring/migrating stores still requires the cleanup migration gates.

The separate native `lmti-project` CLI and Python `lmti_project` SDK/MCP expose
project/site/model-target grants fixed by the launcher. Context is capped at
1–200 records per category and 2 MiB, with explicit truncation. Durable project
categories cap at 2,000 rows each, assets/links retain topology bounds, and files
cap at 64 MiB. Impact queries traverse the authorized graph with a visited set
and depth budget. They describe declared dependency neighborhoods, not measured
runtime impact. No file locators or raw knowledge are exported.

The first proposal allowlist only changes a work state to review or blocked.
No Agent completion, binding write, database connection, shell/build/Git/device
execution is exposed. UI review requires a clean saved document and matching
project/revision/old state. Apply modifies the document; Save persists it.

## Evidence and limits

New project metadata defaults internal. Public export also requires public
parent references and an authorized device site. Desired releases always have
observedVersion unknown; operator-entered evidence is displayed with its source
and result, without inventing live firmware discovery. Done validation work
requires evidence. Milestone acceptance additionally requires all linked tasks
Done, at least one task, acceptance evidence and an explicit operator choice.

KnowledgeRef is reference-only. It does not dereference `.lmti`, read raw AMF
or bypass source policy; the read-only privacy-reviewed memory bridge remains
unimplemented. A bounded lookup/pagination API for objects beyond the context
window is also future work. Repository refs are metadata, not Git integrations.
The initial component has one repository reference; a project may have many
repositories/components. Schema migrations and post-cutover recovery for this
new project format need explicit future contracts before a schema upgrade.

SQLite is not encrypted. Internal classification is not secure secret storage
or same-user OS isolation. The supported data class is nonsecret metadata.
Multi-user identities, durable security audit, synchronization, remote execution,
gateway/telemetry and release deployment remain outside this local alpha.

Tests cover whole-document round-trip, stale writers/proposals, immutable
releases, invalid references/date/text, project/site/parent privacy, milestone
evidence, import source preservation, shared UI history and real MCP processes.
Manual operator/product-client/clean-machine acceptance and GUI frame-time/load
measurements are separate from automated and native storage/context evidence.
