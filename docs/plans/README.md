# LMTI plan and evidence index

Updated 2026-10-14. The [master plan](../LMTI_MASTER_PLAN.md) is the only active
product-priority and milestone authority. Earlier stage IDs are historical;
unfinished gates below become work only through the master backlog. No report
or old plan independently authorizes another implementation branch.

Current r6 continues the MVP build before live client/provider and independent
operator acceptance, as the owner requested on 2026-10-14. Those acceptance
gates still control release/cutover; they no longer block M2/M3 implementation.
WEB-00 now has a synthetic
browser study and contract; browser/owner UX review remains open. WEB-01 native
façade/local API and WEB-02 React/package are implemented and tested through real
owners. WEB-03 operator/client/cutover gates are deferred until the MVP is ready. Existing owners and Qt fallback
are retained. The first web
slice uses a project MCP profile shared by Codex and Cursor, with
project context, infrastructure and real read-only IoT remaining the broader
Agent–project direction. CP-01 profile/owner ADR, adapters and UI are implemented
locally; native-generated Codex read is checked. Actual Cursor/operator/provider
acceptance is pending. Native
M2 read remains implemented. Live-pilot choices, cross-source mapping, workload,
model/operator and IoT acceptance remain open; r1–r4 priorities are historical.

## Current planning annex

[MVP build r6](2026-10-14-mvp-build-r6.md) records the owner's build-first
instruction and the new opt-in Agent reference projection, with native/SDK/API
checks. Cross-owner contents, integrated UI/proposals and observations remain
build work; live/operator acceptance follows afterward.

[WEB-03 continuation](2026-10-14-web-parity-execution.md) adds the packaged
runtime/integrity doctor and real delayed/disconnected owner-write evidence.
Cursor Editor is not installed; cutover/operator/provider gates remain open.
It also records coordinated real Widgets/package API/React revision conflicts,
cross-interface apply/restore and scoped C++/Qt regressions; full parity/history
and independent operator acceptance remain open.
The [locked local baseline](../benchmarks/2026-10-14-web-local-baseline.md) records
500 synthetic projects and the owner metadata projection; performance/user
acceptance thresholds and real-pilot gates remain open.
The [Windows verification runner](2026-10-14-web-verification-runner.md) prepares
the same selected package/runtime checks for local builds and CI; remote clean
runner execution is not yet evidenced.
The [Cursor CLI discovery record](2026-10-14-cursor-cli-discovery.md) now shows
the official isolated client listing the four tools from the latest packaged
web export. Cursor scoped reads/Editor acceptance remain open; Codex scoped reads
were also rechecked against that package.

| File | Role |
| --- | --- |
| [Web UI transition](2026-10-13-web-ui-transition.md) | Owner selected local browser; WEB-00–02 implemented; operator/parity gates open |
| [API/security contract](2026-10-13-web-ui-contract.md) | Typed DTOs, implemented WEB-01 route/preview/recovery/session semantics; browser/operator gates open |
| [Project MCP profile](2026-10-13-project-mcp-profile.md) | Current CP-01 workflow and local implementation; actual Cursor/operator/providers open |
| [M1 Agent layer packet](2026-10-13-agent-layer-m1.md) | Current contract/authority/profile design, prototype and acceptance cases; pilot gates open |
| [Experience plan](2026-10-13-experience-plan.md) | Earlier connection prototype superseded by CP-01; retained structure/IoT/review reference, UX unaccepted |
| [Impact evaluation](../impact-evaluation.md) | Retained protocol for the impact feature; not the gate for the whole product; old week labels are historical |

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
| [WEB-02 React/package](2026-10-13-web-react-execution.md) | Real owner browser flows, package/Qt fallback, actual Codex web export, UI faults and dependency/build regressions; full cutover remains gated |
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

Web presentation: [ADR and local implementation status](../adr/2026-10-13-web-presentation.md).
Browser local is owner-selected and WEB-01 operator boundary is implemented;
React presentation is implemented; default cutover remains gated. It changes the Qt-primary presentation only after parity;
it does not supersede native schemas or Agent/storage contracts.

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
