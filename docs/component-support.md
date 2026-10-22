# Component support and ownership

Planning update 2026-10-13: [master r5](LMTI_MASTER_PLAN.md) prioritizes a
[local browser UI transition](plans/2026-10-13-web-ui-transition.md), retaining a project
MCP profile shared by Codex/Cursor, retaining the Agent–project/context direction
and large-project/read-only IoT scope. CP-01 profile owner/client adapters and
UI are local-alpha implementations; actual Cursor/operator/live providers and
gateway enforcement remain unverified. This map separates
implemented components from the proposed path. Old milestone names are historical.

Date: 2026-10-11. This is the current implementation map under the
[master plan](LMTI_MASTER_PLAN.md) and [native topology ADR](adr/2026-10-11-native-topology.md).
It records local-alpha support, not a production certification.

## Component map

| Component | Owner / role | Status | Entry point and evidence |
| --- | --- | --- | --- |
| `apps/web-api` / `lmti-mcp-admin` | Operator session/scope/DTO and bounded calls to native/Python owners; no direct SQLite or arbitrary shell | WEB-01 API/console façade implemented; actual owner HTTP tests; operator/cutover acceptance open | [Guide](../apps/web-api/README.md); [evidence](plans/2026-10-13-web-api-execution.md); [ADR](adr/2026-10-13-web-presentation.md) |
| `apps/web-ui` / local web package | React MCP/Structure/evidence and desired-configuration review, in-memory operator capability, same-origin assets; no domain/storage ownership | WEB-02 implemented; isolated browser setup/update/recovery, EN/VI, package and Codex export checks; full WEB-03 cutover gated | [Guide](local-web.md); [evidence](plans/2026-10-13-web-react-execution.md) |
| Project MCP profile / Codex and Cursor adapters | Typed nonsecret definitions, config generation/merge/apply/restore, DPAPI backup and local handshake; client-owned OAuth | Implemented local alpha; Codex synthetic read checked; actual Cursor/operator/providers open; **not a proxy/enforcement service** | [Guide](project-mcp.md); [evidence](plans/2026-10-13-project-mcp-execution.md) |
| python/src/lmti_agent + native snapshot SDK | Scoped common envelope, paginated declared inventory/relations, identity lookup, session-bound cursors, owner recheck | Implemented local-alpha M2 native read slice; cross-source/live/model/scale acceptance open | [Guide](agent-layer.md); [M2 evidence](plans/2026-10-13-agent-layer-m2-execution.md) |
| M1 Agent/client feasibility | Contract/authority design, synthetic prototype and isolated native/installed Codex client smoke | Design and local client evidence; full M1/pilot acceptance open | [M1 packet](plans/2026-10-13-agent-layer-m1.md); [execution](plans/2026-10-13-agent-layer-m1-execution.md) |
| Integrated cross-source Agent contract | Native structure, mapped public compiled summaries, explicitly disclosed owner-safe memory and read-only replay in a common envelope | Implemented local alpha with real process tests; live/model/pilot acceptance remains open | [Integrated evidence and setup](plans/2026-10-19-integrated-mvp.md); distinct owner versions, permissions and evidence |
| Controlled replay observation adapter | Bounded replay read; sample/receive time, TTL, quality, sequence and source revocation; separate from project revisions/memory | Implemented and labeled controlled replay; **no live IoT adapter or evidence** | [Contract/tests](plans/2026-10-19-integrated-mvp.md); live source/protocol/pilot selection remains required |
| `@atlas/drive` / `drive-desktop` / `DriveKnowledgePanel` | Isolated session OAuth and selected-folder local document reader | Experimental; publisher OAuth config/live verification required | [Drive guide](google-drive.md); synthetic provider/OAuth/protocol and Qt tests; no AI egress or document storage |
| `native/core`, `native/include` | C++ typed topology, validation, revision/proposal rules | Active Studio development | Core CTest; no Qt dependency |
| `native/storage`, `native/cli` | Qt Core/Sql SQLite transactions and JSON boundary | Active Studio development | `lmti-topology`; storage CTest |
| `lmti_project_core`, `lmti_project_storage`, `lmti-project` | Typed software/hardware project/work domain and separate LMPR SQLite adapter | Experimental Projects MVP | Project CTest, bounded context/impact, immutable releases and work proposals |
| `project_library` adapter / `ProjectLibraryView` | Separate LMLB local folder index and paged desktop view | Experimental library alpha | Folder creation/linking, pins/search/locate; no Agent authority or repository scanning; English/Vietnamese UI |
| `apps/desktop` | Current Qt Widgets editor/MCP setup, document history and proposal review; fallback during planned web migration | Experimental local MVP; retained until WEB-03 | `lmti-desktop`; offscreen QtTest, manual operator check still needed |
| `KnowledgePanel` / TS `desktop-bridge` | Versioned local knowledge boundary; TS memory owner retains storage/policy | Experimental U4 | Explicit source identity, read-only schema-v4 snapshot, bounded external task context, opt-in atomic lesson review |
| Native snapshot / `ImpactPanel` / TS impact owner | Scoped saved LMPR projection; separate LMIP review/history storage | Experimental native impact slice | Exact document/binary boundary, declared-only graph, explicit operator verification; [execution record](plans/2026-10-13-native-impact-review.md) |
| `python/src/lmti_topology` | Scoped SDK and MCP stdio transport | Experimental local MVP | `Client`; `python -m lmti_topology.mcp`; Python/native process tests |
| `python/src/lmti_project`, `lmti_common` | Project/site grants and dependency-free shared validation; topology MCP transport reused explicitly | Experimental Projects MVP | Project SDK/MCP, non-writing review/blocked proposals; native/process integration tests |
| TS `memory`, `privacy`, `compiler`, `graph`, `kernel`, `types` | Project understanding, memory lifecycle, context and policy | Active project-memory path | `lmti compile/context/preflight/memory/task`; TS tests |
| TS `frameworks`, `migration`, `cli`; `schemas`, `skills` | Verification, CLI adapters, storage diagnostics, skill instructions | Active with experimental subcommands | Framework/CLI tests; publish gate and Thoth validation |
| `@atlas/runtime/agent` | Mind context, lesson proposals and Action View | Existing experimental helpers used by CLI | `agent.ts`; mind/action/runtime tests |
| `@atlas/runtime/demo` | Sample agents, session memory and demo tools | Reference; expansion frozen | `demo-runtime.ts`; playground/runtime smoke tests |
| Runtime package root | Compatibility export of agent and demo APIs | Retained | Existing app imports keep working |
| TS `cognition`, `world-model` | Existing diagnostic command semantics | Experimental; expansion frozen | Live CLI imports and tests; not archive candidates yet |
| TS `context`, `security`, `tools`, `agents` | Reference session loader, tool guard and demo adapters | Reference with live consumers | Runtime/demo dependency graph; do not delete by folder name |
| TS `mcp` | Project-memory handler stub without transport | Legacy reference; expansion frozen | `createLmtiMcpStub`; not replaced by topology MCP |
| `apps/playground`, `apps/codex-assistant` | Terminal reference scenarios | Reference | Root convenience scripts; outside primary Studio quickstart |
| `cmd/lmti`, `internal`, `pkg` | Go config/memory/privacy/skill/publish compatibility | Experimental; no new topology domain | `go run ./cmd/lmti`; Node SQLite bridge; Go tests |
| Reasoning placeholder | Historical empty trace implementation | Archived outside workspace | `research/archive/reasoning`; no source consumers found |

