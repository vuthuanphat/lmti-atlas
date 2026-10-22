# Reuse the Impact owner for reviewed source mappings

Date: 2026-10-19. Status: **proposed; not implemented or accepted as complete**.
This proposal implements the existing master-plan mapping lifecycle requirement.
It does not add a new roadmap or change release thresholds. Current build work
uses controlled replay; real devices, a representative operator and clean-Windows
acceptance remain later gates.

Related decisions: [evidence Impact owner](2026-10-12-evidence-impact.md),
[native projection/review](2026-10-13-native-impact-review.md),
[native hierarchy](2026-10-19-project-hierarchy.md),
[native Agent references](2026-10-14-agent-reference-projection.md).

## Problem and existing foundation

Normal integrated Agent reads use explicit immutable mappings in
integration_config.py and knowledge.py. They safely intersect current native
references and use the compiled-knowledge/reviewed-memory owner, but no operator
reviewed import supplies those mappings. Changing them requires editing and
repinning trusted configuration.

The existing packages/impact owner already supplies scoped source namespaces,
source-local keys, persistent identity ownership, normalized import batches,
pending/accepted/rejected state, optimistic revision checks, history, rename,
source freshness/deletion/unavailability and assertion conflicts.
impact-command.ts already has import, import-code, import-native, inspection and
explicit review, including a separate desktop operator capability. Reuse this
implementation and its LMIP store.

The remaining gaps are specific: assertion-only deltas miss isolated mapping
changes; source tombstones do not establish native per-entity retirement;
replacement cannot reassign a reserved external key through review; and current
snapshot/entity/evidence operations are historical projections without fresh
source checks. They cannot directly authorize current Agent mapping resolution.

## Decision: one source owner, explicit native ownership

| Owner | Durable responsibility | Boundary |
| --- | --- | --- |
| Impact / LMIP | Registered external source identity, generations/aliases, reviewed mapping batches and evidence, source checks, mapping conflicts/history | Sole source-mapping writer; no access to native tables or memory internals |
| Native / LMPR | Project, component/asset/container identity, private active/retired registry, hierarchy, desired declarations and native commit receipt | Sole native writer; imported facts arrive as bounded proposals |
| Knowledge owner | Compiled summaries and reviewed memory with original classification/disclosure policy | Existing summary API; no raw source returned by mapping projection |
| Python/broker/UI | Scoped transport, exact DTO validation, read composition and human review | No direct cross-owner storage access and no new arbitrary command tool |

Native increment 2 deliberately stores only private native kind/ID/status.
It must not add a second external source catalog. Every mapping resolves the
original native project/kind/ID, never an Impact-derived hash or a label. Mapping
review records the native revision used for validation; reads also resolve the
current native reference fingerprint and ancestry policy.

There is no global revision. Retain native revision, Impact graph/batch revision
and knowledge/source fingerprints separately. A native rename/reparent changes
native evidence; a knowledge refresh does not mutate the project document.

## Typed mapping contract

Extend the current Impact import/review model, with a versioned opt-in mapping
contract. All names below are proposed, not shipped API guarantees.

A mapping has a stable opaque mapping ID, registered source ID, external key,
external generation, target native project/kind/ID, source version token,
classification, evidence IDs and explicit active/retired state. It optionally
links an Impact entity ID, but that ID is never the native target identity.
Supported payloads are a discriminated union:

- **Identity association:** external component/device/catalog identity to a native
  component/asset/container. Labels, IPs and addresses are attributes, not keys.
- **Knowledge association:** code/document/memory source selection to a native
  repository/knowledge/component reference. The trusted adapter stores relative
  selections, reference fingerprint and explicit disclosure. Compiled public
  summaries and owner_safe_summary memory remain distinct permissions.

Register source authority separately from mutable import heads. An Agent request
cannot choose a namespace, database, root, executable, source path, environment
grant or source-check result. UI requests select opaque configured source/batch
handles. Native target kinds must exist in the supported owner projection;
unsupported kinds fail rather than becoming generic objects.

Use the existing defensive source/import capacities; new mapping read pages are
bounded by the existing Agent context budgets. Exact record, byte and history
bounds must be encoded and tested before implementation is complete. Exceeding a
limit fails explicitly or returns a declared partial read; it never truncates a
complete import into an accepted snapshot.

