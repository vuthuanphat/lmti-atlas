# Agent layer — native read slice

Date: 2026-10-13. Status: **implemented local-alpha M2 native read slice**,
not completion of M2/M3 or a production/whole-project claim.
[Master](LMTI_MASTER_PLAN.md), [contract](agent-layer-contract.md),
[execution evidence](plans/2026-10-13-agent-layer-m2-execution.md).

Update 2026-10-19: the default native read interface below remains compatible.
An explicit `--integration-config` adds `lmti_task_context` plus controlled replay
observations. Mapped public compiled summaries and explicitly permitted owner-safe
memory summaries preserve source versions, evidence and original classification;
no raw files or private/pending memory are exported. See the
[integrated contract and setup](plans/2026-10-19-integrated-mvp.md).
This is controlled-source implementation evidence, not live IoT acceptance.

## Available now

An additive Python SDK/MCP maps the saved native owner projection to
lmti.agent.response.v1. The existing project/topology/impact MCP endpoints and
their schemas remain compatible. There is no new storage owner or model runtime.

| MCP tool | Purpose |
| --- | --- |
| lmti_context | Paginated authorized entity inventory; no implied complete dependency graph |
| lmti_entity | Direct identity lookup beyond the legacy 200-record context window |
| lmti_related | Declared relation query, bounded depth/direction/type, with pagination |
| lmti_observations | Default: typed NOT_SUPPORTED; configured integration: bounded controlled replay with explicit freshness/source labels |

Kinds: component, asset, release. Asset kind comes from the native model:
machine/gateway/broker/service/sensor. Do not interpret every asset as physical hardware.

Relations: declared_dependency (stored native endpoints, not causal impact),
has_release (component → release), deployed_to_desired (release → asset),
declared_connection (stored asset endpoints/protocol, not live connectivity).
Each returned edge has authorized endpoints and source evidence. Bindings never
prove an installed firmware version.

## SDK

Set PYTHONPATH to this repo's python/src in the current developer shell.
Use trusted absolute package/database paths and an existing saved LMPR project.
The example below relies on local environment variables, not embedded credentials.

```python
import os
from lmti_agent import Client, Grant, NativeProjectSource

source = NativeProjectSource(
    os.environ["LMTI_PROJECT_BINARY"],
    os.environ["LMTI_PROJECT_DATABASE"],
    Grant(project_id="factory-monitor", site="factory-demo", target="external"),
)
client = Client(source)
page = client.context(limit=50)
next_cursor = page["completeness"]["nextCursor"]
if next_cursor is not None:
    following = client.context(limit=50, cursor=next_cursor)
firmware = client.entity("component", "sensor-firmware")
links = client.related("component", "sensor-firmware", depth=2, direction="both")
unsupported = client.observations("machine-a")
```

The IDs above refer to the synthetic demo. Real IDs/scopes come from the saved
project and must be authorized by its owner. Do not mark private data public
to make an external read succeed.

## MCP launch

```powershell
$env:PYTHONPATH = Join-Path (Get-Location) 'python/src'
python -m lmti_agent.mcp --binary $env:LMTI_PROJECT_BINARY --database $env:LMTI_PROJECT_DATABASE --project factory-monitor --site factory-demo --target external
```

The optional --source flag sets an opaque source namespace in trusted launcher
configuration. Tool arguments cannot change binary/database/project/site/target/source.
No SQL, arbitrary filesystem lookup, shell or device-execution tool is exposed.
Local target is for a separate trusted local-model process, not external model export.

The server returns the envelope both as structuredContent and as JSON text for
compatible clients, following the [MCP tool specification](https://modelcontextprotocol.io/specification/2025-06-18/server/tools#structured-content).
Tool errors set isError=true and carry a fixed typed error envelope.

## Paging, freshness and limits

Cursor binds to query (including limit/filter/depth/direction), source projection
fingerprint, and the Client/session's private random key; expires after 300 seconds.
Do not change query while following a cursor. Server restart/new Client, source
change or expiry invalidates it. No durable cursor/key or graph cache is written.

Source is read through the owner again immediately before successful return.
Revision and authorized projection fingerprint must match, including changes
made without a revision increment. Access/source failure returns an empty generic
UNAVAILABLE envelope; no earlier cached data is reused.

checked/checkedAt means a saved owner projection was checked at that time.
It is not sensor sample time, live device freshness or a guarantee that the source
cannot change after the check. Expected-revision validation remains essential for
any later review/write.

Bounds: 4 MiB owner snapshot, 64 MiB source file (native SDK limit), 10s per owner
process, 1–200 query result records, depth 1–8, 20,000 examined relation entries,
2,000 visited nodes and 512 KiB final envelope. Related pages include the endpoints
of their relation records, so entity count may exceed the relation page limit.
Traversal budget exhaustion returns partial with no continuation cursor.
No hidden object counts are exported.

**Pagination bounds the Agent response, not native database I/O.** The current
adapter reads a full bounded projection twice per successful query and builds
in-memory indexes. This is not indexed/paged SQLite querying or a 10,000-entity
performance claim. Benchmark and native owner lookup optimization remain planned.

## Verification

```powershell
python scripts/m1-agent-smoke.py --agent-layer --binary $env:LMTI_PROJECT_BINARY
```

Add --codex with a trusted absolute Codex executable to verify installed client
discovery and an MCP tool read. The tool creates a fresh synthetic DB and local
config snippet under ignored build/m1-smoke-*/; it never uses user project stores.
agent-context.json and agent-relations.json show actual synthetic envelope outputs.
No global Codex registration or model turn is performed.

[Tests](../python/tests/test_agent_layer.py) cover scope/metadata/type validation,
paging and lookup past 200, directed cycles/depth, forged/expired cursors,
same-revision source changes, reauthorization, response/traversal budgets, native
processes and unchanged source bytes. Native paging correctness was checked with
1,012 synthetic entities and an added 1,004-edge chain; this is not SLA evidence.

## Next boundaries and security

Under master r6, the owner requested completion of the MVP build before live
client/provider and independent operator trials. An additive
[reference projection](adr/2026-10-14-agent-reference-projection.md) now exposes
declared repository/knowledge links through the same native owner. Opt in with
`NativeProjectSource(..., include_references=True)` or MCP `--references` and a
newly built native binary. Existing profile exports remain on the v1 capability.
`repository` / `knowledge` identity queries and `implemented_in` / `documented_by`
relation filters carry evidence; content remains `not_loaded`. Locators and raw
stored fingerprints are withheld. This does not fetch code/documents or connect
the TS memory owner yet.

TS code/compiler/memory integration, code/design mappings, larger logical hierarchy,
common proposal/review outcomes, live IoT, shared authentication and workload
acceptance remain outside this slice. Current no-observation response is intentional;
unknown must not become fake live data. ThingsBoard is a pilot candidate, not an
installed or connected provider.

[CẢNH BÁO BẢO MẬT] Native SQLite is unencrypted and accepts only nonsecret metadata.
Same-user launch is not an OS sandbox/RBAC. Credentials stay outside graph/code/chat;
do not forward local/internal context to cloud models. Check .gitignore before
push and run lmti publish preflight before any publication.

