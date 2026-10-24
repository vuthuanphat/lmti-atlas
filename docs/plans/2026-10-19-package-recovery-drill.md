# Synthetic package and state recovery drill

This harness supplies a reproducible technical check for the master plan's
PACK/WEB-03 recovery work. It is **not a production backup feature**. It uses
fresh, synthetic data, the same Windows user and machine, an unchanged schema,
and the same absolute fixture root before and after rollback. A passing result
does not close clean-Windows, migration, independent-operator or release gates.

## Existing ownership and reuse

| State or boundary | Existing owner | Reused evidence or behavior |
| --- | --- | --- |
| Project/library/profile | Native LMPR/LMLB/LMCP stores | Native fixture producer creates the initial stores; native project proposal and profile save perform updates. Library is restored and read, not edited through a new SQL writer. |
| Client settings and protected recovery | `scripts/mcp-config-owner.py` | Preview, expected-snapshot apply, current-user DPAPI, root/project/client binding, explicit Restore. |
| Compiled code/docs and reviewed memory | Existing compiler/memory owners | The literal `FIXTURE` in `python/tests/test_agent_integrated_process.py` creates the same controlled public summaries and reviewed internal lesson. Private/pending rows remain withheld. |
| Package integrity/runtime | `apps/web-api/src/doctor.ts` | Existing compiled doctor checks both selected packages before and after the drill; no second package verifier. |
| Path/file guards | `scripts/agent-scale-baseline.py` | Local lexical path checks, parent-first reparse rejection, bounded reads and exclusive writes. |
| Earlier interruption checks | `apps/web-api/test/integration.test.mjs` | Real client-owner interruption and API process-loss tests remain separate. This drill interrupts its own directory cutover, not an unknown owner commit. |

There is currently no native coordinated backup/restore command spanning these
stores. The impact owner has a separate WAL-aware v1-to-v2 migration and rollback
test; it is not used to migrate library, project, profile or memory schemas.

## Protocol

1. Require two existing, different package manifests under repository `build/`,
   a trusted Node executable and an explicit existing native fixture producer.
   Refuse an existing output directory. Record input/runtime/script/fixture hashes
   and package doctor receipts in `protocol.json` before fixture construction.
2. Create both native demo projects and their library/profile using the native
   test producer copied into an isolated runtime directory. Give its startup
   `QTemporaryDir` checks a new, validated `fixture-runtime/temp` via `TMP` and
   `TEMP`; do not inherit personal temp paths or rely on the system fallback.
   The sole direct
   domain SQL write is a known synthetic document-reference insertion during
   setup, reused from the cross-owner process fixture. No existing project is read.
3. Add compiled code/document summaries, reviewed memory, controlled replay and
   a trusted integration configuration bound to package A. Apply both client
   formats through the real Python owner. Confirm the five generated MCP tools
   return code/document/memory and exactly one controlled observation:
   `recovery-observations` / `recovery-temperature`, `machine-a` / `sensor-a`,
   temperature **24.5 C**, replay revision **1**, public classification, good
   quality, `ok` envelope and `fresh` sample/source. Verify the matching evidence
   source, revision and sample identity. Empty, duplicate, stale, partial or
   mismatched observations fail the drill.
4. After every synchronous owner exits, snapshot each database using SQLite's
   backup API, including committed WAL contents. Materialize independent backup
   databases in DELETE journal mode. Compare schemas and logical rows, and record
   backup hashes. A copied database can have a different page-header hash from
   its source; byte equality is not claimed. Plain synthetic source/config and
   encrypted DPAPI files are copied exactly. The original state is retained.
5. Select package B, review/commit one desired-config proposal and update the
   profile through native owners. The fixture launcher updates its own integration
   binding and replay JSON. Apply both client configurations through their owner.
   Require the same database schemas and exact +1 native/profile revisions;
   the controlled replay must now return **25.5 C**, revision **2**, with the
   same identity/unit and successful freshness checks.
6. Save a separate post-update snapshot. Build a fresh baseline restore directory,
   validate every member, and retain the entire current state directory using a
   checked same-volume rename. Rename the prepared baseline to the original root.
   No existing state directory is overwritten or recursively deleted.
