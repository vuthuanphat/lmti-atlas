# Integrated MVP build: context, observations and operator review

Date: 2026-10-19. Status: **component and configured-browser checks passed on
controlled sources; the generated MCP bridge now has actual Codex read evidence. The previous claim
that build steps 0–4 were complete was too broad. Hierarchy, reviewed mapping, Agent proposal handoff, full recovery,
live-provider, remaining client lifecycle, independent-operator and release
acceptance remain open**.
This record supplements the [master plan](../LMTI_MASTER_PLAN.md),
[Agent contract](../agent-layer-contract.md), [native reference
projection](../adr/2026-10-14-agent-reference-projection.md) and
[desktop knowledge boundary](../adr/2026-10-12-desktop-knowledge.md).

The implemented context path crosses the real native project owner, Python
Agent boundary and TypeScript compiled-knowledge/memory owner. It does not make
Python a database owner or import LMTI into a host application's runtime.

## Product-owner sequence clarification — 19 October

Build the foundation with controlled replay first; choose real devices and
their source only after the build is ready. Real-provider, independent-operator
and clean-Windows checks remain deferred acceptance/release gates, not current
implementation blockers. No live endpoint, protocol or source authorization
was supplied by a general assent to the pilot question. Do not ask again for
pilot/live details before the foundation is ready. Continue hierarchy, reviewed
mapping, proposal handoff and recovery with controlled data. This changes the
sequence of acceptance, not its thresholds or the claim that the full plan is open.

## Completion-audit correction

The r3 browser fixture supplied an explicit trusted integration configuration.
That evidence did not test the normal CP-01 generated client setup. At this
audit, `native/storage/mcp_profile_store.cpp` generated only the legacy launch
arguments through `--target external`, without `--integration-config`; the
normal exported profile therefore retained four tools. The fifth task-context
tool and replay were available through a separate manual trusted launch, not
proved through MCP & Agents setup in Codex/Cursor. The generated-configuration
bridge was subsequently implemented and tested as recorded below. Default
four-tool compatibility remains intentional when integration is not enabled.

Existing process, package, browser and native snapshot results below remain
valid within their stated scope. They must not be promoted to full integrated
setup acceptance. The master also retains implementation work for logical
subsystem and physical area/host/environment hierarchy, stable identities, and
reviewed mapping import/update lifecycle. These are autonomous implementation
gaps under the existing plan, separate from choosing a live provider, arranging
an independent operator or obtaining a clean Windows acceptance environment.

## Generated MCP integration bridge — 19 October follow-up

The normal authenticated Export/Preview/Apply path now passes an optional typed
integration binding through the native generator. Only an external grant for
the same project and every enabled local server's site is accepted. The exact
isolated Python launch adds `--integration-config` and `--integration-sha256`;
there is no TypeScript rewriting of generated TOML/JSON. Without opt-in, the
legacy four-tool profile remains unchanged. Remote definitions are unchanged.

Native generation validates bounded local configuration metadata and its hash.
The fixed config owner accepts only the exact legacy or pinned integrated argv.
Python checks the exported digest before parsing the full integration contract.
A detected configuration change permanently revokes the running authority;
restoring file bytes does not revive it. Review and reconnect explicitly after
an intended change. Queued writes recheck session, binding, profile and source.
Protected Restore remains usable after source revocation without restoring that
source authority; integration-generation failure now retains inspection-based
`canRestore` with `review_required` status.

The first bridge package `build/studio-web-mcp-bridge-20261019` was exercised via
installed Codex app-server using the exact config exported by its authenticated
web API. Its isolated client home and ephemeral read-only thread discovered
five tools, read native context, and called `lmti_task_context` and
`lmti_observations`. Code/document/reviewed-memory summaries retained owner
evidence and classification; three controlled replay samples retained fresh or
stale state and partial coverage. Native, compiled, memory, integration and
replay file hashes stayed unchanged. No model turn or personal config edit was
performed. Cursor JSON was parsed, but actual Cursor scoped reads remain open.

This closes the previously missing generated-configuration connection on
controlled sources. It does not close hierarchy, reviewed mapping lifecycle,
Agent proposal handoff, full dataset migration/rollback or external acceptance.
Native CTest passed 10/10 including the new generator process test. Focused API
checks passed 13/13; two additional real-owner Restore regression cases passed.
The initial full API run was 25/26 because a test compared Windows path spelling
instead of canonical identity; after correcting that assertion all 13 affected
API cases passed. The final package includes recovery and pre-write pin checks; complete
verification is recorded below.

## Final bridge package r2 evidence

Package `build/studio-web-mcp-bridge-20261019-r2` has manifest SHA-256
`2960c73da1fb3394a6eca2882325c88b236885d2de8b3272b23b27d5cfcf3531`.
`build/web-verification-486e87ecf4f54e8aa73449a7413a2b8d/verification.json`:
doctor 105 files / 38,444,450 bytes, native/knowledge runtimes loaded;
API 28/28, zero skipped, 24.4837628 seconds; Qt/API and IPC-fault checks passed.

`build/web02-client-Ow2faz/web-export-report.json` records installed Codex
app-server using this package's exact generated config and isolated `-I` wrapper.
It discovered five tools and read native context, code/doc/reviewed memory and
three replay samples with fresh/stale/partial semantics. Original classification
and owner evidence were retained. Native/memory/compiled/integration/replay bytes
stayed unchanged. No model turn, provider call or personal settings edit occurred.
Actual Cursor scoped reads remain open.

Applied-repository config-owner tests passed 20/20, zero skipped, 0.866 seconds;
client assertions 10/10, zero skipped, 0.074 seconds; native CTest 10/10; focused
pin/process tests 4+7. This is separate evidence, not an implied repeat of the
older 93-test Agent suite or browser r3 workflow on this package.

Integration pins are checked after writer-lock acquisition, after DPAPI
encryption before backup/journal writes, and before config commit. Interrupted
apply rechecks after DPAPI decrypt before recovery writes. Restore retains exact
argv/digest syntax and local-path lexical checks without integration-source I/O,
so withdrawn sources do not block recovery or revive authority. Crypto-hook
tests confirm zero writes or preserved interrupted state with recovery available.

The actual repository scale runner completed a small rehearsal: 10 assets,
two samples/query, page size five, 16 entities/four pages, DB/package unchanged.
Evidence: `build/agent-scale-bridge-smoke-20261019/report.json` and its frozen
protocol. This is runner verification, not a new 1k/10k run or scale acceptance.

The controlled generated-MCP connection is closed. Full build still requires
hierarchy/tombstone/migration, reviewed mapping, Agent proposal handoff and full
dataset recovery, plus external gates. Browser r3 evidence below is not relabelled
as a bridge-r2 browser run.

## Owner contracts

| Boundary | Result and authority |
| --- | --- |
| Native `agent-snapshot` | Authorized declared structure and repository/document reference fingerprints; native project revision remains authoritative |
| TS fixed `agent-context` command | Public compiled code/document summaries and explicitly permitted owner-safe memory summaries; independent compiled/memory content fingerprints |
| Python `IntegratedClient.task_context` | Bounded native neighborhood plus mapped owner summaries, common envelope, evidence, partial coverage and unknowns |
| `lmti_task_context` MCP | Additive fifth tool only when the trusted launcher enables integration; default discovery retains the four existing tools |
| Fixed `agent-read-owner.py` | One-shot broker read for the authenticated local operator API; paths/grants/configuration/key come from the trusted broker, never browser arguments |
| Observation source | Read-only controlled replay adapter with source identity, timestamps, TTL, quality, sequence and reconnection semantics |

`task_context(task, kind, entity_id, depth=2)` follows a bounded declared
neighborhood: maximum depth 4, 200 entities and 1,000 selected edges. Native
repository/knowledge references must match the explicit mapping's kind, ID and
fingerprint. A changed locator cannot silently bind to earlier compiled content.
Memory has an explicit mapping to an authorized native component.

Only the TS owner opens its AMF and memory store. Source code is read there only
for explicitly mapped public compiled entries, to compare current text hashes
with compiled hashes and perform privacy checks. The response carries summaries,
never raw source files. File size is capped at 256 KiB, total mapped content at
4 MiB, AMF at 2 MiB, request at 64 KiB and final owner response at 512 KiB. No
filesystem search, arbitrary shell operation, SQL or URL fetch is an Agent tool.

The owner's memory snapshot is read-only, uses the established safe-summary
policy and excludes unapproved lessons. Private, secret and do-not-prompt memory
are withheld. Pending/rejected lesson candidates never enter task context.

**Memory disclosure is an explicit capability.** A trusted memory mapping must
contain `disclosure: "owner_safe_summary"`. Without a memory mapping, memory is
not exported; an omitted or different disclosure value is rejected. Items retain
their original `public` or `internal` classification and the disclosure label.
Code/document items require public classification and carry
`disclosure: "public_compiled_summary"`. The envelope's effective classification
reflects returned internal summaries, and `scope.knowledgeDisclosure` records the
explicit capability. External native scope alone does not authorize internal
memory. This uses the accepted owner's egress-checked summary policy; it does not
relabel stored knowledge as public or permit raw internal memory.

Normal compiler output and newly approved memory can remain internal. The
process fixtures explicitly publish only their own two nonsecret sample files;
production classifications are not automatically promoted to make a mapping
work. Approved internal lessons are exercised through the explicit safe-summary
capability, with their original classification preserved.

## Freshness, revocation and cursors

Compiled hashes mean that the mapped current file matched its compiled entry at
the owner check; they do not prove runtime behavior. Changed content is withheld
with `COMPILED_CONTENT_STALE`. An altered `.lmtiignore` policy blocks previously
compiled disclosure until the owner recompiles against the new boundary. The
owner checks the AMF and ignore policy again before return.

Python obtains owner data twice, compares fingerprints, then rechecks the native
projection. Each source retains its own version and `checkedAt`; there is no
claim of one atomic transaction across owners. A change or revocation discards
the affected result instead of reusing previous context. Changing the trusted
integration configuration invalidates the loaded client, even if only its JSON
formatting changed; explicitly restart/reconnect after reviewing the new file.

The local operator broker retains a private per-session cursor signing key
across its one-shot calls. Tokens bind query, projection fingerprint, expiry and
effective source/project/site/model policy. Another key, query, source namespace,
model target, changed projection or expired token is rejected. The key is never
sent to the browser. Restarted sessions invalidate prior cursors.

