# Agent–project layer: scoped owner adapters and common response contract

Date: 2026-10-13.
Status: **M1 design under the owner-authorized r3 implementation; integrated runtime
and live-pilot acceptance outstanding.**
Scope: additive contract/profile design and synthetic client feasibility.
This does not supersede the accepted native/storage/knowledge/impact contracts.

Implementation update: owner authorized the common-adapter strategy and native
read slice. [M2 evidence](../plans/2026-10-13-agent-layer-m2-execution.md) records
its additive endpoint/envelope, direct lookup, paging and relationships. Original
M1 limitations below describe that design phase; live/cross-source/UX/scale
acceptance remains outstanding.

## Decision

External Agents use LMTI through scoped owner APIs. The first local client target
is Codex with the existing Python MCP stdio transport. The native C++/Qt/SQLite
owner, TS compiler/memory/privacy and TS impact remain independent. Python never
receives SQL handles or writes owner tables. No model runtime is added.

A common response envelope carries effective scope, typed result, per-source
versions/authority/freshness, evidence, completeness and typed failures.
Each operation has a typed payload; JSON is an API/proposal boundary.
Native bindings are declarations. Actual versions/health require an authenticated
observation source. The response must carry explicit unknown/mapping gaps.

[Contract](../agent-layer-contract.md) fixes the intended shape and semantics.
[M1 packet](../plans/2026-10-13-agent-layer-m1.md) tracks coverage and open gates.

## Profiles and source ownership

D0 is local single-operator/synthetic public metadata, external model target.
Grant comes from the trusted launcher; Agent arguments may only narrow it.
The current launcher is not an OS sandbox or multi-user authorization service.
The existing MCP server/CLI continue their old schemas; the new envelope is not
advertised as implemented by those transports until a separate M2 change.

Use an existing IoT/monitoring owner when available. LMTI queries its authorized
read-only API and keeps only bounded derived context/cache. No telemetry goes
into topology revisions or long-term memory. A direct collector is conditional
and requires source-specific protocol/storage/auth/recovery decisions.

Shared access is deferred for the local profile. Selecting shared deployment
requires an authenticated service, source identities, enforceable read/write
scope and audit before exposure; no direct filesystem/SQLite bypass.

## Identity, authority and consistency

Entity identity uses project + namespace + source ID + kind. Cross-source
mappings preserve both endpoints and reviewer/evidence. Names/IP are mutable.
Authority is field/assertion-specific. Contradictions are not last-write-wins.

Each owner read has its own source version. Across owners the response is a
version vector, not an atomic global snapshot. Recheck scope/source before
return and review writes; report changed/inconsistent reads rather than claiming
atomicity. Pagination binds query/principal/policy/source versions and budgets;
source/policy changes invalidate cursor. Never return denied-object counts.

A read timestamp proves when a read occurred, not when a sensor sample was
measured or whether it is current. Freshness needs source-specific evidence
and TTL/quality. Content hash proves identity/change, not truth.

## Threat model and mitigations

| Threat / boundary | Required control |
| --- | --- |
| Document/label/tool-output prompt injection | Untrusted data cannot alter grants/tool allowlist; no shell/general proxy; negative tests |
| Scope elevation and graph inference | Launcher/service authority; filter endpoints/paths before ranking; generic unavailable errors; no hidden totals |
| Cross-source stale or revoked cache | Revalidate policy/source at read/return; policy/version-bound cache/cursor; fail closed |
| Credential or path leakage | Credentials separate from graph, protected local secret store; generic diagnostics; opaque authorized references |
| Forged source/device identity | Authenticate source and endpoint; namespace/native IDs; review replacement/collision; do not merge by name/IP |
| Misreported health | Separate source availability, reachability and functional health; unknown/stale explicit |
| Resource exhaustion | Request/response/node/depth/time bounds; pagination; backpressure/retry budget only where ingestion exists |
| Concurrent edits | Expected revisions at owner transaction; stale proposals rejected; no cross-store atomicity claim |
| Same-user bypass | Document limit; filesystem/service enforcement needed for stronger isolation |
| Sensitive local storage | Native stores accept nonsecret metadata only; encryption/key management needed before sensitive storage |

## Alternatives and consequences

A dashboard-first implementation postpones the actual Agent proof and increases
surface area; use a small human source/review interface.
A generic proxy across all MCP tools would lose least privilege and semantic
ownership; expose only reviewed operation adapters.
One universal DB would duplicate owner authority and couple domains; use source
references and projections instead. No new graph DB, Protobuf or gRPC is selected.
A custom monitoring platform or code language server is unnecessary unless
the pilot demonstrates a missing capability that an adapter cannot supply.

The first feasibility test uses a new synthetic project and Codex client plumbing
without a model turn. It establishes launch/discovery/read compatibility on this
machine, not model quality, live monitoring, production isolation or scale.
No global Codex settings, user stores or real endpoints are modified.

