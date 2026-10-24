# M2 Agent layer — native read execution

Date: 2026-10-13. Scope: owner-authorized implementation after the adapter-strategy
recommendation. Status: **native read slice implemented and locally verified**.
M1 real-pilot/UX gates and remaining M2/M3/M4 goals remain open.

## Behavior delivered

External clients can read authorized native project entities/relationships via a
common response with effective scope, source revision/check time, evidence,
unknowns, completeness and typed failures.

- Additive lmti_agent SDK/MCP, independent of model/provider.
- NativeProjectSource calls the existing native snapshot API; no direct DB access
  by Agent runtime and no new domain/storage format.
- Strict snapshot validation rejects unknown fields, wrong scope/classification,
  invalid parent/release references, bad types and known secret-like metadata.
- Direct lookup and authenticated session cursors cover inventory beyond legacy
  context windows. Related query preserves stored directions and bounded traversal.
- Source projection is rechecked before success; same-revision changes invalidate
  cursors and source change/revocation blocks return.
- Returned declarations/desired bindings are never observed facts. IoT calls
  return NOT_SUPPORTED until an authorized adapter is configured.
- Existing native C++/Qt, project/topology/impact MCP, TS/Go owners and user stores
  are preserved. No package installation, global client config edit or publishing.

The five architecture questions are met by reusable source-backed identities,
bounded queries, explicit privacy/provenance and replaceable adapter/owner APIs.
Token savings and business improvement have not been measured.

## Verification

| Check | Result / scope |
| --- | --- |
| New Agent/source/process tests | 20 passed, 0 skipped |
| Python regression discovery | 46 total: 44 passed, 2 skipped |
| Skipped tests | Two existing TypeScript impact-owner integrations: LMTI_IMPACT_NODE/CLI/CONFIG not supplied; no claim of re-running that owner |
| Legacy M1 smoke | Passed all 8 checks and installed Codex legacy tool read |
| M2 smoke | Passed 4 Agent-layer check groups plus legacy checks; installed Codex read new lmti_context envelope |
| Pagination fixture | 1,012 native entities plus a 1,004-edge added dependency chain; inventory enumerated without repeats, direct lookup and depth-limited traversal past first 200; dirty content at same revision rejects old cursor |
| Negative cases | Missing/denied equivalent, input scope override, malformed source, injected labels, forged/expired/foreign cursors, graph cycles, source-change/revoke, timeout/output bounds |
| Source writes | Synthetic source bytes unchanged after SDK/MCP/client reads |
| Models/devices | No model turn, no live IoT, no measured business value |
| Environment | Python 3.14.2; codex-cli 0.162.0-alpha.17.2; existing native package from build/studio-simple-20261013 |

Native executable SHA-256:
8DDB8E06D9995A3D6EB29C3D6138A91E1FE92EC84DBF6BC303CE0E1BC26F8BEB.

Per-run report, configuration snippet and native envelope examples stay under
ignored build/m1-smoke-*/. Invocation is
scripts/m1-agent-smoke.py --agent-layer --binary <trusted-native-path> --codex <trusted-client-path>.
The historical script path remains compatible; --agent-layer selects M2 checks.
This is real client plumbing against synthetic source data, not model-quality proof.

## Ownership and limits

Python DTOs are transient normalized boundary views. Typed C++/SQLite remains
native domain/storage authority. Agent never receives handles or arbitrary tools.
JSON is an API/proposal boundary, not durable topology.

Projection limit is 4 MiB. Entity/relationship pagination happens after a full
authorized projection, read twice for successful replies. It bounds response
size but does not prove scalable database I/O. The 1,012-entity synthetic fixture
proves query/paging correctness, not a production SLA or representative workload.
Whole-source cost/indexed native lookup and workload acceptance still require measurement.

The local launcher is not multi-user RBAC or an OS sandbox; SQLite is unencrypted
and supported for nonsecret metadata only. Secret-pattern checks are defense in
depth, not a replacement for source classification and proper secret storage.
Read-time verification cannot eliminate changes after the final check.

## Remaining work

M2 still needs code/document/TS owner mappings, fuller hierarchy/ownership and
reviewed proposals through the common contract, plus actual model/operator use
and selected large-project workload. M3 needs permitted real device/platform/API,
metrics, read-only account and freshness/security contract. No provider is chosen
or installed merely to turn a synthetic result into a live claim.

See [usage](../agent-layer.md), [contract](../agent-layer-contract.md) and
[master](../LMTI_MASTER_PLAN.md). The older M1 report describes its original build
and is not rewritten as though these capabilities existed then.

## Safe lesson candidates

- Paginating Agent output does not imply paginated owner I/O; measure the owner
  projection path before claiming large-project scale.
- A source read timestamp/revision is evidence of a checked declaration; device
  freshness requires independently sourced sample time/quality/TTL.

These are review candidates with source/test evidence, not approved memory.
No lesson/raw chat/customer data was stored.

