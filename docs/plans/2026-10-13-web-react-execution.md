# WEB-02 implementation and WEB-03 evidence

Updated 2026-10-14 (Asia/Bangkok; work started 2026-10-13). The owner explicitly requested continued implementation of
the agreed local web design until complete. This report covers the **MCP web
slice**, not the complete cross-source/IoT release. Existing owners/schemas and
TS/Go commands remain intact. No production publication or default Qt removal.

## Implemented

- React/TypeScript project workspace based on the accepted light sidebar/list
  study: project search and paged discovery, connections list, two client cards,
  progressive technical details, native modal focus/Escape, EN/VI and responsive CSS.
- Real profile create/edit/remove/enable through the native LMCP owner, expected
  revision, owner-generated preview/export, independent Codex/Cursor apply/restore,
  local four-tool handshake, truthful unverified client/remote-device status.
- Current single-project summary projection uses the same C++ library/project
  owners. Structure displays metadata, not a fabricated architecture graph.
  Full topology editor/create/link remains Qt fallback. Activity is bounded
  current-tab operator events; it is not durable Agent tool-call auditing.
- Tab-memory session; one-use fragment consumed outside React effects, erased
  before requests. No localStorage/sessionStorage/cookies/auth-state/telemetry.
  React text rendering, fixed same-origin fetch, external CSS, no inline/eval CSP.
- Aborted obsolete project reads, locked project changes during writes/modals,
  consumed previews, expiry guard, explicit conflict/unknown-result refresh,
  no automatic mutation retries, pending operation polling/manual recovery.
- Publisher-built static assets loaded into an exact bounded URL map. No user
  path-to-file mapping, directory listing, source map, source/config/manifest route.
- Fresh local package includes React bundle, compiled dependency-free Node API,
  native CLI + Qt fallback, Python SDK/owners, runtime notices and SHA256 manifest.
  Node >=24/Python >=3.11 remain trusted installed prerequisites, not bundled.
  Idle service closes only after sessions/nonces expire and no write is active.

## Dependency review

Official registry/repositories verified before install; exact React/React DOM/types
19.3.0, Vite 7.3.7, workspace pnpm 10.13.1. Client SPA has no RSC dependencies.
Vite 7.3.6 was present transitively through Vitest; a root override moves it to
the publisher security patch 7.3.7. Install used `--ignore-scripts` and a workspace
store/cache. No audit-fix/forced dependency upgrades or unreviewed lifecycle hooks.

