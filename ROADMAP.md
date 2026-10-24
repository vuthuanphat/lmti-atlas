# LMTI roadmap

Current direction: [master plan](docs/LMTI_MASTER_PLAN.md), as superseded for UI
scope by the [browser-only decision](docs/adr/2026-10-23-browser-only-ui.md).
React + Vite is the sole product UI. The Qt desktop application was removed;
Qt Core/Sql remains a storage/runtime dependency of the native backend.

LMTI gives AI coding agents scoped project understanding, reviewed knowledge and
evidence. It is not a complete AI framework, an MCP enforcement proxy or a new
general monitoring platform. See the [capability matrix](docs/web-capabilities.md).

| Priority | Work | Acceptance |
| --- | --- | --- |
| 1 | Easier first setup and reliable reopen | Fresh demo/empty workspace, reviewed scope, reusable local opener and actionable prerequisite errors |
| 2 | Startup/session and recovery guidance | One-use authentication, distinct connection/owner/session errors, graceful drain and original-target recovery; no automatic repeat of unknown writes |
| 3 | Candidate documentation and verification | Source/package runbooks match; record checks for changed source separately from the 771fc40 baseline |
| Source integration | Integrate reviewed source and refresh README | Authorized on 2026-10-24; record actual preflight/CI/merged-SHA results separately |
| Later runtime acceptance | Clean Windows, independent operator and release provenance | These gates remain open; public runtime release/tag publication remains held |
| Separate pilot | Actual clients/providers and live read-only observation | Record permission, environment, source and outcome; replay is not live evidence |

Current implementation includes the React workspace, local authenticated Node
API, C++/SQLite owners, Python SDK/MCP and TS memory/context CLI. Logical/physical
hierarchy, desired-settings review, project copy/activation/recovery and MCP
configuration preview/apply/restore have owner-backed implementations. Source
presence is not proof of every browser workflow or live provider acceptance.

The [startup readiness plan](docs/plans/2026-10-24-startup-readiness.md) tracks
current work after the [core audit remediation](docs/plans/2026-10-23-audit-remediation.md).
Core library/content workflows are implemented; independent acceptance remains
open. Scoped context/privacy and explicit native owner review remain invariants.
Historical M0/M1/CP-01/WEB-00–03/r5/r6 plans remain
design/evidence records; their old requirement to retain a Qt fallback is
superseded. There is no fallback desktop to launch.

Windows x64 is the backend/browser-launcher packaging target. Linux CI tests
components; full Linux/macOS runtime support has not been certified. Device
actuation, deploy/OTA, arbitrary shell execution, shared hosted service,
multi-user authorization and encrypted domain storage are outside this alpha.
Optional Drive/OAuth and advanced Impact browser integration retain their own
scope and acceptance; no live account is assumed authorized.

- [Current architecture](docs/architecture.md)
- [Component support](docs/component-support.md)
- [Local web setup](docs/local-web.md)
- [Plan/evidence index](docs/plans/README.md)
