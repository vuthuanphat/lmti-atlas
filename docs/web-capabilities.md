# Browser capability and support matrix

Date: 2026-10-23. React + Vite is the only UI. Status is explicit: a native model
does not imply a browser editor, a prototype is not a connected workflow, and a
passing fixture does not prove live client/provider acceptance.

| Capability | Browser/source status | Owner / constraint |
| --- | --- | --- |
| Overview, project selection, EN/VI, sessions | Implemented | Local authenticated API; current source scope |
| Empty/unavailable project onboarding | Operator setup guidance; no retired GUI instructions | Existing native init-project/library-register commands; refresh/relaunch for new scope |
| MCP profile and Codex/Cursor config | Preview/apply/restore/status/export implemented | Native profile + Python config owner; client owns authentication |
| Logical/physical hierarchy | Implemented with explicit grants | Native typed review/commit; original binding/revision checks |
| Inventory, Knowledge, desired settings | Implemented per source grants | Scoped SDK, evidence/freshness; no device commands |
| Project copy/library upgrade/activation/recovery | Implemented with explicit maintenance grants | Native receipts and writer recovery |
| Project content/work/software editing | Implemented: 13 categories, review/confirm/readback | Typed native owner, explicit project edit grant; do not infer from model alone |
| Library creation/registration/linking/pins/remove reference | Implemented with independent reviewed launcher file | Approved parent/folder/candidate keys; preview/CAS/exclusive lease/original-target recovery; no session scope expansion |
| Google Drive panel/live OAuth | Experimental owner; former Qt panel removed | Publisher/live acceptance and browser flow separate; no credentials in metadata |
| Advanced Impact panel | CLI/SDK owner available; former Qt panel removed | Scoped reviewed sources and reports; no universal browser parity claim |
| Topology drag canvas/Qt inspector/undo-redo | Removed | Not implicitly ported to web |
| Legacy TS MCP stub | Handler reference, not a transport | Python scoped/integrated MCP is the actual packaged boundary |
| Research cognition/world model | Experimental deterministic/heuristic helpers | Not model training or proven Artificial Mind |
| At-rest encryption | SQLite not encrypted by this project | DPAPI applies only to client backups/journals |
| Live IoT/device execution | Live adapter not accepted; device execution unsupported | Controlled replay remains labeled replay |

Source CLI installation and browser runtime ZIP are different distributions.
The runtime packages fixed knowledge/mapping read bundles, not the unrestricted
source CLI. Node/Python are trusted external prerequisites. Registry publishing
to npm/PyPI is not a verified distribution route for this candidate.

Clean Windows, an independent operator, actual external clients/providers and a
final merged-SHA build remain acceptance gates. Do not mark them passed from
local tests or generated configuration. See [release build](release-build.md).
