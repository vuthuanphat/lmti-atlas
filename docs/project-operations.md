# Private native project operations protocol

These fixed operator interfaces call the native copy/library owners. They do not
add Agent tools, browser capabilities, a domain store in JavaScript or device
actions. Existing profile mode remains separate. Tokens and receipts below are
private operator data, not browser path authority.

Read invocation: six argv values including the executable.

```text
lmti-mcp-admin --project-operations --library <trusted-library> --copy-parent <trusted-parent>
```

Write invocation: eight argv values including the executable.

```text
lmti-mcp-admin --project-operation-write --library <trusted-library> --copy-parent <trusted-parent> --backup-parent <trusted-backup-parent>
```

Both modes validate raw argument paths lexically before dependent I/O. Input
cannot replace these paths. Read mode rejects every write action and the backup
argument. Inspect/copy-preview and library format reads do not require the copy
parent to exist. Copy-discover/copy-inspect do not open or require the library.
Format upgrades use the backup parent; other writes do not open it. Abandon is
library-only. Terminal activation inspection does not open source, target or
copy parent, but still requires the original parent spelling to match the
receipt's native identity. Linked roots are preserved as metadata, not probed.
Project-copy source authority comes from the selected native library row.

Input is one strict UTF-8 JSON object, at most 32 KiB, with no duplicate or extra
keys. UUIDs, IDs, fields, integer/boolean types, digest syntax and token path
spelling are validated before filesystem access. On Windows both streams use
binary mode, preserving Ctrl-Z/NUL input and a single LF terminator. Output is one
compact JSON object plus LF, at most 512 KiB including that LF. Read overflow
returns only `{"ok":false,"code":"BUDGET_EXCEEDED"}`; write overflow preserves the
known outcome using the fallback described below. This private cap is separate
from the existing browser API's 256 KiB response cap.

Handled responses use exit code 0. A transport/setup failure can return exit 1
without a valid response. Raw owner error text is never serialized. Missing,
partial, malformed or unsuccessful transport output must not be treated as a
write refusal or a reason to retry.

## Shared private values

`LibraryIdentity` is `{schema,canonicalPath,uuid,generation,digest}`. Schema is
1/2/3; v1 uuid and generation are null; v2/3 use native UUID and generation.
Canonical path is an opaque native identity value, never a browser path grant.

`CopyToken` matches the owner intent:
`{schemaVersion,projectId,canonicalPath,storeUuid,revision,contentDigest,registryDigest}`.
The schema-1 store UUID is the owner's empty string.

`CopyIntent` is `{mode,seedsInternalSites,source,target}` with two CopyTokens.
Mode is `migrate_v1` or `clone_v2`.

`CopyPreview` is
`{mode,seedsInternalSites,source,targetRevision,targetContentDigest,targetRegistryDigest}`.

`FormatPreview` is `{source:LibraryIdentity,fullSnapshotDigest}` for v2→v3.
The full snapshot digest preserves nullable and cosmetic library values as well
as identity; it is not the binding-only v2/v3 authority digest.

`ActivationPreview` is
`{library:LibraryIdentity,projectId,copyParent,copyOperationId,mode,seedsInternalSites,source:CopyToken,target:CopyToken}`.
Its library path/schema and source/target identities remain immutable in receipts.

`ActivationToken` is `{libraryUuid,operationId,receiptDigest,revision}`.
`ActivationReceipt` is
`{token:ActivationToken,state,prepared:ActivationPreview,sourceFolder,sourceFolderKey,activatedGeneration}`.
The two folder values preserve null versus empty string independently.
`activatedGeneration` is numeric: 0 for prepared/abandoned, positive for activated.
Receipt state is `prepared|activated|abandoned`, with revisions 1 for prepared and
2 for either terminal state.

Owner codes are fixed uppercase names:
`NONE`, `INVALID_INPUT`, `SOURCE_CHANGED`, `UNSUPPORTED_SCHEMA`,
`BUDGET_EXCEEDED`, `OWNER_UNAVAILABLE`, `EVIDENCE_INVALID`, `TARGET_CHANGED`.
Library error equivalents additionally include `UNSUPPORTED_FORMAT`,
`CONFIG_CHANGED` and `RECOVERY_REQUIRED`. Facade selection refusal is `SCOPE_DENIED`.

## Read actions

Every success begins with `{ok:true,schema:"lmti.project.operations.v1",action}`.
The following fields complete each exact response. Handled read errors are
exactly `{ok:false,code}`.

1. Input `{action:"inspect",projectId}`.
   Output adds:
   - `libraryIdentity: LibraryIdentity`
   - `project: {projectId,name,database,root,schemaVersion,storeUuid,revision}`

   This uses full `load_project`, preserving max-revision/no-transform semantics.
   Schema-1 project storeUuid is empty. Recheck the exact library token and
   selected ID/path/root after loading; no root I/O.

