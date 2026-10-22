# LMTI web presentation

## Workspace presentation v2

The dark technical workspace includes Overview, Work, Architecture (logical,
physical, inventory), Knowledge and Agent. Below 1200px navigation uses a modal
drawer; below 768px controls use 44px targets. Project search explicitly filters
only loaded projects and retains server pagination. Architecture tabs keep owner
panels mounted so changing presentation cannot discard an active write or recovery
lock. Knowledge task input is bounded to 1,000 UTF-8 bytes by the existing contract;
the UI explains that line breaks become spaces before submission.

Eight transparent category icons were generated with the built-in Image AI tool.
Sources and prompts are in `src/assets/icons/`. Vite emits publisher-owned PNGs;
the API serves them through the same exact-path bounded asset map, validates their
PNG header and permits same-origin images through CSP. No remote images/fonts or
new packages are required. The icon's surrounding control always supplies its
accessible text label.

Run `node --test apps/web-ui/test/*.test.mjs` from the repository root and the
existing API verification suite after `corepack pnpm web:build`. Browser testing
must use synthetic data and isolated browser sessions; never save capabilities,
request headers/bodies, auth state or traces. Keep `.env`, credentials and session
artifacts ignored before pushing, and run the repository publish preflight.

Client-only React 19.3 / TypeScript SPA, built with pinned Vite 7.3.7. No RSC,
SSR, cloud scripts/fonts, analytics or fixture data in the application. Built
assets are served by `apps/web-api` on the same authenticated loopback origin.
Domain DTOs come from the API contract; native/Python owners validate all writes.

See [usage/build/package](../../docs/local-web.md) and
[implementation evidence](../../docs/plans/2026-10-13-web-react-execution.md).
`corepack pnpm web:build` typechecks and builds the API and SPA. Native config
loading avoids esbuild scanning workspace parents; this is not a permission bypass.
Do not use `VITE_*` for credentials. Session stays in an API module closure;
bootstrap is consumed once before React renders, then the URL fragment is removed.

Presentation contains project search/pagination, nonsecret MCP profile CRUD,
Codex/Cursor preview/export/apply/restore, supported local handshake and as-of
status. Structure is current registered-project metadata; full topology editing
stays in Qt. Activity contains at most 100 real operator events in this tab only.
Reads abort on project changes; writes are never automatically retried. Unknown
write results/conflicts require refreshing and creating a new preview. A pending
commit is polled by operation ID, with manual status recovery if polling fails.

Development browser checks use the official Microsoft Playwright CLI in an
isolated profile. `scripts/web-ui-browser-fixture.mjs` creates synthetic databases
under `build`, uses the packaged API, and hands off one launch capability in memory
to that isolated browser. The one-use loopback bridge is development-only, scoped
to synthetic files, never installed/exposed in the product or used with real data.
Do not save network request bodies/headers, auth state or traces. Screenshots of
synthetic data go to `output/playwright/`, which is ignored by Git.
