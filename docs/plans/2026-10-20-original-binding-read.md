# Increment 18 — conditional original-binding reads

Implemented and verified locally; full MVP acceptance remains open. This increment adds a private native read boundary; TypeScript integration and package acceptance are separate work.

## Implemented boundary

The caller supplies the original library/project/profile physical identities and immutable library/project identity. The native owner validates all typed fields and local path syntax before filesystem access, then retains Windows read-data/list plus attributes handles (`0x81`) without delete sharing on the original namespace. Main files and preexisting sidecars must be ordinary local files with one hard link. Exact decimal volume/file-index/creation-time values are checked without floating-point conversion.

One library snapshot supplies both its token and selected row. The owner compares that copied row with the expected original project path/root before project I/O. It opens only the captured original project path; later catalog reads verify drift and never choose another project. On one project connection, schema, project ID and store UUID are checked before graph rows. All SQLite readers close before retained handles are released; the returned data is fully owned.

The supported absent-profile case is one missing final leaf beneath a complete matching ancestor chain, explicitly allowed only for prewrite capture. It returns revision zero and an empty profile without calling the profile opener. A newly observed file, missing ancestor or missing original provenance is refused. Recovery of an unknown initial profile-store creation remains separate work.

The new fixed `--original-binding-read --library … --profiles …` mode accepts strict UTF-8 JSON up to 64 KiB and emits a complete binary LF-terminated response up to 128 KiB including LF. It exposes only the existing private binding/profile DTOs or a bounded error. Existing project-operation reads/writes and ordinary profile modes remain unchanged. There is no production environment-controlled test hook.

## Recorded evidence

| Check | Actual status |
| --- | --- |
| R1 attribute-only retained-handle probe | FAILED: file rename succeeded while held; ancestor rename was denied. Four cross-runtime physical identities and two ordinary reads passed. |
| R2 data/list-read retained-handle probe | PASS, 12 checks: four Node/Win32 identity matches, including three actual file IDs above JavaScript's safe-integer range; two ordinary reads; synthetic uint64 conversion; file and ancestor rename denied with error 32 while held, then both succeeded on the same targets after handle release. |
| Native Release build | Initial and fixture-r2 builds PASS; root retains the separate build receipts and source/runtime pins. |
| Initial focused native run | 5/6 CTest targets passed. The new suite failed all 13 cases during common fixture setup, with zero behavioral checks reached. |
| Native focused r2 / new-suite counts | PASS, 6/6 CTest targets in 23.82 s. New suite: 13 named cases, 290 behavioral checks, zero failures, one conditional file-symlink skip; its CTest time was 9.95 s. |
| Full native regression | PASS: 29/29 suites in 323.05s. The new suite again passed 13 cases and 290 checks, with one conditional file-symlink skip. |
| Native QSQLITE compatibility, committed WAL visibility and lease cleanup | Passed the focused fixture cases, including actual committed WAL, unchanged main/WAL bytes, no checkpoint/repair, and release on success/refusal. The local file-symlink case was skipped because creation was unavailable/denied. |
| TS use of the conditional boundary | Not integrated in this increment. |

R1 report: `work/conditional-binding-probe-7d8adcb8ab47438c8997acf91df1d27b/report.json`, SHA256 `26ef697d215dd7964893d9e1b385196cb7f6babe9ad6896661270a8a7a122a14`.

R2 report: `work/conditional-binding-probe-r2-156db94374494954b02747cf05948190/report.json`, SHA256 `252e6589e10f02bff3a62c3f2d554b1bfef3a2e3f67d7f25ce31ceb896caeaa8`. Both runs used fresh controlled workspace fixtures, with no user-data inspection, installation or network access.

The first focused failure was a fixture defect: it enrolled an offline sibling before its file existed, while the library owner requires an existing path. The r2 test-only correction creates the typed project, enrolls it, then removes that fixed fixture file to model an offline sibling. It does not weaken assertions or alter production. Its test SHA256 is `a7a255d133476b4c9b671edc5230fd13c52cd231c5d146ea60860df43e122eff`.

Focused details are retained at `work/original-binding-focused-fixture-r2-details.log`; the build and focused receipts use the same `original-binding-…-fixture-r2` stems. Root applied the fixture correction at checkpoint `cde1c5e565e24d14bb5cd6e49ae22578`. The full 29-target regression passed; all internal skip lines are retained in the evidence JSON.

A peer-review false positive was also corrected: the fixture's `poll=1` is SQL-valid in the LMPR project table. The CHECK constraint cited initially belongs to a different topology table. The poll fixture remains unchanged; this was a review correction, not a production defect or observed test failure.

## Limits and next integration

The implemented guarantee concerns local Windows namespace replacement during cooperative owner reads. Deny-delete handles do not make in-place data immutable or create an atomic snapshot across the library, project and profile stores. Hostile in-place modification, privileged actors and hostile new sidecars remain outside this guarantee. Existing WAL/SHM may coordinate through SHM; no SHM byte-immutability claim is made.

Preexisting WAL and SHM must coexist and satisfy the local-file bounds; a nonempty rollback journal is refused. Focused native tests verified the controlled committed-WAL and lease-lifetime cases. This does not extend their result to hostile filesystem races or all SQLite deployment configurations.

The original Node identities and fixed native paths remain private, not browser authority. Existing grants, restart coverage, retained unknown outcomes and explicit complete-union acknowledgment remain required. Native18 alone does not protect TS recovery calls until the separate adapter replaces the mutable-locator read sequence. Python client-root recovery, unresolved subjects spanning schema/UUID migration, unknown initial profile creation, updated package/browser validation and the remaining MVP acceptance gates stay open.