## Update and identity rules

1. A source submission identifies expected accepted mapping version, a new
   opaque mapping-version token and canonical payload digest. The mapping-version
   token is separate from an existing repository revision label, which may stay
   unchanged in a dirty checkout.
2. Same source/version/digest returns the original batch receipt without another
   mapping mutation. Same version/different digest conflicts. A stale expected
   source version or native revision cannot silently overwrite newer state.
3. Keep the existing complete-source import contract as the initial controlled
   transport. A partial submission is rejected as unsupported or supplied as an
   explicit typed patch against an exact accepted baseline; missing records in
   partial data never imply retirement. Do not reinterpret complete:true from a
   live provider until its authorized coverage is defined.
4. Rename or file move preserves mapping/native ID when the reviewed source
   key/generation remains the same. An explicit alias change reserves the old
   alias permanently. No match on equal labels, addresses or paths merges IDs.
5. Source disappearance marks data deleted/unavailable and preserves history.
   Mapping retirement is a separate reviewed diff. It does not delete the native
   target or other-source associations automatically.
6. Reused external identity requires an explicit replacement generation with
   evidence and a new native target identity. Acceptance retires the old
   association; observations, desired bindings and code/document references are
   not copied. Without generation/replacement evidence, expose an identity
   conflict. Controlled fixtures supply deterministic generation tokens now;
   real-provider generation rules are chosen later.
7. Native retirement is final within that document lineage. A mapping cannot
   revive a retired native ID. Renaming/replacing a source never bypasses this
   registry. Unsaved draft undo remains native owner policy.
8. Retain conflicting source assertions and competing field proposals. A mapping
   conflict needs an explicit resolution against current versions; accepting an
   import is not permission for last-write-wins topology edits.

## Storage and migration

Extend the existing LMIP store through explicit schema 3, preserving source
heads, imports, accepted batches, entity_identity/entity_keys, reports and review
history. Add typed mapping/version/generation and receipt records in that store;
do not create a second mapping database or put topology into JSON source files.
Existing historical Impact payload storage is not authority to store new native
topology there.

Keep v1/v2 read behavior and legacy import compatibility until explicit upgrade.
Mapping writes require schema 3. Upgrade reuses the owner backup and transaction
discipline: separately verified backup including WAL, expected version/data
revision, rollback on failure, no overwrite and no migration during reads.
An older binary must reject schema 3. Migration does not invent mappings,
generations, native endpoints or retirement decisions from labels. Existing
source-key reservations retain their historical ownership.

A concrete DDL/validator design is part of the first implementation increment;
the required ownership and state transitions above are the constraints on it.
The native LMPR schema-2 migration/identity registry is separate and must preserve
its own tombstones.

## Current accepted-mapping read

Add a fixed read operation on the existing owner, proposed name
accepted-mappings, with exact schema and a paged response. It accepts only query
narrowing and a signed cursor. The trusted process startup supplies registered
source IDs, project/site/environment ceiling, target, fixed store and owner path.

The response contains authorized active mappings, current source checks,
accepted batch/review/source versions, graph revision, reference evidence,
completeness/reasons and a stable fingerprint. It does not expose file paths,
hidden IDs/counts, executable metadata or raw compiled/memory text. checkedAt is
not part of the stable fingerprint.

Read accepted rows in one owner transaction; check current source/config/grant
before and after collection. Re-read or refuse if relevant versions changed.
Pending/rejected candidates never become current context. Unavailable/stale
source mappings cannot authorize knowledge disclosure; report their state and
omit their mapping values. Revoked authority returns no prior mapping values or
IDs. Existing as-of snapshot APIs retain their documented semantics.

The native owner projection then checks current endpoint and complete ancestry
privacy, including environment narrowing. A mapping owner grant cannot widen
native scope. Python intersects the resulting kind/ID/reference fingerprints and
calls the existing knowledge owner. That owner remains responsible for current
compiled hashes, ignore policy and reviewed-memory disclosure. Preserve Internal
on permitted safe summaries; do not relabel them Public.

