# M1 Agent layer — local execution evidence

Date: 2026-10-13. Scope: [M1 packet](2026-10-13-agent-layer-m1.md),
under [master r3](../LMTI_MASTER_PLAN.md).
Status: **local design/client feasibility delivered; full M1 acceptance remains open.**

## Changes

- [Boundary ADR](../adr/2026-10-13-agent-project-layer.md): separate owners,
  local Codex/stdio profile, authority/identity, consistency, observation strategy
  and threat model. Existing ADRs/runtime schemas remain in force.
- [Agent contract](../agent-layer-contract.md) and
  [request/response fixtures](../design/2026-10-13-agent-layer/contracts.json):
  design only; common envelope is not yet a deployed MCP API.
- [Interactive prototype](../design/2026-10-13-agent-layer/index.html):
  connection, linked project, human review; unknown/stale/unavailable/revoked and
  stale proposal states. Static synthetic design, not the shipped Qt app.
- [Smoke tool](../../scripts/m1-agent-smoke.py): creates a new synthetic project,
  reads through native/Python APIs, checks scope/revision/declared semantics,
  denied overrides, partial context, absent locators and unchanged source bytes.
- Optional installed Codex probe: discover a two-read-tool allowlist, create an
  ephemeral client thread and call project_context. No model turn or delegated
  Agent task is started; global config is not edited.
- M1 packet: 16 acceptance cases, authority mapping, fixed D0 fixture workload
  and explicit pending real-pilot workload/oracle.

No Qt/C++ runtime, TS/Go memory, user store or project window was changed.
No package was installed, real IoT/Drive accessed or publication performed.

## Environment and evidence

| Item | Result |
| --- | --- |
| Python | 3.14.2 |
| Codex | codex-cli 0.162.0-alpha.17.2 |
| Native | build/studio-simple-20261013/bin/lmti-project.exe |
| Native SHA-256 | 8DDB8E06D9995A3D6EB29C3D6138A91E1FE92EC84DBF6BC303CE0E1BC26F8BEB |
| MCP protocol | Existing native 2025-06-18 accepted by installed client |
| Native smoke | Eight checks passed; final source digest unchanged after client read |
| Codex | Only project_context/project_impact discovered; tool read matched fixture project/site/revision |
| SDK/process regression | test_project.py: 4 passed, 0 skipped |
| Syntax | Python compile and prototype JavaScript syntax checked |
| Model / IoT / value | modelTurn=false; liveIoT=false; businessValue=unmeasured |

Per-run JSON/config/database evidence remains in ignored build/m1-smoke-*/.
Codex protocol schema inspection remains in build/m1-codex-protocol-20261013/.
Local config snippets include machine paths; do not publish as portable config.

Probe follows [official App Server documentation](https://learn.chatgpt.com/docs/app-server);
settings follow [official MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).
Only this client/version/profile was tested. App-server may use local Codex
infrastructure/cache; this is not an OS-isolated client.

## Remaining gates

- No model solved the release scenario; only client protocol/owner reads ran.
- New envelope is design; schema/parser runtime and source-owner mapping are M2.
- Prototype awaits human UX acceptance.
- No permitted real site/device/provider, account, metrics or telemetry workload
  is selected yet. No scale, clean-machine, multi-user, encryption or value proof.
- Source/code mapping and direct identity lookup/pagination remain M2 work.

M1 is not complete while pilot/prototype gates are open. Missing device details
do not authorize choosing a provider or widening permissions. Request only
platform/protocol/device descriptions; credentials stay outside chat/code/graph.

