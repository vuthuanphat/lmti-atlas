# CLI

> Status: Local-alpha documentation

Run the CLI from source until package distribution is finalized:

```bash
node packages/cli/dist/index.js --help
```

If the package is linked or installed locally, use the equivalent `lmti ...`
commands.

Use **Node.js 24 or later** for this CLI. The memory and audit owners require
`node:sqlite`; a runtime without it is unsupported for these writes. An audit
writer that cannot load this primitive refuses with
`AUDIT_RUNTIME_UNSUPPORTED_NODE_SQLITE_REQUIRED` and does not fall back to an
uncoordinated writer. Reading existing audit evidence does not need this primitive.

## Options and exit status

Options are declared by each command. Boolean switches such as `--json`,
`--fix`, `--strict` and `--dry-run` do not consume the next argument. Both
`route --json "publish the repository"` and `route "publish the repository"
--json` select the same request. Options with values accept `--role developer`
or `--role=developer`. Use `--` to end option parsing, for example
`route --json -- "--publish from these notes"`. `memory reinforce --success
true|false` retains its explicit boolean-value form. Repeated declared options
retain the existing last-value precedence.

Unknown options, missing values, invalid boolean/numeric values and extra positional
arguments on fixed-arity commands are now usage errors, before the owner is
called. This intentionally replaces silent acceptance of misspelled options.
Flags belong to their documented command; `--json` is not a global switch for
surfaces that already print their own JSON protocol.

The friendly CLI status codes remain `0` pass, `1` warning, `2` blocked,
`3` command error and `4` invalid usage. **`doctor` and `check` now return the
same nonzero status for a failing report in both text and JSON**, including
`--security`. Scripts that previously relied on the incorrect text-mode zero
status must handle this result. Friendly JSON errors keep `lmti.cli.v1`, with
`INVALID_USAGE` or `COMMAND_FAILED`; private MCP/desktop/Impact protocols retain
their own formats and exit rules.

The TypeScript entry retains the public command-function/type exports.
Dispatch is separate from the command families under `packages/cli/src/commands`,
with shared typed parsing in `arguments.ts` and presentation/status helpers in
`output.ts`. Commands continue to call their existing storage owners.

`lmti` is the primary CLI command. If an `atlas` bin is present, treat it as a
legacy/internal local-alpha alias. Documentation should use `lmti` as the
public command name.

## Current Status

- Stable local workflow: `init`, `check`, `doctor`, `route`, `skill`,
  `publish check`, `compile`, `inspect`, `context`, `preflight`,
  `attach codex`, `memory`, and `task done`.
- Experimental or diagnostic surfaces: `framework`, `actions`, `mind`,
  `cognition`, `world`, `experiment`, `benchmark`, and `privacy audit`.
- Planned names are listed at the end of this file. They should not be shown as
  working aliases until the CLI implements them.

The [master plan](LMTI_MASTER_PLAN.md) coordinates the Studio C++/Qt/Python
direction. This page documents the project-memory CLI; see the
[Studio guide](topology-studio.md) for native topology CLI and Python MCP.
The [support map](component-support.md) distinguishes both domains.

`memory migrate-json --dry-run` inventories legacy TS JSON without writes.
Actual TS and Go legacy import writes are blocked until policy/provenance/lifecycle parity is proven.
Ordinary memory reads/writes, lessons and compatibility JSON commands continue.

## Experimental Go compatibility commands

The Go CLI remains experimental memory compatibility alongside TypeScript.
Its SQLite path uses a Node bridge and a schema distinct from TS project
memory and native topology. It is not the replacement topology core. Run with:

```bash
go run ./cmd/lmti <command>
```

Go-core phase commands:

```bash
go run ./cmd/lmti init
go run ./cmd/lmti doctor --json
go run ./cmd/lmti memory add --title "Rule" --content "Run publish preflight first." --json
go run ./cmd/lmti memory search "publish" --json
go run ./cmd/lmti memory retrieve --intent publish --json
go run ./cmd/lmti memory stats --json
go run ./cmd/lmti migrate from-json --dry-run --json
go run ./cmd/lmti publish check --json
go run ./cmd/lmti adapter inspect --json
```

For the TypeScript CLI, the same friendly command names are available through:

```bash
node packages/cli/dist/index.js check --json
node packages/cli/dist/index.js route "check before publishing" --json
node packages/cli/dist/index.js skill route "check before publishing" --json
node packages/cli/dist/index.js publish check --json
node packages/cli/dist/index.js policy check --action publish --json
node packages/cli/dist/index.js config inspect --json
node packages/cli/dist/index.js agent inspect --json
```