Sources: [React release](https://react.dev/blog/2026/09/09/react-19-3),
[RSC advisory](https://react.dev/blog/2025/12/11/denial-of-service-and-source-code-exposure-in-react-server-components),
[Vite security patch](https://github.com/vitejs/vite/security/advisories/GHSA-rq7h-c2jc-7f22),
[Microsoft Playwright CLI](https://github.com/microsoft/playwright-cli).
Pinned development CLI `@playwright/cli@0.1.22` uses its publisher-pinned
Playwright engine; it is not a product/runtime dependency.

`pnpm audit` (all dependencies) and `--prod` reported **no known vulnerabilities**
at this check. This is registry evidence, not proof of absence of vulnerabilities.
Logs: `build/web02-dependency-audit-all.log`, `build/web02-dependency-audit.log`.

## Verification

TypeScript full build passed. After the Vite patch, **32 files / 384 tests passed**;
log `build/web02-typescript-tests.log`. The API/security suite passed **6/6**, no
skips: protected static delivery, authentication/scope/session expiry/cursors,
actual C++ profile/generation + Python DPAPI merge/restore, unmanaged settings,
local handshake, external file/native revision conflicts and strict JSON.
Log `build/web02-api-tests.log`.

The native/Python sources were not changed by this UI slice. WEB-01 native
**4/4** and Python **56 passed / 2 explicitly skipped** remain prior evidence,
not newly run browser checks. The earlier full Qt **8/8** also remains prior
native fallback evidence. See [WEB-01](2026-10-13-web-api-execution.md) and
[CP-01](2026-10-13-project-mcp-execution.md).

Browser CLI workflow uses isolated Chrome and fresh synthetic native libraries.
This bypasses neither user browser controls nor production authentication. The
earlier user Chrome profile blocked localhost; no extension/security setting was
disabled. The test-only bridge exchanges a real nonce in memory, navigates, waits
for bootstrap removal, then prints only clean public URL/assertions. No trace,
network payload/header dump or saved auth state. Windows CLI uses the same pinned
npx invocation as the skill wrapper; the supplied wrapper is a Bash script.

Confirmed through browser: empty project -> add local MCP -> save -> preview and
apply each client -> update profile -> both show update pending -> protected restore
each; local handshake, cross-project switch, remove, native-owner revision conflict,
HTML-like label rendered as text, modal keyboard/focus and EN/VI. Native concurrent
write is a shared-owner check, not a claim of a second human operating Qt.
Screenshots under `output/playwright/` include desktop 1440x900, preview and mobile
390x844 VI. A browser-pattern validation issue was found and fixed; expected HTTP
409 errors during conflict testing are distinct from JS runtime failures.

## Remaining gates

WEB-02 implementation and local packaged smoke are complete as recorded below.
WEB-03 cutover remains **partial**: actual Cursor, provider OAuth/reachability,
second-operator acceptance, real Qt/web interaction, clean Windows prerequisite
installation, locked comparative performance thresholds/workloads and pilot IoT
observations require external evidence. Do not label these passed or remove Qt.
No provider accounts, network settings, personal configs or customer databases
were changed. No Git push, PR, release or publish action was performed.

Safe lesson candidate: consume write previews once; preserve unknown write state
until owner inspection, and present configuration, endpoint/auth, client use and
device observation as distinct evidence. No raw conversation was stored in `.lmti`.

## Final local package evidence

Package: `build/studio-web-20261013`, with per-file SHA256 in `manifest.json`.
Native admin hash is `B1EF21E841785238280C6E5AB5847D9107C2BB4684B4C031EC2F3FD6ADF09CF0`;
Qt fallback hash remains `00C813B1370BD93EB4F32694D2B4A1010E86F839A880325AF4DA677A29882886`.
Publisher API/UI paths resolve inside the package; launcher returned a public
token-free URL and served React with the restrictive CSP. A `-NoBrowser` process
exited after its idle interval. Qt fallback rendered a synthetic empty library
with its packaged Windows platform plugin, exit 0. The package intentionally
contains `qwindows`, not the test-only offscreen plugin; an initial offscreen
render timed out and is not counted as a passed check. A mistaken `--help` probe
was closed without loading a project. Runtime evidence: `build/web02-runtime-smoke.json`.

Authenticated web exports were consumed by the installed Codex app-server in a
fresh isolated home, no model turn: four expected tools, project `factory-monitor`,
site `factory-demo`, source bytes unchanged. Both export formats parsed to the
same definitions. `build/web02-client-tx4A5b/web-export-report.json` records it.
Actual Cursor was not found by command/default user/default machine path probes;
custom installs are not excluded. No claim of an actual Cursor session.

Final packaged browser also checked remote-profile save/unsupported check,
operator download, expired preview disabled (browser clock fault injection),
unknown write state on offline transport, and pending -> real operation result
polling. Pending used a 202 response rewrite over a completed real owner commit
and delayed real status response; it proves the frontend protocol branch, not a
slow-owner >8s workload or crash recovery. No production API behavior was mocked.
Source bundle is approximately 252 KB JS / 78 KB gzip plus 11 KB CSS; these are
build measurements, not accepted performance thresholds. Scope remains capped
at 500 registered projects / 50 per UI page; expired discovery cursors restart a
bounded read. It is not evidence of unlimited project scale.
Final source/package integrity is recorded in `build/web02-source-evidence.json`;
all **106** listed files matched their hashes. Latest bundle booted with a clean
URL and no browser console errors; final image `output/playwright/lmti-web-final.png`.
Both launchers now refuse UNC/device-prefixed paths and control/quote characters
before resolving filesystem paths; rejection was verified using an unreachable
synthetic UNC string without filesystem/network probing. The test fixtures were
stopped after browser checks; no background test listener was deliberately retained.
