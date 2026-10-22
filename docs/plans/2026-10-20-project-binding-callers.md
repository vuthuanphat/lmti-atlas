# STRUCT-01 increment 7 — private binding evidence and Qt library CAS

Native facade and web broker now carry strictly validated private library and
selected project identities. Browser inventory/summaries receive explicit public
projections; raw paths, UUIDs and generation remain private. Inventory does not
open offline project files. Durable library v2/v3 UUIDs and native project
schema2 store UUIDs detect replacement at unchanged path/revision. Library v2/v3
generation detects root ABA; cosmetics do not invalidate it. V1 lacks those
durable guarantees. Deliberate configuration exports still contain their reviewed
runtime/database arguments. A native canonical path is
an opaque identity key, never a browser-supplied I/O selector.

Qt captures registration/root/remove intent before modal review, uses the exact
v2/v3 token, and does not obtain a new token after a conflict. On v2/v3,
ordinary remember cannot register, resurrect or activate another file. Saved/opened documents
survive index failure; their linked root is withheld and the warning remains.
Unconfirmed outcomes instruct inspection without replay. V1 compatibility checks
all bindings while ignoring cosmetics; it has no durable identity/ABA guarantee.

## Validation

- Release native/Qt and TypeScript builds passed.
- Native binding/export: 2/2, 6.90 s; focused web binding/broker: 22/22, 10.307 s.
- Full web API: **50/50**, 29.413 s, zero failures/skips.
- Qt library CAS: 30 behavior rows plus init/cleanup, 32/32, CTest 21.65 s.
- Full native/Qt: **20/20**, 129.89 s, zero failures/skips.
- Independent review found no unresolved blocker within this slice.

Initial focused API failures were test assumptions (Unicode expansion and mixed
script trees). The first full API run lacked Qt dependencies beside the current
native binary under the Agent's sanitized environment. A separate test runtime
uses current executables and hash-verified bridge-r2 Qt components; the environment
restriction was retained. Failed logs and subsequent passes are recorded separately.
The API doctor/presentation checks still concern immutable bridge-r2, whose manifest
is `2960c73da1fb3394a6eca2882325c88b236885d2de8b3272b23b27d5cfcf3531`.
This is source/runtime evidence, not a new integrated package or client acceptance.

## Next scope and boundaries

Qt MCP immutable reviews, modal-time rebinding checks and writer unknown outcomes
are now covered by [increment 8](2026-10-20-qt-mcp-binding.md). Trusted integrated
MCP export in Qt is separate remaining work. Continue operator copy/activation/recovery
flows, hierarchy authoring/reviewed mapping and Agent proposal handoff before
packaging. Controlled replay remains first; live sources/operator/clean Windows
are post-build gates. No scope expansion or credential request follows from a
generic approval. Separate-process checks do not claim cross-store atomicity.

Machine-readable evidence: `LMTI_Kiem_chung_lien_ket_2026-10-20.json` in the task
outputs, including applied source hashes, executable hashes, logs and runtime scope.