7. Reconnect package A and compare native/library/profile/context/replay facts to
   the baseline. Then explicitly Restore both client formats through the real
   owner, proving DPAPI still decrypts at the original root and returns the exact
   unmanaged bytes. The restored replay must return **24.5 C**, revision **1**,
   and its original source fingerprint/sample evidence while still fresh.
   Recheck both package manifests and the retained updated tree.

The allowlisted snapshot includes two project databases, the library, profiles,
memory database, compiled AMF, its code/document files, replay, integration JSON,
both client settings, ownership state and protected backups. It excludes live
credentials and external sources. Unexpected fixture files stop the drill.

`report.json` contains package receipts, snapshot manifest hashes, database
application IDs, schema/memory-migration versions, logical digests, validated
baseline/update/restored replay facts and explicit limits. Raw source text,
private settings and absolute fixture paths are not
included in the report. Baseline/post-update private fixture state remains under
the fresh build directory. Keep `build/`, SQLite/WAL/SHM, configuration and secrets
ignored before any repository publication; do not publish the private snapshots.

## Run

Run from the repository after the selected packages and TypeScript fixture owners
have been built. No package installation, network request or personal data is
needed. The fixture producer below is an immutable verification copy, so a later
native rebuild cannot replace it during the drill.

```powershell
python -I -B scripts/package-recovery-drill.py `
  --package-before build/studio-web-mcp-bridge-20261019 `
  --package-after build/studio-web-mcp-bridge-20261019-r2 `
  --producer build/web-verification-486e87ecf4f54e8aa73449a7413a2b8d/runtime/bin/lmti-mcp-profile-tests.exe `
  --node 'C:\Program Files\nodejs\node.exe' `
  --output build/package-recovery-20261019
