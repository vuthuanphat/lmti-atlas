# Reproducible native Agent structure baseline

Date: 2026-10-19. Status: **measurement tool and actual-repository bridge-r2 small rehearsal verified;
historical 1k/10k measurements remain baseline evidence, not acceptance**.

`scripts/agent-scale-baseline.py` generalizes the earlier workspace-only probe.
It measures the package's real `NativeProjectSource` and Python Agent `Client`
against new, disposable synthetic native databases. It does not inspect an
existing project, discover source folders, connect a provider or exercise device
operations.

## Run from a trusted checkout

Use a trusted Python 3.11+ interpreter in isolated mode. The current native
package is Windows x64 and still requires its compatible runtime. No dependency
installation is performed by the tool.

First run the small rehearsal:

```powershell
python -I -B scripts/agent-scale-baseline.py --package build/studio-web-mcp-bridge-20261019-r2 --assets 10 --samples 2 --warmups 0 --page-size 5 --output build/agent-scale-smoke
```

For the original workload shape, omit the optional settings:

```powershell
python -I -B scripts/agent-scale-baseline.py --package build/studio-web-mcp-bridge-20261019-r2
```

The second command selects 1,000 and 10,000 assets, two warmups and ten measured
samples per query, with a page size of 50. A fresh `build/agent-scale-<random-id>`
directory is created and its relative name is printed. Full pagination is
verified outside query timing. Large runs can take several minutes; the tool
checks a one-hour overall budget between bounded owner operations.

Both `--package` and optional `--output` accept only a repository-relative
`build/<single-directory-name>` using `/` separators. The script derives the
repository root from its own location; the current working directory does not
select a different checkout. Output must not exist. Use another output name
for another run: there is no overwrite, reuse, deletion or cleanup mode.

| Option | Accepted values |
| --- | --- |
| `--assets` | One to eight distinct integer counts, each 10–10,000 |
| `--samples` | 2–100 measured samples per operation |
| `--warmups` | 0–5 untimed warmups per operation |
| `--page-size` | 1–200 entities |

The tool requires `-I` to avoid user site and `PYTHONPATH` injection. It disables
bytecode writes and selects a fresh unused cache prefix before loading package
Python, so a preexisting package `.pyc` is not used as executable evidence.

## Protocol and provenance

`protocol.json` is written exclusively and flushed **before fixture creation or
measurement**. It records parameters, fixed scope, query shapes, warmups,
percentile method, owner limits, fixture shape and exclusions. Its SHA-256 is
bound into the report. The three measured queries are:

1. First context page.
2. Direct lookup of the last added synthetic asset.
3. Declared related entities for that asset, depth two.

Each Agent query performs its normal two native owner reads, including parsing,
policy validation and source rechecking. Timing ends when the SDK call returns;
payload serialization, setup, hashing and full-pagination verification are
outside that interval. Median and p95 use raw `perf_counter` samples, with p95
calculated by nearest rank.

The tool verifies the package manifest and hashes every listed file before
importing package Python. A bounded parent-first walk rejects all unlisted
package files, including native DLLs, except inert Python cache files in the
known SDK cache directories. It rejects unlisted Python source/native extension
files case-insensitively before imports and checks loaded module paths and hashes. The
native binary, runner script, Python executable, package manifest, declared
package files, loaded Python modules and constructed database all have recorded
hashes. Package files and the frozen protocol are rechecked after measurements.
The report records package-relative names, not local absolute source paths.

The fixture begins with native `init-demo`. Only construction then uses SQLite
parameterized inserts into that newly created database. Queries and pagination
always go through the selected package's native/Python owners. Assets added by
the benchmark have **no new relationships**. The fixture retains the small demo
graph; it is not a representative high-density dependency workload.

After every workload the complete native database hash is compared to the
pre-read hash. Pagination checks duplicate identities, counts all assets and
stops at an explicit page budget. Native subprocesses use fixed argument lists,
`shell=False`, output limits and deadlines through the existing packaged
`lmti_common.process.read_owner` helper.

## Output and failure behavior

- `protocol.json`: frozen protocol, schema `lmti.agent.scale-protocol.v2`.
- `workload-<count>.json`: append-only completed/failed workload record, raw
  latency samples, payload maximum, fixture hashes and pagination outcome.
