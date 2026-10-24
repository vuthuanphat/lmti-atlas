# Typed project hierarchy and identity lifecycle

Date: 2026-10-19. Status: accepted implementation direction under master plan
STRUCT-01; increment 1 implements the typed domain and loss-prevention guard.
The full native build and 11/11 CTest passed on 19 October (49.64 seconds),
including project_structure_domain; no hierarchy package/UI claim is made.
Increment 2 adds dual-version storage and the durable identity registry.
Its applied native/Qt build passed all 13 CTest suites in 58.84 seconds.
Increment 3 now implements scoped versioned projection and trusted read capability;
its applied verification is linked below. Migration, reviewed import and hierarchy
presentation remain follow-on increments.

## Decision

Extend the existing Qt-independent ProjectDocument with an appended optional
ProjectStructure. Its typed records are Subsystem, ComponentMembership, Site,
Area, Environment and AssetPlacement. Absence means legacy/unavailable;
presence with empty collections means an explicitly declared empty structure.
Existing component and asset aggregates, stable IDs, standalone topology schema
and desired-config proposal semantics remain unchanged.

Subsystem parents form the logical project→subsystem→component forest. Areas
belong to a site and may have parent areas. Each existing asset may have one
placement with an optional area, parent asset and environment. A parent asset
must itself have a placement and share the child's site, area and environment.
The optional physical role is host, gateway or device; absence stays unknown,
regardless of the existing asset kind. No placement, environment or physical
role is inferred from labels, addresses, dependencies or desired bindings.

An explicit Site ID is the existing Asset.site scope identity. Its label can
change without changing grants. Every asset in a declared structure references
a declared site. An asset without a placement retains only its known site; an
unassigned component does not gain a fabricated subsystem. A software-only
project needs no synthetic physical entities.

Validation checks references, unique IDs, one parent per child, parent scopes
and containment cycles. The hierarchy walk uses parent indexes and iterative
visitation, not recursion or repeated ancestor walks. The maximum is 32
containment edges from the project/site root, including component/asset leaves
and combined area+asset ancestry. Catalogs use the existing 2,000-record guard;
asset placements use the existing 10,000-asset guard. These are safety bounds,
not a workload SLA. Dependency cycles remain valid and are never interpreted
as a containment tree.

Classification on a child does not override its ancestors. Public children
under internal parents are valid stored declarations, but future projections
must inherit the whole path's classification and filter before selection,
pagination or relationship traversal. A hidden parent must not appear as a
missing-parent hint or cause its child to be presented as a new root.

## Compatibility and staged implementation

Increment 1 validates typed in-memory structure and prevents removal of a
present structure through validate_update. Its initial blanket save refusal
is superseded by the explicit schema-2 owner below. Existing flat schema-1
reads and writes remain unchanged. No hierarchy CLI/MCP/UI capability or
migration is advertised by either of these increments.
Legacy in-memory context, impact and work-proposal application also refuse a
present structure: they do not yet enforce inherited hierarchy privacy.

Increment 2 uses explicit LMPR schema 2, with typed tables,
foreign keys, whole-document validation and the existing optimistic native
save transaction. Reads never auto-upgrade. Old binaries and legacy v1/v2
snapshot readers must fail closed on schema 2 instead of silently dropping
hierarchy. Updated metadata/full readers need explicit known-version branches
and must validate all required columns. A new opted-in snapshot v3 supplies
the hierarchy with inherited privacy; default tooling remains compatible with
schema-1 documents.

Migration must preserve the source and every existing entity ID and owned
field. The intended initial strategy is an explicit native copy into a new
schema-2 file with monotonically increasing saved revision, verified before
activation. Site records preserve known site tokens; no other hierarchy is
invented. Library activation requires expected-binding/revision checks and
recoverable prepared/activated states. Existing library upsert alone is not a
migration transaction. Downgrade is by preserved backup only; it must never
silently discard later schema-2 edits. Full package/library/memory recovery and
clean-machine acceptance remain separate gates.
Migration is bounded, not guaranteed for every valid legacy inventory: a
schema-1 document can contain more than 2,000 distinct site tokens. That exceeds
the proposed Site catalog guard; the migration must refuse with a budget error
and leave source/binding unchanged. It must not merge sites or drop assets to
make the new limit pass. Raising that limit requires an explicit budget review.

