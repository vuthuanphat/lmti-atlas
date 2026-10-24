# LMLB v2 native generation core — implementation record

Applied implementation record, 2026-10-20. This records a native library
increment, not completed copy activation or release acceptance.

## Applied state and evidence

| Item | Recorded result |
| --- | --- |
| Production header and owner | Applied; checkpoint `220b1e00d5d5419ea3ba6c890cef89d5` |
| Full Release build | Passed before new test target was applied; root reported success |
| Isolated test source and CMake target | Applied; checkpoint `207655cf7e68401b80fec6532909ab24` |
| `project_library_generation` runtime | Passed: focused 5.22 s; same test in full regression 5.08 s; Release isolated test target |
| Existing native/Qt regression suite | Passed: 16/16, zero failures or skips, 83.76 s |
| Default Qt-generated path probe | Passed: exact QDir/QFileInfo constructor expression, no Qt caller change required |
| Independent source review | Proposal owner reviewed completed production source and final fixes; no remaining actionable issue within this core scope. No tests were run by that reviewer. |

These checkpoints are local apply records, not Git commit IDs. Existing copy-owner
and previous package evidence remain separate; no current packaged LMLB v2 runtime
or real-user data upgrade has been claimed.

Applied production SHA-256 values:

- `native/include/lmti/project_library.hpp`:
  `7f5602d863c1d954e3c917adec8f4a0dfd2bebc4fb0eb8d0f103229f4e4c80d7`.
- `native/storage/project_library.cpp`:
  `6b2d979935eb29e241bfb1be9a39cd79574861446fa1ef063b06a8c31a29414b`.
- `CMakeLists.txt`:
  `8ff1f9070845901417aef4f8b38a8f7520a6ebc9b2081ac298648b4df275cf5f`.
- `native/tests/project_library_generation_tests.cpp`:
  `b9be2733f4622041595c5e137469b06f0650d5a65e26a501f45e133d397505ed`.

## Implemented contract

New libraries still start at v1. Upgrade is an explicit native operation with an
expected full v1 inspection token and trusted backup parent. Exact schema and
typed rows are rechecked under a write lock. A fresh retained v1 backup preserves
all seven fields, including independent SQL NULL/empty folder and folder-key
values, pin and opened timestamp. Backup verification precedes source DDL.

V2 renames `library` to `library_entries` without a compatibility view and adds a
single identity row: library UUID, binding generation, upgrade operation UUID,
and original backup snapshot digest. Preopened old SQL can no longer write the
renamed table. Every supported write rechecks format and identity under its lock;
inspection reads the token, receipt fields and entries in one transaction.

Explicit CAS APIs support absent-ID registration, root change and deletion.
Registration validates the selected native project's supported schema and project
ID. A real binding change increments the generation once; no-op and cosmetic
updates leave it unchanged. UUID, generation, path and binding digest protect
against stale previews, A→B→A and same-path library replacement. No existing-ID
database-path replacement or copy activation API is exposed.

V2 automatic remember only refreshes an existing identical binding. Omitted root
preserves the current root, and stale automatic link cannot restore an old root.
An absent row is never automatically re-created. Existing offline references can
be inspected or pinned without opening their project files. V1 writer semantics
remain, subject to strict path and malformed-format checks.

## Recovery and fixed review findings

Upgrade retains its operation directory after reservation. On uncertain results,
fresh inspection must match the durable library UUID, upgrade operation UUID and
backup digest. `LibraryUpgradeStatus.library` may be empty or merely an intended,
uncommitted v2 token; that field alone never proves success. CAS has no per-operation
receipt in this increment: inspection proves current state, not which caller's
identical operation committed. An uncertain COMMIT returns `RecoveryRequired`;
there is no automatic replay. Success objects are allocated before COMMIT.

Review fixes include case-insensitive reserved-table downgrade detection and a
literal `sqlite_` internal prefix check, so `LIBRARY_IDENTITY` and user-created
`sqliteXextra` cannot evade format checks. Exact v1 preflight refuses unknown
schema extensions. Import validates its catalog before file probes and reserves
a fresh destination exclusively. Native registration checks bounded, local regular
WAL/SHM/journal sidecars before and after its metadata read. Raw network/device/ADS
paths and reparse ancestors are rejected by the existing shared owner boundary.

The isolated test build exposes compile-time-only faults before and after actual
upgrade/CAS COMMIT and after backup verification. Shipped storage has no test hook.
The new suite targets retained typed backup/WAL fidelity, commit reconciliation,
stale Qt sequences, identity/generation conflicts, rollback and schema/path bounds;
the runtime results above establish these controlled-fixture behaviors.

## Remaining work and limits

Future activation needs its own explicit schema increment and durable operation
receipts, freshly verified source/target copy tokens held stable across library
cutover, and separately reviewed recovery. CLI/Qt/browser deliberate register,
root-link, forget and activation flows still need wiring to the native CAS APIs.
Generated MCP config changes remain a separate owner review and client restart.

No device operation, live provider, clean Windows, packaged activation, or release
completion is established here. Controlled fixtures are the intended test inputs.
SQLite busy waits and size bounds do not establish a hard OS I/O deadline or
protection against an adversarial same-user filesystem race.
