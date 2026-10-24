# Google Drive quick-connect execution record

Date: 2026-10-13. Local alpha; live Google consent is not yet verified.

## Delivered boundary

The requested end-user flow is Connect Google Drive → browser login → choose
folder → local document preview. OAuth registration/configuration belongs to
the LMTI publisher, not the user. An unconfigured package reports its state
and never simulates a successful login.

* `@atlas/drive`: installed OAuth/PKCE, session token lifecycle, fixed provider
  endpoints, bounded folder/document reader and current permission checks.
* `drive-desktop`: separate persistent JSONL process, strict project/session
  identities, operation allowlist, sanitized errors and bounded I/O queues.
* `DriveKnowledgePanel`: Knowledge tab, scope disclosure, folder picker,
  pagination, local plain-text preview, disconnect, EN/VI captions, stale
  response rejection and project-change cancellation.
* Build/launcher accept publisher public client config; no new registry
  dependencies, native storage schema, Agent tools or device actions.

The [ADR](../adr/2026-10-13-google-drive.md) and [guide](../google-drive.md)
record Google's account-wide readonly scope versus LMTI's folder gate,
supported formats, session-only behavior and publisher prerequisites.

## Evidence

* Full TypeScript composite build passed.
* Full package suite: **383 tests, 32 files passed**, with two workers.
  An earlier simultaneous native compilation/full parallel test run hit
  three existing five-second test deadlines; the bounded-worker rerun passed
  without changing assertions or test timeouts.
* After the final UTF-8 BOM correction, the focused suite passed **82 tests**:
  provider **43**, OAuth **22**, broker **17**. The content hash covers emitted
  UTF-8 text, matching Qt verification even when a source file contains a BOM.
  Synthetic data covers ancestry/version/permission races, cancellation,
  PKCE/state, callback limits, token refresh, response bounds, stale identities,
  credential redaction, malformed framing and output backpressure.
* Native package: `build/studio-drive-20261013`; source launcher remains required.
* Final native build passed; **6/6 CTest groups passed**, including existing
  desktop **36**, impact **7** and Drive **32** QtTest outcomes, all zero skips.
  The Drive group includes the real broker's configured/missing-config status
  handshake without authentication, plus malformed/stale response and browser
  URL checks. A discovered VI button-height issue was fixed; notice visibility
  and nonoverlap are now asserted across EN→VI→EN changes.
* Synthetic compact screenshots reviewed: `drive-local-view-{en,vi}.png` and
  `drive-setup-missing-{en,vi}.png` in the evidence directory. They are fixture
  views, not evidence of real Google account access.

Artifacts are local and ignored: `build/drive-ts-tests-final.log`,
`build/drive-focused-tests-final.log`, `build/drive-ctest-verified.log`,
`build/drive-ctest-focused-final.log`, `build/drive-evidence-20261013/`.
Tests never authenticate a real Google account or open a real login browser.

## Outstanding release evidence

Publisher OAuth registration/consent verification, a real account login/read,
clean Windows installation and a standalone signed runtime bundle remain
outstanding. No production readiness, Google ACL folder restriction or AI
knowledge ingestion is claimed. The existing running Studio project has
unsaved edits and was left open; the new package is isolated.

## Safe lesson candidate

Keep external-document authorization in a provider-owned session, separate
from AI context export. Test the real UI-to-broker status handshake as well
as fake provider responses, so environment capability mismatches cannot be
hidden by mocks. This is a proposed lesson only; no raw chat or Drive data
was stored in memory and no lesson was automatically approved.
