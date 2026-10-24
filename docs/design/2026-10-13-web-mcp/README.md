# LMTI WEB-00 browser study

Dependency-free, synthetic interaction study for the planned React UI. This is
not the React application, the local administration API or a connected MCP client.
No project data/config, credentials, accounts or live endpoints are accessed.
Changes exist only in the tab and reset on reload/scenario selection.

Start from the repository root:

```powershell
& scripts/start-web-preview.ps1
```

Open the URL printed by the launcher. Default is `http://127.0.0.1:8781/`.
If that port is occupied, use `-Port 0` to select a free loopback port. Existing
services are never stopped/replaced. The launcher returns the preview PID; stop
only that identified helper when finished. No automatic browser launch or changes
to browser security are performed by this script.

The server allows only the three UI files, index and `/preview-info`; `/api` and
all other paths/methods are rejected. Public synthetic study assets do not need
an operator session. The future administration API requires the separate
[session/security design](../../plans/2026-10-13-web-ui-contract.md).

## Review flows

- **Try a flow → Set up a new project:** add local LMTI context or plain HTTPS
  endpoint; inspect advanced scope/key; review and apply in each client.
- **Update an existing configuration:** inspect added/removed keys; simulate a
  configuration conflict; refusal must preserve the previous sample state;
  create a fresh preview, then apply. Switch projects to verify isolation.
- **Recover an interrupted update:** restore Codex, inspect unavailable Cursor,
  then check separate endpoint/auth/client evidence. No simulated authentication
  success is presented as real access.
- Switch EN/VI; navigate structure and activity; Escape closes dialogs and native
  dialog focus returns to its trigger. Browser checks still require evidence.

Config outlines are illustrative, not exportable native-generated configurations.
Connection validation is a study aid; native/Python owners remain authoritative.
Product frontend must never import this fixture state machine or emulate writes.
Use [api-contract.ts](api-contract.ts) and the owner inventory to build the live
boundary at WEB-01/02. Keep `.gitignore` for env/credentials/client runtime and
run `lmti publish preflight` before any push/PR/release.
