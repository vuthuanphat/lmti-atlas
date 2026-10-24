# LMTI plan and evidence index

**Current work (2026-10-24):** [startup, setup and recovery readiness](2026-10-24-startup-readiness.md)
after [core audit remediation](2026-10-23-audit-remediation.md). Use the
[browser capability matrix](../web-capabilities.md) for implemented scope. The
[browser-only ADR](../adr/2026-10-23-browser-only-ui.md) removes Qt desktop; old
plans to retain it are superseded. Qt Core/Sql backend ownership remains.

The [master plan](../LMTI_MASTER_PLAN.md) is the active
product-priority and milestone authority. Earlier stage IDs are historical;
unfinished gates below become work only through the master backlog. No report
or old plan independently authorizes another implementation branch.

The owner requested implementation and full retesting, with **no merge to main
or publication**. Clean Windows and independent operator acceptance remain open.
Live clients/providers/IoT retain their separate acceptance gates; controlled
replay is not live acceptance. Drive/OAuth and advanced Impact browser work are
[deferred](2026-10-23-optional-integrations.md).

## Current planning annex

The [current QA record](../releases/v0.2.0-alpha.1-qa.md) identifies the
2026-10-23 baseline `771fc40`, including successful hosted CI. Later source edits
require their own local/hosted verification; final merged/tag provenance is a
future gate. Old test counts and claims that hosted CI had not yet run apply
only to the dated records below.

| File | Role |
| --- | --- |
| [Startup readiness](2026-10-24-startup-readiness.md) | Current setup, reopen, session/recovery UX and documentation work; no merge/publish |
| [Audit remediation](2026-10-23-audit-remediation.md) | Implemented library/content scope and baseline checks |
| [Local operator guide](../local-web.md) | Current package setup, launch grants, session lifetime and recovery steps |
| [MVP build r6](2026-10-14-mvp-build-r6.md) | Dated build-first instruction and opt-in Agent reference projection |
| [WEB-03 continuation](2026-10-14-web-parity-execution.md) | Historical delayed/disconnected writes and Qt/web coexistence evidence |
| [Windows verification runner](2026-10-14-web-verification-runner.md) | Runner design and its original evidence; use current QA for later CI results |
| [500-project baseline](../benchmarks/2026-10-14-web-local-baseline.md) | Synthetic performance baseline; not platform/user acceptance |
| [Cursor discovery](2026-10-14-cursor-cli-discovery.md) | Historical actual CLI tool listing; not general Cursor/provider acceptance |
| [Web UI transition](2026-10-13-web-ui-transition.md) | Original browser decision, superseded for retained Qt UI by browser-only ADR |
| [API/security contract](2026-10-13-web-ui-contract.md) | Typed owner boundary and original route/preview/recovery/session contract |
| [Project MCP profile](2026-10-13-project-mcp-profile.md) | Profile/client contract; actual-client acceptance remains distinct |
| [M1 Agent layer packet](2026-10-13-agent-layer-m1.md) | Original authority/profile design and pilot cases |
| [Experience plan](2026-10-13-experience-plan.md) | Earlier UX reference; does not certify operator acceptance |
| [Impact evaluation](../impact-evaluation.md) | Separate feature protocol; old week labels are historical |

## Earlier scope and design records

These preserve the original rationale. Implemented behavior must be checked
against current owners, runbooks and dated evidence; old future-tense language
does not mean the component is still missing today.

| Scope/design | Current interpretation |
| --- | --- |
| [IoT platform survey](2026-10-11-iot-agent-platform.md) | Initial survey; use as reference for r3's bounded source-adapter design, not authority for unrestricted gateway/network expansion |
| [Consolidation/cleanup](2026-10-11-consolidation-cleanup.md) | Historical cleanup scope; compatibility and migration constraints retained |
| [Software/hardware projects](2026-10-11-software-hardware-projects.md) | Original S0–S5 scope, local slice implemented; remaining acceptance folded into M2–M4 |
| [Project library](2026-10-12-project-library.md) | Original L0–L3 scope; reuse library rather than restart its build |
| [UI optimization](2026-10-12-ui-optimization.md) | Original U1–U5 scope; not the next UX backlog |
| [UI refinement](2026-10-12-ui-refinement.md) | Prior operator feedback and implementation choices |
| [Management UI fix](2026-10-12-management-ui-fix.md) | Prior management-page adjustment |
| [26-screen design audit](2026-10-12-design-implementation.md) | Historical design implementation/evidence; screen count is not release success |
| [Evidence-backed change impact](2026-10-12-evidence-backed-change-impact.md) | Retained domain rationale; six-week order/estimates superseded by M0–M4 |
| [Simpler Studio](2026-10-13-simple-studio.md) | Latest UI reference build and evidence; operator acceptance outstanding |

