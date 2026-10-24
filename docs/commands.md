# LMTI Commands

> Status: Local-alpha documentation

LMTI commands are designed for two audiences: short human commands and stable
JSON commands for AI agents.

Core rules:

- Choose read-only inspection variants deliberately. `doctor --fix`, initialization,
  compilation and legacy migration can write local state; framework detection
  can create its configuration. Run smoke workflows in a disposable fixture.
- Risky workflows must go through policy, privacy, or publish gates.
- The simplified command-system JSON paths use the `lmti.cli.v1` envelope.
  Legacy local-alpha and diagnostic commands are still being normalized.
- Agents must not read raw SQLite or raw memory files.
- Commands must never print raw secrets.

## Quick Map

| Goal | Human Command | Agent Command |
|---|---|---|
| Check LMTI health | `lmti doctor` | `lmti doctor --json` |
| Find the right skill | `lmti skill route "<task>"` | `lmti skill route "<task>" --json` |
| Show a skill | `lmti skill show <skill-id>` | `lmti skill show <skill-id> --json` |
| Search memory | `lmti memory search "<query>"` | `lmti memory search "<query>" --json` |
| Retrieve context | `lmti memory retrieve --intent <intent>` | `lmti memory retrieve --intent <intent> --json` |
| Check before publishing | `lmti publish check` | `lmti publish check --json` |
| Validate skills | `lmti skill validate` | `lmti skill validate --json` |
| Migrate legacy JSON | `lmti migrate from-json --dry-run` | `lmti migrate from-json --dry-run --json` |

Status note: `lmti migrate from-json` is implemented in the Go core path and is
planned as the friendly TypeScript CLI alias. The current TypeScript migration
surface is still `lmti memory migrate-json`, so do not use `migrate from-json`
as a release claim until parity is verified.

Both legacy import write paths are now blocked pending lossless policy,
provenance and lifecycle mapping; use dry-run inventory and keep original stores.
Ordinary memory commands remain active. For topology/Agent commands use the
[Studio guide](topology-studio.md) and [support map](component-support.md).

## Simple Aliases

| Alias | Canonical Behavior |
|---|---|
| `lmti check` | `lmti doctor` |
| `lmti route "<task>"` | `lmti skill route "<task>"` |
| `lmti skill route "<task>"` | Skill routing through Thoth logic |
| `lmti skill show <skill-id>` | Selected `skill.md` loading |
| `lmti publish check` | `lmti publish preflight` |

Aliases must not create different safety behavior.

## Exit Codes

| Exit Code | Meaning |
|---:|---|
| `0` | Pass |
| `1` | Warning |
| `2` | Blocked |
| `3` | Command error |
| `4` | Invalid usage |
| `5` | Internal error |

## JSON Envelope

```json
{
  "schemaVersion": "lmti.cli.v1",
  "command": "lmti.command.name",
  "status": "pass",
  "warnings": [],
  "errors": [],
  "data": {}
}
```

Allowed statuses: `pass`, `warn`, `blocked`, and `error`.

Errors and warnings include stable codes:

```json
{
  "code": "ERROR_CODE",
  "message": "Human-readable message",
  "suggestion": "Optional safe fix"
}
```

## Safety Notes

- `lmti publish check` checks only; it does not push, publish, rewrite history,
  create pull requests, or change remotes.
- `lmti skill route` selects a skill only; it does not execute the task.
- `lmti skill show` loads only the requested skill file and blocks secret-like
  content.
- `lmti memory retrieve --intent <intent>` uses privacy-filtered retrieval and
  does not return `secret` or `do_not_prompt` records.
- `lmti policy check` reports `allow`, `warn`, `block`, or
  `require_user_approval`; it does not perform the risky action.
- `lmti config inspect` summarizes config shape and does not print raw config
  values.