### `lmti init`

Creates local `.lmti` storage.

```bash
node packages/cli/dist/index.js init
```

Privacy note: `.lmti/` is local runtime state and should not be committed.

### `lmti compile [projectPath]`

Builds `.lmti/project.amf.json`.

```bash
node packages/cli/dist/index.js compile ./examples/sample-project
```

Privacy note: compile treats target projects as untrusted input and should skip
ignored secret files.

### `lmti inspect [amfPath]`

Prints Project Atlas / AMF stats.

```bash
node packages/cli/dist/index.js inspect
```

### `lmti context "<task>"`

Builds a task-specific Context Pack.

```bash
node packages/cli/dist/index.js context "fix packing label bug"
```

Expected output: JSON with inferred intent, selected modules/files, memory
selection, and filtered counts.

### `lmti preflight "<task>"`

Builds a policy-safe MVP context package with hard memory gates.

```bash
node packages/cli/dist/index.js preflight "permission routing issue" --role developer --model-target external_model
```

Expected output: JSON with observer frame, selected memories, blocked memories,
risk signals, predicted failures, constraints, final context package, egress
scan result, adapter sandbox result, and metrics.

### `lmti publish check`

Runs the publish/PR/release safety gate. This command should run before pushing
to a public repo, opening a PR, creating a release, publishing open-source
artifacts, or changing Git remotes.

```bash
node packages/cli/dist/index.js publish check
node packages/cli/dist/index.js publish check --target main --json
node packages/cli/dist/index.js publish check --strict --fix-suggest
```

Advanced alias:

```bash
node packages/cli/dist/index.js publish preflight
node packages/cli/dist/index.js publish preflight --target main --json
node packages/cli/dist/index.js publish preflight --strict --fix-suggest
```

Legacy alias:

```bash
node packages/cli/dist/index.js preflight publish
```

Checks include repository identity, origin remote, branch safety, common Git
history with `origin/<target>`, ahead/behind divergence, dirty working tree,
protected paths, LMTI layer identity, and configured publish target.

Exit codes:

- `0`: pass.
- `1`: warnings; review before continuing.
- `2`: blocked; stop publish/PR/release work until fixed.

Security note: protected path checks inspect Git path/status metadata only. They
do not read or print raw `.env`, private memory, key, certificate, or secret
file contents.

### `lmti skill ...`

Routes a user request to the right `skill.md` without executing the task,
dumping memory, or bypassing policy.

Use `skill` for normal human and agent workflows:

```bash
lmti skill list
lmti skill route "check before publishing"
lmti skill show publish-preflight
lmti skill validate
```

Agent JSON:

```bash
lmti skill route "migrate JSON memory to SQLite" --json
lmti skill show migration-from-json --json
```

Advanced Thoth diagnostics are available for local-alpha development:

```bash
lmti thoth list
lmti thoth route "publish repo to open source GitHub"
lmti thoth explain "clean unused code without breaking the current flow"
lmti thoth inspect publish-preflight
lmti thoth validate
lmti thoth doctor
```

Friendly agent-facing JSON uses the `lmti.cli.v1` envelope. Advanced Go Thoth
diagnostics may also emit `lmti.thoth.v1`. See [commands.md](commands.md),
[agent-commands.md](agent-commands.md), [thoth.md](thoth.md), and
[skills.md](skills.md).

### `lmti doctor [--fix|--security]`

Diagnoses storage, AMF noise, ignore rules, migration state, and security
posture.

```bash
node packages/cli/dist/index.js doctor
node packages/cli/dist/index.js doctor --security
```

## Codex Workflow

### `lmti attach codex`

Adds LMTI guidance to `AGENTS.md` without deleting existing content.

```bash
node packages/cli/dist/index.js attach codex
```

## Memory Commands

```bash
node packages/cli/dist/index.js memory init
node packages/cli/dist/index.js memory add --title "Packing rule" --content "A label can print only after all items are completed."
node packages/cli/dist/index.js memory search "packing label"
node packages/cli/dist/index.js memory retrieve --intent "fix packing label bug"
node packages/cli/dist/index.js memory lesson propose \
  --task "Packing fix" \
  --lesson "Verify label-group completion before printing." \
  --files-touched src/orders/packing.ts:modified \
  --commands "npm test:0" \
  --tests "npm test:pass" \
  --outcome pass
node packages/cli/dist/index.js memory lesson candidates
node packages/cli/dist/index.js memory lesson show <candidateId>
node packages/cli/dist/index.js memory lesson approve <candidateId>
node packages/cli/dist/index.js memory lesson reject <candidateId>
node packages/cli/dist/index.js memory stats
node packages/cli/dist/index.js memory privacy-check
node packages/cli/dist/index.js memory context "fix packing label bug"
```