2. Input `{action:"copy-preview",projectId,mode}`.
   Output adds:
   - `libraryIdentity: LibraryIdentity`
   - `projectId`
   - `preview: {mode,seedsInternalSites,source,targetRevision,targetContentDigest,targetRegistryDigest}`

   Resolve the source from the selected library row, call inspect_project_copy,
   check the returned source project ID, then recheck library token/row.

3. Input `{action:"copy-discover",offset,limit,snapshot}`.
   Output adds:
   - `complete`, `code`, `examinedEntries`, `unattributedEntries`
   - `snapshot`, `offset`, `nextOffset`
   - `items: [{operationId,state,intent}]`

   State is `uninspected`, `incomplete`, `invalid` or `unavailable`; intent is
   CopyIntent or null. Sort all bounded candidates by operationId before paging.
   Snapshot is SHA-256 of deterministic compact JSON containing exactly the full
   scan flags/code/counts and sorted complete candidate list under key `items`.
   A scan can succeed as a protocol response with complete=false and an owner
   error code. It never certifies a valid copy.

4. Input `{action:"copy-inspect",operationId}`.
   Output adds:
   - `status: {operationId,state,code,mode,seedsInternalSites,verifiedReceipt,source,target}`

   State is `prepared` or `recovery_required`. Source/target are CopyToken or null.
   If no validated source/target intent is available, mode and seedsInternalSites
   are null too; do not present default owner initialization as observed metadata.
   Only fixed operation files under the trusted parent are inspected. Recovery
   state/code is returned as status, not upgraded to success or retried.

5. Input `{action:"activation-history",projectId,offset,limit,snapshot}`.
   Output adds:
   - `libraryIdentity`, `projectId`, `snapshot`, `offset`, `nextOffset`
   - `items: [{operationId,projectId,copyOperationId,state,revision}]`

   State is `prepared`, `activated` or `abandoned`. Require supported library v3
   through the existing owner API, but do not require project registration or
   source readability. Filter history to requested ID, sort by operationId and
   recheck the library token after owner reads. Snapshot hashes compact JSON with
   exactly `{libraryIdentity,projectId,items}` for the full filtered list.

6. Input `{action:"library-format-preview",fromSchema}`; fromSchema is integer 1
   or 2. Output adds `{fromSchema,toSchema,expected}`. For 1→2, expected is the
   exact LibraryIdentity from `inspect_project_library`, requiring schema 1.
   For 2→3, expected is FormatPreview from
   `inspect_library_activation_upgrade`, which captures token and full digest in
   one transaction. No upgrade or multi-step “latest” operation occurs.

7. Input `{action:"library-format-status"}`. Output adds
   `{libraryIdentity,upgradeOperationId,legacyDigest,activationFormatOperationId,activationFormatBackupDigest}`.
   All values come from one LibraryInspection. Absent operation/digest metadata
   is null, including all four fields in v1. This reads no project, copy or backup
   file; it reports persisted library metadata.

8. Input `{action:"activation-candidate",projectId,copyOperationId}`.
   Output adds `{preview:ActivationPreview}` from the existing candidate owner.
   The owner resolves the selected source, independently inspects the fixed copy,
   checks fresh source/target identities and rechecks library authority.

9. Input `{action:"activation-inspect",libraryUuid,operationId}`.
   Output adds `{libraryIdentity,receipt:ActivationReceipt,condition,code}`.
   Condition is `prepared_current|prepared_stale|activated_current|activated_superseded|abandoned|inconsistent|unavailable`.
   Lookup uses the pinned library UUID and operation ID, not an obsolete receipt
   revision. Prepared readiness is advisory and rechecked by the owner; terminal
   history does not depend on old source/target readability. A successful protocol
   response may report a non-NONE code and unavailable/stale/inconsistent state.

Paging integers: offset 0..1000, limit 1..50. Initial offset 0 requires snapshot
null. Offset >0 requires an exact lowercase 64-hex digest matching the fresh full
bounded snapshot; mismatch returns CONFIG_CHANGED. Offset greater than item count
returns INVALID_INPUT; offset equal to count returns an empty terminal page.
nextOffset is null at the end, otherwise the next integer offset. Digests provide
repeatable page-content checks, not an atomic filesystem enumeration guarantee or
evidence that candidates are valid.

## Write requests

Each listed object is exact. No generic command, source/target path override or
automatic upgrade action is accepted. Expected tokens must be retained from the
reviewed read result; fresh reads never replace them silently.

| Request | Owner behavior |
| --- | --- |
| `{action:"copy-prepare",projectId,expected:{libraryIdentity,preview:CopyPreview}}` | Resolve the current selected library row; compare library and full source preview; recheck selected ID/path/root before `prepare_project_copy`. Creates a separate verified copy, preserves the source and does not change the selected library binding. |
| `{action:"library-upgrade-v1",expected:LibraryIdentity}` | Require expected schema 1; explicit `upgrade_project_library` with its fresh typed backup. |
| `{action:"library-upgrade-v2",expected:FormatPreview}` | Require expected schema 2 and full snapshot digest; separate `upgrade_library_activation_format` with typed v2 backup. |
| `{action:"activation-prepare",expected:ActivationPreview}` | Compare a freshly inspected candidate to the unchanged preview, then persist a prepared receipt through `prepare_library_activation`. |
| `{action:"activation-activate",projectId,expected:ActivationToken}` | Require matching project, exact prepared token and current advisory readiness; the owner takes fresh source/target reservations and commits binding generation/path plus activated receipt under library CAS. |
| `{action:"activation-abandon",projectId,expected:ActivationToken}` | Check pinned library UUID and matching prepared summary/project/revision, then pass the unchanged full token to the owner's digest/revision CAS. This path does not inspect source/target/copy files, delete a copy or undo an activation. |