Native, TS and Go components do not import each other's private storage models.
The topology Agent boundary does not expose store handles. Reference runtime
demos still pass in-process memory helpers to sample agents; they are not a
supported boundary for external agents. Trusted-launcher scope does not provide
an OS sandbox against the same filesystem user. Live observation is planned
through scoped source adapters. Collector/gateway and shared service choices
depend on the pilot; encryption and multi-user RBAC are not implemented here.
Device dispatch is outside the first release.

Software/hardware project management now has an implemented local-alpha slice:
[Projects, software/releases/bindings and work/milestones](plans/2026-10-11-software-hardware-projects.md).
Its screens live in ProjectWindow, which composes the existing topology editor;
its versioned CLI/SDK does not replace TypeScript project memory. See the
[Projects guide](project-studio.md) and [project ADR](adr/2026-10-11-project-document.md).
The privacy-reviewed memory source bridge is implemented as a separate, explicitly
connected adapter; unmapped knowledge references remain unloaded metadata. Explicit integrated mappings can return owner-filtered summaries. See its
[ADR](adr/2026-10-12-desktop-knowledge.md) and [UI evidence](plans/2026-10-12-ui-execution.md).
Production/acceptance gates remain separate.

## Commands and stores

| Command / reader-writer | Domain and store | Lifecycle / boundary |
| --- | --- | --- |
| TS `compile`, `inspect`, kernel context | Project Atlas/AMF | Compiler artifact; regenerate from allowed source; memory is separate |
| TS `remember`, legacy `memory --scope ... --legacy` paths | Legacy `.lmti/memory/*.json` | Compatibility readers/writers; preserve until lossless migration |
| TS `context`, `preflight`, MCP reference reads | Memory owner readonly API; SQLite preferred if present, explicit JSON compatibility | No implicit merge/migration; privacy before ranking; compiler freshness checked; preflight audit remains |
| TS `impact`, Qt Impact page, Python impact MCP, local review page | Separate LMIP SQLite schema 2; v1 read compatibility; synthetic/nonsecret only | Native owner snapshots, source review, immutable saved reports, append-only human outcomes; explicit backup migration; Agent reads only; [runbook](impact-review.md) |
| Default TS `memory search/retrieve`, lessons, short notes, mind | `.lmti/memory/project-memory.sqlite`, schema v4 | Write/retrieval privacy gates; reviewed lessons and TTL/promotion |
| TS `memory migrate-json --dry-run` | Read-only inventory of legacy scopes | Counts only, no content; writes blocked while lossless mapping is incomplete |
| Go `memory`, `migrate from-json --dry-run` | `.lmti/memory.sqlite`, Go schema via Node bridge | Experimental independent inventory; import writes blocked pending lossless mapping |
| Runtime session demo | InMemoryStore | Reference session state, not durable project memory |
| Runtime Action View | `.lmti/actions/codex-actions.sqlite` | Local experimental observability; separate from memory and topology |
| Desktop open/save; native scoped reads | Operator-selected topology SQLite, application/schema ID | Optimistic revision + transaction; public/internal nonsecret metadata only |
| Desktop project/library adapters | LMPR document; LMLB local folder index; legacy LMCA recent catalog | Library refs never exported; one-time import preserves old catalog; removing a ref preserves source; UI language setting is separate |
| Python topology context/asset/proposal | Saved topology via native CLI | Launcher site/model target; proposal does not write DB or dispatch |

