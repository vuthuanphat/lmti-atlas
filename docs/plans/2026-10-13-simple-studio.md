# A simpler Studio interface

> Planning status, 2026-10-13: this is a dated scope/evidence record.
> The [consolidated master plan](../LMTI_MASTER_PLAN.md) owns current priorities
> and M0–M4 milestones. Earlier stage orders and unfinished work below are
> reference material, not a separate active backlog. Accepted architecture and
> recorded evidence remain valid within their stated scope.

Requested 2026-10-13: simplify the whole desktop after operator feedback that
the interface is cluttered compared with ChatGPT. This is a presentation slice.

The change improves understanding through fewer simultaneous decisions,
reduces repeated navigation, retains reusable project/context owners, preserves
privacy controls and evolves independently of storage, OAuth and Agent logic.
The weakness is that an inactive screen currently shows every future control,
and the Knowledge source banner is incorrectly attached to the Drive page.
The risk of simplification is hiding capabilities or permission disclosures.
Every existing page therefore remains reachable, while security consent stays
explicit before sign-in and state-specific actions remain guarded.

## Accepted scope

* A quiet, neutral shared shell. Five everyday destinations: Overview, Work,
  Architecture, Knowledge and Agent; specialist inventory/release/review pages
  stay under More tools. A directly opened specialist page stays visible.
* Overview offers one primary action and expands secondary setup actions.
  Existing typed project operations are reused; no pretend chat/model calls.
* Library keeps creation primary and moves file/folder utilities into a menu.
* Drive shows connect first, then folder choice, then documents. Unavailable
  controls and empty document panes do not occupy the disconnected screen.
* Knowledge only shows local-source controls on local-source pages.
* EN/VI, keyboard access, dirty drafts, stable page IDs, provider isolation and
  existing verification/privacy gates remain part of the implementation.

Qt UI regressions, state transitions and synthetic screenshots will verify
the implementation. Use a separate build/package; do not close the operator's
running window with unsaved edits. Operator acceptance remains necessary after
the new interface is actually viewed; screenshots are not acceptance.

## Execution evidence

* Native Release build and local package passed: `build/studio-simple-20261013`.
* **6/6 CTest groups passed**. Qt outcomes: main desktop **37**, Drive **33**,
  impact **7**, with zero failures/skips. Logs: `build/simple-ctest-verified.log`.
* Regression checks preserve typed document state, specialist page access,
  filter/language state, separate knowledge providers and pre-login consent.
* A compact search-width regression was fixed by retaining a dedicated search
  row. Drive button translation now respects real height-for-width support.
* Reviewed synthetic VI captures for Overview, Software and Project library,
  plus staged Drive views under `build/simple-evidence-20261013/`.
* No TS, domain storage, OAuth provider, Agent grant, network or dependency change.
  Google OAuth publisher configuration remains required for a live connection.

Proposed safe lesson: reveal secondary controls when their workflow stage is
active, and keep consent visible at the decision point. No raw chat/documents
were stored as memory and no lesson was automatically approved.
