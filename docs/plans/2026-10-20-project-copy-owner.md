# Native project copy owner — applied implementation record

Date: 2026-10-20. Applied source build under STRUCT-01. Release build passed;
the full native/Qt run passed all 15 suites in 74.74 seconds, with
zero failures or skips. This does not establish library activation or a new
packaged hierarchy release.

## Implemented scope

The private native owner supports reviewed schema-1 migration and schema-2 clone
through inspect, prepare and operation-inspection APIs. It reads the complete
typed document and identity registry in one SQLite read transaction, including
committed WAL content. It performs no source DDL/DML and never checkpoints or
reconstructs the source as part of copying.

Preview binds schema, canonical source path, project ID, saved revision, owned
content digest, registry digest and the schema-2 store UUID. Preparation captures
the source again and requires the same preview before reserving output. Equal
project ID/revision/content is insufficient when the source store UUID changed.

Preparation reserves a fresh UUID child directory under a trusted local parent,
then exclusively creates the fixed `project.sqlite` target. The target keeps the
project ID, receives a fresh store UUID and advances the captured revision once
within the existing domain limit. Metadata reads, ordinary saves and copy
preparation now agree on that strict ceiling: producing the last valid revision
is allowed, while a source already at that revision is rejected before a new
copy directory is reserved or ordinary-save rows are replaced. Invalid saved
revisions are rejected on metadata read. It never overwrites the source or
another target. Source paths and destination parents are checked as local owner
paths; linked paths, device/network namespaces and unsupported source schemas
fail closed. Existing size, record-count and copy-work budgets remain enforced.

Schema-1 migration preserves owned metadata, desired state, evidence and existing
identities. It declares Sites from existing asset site tokens with Internal
privacy and records that policy in the preview/receipt. It does not infer
subsystems, areas, environments, component membership, asset placement or roles.
An empty source does not acquire a fabricated Site. Schema-2 clone preserves the
declared hierarchy and the full active/retired registry for all six native kinds:
component, asset, subsystem, site, area and environment. Cloned tombstones continue
to prevent reuse of retired IDs; a replacement needs a new ID.

## Completion and recovery behavior

Private `intent.json` and `verified.json` receipts describe the operation and
binding digests; they do not contain raw project/reference content. The owner
reopens and validates the committed target independently before reporting a
verified preparation. A failure after reservation retains the operation identity
and artifacts with recovery-required status, including a failure after COMMIT.
It does not retry the write or delete a possibly committed target.

Operation inspection uses only fixed filenames beneath the trusted operation
directory. It does not follow source paths supplied by receipt JSON or reread a
withdrawn source. It validates the current target against the intent and any
final receipt. A committed target with a missing final receipt can be recognized
as Prepared with `verified_receipt=false`; inspection remains read-only and does
not manufacture the missing receipt. Malformed, altered, partial or missing
artifacts remain recovery-required.

These are unsigned local preparation receipts, not authoritative activation
records. They do not grant permission to update a library entry or prove that a
project has been activated. Library activation/reconciliation, operator UI,
user-facing Save As integration and reviewed selection of the active store remain
separate work. No Agent write tool, device execution or provider connection is
introduced. Ordinary structured-save lineage guards remain in force.

## Applied validation

- Release build after the revision correction succeeded.
- Focused project_copy_owner passed in 5.68 seconds.
- Full native/Qt CTest passed 15/15 in 74.74 seconds, zero skips.
- This includes ordinary storage, hierarchy storage/projection, proposal, MCP
  config and desktop regression after the shared writer/path-helper changes.
- The first focused run failed at an invalid revision fixture; diagnostics
  confirmed the error mismatch. The correction retained the domain limit,
  fixed the copy/save next-revision checks and aligned metadata rejection.
  Positive and negative boundary cases passed in the final full run.

The executed suite covers committed WAL revision/content capture; source
database/WAL preservation in the held-WAL fixture; migration field equality; all
six cloned tombstone kinds and rejected reinsertion; same-path replacement
isolating a different store UUID; unsupported-schema/budget refusal; and
interrupted or tampered operation reconciliation. Boundary tests cover
migration, clone and ordinary save reaching the last valid revision, followed by
exhausted/invalid revision refusal with unchanged source bytes and caller
revision and no reserved copy output. Deterministic test-only faults exercise
the actual preparation failure path after COMMIT, both before independent
verification and before final receipt writing, followed by read-only inspection
without retry, deletion or receipt creation. Fault controls compile only into
the isolated test executable, never the shipped storage library. The full-run
result above applies to this coverage. No live source or user project was used
by these disposable fixtures.