# Native project projection and human impact review

Date: 2026-10-13. Status: accepted for the user-authorized local software/hardware/IoT slice.
Manual operator acceptance and real pilot success remain separate gates.

## Decision and ownership

The native C++/SQLite owner exports `lmti.project.snapshot.v1` from one read-only
transaction of a saved LMPR document. TypeScript consumes that versioned boundary;
it does not query or write native tables. The export contains project-wide software
components/dependencies/releases and assets/bindings/connections in one site, after
parent and endpoint privacy filtering. It is complete within this declared scope:
it is neither a complete model of the real system nor the existing bounded context
API. Oversized or malformed exports fail without a truncated success response.

The impact adapter creates stable source/entity IDs and content fingerprints.
Components become logical services; bindings become desired deployment declarations.
The adapter does not infer observed installed versions, business workflows or causal
dependencies from physical connections. Repository code mapping remains a separate
explicit owner adapter; native component metadata does not prove code deployment.

Qt calls the TypeScript owner with fixed argv through a separate desktop contract.
Every request identifies the exact saved document path, project ID and revision.
The configured native executable must match the trusted packaged executable selected
by the desktop launcher; the recorded binary digest detects replacement. A hash
provided by an arbitrary JSON file is not executable authority. No request selects
a shell command, grants, native binary or source-check claims.

Rebuilding/replacing `lmti-project` changes the pinned digest even at the same path.
Existing review workspaces fail closed; there is no silent repin or permission
widening. The current recovery is to retain the old workspace/history and create a
new review workspace with the newly trusted package, then inspect and accept its
imports again. This does not migrate old evidence. An explicit owner upgrade/repin
workflow is deferred.

## Human review and persistence

The operator flow is stage, inspect the candidate and evidence, accept/reject,
generate impact, save that exact report, record verification and reopen it.
`start-studio-ui.ps1 -AllowImpactReview` explicitly enables desktop owner writes;
the default and Python/MCP Agent surface remain read-only. This local capability
does not establish OS isolation or multi-user identity.

Human outcomes are separate append-only events: pending, verified or failed.
Verified/failed require a bounded nonsecret evidence summary and a source-relative
reference. References are never fetched or executed. Events bind to the canonical
saved report, grant/principal/policy, source versions and graph revision. A separate
review revision prevents concurrent overwrites without invalidating the graph after
each human action. Canonical report checklists remain pending; an operator claim
does not change a graph assertion or authorize deployment. Stale outcomes are not
presented as current verified checkboxes.

New LMIP stores use schema 2. Schema 1 remains readable. Review writes on schema 1
require an explicit upgrade, an exclusive new backup destination, a verified
`VACUUM INTO` snapshot including committed WAL data, and transactional additive DDL.
A concurrent change detected after backup aborts migration. Failure rolls back the
original schema and retains the backup; unknown versions and occupied destinations
are rejected. No `.lmti` or user project database is migrated by this operation.

## Consequences and limits

Native and impact stores retain separate writers. There is no cross-store atomic
transaction: owner sources are checked before an operator write and checked again
before presenting current verification. A change after a check can make an event
historical; reopening revalidates source bytes, policy and canonical report content.
The synchronous review API also checks freshness while holding the impact write lock;
an asynchronous native adapter cannot make that lock cover the native database.

Saved-report inventory exposes only opaque IDs, saved times and graph revisions for
the exact grant fingerprint. Opening a listed report performs normal freshness and
canonical checks. History is retained; historical stale report content is not yet
available through an as-of viewer. Limits remain explicit, including 100 inventory
entries per query and 1,000 human review events per report.

The native snapshot and each impact import are bounded to 4 MiB. Impact imports
allow at most 2,000 entities, 5,000 evidence records and 5,000 assertions per source;
a valid native snapshot can exceed these downstream limits and must then be rejected.
Default report budgets allow 2,000 visited nodes, 20,000 examined edges, 200 displayed
findings and 512 KiB output, with explicit incomplete/truncated coverage when reached.
The Qt response cap is 2 MiB, including report and review history, with a 30-second
request timeout. Oversized UI/history responses fail closed; use a narrower supported project/source scope. These bounds
are defensive limits, not an unlimited-graph or production-scale claim.

SQLite remains unencrypted and this slice accepts nonsecret metadata only. No live
telemetry, network discovery, device execution, general-purpose Agent tools or
multi-user authentication is added. Real business accuracy and time savings are
unmeasured. See the [execution record](../plans/2026-10-13-native-impact-review.md).
