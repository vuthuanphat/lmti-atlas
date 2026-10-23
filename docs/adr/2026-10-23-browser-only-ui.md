# React + Vite as the only product UI

Date: 2026-10-23. Status: accepted by explicit product-owner instruction.

Remove the native Windows Qt desktop application from the project. Keep the
local React + Vite browser workspace as the single presentation layer.

Remove `apps/desktop`, its executable/library targets, GUI deployment, launchers,
native screenshot tooling and desktop-only QtTest/API coexistence trials. The
web package and doctor must no longer depend on Widgets, Gui or a platform plugin.
Fresh native installations prevent stale desktop binaries from being packaged.

Keep C++ domain/storage owners, Qt Core/Sql and SQLite driver dependencies,
the Node loopback API, Python SDK/MCP, TypeScript owners and Go compatibility.
Windows x64 remains the verified packaging target for those backend components
and the browser launcher; removing the desktop app is not a Linux/macOS port.

Replace the desktop prerequisite for initial setup with explicit local operator
CLI commands: `init-project` creates a new validated project; `library-register`
registers a saved project/folder through the native owner. A new library uses
exclusive reservation and the established v1 format. Existing v1 libraries need
the reviewed web upgrade before another registration; v2/v3 registration uses
CAS and never replaces an existing binding. These commands are not Agent tools
or new HTTP path endpoints. Existing stores are not deleted or migrated implicitly.

Former desktop-only editing/review screens are removed features until separately
implemented in the browser. Historical ADRs, plans and screenshots remain evidence
of earlier builds and must not be presented as current product capabilities.

Previous release artifacts and green CI results apply to their recorded commit.
Rebuild the source/runtime artifacts and rerun headless/native, API, UI, Python
and compatibility checks before replacing a draft. Independent operator and clean
Windows browser/backend acceptance remain open; this decision does not waive them.
