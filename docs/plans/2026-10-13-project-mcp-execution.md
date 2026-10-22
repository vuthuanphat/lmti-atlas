# CP-01 project MCP implementation evidence

Date: 2026-10-13. Status: **local-alpha profile/UI/generator/apply implemented;
actual Cursor, operator and live-provider acceptance open**.

The owner requested execution of the project MCP workflow shared by Codex and
Cursor. [Master r4](../LMTI_MASTER_PLAN.md) sets priority;
[spec](2026-10-13-project-mcp-profile.md),
[ADR](../adr/2026-10-13-project-mcp-profile.md) and
[usage/limits](../project-mcp.md) describe the implementation.

## Delivered behavior

- Typed C++ profile and separate LMCP SQLite v1 owner, keyed by project ID with
  optimistic revision checks. Definitions are bounded nonsecret metadata; no
  topology/memory schema or Agent raw-store access is added.
- Qt **MCP & Agents** is the initial project page. Add/edit/enable definitions;
  choose remote/Cloudflare/private-via-Tailscale or the fixed local LMTI read server.
  Save the project first; each client has its own setup preview and status.
- Both generators derive from one revision. OAuth stays in each client; no
  credential values/custom headers/arbitrary local shell commands are accepted.
- Project config preview/merge/apply, protected Windows backup/restore, stale-file
  and ownership conflicts, interrupted-update recovery. Other servers/settings
  are preserved. Global configs are not written.
- Bounded local initialize/tools-list check reports four tools and check time;
  it does not claim client access or remote endpoint health.
- SDK/launcher/config owner are packaged. Trusted per-process launcher paths;
  `-ProjectFile` opens a saved project without forcing a demo.

The update is additive. Existing project/topology, TS memory, impact and Go owners
remain separate. Domain values are C++; JSON/TOML remain config/process boundaries.
No new runtime library, cloud/network/credential mutation or publication.

## Local evidence

Final package: `build/studio-mcp-verified-20261013`; build: `build/native-mcp-20261013`.
Desktop SHA256: `00C813B1370BD93EB4F32694D2B4A1010E86F839A880325AF4DA677A29882886`.
The earlier `studio-mcp-20261013` is a preview before additional server-key and
unsupported-auth rejection. It is not the final package identity.
Toolchain: MSVC/C++20, Qt 6.12.0, Python 3.14.2, installed Codex
0.162.0-alpha.17.2. No Cursor command/executable at the two conventional install
locations was found; a custom installation was not scanned.

- **Python: 54 cases, 52 passed, 2 skipped.** Eight new config-owner tests pass,
  covering DPAPI apply/restore, project isolation, disabled entries, stale preview,
  owned drift, original-secret non-disclosure and partial-commit recovery.
  Existing native/project/Agent integrations use the new package. Two skips are
  pre-existing TS impact Python integrations without their opt-in runtime env.
  Log: `build/mcp-python-tests.log`.
- **Native profile suite passes:** revision/isolation, invalid URLs, duplicates,
  metadata injection, disabled output and typed local launcher.
- **Qt MCP suite: 5 passed, 0 failed, 0 skipped** (three workflow methods and
  init/cleanup). Input rejection/reload/preview, EN/VI layout, local handshake and
  both client apply/restore on disposable folders. Log:
  `build/native-mcp-20261013/mcp-panel-tests.txt`.
- **Full native/Qt CTest: 8/8 passed**, recorded in `build/mcp-ctest-release.log`.
  Existing desktop 37/37, impact 7/7, Drive 33/33 and new MCP 5/5 Qt cases passed
  without skips in these suites. Final native/Qt run took 64.62 seconds.
  Initial runs omitted Windows fonts and the installed CLI/plugin layout. Final
  checks use documented fonts and the existing CI runtime staging procedure.
  The legacy navigation check now asserts stable page identity, since row offsets
  changed with the new first entry point.
- **Native-generated client smoke passes:**
  `build/cp01-final-745d74c4/report.json`. TOML/JSON parse to the same definitions.
  Installed Codex app-server in a fresh CODEX_HOME discovers four tools and reads
  saved synthetic `factory-monitor` / `factory-demo` scope. Source bytes unchanged;
  no model turn, personal config or live provider call. Cursor JSON parsing does
  not prove actual Cursor execution.
- Packaged app opens the saved synthetic project on MCP & Agents. Windows
  inspection confirms local handshake and Codex setup preview. The prior app
  with an unsaved draft remains untouched. Author inspection is not independent
  operator acceptance.

Synthetic emitter: `native/tests/mcp_profile_tests.cpp`, optional fresh evidence
folder argument. Client runner: `scripts/cp01-client-smoke.py`. Artifacts stay in
ignored build/. Profile/core/Qt code does not import the host business runtime.

## Remaining gates and limits

CP-01d actual Cursor and independent operator acceptance remain open. JSON
validity or config writes do not prove IDE access. Provider labels are connection
definitions, not live Cloudflare/Tailscale integration. Remote probes/OAuth,
multi-user authorization, proxy enforcement, bearer-secret references and general
local executable onboarding are not implemented. Unix apply is blocked pending
protected backup design; preview/export remain.

Profiles are nonsecret and SQLite is not encrypted. DPAPI and fixed launchers do
not isolate the same authenticated user. External editors can change configs
after the final check: the named mutex serializes LMTI writers and hashes detect
observed drift, but no lock is shared with all IDEs and no cross-store transaction
exists. A successful apply can become stale immediately. Cards/probes are as-of
checks. Interrupted recovery with unrelated edits keeps the protected journal and
fails closed for manual review. Toggling a profile does not revoke credentials.

No `.lmti/` edits, raw chat storage, auto-approved lessons, push/PR/release/remote
changes. Ignore rules cover client runtime state/config; check the host ignore
rules and run publish preflight before publishing.

## Safe lesson candidates

Review privacy/evidence before storing:

- A shared project MCP profile does not imply shared OAuth credentials/session.
- Configured, applied, endpoint checked and actual client read are separate evidence states.
- Use stable page IDs in navigation checks; row positions change with entry points.
