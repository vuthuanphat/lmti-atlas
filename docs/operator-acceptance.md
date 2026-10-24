# Operator acceptance — v0.2.0-alpha.1

This is a test procedure, not a passed acceptance report. Use a fresh disposable
workspace and synthetic nonsecret data. Independent operator and clean-Windows
acceptance remain pending until a tester records the results below for the exact
candidate. Maintainer browser checks and CI do not replace either gate. The
current owner instruction forbids merging main, tagging or publication.

Follow the [local setup guide](local-web.md) from the trusted extracted package.
Do not use a live repository, existing Studio data or an operational `.lmti/`
directory. Node 24+ x64, Python 3.11+ x64 and the compatible Microsoft C++ runtime
must be installed beforehand. There is no automatic installer or execution-policy
bypass. Preserve failed test workspaces for inspection.

## Record before testing

| Field | Tester entry |
| --- | --- |
| Tester and relationship to implementation | Pending |
| Date/time and time zone | Pending |
| Source commit and package manifest SHA-256 | Pending |
| ZIP SHA-256 compared with supplied checksums | Pending |
| Windows edition/build, architecture and clean/existing installation | Pending |
| Node, Python, MSVC runtime and browser versions | Pending |
| Test workspace identifier, without private paths | Pending |

Keep private paths, launch URLs, tokens, personal configuration and raw logs out
of public reports. Screenshots should show only synthetic data and no address-bar
bootstrap fragment. Record each result as Pass, Fail or Not run with a reason.

## Test one step at a time

1. **Verify and cancel setup.** Double-click package-root `LMTI.cmd` or run
   `scripts/setup-local-web.ps1`, choose a new
   workspace path and demo mode. Inspect the displayed grants, then cancel
   instead of typing `CREATE`. Confirm that no workspace was created. Record
   prerequisite or policy failures as failures to start, without bypassing them.
2. **Create a demo.** Run setup again and confirm `CREATE`. Verify Factory Monitor,
   ID `factory-monitor`, appears. Switch EN → VI → EN and check Unicode text,
   navigation and error-free loading. If main JavaScript cannot load, the initial
   HTML must give EN/VI reopen guidance rather than a blank screen. Record the
   failure; this fallback is not a successful application start.
   The demo does not prove a client/provider
   or live IoT connection. No Qt fallback instruction should appear.
   For step 6, explicitly choose maintenance and retain the default four approved
   source folders during setup; confirm the additional folders are empty and local.
   This choice does not perform a library upgrade automatically.
3. **Reopen a private tab.** Keep the operator console open. Enter O and press
   Enter; the new tab should load the same scoped project. Refreshing a tab or
   opening an old URL must not create a new session. If a session ends, use O.
   Do not copy the private launch URL into the test report.
4. **Review without writing.** In Work, inspect the library and project-content
   panels. Start a harmless content edit on synthetic data, review the proposed
   changes, then reject/cancel. Refresh the current state and confirm the record
   and revision did not change. Navigation should unlock after rejection.
5. **Confirm a known write.** Create a uniquely named synthetic work item, such
   as `acceptance-task-1`, with a Vietnamese title. Inspect the preview, confirm
   once and wait for a definite result. Read it back and verify the expected
   revision change. Switch EN/VI and confirm the success message and stored title.
   If the outcome is pending or unknown, stop here and follow step 8; do not retry.
6. **Create a second project and check explicit scope.** With the separately
   granted maintenance scope, inspect the library version, review the required
   **Library upgrade**, its backup and confirmation, then read back the result.
   In **Create project**, choose an unused approved folder, such as `source-2/`
   (key `workspace-source-2`), create one synthetic project and record its ID.
   The initial `source/` is already bound and must not be reused. If maintenance
   or a spare folder was not granted, record Not run; do not widen saved JSON.
   A new O tab or default saved opener must retain the original IDs.
   Use Q to drain the older console before starting a different selected session.
   Use `open-local-workspace.ps1 -WorkspaceFile <profile> -ProjectId <registered-id>`
   for read-only project content; saved library-management/maintenance grants
   remain active. Add the `-GrantProjectContent` switch only after
   reviewing that edit grant for all selected IDs. Check `-ValidateOnly` returns
   the intended selected/content IDs.
   Never edit the saved JSON to widen rights. If a library upgrade is needed,
   it requires the separately granted maintenance scope and reviewed preview.
7. **Stop and reopen cleanly.** With no pending writes, enter Q and press Enter.
   The service should drain and stop. In the old tab, request current state or
   another status/read; that failed request must show a useful connection or
   session message. No automatic heartbeat or immediate stop notification is
   promised. Its service connection check must not repeat a write. Reopen the
   workspace using `Open-LMTI.cmd` and confirm the saved record remains present.
   Closing a tab alone is not a cancellation or shutdown mechanism.
8. **Handle writer/recovery states if present.** If writer busy is shown, stop
   the older known workspace console with Q, wait for accepted writers and use
   **Check writer admission**. If recovery is required, review fresh evidence
   for the original target, then acknowledge it separately if appropriate.
   Admission is not proof of the prior write result, which may remain unknown.
   Never force-kill, delete marker/lock files, repeat an uncertain write or
   acknowledge unreviewed recovery. If this state is not present, record Not run;
   do not claim a crash/recovery drill passed from a clean shutdown.
9. **Try an empty project separately.** Run setup with `-Mode empty` in another
   new workspace, choose a valid ID/name and check the empty project loads with
   actionable guidance. An unavailable owner must be distinguished from empty
   data; do not reinitialize an existing workspace to clear an error.

## Record the outcome

| Step | Pass / Fail / Not run | Observed result and safe evidence reference |
| --- | --- | --- |
| 1 — Review and cancel | Pending | |
| 2 — Demo and EN/VI | Pending | |
| 3 — Fresh private tab | Pending | |
| 4 — Reject without writing | Pending | |
| 5 — Confirm and read back | Pending | |
| 6 — Reviewed upgrade/create and explicit selection | Pending | |
| 7 — Graceful stop/reopen | Pending | |
| 8 — Writer/recovery | Pending | |
| 9 — Empty project | Pending | |

Record failures with the visible message, step, expected/actual result and a
sanitized screenshot. Stop dependent writes after an unknown outcome. A second
person must review unresolved failures and any Not run release-critical step.
Record clean-Windows results separately if this run used an existing development
machine. Completing this form does not authorize merge or publication.
