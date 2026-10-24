# Project-memory MCP reference stub

Status: legacy/reference, feature expansion frozen.

`createLmtiMcpStub` exposes local handler functions for project context and
memory. It has no MCP transport, negotiated identity or process sandbox and is
not a supported remote service. Existing exports remain for compatibility.

Context/get-memory handlers now use the readonly owner reader (SQLite if present,
otherwise legacy JSON) and context includes compiler freshness. The legacy
related-files list fails closed on stale/unknown AMF because its array contract
cannot carry a warning. `lmti_record_task_result` remains a legacy JSON writer;
do not treat this stub as a complete transport or SQLite write API.

The independent evidence-impact MCP is implemented at
`python/src/lmti_impact/mcp.py`; its five tools call the scoped TS owner.
See the [impact runbook](../../docs/impact-review.md).

The actual topology MCP stdio server is in `python/src/lmti_topology/mcp.py`;
see the [Studio guide](../../docs/topology-studio.md). It serves scoped topology
reads and configuration proposals, not project-memory parity. Neither surface
permits device execution. See the [support map](../../docs/component-support.md).
