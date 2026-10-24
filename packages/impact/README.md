# Evidence-backed change impact — local synthetic slice

This package implements the additive TypeScript owner accepted in
[the ADR](../../docs/adr/2026-10-12-evidence-impact.md). It does not open native
LMPR/topology schemas or `.lmti` memory, replace Qt, run a model, scan a network,
execute a checklist or control equipment. Node's built-in SQLite is the only new
storage mechanism; `@atlas/privacy` is the existing internal privacy dependency.
The [native review ADR](../../docs/adr/2026-10-13-native-impact-review.md) adds a
versioned owner snapshot adapter and a Qt operator review surface using this same
engine. It does not give this package access to native storage.

The demonstration intentionally starts with **9 entities, 8 assertions and two
source families**: a synthetic code snapshot and a warehouse manifest. Manifest
A/B/C demonstrates staging, stale evidence, explicit review and changed metadata.
It is smaller than the planned 30–80 entity pilot. It has no real warehouse data
and no independently approved business oracle.

`compileMappedCodeSource({root, source, mappings})` adds an actual file-backed
adapter for explicitly mapped public/nonsecret `.ts`/`.js` files. It reads only
the supplied files, checks a top-level named `export function` declaration with
a body, and returns `{snapshot, inputs:[{file,digest}]}`. IDs come from the mapping,
so an explicit filename change preserves identity. Raw source text and function
bodies are neither returned nor stored. Code evidence is anchored to the mapped
entity and has its own policy check even before a relation references it.

The recognizer strips comments and quoted strings, requires the declaration at
the start of a logical line, and rejects templates, regex/division syntax,
ambient declarations, ambiguous exports and unsupported return-type forms. It
does not validate full TS syntax or behavior, resolve imports, infer dependencies,
perform an LSP lookup, or prove the code is deployed. Import a richer owner-produced
snapshot for unsupported code rather than silently guessing. File reads are
bounded to 256 KiB each/1 MiB total/100 mappings, reject binary/non-UTF8 data,
private annotations, detected secrets, symlink/junction paths and traversal.
Both the source fingerprint and trusted launcher input hashes change when file
bytes change even if size and mtime are restored. A read-only source adapter must
recheck those input hashes when preparing current context.

## Owner API

`src/index.ts` exports typed contracts and these synchronous owner functions:

| Operation | Behavior |
| --- | --- |
| `initializeImpactStore(path)` | Explicit creation of an LMIP application-ID/schema-2 SQLite store. Existing schema-1 remains readable; foreign files and `.lmti` paths are denied. |
| `upgradeImpactStore(path, {backupPath})` | Explicit v1→v2 migration after exclusive WAL-inclusive SQLite backup and integrity checks; atomic DDL rollback on failure. No implicit reader migration. |
| `compileNativeProjectSource(snapshot, options)` | Validates a complete scoped native owner projection, stable identities and fingerprints; desired-only software/deployment/asset relations. Physical links never become causal dependencies. |
| `importImpactSnapshot(path, input, {expectedRevision, actor})` | Validates a complete source snapshot, stages an idempotent batch, advances source head and records an atomic history event. |
| `reviewImpactImport(path, batchId, {decision, expectedRevision, reviewer, evidenceReviewed, grant})` | Operator review only. A supplied launcher grant must cover the complete batch and its referenced entities inside the same transaction. Never approve a filtered preview. |
| `recordImpactSourceStatus(...)` | Operator/owner records a deleted or unavailable source without removing accepted history. |
| `readImpactSnapshot`, `lookupImpactEntity`, `getImpactEvidence` | Read-only existing-store access under project/site/environment/privacy grant. Missing readers do not initialize or migrate. |
| `listImpactImports`, `readImpactImport`, `readImpactHistory` | Scoped source-review and history views. An import preview is filtered to its grant and must not be reinterpreted as a full source export. |
| `createImpactReport(path, grant, change, options)` | Read-only deterministic directed report. No implicit persistence or model call. |
| `saveImpactReport(...)` | Explicit operator persistence after fresh source checks and full canonical recomputation. |
| `loadImpactReport`, `revalidateImpactReport` | Recheck principal/policy, exact source set, freshness, graph/rules and regenerate canonical output including query budgets. Modified paths, dispositions, source omissions or prose are denied. |
| `listImpactReportSummaries(path, grant, {limit})` | Read-only exact-grant saved IDs/timestamps/revisions; default 50, maximum 100, explicit truncation. Opening still requires revalidation. |
| `createImpactReviewOperator(path, grant, {reviewer, freshness})` | Trusted operator-only read/record capability; append human pending/verified/failed outcomes with independent optimistic review revision and source/report binding. Not an Agent tool. |

Operator APIs without a grant are trusted local owner calls, used for disposable
fixtures. An application boundary must supply its launcher grant to review and
must authorize import/initialization separately. Do not expose owner writes as
Agent tools. Same-user local processes are not an OS sandbox or multi-user RBAC.