Owner window limits remain explicit: at most 200 memory snapshot records and 200
selected knowledge items; `OWNER_WINDOW_LIMIT` or `RESULT_LIMIT` marks partial
coverage, with no fabricated continuation cursor. This is not an indexed
large-project performance claim.

## Trusted setup

Use canonical absolute local paths. UNC/device namespaces, alternate data
streams, traversal and linked source/configuration parents are rejected. Node 24
or newer is the verified memory-owner runtime. Python 3.11 or newer and the
matching native build are required. Installed runtime paths, source root,
reference fingerprints and source identity are selected by the operator.

The following is a configuration template, not a ready-to-run example. Replace
the angle-bracket placeholders with verified values from the selected local
source and native owner. IDs are illustrative synthetic IDs. The `sourceId` is
the existing desktop source identity: SHA-256 of canonical root, a NUL separator
and the AMF project name. An empty identity is not accepted for automatic
discovery/rebinding. Native reference fingerprints come from the authorized v2
owner projection; no raw locator is required in the Agent response.

```json
{
  "schema": "lmti.agent.integration.v1",
  "projectId": "factory-monitor",
  "site": "factory-demo",
  "target": "external",
  "knowledge": {
    "node": "<absolute canonical Node executable>",
    "cli": "<absolute package>/share/lmti/knowledge-owner/index.js",
    "root": "<absolute reviewed source root>",
    "sourceId": "<pinned 64-character lowercase hexadecimal identity>",
    "mappings": [
      {
        "kind": "code",
        "referenceKind": "repository",
        "referenceId": "repo-sensor",
        "referenceFingerprint": "<native repository fingerprint>",
        "path": "src/firmware.ts"
      },
      {
        "kind": "document",
        "referenceKind": "knowledge",
        "referenceId": "firmware-design",
        "referenceFingerprint": "<native knowledge fingerprint>",
        "path": "docs/firmware.md"
      },
      {
        "kind": "memory",
        "referenceKind": "component",
        "referenceId": "sensor-firmware",
        "disclosure": "owner_safe_summary"
      }
    ]
  },
  "observations": null
}
```

Either owner may be disabled with `null`. To connect the controlled observation
replay, replace `observations` with
`{"path":"<absolute local replay JSON>","sourceId":"controlled-observations"}`.
That file uses `lmti.observations.replay.v1` and must match project/site/source.
Its source kind remains `controlled_replay`; never present it as a live device
connection. Sample time and received time remain separate. Unavailable, revoked,
stale, uncertain, bad-quality, future-clock, sequence-gap, reconnect and conflict
states do not manufacture a current measurement or an installed software version.

Opt-in MCP launch uses the existing fixed binary/database/project/site/target
arguments and adds `--integration-config <absolute file>`. Tool calls cannot
change those launch arguments. The local web launcher enables operator reads
only with exactly one `-ProjectId` and an explicit `-AgentSite`; optional
`-AgentTarget external` and `-IntegrationConfig <absolute JSON>` narrow the
selected connection. Omitting `AgentSite` retains the earlier web behavior.
Browser requests carry only an allowed operation and typed arguments.

The packaged knowledge owner is a narrow `index.js` plus `package.json`, built
with the already-installed Vite/esbuild toolchain. It accepts only the fixed
`agent-context` operation and needs no runtime `node_modules` tree. The full
developer CLI remains compatible. Package startup/lifecycle and rendered UI
checks must be recorded independently from the owner process tests below.

## Review desired configuration

The operator flow reads the current native asset, creates a bounded preview,
shows expected and desired values, and lets the human reject or commit the
reviewed preview. Preview identity, project revision, topology revision, old
values and expiry remain bound to the proposal. The native owner rechecks the
saved revisions and expected values when committing; a stale preview cannot
silently overwrite another editor's changes. A pending operation is inspected
through its operation handle before retrying, because a commit can finish before
the caller sees the response.

This changes **saved desired configuration only**. Neither accepting a proposal
nor observing a successful save sends a device command, installs firmware or
proves a live deployment. Agent reads cannot approve, commit or actuate devices;
the authenticated operator review boundary owns those local writes.

## Verification evidence

Verified on 2026-10-19 using the native build
`build/studio-mvp-integrated-20261019/bin/lmti-project.exe` and package revisions
identified below. The historical browser package candidate was
`build/studio-web-integrated-20261019-r3`, including the browser navigation
correction. Automated package verification and the scoped real-browser workflow
passed on controlled synthetic data.

| Check | Observed result |
| --- | --- |
| Full TypeScript package suite | 33 files / 392 tests passed in the coordinated run before the final AMF-declared-root regression |
| TS `agent-context.test.ts` | Final 9/9 and TypeScript build passed after the AMF-root hardening: real compiler/memory fixture, explicit disclosure, approved lesson, stale/denied source, path and output boundaries |
| Native project/core checks | 9/9 reported by the coordinated native build run; review/write-owner evidence is separate from Agent read tests |
| Python `test_agent*.py` | Final 93/93 passed, zero skipped, in 17.099 seconds, including effective knowledge classification and parent-first configuration-path validation |
| Real cross-owner/MCP process suite | 6/6 passed in 4.707 seconds with the developer TS owner; native and memory DB bytes unchanged |
| Operator process/cursor suite | 8/8 passed in the complete Python run, including key/source/model policy binding |
| Narrow bundled knowledge owner | Same six real process cases passed in 3.333 seconds against `build/knowledge-owner-check2-20261019/index.js`, without runtime `node_modules` |
| Packaged owner/MCP integration | 6/6 passed, zero skipped, in 3.502 seconds using `studio-web-integrated-20261019` native binary, Python modules and narrow knowledge bundle after AMF-root hardening; 29 owner runtime files were subsequently verified byte-identical in r3, without claiming the six cases were rerun on r3 |
| Historical browser package r3 verifier | Doctor checked 105 files / 38,395,254 bytes and loaded native/knowledge runtimes; API 24/24 passed with zero skips in 23.515 seconds; Qt/API interoperability and IPC-fault checks passed; evidence in `build/web-verification-938705515c1a4f45b025cef7dcdb8a10/verification.json` |
| UI checks | 14 UI tests reported passing in the coordinated run; actual r3 browser entry, inventory, context/evidence, replay, EN/VI, reject, commit and readback passed with independent native snapshots |
| Go compatibility | `cmd`, `internal` and `pkg` package tests passed in the coordinated run; broad `go test ./...` encountered an inaccessible historical build scratch directory |
| Synthetic scale measurements | 1,000 assets / 1,006 entities / 21 pages and 10,000 assets / 10,006 entities / 201 pages read completely; native database bytes unchanged for both; no performance acceptance threshold was set |

The real process suite uses native `init-demo`, an owner-compiled synthetic source
and owner-created/reviewed memory. Test-only SQLite inserts create the native
reference fixture; runtime code does not use Python SQLite. It verifies code,
documents and reviewed memory together, independent evidence, absence of raw
paths/private/pending material, stale mapped code, changed reference fingerprints,
native permission revocation, configuration revocation and five-versus-four MCP
tool discovery. These are actual local process checks, not claims of a Codex or
Cursor model turn, live IoT measurement, second-operator success or clean-machine
installation.

The package r1 owner-runtime run verified nine imported Agent/Project/Common modules were
loaded from `share/lmti/python/src`. The test's MCP subprocess normally overrides
`PYTHONPATH` to the developer checkout; a workspace copy changed only that
assignment to inherit the pinned package `PYTHONPATH`. Both opt-in and default
MCP processes therefore ran the packaged `lmti_agent.mcp` module. The checkout
provided only the test fixture's compiler and memory-creation APIs. This run did
not exercise the packaged MCP wrapper or mutate the package; launcher and browser
acceptance remain separate evidence.

The provenance check compares 29 runtime files between tested r1 and historical browser r3:
the native owner, complete Python `.py` tree, bundled knowledge entry/package
metadata and fixed MCP/read wrappers. All matched byte for byte. This supports
reusing the six-case owner-runtime evidence for the equivalent owner components;
it does not retroactively pass r1 package integrity or replace the separate r3
API, launcher and browser checks.

The first package copied preexisting Python bytecode into its manifest. Actual
use regenerated a cache file and doctor correctly rejected the changed hash.
The packager now removes only `.pyc` leaf files from the validated fresh package
output before recording the manifest. Package r2 passed the selected verifier
after this correction; the historical r3 candidate includes the same fix.
Runtime caches are not publisher-authenticated source files.

Real browser navigation exposed another distinct issue: a top-level `GET /`
document request was labelled cross-site and refused by the origin guard. A
narrow correction in r3 permits only the `GET /` top-level document-navigation
case while retaining Host/Origin and authenticated API/mutation protections.
Real r3 browser launch and the controlled workflow passed. This is separate
evidence from the API/UI unit tests.

The browser showed ten inventory entities; public compiled code/document
summaries; deliberate and reviewed memory with original Internal classification
and owner-approved safe-summary disclosure; and expanded revision evidence.
Controlled replay showed firmware `0.2.0` and temperature `24.5` fresh at TTL
3,600 seconds, pressure `2.1` stale at TTL 30 seconds, and the partial/replay
disclaimer. English-to-Vietnamese switching worked.

An independent native snapshot after rejecting the preview confirmed project
and topology revision r1, `enabled: true`, `pollMs: 1000`, and byte-for-byte
unchanged native database. One subsequent accept persisted project/topology r2
and `pollMs: 2000`, with exactly one revision increment, other asset fields
unchanged and the memory-store hash unchanged. During an explicit fixture-only
two-second delay, navigation/entity refresh was locked and then restored.
Browser console errors were empty. These checks concern saved desired
configuration on the synthetic fixture; they do not show device actuation,
live telemetry or success by a second operator.

The controlled scale report used Windows AMD64 and Python 3.14.2, with ten
samples per query shape. Results are baseline measurements, not a scale
acceptance claim:

| Synthetic assets | First-page p95 | Last-asset lookup p95 | Last-asset related p95 | Pages / entities |
| --- | --- | --- | --- | --- |
| 1,000 | 550.51 ms | 493.98 ms | 459.92 ms | 21 / 1,006 |
| 10,000 | 3,822.86 ms | 3,415.03 ms | 3,429.53 ms | 201 / 10,006 |

Both runs completed without errors and with unchanged database bytes. The
report deliberately retains `acceptancePassed: false`: no latency, resource or
benefit threshold was approved. These measurements concern native structure
queries; they do not measure concurrent readers, live observations, full
cross-owner context or deployment on another machine.

