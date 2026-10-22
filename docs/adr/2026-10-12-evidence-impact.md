# Additive evidence-backed change-impact slice

Date: 2026-10-12. Status: accepted for the user-approved local synthetic pilot;
business, operator and production acceptance remain separate gates.

The approved [product plan](../plans/2026-10-12-evidence-backed-change-impact.md)
adds a TypeScript change-impact domain. It does not replace the native C++
project/topology domain, Qt desktop, Python boundary or existing TS/Go memory
commands. Native LMPR entities remain owned by the native writer. Native exports
must be explicit, revision-consistent and complete; the existing bounded context
and undirected neighborhood are not authoritative impact graph exports.

`packages/impact` owns a separate SQLite schema and application identifier.
Its path is explicitly selected in application data, outside `.lmti`. One writer
owns imports, source heads, assertion/evidence versions, review history and saved
reports. Each input is a versioned, bounded, complete snapshot of one source.
Imported source-local keys map to stable entity IDs; labels, paths and IPs are
not identities. Cross-source references retain their source authority rather
than creating a second writer for native records.

Import stages a candidate batch atomically. The accepted batch remains readable;
a changed source head makes its earlier evidence stale immediately. Review is an
explicit operator operation with expected store revision and evidence-review
acknowledgment. Acceptance replaces that source's active projection while older
batches and decisions remain in history. Rejected candidates do not make the old
source fresh. Repeating an identical batch is idempotent. Incomplete, malformed
or incompatible imports do not overwrite the last accepted snapshot.

Desired, observed and inferred assertions remain distinct. Evidence records carry
source revision/digest and source-relative locators. Import time never becomes
verification time. Contradictory assertions are retained rather than resolved by
last-write-wins. Human review acknowledges supplied evidence; it does not execute
tests or prove that a machine matches desired configuration.

The impact engine is deterministic and has no model dependency. It applies typed,
directed rules to the authorized graph before limiting report presentation.
Prospective changes name rollout targets; deployment impact is conditional on
that rollout. A host linked by `runs_on` is associated context, not an affected
machine by default. Current-observed queries cannot turn desired declarations
into observations. Missing, stale, conflicting, inferred or truncated paths
remain unresolved. No path is never proof that a change has no impact.

Trusted callers supply immutable project/site/environment/model-target grants
and freshly obtained source checks. Source checks are observations supplied by an
owner adapter, never a permission-bearing Agent argument. Missing checks produce
unknown freshness. The first package supports synthetic/imported snapshots, not
live polling, repository crawling, telemetry or network discovery. A later source
adapter must implement allowed-root fingerprinting before claiming live freshness.

Authorization precedes entity lookup, evidence lookup, traversal and report
output. Reports are bound to principal, grant/policy version, source/graph/rules
versions and input digest; opening or exporting a saved report rechecks these
bindings and freshness. Agent-facing operations are read-only and receive no
SQLite handle. Import/review/store initialization belong to the operator boundary.
The same-user local process is not an OS sandbox or multi-user identity service.

SQLite is not encrypted. This pilot accepts synthetic/nonsecret metadata only;
restricted labels do not make it a secret store. No direct `.lmti` access, native
schema access, arbitrary shell, SSH, deployment or device execution is added.
Qt and CLI/MCP consume the same versioned report contract. Packaging, encrypted
storage, multi-user identities, source adapters, external Agent/operator trials
and independently reviewed business oracles require their own evidence.
