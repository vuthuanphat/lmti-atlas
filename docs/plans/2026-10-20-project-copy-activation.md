# Native activation implementation record

2026-10-20. This records native source and controlled-fixture checks only. It does
not establish activation UI, a refreshed package, provider access or release acceptance.

## Applied state

| Item | Evidence/status |
| --- | --- |
| Held-project helper | Applied; `project_store.cpp`, `project_copy_p.hpp`, isolated `project_reservation_tests.cpp` |
| Helper focused runtime | **PASS, 5.59 s**, reported by root on the actual configured Qt runtime |
| Activation header/owner | Applied checkpoint `86504124010d4f86a1f3167e9dd15e8a` |
| Activation tests | Applied checkpoint `bdadff9a70e240aba718ea8627653b8a` |
| Combined CMake | Applied checkpoint `33dc747a44ff4096b5a9031582badd6b` |
| Full Release build | **PASS, exit 0**, after helper, v3 core and test application; root reported result |
| `project_library_activation` | **PASS, 23.54 s** (23.56 s CTest total), zero skipped; reported by root |
| Full native/Qt regression | **PASS, 18/18**, zero failures/skips, 110.71 s |

Checkpoints are local apply records, not Git commits. Core manifest
`work/structure-library-activation-core/manifest.json` SHA-256 is
`602f2044909f73aff653caca89257b2502d9e75225c617ab50b3eb8ecc9f5337`;
its header is `b52c1d032b48aebe78e2adeb798e73797f1bc6fa3a819978d198fec5cd25c7d9`
and owner is `a685e26c1adaa15eaf4f8fc33c5021f40ae60c853f0f65740e3341e44e3da632`.
Independent source review found no remaining actionable blocker within this scope.

## Implemented native contract

Explicit LMLB v2→v3 migration requires a fresh full format preview. Its digest
covers all seven entry values, including independent SQL NULL/empty root fields,
cosmetics and the original identity/upgrade receipt. It is separate from the
authority token, which intentionally excludes cosmetics. Under the library lock,
the owner writes a fresh typed `library-v2.sqlite` backup, closes/reopens and
verifies it before source DDL. V3 preserves the library UUID, generation, existing
entries and original v1 upgrade receipt; it adds its own format operation/digest
and bounded activation receipt table. V1 creation and explicit v1→v2 stay separate.

Each receipt stores the exact prepared library schema, canonical path, UUID,
generation and binding digest, source/root selection, copy policy and full native
source/target tokens. Nullable root distinctions participate in its computed
digest. History is capped at 1,000, with no eviction. Preparation and abandonment
change only their receipt. Activation atomically changes selected path, increments
binding generation once, and records the activated receipt/revision in the same
library transaction; current cosmetics and root fields are retained.

The source is resolved from the selected library entry. Target is fixed under the
trusted copy parent/operation UUID. Copy JSON is supporting evidence; full native
source/target and the exact copy transformation are checked again on held project
connections. Library and project aliases are refused. Projects receive no domain
DML, DDL or commit. Existing-only URI opens avoid recreating a disappeared store.

`HeldProjectCopies` acquires both existing stores in canonical order and keeps
complete typed snapshots on the same `BEGIN IMMEDIATE` connections until after
the library COMMIT. Its focused runtime passed writer exclusion, cleanup and
committed-WAL preservation checks, including the fixture with no outside keeper.
The read-only keeper prevents incidental writer-last-close checkpoint in those
tested cases. The separate focused activation suite also passed its native
lifecycle/format/fault tests. These are observed controlled-fixture results, not
an OS-wide guarantee; the full 18-suite regression also passed in 110.71 s, zero skips.

## Recovery and validation

Prepared/activated/abandoned history and operation revisions are durable library
data. Exact tokens are required for write transitions. Results are allocated
before COMMIT. On uncertainty, `RecoveryRequired` retains operation identity;
the returned receipt may be only intended and uncommitted. Read-only inspection
by library UUID and operation UUID establishes durable state; there is no replay.
Activated history can be current, superseded by a later binding generation, or
inconsistent. It does not reopen the old source or freeze later valid target edits.

Prepared readiness is advisory: independent project reads are followed by a fresh
library-token and exact-receipt recheck. A concurrent change reports stale/conflict
without retry. Acceptance always takes fresh reservations. Automatic and CAS
branches explicitly handle v3, so they cannot fall through to legacy v1 SQL.

Strict schema checks use a literal `sqlite_` prefix and case-insensitive reserved
table detection; `sqliteXextra` and uppercase downgraded structure/control tables
are refused. Required typed cells explicitly reject SQL NULL; intended nullable
fields remain preserved. Unknown schema/data and unsafe local/sidecar paths fail
closed with bounded generic errors. Test-only fault points exercise before and
after real format, preparation, acceptance and abandonment commits; those hooks
are absent from shipped storage.

The atomic commit boundary is the library. Project reservations constrain
cooperating writers; this is not distributed atomicity, a hard OS I/O deadline,
or an adversarial same-user filesystem-replacement guarantee. CLI/Qt/browser
review flows, private caller fingerprints and a new verified package remain work.
