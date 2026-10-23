# Deferred Drive and advanced Impact browser work

Status: planned, not implemented by the core remediation. The owner explicitly
selected core project/library/content workflows first on 2026-10-23.

## Drive

1. Specify an operator-only web contract for selected-folder read sessions,
   publisher configuration and OAuth lifetime/revocation. Keep credentials out of
   project metadata and model context; authentication remains a human action.
2. Adapt the existing Drive owner through fixed commands and bounded DTOs; do not
   expose arbitrary paths, provider APIs or automatic AI egress.
3. Add consent/source/freshness/revocation presentation in React, with unavailable,
   expired, canceled and denied states. Removed Qt panels are historical only.
4. Test synthetic provider failures and revocation, then obtain independent live
   OAuth/provider acceptance before any claim of working production connectivity.

## Advanced Impact

1. Define browser access to the existing scoped source review/report/history owner,
   keeping LMIP separate from project memory and the native project store.
2. Preserve exact source revisions, explicit verification, immutable reports and
   append-only human outcomes; no browser-supplied source path authority.
3. Add source selection, report review, evidence/history and bounded pagination,
   with stale-source rejection and unknown-write recovery where writes are added.
4. Test real owners and withheld/private/stale/changed sources, then run an
   independent operator journey. CLI/SDK/local review page availability does not
   imply a connected React panel.

No live IoT, device execution, encryption migration, shared service or retired Qt
canvas is implicitly added by these plans. Each requires its own accepted
contract, authority and verification scope. See [capabilities](../web-capabilities.md).
