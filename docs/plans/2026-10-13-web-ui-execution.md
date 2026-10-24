# WEB-00 — Local browser study and API design delivery

Date: 2026-10-13. Master: [r5](../LMTI_MASTER_PLAN.md).
Status: **study and contract delivered; owner UX review and browser verification
remain open. React, real local API and WEB-01–03 are not implemented**.

## Delivered

- [Browser study](../design/2026-10-13-web-mcp/README.md): project switcher, MCP
  connection editor/toggle, Codex/Cursor preview and simulated apply/restore,
  config conflict refusal/fresh preview, auth/offline/missing-client states,
  declared structure and synthetic configuration activity, EN/VI strings.
- Responsive CSS for desktop/mobile, semantic labels, skip link, native modal
  dialogs, keyboard focus styles and text-only metadata rendering.
- [Typed DTOs](../design/2026-10-13-web-mcp/api-contract.ts) and
  [operation/security contract](2026-10-13-web-ui-contract.md): route semantics,
  private preview state, scope/revision/TTL, proposed bootstrap, owner/process
  limits, safe errors, cancellation and recovery semantics.
- `scripts/web-preview-server.mjs` and `scripts/start-web-preview.ps1`: fixed
  synthetic asset allowlist, IPv4 loopback only, exact Host/Origin, GET/HEAD only,
  CSP/no network fetch/frame/analytics, no arbitrary file/API access.
- Owner gaps explicitly recorded: profile/library console façade, typed private
  owner error/status codes, **read-only restore preview**, explicit export design
  and shared bounded local handshake adapter. No Python restore used as preview.

No packages installed, no lockfile/domain/storage changes. Existing Qt launchers,
windows/drafts, Agent stdio and client configuration remain as they were.
The browser study is outside product runtime; fixture code is not reusable domain
logic and must not be imported into the live UI.

## Checks and actual limits

- `node --check` passed for browser study JS and preview server.
- Existing TypeScript compiler passed strict no-emit check of DTO artifact
  (`ES2022`, `ESNext`, `skipLibCheck`); no package installation.
- 11 HTTP boundary cases passed: index/JS served, `/api`, `.env`, traversal,
  encoded traversal and query rejected; POST rejected; wrong Host/Origin and
  cross-site fetch rejected. CSP `connect-src 'none'`, no-store and deny-frame
  headers checked. Evidence: `build/web-preview/web00-http-check.json`.
- Local launcher started the isolated synthetic helper at
  `http://127.0.0.1:8781/`; this is a static study, not an authenticated owner API.
- Chrome automation could create tabs but the page reported **ERR_BLOCKED_BY_CLIENT**
  in both connected profiles; reload did not resolve it. No browser protection
  was changed. Therefore browser rendering, actual interaction flows, keyboard,
  EN/VI layout and 1280×720/1440×900/mobile visual verification are **not claimed**.
  Manual review remains required; source and HTTP checks do not replace UI proof.

Native CP-01/M2 tests are inherited baseline only. They were not rerun for this
isolated study and are not web acceptance evidence. This turn does not claim
actual Cursor, OAuth/provider access, live IoT, scale or release readiness.

## Next gate

The [transition plan](2026-10-13-web-ui-transition.md) requires
**“Chủ sản phẩm review prototype”** at WEB-00 before full live UI port. Review
the three workflows and density/navigation first, then adopt the detailed
boundary/security contract and implement WEB-01. No automatic approval has been
inferred from creating the study. Keep Qt available until WEB-03 parity/cutover.

Safe lesson candidate (not saved): configuration-applied, endpoint/auth state
and actual-client evidence must be distinct in UI and API.
