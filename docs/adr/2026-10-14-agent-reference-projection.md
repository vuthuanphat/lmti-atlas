# Declared project references for the Agent MVP

Date: 2026-10-14. Local MVP implementation under the owner's r6 build-first
instruction. This extends the accepted native owner, not its storage model.

The saved typed ProjectDocument already owns RepositoryRef, KnowledgeRef and
component association. The v1 snapshot omitted these deliberately. Add the fixed
`agent-snapshot` CLI operation with `lmti.project.snapshot.v2`; keep `snapshot`
v1 unchanged for impact, legacy SDKs and existing client profiles.

V2 is a single read-only owner transaction with the same 4 MiB response budget,
project/site/target validation and inherited classifications. It adds permitted
repository identities, component repository IDs and knowledge identities with
component associations. Raw repository/document locators and stored fingerprints
are withheld. Opaque SHA-256 binding fingerprints invalidate cursors when a saved
reference changes, including edits that failed to increment the project revision.
They certify neither a fetched document nor a checked repository revision.

Python opts in with `NativeProjectSource(..., include_references=True)` or MCP
`--references`; this requires a newly built native owner. No automatic fallback
on a failed v2 read, raw file access, network fetch or privacy widening occurs.
The Agent graph includes repository/knowledge entities and declared
`implemented_in` / `documented_by` relations. Content is `not_loaded` with explicit
unknowns. Existing component code-mapping gaps remain: a repository association
does not establish symbol/file-level mapping or loaded project memory.

Native storage remains typed C++/SQLite. Python DTOs and JSON are boundary views
only. No schema migration, graph database, new dependency or model-specific
component is introduced. Double owner reads still validate consistency; this
slice does not improve full-projection I/O or establish a scale SLA.

Next build work: connect authorized compiled code/document/memory projections
through their existing owners, then expose the integrated structure/review UI.
Live clients/providers and operator acceptance remain deferred, not passed.
