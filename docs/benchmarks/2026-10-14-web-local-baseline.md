# WEB-03 local baseline and metadata projection

Date: 2026-10-14, Asia/Bangkok. This is a synthetic engineering baseline,
not pilot, user-time, clean-Windows or release acceptance. The master plan and
WEB-03 gates remain unchanged.

## Protocol locked before measurement

[`web03-workload.v1.json`](web03-workload.v1.json) fixes 500 registered projects,
50 pinned dense projects, page size 50, three warmups then 30 serial samples per
operation. Each dense document has 100 components, 100 releases, 200 declared
assets, 500 bindings and 500 work items. Remaining projects have one declared
asset. Every profile has two definitions; neither provider network nor actual
client/model execution is involved. SQLite files are produced and round-tripped
by typed C++ owners; JSON describes the protocol/fixture/report boundaries only.

The protocol SHA is recorded before construction and before each run. The before
and after runs used the same fixture and protocol hash. Ten discovery pages
enumerated all 500 unique IDs. All **502** native document/index/profile file
hashes remained unchanged after each read-only run. The workload is below native
per-document maxima; it does not establish unlimited scale or real device state.

## Finding and resulting change

The first dense page exposed a real cost: native `summaries` loaded and validated
each complete graph merely to return project name/revision. The private operator
façade now calls typed `load_project_metadata` in the existing C++ SQLite owner.
It retains read-only/query-only access, application/version checks, trigger/view
rejection, required table/column resolution, one bounded typed metadata row,
revision bounds, UTF-8/secret-like text/classification validation and the same
library identity/root checks. There is no cache, new schema or Node SQL access.

Metadata validates its projection and supported container shape; **it does not
certify graph health**. Context, snapshots, profile reads/generation and mutations
continue to load and validate the full document. Tests intentionally corrupt a
graph row: metadata remains independently readable while the full reader rejects
it. Invalid metadata revision/type/text/privacy, missing tables, unknown versions
and view-bearing containers are rejected without modifying source bytes.

## Measured results

All times below are p95 in milliseconds, nearest-rank sample 29 of 30.

| Operation | Before | After |
| --- | ---: | ---: |
| Dense first page, 50 projects | 5,609.8 | 264.0 |
| One dense project summary | 216.9 | 82.2 |
| Dense profile read | 190.5 | 195.3 |
| Codex configuration status | 570.2 | 599.7 |
| Codex export | 290.9 | 203.5 |
| Cursor export | 247.6 | 199.6 |
| Direct native full read | 174.5 | 193.6 |
| Direct native generation | 187.8 | 181.6 |

The targeted page projection is about **21 times faster in these runs**. Other
operation differences do not establish improvement/regression: process startup,
OS caching, GC/background load and machine variability were not isolated. No
acceptance threshold or business benefit was retroactively declared passed.

After-run startup measurements: publisher `-NoBrowser` launcher first ready line
1,163.8 ms; API process spawn to ready 109.9 ms; authenticated bootstrap 10.1 ms;
first dense page 239.8 ms. These are single fresh-process observations, not a p95
startup distribution, OS cold-cache guarantee or browser first-paint measurement.
Node RSS after samples was approximately 62.8 MiB; browser and transient C++/Python
processes are excluded. Export timings are generation, not human/client setup.

The original before-run launcher timing was mislabelled: synchronous capture
waited about 30 seconds for an inherited output pipe to close. It is retained
as raw historical data and **excluded** from startup comparisons. The runner now
times receipt of the first ready JSON line. An earlier 180-second test-host bound
also ended a partial run during the slow workload; that run was not counted as a
complete baseline. The bounded benchmark host now allows ten minutes.

## Artifacts and package

- Before/after reports: `build/web03-bench-PfrjPt/baseline-before.json` and
  `baseline-after.json`; comparison/validity notes: `build/web03-baseline-comparison.json`.
- Logs: `build/web03-baseline-before.log`, `build/web03-baseline-after.log`.
- New package: `build/studio-web03-projection-20261014`; fresh native install:
  `build/studio-projection-native-20261014`. Old packages are preserved.
- Native/Qt **8/8 CTest** passed, including metadata corruption/projection checks:
  `build/web03-projection-native-tests.log`.
- API/package **13/13**, no skips, tested against the new native package:
  `build/web03-projection-api-tests.log`.
- Qt/API interoperability passed and six diagnostic reruns passed:
  `build/web03-projection-interop.log`, `build/web03-projection-repeat-1.log`–`-6.log`.

One early interoperability attempt reported an invalid synthetic response during
project switching. Diagnostics and early promise-rejection handling were improved;
the precise cause remains unproven. These retries do not certify absence of an
intermittent problem and do not replace an independent operator trial.

The new package has **94** manifest files; runtime Python caches are excluded from
the native installation. Doctor tests compare every manifest entry and required
components, not an arbitrary minimum file count. Source web launchers select the
new opt-in package; Qt fallback and the existing default native workflow remain.
No test producer/controller, offscreen plugin or benchmark host is shipped.
The measured manifest identifies the package before the final launcher/guide
refresh. `build/web03-projection-final-evidence.json` records both manifest hashes
and the matching compiled native admin hash; the optimized native binaries and
measured workload were preserved. No background test API host remained afterward.

## Reproduce

With the existing trusted Qt/CMake toolchain, build `lmti-web-benchmark-fixture`
in the local test build, then:

```powershell
$env:LMTI_WEB_TEST_PYTHON = (Get-Command python -CommandType Application | Select-Object -First 1).Source
corepack pnpm web:baseline
```

`LMTI_WEB_TEST_PACKAGE` and `LMTI_WEB_BENCH_PRODUCER` select other verified local
builds. `LMTI_WEB_BENCH_FIXTURE` may reuse only a matching, marked synthetic build
fixture with the identical protocol hash. The benchmark does not accept arbitrary
workload/command arguments. It never stores launch nonces/session tokens, existing
client settings, traces, raw secret memory or provider credentials.

Remaining work: lock acceptance thresholds and human comparative trials, confirm
actual Cursor/providers, clean Windows and complete parity/history/pilot gates.
Safe lesson candidate: project discovery needs an owner-validated metadata
projection; a metadata row is neither a graph-health certificate nor authority
to bypass full validation when reasoning or writing.
