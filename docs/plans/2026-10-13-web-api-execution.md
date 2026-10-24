# WEB-01 — Local operator API over native/Python owners

Date: 2026-10-13. Priority: [master r5](../LMTI_MASTER_PLAN.md).
The owner requested continuation after the WEB-00 artifact. Status:
**native façade + authenticated local operator API implemented/tested as local
alpha; React workspace, browser/operator acceptance and WEB-03 cutover remain open**.

## Implemented slice

- `lmti-mcp-admin`: library inventory/batched summaries, scoped profile read/save,
  native Codex/Cursor generation. Reuses LMCP/LMPR/LMLB owners. Fixed launcher
  locations, bounded stdin, strict field/type shape and project identity checks,
  reparse/symlink ancestor rejection, typed revision-conflict response.
- [Node/TypeScript service](../../apps/web-api/README.md): numeric loopback bind,
  exact Host/Origin, no wildcard CORS, cryptographic one-use bootstrap and memory
  bearer session, session/project/client-bound opaque previews/cursors, strict
  UTF-8/duplicate-key JSON, fixed processes and capped queue/body/output.
- Profile read/update, project pagination, per-client status, native-generated
  managed export, apply/restore preview + commit, local initialize/tools-list
  handshake. Remote check remains unsupported and performs no network request.
- Private Python `inspect`, read-only `restore_preview`, expected-hash-bound
  `restore_commit`; stable error codes preserve legacy response messages. Protected
  new records bind project/client/root. Windows DPAPI/DACL/optimistic checks and
  old Qt-compatible apply/restore interfaces remain.
- One API writer per project; write owners are not killed on UI disconnect/8s
  response timeout. Pending operations return ID/202 and can be polled within
  their session. Unknown outcomes require owner status/recovery, no blind retry.
- Separate opt-in launcher with trusted private stdin configuration. No secret
  fragment/token is printed or written. Operator scope freezes registered IDs at
  launch; library membership does not grant external Agent access.
- Browser connection page exchanges/removes launch fragment, lists native project
  summaries and reads profile. It is a diagnostic page, **not the React MCP UI**.

No new third-party packages installed. Empty workspace importer only; existing
root TypeScript/Node tools reused. Go/TS memory/Agent stdio interfaces and durable
schemas are unchanged. User configurations and existing Qt windows/drafts were
not changed; every write test uses disposable synthetic projects inside `build`.

## Validation

- TypeScript strict build + diagnostic browser JS syntax passed.
- **5/5 Node tests** passed. They run HTTP with actual native fixture/library/profile
  owners and actual Python/Windows protected apply/restore, not owner mocks.
  `build/web01-api-tests.log` records the run.
- Assertions cover unauthenticated requests, replayed/expired nonce, wrong
  Host/Origin/cross-site, unsupported methods, duplicate/escaped keys, malformed
  UTF-8/deep/unsafe-number JSON, oversize body, unknown command/path fields,
  inaccessible projects, session-separated and consumed/expired previews,
  session expiry, paged project isolation, revision conflict and external config
  edits. Both client formats preserve unmanaged settings and secret-like synthetic
  existing values without returning them; restore preview writes nothing.
- Native-generated managed export and four-tool local handshake verified. Original
  project DB bytes remain unchanged through client operations; second project
  profile stays isolated. No real provider endpoint/auth or actual client launch.
- **4/4 native CTest** passed in desktop-off build (4.84s); see
  `build/native-web01-20261013/Testing/Temporary/LastTest.log`.
- **58 Python tests: 56 passed, 2 skipped** (11.796s), including all **12 private
  owner cases**. Two existing optional TS impact integrations lack opt-in
  `LMTI_IMPACT_NODE/CLI/CONFIG`; they are not failures. Log:
  `build/web01-python-tests.log`.
- Native package installed separately at `build/studio-web01-20261013`.
  `lmti-mcp-admin.exe` SHA256:
  `B1EF21E841785238280C6E5AB5847D9107C2BB4684B4C031EC2F3FD6ADF09CF0`.
  Source/packaged config owner SHA256:
  `6B4352C8EF5042347689B104FABD91B440CC94D5DC6F9E50854F501B75AA88F0`.
- Opt-in launcher smoke ran against `build/web01-demo-7c1376a8`, a fresh native
  synthetic library/profile/project pair. NoBrowser mode does not mint a browser
  session or authorize manually opened URLs. No user data folder was touched.

## Limits and work remaining

WEB-00 Chrome automation reported `ERR_BLOCKED_BY_CLIENT`. This turn validates
the API through HTTP/owner integration; it does **not** claim browser rendering,
history clearing, keyboard/layout/operator acceptance or diagnose/change browser
protection. Session security tests do not establish OS isolation or multi-user RBAC.

React/Vite dependencies and UI port remain WEB-02. Native folder creation/linking
stays in Qt; no folder-picker API added. Status represents as-of configuration,
not installation/auth/endpoint health; actual Codex/Cursor use remains unverified
by this slice. WEB-03 must add browser interoperability, second operator, fault/
recovery/clean-machine/scale/performance proof before changing defaults.

No atomic transaction spans native profile storage and client configs/both
clients. Same-process writes are serialized; each owner checks its own revision/
fingerprint. A concurrent Qt profile edit after the checked point can make the
applied client configuration immediately pending; post-commit status must reflect
that. A process/server crash relies on the existing protected recovery journal.
Pending-write/timeout branch and actual browser bootstrap still need additional
end-to-end fault/browser evidence at WEB-03; do not turn code paths into proof.

Native SQLite remains unencrypted/nonsecret-only. Public network exposure, generic
MCP proxy/enforcement, live Cloudflare/Tailscale/Drive/IoT, model-quality and full
release acceptance are not delivered. No push/PR/release was performed.
Keep .gitignore for env/credentials/client runtime; publish preflight remains required.

Safe lesson candidate (not stored): a restore preview must be read-only and bind
all config/state/journal/backup fingerprints; a writing restore is not a preview.