Run from the checkout with trusted runtime paths configured locally:

```powershell
$env:PYTHONPATH = Join-Path (Get-Location) 'python/src'
$env:PYTHONDONTWRITEBYTECODE = '1'
python -B -m unittest discover -s python/tests -p 'test_agent*.py' -v
```

Set `LMTI_PROJECT_BINARY` to the built native executable to enable process tests.
`LMTI_AGENT_REPO`, `LMTI_NODE_BINARY` and `LMTI_KNOWLEDGE_CLI` optionally select
the checkout, canonical Node and packaged narrow owner. The latter permits the
same six process cases to verify the actual package bundle. The first ESM bundle
failed because bundled CommonJS memory code required Node builtins; the corrected
bundle supplies Node's `createRequire`. Package r1 passed all six owner process
cases after AMF-root hardening, with Python loading pinned to the package as
described above. R2 and historical browser r3 have separate integrity and API/Qt/IPC
evidence. A successful bundle build alone is not runtime evidence.

## STRUCT-01 domain increment — source build only

The typed optional hierarchy, acyclic containment/depth/site/environment
validation and schema-1 loss-prevention guards are implemented under the
[hierarchy ADR](../adr/2026-10-19-project-hierarchy.md). The complete native
build and 11/11 CTest passed in 49.64 seconds, including the new
`project_structure_domain` test (0.20 seconds). Legacy in-memory context,
impact and proposal paths refuse hierarchy until inherited privacy is
supported; schema-1 writes refuse present hierarchy before filesystem I/O.
Independent read-only review found no actionable issue in this increment.

This is a later source build, not a modification of bridge r2 or completed
STRUCT-01. Schema-2 storage/copy migration/activation/recovery, durable
retired identities, v3 projection/path privacy, generated setup and reviewed
import/UI remain required. Old snapshots must explicitly refuse schema 2
when the dual-version native reader is introduced.

## Remaining release gates

Controlled replay is the authorized build source. A real IoT provider, its
authorization, failure/reconnect behavior and representative workload remain
an acceptance gate scheduled after the foundation is ready; they do not block
current implementation. Codex generated-config reads now have controlled-source evidence. Actual Cursor
scoped reads and remaining client lifecycle remain open. Independent-operator
and clean-Windows acceptance are deferred until after build; full dataset/package
recovery preparation continues now. Measured benefit remains a separate gate.
Repository/document mappings are deliberate links to compiled summaries; this is
not a new language server, causal-impact proof or whole-repository understanding
claim. Source identities need explicit reconnection after a move/rename.

[CẢNH BÁO BẢO MẬT] Native topology/project SQLite remains unencrypted and is
restricted to nonsecret metadata. Same-user launch is not an OS sandbox or
multi-user authorization system. Store credentials outside code, source maps,
context, replay files and logs. Review `.gitignore` before push, and run
`lmti publish preflight` before publication. No publication or live connection is
implied by this local build evidence.

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

## STRUCT-01 increment 2 — applied native storage evidence

The full Release native/Qt build passed, followed by 13/13 CTest suites in
58.84 seconds, zero failed or skipped. New project_structure_storage passed
in 2.27 seconds and structure_desktop in 0.89 seconds. The source-only change
adds schema-2 typed hierarchy, a private bounded active/retired registry,
same-transaction graph/revision/identity updates, store UUID/path lineage,
legacy privacy refusal and safe Qt Save As behavior. A deprecated Qt test macro
was replaced and that target rebuilt before the final suite.

Tests cover all six retirement kinds, new-ID replacement, SQL-failure rollback,
schema/registry corruption and downgraded version tags, cross-store divergent
tombstones and same-path independent replacement. The corruption writer tests
load each destination before corruption, so they reach transaction validation
rather than short-circuiting on a different source path. Independent review's
cross-store lineage finding is resolved; no further actionable defect was found.

The build is not a new packaged hierarchy capability. Explicit copy migration,
registry-preserving clone, recoverable binding activation, snapshot v3/inherited
policy, reviewed mapping/import and operator UI remain required. Existing bridge
packages and their historical MCP/browser/recovery evidence remain unchanged.

## STRUCT-01 increment 3 — applied scoped read boundary

The [v3 read-boundary record](2026-10-19-structure-read-boundary.md) documents inherited privacy, directed
Agent traversal, strict integration v2 and the broker-to-child configuration
pin. Current source passed134 Agent tests and25 config-owner tests; native
and API failures were repaired and their focused regressions passed. The
record keeps full-run and focused evidence distinct. No new packaged
hierarchy, migration/activation, UI or live acceptance is implied.

## STRUCT-01 increment 4 — native copy and migration

The [copy-owner record](2026-10-20-project-copy-owner.md) documents applied schema-1 migration,
registry-preserving schema-2 clone, WAL-consistent snapshots and read-only
recovery evidence. Release build and all 15 native/Qt suites passed in
74.74 seconds after the revision-bound correction. Copy receipts
do not activate a library binding. Durable binding generation/CAS, reviewed
activation, operator UI and mapping lifecycle remain follow-on work.

## STRUCT-01 increment 5 — native library generation

The [library-owner record](2026-10-20-project-library-generation.md) documents explicit retained-backup
v1-to-v2 upgrade, UUID/generation binding CAS, stale automatic-writer
refusal and commit reconciliation. Release builds and all 16 native/Qt
suites passed in 83.76 seconds; the focused suite passed in 5.22 seconds.
Copy activation and its durable receipts, operator UI, mapping lifecycle
and a new packaged hierarchy runtime remain follow-on work.

## STRUCT-01 increment 6 — native copy activation

The [activation record](2026-10-20-project-copy-activation.md) documents explicit retained v2 backup,
v3 prepared/activated/abandoned receipts and held source/target snapshots.
Release build passed; reservation and activation focused suites passed in
5.59 s and 23.54 s, then all 18 native/Qt suites passed in 110.71 s.
Private caller fingerprints, deliberate UI flows and client reconfiguration
still need wiring; no new package or end-to-end acceptance is claimed.

## STRUCT-01 increment 7 — caller identity and Qt library CAS

The [caller record](2026-10-20-project-binding-callers.md) documents private native identity, strict web
projection/fingerprints and deliberate Qt library intents. Release/TypeScript
builds passed; API 50/50 and native/Qt 20/20 (129.89 s) passed.
Qt MCP modal freshness and writer lifecycle, operator activation UI, mapping
and handoff remain. This is not a new package or full MVP acceptance.

## STRUCT-01 increment 8: Qt MCP

Cập nhật 20/10: MCP Qt đã giữ cố định dự án/cấu hình được xem trước, kiểm tra
lại trước thao tác và giữ tiến trình ghi khi đóng hộp thoại. Phản hồi thiếu hoặc
sai không được coi là ghi thành công; review trạng thái hiện tại không tự ghi lại.
Build Release đạt; **21/21 native/Qt đạt trong 207.38 giây**. Suite MCP mới
đạt **45/45** (43 ca hành vi + khởi tạo/kết thúc), không skip.
Chín kiểm tra Qt mới ↔ API bridge-r2 đạt trên fixture; đây là kiểm thử kết hợp
với package cũ, chưa phải package MVP tích hợp mới. UI activation/recovery,
mapping/import và Agent proposal handoff vẫn còn trong phạm vi build.

## STRUCT-01 increment 9: recovery discovery

Cập nhật 20/10: đã có tìm lại bản sao khi mất mã thao tác và cổng native
chỉ đọc để kiểm tra dự án, bản sao và lịch sử kích hoạt. Mỗi lượt xét tối đa
1.000 mục; vượt giới hạn hoặc không đọc được phải báo chưa đầy đủ. Bản có intent
hợp lệ vẫn chưa được xem là bản sao đã kiểm chứng. Phân trang từ chối tiếp tục
khi nội dung đã thay đổi; không tự chọn bản mới nhất hoặc chạy lại thao tác ghi.
Build Release đạt; **23/23 native/Qt đạt trong 195.44 giây**.
Sáu suite tập trung đều đạt; suite discovery ghi nhận **2 ca skip có điều kiện**.
Cổng ghi, broker/UI activation-recovery, mapping/import và handoff vẫn cần
hoàn thiện; đây là bằng chứng source build, chưa phải package MVP mới.

## STRUCT-01 increment 10: private write facade

Cập nhật 20/10: cổng native đã hỗ trợ sao chép, hai bước nâng định dạng
thư viện và chuẩn bị/kích hoạt/hủy yêu cầu kích hoạt đang chờ. Mỗi thao tác dùng bản xem
trước hoặc receipt cụ thể; kết quả phân biệt từ chối trước khi ghi, xác nhận hoàn
tất và chưa xác định. Khi phản hồi bị mất hoặc lỗi sau commit, chỉ đọc trạng thái
để phục hồi; không tự ghi lại. Hủy thao tác đang chờ chỉ cần thư viện, không cần
nguồn hay thư mục bản sao còn truy cập được.
Build Release đạt; **24/24 native/Qt đạt trong 206.14 giây**, cùng **7/7 suite
tập trung**. Cổng này dành cho tiến trình vận hành nội bộ; broker, quyền launcher
và giao diện review/phục hồi vẫn cần nối tiếp. Đây là bằng chứng source build,
chưa phải package MVP tích hợp mới hoặc nghiệm thu thiết bị thật.

## STRUCT-01 increment 11: private API/native primitives

Cập nhật 20/10: đã build lớp nối riêng giữa API và cổng native, phân biệt
chưa khởi chạy với kết quả ghi chưa xác định, giữ tiến trình ghi đến khi đóng
hẳn và kiểm tra phản hồi theo đúng thao tác đã duyệt. Helper Windows từ chối
yêu cầu nhận quyền khi broker cũ hoặc tiến trình con còn sống; nhận lại quyền vẫn phải đọc
đối chiếu trạng thái. Đã sửa lỗi UUID rỗng schema 1 bị chuyển thành SQL NULL khi
chuẩn bị kích hoạt và thêm kiểm thử migration/clone qua cổng tiến trình thật.

**84/84 kiểm thử API**, **34/34 ca tập trung**, **16/16 kiểm thử helper Windows**
và **24/24 suite native/Qt đạt** (193.16 giây); discovery còn
2 ca symlink skip có điều kiện. Đây là các thành phần riêng đã kiểm chứng;
quyền launcher, điều phối ghi/phục hồi trong service và giao diện review vẫn
phải nối tiếp. Chưa có package MVP tích hợp mới hoặc nghiệm thu thiết bị thật.