## Execution evidence

Each record reports its own build/test scope and date. Passing tests do not
retroactively accept a later build, a user workflow or a business-value claim.

| Record | Evidence scope |
| --- | --- |
| [WEB-02 React/package](2026-10-13-web-react-execution.md) | Real owner browser flows, historical package/desktop coexistence, actual Codex web export, UI faults and dependency/build regressions; full cutover remains gated |
| [WEB-01 API](2026-10-13-web-api-execution.md) | Authenticated HTTP + real native/Python owner roundtrip; preview/export/apply/restore/handshake and native/Python regressions; backend evidence |
| [WEB-00 study](2026-10-13-web-ui-execution.md) | Synthetic interactive source, DTO check and static HTTP boundary checks; Chrome blocked local navigation, visual/operator review open |
| [Project MCP setup](2026-10-13-project-mcp-execution.md) | Profile/revision, parsers, merge/DPAPI/recovery, Qt setup/local probe and native-generated Codex read |
| [M2 native Agent layer](2026-10-13-agent-layer-m2-execution.md) | Common envelope, lookup/paging/relations, owner recheck, native processes and installed Codex client read; no live IoT/model-quality proof |
| [M1 Agent layer](2026-10-13-agent-layer-m1-execution.md) | Native/Python smoke and installed Codex client MCP tool read on synthetic metadata; no model turn or live IoT |
| [Cleanup](2026-10-11-cleanup-execution.md) | Baseline, boundaries and compatibility |
| [Projects](2026-10-11-project-execution.md) | Native project/work and SDK slice |
| [Library](2026-10-12-library-execution.md) | Local folder references and desktop navigation |
| [UI](2026-10-12-ui-execution.md) | Earlier desktop/knowledge bridge implementation |
| [Initial impact](2026-10-12-impact-execution.md) | TS impact/evidence slice |
| [Native impact](2026-10-13-native-impact-review.md) | Native snapshot, Qt review, persisted outcomes and scoped Agent boundary |
| [Google Drive](2026-10-13-google-drive.md) | Session reader/OAuth/broker tests; live login and release gates open |

## Architecture decisions

These accepted contracts continue to apply. A product-priority change does not
replace the architecture or broaden data access.

M1 additive design: [Agent–project layer](../adr/2026-10-13-agent-project-layer.md).
Its integrated runtime/pilot acceptance is pending; it does not supersede these ADRs.

Web presentation: [original ADR](../adr/2026-10-13-web-presentation.md) and
[browser-only superseding decision](../adr/2026-10-23-browser-only-ui.md).
React + Vite is the sole product UI. Retained Qt fallback/cutover requirements
are historical; native schemas and Agent/storage contracts remain intact.

- [Native topology](../adr/2026-10-11-native-topology.md)
- [Project document](../adr/2026-10-11-project-document.md)
- [Desktop knowledge](../adr/2026-10-12-desktop-knowledge.md)
- [Impact/evidence](../adr/2026-10-12-evidence-impact.md)
- [Native impact review](../adr/2026-10-13-native-impact-review.md)
- [Google Drive](../adr/2026-10-13-google-drive.md)
- [Project MCP profile](../adr/2026-10-13-project-mcp-profile.md)

## Historical proposals

- [r4 native MCP setup priority](../archive/2026-10-13-master-plan-r4.md)
- [Master plan before consolidation](../archive/2026-10-13-master-plan-before-consolidation.md)
- [Unaccepted r1 task/context-centered proposal](../archive/2026-10-13-master-plan-r1.md)
- [r2 standalone governance framing](../archive/2026-10-13-master-plan-r2.md)
- [r3 before project MCP priority](../archive/2026-10-13-master-plan-r3.md)
- [Coding-agent roadmap](../archive/coding-agent-roadmap.md)
- [Go memory roadmap](../roadmap.md)
- [Coding-agent MVP build spec](../LMTI_MVP_BUILD_SPEC.md)
- [Research RFC archive](../../rfcs/README.md)

The historical keep/cut lists and P/S/L/U/W stage orders are reference material.
Use current capability evidence and master milestones when selecting work.
