# Web presentation over existing LMTI owners

Date: 2026-10-13. Status: **WEB-01 local operator boundary implemented following
the owner's continuation request; WEB-02 React presentation implemented,
WEB-03 default cutover still gated**.
No network publication is authorized. [WEB-01 evidence](../plans/2026-10-13-web-api-execution.md)
records backend tests and limits; [WEB-02 evidence](../plans/2026-10-13-web-react-execution.md)
records browser/package checks. Owner UX acceptance remains open.

The owner requested a hybrid stack with a more flexible user interface and
selected a local web application opened in the browser. The
proposal makes React/TypeScript SPA the target presentation, served by a thin
local Node.js/TypeScript API. C++ remains the typed domain and native SQLite
owner; Python remains SDK/MCP and client-config owner; TS memory and Go
compatibility remain independent. See the
[transition plan](../plans/2026-10-13-web-ui-transition.md).

This proposes superseding the Qt Widgets primary presentation choice only after
parity/cutover. Native topology/project/profile schemas, validation and SDK
boundaries are preserved. Qt Core/Sql still supports existing native adapters.
Qt desktop is the compatibility/recovery UI during migration.

Node is an orchestration façade for documented owner operations, not another
domain/database owner. A minimal native profile/library CLI adapter now exists;
browser requests cannot select binaries, raw paths, grants, SQL or shell tools.
JSON/HTTP are UI API boundaries, not durable domain formats. Python Agent MCP
stays stdio until a separately reviewed need justifies changing it.

Local web access requires session authentication, exact origin/host controls,
bounded requests/processes and secret-safe rendering/logs. A loopback listener
does not provide same-user isolation or multi-user RBAC. No Cloudflare/Tailscale
publication of this API, cloud deployment, arbitrary Agent execution or GPU/model
training is selected. Desktop wrapper/shared service choices need separate review.

Gate: UX/contract/security review, owner/API parity tests, CP-01 recovery and
actual client verification, second operator and bounded package/workload checks.
The owner explicitly authorized continuation after the WEB-00 artifact. The
local Node/native/Python boundary and React now have HTTP/browser integration
evidence. Full parity/cutover remains pending; these checks do not establish
browser rendering, second-operator acceptance or web release readiness.
