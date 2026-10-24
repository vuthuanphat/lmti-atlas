# WEB-03 package checks and write lifecycle evidence

Updated 2026-10-14, Asia/Bangkok. Continues the accepted local web transition;
does not declare WEB-03 cutover or the complete LMTI master plan achieved.

## Implemented and verified

Both packaged launchers now run `test-local-web-package.ps1` before starting
Studio operations. The read-only doctor checks local non-link runtime paths,
Windows/Node/Python x64, Node >=24 and Python >=3.11, required package components,
bounded strict manifest parsing, case-insensitive duplicate filenames, traversal,
SHA256, absent files, extra files, links and referenced JS/CSS assets. Normal SDK
`.pyc` caches may be unlisted; their bytes are not publisher-authenticated.
Native admin is invoked without arguments and must refuse with `INVALID_INPUT`
before any database access. This confirms native/Qt Core loading, not full Qt
UI/SQL parity. Checks do not open operator data, inspect personal configuration,
contact providers, install dependencies or create a web session.

The source launcher no longer silently falls back from an incomplete package
to repository API output. The original `studio-web-20261013` package is retained.
Current source launchers select `build/studio-web03-20261014`; packaged launchers
select their own package. This is a newer opt-in package, not Qt default removal.

The package contains 109 manifest files. Doctor passes on this Windows machine
with Node 24.13.0 and Python 3.14.2. Evidence: `build/web03-doctor.json`.
Hashes are integrity evidence against a supplied manifest, not a publisher
signature or protection against the same OS user replacing checker/manifest.

API tests now cover a test-only Python process pause followed by the **unchanged
real DPAPI owner**, without rewriting API responses or adding a production delay
flag. The accepted apply remains pending beyond eight seconds and returns real
HTTP 202. During that interval a second write receives BUSY, a consumed preview
cannot be reused, other sessions cannot inspect the job, and expired/revoked
sessions cannot authorize additional operations. Revoking all sessions does not
make the service idle while the accepted write remains active. Release lets the
owner finish; a fresh authorized session inspects actual state and restores the
protected original, preserving unmanaged settings and the other project.

A separate test disconnects the HTTP request **after the owner starts and before
the commit response**. The owner continues, holds the project lock through its
terminal status bookkeeping and eventually releases it. Seeing an applied file
can precede completion of that bookkeeping; the test only retries definitive
BUSY refusals, never an unknown write. This is not a product mutation-retry loop.
These are deterministic fault checks, not a natural slow-machine performance
benchmark, server-crash recovery proof or actual Cursor session.

Current API/package suite: **11 passed / 0 failed / 0 skipped**, logged in
`build/web03-api-tests.log`. Web/API TypeScript build passes. The packaged
launcher returned a token-free public URL and React HTTP 200 with `-NoBrowser`;
that diagnostic process later exited on idle, confirmed by its recorded PID
being absent. Evidence: `build/web03-startup.json`. Browser rendering and the
384-test TypeScript workspace run remain prior WEB-02 evidence; no new UI
behavior was claimed or re-tested here.

## Completion audit against the accepted plan

| Requirement | Evidence and current result |
| --- | --- |
| WEB-00 UX/contract | Existing prototype/typed contract; owner UX acceptance still open |
| WEB-01 same owners and safe API | Existing actual native/Python integration plus current auth/scope/conflict checks; no storage/domain replacement |
| WEB-02 MCP React slice | Existing packaged browser CRUD, both adapter apply/restore and native exports; UI assets unchanged in this continuation |
| Package/runtime doctor | Implemented here; real 109-file package checked, negative corruption/extra-file/link tests; clean Windows still unverified |
| Accepted write >8s, pending, disconnect/session lifecycle | Real HTTP/process/DPAPI checks; interrupted owner and actual API process-loss recovery now checked below; independent/clean-machine recovery still open |
| Codex actual client | Prior isolated web-export app-server evidence; no new model turn or expanded claim |
| Cursor actual client | Owner confirmed **not installed** in this session; adapter roundtrip is not actual-client acceptance |
| Qt/web UI interoperability | Real source Widgets + packaged API/React now checked below; full history/feature parity and independent operator acceptance remain open |
| Second operator | No independent operator trial yet |
| Provider OAuth/reachability | No authorized live provider evidence yet; UI remote check remains truthfully unsupported |
| Setup/update/recovery comparison and scale | Workload/baseline and acceptance thresholds not yet locked; do not infer acceptance from bundle sizes/test duration |
| Broader Agent cross-source / real IoT | Still open under master plan; not replaced with synthetic/live claims by completing MCP presentation |
| Cutover/default Qt retirement | Not performed; fallback and old package preserved |

