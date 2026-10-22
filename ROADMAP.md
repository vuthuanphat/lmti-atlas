# LMTI roadmap

The [master plan r5](docs/LMTI_MASTER_PLAN.md) is the only active product plan.

The owner selected **local web, opened in a browser**. The
[UI transition plan](docs/plans/2026-10-13-web-ui-transition.md) proposes a
React/TypeScript SPA over a thin Node.js local API. [WEB-01](docs/plans/2026-10-13-web-api-execution.md)
implements the owner façade/authenticated API; [WEB-02](docs/plans/2026-10-13-web-react-execution.md)
implements React MCP setup and local packaging. Browser flows use real owners on
synthetic data; owner UX acceptance and WEB-03 cutover gates remain open.

**LMTI manages project MCP connections and understanding for AI Agents.** The
owner selected one project MCP profile used by Codex and Cursor as the next
workflow. [CP-01](docs/plans/2026-10-13-project-mcp-profile.md) defines screens,
profile/client adapters and acceptance. [Local implementation](docs/project-mcp.md)
and native-generated Codex read are checked; actual Cursor/operator/providers
remain open.
It also links large-project structure, code, design/document references,
infrastructure and real IoT observations with source authority, freshness and scope.
The human UI configures sources/permissions, inspects mappings and reviews proposals.

The owner selected large-project coverage and real read-only device state in the
first release. WEB-00–03 moves CP-01 setup to web before further cross-source/IoT
expansion. The r5 web contracts and acceptance thresholds
are proposals for review, not claims of implementation or universal compatibility.

| Stage | Required outcome |
| --- | --- |
| M0 — Consolidate direction | Master r5; local browser selected, MCP workflow preserved; detailed web design acceptance open |
| M1 — Contract and pilot design | Agent-client smoke through the existing boundary, source authority/identity, tool envelopes, read-only IoT source, UX prototype, workload and evaluation protocol |
| CP-01 — Project MCP setup | One revision creates project configurations for Codex and Cursor; preview/merge/recovery, no secrets in exports, real client proof and operator acceptance |
| WEB-00 — UX and API contract | Review setup/update/recovery prototypes, owner operations, session/security and dependencies |
| WEB-01 — Local owner façade/API | Native profile/library CLI plus Node broker, bounded fixed owner calls and authenticated same-origin access |
| WEB-02 — React MCP slice | Project switcher, profile CRUD and real client preview/apply/restore/status through the local API |
| WEB-03 — Parity and cutover | Qt/web revision conflicts, actual clients, recovery, second operator, packaging and rollback before default changes |
| M2 — Agent understands structure | A real Agent queries linked structure/code/document context, receives scoped evidence and gaps, handles updates and submits a reviewed proposal |
| M3 — Agent reads real device state | One permitted live adapter/site with identity, timestamps, freshness, bounded reads and revocation |
| M4 — Evidence and limited release | Same-Agent baseline comparison, scale/recovery and clean-machine acceptance, second operator and published support limits |

WEB-02 is implemented; WEB-03 acceptance is the next priority. CP-01 client/operator gates remain open
and apply to the web slice. CP-01 is configuration management, not a
proxy or proof of universal tool enforcement. Cloudflare/Tailscale remain optional
integrations; no cloud accounts or network settings have been changed.
CP-01 or M2 alone is not the selected full release. M3 needs a real observation source;
fixtures and prior local-alpha tests do not satisfy live acceptance.
M0 direction and the adapter strategy are approved for execution. The native
[M2 read slice](docs/agent-layer.md) now implements common envelopes, identity
lookup, paged inventory and scoped declared relations. M1 pilot/UX and the
remaining cross-source M2/live M3/acceptance M4 gates remain open.
See the [M1 packet](docs/plans/2026-10-13-agent-layer-m1.md) and
[execution evidence](docs/plans/2026-10-13-agent-layer-m1-execution.md).

Build identity/mapping, project semantics, bounded context, policy and reviewed
interaction. Prefer adapters to existing code/document/catalog/monitoring tools.
Keep C++/Qt/SQLite domain ownership, Python SDK/MCP and TS/Go compatibility.
Qt Core/Sql remains a native dependency; Qt Widgets provides a fallback until
WEB-03. No loopback API publication over LAN/Cloudflare/Tailscale is selected.

Device actuation, deploy/OTA, automatic network scanning, a new Agent runtime and
a new general-purpose monitoring platform are outside the first release.
Google Drive is optional; live OAuth and Agent-egress acceptance remain open.

- [Current capabilities and ownership](docs/component-support.md)
- [Agent connection and human-review UX](docs/plans/2026-10-13-experience-plan.md)
- [Plan and evidence index](docs/plans/README.md)
- [Implemented architecture](docs/architecture.md)

This file is an entry point, not an independent backlog.
