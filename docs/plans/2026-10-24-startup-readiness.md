# Startup, setup and recovery readiness

Date: 2026-10-24. Baseline: `771fc40f439ec1fe49a1fa1bca3183e58ccbae28`.
The owner authorized implementation and full regression checks, with **no merge
to main, public tag or release publication**. Human and clean-Windows acceptance
remain separate from maintainer and CI checks.

## Intended outcome

A first-time local operator can create a separate nonsecret workspace, reopen it
with the same reviewed grants, and understand what to do when a service, session
or writer is unavailable. Project memory and native data owners remain separate.
The work improves reusable project context without adding model calls or Agent
write authority.

| Order | Work | Evidence required |
| --- | --- | --- |
| 1 | Add an optional local operator console: O opens a fresh private session; Q or EOF drains accepted work and stops | Bounded stdin protocol; no web relaunch endpoint, persisted token or forced process kill; legacy launch protocol regression |
| 2 | Add fresh demo/empty-project setup and a reusable saved workspace launcher | Exact nonsecret profile, explicit grants, no overwrite, native initialization only, Unicode PowerShell 5 tests, tamper/path refusal |
| 3 | Distinguish startup failure, session expiry, network disconnection and native-owner failure | EN/VI behavior tests; a connection check reads only and never retries a write or bootstrap |
| 4 | Explain writer busy, unavailable and recovery-required outcomes separately | One explicit claim plus fresh status read; original-target recovery and separate acknowledgment remain mandatory |
| 5 | Align active setup/recovery/release/roadmap documentation | Historical evidence labeled; tested scope and open acceptance gates accurate |
| 6 | Build, run targeted and full suites, prepare a new isolated candidate and verify archives | Current source SHA, pass/fail/skip accounting, doctor, package hashes, secret review, browser journeys; no reuse of old green results for changed payload |

## Boundaries

- React + Vite remains the only UI. Native C++/Qt Core/Sql retains SQLite authority.
- Initial setup operates exclusively on a new workspace. Existing data is never
  reinitialized because an owner is unavailable. No schema upgrade is implicit.
- Setup reviews `ProjectFolderCount` (1–8, default 4) and creates only derived
  local source folders: `source/` for the initial project plus `source-2/` onward.
  A subsequent project needs a reviewed library upgrade and an unused approved
  folder; native UNIQUE folder keys are not bypassed. Existing one-folder profiles
  remain valid, and no real repository path is implicitly granted.
- Saved profiles carry locators, a package identity and bounded grants, never
  credentials, browser session tokens or one-use bootstrap fragments.
- O and the default saved launcher retain the initial project IDs. A separate
  opener selection uses explicit registered `-ProjectId` IDs checked by the
  native catalog; `-GrantProjectContent` is a switch granting edits to all selected
  IDs and requires that explicit selection. Without it, only the original
  already-approved content scope is retained. These are session-only overrides;
  the saved profile and Agent/hierarchy/copy/activation grants do not change.
- The operator console uses its inherited local stdin only. Session TTL and
  authentication remain unchanged. Reopening creates a new scoped session and
  does not grant a stale browser URL access.
- No generic filesystem, SQL, shell, process-kill, or relaunch HTTP endpoint.
- A busy broker is not a failed write. Unknown outcomes stay unknown; no replay,
  marker deletion, permission broadening or automatic recovery acknowledgment.
- Node/Python/MSVC remain trusted prerequisites. No automatic package download,
  administrator escalation or execution-policy bypass is introduced.
- SQLite metadata remains unencrypted and nonsecret-only. OS sandboxing,
  multi-user hosting, Drive/OAuth, advanced Impact and live IoT remain separate.

## Review and risk

Use focused source changes against this baseline for review of the larger release
PR. Pay particular attention to saved-profile tampering, command framing,
shutdown while native work is running, and the difference between reachable
service and a confirmed write outcome. Same-user filesystem races, forcibly
closing a console and machine power loss retain the existing recovery limits.
Routine checks must not leak locators, stderr, token-bearing URLs or personal data.

Implementation and final verification results will be recorded after the actual
checks complete; this plan alone does not close any acceptance gate.

The [operator acceptance guide](../operator-acceptance.md) records step-by-step
human outcomes separately from maintainer-controlled automated/browser checks.
Independent and clean-Windows acceptance remain pending until completed records
identify the exact candidate and tester environment.

## Implementation and verification record

The source now provides reviewed fresh setup, package-root `LMTI.cmd`, a saved
`Open-LMTI.cmd`, operator O/Q with drain, explicit registered-project selection,
distinct EN/VI service/session/owner/writer guidance and a read-only service
check. Optional maintenance stays separate. The [QA record](../releases/v0.2.0-alpha.1-qa.md)
separates preliminary working-tree regressions from baseline CI and final-package
verification. Delivery records identify the eventual committed package and hashes.

A real-browser race exposed failed lazy Work-panel loading during shutdown.
Core panels were moved to the initial bundle and initial HTML gained bilingual
fallback guidance; the known Vite chunk-size warning is retained. Fresh-package
browser evidence is required after this fix. Setup also gained reviewed bounded
spare folders because the initial folder is already uniquely bound; no native
uniqueness or authorization rule was relaxed. Do not erase those failures from
the verification history or infer independent acceptance from repaired tests.