## Next evidence to obtain

Actual Cursor requires an installed client, version/environment record and an
isolated project that reads the four local tools using the generated profile.
Do not edit personal Cursor settings to simulate success. Provider checks need
the operator's selected nonsecret HTTPS endpoint and client-side OAuth consent;
never request tokens in chat. A second operator should independently select a
synthetic project, add a connection, preview/apply each installed client, update
the profile, resolve a concurrent conflict and restore it, recording outcomes
and time rather than credential/config payloads.

The remaining gates are not waived by this report. Keep the full objective
active. No publish, push, PR, release, remote change or `.lmti` memory write.

Safe lesson candidate: distinguish file state visible to inspection from a
terminal owner operation; retain its lock until owner completion. No raw chat
or secret memory was stored.

## Coordinated Widgets / packaged API / React continuation

`lmti-qt-web-probe` is a development-only CMake test target, **not installed or
packaged**. It links the real `lmti_desktop_ui` library, opens a marked synthetic
fixture under repository `build/`, and uses actual connection/setup dialogs and
buttons. It accepts only fixed coordinated test actions. It has no MCP endpoint,
arbitrary shell command, general file picker or SQL interface. Node's
`scripts/web-qt-interop-smoke.mjs` first validates the trusted local package and
runtime, then makes fresh native documents and a private test runtime copy.
The SDK offscreen plugin is used only in this test copy; it is not added to the
product package. The API imports the actual packaged server and runs its normal
authentication/native/Python owners. No API responses or successful writes are
mocked. UI and API generators resolve the same native runtime paths.

The nine explicit assertions prove these bounded flows:

- Qt toggles/adds a connection and the API reads the resulting revisions.
- Qt dialogs and web exports produce byte-identical managed Codex/Cursor configs.
- Qt applies Codex; the web API restores the protected original through the same
  Python owner. Web applies Cursor; Qt restores it. Unmanaged synthetic settings
  remain intact. This is adapter interoperability, not actual Cursor execution.
- Qt changes a profile after a web preview; web refuses the stale commit.
- Web changes a profile while a Qt setup dialog remains open; Qt refuses stale
  apply. A subsequent stale Qt profile edit cannot overwrite the newer revision.
- Qt reloads the new revision and switches to the independent Edge Gateway
  profile. The native project document bytes remain unchanged.

Final automated report: `build/web03-qt-A4a7yW/qt-api-report.json`, command log
`build/web03-qt-final.log`. Five additional repeated synthetic trials after the
diagnostic refinement passed; their logs are `build/web03-qt-repeat-1.log`
through `-5.log`. Current C++/Qt MCP regression build and **2/2 CTest targets**
passed (`mcp_profile`, `mcp_desktop`), recorded in
`build/web03-qt-regression-build.log` and `build/web03-qt-regression.log`.
These are scoped checks, not a new run of the whole TypeScript/native suite.

An isolated real browser also held React's Codex preview at r5 while the Widgets
probe changed the profile to r6. React received actual HTTP 409, showed the
conflict, disabled writes until an explicit reload and displayed the disabled
connection from Qt. The operator then enabled it through React, producing r7;
the still-running Widgets probe reloaded and read r7/enabled. React project
switching showed Edge Gateway r0, then Factory Monitor r7. Session was ended and
the test browser/probe/API were closed. Both original client files and native
project bytes were checked again afterward.

Browser evidence: `build/web03-qt-browser-evidence.json`,
`build/web03-browser-shared.log`, `build/web03-browser-end.log`, and
`output/playwright/lmti-web03-qt-shared.png`. The browser's HTTP 409 console entry
is expected conflict evidence; it is not a successful commit or a JS exception.
No private launch URL, auth header/body, raw existing config, trace or saved auth
state was logged. The one-use development handoff was scoped only to synthetic
data and is not a production authentication path.

An earlier browser attempt exceeded the original two-minute probe lifetime;
its final Qt reread was not counted. The probe now has a five-minute bound and
rejects commands after exit. One early automated trial also exited during project
switching before diagnostic capture was added; it was not counted as passed and
its cause is unproven. Subsequent trials passed, but this does not certify the
absence of an intermittent issue. Full cutover still requires independent
operator and clean-machine trials, current client/provider proofs, locked
comparative workloads and the complete parity/history audit.

