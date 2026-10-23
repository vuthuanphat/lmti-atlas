# Native topology core, Qt desktop and Python Agent boundary

> The Qt Widgets UI portion is superseded by the
> [browser-only UI decision](2026-10-23-browser-only-ui.md). Core/Sql storage and
> the scoped Python boundary remain in effect.

Date: 2026-10-11. Status: accepted for the local topology MVP.

The owner requested an IoT architecture editor, typed C++ implementation,
Python Agent integration and a C++ UI. This supersedes the earlier proposed Go
runtime choice for the new topology domain. Existing Go/TypeScript memory
commands remain supported during this additive transition.

`native/core` owns Qt-independent C++20 values and validation. Qt Core/Sql
adapters own SQLite transactions and JSON boundary serialization. Qt Widgets
owns the desktop, canvas, inspector, undo/redo and proposal review. Python
owns a small scoped SDK and MCP stdio server. The Python runtime has no
third-party runtime dependency and calls the packaged native CLI with a fixed
argument vector; it never receives a raw store handle.

Topology files use a separate SQLite schema and application identifier. They
are not `.lmti` memory files. Writes check the saved revision within a single
`BEGIN IMMEDIATE` transaction. Agent reads use read-only transactions, site
and classification filters, indexes and bounded results. JSON is used for
context, MCP and proposal interchange only. Protobuf and gRPC are unnecessary
for this slice.

Site/model-target grants come from trusted process launch configuration. The
Agent cannot change them in tool arguments. External grants include only
public metadata. Internal records are nonsecret local metadata; confidential
and secret storage are unsupported. The launcher and same-user native CLI
are not an OS sandbox or multi-user authorization service. SQLite files are
not encrypted by this MVP.

Configuration proposals contain only expected revision/site/configuration and
new desired enabled/poll-interval values. Desktop review checks the saved
revision and prior values before applying the diff to the document. Saving
commits the architecture. No machine command is dispatched, and declarations
are never reported as live connectivity.

Consequences: Qt 6.12 or newer is required for the adapter/UI build; the
headless CLI still needs Qt Core/Sql runtime libraries. Packaging uses dynamic
Qt libraries. Production networking, encrypted storage, durable audit history,
multi-user identities, telemetry freshness rules and gateway connectors need
separate implementations and deployment validation.