The project has one saved native revision, stored in topology.revision. Do
not add a global revision across native, knowledge and observation owners.
Hierarchy edits invalidate native proposals/cursors; observation samples do
not mutate the document revision.

## Required identity and reviewed lifecycle increments

Rename and move preserve the existing kind/ID. A replacement device receives
a new ID even at the same address. A native-owned durable active/retired
identity registry is mandatory: migration seeds existing identities, committed
deletion retires an ID in the same transaction, and later reuse is rejected.
The registry is bounded and private, without automatic tombstone deletion or
Agent-visible hidden counts. Unsaved Undo may restore a draft deletion; after
committed retirement it must not resurrect the identity. Increment 1 does not
claim this durable guarantee; increment 2 implements the transaction and
no-reuse checks for asset, component, subsystem, site, area and environment
identities. Existing repository/release/work identity rules are unchanged.

The schema-2 identity registry is private owner state, capped at 50,000 total
active plus retired rows. Exhaustion refuses the whole save; tombstones are
never automatically evicted. A full load requires exactly the current active
graph identities and rejects retired identities still present in that graph.
Unknown kinds/states, invalid IDs and duplicates are refused independently
of SQLite constraints. Before saving, the owner re-reads and validates the
current graph and registry inside BEGIN IMMEDIATE, checks project/revision,
derives retirement/additions and commits all typed tables and registry together.

An absent structure creates schema 1; an explicitly present structure at
revision zero may create schema 2. An existing schema-1 file still refuses a
structured save until explicit migration exists. Schema-2 reads use exact
known table/column/type layouts and domain/foreign-key/registry checks.
Schema-1 readers reject reserved schema-2 tables even if user_version was
changed to 1. Metadata reads recognize both supported versions and validate
layout and metadata, but deliberately do not certify graph/registry health.
Reading never upgrades or repairs either format.

The legacy snapshot v1/v2, context, impact, work-proposal and desired-config
proposal owners refuse present structure until hierarchy-aware projections
and mutation policy exist. This includes operator-local legacy requests;
there is no implicit privacy bypass for local callers.

Save As is temporarily unavailable for saved structured documents. Native
load and successful mutable save attach an owner-only lineage marker binding
project/schema, canonical local path and the persisted store UUID. The marker
rejects reset-revision, fresh-file and cross-file saves; the UUID check inside
the current save transaction also refuses same-path replacement by another
same-project/same-revision store. Schema 2 owns a singleton store_identity table;
its UUID and the local path are never serialized through Agent projections. The
structured save requires a mutable ProjectDocument so first-save callers also
retain the marker; the compatible const overload supports flat documents only.
Marker allocation and validation happen before commit and its final move cannot throw; no
post-commit readback is used. Qt additionally refuses a different destination
when a structured document already has a saved path. The explicit future copy
API must copy registry/history and source state, not reconstruct from the active
graph. These checks protect normal native owner operations, not malicious C++
code that deliberately discards native-only state or directly edits SQLite.

The reviewed import increment must preserve source namespace, external ID,
native endpoint, source revision and reviewed evidence. Identical version and
payload retries are idempotent; changed payload at the same version conflicts.
Partial source omission never implies deletion. Explicit deletion, complete
source absence, address reuse and external-ID replacement are reviewable
retirement/replacement changes. Conflicting source assertions are retained
with evidence instead of last-write-wins. No automatic reassignment of
observations, bindings or code/document mappings follows a label/address match.

Authoring uses bounded typed operator changes against expected revision/old
values, followed by one native save. Agent reads stay nonwriting. The browser
will show separate logical/physical views, owner-backed children and ancestry,
partial/unknown coverage and explicit review. Qt must retain structure on
load/edit/save/Undo/Redo after intentional migration; no parity claim precedes
those checks. TS memory, compiler, legacy Go and host-application runtime stay
independent.

## Verification scope

The targeted project_structure_domain suite exercises typed references,
containment cycles/depth, dependency-cycle compatibility, unknown placement,
rename/reparent identity preservation and schema-1 no-write refusal. Existing
project_domain_storage and desktop compatibility tests remain necessary.
Increment 2 adds project_structure_storage for typed roundtrip/empty structure,
metadata/library compatibility, all six retirement kinds, same-label replacement,
stale revision and SQL-failure rollback, registry corruption/budget, schema
confusion and real CLI privacy refusal. structure_desktop exercises same-path
Qt preservation, first-save lineage, retirement and Save As refusal. These
passed in the applied build; the exact run and scope are recorded below.