To reproduce with the existing trusted Qt SDK, build the probe and fixture
producer in a local CMake test build (no additional library installation):

```powershell
cmake --build build/native-mcp-20261013 --config Release --target lmti-qt-web-probe lmti-mcp-profile-tests
$env:LMTI_WEB_TEST_PYTHON = (Get-Command python -CommandType Application | Select-Object -First 1).Source
$env:LMTI_WEB_TEST_PRODUCER = "$PWD/build/native-mcp-20261013/bin/Release/lmti-mcp-profile-tests.exe"
corepack pnpm web:qt:smoke
```

The helper accepts trusted operator overrides `LMTI_WEB_TEST_PACKAGE`,
`LMTI_WEB_TEST_QT_PROBE` and `LMTI_WEB_TEST_PRODUCER` for other local build paths.
Node must already have `web:api:build` output. Browser coordination uses the
development-only `--browser` option and the already-reviewed Playwright CLI;
do not use this helper with operator/customer libraries.

## IPC fault and interrupted-write recovery continuation

A deterministic Windows sharing-violation fault reproduced a concrete **test
controller** defect: a half-second exclusive lock on the marked synthetic
`qt-command.json` made the probe exit with code 2 and diagnostic `command_open`.
The probe now waits for at most 50 polls (20 ms timer target) when opening that
file is temporarily unavailable. It does not change ACLs or accept malformed
content. Symlinks/junctions, byte limits, JSON fields and sequence validation
remain enforced. Diagnostic output contains only sequence and fixed phase codes,
never request/config contents. The locking child also has bounded start/acquire
times. This does not prove that the previously uncaptured project-switch exit
had the same cause; that historical event remains unexplained.

Before-fix evidence: `build/web03-qt-QJxMjh/qt-api-failure.json` and
`build/web03-qt-ipc-before.log`. After fix, the real Windows lock was held for
0.5 seconds without terminating the probe; all nine Qt/API workflow checks
still passed. A deliberately malformed JSON command then produced the expected
`command_decode` refusal/code 2. That final exit is intentional negative-test
evidence, not an unexplained crash. Final report:
`build/web03-qt-SSV8hI/qt-api-report.json`; log `build/web03-qt-ipc-final.log`.
Run with `node scripts/web-qt-interop-smoke.mjs --ipc-lock` after building the
probe. The test executable remains absent from the product package.

Two API integration cases now exercise actual process interruption boundaries:

1. A test-only wrapper performs the real owner's config replacement, then exits
   abruptly before the state write. The unchanged owner has already written
   DPAPI backup/journal. API returns fixed OWNER_UNAVAILABLE; inspection reports
   `recovery_required`, an apply preview is refused, a protected restore preview
   exposes no original bytes, and explicit restore returns the exact original.
   Profile revision and native project document bytes remain unchanged.
2. A standalone test API process accepts a real write and is forcibly stopped
   only after config replacement is confirmed. The parent retains no successful
   commit response. A newly launched API requires a fresh session, refuses the
   old session token/preview and inspects actual owner state before any action.
   On this host the observed state was **recovery_required**, not applied; explicit
   protected restore then recovered the original bytes without replaying apply.
   Process/hosting behavior may also permit a completed owner; the test accepts
   those two defined states, never an unknown state or silent retry. It does not
   bypass host process containment to force a child to survive.

The standalone host is `apps/web-api/test/fixtures/api-process.mjs`, restricted
to fresh synthetic build fixtures and **not packaged**. Launch nonce/session
travel only over the parent's private pipe and HTTP exchange in memory; neither
is printed to user output or persisted. No operator service/process was stopped.
The fault wrappers are test-only; there is no production crash flag or successful
owner-response mock. The recovery case retains synthetic evidence under `build/`
instead of deleting it while descendants might still be winding down on failure.

Current API/package suite: **13 passed / 0 failed / 0 skipped**,
`build/web03-api-process-tests.log`. Actual process-loss evidence:
`build/web01-test-wPUjGa/process-loss-evidence.json`. This verifies scoped local
fault behavior; it does not certify all crashes/power loss, second-human recovery,
clean Windows, complete Qt feature/history parity or actual Cursor/provider use.
The full objective remains active and the broader cross-source/IoT gates stay open.

Safe lesson candidate: test accepted writes across UI disconnect, owner loss and
API process loss separately; after lost transport, inspect owner state under
fresh authority and offer protected recovery rather than replaying apply.
