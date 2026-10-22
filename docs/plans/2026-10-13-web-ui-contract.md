# WEB-00 — UI contract and local service security design

Date: 2026-10-13. Status: **WEB-01 local operator API implemented after the owner's
continuation request; WEB-02 React implemented, operator/cutover acceptance remains open**.
Priority follows [master r5](../LMTI_MASTER_PLAN.md). The browser study is in
[web-mcp](../design/2026-10-13-web-mcp/index.html); DTOs are specified in
[canonical API DTOs](../../apps/web-api/src/contracts.ts).
See [WEB-01 evidence](2026-10-13-web-api-execution.md) for the implemented slice;
the original WEB-00 study remains synthetic.

## Purpose and boundaries

Make the same project MCP profile understandable and reusable across clients,
reduce repeated manual configuration and retain private owner boundaries.
Presentation can evolve separately from C++ domains and Python/TS owners.
This is one project workflow, not an Agent runtime, hosted MCP gateway or model.

The study is dependency-free HTML/CSS/JS and synthetic tab-local state. It is an
interaction specification for the React implementation at WEB-02. It performs no
network fetch, filesystem/config write, credential collection or real probe.
The static study server is not the administrative service designed below.

## Operation inventory

| UI operation | Current authority / implementation | WEB-01 work |
| --- | --- | --- |
| List/select known projects | `project_library` / native Qt library adapter | Add bounded native console projection; opaque IDs, no arbitrary paths |
| Read/save MCP profile | `load_mcp_profile`, `save_mcp_profile`, endpoint validation; LMCP v1 owner | Console adapter with expected revision, native validation and consistent errors |
| Generate configuration | `generate_mcp_config` / native owner | Resolve trusted runtime/root/site on broker, return managed nonsecret projection |
| Client status/preview/apply/restore | `scripts/mcp-config-owner.py`, Qt orchestration; Windows DPAPI + optimistic hash checks | Fixed-process adapter; broker holds raw private request and snapshot internally |
| Local handshake | Qt panel's bounded Python stdio probe | Extract/share boundary behavior without exposing arbitrary executable/tool calls |
| Remote check/auth | Client-owned OAuth; no remote probe in CP-01 | Return not-supported/unknown; no browser fetch or fabricated success |
| Project structure | Existing `lmti-project` snapshot + scoped Python SDK | Read projection when needed; no graph editor or live observation port in WEB-02 |
| Configuration activity | Existing owner state/recovery; study events are synthetic | Show only retained evidence actually available; no inferred historical tool audit |

Frontend strings, visibility and validation assist the user; native/Python owner
validation remains authoritative. DTOs are versioned projections, not another
storage schema. Qt/web share the same files and must conflict on stale revisions.
Server path/binary/root resolution is from launch configuration and the trusted
library. Library membership alone is not an external Agent grant.

## Routes implemented for WEB-01

Routes below run on the authenticated WEB-01 service. The WEB-00 study server
still has no `/api` and does not connect to these routes.
JSON must be strict (duplicate keys, unknown fields, malformed UTF-8 and nonfinite
numbers rejected). Reject authority-bearing paths/commands/env/grants. Identity
lookup is session-scoped; inaccessible and nonexistent IDs have the same response.

