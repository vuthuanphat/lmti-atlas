# LMTI

**Project context you can inspect. Changes you review.**

[![CI](https://img.shields.io/github/actions/workflow/status/vuthuanphat/lmti-atlas/ci.yml?branch=main&label=CI)](https://github.com/vuthuanphat/lmti-atlas/actions/workflows/ci.yml)
[![Native checks](https://img.shields.io/github/actions/workflow/status/vuthuanphat/lmti-atlas/topology.yml?branch=main&label=native)](https://github.com/vuthuanphat/lmti-atlas/actions/workflows/topology.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
![Stage](https://img.shields.io/badge/stage-alpha-orange)

LMTI keeps reusable project knowledge on your machine and gives AI coding agents
scoped context with evidence behind it. Project-memory tools organize compiled
understanding, eligible memory and reviewed lessons. The local browser workspace
helps you inspect architecture and review changes before native owners apply them.

The workspace uses **React + Vite**, a local Node.js API, native C++/SQLite owners
and a scoped Python SDK/MCP boundary. The browser is the product UI. Windows x64
is the current backend/package target; Qt Core/Sql supplies storage dependencies.
The Qt desktop application has been removed.

**Status:** `v0.2.0-alpha.1` is a development candidate. Source on `main` and
a published runtime release are separate: the candidate release remains unpublished.
Alpha APIs and storage contracts can change. Read the
[release notes](docs/releases/v0.2.0-alpha.1.md) before using existing data.

[Get started](#get-started) · [Workspace guide](docs/local-web.md) ·
[Validation](docs/releases/v0.2.0-alpha.1-qa.md) · [Contribute](CONTRIBUTING.md)

![LMTI browser workspace with a synthetic sample project](docs/media/launch/workspace.png)

*Actual React workspace with synthetic data. Saved client configuration and
verified client use are distinct; this image does not certify a provider connection.*

## What you can do

| Area | Available behavior |
| --- | --- |
| Project understanding | Compile project maps and reuse scoped context, eligible memory and reviewed lessons through the TypeScript CLI. |
| Browser workspace | Explore Overview, Work, Architecture, Knowledge and Agent, in English or Vietnamese. |
| Project library | Create/register metadata, choose approved source folders, pin projects and remove references while preserving source files. |
| Project content | Review 13 typed categories, including software, hardware targets, releases, bindings, dependencies, evidence, milestones and work. |
| Evidence and review | Inspect reviewed code/document summaries and context sources; native revision checks and separate confirmations guard changes. |
| Coding clients | Preview, apply and restore project MCP configuration for Codex and Cursor; clients handle their own provider authentication. |
| Agent integration | Use scoped Python SDK/MCP reads and reviewed proposals; native, knowledge and memory owners retain their policies. |
| Local operations | Open fresh private sessions, drain accepted work on shutdown and inspect recovery evidence before another change. |

See the [capability matrix](docs/web-capabilities.md),
[component ownership](docs/component-support.md) and [Agent guide](docs/agent-layer.md).
Controlled observation replay is labeled as replay; it is not live IoT connectivity.

## Get started

### Build the project-memory CLI

Use Node.js 24+, Corepack and the repository's pinned pnpm 10.13.1:

```powershell
git clone https://github.com/vuthuanphat/lmti-atlas.git
cd lmti-atlas
corepack pnpm install --frozen-lockfile --ignore-scripts
corepack pnpm build
node packages/cli/dist/index.js --help
```

The source CLI is the verified entry point. npm/PyPI installation is not a
verified distribution channel for this candidate. Internal `@atlas/*` names
remain package namespaces; the public product name is LMTI.

### Run the local browser workspace

Prepare a Windows x64 package with the [build guide](docs/release-build.md).
Native owners require the documented C++/CMake/Qt toolchain; building only the
frontend does not produce a complete runnable package.

Running a prepared package requires **Node.js 24+ x64, Python 3.11+ x64 and a
compatible Microsoft C++ runtime** from trusted publishers. Qt Core/Sql and
the Python SDK are included; Node/Python are external prerequisites. Verify
the supplied SHA-256 checksums and extract into a new directory.

1. Double-click **`LMTI.cmd` inside the prepared package**, or run its
   `scripts/setup-local-web.ps1` from PowerShell.
2. Choose a **new workspace folder** and a demo or empty project. Review the
   displayed grants, then type `CREATE`. Setup checks the package and runtimes
   first; existing workspace folders are refused.
3. Keep the operator console open. Later, run **`Open-LMTI.cmd` inside the
   workspace** to reopen it with the saved package and grants.

| Console action | Result |
| --- | --- |
| **O**, then Enter | Ask the OS browser opener for a fresh private session with the current scope. |
| **Q**, then Enter | Stop accepting work, wait for accepted operations, then close the service. |

Old URLs, bookmarks and refreshed tabs cannot create a new private session.
Setup does not install dependencies, bypass execution policy or silently upgrade
schemas. Follow the [startup/recovery guide](docs/local-web.md) when the service,
session or owner is unavailable. Do not repeat a write whose outcome is unknown.

### Add another project

Setup prepares **four approved source folders** by default: one for the initial
project and three empty folders for later projects. Adding a project requires
the separately granted, reviewed library upgrade and an unused approved folder.
See [library management](docs/library-management.md) for the full sequence.

Creating a project does not expand the current session. After stopping the old
console with Q, run the local opener from the prepared package with a registered ID:

```powershell
& .\scripts\open-local-workspace.ps1 -WorkspaceFile 'C:\work\LMTI-demo\lmti-workspace.json' -ProjectId new-project -GrantProjectContent
```

Use your actual saved profile path; the example assumes an existing `C:\work`
parent. The switch grants the typed content editor, including reads and writes,
to the explicitly selected IDs for this launch. Omitting it does not grant that
editor for new IDs; saved library and maintenance grants still apply. The saved
profile and default launcher keep their original scope. Add `-ValidateOnly` to
inspect the selected/content IDs first.

## Validation and release status

The [QA record](docs/releases/v0.2.0-alpha.1-qa.md) distinguishes source/package
checks, test skips, browser evidence and hosted CI. Badges describe `main`,
not certification of every platform or a published binary.

The readiness candidate has native, TypeScript, Python, Go, real-owner API, UI
and broker/launcher checks, plus maintainer-controlled Chrome and Windows
PowerShell 5 journeys. Clean Windows, independent operator and actual external
client/provider acceptance remain separate gates. Use the
[operator acceptance procedure](docs/operator-acceptance.md) to record results.

## Scope and data handling

- The API binds `127.0.0.1`. Keep launch links private and the service off LAN,
  tunnels and port forwarding.
- Project/topology SQLite metadata is **unencrypted and nonsecret-only**.
  Trusted launcher grants are not an OS sandbox against the same filesystem user.
- External AI clients/providers retain their own permissions and data handling.
  Local storage alone does not guarantee local inference.
- Shared hosting, multi-user authorization and device execution are outside
  this alpha. Full Linux/macOS workspace packages are not prepared.
- Google Drive and advanced Impact browser integration remain deferred;
  experimental CLI/SDK integrations have separate setup and acceptance limits.
- In another repository, LMTI is a context layer, not part of the application's
  runtime. See the [host-project boundary](docs/host-project-boundary.md).

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md), [development](docs/development.md),
[AGENTS.md](AGENTS.md) and [SECURITY.md](SECURITY.md). Keep fixes focused and
record meaningful verification and skips. Go remains an experimental
compatibility path; TypeScript memory and native projects keep separate stores.

Before pushing, review `.gitignore` and tracked files. Keep credentials, private
memory, databases and generated workspace/session files out of Git. Use ignored
configuration or environment variables for secrets. Run
`node packages/cli/dist/index.js publish preflight` before public push/PR/release
operations; report vulnerabilities through the private channel in SECURITY.md.

Created by **Edgar Vu — Cyno Software**. Source: [Apache-2.0](LICENSE).
Dependencies retain their own licenses; see [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt).