## STRUCT-01 increment 12: reviewed project operations

Cập nhật 20/10: đã nối quyền launcher, điều phối các thao tác ghi, API native và giao diện Activity cho sao chép/chuyển đổi, nâng thư viện, chuẩn bị/kích hoạt/hủy và đối chiếu phục hồi. Preview một lần, phiên hết hạn và kết quả chưa rõ được kiểm tra; thao tác ghi đang chạy được giữ đến khi kết thúc, không tự gửi lại.

Build API/UI đạt; **132/132 kiểm thử API, 24/24 UI và 8/8 launcher đạt**, không skip. Gói local `studio-web-operations-20261020` có **116 tệp qua doctor**, đủ bốn binary native từ cùng build Release. Kiểm thử HTTP trên chính gói đạt cả nguồn schema 1 và 2: **14 lượt ghi được xác nhận**, reject không tạo bản sao, nguồn giữ nguyên byte và các broker đóng sạch. Không chạy lại suite C++ vì increment này không đổi nguồn C++.

**Chưa nghiệm thu thao tác trình duyệt:** CUA chặn kênh bootstrap thử nghiệm (`EPERM`/`EACCES`), không có navigation hoặc hành động UI; đã giữ bằng chứng riêng. Gói mới không đồng nghĩa toàn MVP hoàn tất. Hierarchy, mapping/import có review, Agent proposal handoff và workload còn cần build; thiết bị thật, client còn lại, người thứ hai và Windows sạch thuộc nghiệm thu sau build. Kiểm tra `.gitignore` cho cấu hình riêng và secrets trước khi push.

## STRUCT-01 increment 13: reviewed logical hierarchy owner

Cập nhật 20/10: đã triển khai domain và owner native cho năm thao tác phân cấp
logic: thêm/đổi tên/di chuyển subsystem, đổi membership component và nghỉ dùng
subsystem rỗng. Bản review giữ snapshot, scope, UUID kho và registry riêng;
commit kiểm tra lại rồi ghi graph, lịch sử ID và một revision trong cùng transaction.
Quyền kế thừa cả tổ tiên và repository liên kết; di chuyển không được giảm
classification. ID đã nghỉ dùng không thể tái sử dụng, kể cả sau clone.

Build Release đạt; **26/26 suite native/Qt đạt trong 217.21 giây**,
**5/5 suite tập trung đạt**. Hai bộ mới có **128 kiểm tra domain** và
**13 ca SQLite với 163 kiểm tra**, không lỗi/skip. Suite discovery cũ còn
**2 ca symlink skip có điều kiện**, ghi riêng trong bằng chứng.
Rollback trước commit, mất phản hồi giả lập sau COMMIT thật, xung đột revision/
UUID/registry và quyền repository đều được kiểm tra.

Đây là owner native dùng review trong cùng process; chưa có cổng CLI/HTTP hay
editor hierarchy mới. Bước tiếp theo nối token review qua process, quyền launcher,
broker và UI; phân cấp vật lý, mapping/import và Agent handoff vẫn còn trong kế
hoạch. Gói thao tác dự án trước đó được giữ nguyên, không coi là đã chứa increment này.

## STRUCT-01 increment 14: private hierarchy transport

Cập nhật 20/10: cổng native riêng đã có đọc trạng thái, xem trước và commit
phân cấp logic qua các tiến trình khác nhau. Token giữ nguyên snapshot/scope và
được kiểm tra lại đầy đủ; quyền từ argv tin cậy, đường dẫn từ thư viện đã chọn.
Thư viện, dự án và các sidecar được kiểm tra đường dẫn; cổng hierarchy từ chối
hardlink thư viện. Kết quả phân biệt refused/confirmed/unknown, không tự gửi lại.

Build Release đạt; **27/27 suite native/Qt đạt trong 372.82 giây**,
**6/6 suite tập trung đạt**. Bộ transport mới có **11 ca, 503 kiểm tra**,
không lỗi/skip; discovery cũ còn **2 ca symlink skip có điều kiện**.
Các kiểm tra owner/domain trước vẫn đạt. Fault được chèn trước/sau COMMIT thật,
không được gọi là thử nghiệm kill process.

Đã đo cây hợp lệ sâu 32: 104 component lá trả
trọn 522,935 byte và commit thành công;
105 lá cần 527,284
byte nên bị từ chối nguyên khối. Mẫu 2.000 lá cũng bị từ chối; phản hồi thực tế
chỉ 38 byte lỗi, không chứa token/diff
thiếu. Đây là giới hạn của một họ workload đã đo, không phải SLA hoặc cam kết
hỗ trợ mọi graph schema 2.

Chưa nối cổng này vào launcher/API/UI và chưa đóng gói lại. Tiếp theo hoàn thiện
lớp nối TypeScript, điều phối ghi/phục hồi, editor logic; phân cấp vật lý,
mapping/import và Agent handoff vẫn còn. Gói ZIP trước giữ nguyên.

## STRUCT-01 increment 15: private TypeScript hierarchy adapter

Cập nhật 20/10, STRUCT-01 increment 15: lớp nối TypeScript riêng đã kiểm tra
quyền dự án bất biến, JSON/token/diff chặt chẽ và kết quả refused/confirmed/unknown.
Build API đạt; **20/20 kiểm tra tập trung**
trong 2015.693 ms và **152/152
kiểm tra toàn bộ API** trong 49312.1449 ms đều đạt, không lỗi,
cancel, skip hay todo. Ca tiến trình native thật thêm một subsystem có Unicode,
commit rồi đọc lại, giữ nguyên thư viện/UUID, tăng đúng một revision và từ chối
replay cũ. Guard dùng PREVIEW qua pool kiểm tra riêng khi pool chính chỉ có một slot.
Kiểm chứng đủ năm thao tác native thuộc increment 14 trước đó; không chạy lại
27 suite native trong đợt TypeScript này.

Hai lần runner dừng sớm do kiểm tra DirectoryInfo và đường dẫn junction của
compiler pnpm đã được giữ lại; compiler chưa chạy ở cả hai lần, không phải lỗi
sản phẩm. Suite API có fixture HTTP loopback; “không network” trong receipt
được hiểu là không gọi mạng ngoài/provider, không phải bằng chứng không mở socket.

Chưa nối adapter phân cấp vào launcher, service/routes, điều phối ghi/phục hồi
hoặc editor UI; chưa đóng gói mới. Bước tiếp theo giữ token riêng trong review
opaque, điều phối ghi và phục hồi đầy đủ các scope bị ảnh hưởng; không tự gửi lại
ghi chưa rõ kết quả, không dùng trạng thái hiện tại để gán lại kết quả lịch sử.
Gói cũ gồm manifest/116 file đã liệt kê và ZIP giữ nguyên hash.

## STRUCT-01 increment 16: original-target recovery provenance

Cập nhật 20/10, STRUCT-01 increment 16: marker v2 giữ đích ghi ban đầu
trước khi owner chạy. Coordinator giữ toàn bộ entry và khóa ghi qua bước cập
nhật metadata. Phục hồi kiểm tra quyền cho toàn bộ tập đích, thu bằng chứng hai
lần và yêu cầu xác nhận riêng; không tự chạy lại ghi unknown hoặc đổi kết quả
lịch sử dựa trên trạng thái hiện tại.

Build API đạt; **96/96 kiểm thử tập trung**, **211/211 kiểm thử API đầy đủ** và
**25/25 kiểm thử marker Python trên Windows** đều đạt, không bỏ qua. Lượt API
đầy đủ mất 73.852 giây; Python unittest mất 30.903 giây. Các lần build/kiểm thử
lỗi trước đó được giữ lại: hai type annotation còn thiếu và các fixture chưa
chờ hết bước cập nhật marker sau kết quả ghi đã biết. Bản sửa fixture chỉ đợi
trạng thái đọc, giữ nguyên cơ chế khóa và không gửi lại thao tác unknown.

Unknown library upgrade vẫn bị chặn chờ kiểm tra native đầy đủ thư mục backup.
Marker v1 chưa có chuyển đổi tự động; thiếu identity ban đầu không được coi là
đã phục hồi. Kiểm tra binding hiện tại chưa phải phép đọc native có điều kiện
nguyên tử. Chưa nối hierarchy vào launcher/service/editor, chưa có browser
acceptance hoặc gói mới. Gói/ZIP cũ giữ nguyên; không đóng STRUCT-01 hay toàn MVP.

[Chi tiết kiểm chứng](2026-10-20-write-recovery-provenance.md).

## STRUCT-01 increment 17: library upgrade recovery

Cập nhật 20/10, STRUCT-01 increment 17: native đọc đầy đủ thư mục backup
đã ghim, kiểm tra snapshot typed và receipt hiện có; lớp API dùng bằng chứng này
để đối soát đích nâng cấp ban đầu. Trạng thái hợp lệ cho phép xác nhận riêng rồi
review mới. Kết quả ghi cũ vẫn là unknown; không chọn orphan để đoán operation ID
đã mất, không chạy lại ghi.

**47/47 kiểm thử API tập trung** và
**231/231 kiểm thử API đầy đủ** đạt, không skip.
**6/6 suite native tập trung** và **28/28 suite native/Qt đầy đủ** đạt
(320.14 giây). Suite recovery mới có 14 ca, 6386 kiểm tra,
0 lỗi, 1 skip symlink có điều kiện;
toàn native có 3 skip nội bộ, không skip suite CTest.
Năm ca API/native thật gồm hai schema và lỗi sau COMMIT; đối soát được kiểm tra
qua collector/coordinator riêng, không phải nghiệm thu browser hay HTTP recovery.

Đã đóng phần chặn increment 16 dành cho backup upgrade hợp lệ và xác minh đầy đủ.
Backup thiếu, hỏng, dở dang, sai pin hoặc thư mục không kiểm tra hết vẫn giữ khóa;
chưa có thao tác owner để sửa các artifact đó. Giữ log lỗi UUID regex production
và lỗi so sánh prototype trong fixture, cùng các bản sửa và lần chạy lại.
Không có gói/ZIP mới, không đóng STRUCT-01 hay toàn MVP.

[Implementation record](2026-10-20-library-upgrade-recovery.md).


## Increment 18 — original binding native read