| Method / route | Input | Output / semantics |
| --- | --- | --- |
| POST `/api/v1/session/bootstrap` | One-use launch nonce in JSON; exact Origin + `X-LMTI-UI: 1` | Short-lived bearer session, never logged; see bootstrap design |
| DELETE `/api/v1/session` | Session header | Revoke session, previews and cursors |
| GET `/api/v1/projects?limit=50&cursor=...` | Limit 1–100; opaque cursor | `Page<ProjectSummary>`; current-session scope; no raw roots |
| GET `/api/v1/projects/{id}` | Permitted project ID | Current native `ProjectSummary`; scoped, no raw paths; added for WEB-02 refresh |
| GET `/api/v1/projects/{id}/mcp-profile` | Project ID | `ProfileDto`; native revision 0 means unsaved empty profile |
| PUT `/api/v1/projects/{id}/mcp-profile` | `UpdateProfileRequest` | Owner-saved `ProfileDto`, conflict on expected revision mismatch |
| GET `/api/v1/projects/{id}/clients/{client}` | Allowlisted codex/cursor | `ClientStatusDto`; as-of evidence, not continuous health |
| POST `/api/v1/projects/{id}/clients/{client}/previews` | `CreatePreviewRequest` | `ClientPreviewDto`; opaque, session/project/client/op-bound, TTL 120s |
| POST `/api/v1/projects/{id}/clients/{client}/commit` | `CommitPreviewRequest` only | Recheck and consume preview, fixed owner action, `CommitResultDto` |
| POST `/api/v1/projects/{id}/connections/{server}/check` | Empty JSON; allowlisted stored definition | Local handshake `ConnectionCheckDto`; remote returns `NOT_SUPPORTED` |
| POST `/api/v1/projects/{id}/clients/{client}/export` | Expected profile revision | Explicit native-generated managed config projection; no existing raw client config |
| GET `/api/v1/operations/{id}` | Session-bound operation ID | Pending/succeeded/failed + retained result or stable error code |

Every response uses `ApiResult<T>`. Suggested HTTP mapping: 400 invalid input,
401 unauthenticated/expired, 403 origin/scope, 409 stale/recovery/drift/collision,
410 expired preview, 413 bounds, 429 busy, 501 unsupported, 503 owner unavailable.
Response messages are fixed public summaries. No stderr, command lines, raw
existing config, secret fragments, hidden IDs or filesystem diagnostics.

## Preview, commit and recovery

Broker reads native profile/generates config, then invokes the private Python
owner's preview. It stores the resulting private expected config/state hash,
profile revision, project/library binding identity and generated config under
the opaque preview ID. Browser receives only managed generated config + diff.
Never accept generated content, file hashes or write destinations from browser.

Apply and restore use separate preview operation types. A restore preview is
read-only: it may inspect protected journal/backup through a bounded private
owner extension, but must not perform recovery. WEB-01 adds `inspect`,
`restore_preview` and expected-hash-bound `restore_commit` to the private Python
owner. Legacy `restore` behavior remains compatible for Qt; it is never used
as preview. New writes bind protected backups to project/client/root metadata.
Legacy protected records remain readable and are checked against owner state.

Commit serializes project/client operations, checks session/TTL/operation/scope,
rechecks project-root binding, native revision and config/state/backup identity,
then calls the owner with fixed arguments. Conflict invalidates preview;
success consumes it. After ambiguous process timeout/disconnect, do not retry
the write automatically: read owner recovery/status and require a fresh preview.
Existing Windows DPAPI, DACL preservation and protected journal are retained.
Different client operations commit separately; no claim of a transaction across
Codex and Cursor. Owner restore refuses intervening third-party edits.

Do not map Python's generic free-text errors by brittle substring guessing.
WEB-01 adds stable error codes at the private boundary, retaining existing message/CLI
compatibility. Request cancellation during a write only detaches the UI; it
does not terminate the owner mid-transaction. Report the eventual result through
retained operation state/recovery inspection.

Actual generated local configuration can
include machine paths. Do not surface those through generic status/errors.
An explicit managed-config preview/export may disclose required nonsecret
launch paths to the operator, but never arbitrary existing config or credentials.
WEB-01 export returns managed content/format/safe filename after an authenticated
explicit request. WEB-02 implements the operator download flow; the WEB-00
study continues to offer instructions only.

## Local bootstrap and threat model

**[CẢNH BÁO BẢO MẬT]** An administrative loopback HTTP service can be reached by
other processes and malicious web content. Loopback binding is not authentication.
The study exposes public synthetic static assets only; these rules apply when
WEB-01 connects real owner operations.

Implemented bootstrap: the local service creates a 256-bit cryptographic one-use nonce, valid
30 seconds, opens same-origin UI using a URL fragment. UI reads/removes fragment
immediately with history replacement before its first API request, then posts
the nonce to bootstrap. Nonce is not an API query parameter, referrer, log, chat
or persistent store. Response bearer stays in tab memory only. Reload requires
relaunch; useful session-expired UX is required. Session idle TTL 20 minutes,
absolute TTL 4 hours, at most 8 sessions. Nonce/session comparison must be constant
time; rate-limit bootstrap. Never fall back to anonymous access.

