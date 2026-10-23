# LMTI local operator API — WEB-01

Local-alpha operator boundary over existing native and Python owners. C++ owns
the project/profile/library stores and generators; Node does not open SQLite.
Python owns private client config merge, Windows DPAPI and recovery. Agent MCP
continues over Python stdio and never receives the operator session.

The React MCP workspace now uses this API for real owner operations. See
[usage and packaging](../../docs/local-web.md) and [WEB-02 evidence](../../docs/plans/2026-10-13-web-react-execution.md).
WEB-03 actual-client/operator/provider and cutover gates remain open. WEB-00
study fixtures are not imported into the application.

## Build and launch

Use existing Node 24+, TypeScript and the trusted native Core/Sql backend package:

```powershell
corepack pnpm web:build
& scripts/package-local-web.ps1
& scripts/start-local-web.ps1 -DataDirectory 'build/studio-ui/data'
```

Choose the data directory that contains your Studio `project-library.sqlite`
and `mcp-profiles.sqlite`. The shown directory is an example, not an automatic
search or migration. Default package is `build/studio-web-20261013`; use
`-PackageDirectory` for another verified package containing `lmti-mcp-admin`,
`lmti-project`, Qt Core/Sql dependencies and publisher Python scripts/SDK.

The launcher freezes local operator scope to currently registered project IDs.
Use `-ProjectId factory-monitor` to select a subset. Library membership does not
grant an external Agent access. Create/register projects using the explicit local operator commands in
[local setup](../../docs/local-web.md#khởi-tạo-dự-án-không-cần-desktop). The web
API has no arbitrary path/shell or repository upload endpoint.

Launcher opens the browser with a cryptographic one-use fragment, then the page
removes that fragment and exchanges it for a session held only in tab memory.
No nonce/session is printed, written to files or placed in a query parameter.
Nonce is valid 30s; session idle TTL 20min/absolute 4h. Reload/end-session requires
relaunch. `-NoBrowser` starts a token-free diagnostic listener: manually opening
its printed public URL does **not** grant access. Default port is dynamically
allocated on `127.0.0.1`; occupied services are never replaced.
The packaged service checks idle shutdown every 30 seconds, only when no live
launch/session or write remains. It does not kill an accepted pending write.

**[CẢNH BÁO BẢO MẬT]** This service can write only through authenticated scoped
owner routes. Do not expose it through LAN, Cloudflare Tunnel or Tailscale Serve.
Loopback + session controls do not isolate malware/extensions with the same OS
user privileges and do not implement multi-user RBAC. Native SQLite remains
unencrypted/nonsecret-only. Provider OAuth/credentials remain client-owned.

## API and write semantics

See [contract/security](../../docs/plans/2026-10-13-web-ui-contract.md),
[DTOs](src/contracts.ts) and [evidence](../../docs/plans/2026-10-13-web-api-execution.md).
Every API call needs `Authorization: Bearer <in-memory session>` and
`X-LMTI-UI: 1`. Mutations/bootstrap additionally require the exact Origin.
No wildcard CORS; strict duplicate-key/UTF-8 input, fixed owner processes,
bounded bodies/outputs, revision checks and no raw owner diagnostics in responses.

Preview TTL 120s, bound to session/project/client/op/native profile/root binding
and private config/recovery fingerprint. Commit rechecks and consumes preview.
Configuration status is as-of, not endpoint health or proof of actual client use.
Managed export returns only native-generated config, explicitly requested by the
operator; local launch paths may be necessary in that export. Existing full client
config is never returned. Restore preview decrypts/checks privately without writing.

One API writer per project; at most 2 owner processes, queue 16. Writes are not
killed when the UI disconnects/times out. Commit may return 202 with `outcome:
pending` and operation ID; poll authenticated `GET /api/v1/operations/{id}`.
Completed results are retained at most 10 minutes/on active session. A server
crash needs fresh owner status/recovery; no blind write retry. Native revision and
Python optimistic checks remain authoritative for concurrent native/IDE edits. There
is no atomic transaction across profile SQLite, client files and both clients.

Project cursors bind to session, page size and the current permitted library
inventory/bindings. Each page projects current owner revisions; it is not a
snapshot of every project database. Inventory changes require a new cursor.
Status/check/export/preview may reveal only permitted nonsecret project metadata.

## Verification

The [repeatable Windows runner](../../docs/plans/2026-10-14-web-verification-runner.md)
selects package/native paths and runs doctor, browser UI tests and real native-owner/API checks:

```powershell
& .\scripts\verify-local-web.ps1
```

```powershell
$env:LMTI_WEB_TEST_PYTHON = (Get-Command python -CommandType Application | Select-Object -First 1).Source
node --test apps/web-api/test/*.test.mjs
```

Native fixture producer and the installed package must already be built. Tests
also expect a built WEB-03 package (the runner selects `build/studio-web03-projection-20261014`, or
`LMTI_WEB_TEST_PACKAGE`) for its read-only integrity/runtime doctor. Synthetic
process pauses exercise real 202 pending, session revocation and HTTP disconnect
without adding a production delay flag or mocking successful owner results.
Interrupted-owner and actual API process-loss trials also verify protected
recovery and rejection of previous sessions/previews after restart. The standalone
host under `test/fixtures` is synthetic-only and is not packaged. See
[WEB-03 evidence](../../docs/plans/2026-10-14-web-parity-execution.md).
Tests use fresh directories inside `build`, actual native schemas/generation, protected
Python apply/restore and HTTP requests. They never write operator client config
or contact real providers. Do not print session/nonce headers while debugging.
Keep `.gitignore` for env, credentials and client runtime. Run publish preflight
before push/PR/release; this component has not been published.
