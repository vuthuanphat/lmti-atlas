# STRUCT-01 increment 17 — library upgrade recovery

Implemented and verified locally. Full MVP acceptance remains open.

## Behavior and authority

The fixed native read mode receives the original typed `LibraryFormatPreview`,
the launcher-selected library and backup parent. Exact schema, path key, UUID,
generation, bindings digest and full typed snapshot remain pinned. Schema1
retains explicit null UUID/generation; its original physical identity is checked
by the API recovery subject. Native snapshot equality preserves NULL versus
empty values, cosmetic rows and committed WAL content.

The scanner examines the complete immediate parent, including invalid names.
At most 1000 entries are processed plus a 1001st overflow sentinel. UUID children
are shallow inspected for one fixed standalone backup leaf. Backup reads use
immutable SQLite and reject sidecars; source reads allow existing WAL/SHM
coordination but refuse missing required SHM or a nonempty journal. Raw path,
reparse and single-link checks precede ordinary file reads.

Two parent scans and two source observations must agree. Matching original
state with an empty pinned parent, or independently verified matching pre-COMMIT
artifacts, may support fresh review without naming a lost attempt. Committed
state additionally requires the current durable receipt's exact artifact and
the complete original pin, not merely UUID/full-digest agreement. Equivalent
orphan files cannot replace missing receipt-named evidence.

The private TypeScript adapter validates exact framing, bounded DTO rows,
identity/null semantics and complete/incomplete correlations. It uses the
dedicated verifier pool; the ordinary process environment is unchanged.
`ProjectOperationRecovery` verifies original physical library/parent before and
after the queued native read, hashes the validated fixed-shape result and feeds
the existing complete-target collector. Two fresh equal collections and a
separate explicit acknowledgment are still required. No write is retried,
historical `unknown` relabeled or native path/UUID promoted to a public authority.

## Verification

- Native Release builds retained before and after the pin repair; final focused
  6/6 passed in 132.38s; full
  28/28 passed in 320.14s.
- Native recovery: 14 cases, 6386 checks, zero failures,
  1 conditional file-symlink skip.
  Existing discovery contributes 2
  conditional symlink skips. Total 3
  internal skips; no skipped CTest suite. Exact reason lines are retained.
- Final API focused 47/47 in
  11.926s; full 231/231 in
  83.100s; zero skips/cancellations/todos.
- Five real-process integration tests use current shipped read admin, the
  existing fixed fixture producer and isolated native post-COMMIT fault writer.
  Direct collector/coordinator acknowledgment is not HTTP/UI or restart proof.
- Current 14 source/stage hashes, complete final API inputs/dist/support/runtime,
  native inputs/binaries, every retained attempt/log/receipt and application
  checkpoint before images are pinned in the evidence JSON.

## Corrections retained

Review found an early-source-unavailable artifact could be labeled Foreign
before classification; it now remains Unavailable with unresolved coverage.
Review also found committed receipt matching could omit original schema2
generation/bindings equality; it now requires `matches_expected`, with a real
post-COMMIT regression. The initial native build passed before this narrow pin
repair; no pre-repair native test pass is claimed.

The first API focus run passed 10/47: two new UUID regular expressions omitted
one four-hex group, rejecting valid native identities. Both were repaired to
8-4-4-4-12. The next run passed 46/47; the remaining test compared a frozen
null-prototype subject to a plain structured clone. Canonical before/after
comparison fixed that fixture without weakening the production codec.
All failed attempts and repair chains remain preserved. Static review did not
constitute runtime proof.

## Limits and next work

- Fresh complete native observations permit explicit acknowledgment and a separate new review; they never identify or rewrite a lost historical outcome.
- Malformed, partial, foreign, unavailable, missing receipt-named or incompletely enumerated backup evidence stays fenced; no cleanup, repair or forced adoption owner is implemented.
- The five new real native API cases exercise private adapter/recovery helper and direct same-process collector/coordinator, not an HTTP/browser or restart-marker acceptance flow.
- Copied closed native databases are controlled orphan fixtures for TS integration; actual pre-COMMIT reservation faults are separately proved by native owner tests.
- Source WAL is read through an existing readonly snapshot with pre-existing SHM coordination; SHM bytes are not immutable and no checkpoint/repair is performed.
- The 20-second cooperative deadline and 512-MiB admission work estimate do not measure every VFS byte or guarantee a hard process deadline.
- Observed physical/file/source/parent drift is refused; no atomic cross-store snapshot or hostile same-user race guarantee, and no deterministic concurrent midscan trigger is claimed.
- Marker v1 migration, missing original identity and atomic conditional selected-store reads remain open; this increment does not broaden their scope.
- Hierarchy launcher/service/routes/editor, physical hierarchy, reviewed mapping/import, Agent handoff, representative workload and operator/device gates remain open.
- No new package/ZIP, browser acceptance, external model/provider/device activity or clean-Windows acceptance; previous packages and ZIP remain historical deliverables.

This closes the specific increment16 valid-upgrade recovery prerequisite.
Unresolved artifacts still require a future explicit owner remediation design;
current observation is never permission to delete or rewrite them.
