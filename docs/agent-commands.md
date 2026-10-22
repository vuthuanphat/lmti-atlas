# Agent Commands

> Status: Local-alpha documentation

This page covers project-memory CLI commands. Native topology context/proposals
and Python MCP use the separate contracts in the [Studio guide](topology-studio.md)
and [JSON boundary map](json-boundary.md); see the [support map](component-support.md).

AI agents should use LMTI through stable JSON commands. Agents must not parse
human tables, read raw SQLite, or read raw memory files.

## Recommended Flow

```text
1. Receive the user task.
2. Run lmti skill route "<task>" --json.
3. Read data.selectedSkill.
4. Run lmti skill show <skill-id> --json if instructions are needed.
5. If memory is required, run lmti memory retrieve --intent <intent> --json.
6. If policy is required, run lmti policy check or the required safety command.
7. Perform the task.
8. Record an event or lesson candidate when available.
```

## Commands

| Agent Need | Command |
|---|---|
| Health check | `lmti doctor --json` |
| Route task to skill | `lmti skill route "<task>" --json` |
| Load selected skill | `lmti skill show <skill-id> --json` |
| Retrieve safe context | `lmti memory retrieve --intent <intent> --json` |
| Check publish safety | `lmti publish check --json` |
| Evaluate policy | `lmti policy check --action <action> --json` |
| Inspect config shape | `lmti config inspect --json` |
| Inspect agent boundary | `lmti agent inspect --json` |
| Get scoped agent context | `lmti agent context --intent <intent> --json` |

## JSON Contract

The friendly project-memory commands on this page use the `lmti.cli.v1` envelope;
advanced diagnostics retain their documented outputs. Topology/MCP messages are
not wrapped in this envelope:

```json
{
  "schemaVersion": "lmti.cli.v1",
  "command": "lmti.skill.route",
  "status": "pass",
  "warnings": [],
  "errors": [],
  "data": {}
}
```

Agents should rely on both `status` and the process exit code:

| Status | Exit Code | Meaning |
|---|---:|---|
| `pass` | `0` | Continue |
| `warn` | `1` | Continue only after reviewing warnings |
| `blocked` | `2` | Stop and resolve safety issue |
| `error` | `3` | Command failed |

Invalid usage returns exit code `4`.

## Privacy Rules

- Do not read `.lmti/memory.sqlite`.
- Do not read raw JSON memory files.
- Do not request `secret` or `do_not_prompt` memory.
- Do not include raw secrets in prompts or logs.
- Use `lmti policy check` before risky actions.
- Use `lmti publish check` before publishing, pushing, opening a PR, creating a
  release, or changing a Git remote.