Future acceptance must additionally prove migration/recovery fault cases,
old-binary refusal on exact packages, ancestor/path privacy,
versioned projection/cursor behavior, bounded task-context traversal without
sibling expansion, reviewed import conflict/replacement, real UI authoring and
the normal generated MCP setup on an exact rebuilt package. No live-provider,
independent-operator, model-quality or performance-threshold acceptance is
implied by the typed domain tests.

## STRUCT-01 increment 2 — applied native storage evidence

The full Release native/Qt build passed, followed by 13/13 CTest suites in
58.84 seconds, zero failed or skipped. New project_structure_storage passed
in 2.27 seconds and structure_desktop in 0.89 seconds. The source-only change
adds schema-2 typed hierarchy, a private bounded active/retired registry,
same-transaction graph/revision/identity updates, store UUID/path lineage,
legacy privacy refusal and safe Qt Save As behavior. A deprecated Qt test macro
was replaced and that target rebuilt before the final suite.

Tests cover all six retirement kinds, new-ID replacement, SQL-failure rollback,
schema/registry corruption and downgraded version tags, cross-store divergent
tombstones and same-path independent replacement. The corruption writer tests
load each destination before corruption, so they reach transaction validation
rather than short-circuiting on a different source path. Independent review's
cross-store lineage finding is resolved; no further actionable defect was found.

The build is not a new packaged hierarchy capability. Explicit copy migration,
registry-preserving clone, recoverable binding activation, snapshot v3/inherited
policy, reviewed mapping/import and operator UI remain required. Existing bridge
packages and their historical MCP/browser/recovery evidence remain unchanged.

## STRUCT-01 increment 3 — applied scoped read boundary

The [v3 read-boundary record](../plans/2026-10-19-structure-read-boundary.md) documents inherited privacy, directed
Agent traversal, strict integration v2 and the broker-to-child configuration
pin. Current source passed134 Agent tests and25 config-owner tests; native
and API failures were repaired and their focused regressions passed. The
record keeps full-run and focused evidence distinct. No new packaged
hierarchy, migration/activation, UI or live acceptance is implied.

## STRUCT-01 increment 4 — native copy and migration

The [copy-owner record](../plans/2026-10-20-project-copy-owner.md) documents applied schema-1 migration,
registry-preserving schema-2 clone, WAL-consistent snapshots and read-only
recovery evidence. Release build and all 15 native/Qt suites passed in
74.74 seconds after the revision-bound correction. Copy receipts
do not activate a library binding. Durable binding generation/CAS, reviewed
activation, operator UI and mapping lifecycle remain follow-on work.

## STRUCT-01 increment 5 — native library generation

The [library-owner record](../plans/2026-10-20-project-library-generation.md) documents explicit retained-backup
v1-to-v2 upgrade, UUID/generation binding CAS, stale automatic-writer
refusal and commit reconciliation. Release builds and all 16 native/Qt
suites passed in 83.76 seconds; the focused suite passed in 5.22 seconds.
Copy activation and its durable receipts, operator UI, mapping lifecycle
and a new packaged hierarchy runtime remain follow-on work.

## STRUCT-01 increment 6 — native copy activation

The [activation record](../plans/2026-10-20-project-copy-activation.md) documents explicit retained v2 backup,
v3 prepared/activated/abandoned receipts and held source/target snapshots.
Release build passed; reservation and activation focused suites passed in
5.59 s and 23.54 s, then all 18 native/Qt suites passed in 110.71 s.
Private caller fingerprints, deliberate UI flows and client reconfiguration
still need wiring; no new package or end-to-end acceptance is claimed.

## STRUCT-01 increment 7 — caller identity and Qt library CAS

The [caller record](../plans/2026-10-20-project-binding-callers.md) documents private native identity, strict web
projection/fingerprints and deliberate Qt library intents. Release/TypeScript
builds passed; API 50/50 and native/Qt 20/20 (129.89 s) passed.
Qt MCP modal freshness and writer lifecycle, operator activation UI, mapping
and handoff remain. This is not a new package or full MVP acceptance.
