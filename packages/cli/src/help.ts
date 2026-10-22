
export function printHelp(): void {
  console.log(`LMTI

Usage:
  lmti init [--yes]
  lmti check [--json]
  lmti route "<task>" [--json]
  lmti compile [projectPath]
  lmti migrate [--yes]
  lmti doctor [--fix|--security]
  lmti doctor --json
  lmti inspect [amfPath]
  lmti context "<task>" [amfPath] [--include-secret]
  lmti context "<task>" [--memory-source auto|sqlite|legacy_json]
  lmti preflight "<task>" [amfPath] [--role developer] [--model-target external_model]
  lmti impact demo --out <new-directory>
  lmti impact serve --config <launcher.json> [--change change.json] [--port 0]
  lmti impact report --config <launcher.json> [--change change.json]
  lmti impact export --config <launcher.json> --out <new-report.html|json>
  lmti impact import --config <launcher.json> --file <source.json> --revision <expected>
  lmti impact import-code --config <launcher.json> --file <code-mapping.json> --revision <expected>
  lmti impact review --config <launcher.json> --batch <id> --revision <expected> --decision accept|reject --reviewer <name> --evidence-reviewed true
  lmti impact request --config <trusted-launcher.json>  # versioned request on stdin
  lmti skill list [--json]
  lmti skill route "<task>" [--json]
  lmti skill show <skill-id> [--json]
  lmti skill validate [--json]
  lmti thoth <list|route|explain|show|inspect|validate|doctor> [--json]
  lmti publish check [--target main] [--json] [--strict] [--fix-suggest]
  lmti publish preflight [--target main] [--json] [--strict] [--fix-suggest]
  lmti preflight publish [--target main] [--json] [--strict] [--fix-suggest]
  lmti policy check --action <action> [--json]
  lmti policy list [--json]
  lmti config <show|inspect|validate> [--json]
  lmti agent inspect [--json]
  lmti agent context --intent <intent> [--json]
  lmti cleanup check [--json]
  lmti experiment thinking "<task>"
  lmti attach codex
  lmti memory init [--migrate-json --dry-run]
  lmti memory migrate-json --dry-run
  lmti memory add --title "..." --content "..." [--zone lesson]
  lmti memory add --scope short_term --kind task --title "..." --content "..." --legacy
  lmti memory list [--scope short_term|long_term] [--role developer]
  lmti memory search "<query>" [--zone security,lesson]
  lmti memory search "<query>" --legacy [--role agent] [--include-secret]
  lmti memory retrieve "<task>"
  lmti memory context "<task>" [--short-limit 8] [--long-limit 8]
  lmti memory short:add --title "..." --content "..." [--priority medium] [--ttl-hours 24]
  lmti memory short:retrieve "<task>" [--tags tag-a,tag-b]
  lmti memory short:expire
  lmti memory short:cleanup [--dry-run]
  lmti memory short:evaluate <noteId>
  lmti memory short:promote <noteId> [--reason "..."]
  lmti memory lesson propose --task "..." --lesson "..."
  lmti memory lesson candidates [--approval-status pending]
  lmti memory lesson show <candidate-id>
  lmti memory lesson approve <candidate-id>
  lmti memory lesson reject <candidate-id>
  lmti memory stats
  lmti memory privacy-check
  lmti memory consolidate
  lmti memory decay
  lmti memory reinforce <id> --success true|false
  lmti memory review
  lmti memory associations <id>
  lmti memory explain "<query>"
  lmti memory promote <id>
  lmti memory delete <id>
  lmti mind context "<task>"
  lmti mind explain "<task>"
  lmti mind reflect --task "..." [--summary "..."]
  lmti mind debug "<task>"
  lmti framework detect [--json|--html]
  lmti framework list
  lmti framework info [framework]
  lmti framework commands [framework]
  lmti framework risk-zones [framework]
  lmti framework verify-plan --task "..." [--files a,b]
  lmti framework monorepo-map
  lmti actions start --task "..."
  lmti actions log --session-id "..." --type file_read --file "..."
  lmti actions command --session-id "..." --command "npm test" --exit-code 0
  lmti actions decision --session-id "..." --decision "..." --reason "..."
  lmti actions end --session-id "..." --status completed
  lmti actions list
  lmti actions show <session-id>
  lmti actions risks
  lmti actions replay <session-id>
  lmti cognition run "<task>"
  lmti cognition explain "<task>"
  lmti cognition state ["<task>"]
  lmti world check "<task>"
  lmti world cost "<task>"
  lmti world align "<task>"
  lmti world observe "<input>"
  lmti remember --kind rule --title "..." --content "..." --tags a,b --prompt-policy summarize_only
  lmti task done --title "..." --summary "..." [--lesson "..."]
  lmti privacy audit [--verify|--retain 1000]
  lmti privacy check
  lmti benchmark preflight "<task>" [--runs 5]

Commands:
  init      Create local .lmti storage.
  check     Alias for doctor.
  route     Alias for skill route.
  compile   Compile a project into .lmti/project.amf.json.
  migrate   Copy legacy Atlas state into canonical .lmti storage.
  doctor    Diagnose storage, AMF noise, ignore rules and security posture.
  inspect   Print Project Mind stats from AMF.
  context   Build a Context Pack JSON from AMF and a task.
  preflight Build a policy-safe MVP context package with hard memory gates.
  publish   Run publish/PR/release safety gates before public workflows.
  skill     Route tasks to skill.md instructions.
  thoth     Advanced skill routing and diagnostics.
  policy    Evaluate risky actions without executing them.
  config    Inspect LMTI config shape without printing raw values.
  agent     Provide safe machine-readable agent context.
  cleanup   Check cleanup readiness without modifying files.
  experiment Run local LMTI experiments.
  attach    Attach local LMTI guidance to Codex.
  memory    Manage local structured ATLAS memory.
  mind      Prepare intent-aware, privacy-safe Codex context from memory.
  framework Detect project frameworks, commands, risk zones and verification.
  actions   Track, audit and replay Codex/AI Agent actions.
  cognition Run the deterministic Cognitive Orchestrator.
  world     Run Reality Boundary and resource-bounded active inference checks.
  remember  Store a deliberate project rule or decision.
  task      Record completed task events and optional lesson candidates.
  privacy   Inspect Cognitive Privacy audit and memory safety.
  benchmark Measure local LMTI hot-path latency.
`);
}