V1 library previews have no durable UUID/generation and include cosmetic values.
V2/v3 binding authority ignores cosmetics, while v2→v3 format previews still pin
the full snapshot. Activation increments binding generation once; prepare and
abandon do not. Prepared sourceFolder/sourceFolderKey stay unchanged.

Copy preparation does not hold a library reservation throughout the copy. A
binding change after its preflight does not invalidate an owner-confirmed retained
copy result. Fresh activation review must compare that copy with the current
selected source. This interface does not claim cross-store atomicity.

## Write replies and recovery

Write replies have exactly seven fields:

```text
{schema:"lmti.project.operation.write.v1",action,outcome,code,operationId,details,detailsAvailable}
```

`action` is one of the six recognized write strings. If no recognized action was
parsed, it is null and the reply is refused/INVALID_INPUT with null operationId
and details and detailsAvailable false. Arbitrary action input is never echoed.
`operationId` is a native UUID or null; `details` is an object or null, and
`detailsAvailable` is true exactly when that object is present.

- `refused`: failure before entry into a mutating owner call. Operation ID and
  details are null; code is non-NONE.
- `confirmed`: the typed owner result confirms the requested operation. Code is
  NONE. Subsequent encoding or readback failure must not turn it into refusal.
- `unknown`: an exception after owner entry, or a returned recovery-required
  result. Code is non-NONE. Returned intended tokens/receipts may not be committed.
  Only fresh owner inspection establishes durable state.

Full confirmed details are action-specific:

| Action | `details` |
| --- | --- |
| copy-prepare | **Direct** `{operationId,state,code,mode,seedsInternalSites,verifiedReceipt,source,target}` status object. Read `copy-inspect` still wraps this object under `status`. |
| either library upgrade | `{state:"upgraded",operationId,backupPath,libraryIdentity}` |
| prepare/activate/abandon | `{receipt:ActivationReceipt}` in the corresponding requested result state |

Unknown copy details use the same direct status shape with recovery-required
state. Unknown upgrade details use
`{state:"recovery_required",operationId,backupPath,libraryIdentity}`, with each
unavailable identity/path value null. Unknown activation details contain
`{receipt:ActivationReceipt}` when the owner returned one, or details is null.
Such receipts are recovery hints, not proof of persistence.

Minimum outcome frames are serialized before owner entry. The owner chooses
operation/store UUIDs internally, so the complete result cannot be prebuilt.
Immediately after owner return the façade latches confirmed versus unknown before
allocating result JSON. If encoding fails or exceeds 512 KiB, the prebuilt frame
retains that outcome with operationId/details null and detailsAvailable false.
A confirmed fallback means the action completed but its details require read-only
recovery; it never grants authority to an unidentified target. Failure to prepare
the frames exits before owner I/O. A pipe failure after a committed operation still
leaves the receiving caller without confirmation. No second frame, retry or
post-success owner readback is performed.

The caller must retain a dispatched write until its process exits; a timeout,
navigation event or lost acknowledgment is not permission to kill/replay it.
An unknown reply, malformed output or missing transport result requires
read-only reconciliation:

- Copy with a retained UUID: independently inspect that fixed operation.
  Without a UUID, bounded discovery supplies candidates only. Zero, multiple and
  unattributed/incomplete results do not identify a winner or prove no write.
- Library upgrade: compare persisted format-status operation/digest/identity
  against the reviewed source and any retained operation ID. Intended returned
  tokens alone do not prove commit. Without a retained ID, observing the resulting
  format need not attribute the change to a particular caller.
- Activation: inspect by pinned library UUID/operation ID. Lost preparation IDs
  can be found in bounded project history, followed by explicit inspection.
  Superseded activation is historical state, never an automatic cutback.

The interface never automatically resumes, deletes interrupted artifacts,
rolls back a backup or chooses the latest candidate. External MCP configuration,
grants and integration pins are not retargeted by activation.

## Caller boundary

These native modes do not themselves add a launcher/API/browser workflow. A
broker must supply trusted paths, explicit operator scope and a separate
library-maintenance capability for library-wide format changes. Project/Agent
read permission alone is insufficient. Private token values stay broker-side;
browser controls should use opaque reviewed handles with one-use decisions.
Candidate/history results must be filtered to the allowed project scope.
The existing browser API cap remains 256 KiB, independent of this private 512 KiB
protocol. There is no build, package or live-provider acceptance claim in this
protocol document.