- `report.json`: final provenance, machine context, workload results and generic
  failure code, schema `lmti.agent.scale-baseline.v2`.
- `synthetic-<count>.sqlite`: the disposable nonsecret fixture, retained for
  inspection; it is never selected from an existing project.

Runtime failures and interruption persist a final report when the new output
directory remains available. Invalid arguments, unsafe paths or a preexisting
output fail before a run is created. Diagnostic messages use fixed codes and
never echo child output, exception paths or an environment dump. There is no
destructive cleanup after success or failure.

UNC/device namespaces, alternate data streams, control characters, traversal,
reserved Windows names, and symlink/junction/reparse parents are rejected before
opening descendant paths. Parents are inspected from the volume downwards.
Manifest hashes establish consistency with the selected package, not publisher
identity. Select only a trusted package; the tool is not an OS sandbox against
another process running as the same user.

Machine context includes Python/OS/architecture, CPU model if available, logical
core count and installed physical RAM using the standard library. Unavailable
values remain null. No hostname, username, serial, IP address or environment
dump is collected. Installed RAM is **not** measured process RAM; CPU utilization,
process memory peaks, storage throughput and concurrent-reader behavior are not
measured.

## Evidence and relationship to existing checks

A workspace-only rehearsal ran the same runner against the r3 package with ten
assets, zero warmups, two samples and page size five. It read 16 total entities
across four pages; all three query shapes completed, native database and package
hashes stayed unchanged, and 12 loaded Python modules were verified. Eight focused
boundary checks covered lexical no-I/O rejection, parent-first reparse handling,
build-child scope, numeric limits, no overwrite, persisted generic failure,
unlisted native files and uppercase unlisted Python source before execution.
The harness redirected only its fresh output to the workspace; the shipped CLI
continues to require a fresh repository `build/` child.

The applied repository script was subsequently run directly, without output
redirection, against `build/studio-web-mcp-bridge-20261019-r2`: ten assets, two
samples, zero warmups, page size five. All queries completed, 16 entities across
four pages, DB/package hashes unchanged. It retains `acceptanceThresholds: null`
and `acceptancePassed: false`.

Exact evidence: `build/agent-scale-bridge-smoke-20261019/protocol.json` and
`build/agent-scale-bridge-smoke-20261019/report.json`. Package manifest SHA-256:
`2960c73da1fb3394a6eca2882325c88b236885d2de8b3272b23b27d5cfcf3531`.
Doctor 105 files/API 28/28/Qt/IPC and actual Codex reads separately passed on the
same package. They do not make this small rehearsal representative acceptance.

The prior 2026-10-19 results remain unchanged:

| Assets | First-page p95 | Last lookup p95 | Last related p95 | Complete pagination |
| --- | --- | --- | --- | --- |
| 1,000 | 550.51 ms | 493.98 ms | 459.92 ms | 1,006 entities / 21 pages |
| 10,000 | 3,822.86 ms | 3,415.03 ms | 3,429.53 ms | 10,006 entities / 201 pages |

Those results came from the earlier one-off protocol, not from a new full run of
this script. Historical CPU/RAM or raw samples are not retroactively invented.
The new v2 report adds explicit provenance, raw samples and modest machine
context for future runs. See the [integrated MVP evidence](../plans/2026-10-19-integrated-mvp.md).

Existing `scripts/web-local-baseline.mjs` measures a different layer: many
registered projects through the authenticated web broker, startup and metadata
projection. It remains unchanged. The new script reuses native demo generation,
packaged SDK validation, bounded owner process reading, and the prior Agent
query protocol; it does not introduce another owner transport or web benchmark.

Every report retains `acceptanceThresholds: null` and `acceptancePassed: false`.
Successful execution means the stated measurements completed with their
invariants. Agree on a representative graph, concurrency, latency/resource and
benefit thresholds **before** optimization or acceptance reruns. This baseline
does not close live IoT, real client, clean Windows, second-operator or value
acceptance gates. Keep generated fixtures out of publication; check `.gitignore`
and use `lmti publish preflight` before publishing source or artifacts.