Native conditional recovery read is implemented and verified: focused 6/6, full 29/29. See [scope and evidence](2026-10-20-original-binding-read.md). The API still needs to adopt this mode; hierarchy UI and full MVP remain open.


## STRUCT-01 increment 19 — conditional original-binding API

Cập nhật 20/10, STRUCT-01 increment 19: API đã nối kiểm tra đích ghi gốc
qua lệnh native có điều kiện. Chuỗi đọc catalog → project → catalog cũ được bỏ;
quyền, identity file gốc, guard hàng đợi và so sánh binding sau đọc vẫn được giữ.
JSON riêng giới hạn 64 KiB đầu vào / 128 KiB phản hồi đầy đủ có LF, timeout 30 giây;
không tự quay về cách đọc cũ và không dùng phản hồi lỗi để gán lại kết quả ghi.

Build TypeScript đạt. **90/90 ca tập trung**
đạt trong 8763.7447 ms; **251/251
ca toàn API** đạt trong 60039.286 ms, không lỗi/cancel/skip/todo.
Bốn phase prepare/build/focused/full đều đạt ngay lần initial, không có lần chạy
API thất bại trong mốc này. Năm ca mới dùng native thật kiểm tra Unicode/BigInt,
cặp schema cũ/mới, profile vắng/xuất hiện, thay file cùng tên, ghi profile có guard
và quan sát đầy đủ trước acknowledgment riêng. Barrier unknown trong ca cuối là
fixture cùng tiến trình; không phải thử mất ACK, kill writer hay restart broker.

Increment 18 vẫn là bằng chứng native riêng: 29/29 suite, 13 ca/290 kiểm tra,
một skip có điều kiện trong suite mới. Không chạy lại toàn native trong đợt API.
Suite API có HTTP loopback; không phải bằng chứng không mở socket. Chưa đóng gói
mới, chưa nghiệm thu browser/Windows sạch; không tuyên bố atomic nhiều store hay
atomic giữa lần đọc kiểm tra với lệnh ghi sau đó. Toàn MVP còn các gate mở.

[Phạm vi và bằng chứng](2026-10-20-original-binding-api.md).


## STRUCT-01 increment 20 — hierarchy backend

Cập nhật 20/10, STRUCT-01 increment 20: backend phân cấp đã nối quyền
launcher rõ ràng, state/preview/reject/commit qua native, kiểm tra đúng đích gốc
trước ghi và phục hồi chung trên toàn bộ tập đích chưa rõ kết quả. Catalog mới
chỉ đọc vị trí gốc; không phụ thuộc profile hay dùng canonicalPath làm đường mở file.

Native tập trung 8/8
và toàn bộ 30/30 suite đạt
(318.10s); suite mới có 8 ca/127 kiểm tra.
Bốn dòng skip nội bộ về tạo symlink của suite cũ được giữ trong JSON; không suite
CTest nào bị bỏ qua. API tập trung
149/149 và toàn bộ 305/305
đạt, không fail/cancel/skip/todo. Ca HTTP dùng ghi native thật, một ca cố ý làm hỏng
ACK đã nhận sau khi child đóng rồi dựng lại broker trong cùng tiến trình.
Đó không phải thử restart hệ điều hành hay crash broker thật.

Lần build native đầu thất bại vì enum Privacy::Private trong kiểm thử; sửa fixture
và kỳ vọng kế thừa về Internal/Public, không đổi mã sản phẩm. Không có gói phát hành/UI editor mới; decoder
UI cho hierarchyItems còn phải làm. Không coi nhiều store là giao dịch nguyên tử,
không tự thử lại lệnh ghi và không đổi lịch sử unknown thành confirmed qua phục hồi.
Nghiệm thu thiết bị/provider thật, người vận hành thứ hai và Windows sạch còn mở.

[Phạm vi và bằng chứng](2026-10-20-hierarchy-backend.md).


## STRUCT-01 increment 21 — reviewed logical hierarchy UI

Cập nhật 20/10, STRUCT-01 increment 21: đã thêm trình sửa phân cấp logic
EN/VI trong trang Structure, với năm thao tác có kiểu, lô tối đa 32 thay đổi,
xem đủ sai khác và phạm vi bị ảnh hưởng trước khi từ chối hoặc xác nhận một lần.
Quyền phân cấp được kiểm tra riêng; không suy ra từ quyền Agent hay copy dự án.
Activity trình bày đủ nhóm phạm vi phục hồi chung, không tạo trạng thái profile giả
cho phân cấp và không đổi kết quả ghi lịch sử chưa xác định thành đã thành công.

TypeScript/Vite và UI 55/55 đạt; API tập trung
26/26, toàn bộ 321/321
đạt, không fail/cancel/skip/todo ở các lượt cuối. Lượt API tập trung đầu có
25/26 đạt: fixture trả cùng đối tượng snapshot nên không mô phỏng được thay đổi
generation. Sửa kiểm thử để trả snapshot độc lập; không sửa sản phẩm trong lượt r2.
Kết quả UI ban đầu vẫn áp dụng vì toàn bộ đầu vào và bundle UI được giữ nguyên.

Thử mở browser qua cơ chế được hỗ trợ chỉ trả trạng thái queued; CUA không thấy tab. Host giả lập đã khởi động, đọc trạng thái và đóng/drain thành công; projection dự án, library và profile không đổi. Chưa có navigation, thao tác UI hay ảnh chụp được kiểm chứng. Nghiệm thu tương tác trình duyệt vẫn còn mở.

Không có thay đổi native hay gói phát hành mới. Kết quả native 30/30 của increment 20
là bằng chứng trước đó, không phải chạy lại ở increment này. Phân cấp vật lý,
mapping/import, nghiệm thu provider/thiết bị thật, người vận hành thứ hai và
Windows sạch còn mở; chưa nghiệm thu toàn bộ MVP.

[Phạm vi và bằng chứng](2026-10-20-hierarchy-ui.md).


## STRUCT-01 increment 22 — physical hierarchy native owner

Đã thêm lõi C++ và owner SQLite cho 11 thao tác site/khu vực/môi trường/vị trí
thiết bị hiện có. Mỗi lô có tối đa 32 thay đổi, đối chiếu giá trị gốc, xem đủ
sai khác và các đối tượng bị ảnh hưởng trước khi ghi một lần. Site của asset
và toàn bộ dữ liệu ngoài phạm vi được giữ nguyên; bỏ vị trí không nghỉ hưu asset.
Quyền ghi vật lý tách riêng; không tự hạ dữ liệu Internal thành Public khi di chuyển.

Build native đạt; tập trung **8/8**, toàn bộ **32/32 suite CTest**
đạt (350.85 giây). Suite domain có 13 ca /
340 kiểm tra; owner có 11 ca /
210 kiểm tra, 0 skip.
Danh sách skip nội bộ và mọi lần chạy được giữ trong JSON bằng chứng;
không suite CTest nào bị bỏ qua.

Kiểm thử dùng SQLite thật trong thư mục tạm: xung đột revision dùng chung với
phân cấp logic, thay file cùng tên, dữ liệu WAL, lịch sử ID không tái sử dụng,
rollback khi có lỗi chèn giữa các câu lệnh ghi, lỗi trước COMMIT và mất phản hồi
sau COMMIT. Các điểm gây lỗi chỉ được biên dịch vào target kiểm thử.
Đây không phải bằng chứng crash tiến trình/hệ điều hành hay atomic nhiều store.

Phần này mới là native domain/owner. CLI có kiểm soát, API/quyền/phục hồi chung và
UI phân cấp vật lý là bước kế tiếp. Không chạy lại API/UI, không tạo gói phát hành
mới. Kết quả API 321/321 và UI 55/55 thuộc increment 21; nghiệm thu browser thực
vẫn còn mở. Mapping/import, provider/thiết bị thật và Windows sạch chưa nghiệm thu;
toàn bộ MVP chưa hoàn tất.

[Phạm vi và bằng chứng](2026-10-20-physical-hierarchy-native.md).


## STRUCT-01 increment 23 — cổng native phân cấp vật lý

Đã nối 11 thao tác vật lý qua cổng tiến trình có đầu vào cố định, quyền theo dự án,
xem sai khác rồi xác nhận ghi. Phản hồi phân biệt rõ từ chối trước khi ghi, kết quả
chưa xác định sau khi bắt đầu và ghi đã xác nhận. Đọc phục hồi có điều kiện kiểm tra
đúng tệp gốc, thư viện, UUID và liên kết đã chọn; không chuyển sang tệp thay thế.

Build native đạt; kiểm thử tập trung **10/10**, hồi quy toàn bộ **34/34 suite CTest**
đạt (360.56 giây). Suite giao tiếp có 10 ca / 2450 kiểm tra;
suite đọc đích gốc có 8 ca / 186 kiểm tra. Cả hai không lỗi,
không skip. Các skip nội bộ của suite cũ được liệt kê trong JSON; không suite CTest
nào bị bỏ qua.

Lượt tập trung đầu tiên đạt 9/10, phát hiện nhãn có Unicode surrogate không hợp lệ
bị nhận rồi mất ký tự khi chuyển mã. Tái hiện độc lập chỉ đọc xác nhận lỗi, các file
thử không thay đổi. Bản r2 kiểm tra UTF-16 hợp lệ trước chuyển mã; thêm ca từ chối
surrogate cao/thấp/đảo thứ tự và giữ nguyên cặp Unicode hợp lệ. Log lỗi ban đầu
và hai checkpoint áp dụng đều được giữ lại.

Kiểm thử tiến trình thật bao phủ cả 11 thao tác, token/quyền sai, thay đổi thư viện,
dữ liệu Unicode, khung JSON sai, giới hạn byte, rollback và mất phản hồi sau COMMIT.
Cây thử độ sâu 32 với 16 asset đi qua đọc/xem/ghi; cây 2.000 asset hợp lệ ở owner
được từ chối đầy đủ khi phản hồi vượt giới hạn. Không trả cây bị cắt thiếu.
Các điểm gây lỗi chỉ nằm trong executable kiểm thử; đây không phải nghiệm thu
crash hệ điều hành hay giao dịch nguyên tử giữa nhiều store.

API/quyền/phục hồi chung cho vật lý đang được triển khai; chưa build hoặc nghiệm thu
API/UI cho phần này. Chưa đóng gói phát hành mới. Bằng chứng API 321/321 và UI 55/55
thuộc increment 21; browser thực vẫn chưa nghiệm thu. Mapping/import, nguồn thiết bị
thật và máy Windows sạch vẫn còn mở; toàn bộ MVP chưa hoàn tất.