Privacy note: memory writes and retrieval pass through privacy checks. Lesson
proposal is Level 2 only: it does not train a model, does not store raw diffs,
and does not auto-approve candidates. Pending lesson candidates are not
included in context retrieval.

Short memory:

```bash
node packages/cli/dist/index.js memory short:add --title "Current checkpoint" --content "Inspect preflight next." --priority medium
node packages/cli/dist/index.js memory short:retrieve "preflight"
node packages/cli/dist/index.js memory short:expire
node packages/cli/dist/index.js memory short:cleanup --dry-run
node packages/cli/dist/index.js memory short:evaluate <noteId>
node packages/cli/dist/index.js memory short:promote <noteId> --reason "Durable lesson"
```

Lifecycle:

```bash
node packages/cli/dist/index.js memory consolidate
node packages/cli/dist/index.js memory decay
node packages/cli/dist/index.js memory reinforce <id> --success true
node packages/cli/dist/index.js memory review
node packages/cli/dist/index.js memory associations <id>
node packages/cli/dist/index.js memory explain "partner permission route"
```

## Task And Lesson Commands

```bash
node packages/cli/dist/index.js remember --kind rule --title "Route rule" --content "Partner users route through /partner." --tags routing,permission --prompt-policy summarize_only
node packages/cli/dist/index.js task done --title "Partner route fix" --summary "Confirmed routing behavior." --lesson "Partner users route through /partner."
node packages/cli/dist/index.js memory lesson candidates --approval-status pending
node packages/cli/dist/index.js memory lesson approve <candidateId>
```

`task done --lesson` and `memory lesson propose` create lesson candidates.
Approval is a separate step so a privacy warning, weak evidence, or low
confidence score does not become long-term memory automatically. `remember` is
for deliberate non-lesson memory such as rules and decisions.

## Experimental Framework Commands

These commands expose local framework detection and verification metadata. They
are useful for development, but they are not a complete framework integration
platform.

```bash
node packages/cli/dist/index.js framework detect
node packages/cli/dist/index.js framework list
node packages/cli/dist/index.js framework info
node packages/cli/dist/index.js framework commands
node packages/cli/dist/index.js framework risk-zones
node packages/cli/dist/index.js framework verify-plan --task "fix auth middleware" --files middleware.ts
node packages/cli/dist/index.js framework monorepo-map
```

## Experimental Action View Commands

These commands write local session metadata for Codex-oriented workflow
inspection. They are not a hosted dashboard or team audit product.

```bash
node packages/cli/dist/index.js actions start --task "fix permission routing"
node packages/cli/dist/index.js actions log --session-id <id> --type file_read --file src/auth/middleware.ts
node packages/cli/dist/index.js actions command --session-id <id> --command "npm test" --exit-code 0
node packages/cli/dist/index.js actions decision --session-id <id> --decision "Keep least privilege" --reason "403 is expected for partner role"
node packages/cli/dist/index.js actions reflection --session-id <id> --summary "Fixed route safely" --tests-run "npm test"
node packages/cli/dist/index.js actions end --session-id <id> --status completed
node packages/cli/dist/index.js actions list
node packages/cli/dist/index.js actions show <session-id>
node packages/cli/dist/index.js actions risks
node packages/cli/dist/index.js actions replay <session-id>
```

Privacy note: Action View stores summaries and metadata. It is not a secret
vault.

## Experimental And Diagnostic Commands

These commands exist in the current CLI, but they are best treated as
diagnostic/development surfaces rather than the primary user workflow.

```bash
node packages/cli/dist/index.js migrate --yes
node packages/cli/dist/index.js experiment thinking "fix packing label bug"
node packages/cli/dist/index.js mind context "fix permission routing issue 403"
node packages/cli/dist/index.js mind explain "deploy production"
node packages/cli/dist/index.js cognition run "permission routing issue"
node packages/cli/dist/index.js world check "fix partner dashboard 403"
node packages/cli/dist/index.js privacy audit --verify
node packages/cli/dist/index.js privacy check
node packages/cli/dist/index.js benchmark preflight "permission routing issue" --runs 5
```

## Not Implemented As Aliases Today

These names may appear in roadmap discussions, but they are not current CLI
commands:

```text
lmti atlas build
lmti atlas inspect
lmti context build --task "..."
lmti context explain --task "..."
lmti adapter list
lmti adapter test
```

Use the real commands documented above.
