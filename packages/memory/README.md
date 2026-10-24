# @atlas/memory

Structured memory layer for ATLAS.

It includes local `.lmti` memory storage for CLI workflows and in-memory short-term/long-term memory classes for runtime playground sessions.

## Long-Term Memory Engine

The long-term memory path is now an engine, not a keyword-only note store:

```text
Input Event
  -> Encode
  -> Short-Term Buffer
  -> Consolidate
  -> Long-Term Memory
  -> Retrieve
  -> Reinforce / Decay
```

Engine responsibilities live in focused modules:

* `encode.ts` normalizes memory, infers cues, computes priority and creates a privacy-safe summary.
* `consolidate.ts` selects high-priority short-term records for long-term storage.
* `retrieval.ts` scores activation with lexical, intent, association, priority, decay and privacy inputs.
* `decay.ts` weakens stale low-value memory without deleting durable project rules.
* `reinforce.ts` strengthens successful memories and weakens false matches.
* `associations.ts` updates Hebbian-style memory links.
* `review.ts` schedules important memories for review.

Raw chat history is not stored by default. Secret-like content is marked `secret`
with `do_not_prompt`, and context retrieval still passes through the Cognitive
Privacy Layer before anything can enter a prompt or preflight package.

## Project Operating Memory

The production-oriented long-term memory path is backed by local SQLite:

```text
.lmti/memory/project-memory.sqlite
```

This layer uses Node's built-in `node:sqlite` runtime API. The rest of the
package remains import-compatible without opening SQLite, but these commands
require a Node runtime that provides `node:sqlite` (tested on Node 24).

It adds:

* FTS5 full-text search with BM25 ranking.
* Schema-versioned SQLite migrations. Version 3 adds `content_hash` for
  tamper/staleness checks without storing raw secret material.
* Library zones: `architecture`, `codebase`, `workflow`, `deployment`,
  `security`, `decision`, `lesson`, `incident`, `customer`, `business`,
  `prompting` and `unknown`.
* Write-time privacy gate that redacts secret-like material before storage.
* Retrieval-time privacy gate that blocks `secret` and `do_not_prompt` memory
  before AI prompt assembly.
* Lesson candidates through the explicit proposal and approval flow.
* Short Memory notes for temporary task context with TTL, FTS5 retrieval,
  expiration, cleanup and explicit promotion into Long Memory.

CLI:

```bash
lmti memory init
lmti memory add --title "Partner dashboard 403" --content "Partner user must route to /partner."
lmti memory search "dashboard 403 partner"
lmti memory retrieve "fix partner dashboard permission"
lmti memory lesson propose --task "Partner route fix" --lesson "Partner user must route through /partner."
lmti memory lesson candidates
lmti memory lesson approve <candidateId>
lmti memory stats
lmti memory privacy-check
lmti memory short:add --title "Current checkpoint" --content "Inspect retrieval next." --priority medium
lmti memory short:retrieve "retrieval"
lmti memory short:expire
lmti memory short:cleanup --dry-run
lmti memory short:evaluate <noteId>
lmti memory short:promote <noteId> --reason "Durable lesson"
lmti memory context "fix partner dashboard permission"
```

Legacy JSON memory remains available for compatibility via commands that pass
`--scope ... --legacy`.

Legacy JSON is still used by `remember` and explicit compatibility helpers.
Project Atlas context and preflight use `readContextMemory`: SQLite when it
exists, otherwise the explicitly reported `legacy_json` compatibility source.
Callers may select `source: "legacy_json"`; stores are never implicitly merged.
An existing invalid SQLite store fails instead of falling back to JSON.
`memory migrate-json --dry-run` inventories all three legacy scopes
without opening a target DB or returning record contents. Actual TS/Go import
writes are blocked until project scope, policy, provenance and lifecycle can
be migrated losslessly; keep source stores. The SQLite schema remains v4.

The owner context reader returns source, revision, completeness, policy decisions
and all policy-safe candidates before final ranking/limits. It does not initialize
a missing store, migrate schemas, expire records, log access, reinforce memories
or change stored application data. SQLite may create/update WAL/SHM concurrency
sidecars during a read-only connection; these are not application writes. Live
WAL records are read through a transaction; the reader never uses `immutable=1`.
Legacy JSON reads likewise leave files unchanged. Secret/do_not_prompt, expired,
archived, superseded and unapproved SQLite lessons remain excluded.

The local-alpha scan budget is 10,000 records and 16 MiB of record payload;
`maxCandidates` can reduce the record budget. Overflow throws
`MEMORY_READ_BUDGET_EXCEEDED`, never a complete empty/partial answer. SQLite
search/short retrieval also examine their complete matching set (up to the
explicit record budget) before final scoring and limiting. They retain their
existing access-event behavior; use the context owner reader for read-only work.

Short Memory is not durable truth. Priority controls the default TTL: `low` 6h,
`medium` 24h, `high` 3d and `critical` 7d. Retrieval ranks active notes by
FTS5/BM25, recency, priority, matching tags, promote score and access count.
Promotion to Long Memory is explicit and blocked for `secret` or
`do_not_prompt` notes.

## Filesystem ownership

Memory owners resolve the selected project root before opening stores. A linked
project root remains supported. Links/junctions below that root and hardlinked
memory files are refused, including SQLite WAL/SHM/journal files. A boundary
failure does not migrate or relocate the target. Desktop snapshots, context,
legacy inventory and writers use the same containment checks.

On POSIX, new owned directories use `0700` and files use `0600`; writers reject
existing group/other-accessible or differently owned paths with
`MEMORY_STORAGE_PERMISSIONS_UNSAFE`. Review ownership and permissions explicitly
before retrying. No automatic chmod or recursive permission change is performed.
Read-only context can still inspect existing stores without changing their modes.
Windows retains existing ACLs and does not treat chmod as an ACL substitute.

Ancestor identities are checked again before use, and JSON/log writes validate
the opened file before changing its contents. These checks are not a sandbox
against a hostile process running as the same OS user: Node and SQLite path
APIs cannot prevent every ancestor replacement between a check and an open.
Keep the project and its parents under the operator's control. Legacy JSON
replacement still has its existing crash/concurrent-update semantics; SQLite
retains its transactional owner and schema.
