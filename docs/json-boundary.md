# JSON Boundary

> Status: Local-alpha documentation

LMTI uses JSON at the boundary, not as the core database.

JSON is allowed for:

- CLI output with `--json`;
- import and export;
- adapter communication with AI agents;
- config shape validation;
- interchange between tools.

Topology uses a typed C++ domain and a separate SQLite schema. TS project memory
uses SQLite; Go compatibility has its own schema and typed values. Legacy TS
JSON memory is still read/written by some commands and must remain until a
lossless reviewed migration is available. JSON import writes are currently
blocked; `lmti memory migrate-json --dry-run` is a read-only inventory.

## Contracts by entry point

| Surface | Contract | Scope |
| --- | --- | --- |
| Friendly project-memory CLI JSON | `lmti.cli.v1` envelope | Supported friendly commands; advanced TS/Go diagnostics can retain their documented output |
| Native topology context | `schema: lmti.topology.context.v1` | Bounded saved topology with site/visibility filtering and revision |
| Native topology proposal | `schema: lmti.topology.proposal.v1` | Desired-configuration diff; expected revision and old values; no write/dispatch |
| Python MCP stdio | JSON-RPC/MCP transport | Three topology tools calling the same scoped SDK |
| Project Atlas / AMF | Versioned compiler artifact | Compiled project understanding, distinct from topology and deliberate memory |

Do not wrap MCP messages or topology payloads in the project-memory CLI envelope.
Transport, schema and domain validation remain separate responsibilities. See
the [Studio guide](topology-studio.md), [CLI](cli.md) and [support map](component-support.md).

Friendly CLI responses use this envelope:

```json
{
  "schemaVersion": "lmti.cli.v1",
  "command": "lmti.publish.preflight",
  "status": "blocked",
  "warnings": [],
  "errors": [
    {
      "code": "GIT_HISTORY_NO_COMMON_ANCESTOR",
      "message": "Current branch has no common ancestor with origin/main."
    }
  ],
  "data": {}
}
```

Valid statuses are:

```text
pass
warn
blocked
error
```

Command errors should use stable error codes such as
`CONFIG_INVALID`, `STORAGE_UNAVAILABLE`, `PRIVACY_BLOCKED`,
`SECRET_DETECTED`, `PROTECTED_FILE_DETECTED`, and the `THOTH_*` routing codes.

Project-memory boundary schemas live in `schemas/`; native topology serialization
and proposal validation live in `native/storage/boundary.cpp`. Existing outputs
remain compatible during this consolidation.
