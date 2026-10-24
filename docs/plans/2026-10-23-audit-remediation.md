# Audit remediation and browser workflows

Date: 2026-10-23. Status: implementation authorized by the product owner.
Baseline: `0d958515c94421212b90001f16035d6a134ef28e`.

## Priorities and completion checks

| Phase | Work | Required evidence |
| --- | --- | --- |
| 1 | Replace retired Qt empty-state instructions with actionable EN/VI onboarding; distinguish empty library from failed read | Render/behavior tests and browser checks with empty and unavailable states |
| 2 | Align roadmap, architecture, support map and documentation index with browser-only ADR; publish explicit web/CLI/removed/experimental parity | No current instructions to launch a retired GUI; valid local links and scope claims |
| 3 | Complete core project/library setup and project content workflows through typed native owners: metadata, software/release/bindings, work/milestones | Explicit launcher grants, bounded DTOs, preview/commit, CAS/revision checks, no browser-selected absolute paths, no direct Node SQLite writes |
| 4 | Add user-facing web forms, readback, stale-preview handling, rejection and unknown-outcome recovery for the supported operations | Real-owner HTTP integration plus browser EN/VI journeys, conflict/refusal tests, session and navigation locking |
| 5 | Clarify at-rest protection, source/package boundaries, legacy MCP and research status; give optional integrations honest capability states | Documentation/capability checks; no claims of encrypted SQLite, live provider or telemetry acceptance |
| 6 | Rebuild and test TS/UI/API/native/Python/Go, package integrity, extracted runtime and publication preflight | Counts/skip accounting, source SHA, checksums; keep release draft and external acceptance gates open |

## Scope and safety

React + Vite remains the only UI. Qt Core/Sql is the native storage adapter, not
a desktop fallback. Existing owner authority, privacy vocabulary conversions,
transaction/revision rules and compatibility stores remain intact. No generic
shell, SQL, repository-upload or arbitrary filesystem-path HTTP endpoint is added.
Mutable operations require explicit local operator intent and typed review.

Core web workflows are the first implementation priority. Drive/provider OAuth,
live IoT, OS sandboxing, a shared service, production encryption and platform ports
are separate workstreams requiring their own authority/contract/acceptance. Do not
simulate successful live acceptance to close the audit. Optional Drive/Impact
integration scope may be extended by the owner's response during this work.

## Findings disposition

- A01: fix the empty-state UI and translations first.
- A02: rewrite active docs; preserve historical evidence under a clear status.
- A03: port supported core workflows and maintain a capability parity table;
  removed Qt canvas and unported optional panels must not be implied available.
- A04: state SQLite/DPAPI protection precisely; no silent store encryption/migration.
- A05/A07: preserve clean-Windows, independent operator and live-provider gates.
- A06: keep separate owners, schema checks and explicit migration, with regressions.
- A08/A09/A10: label legacy/reference/research, and distinguish source CLI from
  the fixed read bundles shipped in the browser runtime.

No merge, public tag or prerelease publication is part of this remediation.
Public branch/PR/draft updates require a clean reviewed commit and publish preflight.

## Implementation record

Core scope was confirmed by the owner; Drive and advanced Impact are deferred
to the [separate plan](2026-10-23-optional-integrations.md). Onboarding, active
documentation, library management, 13-category content editing and the regression
suites are implemented. Final packaging/verification records are published with
the candidate assets; external acceptance remains open. See [current QA](../releases/v0.2.0-alpha.1-qa.md).

Library metadata writes use a separate explicit launcher file, an exclusive
writer lease, original physical provenance and native CAS. A fresh library
bootstraps schema 1; further binding mutations require the reviewed upgrade.
Changing the database path for an existing ID is deliberately not a browser
“locate” shortcut. Source data is preserved and current-session access never expands.

Follow-up: actual Windows PowerShell 5 startup revealed Unicode JSON corruption.
Dedicated UTF-8 pipes and a real-helper regression cover launcher/doctor input
and output; packaged startup uses Vietnamese grants and Unicode directories.
Hosted hierarchy-probe failures are retained in history; bounded diagnostics and
noninteractive progress suppression preserve exact refusal assertions and guards.