HTTP tests cover expired/replayed nonce, wrong Origin/Host, unauthenticated access
and session/preview TTL. Browser history clearing/rendering still needs real browser
verification; the source removes the fragment before its first request. No cookies/localStorage authority.
Malicious software/extension with the same OS user's privileges is outside this
boundary; no OS isolation/RBAC claim. Operator secrets remain client-owned.

| Threat | Required control / test |
| --- | --- |
| Malicious website / CSRF / DNS rebinding | Bind 127.0.0.1 only; exact numeric Host/Origin with actual port; reject cross-site fetch; no wildcard CORS; bearer required on every owner route |
| XSS through project/server/tool metadata | React text rendering, no raw HTML; CSP same-origin scripts/styles, no inline/eval, no remote fonts/analytics, deny framing |
| Arbitrary process/path/SQL / SSRF | Broker resolves IDs to trusted owners; fixed argv, shell=false; no DB/filesystem/URL proxy endpoint; no remote check in first slice |
| Secret exposure | Strict DTO allowlists; managed config only; never existing config/stderr/env; no VITE secrets; .gitignore and preflight before publishing |
| TOCTOU / stale preview / ID confusion | Recheck revision, scope, root binding and file hashes at commit; operation-bound previews; owner optimistic checks; consistent hidden-ID errors |
| Interrupted process / unknown write outcome | Retain owner journal/DPAPI; bounded status/recovery; no blind retry; do not kill committing owner on UI cancellation |
| Request/resource exhaustion | Body 128KiB, owner result 4MiB bounded before projection, public managed-config response <=128KiB, other result <=256KiB; handshake response <=32KiB; timeouts and concurrency caps |
| Privilege/network expansion | No LAN, tunnels or Tailscale Serve; no device execution; no arbitrary Agent calls; separately reviewed service ADR for sharing |

Initial limits: read timeout 10s; client owner/probe 8s (matches current local
behavior); queue length 16 and at most 2 owner processes; one writer per project
(stricter than the original per-client design). Native LMCP limit 32 servers; library and native storage limits retained.
No snapshot/process call per rendered node/card. Page/project projections should
batch reads where revision consistency is guaranteed; measure p95 and startup
before adding caches/workers. Deeper telemetry stays outside WEB-02.

## Packaging and dependency gate

WEB-00 uses existing Node 24, browser and no added package. WEB-01 implements a thin
local service, WEB-02 a separately buildable React/TypeScript SPA using Vite.
No SSR/RSC, N-API, new database, Electron/Tauri, Protobuf/gRPC or GPU runtime.
Use official registry package identities, pin reviewed versions and check current
advisories/transitive dependencies **before installation**. No audit-fix force.
Web launcher remains opt-in and independent of the Qt launcher. Existing package
toolchain (Node/Python/Qt) needs doctor checks and clean Windows verification.

Completed operation outcomes are retained for 10 minutes while the session is
active. A commit waiting longer than 8s returns 202/pending plus operation ID;
the writer remains serialized until its owner exits. SQLite profile and protected
client files are separate owners, not a cross-store transaction. Project cursors
are tied to permitted library inventory/bindings; each page has current owner
revisions, not a snapshot of all project DBs.

## Review and acceptance

Review three actual browser flows: new project → add → preview → two clients;
updated profile → diff → conflict → fresh preview; recovery → restore → auth/
offline/missing-client states. Project switching must not carry profiles/status
across projects. EN/VI, keyboard/escape/focus and desktop/mobile layout require
manual evidence. All simulated write buttons must say preview explicitly.

Record operator feedback separately from test success. WEB-00 is review-ready
when artifact, contract, owner gaps and threat model are inspectable; the gate
"Chủ sản phẩm review prototype" in the [transition plan](2026-10-13-web-ui-transition.md)
remains open until feedback. Review does not mark native/Web/client/IoT parity.
Safe lesson candidate (not stored): UI status must distinguish configuration,
endpoint reachability and evidence of actual client use.