```

For the interruption case, choose another fresh output and add
`--interrupt-after-retain`. The first invocation returns
`interrupted_at_safe_cutover`; there is intentionally no active state directory.
Invoke the same command with `--resume` (the interruption flag is no longer
needed). Input, source and package hashes must still match. Resume verifies the
complete baseline and retained updated state, then only completes the directory
cutover. It does not rerun fixture creation, the update or any previous owner write.
The original replay timestamp is preserved. Resume must complete within its
3,600-second TTL; an expired replay fails closed instead of refreshing the fixture
to manufacture a passing restore.

The append-only, hash-linked event journal handles interruption before/after either
directory rename, including a rename completed before its phase receipt. Any
other state requires inspection. Do not open the fixture while cutover is pending.
Owner output is streamed in 64 KiB chunks, retaining at most 4 MiB per pipe and
continuing to drain/discard excess bytes. Input is capped at 4 MiB. Each owner
has a 30-second wait budget. Read-only children that exceed time/output budgets
are terminated with at most a one-second reap wait. A writing child's timeout,
output overflow or pipe failure is an unknown outcome: the harness preserves its fixture and
records `WRITE_OUTCOME_UNKNOWN` and a private PID receipt. It does not kill or
retry the owner, take a new snapshot, or proceed to rollback. Confirm its durable
state separately; this condition cannot use automatic `--resume`. Bounded pipe
drainers remain active while the harness is alive; the receipt does not promise
that an owner completed when the harness exits.

Private failure receipts also retain a bounded owner operation label, exit code,
captured byte counts and output SHA-256 digests. They contain no raw stdout,
stderr, command arguments or executable paths; console errors stay generic.

Each SQLite backup has a 30-second progress deadline, including BUSY/LOCKED
retries, and a 250 ms connection lock wait. On expiry the incomplete new backup
and original database are preserved. The deadline is checked after each backup
step/lock wait, so it is not a hard real-time limit. Other SQLite inspection
connections retain their two-second lock timeout. Local filesystem reads,
exclusive writes/fsync, process creation and OS scheduling are synchronous and
do not carry a hard wall-clock guarantee. There is no unbounded `communicate()`
buffer or unbounded SQLite backup retry loop.

Focused tests:

```powershell
python -I -B python/tests/test_package_recovery_drill.py -v
```

The **20 focused tests passed** after these corrections. They cover lexical and
parent-reparse denial before child I/O, WAL-inclusive backup, FTS/review schema
retention, no overwrite, journal edits/gaps, retained post-update data, forward
cutover resume, exact/empty/wrong/stale replay cases, bounded stdout/stderr capture,
read termination, no kill/retry on unknown owner writes and a deterministic
SQLite BUSY deadline, fresh producer temp containment and bounded private
diagnostics without raw output. A fixed local Python child checks real pipe collection;
no native/package process is launched by these unit tests.
The real A/B drill remains a separate test; a unit pass is not a package recovery
result. The harness adds only Python cache-control flags to native-generated MCP
arguments to keep package files unchanged; this is not an actual Codex/Cursor run.
Canonical executable identity is checked while retaining the native-exported
Python command spelling and its full owner argument list.

The first full attempt stopped with `OWNER_FAILED` before fixture creation and
retains its original evidence directory. Its old runner did not retain a child
exit/output receipt, so the exact original exception cannot be recovered. Code
inspection found that the sanitized environment omitted `TMP`/`TEMP` while the
native producer runs temporary-directory checks before writing fixture data.
A separate no-argument smoke of the immutable producer passed with an explicit
fresh workspace temp directory. This is startup evidence only; a fresh full
A/B run is still required after applying the correction. Never reuse or overwrite
the failed attempt's output.

## Clean Windows and CI audit

The local read-only audit found Windows edition `CoreSingleLanguage`, build
`26200.9457`, display version `25H2`. `WindowsSandbox.exe` and the Hyper-V
PowerShell module were not available; `vmrun` and `VBoxManage` were not found on
PATH. Docker, WSL and GitHub CLI executables were present. Their presence does
not establish a disposable clean Windows VM or a ready CI runner. Default local
runner folders were absent; service inventory was blocked by sandbox permissions,
so registered runner-service state is unknown.

`.github/workflows/topology.yml` describes a `windows-latest` build/package and
doctor/API/Qt/Python job on push/pull-request. Source workflow wiring is not a run
receipt. It has no manual-dispatch trigger or evidence-artifact upload at this
audit. No remote CI, VM, service or installation was started or inspected over
the network. Clean Windows acceptance therefore remains open.

Controlled replay and the build foundation come first. Real devices, an
independent operator and clean-Windows acceptance follow that build work; no
live IoT provider or device is selected by this drill.

The drill also does not test cross-machine/user DPAPI portability, custom DACL
restoration, encrypted native storage, schema migration/downgrade, live providers,
concurrent production writers or data reconciliation after a real cutover.

## Controlled package recovery evidence — 19 October

Applied harness tests passed 20/20 in 0.396 seconds. The corrected full runs
`build/package-recovery-20261019-r2` and
`build/package-recovery-interrupted-20261019` both passed. The latter stopped
after retaining the updated tree, then resumed forward without repeating the
fixture creation or update writes. Baseline logical state returned across all
five databases; both real config owners decrypted their original-root DPAPI
backups and restored exact unmanaged configuration bytes. Compiled code/docs,
replay and integration files were preserved, with the whole updated tree retained.
Replay identity/unit/source/evidence and freshness confirmed 24.5/r1 → 25.5/r2
→ 24.5/r1. Package A manifest `7aa5f995221d5540b67f99417833810e63ed9d0d08a944a4e9a2fd5fd8bb617e`
and package B manifest `2960c73da1fb3394a6eca2882325c88b236885d2de8b3272b23b27d5cfcf3531`
were unchanged. The private reports/protocols remain in those fresh build folders.

The first attempt `build/package-recovery-20261019` was retained after failure
before fixture creation. The producer's QTemporaryDir prechecks needed explicit
private TMP/TEMP; the original exception was not captured. A bounded startup
smoke and both full fresh-output runs passed after the fix. No failed write was
retried into that first directory.

This evidence covers a synthetic same-schema/same-user/same-machine recovery.
It is not a production backup feature, schema-2 or mapping migration, actual
client run, independent operator, clean Windows, cross-user/machine DPAPI or
custom DACL acceptance. Those claims remain unverified.
