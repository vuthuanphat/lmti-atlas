# LMTI topology and Architecture Studio

Current scope: 2026-10-23. The product UI is React + Vite in a local browser.
The former Qt desktop, Qt Widgets/Gui runtime, desktop launcher and QtTest UI
targets were removed. Qt Core/Sql and the SQLite driver remain native backend dependencies.

## Run and build

Use the [local web guide](local-web.md) for packaged startup, project setup and
explicit permissions. Use [release build](release-build.md) to build the C++20
owners and browser package. Node/Python are trusted external prerequisites.
Do not launch retired desktop binaries or reuse old desktop install directories.

## Domain and capabilities

The typed C++ core validates sites, declared devices/services, desired settings,
connections, privacy and revision/proposal rules. Native Qt Core/Sql adapters own
SQLite transactions. Python provides scoped SDK and MCP reads/proposals. Node is
an authenticated local façade with bounded DTOs and fixed owner calls; React owns presentation.

Architecture contains logical hierarchy, physical infrastructure and inventory /
relationships. Work contains typed project content (including devices and declared
connections), project operations/recovery and browser-session activity. The
[capability matrix](web-capabilities.md) distinguishes browser, CLI, removed and experimental features.
The drag canvas, Qt inspector and Qt undo/redo were removed; they are not implied
by native model support.

Local operator changes require explicit launcher grants, a revision-bound review
and confirmation. Source/binding changes invalidate reviews. Unknown outcomes
retain the writer recovery gate across restarts. Agent proposals do not grant
operator authority or write device state. No arbitrary shell/SQL/path HTTP tool exists.

## Evidence and limitations

Declared relationships are not observed traffic. Desired configuration is not
observed health. Controlled replay is labeled replay and retains sample/receive
time, TTL, quality and source identity. There is no accepted live IoT adapter or
device dispatch. Live client/provider and pilot acceptance cannot be inferred
from synthetic fixtures or configuration generation.

Topology/project privacy uses public/internal nonsecret metadata. TypeScript
memory has its own richer privacy vocabulary and egress policy; mappings must be
explicit. Native SQLite is not encrypted. DPAPI applies to specific client
backups/journals only. There is no shared multi-user service or OS sandbox here.

## Verification

Native CTest covers domain/storage/owner boundaries; Python tests cover scoped
SDK/MCP/process use; TypeScript tests cover memory/privacy and fixed bundles.
The local web verifier runs package integrity plus actual-owner HTTP and React
tests. [Release build](release-build.md) describes reproducible commands and
external gates. Local tests do not substitute for a clean Windows machine or an
independent human operator.

Historical design/evidence lives in the dated [plans](plans/README.md) and
[native topology ADR](adr/2026-10-11-native-topology.md); old UI instructions are
superseded by the [browser-only decision](adr/2026-10-23-browser-only-ui.md).