[Phạm vi và bằng chứng](2026-10-20-physical-hierarchy-transport.md).

## STRUCT-01 increment 24 — kiểm tra Unicode ở ranh giới JSON native

Đã bổ sung kiểm tra UTF-16 sau giải mã cho mọi chuỗi và khóa JSON dùng chung,
đồng thời chuyển cổng proposal cũ sang parser này. Chuỗi surrogate sai bị từ chối
trước khi xử lý; cặp Unicode hợp lệ và ký tự gốc được giữ nguyên. Giới hạn byte,
độ sâu, khóa trùng và các quy tắc kiểm tra theo trường vẫn được giữ.

Build đạt; kiểm thử tập trung **12/12**, hồi quy native/Qt **34/34** đạt.
Các ca mới kiểm tra cả parser trực tiếp, xem trước/ghi phân cấp logic, proposal
và thao tác sao chép dự án; yêu cầu bị từ chối giữ nguyên dữ liệu thử.
Các skip nội bộ có điều kiện được ghi trong JSON; không suite CTest nào bị bỏ qua.

Đây là bước sửa dùng chung sau lỗi Unicode đã ghi ở increment 23. Không mở rộng
hồi tố bằng chứng cũ. API phân cấp vật lý đã áp dụng nhưng chưa được kiểm chứng
trong increment này; UI, browser thực, gói mới, thiết bị thật và Windows sạch còn
mở. Toàn bộ MVP chưa hoàn tất.


## STRUCT-01 increment 25 — API phân cấp vật lý

Đã tích hợp API cho 11 thao tác vật lý, quyền riêng theo dự án, xem trước rồi xác
nhận một lần, theo dõi job và phục hồi chung. Quyền logic hoặc quyền sao chép
không tự cấp quyền vật lý. Phản hồi vượt giới hạn bị từ chối đầy đủ.

Build API đạt; kiểm thử tập trung **124/124**, toàn bộ API **395/395** đạt,
không fail/skip/cancel/todo. Bốn ca HTTP dùng native thật kiểm tra ghi lô và đọc
lại, từ chối ghi khi thay tệp dự án trước dispatch, cách ly quyền, và phục hồi
sau khi ACK nhận về bị làm hỏng sau lúc tiến trình ghi kết thúc.

Python đạt **43/43** ca ở bốn suite launcher/marker. Hai lượt đầu đều có 3/6 ca
launcher thất bại ở bước khởi tạo PowerShell; ba suite sau chưa chạy. Thử riêng
lệnh khởi tạo chưa đủ xác minh toàn bộ chuỗi chạy. Hai log lỗi được giữ lại;
runner được sửa riêng rồi chạy lại. Các ca mong đợi từ chối ở hai lượt lỗi không
được dùng làm bằng chứng chính sách vì lỗi khởi tạo cũng có thể trả mã khác 0.
Bản sửa giữ danh sách biến môi trường cố định, xóa biến bằng giá trị null thực
và đặt RemoteSigned chỉ cho tiến trình kiểm thử; không đổi chính sách máy hoặc
mã sản phẩm.

API dùng bản native đã đạt 34/34 ở increment 24. Việc tái tạo broker được thử
trong cùng tiến trình; chưa chứng minh crash/restart hệ điều hành. UI vật lý đang
ở stage, chưa apply/build/nghiệm thu. Browser thực, đóng gói mới, mapping/import,
thiết bị thật và Windows sạch còn mở; toàn bộ MVP chưa hoàn tất.


## STRUCT-01 increment 26 — giao diện phân cấp vật lý

Đã nối editor vật lý vào Structure: 11 thao tác Site/Area/Environment và vị trí
Asset, hiển thị đầy đủ đường dẫn/quyền, bản nháp theo revision, xem trước rồi
xác nhận một lần. Quyền vật lý được phát hiện riêng; quyền logic hoặc thao tác
dự án không tự cấp quyền này. Vị trí chưa khai báo khác vị trí đã khai báo nhưng
các trường tùy chọn rỗng; Environment là quan hệ thành viên.

Khóa thao tác ghi vật lý được giữ cùng các khóa hiện có. Phản hồi muộn, review
hết hạn và ghi chưa rõ kết quả không tự gửi lại. Activity đọc phục hồi chung
của bốn họ thao tác, giữ các quan sát lặp của cùng dự án và kiểm tra toàn bộ
tập đích trước xác nhận. Xác nhận trạng thái hiện tại không đổi kết quả lịch sử
từ unknown thành confirmed.

Build TypeScript/Vite đạt. **52/52 kiểm thử tập trung và 81/81 kiểm thử UI đầy đủ**
đạt, không fail/skip/cancel/todo. Các ca kiểm tra DTO, bản nháp, quyền/đường dẫn,
giới hạn, vòng đời review/job, khóa ghi và render EN/VI. Đây là kiểm thử helper,
state và SSR; chưa chứng minh click, focus, bàn phím hay trình đọc màn hình
trên browser thật.

API đã được kiểm chứng riêng ở increment 25 (395/395 API, 43/43 Python).
Increment này chỉ sửa UI, không chạy lại native/API/Python và không tạo package
mới. Browser thật, mapping/import có review, Agent handoff, workload tích hợp
và đóng gói vẫn còn; thiết bị thật, người vận hành độc lập và Windows sạch thuộc
nghiệm thu sau build. **Toàn bộ MVP chưa hoàn tất.**


## STRUCT-01 increment 27 — owner mapping có duyệt

Đã thêm hợp đồng mapping và owner SQLite trong Impact: đăng ký nguồn theo quyền
cố định, nhập bản đầy đủ, xem diff nguồn/entity/evidence/assertion/mapping rồi
duyệt hoặc từ chối. Mapping chỉ liên kết các định danh native đã được cấp quyền;
không ghi topology hoặc memory. Alias và thế hệ được giữ để ngăn tái sử dụng
định danh; bản nhập đầy đủ bỏ một association sẽ tạo trạng thái retired.
Bằng chứng của mapping retired giữ đúng batch gốc qua nhiều phiên bản.

Owner kiểm tra đầy đủ dữ liệu trước/sau và quyền nguồn, bằng chứng, entity cùng
native ancestry. Cho phép đọc Internal không cho phép đổi nhãn Internal thành
Public. Quyền được kiểm tra lại sau chờ observer; timeout rollback và bỏ kết quả
trả muộn. Biên nhận xác nhận được lưu cùng giao dịch; gửi lại yêu cầu đã xác nhận
đọc biên nhận cũ. COMMIT không rõ kết quả trả unknown, không tự gửi lại.

Nâng LMIP từ format 2 lên 3 là thao tác riêng, có backup VACUUM được đối chiếu,
kể cả dữ liệu đã commit chỉ nằm trong WAL. Khởi tạo vẫn dùng format 2; đọc cũ và
luồng import/report/review không thuộc nguồn mapping giữ tương thích.

Build cuối đạt; **54/54 ca mapping tập trung và 100/100 ca toàn bộ Impact** đạt,
không fail/pending/todo. Có kiểm thử SQLite thật cho transaction, rollback,
COMMIT contention, replay, quyền, schema/triggers và migration. Observer nguồn
và native trong các ca này là fixture có kiểm soát, chưa phải adapter thiết bị.

Lịch sử lỗi được giữ: build đầu thiếu một trường kiểu evidence, đã sửa khai báo;
focused r2 đạt 48/50 do fixture WAL chưa giữ read transaction và một nhóm test
vượt 5 giây. R3 đạt 52/53 sau sửa WAL, còn nhóm biên 2.000/2.001 dòng xử lý lặp.
Test được tách và đóng khung payload độc lập để mỗi ca xác thực một lần; r4 đạt
54/54. Không tăng timeout, đổi giới hạn sản phẩm hay bỏ assertion. Các lượt này
không phải benchmark hiệu năng và không chứng minh khôi phục sau crash hệ điều hành.

Increment này chỉ build/test gói Impact và các project reference hiện có, không
chạy lại native/API/UI/Python, không tạo release package hay migrate dữ liệu
người dùng. Bước tiếp theo là đọc mapping đã duyệt với kiểm tra nguồn/native
hiện tại, rồi nối Agent knowledge và giao diện review/handoff. Browser thực,
đóng gói/workload tích hợp, thiết bị thật, người vận hành độc lập và Windows sạch
vẫn còn mở. **Toàn bộ MVP chưa hoàn tất.**


## STRUCT-01 increment 28 — cổng đọc mapping native

Đã thêm cổng `mapping-observation` chỉ đọc. Đường dẫn kho, Project, UUID, Site,
Environment và quyền local/external do launcher cố định; request chỉ chọn các
đối tượng cần đọc. Schema, Project và UUID được kiểm tra trước nội dung; đồ thị
và registry được lấy từ cùng một snapshot SQLite. Kết quả giữ đủ tập yêu cầu,
không trả nhãn, đường dẫn, nội dung nguồn hoặc registry thô.

Quyền được tính theo toàn bộ quan hệ liên quan: repository/subsystem cho
Component và Knowledge; Site/Area/Environment/thiết bị cha cho Asset. Asset
phải có Environment khai báo khớp phạm vi; role chưa khai báo vẫn là null.
Đối tượng không tồn tại, retired, bị ẩn hoặc ngoài phạm vi đều từ chối cả lượt
đọc bằng cùng một khung lỗi. Danh sách rỗng vẫn kiểm tra quyền Project.

Fingerprint quan hệ giữ cả đường dẫn tổ tiên và phân loại quyền; fingerprint
repository/knowledge tương thích cổng native v3 hiện có. Cổng giới hạn 4.000
đối tượng và 4 MiB cho request/phản hồi hoàn chỉnh, kiểm tra JSON UTF-8/scalar,
khóa trùng, EOF và một LF kết thúc.

Build đạt; **10/10 suite tập trung và 35/35 suite native/Qt đầy đủ** đạt.
Bộ test mới gồm tám nhóm, có SQLite/WAL thật, ghi đồng thời tại điểm kiểm soát,
kiểm tra giữ/nhả khóa đường dẫn, đối chiếu fingerprint độc lập và gọi CLI thật.
Cả hai lượt đều có 20.337 kiểm tra mới đạt, phản hồi đủ 4.000 dòng là 1.440.165
byte. Suite mới bỏ qua một ca do môi trường không tạo được symlink
(unavailable/denied); toàn bộ suite có năm skip nội bộ có điều kiện, được giữ
trong JSON. Không suite CTest nào bị bỏ
qua. Build và hai lượt test đều đạt ngay ở lần chạy đầu, không cần sửa nguồn.

