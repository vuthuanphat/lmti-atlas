# Native impact review execution record

Date: 2026-10-13. Scope authorized by the user: prove LMTI's usefulness first for
software/hardware/IoT projects by connecting saved project/topology metadata to impact
review inside Studio. Package target: `build/studio-impact-20261013`.

## Constitutional answers

| Question | Concrete contribution |
| --- | --- |
| Improve understanding? | Trace declared component/deployment/device relationships with source revision and explicit unknowns. |
| Reduce repeated reasoning? | Reuse the native owner's scoped snapshot and saved impact report across review sessions. |
| Increase reusable intelligence? | Retain human evidence and review history without turning claims into observed deployment facts. |
| Protect knowledge? | Enforce project/document/site/privacy scope, trusted executable selection and stale-source rejection; export bounded nonsecret metadata only. |
| Evolve independently? | Native LMPR, impact LMIP, TS memory and Python/MCP preserve independent owners and versioned boundaries. |

## Implemented scope

- Saved native snapshot exporter with one read transaction, stable ordering,
  inherited privacy, complete scoped output or failure, and no raw repositories,
  knowledge content, observations or configuration.
- Deterministic TypeScript projection with stable IDs and content fingerprints;
  source staging remains separate from acceptance. Repeating an unchanged source
  or recovering an interrupted launcher update preserves import identity.
- Desktop Impact page with source inspection, explicit import review, impact paths,
  exact report persistence, evidence-backed human outcomes and saved-report reopening.
- Launcher capability `-AllowImpactReview`; exact current document path/revision and
  trusted packaged native executable checks. Agent tools remain read-only.
- LMIP schema 2 append-only human review records, optimistic review revision, v1
  read compatibility and explicit backup/transactional migration.

Architecture and interpretation are specified in the
[ADR](../adr/2026-10-13-native-impact-review.md); operating steps are in the
[impact runbook](../impact-review.md).

## Verification and measurable completion criteria

The full TypeScript build and **302 tests across 29 Vitest files passed**, including
15 persisted-review/inventory regressions. Logs are
`build/impact-native-evidence-20261013/typescript-build.txt` and
`build/impact-native-evidence-20261013/typescript-tests.txt` (generated, ignored).
The native build/exporter and package installation completed. A real compiled
native → TypeScript desktop-boundary workflow passed in a disposable synthetic
project: seven entities/four assertions, save/verify/reopen, unchanged native store
during product operations, source edit → stale, missing source → unknown, copied
document denied and Agent mutation denied. Evidence: `native-workflow.txt` in the
same directory. Its manual SQL edit is test-only; the product adapter does not query
native storage. The full Python suite passed **26 tests with zero skips**
(`python-tests.txt`), including real native/MCP integration fixtures.

The final native build passed and **all five CTest suites passed, zero failures**
in 48.47 seconds: topology core/storage, project domain/storage, desktop and impact
desktop. Detailed QtTest results are **36 passed / 0 failed / 0 skipped** for the
existing desktop suite and **7 passed / 0 failed / 0 skipped** for Impact, including
the real compiled CLI workflow and bilingual rendering. Final evidence is
`build/impact-native-evidence-20261013/native-build-final.txt`, `ctest-final.txt`,
and `build/native-impact-20261013/desktop-tests.txt` / `impact-panel-tests.txt`.
The earlier `ctest.txt` is an intermediate log; the final result above supersedes it.
Native formatting checks, `git diff --check`, launcher parsing and
`-PrintLaunchInfo` also passed. These are local synthetic/offscreen checks; manual
operator acceptance, real human pilot outcomes and clean-Windows acceptance remain
separate.

The native CI workflow now configures Node 24/TypeScript, a staged native runtime,
the opt-in Qt/CLI integration fixture and a disposable Python impact fixture so
these integration paths are exercised instead of silently skipped. The equivalent
local workflow is verified above; remote CI has not run because this task did not
push, publish or open a PR.

The required technical checks cover:

1. Export all permitted records beyond the old 200-row context cap without mutation;
   deny wrong project, hidden parent/endpoint, malformed or oversized snapshots.
2. Stage/review one native source, repeat import idempotently, and recover an
   interrupted launcher replacement without creating a new content identity.
3. Reject another document with the same project ID/revision and reject an executable
   selected only by workspace JSON before spawning it.
4. Save the exact displayed report; reopen it with the same verification history.
   Wrong grants, forged reports, missing evidence, duplicate decisions and revision
   conflicts must fail without overwriting history.
5. Change native content or permissions: previously verified outcomes must not remain
   displayed as current. Preserve the historical event in storage.
6. Read v1 without migration; verify WAL-inclusive backup and rollback on failed
   migration; never overwrite an existing backup or accept an unknown schema.
7. Run the desktop workflow on disposable nonsecret data with cancellation, dirty
   project state and reopening covered; retain existing TS and native compatibility.

Real-pilot acceptance remains open: an independent owner reviews expected paths and
unknowns, another person resumes the saved review, and total preparation, mapping
maintenance and review effort is compared against the existing workflow. No 20%
saving or business correctness claim is made from synthetic engineering tests.

## Risks and next gates

Sources may change between stores; there is no distributed transaction. Desired
bindings do not establish deployed versions. Project-wide software scope is broader
than one site's assets. Large graphs fail configured bounds rather than silently
claiming completeness. Old reports can remain listed but fail current reopening;
a historical as-of viewer is deferred. Encryption, multi-user identity, telemetry,
real Agent/operator trials and clean-machine acceptance remain future gates.

Native snapshots and impact imports are capped at 4 MiB; each source import accepts
at most 2,000 entities, 5,000 assertions and 5,000 evidence records. Qt responses are
capped at 2 MiB including history, with a 30-second request timeout. Exceeding these limits fails closed and requires
a narrower supported source/project scope. Successful bounded traversal does not
prove complete real-system knowledge or unlimited scale.

Replacing/rebuilding the native executable invalidates existing launcher digest
pins. Current recovery preserves the old workspace and creates a fresh one using
the newly trusted package, with new import review; it does not migrate evidence.
There is no automatic or explicit repin command in this slice.

## Safe lesson candidates

Propose these only after privacy/evidence review; this task does not write `.lmti`:

- Bind desktop context to the canonical document path as well as project ID and
  revision; copied project identities are not sufficient authority.
- A digest from the same config as an executable path establishes consistency,
  not permission to run that executable.
- Keep canonical generated reports immutable and append human outcomes separately;
  reopening must revalidate the report and sources before showing verified state.
- Back up SQLite through its owner so committed WAL contents are retained; perform
  schema changes transactionally and keep existing readers compatible.
