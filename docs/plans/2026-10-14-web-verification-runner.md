# WEB-03 repeatable Windows verification

Date: 2026-10-14. Continues the master plan's clean-machine/parity preparation.
This records an executable local/CI check path, not a completed remote CI run or
the full Windows/operator/client acceptance gate.

`scripts/verify-local-web.ps1` checks the package/runtime doctor, runs the real
API suite, then the coordinated Qt/API workflow and IPC fault case. It uses only
trusted local package/build/SDK paths, rejects UNC/device paths and ancestor
links, freezes test executables from the selected native build, and prepares an
explicit DLL/plugin runtime copy under a fresh `build/web-verification-*` folder.
No test executable or offscreen plugin is copied into the product package.
Selected environment overrides are restored after the run, including failure.

The report records each selected check and stops on failure; there is no automatic
retry or false clean-Windows label. Logs contain bounded synthetic fixture output,
not session nonces, bearer headers, protected originals or personal configurations.
The benchmark is separate so variable machine timings are not passed off as CI
acceptance thresholds.

```powershell
& .\scripts\verify-local-web.ps1
```

For a different local/native build, explicitly select its package/build/Qt SDK.
For example, the CI job builds a fresh package from its own native install:

```powershell
& .\scripts\package-local-web.ps1 -NativePackage build/studio -AdminPackage build/studio -OutputDirectory build/studio-web-ci
& .\scripts\verify-local-web.ps1 -PackageDirectory build/studio-web-ci -NativeBuildDirectory build/native -QtRoot .tools/qt/6.12.0/msvc2022_64
```

`.github/workflows/topology.yml` now contains these two commands after the native
build. Workspace dependency installation uses `--frozen-lockfile --ignore-scripts`;
the existing verified Qt installer/runtime pins are retained. No new dependency,
provider connection, credential or broader GitHub permission is introduced.
API fixture producer and Qt offscreen paths are operator-configurable test inputs,
not browser/Agent executable settings.

The first local runner passed. A follow-up fresh-runtime run failed during Qt
preview coordination and remained failed in its report. The test controller was
then changed to acknowledge preview only when the actual modal is visible, and
acknowledge closure only after the modal call unwinds. Connection-save replies
also wait for the dialog call to return. These are test synchronization changes,
not production UI/storage changes. Previous failures and unexplained early trial
events remain evidence; a successful rerun is not proof that every historical
failure had this cause.

The subsequent diagnostic captured the concrete failure `EPERM` while publishing
the next atomic IPC command file: Qt was briefly reading the replacement target.
The harness now retries only that failed file publication for at most 50 attempts
at 20 ms, retaining the same bytes/sequence. The receiver deduplicates sequence;
no unknown apply/restore result is retried, permissions are not widened, and a
permanent failure still fails the report. The IPC fault test holds an exclusive
target lock while issuing a read-only reload, verifies that publication really
waited, then checks malformed commands are still refused. Eight diagnostic trials
passed after this change; the final integrated runner also passed.

Final local report:
`build/web-verification-a3bf41a584e4469197f2f555aa6c67eb/verification.json`.
Its four checks are package/runtime integrity (94 files), API (13/13), Qt/API
interoperability and the controlled IPC fault. The final fault report recorded
17 publication waits and exactly the expected resulting revision. Evidence:
`build/web03-qt-874FQL/qt-api-report.json`; run log
`build/web03-verification-published.log`. Earlier failed reports are preserved.
This confirms the current reproduction/mitigation; historical failures without
those diagnostics still cannot be assigned this cause with certainty.

Remote CI execution requires a separately authorized publication/push path and
`lmti publish preflight`. No push, PR, release, remote workflow run or artifact
upload was performed here. Once a clean runner actually executes, record its run
URL, environment, version and reports; do not infer success from this workflow
source. Manual prerequisite installation, actual Cursor/OAuth, independent human
trial, complete parity/history and broader pilot/IoT gates remain open.