Lease bảo vệ namespace trong lượt gọi này; không chứng minh inode của lượt gọi
cũ, không chặn ghi tại chỗ hay tạo giao dịch nguyên tử với Impact. SQLite chỉ
phối hợp qua SHM đã tồn tại; test đối chiếu main/WAL và danh sách file, không
khẳng định từng byte SHM bất biến. Đây là Windows hiện tại, chưa là nghiệm thu
trên máy Windows sạch hoặc thử crash hệ điều hành.

Bước tiếp theo là reader mapping đã duyệt kiểm tra trạng thái hiện tại, nối
transport cố định và Python knowledge, rồi handoff có review và gói/workload
tích hợp. Increment này chưa nối API/UI/Agent hay thiết bị thật và chưa tạo
package mới. Browser thực, người nghiệm thu độc lập và máy Windows sạch còn
mở. **Toàn bộ MVP chưa hoàn tất.**


## STRUCT-01 increment 29 — đọc mapping đã duyệt theo trạng thái hiện tại

Đã thêm reader chỉ đọc trong gói Impact và hai factory nguồn/native cố định.
Reader giữ quyền, store UUID và nguồn gốc file ban đầu; lấy snapshot LMIP đã
duyệt, kiểm tra nguồn/native hai lần và đối chiếu lại snapshot trước khi trả dữ
liệu đầy đủ. Quyền hiện tại, current head, thời hạn của cả nguồn đã duyệt lẫn
current head, evidence và endpoint assertion từ nguồn khác đều có thể làm
reader từ chối toàn bộ kết quả; không trả một phần Public.

Nguồn hiện tại hỗ trợ manifest và code với tập file được cấp quyền cố định.
Native-as-source vẫn trả UNSUPPORTED_MAPPING trước I/O. Native target được đọc
qua owner của increment 28, không đọc SQLite native trực tiếp từ TS. Mode local
bị từ chối trước spawn nếu grant không cho Internal. Revision/ancestry hiện tại
có thể đổi sau khi duyệt; không giả vờ rằng fingerprint native lúc stage là
quan sát hiện tại. Repository/knowledge reference vẫn là giá trị opaque, không
được mở theo đường dẫn hoặc tải từ mạng.

Reader không ghi hoặc tự duyệt mapping, migrate store, retry native child hay
thay kết quả lịch sử. Khi hủy/timeout, một worker chưa kết thúc vẫn giữ BUSY;
native child được giữ đến close. Đây là cơ chế vòng đời đã kiểm thử trong phạm
vi fixture, không phải bảo đảm chống mọi cuộc đua từ tiến trình cùng người dùng.

Build CLI cùng project references đạt. **79/79 ca tập trung và
278/278 ca toàn bộ Impact/CLI trong 19 file** đạt, không
fail/pending/todo. Trong 79 ca mới: 20 dùng LMIP thật với observer có kiểm soát,
55 kiểm tra adapter/file (child native ở suite adapter được mô phỏng), và bốn
ca chạy native28 thật cùng LMIP, manifest cố định và thao tác native có duyệt.
Bốn ca thực kiểm tra đọc không đổi bytes, thay UUID cùng đường dẫn, revision
và privacy ancestry mới, manifest drift/duyệt lại và retirement.

Giới hạn byte được kiểm tra bằng payload lưu trữ riêng được tăng JSON whitespace
quá 4 MiB và bị chặn trước observer; đây không phải kiểm chứng biên envelope lớn
nhất của mọi kết quả đã duyệt hợp lệ. Adapter native nhận 4.000 targets và từ
chối 4.001; adapter nguồn nhận hai fixture riêng có 5.000 evidence và 5.000
assertion trong giới hạn 4 MiB. Đây là các ca chấp nhận cụ thể, không phải bằng
chứng về mọi tổ hợp tối đa hoặc biên từ chối 5.001. Không cắt ngắn dữ liệu để
vừa frame. Full initial giữ nguyên kết quả 267/278: 11 fixture publish cũ thất bại
do PATH kiểm thử thiếu Git (`spawnSync git ENOENT`), còn 79 ca mới đều đạt.
Full-only r2 bổ sung đúng Git đã pin và config Git global rỗng/no-system,
không đổi source/test, build lại hoặc chạy lại focused. Một sửa nhỏ AbortSignal
cleanup được review trước lần apply đầu và giữ riêng trong provenance.

Runtime bảy file chỉ phục vụ kiểm thử local, lấy executable từ native28 và
Qt/config/plugin đã xác minh; không tạo package phát hành mới. Chưa nghiệm thu
đường phục vụ Agent/generated integration, Python, API/UI, thiết bị thật,
người vận hành độc lập hoặc Windows sạch cho chặng này. Những đường cũ được
kiểm tra hồi quy trong phạm vi Impact/CLI; không đồng nghĩa các tích hợp mới đã
được bật. **Toàn bộ MVP chưa hoàn tất.**



## STRUCT-01 increment 30 — mapping đã duyệt trong ngữ cảnh Agent

Đã nối reader accepted-current của increment 29 vào generated Agent bằng
`lmti.agent.integration.v3`, chế độ `reviewed`. Mỗi cấu hình gắn với một nguồn
Impact đã đăng ký, hỗ trợ manifest hoặc code với tập file được cấp quyền cố định.
Entry riêng chỉ đọc `accepted-mappings`; Agent không được stage, accept, migrate
hay ghi native. Python không đọc SQLite Impact/native trực tiếp. Mapping
pending/rejected không thay head đã chấp nhận. Native-as-source v3 vẫn chưa hỗ trợ.

Cấu hình ghim grant, project/site/environment, UUID store, nguồn gốc file và hash
của executable/bundle/config. Thay đổi bị phát hiện sẽ thu hồi quyền tương ứng
trong phiên; khôi phục bytes không tự hồi sinh quyền. Lượt ghép đối chiếu mapping
trước/sau, knowledge trước/sau và native đầu/cuối. Nó chỉ dùng target nằm trong
neighborhood native được phép đọc. Selection trùng được nhóm, nhưng giữ đủ
contributor và không hạ classification. Association biểu thị liên kết đã duyệt,
không chứng minh sức khỏe thiết bị hoặc việc thực thi ngoài hệ thống.

Phản hồi chỉ thêm association, metadata review và evidence ID opaque; không xuất
store UUID, đường dẫn riêng, selection, external key/alias hay body/locator
evidence thô. Năm tên tool vẫn giữ nguyên. Chỉ phiên reviewed mở thêm
`limit`/`cursor` cho `lmti_task_context`; cursor gắn phiên, truy vấn và bằng chứng
hiện tại. Default bốn tool và manual v1/v2 năm tool được kiểm tra bằng phiên
generated thực tế.

Giới hạn vẫn là đầy đủ hoặc từ chối: request mapping 4 KiB, config 128 KiB,
phản hồi mapping gồm LF 4 MiB và envelope Agent 512 KiB. Tối đa 100 selection đủ
điều kiện, đếm trước nhóm trùng/phân trang; tối đa một memory mapping với disclosure
tường minh. Trang 1–200 association/context item kiểm tra lại toàn bộ nguồn;
không cắt nội dung để vừa frame. Lỗi riêng phần reviewed có thể trả native-only
partial khi native và quyền hiện tại còn hợp lệ; không gắn lại proof reviewed cũ.

Ngân sách 240 giây bao trùm cả lượt ghép. Deadline hết không chứng minh child đã
đóng: worker còn sống tiếp tục giữ BUSY đến close/drain, kể cả khi API wait lỗi.
Đây là kiểm tra phối hợp giữa các owner local, không phải giao dịch nguyên tử
xuyên Impact/native/code, lease chống mọi thay đổi filesystem hay bảo đảm đóng
toàn cây tiến trình khi hệ điều hành kết thúc Agent.

### Kết quả chạy thực tế

| Hạng mục | Kết quả cuối và phạm vi |
|---|---|
| Native/Qt | Build đạt; 35/35 suite CTest đạt. Năm kiểm tra symlink nội bộ skip có điều kiện do môi trường không tạo được link: copy discovery 2, upgrade recovery 1, original binding 1, mapping observation 1. Không suite CTest nào bị skip. |
| TypeScript | Build CLI cùng project references đạt; 308/308 test Impact/CLI trong 20 file đạt, không fail/pending. |
| Python | Unit-r3: 184/184 test trong 11 file đạt, không fail/error/skip; gồm decoder, revocation, lifecycle có điều khiển và hồi quy cũ. |
| Generated MCP | Process-r3: 4/4 ca đạt, không skip, child của harness đã đóng. Dùng argv `-I` do native sinh, native/LMIP thật và knowledge bundle thực trong package-r2. |
| Web/package | API build, UI typecheck/build đạt; doctor-r2 4/4 test đạt. Đây không phải lượt chạy lại toàn bộ API/UI hoặc thao tác browser. |

Bốn ca process kiểm tra accepted mapping và loại pending/rejected, nhóm selection
trùng, không lộ trường riêng; manifest drift rồi operator accept head mới trong
cùng phiên; các trang/cursor đổi hoặc khác phiên; config revocation và tương thích
default/v1/v2 manual. Chuỗi thực dùng nguồn manifest và nội dung code đã compile;
không suy rộng thành kiểm chứng mọi nguồn code/memory, client MCP bên thứ ba hoặc
mọi tổ hợp giới hạn tối đa.

Giữ nguyên ba lần thất bại và sửa tương ứng. Unit-initial có 180/181 đạt: v2 bị
thêm keyword `retain_until_closed=False`, làm đổi call shape cũ; sửa chỉ truyền
`True` cho v3, unit-r2 đạt 181/181. Process-initial thất bại cả bốn trước MCP vì
fixture so đường dẫn Windows bằng raw separator; sửa kiểm tra canonical path và
samefile, giữ nguyên argv/hash. Process-r2 tiếp tục thất bại cả bốn lúc khởi tạo:
`FilePin` so `ctime` path/handle như cùng một giá trị. Chẩn đoán Python 3.14 trên
Windows hiện tại cho thấy Node đã cài và native được copy có hai `ctime` khác
nhau, còn identity/size/mtime/birthtime/link count khớp. Bản sửa giữ hai chữ ký
riêng, vẫn kiểm tra thay đổi trong từng API và SHA-256; thêm ba test, gồm đọc
Node đã cài. Unit-r3 và process-r3 đạt sau sửa. Không xóa log thất bại hoặc gán
thành công mới cho package cũ.

