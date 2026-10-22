# Historical Go memory roadmap

> Status: historical proposal; Go remains experimental memory compatibility.

The [master plan](LMTI_MASTER_PLAN.md) coordinates current work. The accepted
[native topology ADR](adr/2026-10-11-native-topology.md) selects C++/Qt/Python
for Architecture Studio. Existing TS and Go memory commands keep their separate
implementations and schemas; the phases below do not authorize a new migration.
See the [support map](component-support.md) for current ownership and contracts.

## Original Proposed Direction

```text
Go = Core Runtime
SQLite = Local Memory Storage
TOML = Human Config
JSON = CLI/API Boundary
JSON Schema = Contract Validation
```

## Phase 1

- Keep the existing TypeScript CLI stable.
- Add Go core models, policy interface, JSON envelope, and storage schema.
- Keep `lmti publish preflight` as the safety gate.
- Document TOML config and JSON boundary.

## Phase 2

- Move memory write/search/retrieve paths behind the Go core.
- Add canonical `.lmti/memory.sqlite` migrations.
- Add `lmti migrate from-json`.
- Expand doctor checks for config, migration, adapter, and identity.

## Deferred

- Protobuf.
- gRPC.
- Separate SDKs for C#, Rust, or additional languages.
- Distributed platform features.