One implementation owns each schema/version; transactions coordinate multiple
instances. No store is removed or merged by this cleanup. Generated JSON
artifacts and active JSON compatibility data have different lifecycles.

## Contract coverage

| Invariant | Existing executable coverage | Outstanding gate |
| --- | --- | --- |
| Secret/do_not_prompt denied, egress redacted | Privacy, memory, kernel and CLI tests | Lossless policy mapping before legacy import writes resume |
| Lesson candidate requires privacy/evidence/review | Memory/CLI lesson tests | Do not reinterpret legacy lessons as approved records |
| Context relevant and bounded, evidence retained | Kernel/framework/mind tests; native/Python bounds/scope tests | Performance budget and freshness for live telemetry |
| Proposal cannot write or dispatch | Python/native tests; revision/site/old-value rejection | Actual product-Agent + manual operator acceptance |
| Domain/core replaceable | Qt-independent core target, runtime agent/demo separation, acyclic dependency tests | Future service/provider isolation needs separate design |
| Failed migration does not mutate stores | Memory migration guard tests; CLI smoke in disposable fixture | Schema mapping, consistent backup, cutover and post-cutover rollback |
| Publication protects runtime paths | CLI publish tests and documented preflight | Run actual publish preflight before push/PR/release/remote work |

Test commands and required versions are in [development](development.md).
Current local evidence and explicit deferred gates are in the
[cleanup execution report](plans/2026-10-11-cleanup-execution.md).
Library implementation and UI-language evidence are in the
[library execution report](plans/2026-10-12-library-execution.md).