The SQLite schema keeps source heads, versioned import/entity/assertion/evidence
rows, stable identity keys, review history and explicit saved reports. Each
source's accepted projection is separate from its latest staged batch. A changed
head immediately makes the accepted evidence stale. Rejecting a new import does
not restore freshness. Evidence-only changes also appear in the assertion delta.
Old versions are retained; source digest reuse for different content is denied.

Review events require evidence summary and a source-relative reference for verified
or failed outcomes. They preserve the canonical report's pending checklist and never
promote a relation to observed or approve deployment. Repeated saving of the exact
report is idempotent; changed content under that ID is denied. Scope, canonical
content, graph/source versions and freshness are rechecked before current outcomes
are shown. At most 1,000 human events are accepted per report; history is never
overwritten. Source references are metadata and are not opened.

Native exports include project-wide software and only the selected site's assets.
Local projections are conservatively internal even when empty; external projections
are filtered public metadata from the owner. The desktop binds the exact saved
document path/revision and the launcher-selected packaged executable, independently
of its configured digest. There is no cross-store atomic transaction; owner sources
are checked before writes and before presenting current verification afterward.

`SourceCheck` inputs must come from a trusted source adapter, never Agent input.
They carry a just-checked source revision/digest/status/time. Missing, unavailable,
over-five-minute-old or changed checks produce unknown/stale results. The package
does not itself open evidence locators or prove that a source file has stayed
unchanged. File adapters must compare current permitted bytes to their trusted
binding before supplying a successful check. Source-relative evidence locators
are metadata; no URL or arbitrary local path is executed or fetched.

## Interpretation and limits

- Reports distinguish potentially affected entities, associated context and
  unresolved paths. All findings remain candidates for human verification.
- Consumer dependencies propagate from provider to consumer. A deployment host
  is context when its service changes. The host is not traversed as affected,
  so unrelated services on that host do not become affected through co-location.
- Prospective rollout names deployment IDs. Logical-service consumer links with
  no deployment routing are unresolved. Deployment `version` is the declared
  source revision pinned by this pilot fixture; a missing/mismatching baseline
  is unresolved, not proof of observed installation.
- Desired declarations never become observations. Inferred assertions and
  contradictory support/denial evidence remain unresolved. Conflict detection
  covers opposite assertions for the same typed relation/basis and multiple
  same-basis `instance_of` targets; it is not a general semantic contradiction
  detector.
- The traversal records one representative evidence path per candidate. Cycle
  handling, node/edge/depth/time budgets and presentation/byte limits are explicit.
  It does not enumerate every possible path. An exhausted traversal is incomplete;
  a presentation limit is separately marked. Knowledge completeness is never
  inferred from traversal completion.
- No path never means safe to deploy. No checklist is automatically completed.
- Source import limits: 4 MiB input, 2,000 entities, 5,000 assertions and 5,000
  evidence records per source; up to 200 sources and a 256 MiB local store limit.
  These are defensive limits, not production scale claims.
- Persisted reports can be opened through the current-report API only after fresh
  source checks and exact canonical recomputation. Unknown/stale reports need to
  be generated again; a separate historical/as-of report viewer is not yet
  implemented. Time-budget-truncated results may not reproduce for persistence;
  regenerate with an adequate budget instead of certifying them as current.
- SQLite is not encrypted. Only synthetic/nonsecret metadata is supported in
  this slice. Network connectors, true multi-user identity, encryption, historical
  as-of report viewing and real operator/Agent trials remain gates. Explicit schema
  migration retains a verified backup and rolls back failed DDL; restoring a backup
  is an offline operator procedure, never an automatic file replacement.

## Reproduce checks

From repository root, using already installed development dependencies:

```text
node node_modules/typescript/bin/tsc -b packages/impact --pretty false
node node_modules/vitest/vitest.mjs run --configLoader native packages/impact/test
node packages/impact/scripts/benchmark.mjs
```

The tests use disposable OS-temporary SQLite fixtures. They cover import/review
transactions and identity, mutation-free reads, policy/endpoint/evidence filtering,
directed rollout paths, stale/missing/conflicting evidence, cycles and budgets,
and saved-report tamper/revocation checks. These are engineering regressions,
not the plan's independently reviewed 20-case customer benchmark.

The separate reproducible stress script builds 1,000 synthetic entities and
5,000 assertions, performs two warm-ups and fifteen measured reports, and includes
SQLite source reads. A Windows x64 / Node 24.13.0 / Intel i7-11800H run on
2026-10-12 final verification run measured p50 117 ms and p95 228 ms with all
999 other entities reached (log: `build/impact-evidence/impact-benchmark-final.txt`).
Timing varies by machine and workload. No human effort saving, business accuracy
or safety result has been measured. The planned ~20% target is still untested.