Package được kiểm chứng là `studio-web-mapping-composition-20261020-r2`, manifest
SHA-256 `ce0a08de743168d2d14da842b2c1c866a0449d3d719ab057bed86576b3700aed`.
Nó chứa native hiện tại, Python đã sửa và hai bundle knowledge/mapping; package
ban đầu được giữ nguyên làm bằng chứng lịch sử. Đã xuất ZIP `LMTI_Build_Mapping_Da_Duyet_2026-10-20.zip`: 145 file (144 file được manifest liệt kê và manifest), 16.153.094 byte,
SHA-256 `545fa3d261c3b5d19f453c757182723e659eddd34a5a1ff091957a5fcf76a122`. Đã đọc lại và đối chiếu hash từng file trong ZIP;
24 cache SDK Python sinh khi kiểm thử được loại khỏi ZIP. Hash local là bằng chứng
đối chiếu, không phải chữ ký của nhà phát hành. Tài liệu tiến độ này được cập nhật
sau đóng gói; tài liệu trong ZIP giữ đúng snapshot khi build.

Ưu tiên tiếp tục foundation/build có kiểm soát theo lựa chọn của người dùng.
Handoff proposal schema-2, operator inbox và receipt native bền vững để đối chiếu
lost ACK vẫn còn mở; đường đọc reviewed vừa kiểm chứng không hoàn thành đường ghi.
Browser workflow, client MCP bên thứ ba với timeout riêng, provider/thiết bị thật,
crash hệ điều hành, người vận hành độc lập và Windows sạch là các bước nghiệm thu
sau. Không yêu cầu live pilot để tiếp tục phần nền tảng này.
**Toàn bộ MVP chưa hoàn tất.**


## Bổ sung 31 — Nền tảng ghi Desired Asset và biên nhận native

Phần native đã có đường ghi giới hạn cho hai giá trị cấu hình mong muốn của
Asset: `enabled` và `pollMs`. Một giao dịch cập nhật đúng Asset, tăng revision
một lần và lưu biên nhận của thao tác. Đây là cấu hình mong muốn trong dự án;
chưa phải lệnh điều khiển hay trạng thái đo từ thiết bị.

Định dạng LMPR3 được nâng cấp tường minh từ LMPR2. Trước nâng cấp, owner tạo
bản sao dữ liệu có kiểu từ một snapshot được giữ ổn định, gồm các thay đổi đã
commit còn nằm trong WAL, rồi kiểm tra độc lập bản sao. Store UUID, revision,
đồ thị và registry được giữ nguyên. Đọc thông thường không tự nâng cấp.

Quyền ghi riêng, Site/Environment cố định, privacy kế thừa và identity của file
gốc được kiểm tra trước khi tiết lộ xung đột giá trị hoặc revision. Việc tìm lại
biên nhận dùng đúng thao tác và phạm vi cũ, kể cả sau lần lưu thông thường kế
tiếp; file sao chép có cùng UUID không được nhận biên nhận của file gốc.
Đối với nguồn external, lịch sử chỉ được trả khi target và tổ tiên vẫn đủ
điều kiện công khai. Biên nhận vắng mặt không chứng minh chưa từng commit và
không tự cho phép gửi lại lệnh.

CLI riêng có bốn entry cố định cho xem trước/ghi/tìm biên nhận và bảo trì
định dạng. Input giới hạn 64 KiB, độ sâu 16 và phải kết thúc thật; output gồm
newline giới hạn 128 KiB. Không thêm tool MCP ghi hay lệnh shell tùy ý.

| Kiểm chứng | Kết quả |
|---|---|
| Build native Release | Đạt sau hai sửa đổi chỉ trong bộ test. |
| Domain | 11/11 tình huống, 245 kiểm tra hành vi, không bỏ qua. |
| SQLite/biên nhận/nâng cấp | 10/10 tình huống, 174 kiểm tra hành vi, không bỏ qua. |
| CLI bằng tiến trình thật | 8/8 tình huống, 262 kiểm tra hành vi, không bỏ qua. |
| Hồi quy native/Qt | 38/38 suite CTest đạt; không suite nào bị skip. Năm kiểm tra symlink nội bộ bỏ qua có điều kiện do môi trường hiện tại. |

Log thất bại được giữ nguyên. Lượt build đầu phát hiện tên enum sai trong test,
được sửa thành `Committed`. Lượt test trọng tâm đầu đạt hai suite rồi process
fixture crash: hai biến giữ `QJsonValueRef` trỏ vào object tạm đã bị hủy. Sửa
sang giá trị JSON sở hữu độc lập bằng `.value("receipt")`; lần chạy lại đạt cả
ba suite. Hai sửa đổi này không thay đổi mã production hay giảm assertion.

Các ca mới bao gồm rollback trước commit, lỗi được chèn sau COMMIT trong owner
test riêng, mất stdout thực rồi tiến trình mới tra lại/replay, backup live WAL,
snapshot cũ, scope/privacy, file bị thay thế, ledger/schema sai, giữ lịch sử khi
lưu thường và từ chối các API cũ chỉ nhận schema2. Mốc 4.096 biên nhận được
kiểm tra bằng các hàng fixture tổng hợp hợp lệ, không phải 4.096 lần commit thật.
Fault hook không chứng minh độ bền trước mất điện hoặc crash hệ điều hành.

Bản sao lưu được xác minh bằng file thường ở vị trí cố định và hash nội dung.
Định dạng hiện tại không lưu lịch sử inode của backup; một file thay thế có
nội dung hoàn toàn giống vẫn có thể được xác minh. Các trường hợp không rõ sau
đặt chỗ backup giữ operation ID và artifact để đối chiếu.

Tài liệu hợp đồng gốc đã được phục hồi và đối chiếu đúng SHA-256 đã chốt; bản
làm rõ hai đoạn về backup vắng mặt và vị trí fault hook cũng được giữ riêng.
Các ghi nhận tạm thời trước lúc phục hồi còn nguyên trong lịch sử bằng chứng.

Bước tiếp theo là đường đọc mapping dành riêng cho LMPR3, kiểm tra kết hợp
native/TypeScript/Python và phiên generated năm tool với nguồn mới được duyệt.
Binary/config của nguồn đã đăng ký có fingerprint bất biến; nâng binary cần
nguồn mới và association được duyệt lại. Không tự sửa quyền đăng ký cũ.

Handoff proposal qua LMIP, inbox/operator, nối UI và recovery toàn luồng còn
tiếp tục. ZIP của bổ sung 30 giữ nguyên, không chứa bổ sung 31. Chưa có nghiệm
thu browser, client MCP bên thứ ba, thiết bị thật, máy Windows sạch hoặc người
vận hành độc lập từ lượt này. **Toàn bộ MVP chưa hoàn tất.**

Trước khi push repository, kiểm tra `.gitignore` đã loại `.env`, token và cấu
hình riêng chứa thông tin nhạy cảm. Lượt này không push hoặc cài thêm thư viện.


# Cổng đọc mapping cho LMPR schema3 — 21/10/2026

Increment32 nối LMPR3 có biên nhận với luồng đọc mapping đã duyệt. Lệnh
`mapping-observation-v2` chỉ nhận schema3 thật; giao thức cũ vẫn nhận schema2.
TS/Python kiểm tra phiên bản khớp cấu hình, giữ nguyên vector hash schema2.
Không tự nâng cấp hoặc fallback.

Phiên process thực tế dùng project tổng hợp, nâng cấp và ghi desired qua CLI
riêng, rồi đăng ký **source ID mới cùng association mới được duyệt**. Lịch sử
cũ được giữ lại và tái dùng source ID cũ bị từ chối. Năm công cụ MCP vẫn chỉ
đọc, kiểm tra revision/mapping mới, từ chối cursor cũ và giữ kín nội dung khi
privacy của Asset, Site hoặc nguồn thay đổi.

DTO Asset công khai không thêm `enabled`/`pollMs`. Các giá trị này được đối
chiếu riêng bằng biên nhận; ledger, token ghi, đường dẫn và backup không được
đưa ra MCP.

| Kiểm chứng thực tế | Kết quả |
| --- | --- |
| Native Release / CTest | Build PASS; focused 5/5; full 38/38 |
| Mapping observation | 12 case, 36.560 kiểm tra, 0 lỗi |
| TS Impact + CLI | 323/323 test, 20 file |
| Python unit / process đóng đủ | 189/189 / 8/8 |
| API + UI build / doctor package | 3 lệnh build PASS / 4/4 |

Full native có 5 nhánh symlink bỏ qua do host; không có suite CTest bị skip.
Các nhóm TS/Python/doctor không có fail, skip hay todo. Số liệu lấy từ receipt
và raw report đã chốt.

Bản ZIP mới chỉ chứa file được manifest liệt kê cùng `manifest.json`, không có
cache hay dữ liệu fixture. ZIP/bằng chứng increment30 và bằng chứng increment31
được giữ nguyên; increment31 không có ZIP riêng. Gói: [LMTI_Build_Cong_Schema3_2026-10-21.zip](C:/example-user/Documents/Codex/2026-10-19/b-n/outputs/LMTI_Build_Cong_Schema3_2026-10-21.zip); SHA256 `0ee305348e0e01fbaa9224b4cf1a5c6fc11be8c9acfd56e0f3f03a6d0d01a4a1`.

Giới hạn: kiểm tra cục bộ trên Windows hiện tại; ghi/replay chỉ trong API riêng
và fixture được kiểm soát. Không có thiết bị thật, thử mất điện, browser,
Windows sạch hay nghiệm thu operator độc lập.

Các gate còn mở:

- Proposal → operator → LMIP handoff/finalization.
- Xoay authority cho nguồn đang được sử dụng.
- Schema3 đầy đủ cho copy, hierarchy và web recovery.

Chưa tuyên bố hoàn thành toàn bộ MVP.

Bằng chứng chi tiết: [LMTI_Kiem_chung_Cong_Schema3_2026-10-21.json](C:/example-user/Documents/Codex/2026-10-19/b-n/outputs/LMTI_Kiem_chung_Cong_Schema3_2026-10-21.json).