## Normal generated MCP integration

Add an explicit reviewed-mapping mode to a versioned trusted integration config.
Its immutable binding pins packaged owner entry, store identity, allowed source
IDs, authority/policy ceiling and native source identity. Existing -I generated
argv and integration SHA checks remain mandatory. Fixed manual mappings remain
a compatible mode; do not silently merge both authorities.

The pin covers immutable delegated authority, not every legitimate accepted
mapping head. Owner-approved version updates are read from the owner and appear
in evidence; they do not require secretly editing pinned integration JSON.
New source registration, wider policy or a different native authority requires
explicit review/re-export/reconnect. A changed authority config latches
revocation; restoring old bytes does not revive that process. Never trust a
mutable child launcher grant to widen the pinned ceiling.

The current packaged agent-knowledge-owner.ts allows only agent-context and
does not contain Impact. Add a separate fixed read-only mapping-owner entry that
reuses packages/impact and bounded loader helpers; do not expose the general CLI
or import/review commands to Agent startup. The authenticated operator broker has
a separate fixed entry for reviewed writes. Package each with manifest/doctor
checks and test the exact generated configuration. Five Agent read tools remain
compatible; no extra writable MCP tool is required.

## Native mutation and recovery

Accepting a mapping that only links existing authorized knowledge references
commits solely in Impact. It does not change native topology or memory.

A candidate that changes a native identity, label, containment or desired
declaration uses the native typed proposal/review owner. A batch may be reviewed
but must stay non-serving while its required native mutation is pending. Bind
the native preview to expected native revision/old values, accepted source
generation/digest, operator session and operation ID.

There is no distributed SQLite transaction. Reuse operation tracking with
durable prepared, native-committed and finalized receipt states, retaining
failure/unknown outcomes. Native checks its registry and expected values under
its writer lock; source/grant/digest checks are repeated before first durable
write. Reconcile by inspecting the native operation receipt after interruption.
Finalize the Impact active association only when the exact native result is
confirmed and current source authority still permits it. If authority was
revoked after native commit, preserve the receipt and keep the association
non-serving for explicit recovery; do not undo a saved native edit silently.

Reject before commit changes neither native nor accepted mapping state. A
transport timeout must never trigger an automatic commit retry. Replay of the
same confirmed operation inspects the receipt and cannot increment native
revision twice. Unrelated native edits require revalidation, not label-based
rebinding.

## Operator experience and serial implementation

Extend the existing source import inbox in Structure & Sources. Show entity,
mapping and evidence diff even if no assertions changed, current versions,
native target identity, original classification and retirement/replacement
consequences. Reuse preview expiry, session/project binding, accept/reject,
pending operation inspection, navigation lock and re-read after success.
Source selection uses registered handles; root paths and authority cannot be
entered through Agent arguments. Independent operator acceptance is after build.

Follow the master's one-main-item sequence:

1. After current STRUCT storage work, add owner typed contract, mapping diff,
   receipt identity and explicit LMIP upgrade tests.
2. Implement accepted-mapping read and Python/knowledge composition while keeping
   legacy mappings and five-tool setup compatible.
3. Connect the existing operator import/review flow and native handoff/recovery;
   prove rename, retirement, replacement and conflicts on controlled input.
4. Package and run exact generated MCP plus operator UI evidence. Extend the
   workload report without changing thresholds after results are known.

## Required focused evidence

Tests must include entity-only/code-only diffs; rename preserving identity;
same-token retry/conflicting payload; partial omission; complete retirement;
explicit replacement generation; retired native ID refusal; conflicting sources;
review/source/native/grant changes around lock and return; pending/rejected/
revoked mappings absent from context; hidden ancestor/endpoint/path privacy;
unchanged memory disclosure; old-format behavior; explicit upgrade interruption;
and unknown native outcome recovered without duplicate writes.

The normal generated profile must read the accepted update and its evidence,
then withhold it on source change/revocation. Real UI reject must preserve both
accepted mapping and native state; one accepted native change must persist once,
with independent owner inspection. No Agent read mutates native/Impact/memory
stores. Real device connection, independent operator, clean Windows and measured
product benefit remain unclosed acceptance gates after this controlled build.

