# Security Policy

LMTI Atlas handles local project memory, context routing, privacy gates, and
agent-facing command output. Security reports are important because a bug can
leak private project knowledge into a prompt, log, package, or public repo.

## Supported Versions

| Version | Support Status |
|---|---|
| `0.2.0-alpha.1` | Local candidate; security fixes in the prepared release branch. |
| `0.1.0-alpha.1` | Historical public alpha; upgrade guidance accompanies the next release. |
| Earlier versions | Not supported. |

There are no stable long-term support branches yet.

## Reporting A Vulnerability

Use GitHub **Private Vulnerability Reporting**:
https://github.com/vuthuanphat/lmti-atlas/security/advisories/new

Private vulnerability reporting was enabled and verified through the GitHub API
on 2026-10-23. Report vulnerabilities through the private channel above. Never
include exploit details, tokens, private paths, customer data, raw memory or
sensitive logs in public issues. If the private channel is unavailable, a public
issue may request private contact using only a neutral sentence.

## Security Principles

- Local-first by default.
- Least privilege for tools, adapters, and model targets.
- Privacy gates before memory enters agent context.
- Redaction before safe CLI output where the privacy layer is used.
- Memory is prior belief, not source of truth.
- Publish gates reduce release risk but do not replace human review.

LMTI reduces leakage risk. It does not replace source-code verification, tests,
dedicated secret scanning, dependency review, or human security review.

## Local State And Secrets

Local runtime state can include sensitive knowledge. Treat `.lmti/` and legacy
`.atlas/` state as private unless a maintainer has reviewed the exact files.

Sensitive examples include:

- Memory databases and JSON memory exports.
- Project Atlas / AMF output.
- Privacy audit logs.
- Action traces.
- Context packs.
- Private prompts and private deployment notes.

## What Not To Commit

[CẢNH BÁO BẢO MẬT] Do not commit:

- `.env` or `.env.*` files, except safe examples such as `.env.example`.
- API keys, access tokens, passwords, cookies, or session material.
- Private keys, certificates, signing keys, or generated credentials.
- Database URLs and production connection strings.
- SQLite databases, `.db` files, or local memory stores.
- Raw `.lmti/` runtime state or legacy `.atlas/` runtime state.
- Customer data, private prompts, deployment details, or internal server names.
- Sanitized-looking logs that still contain tokens, paths, or customer data.

Use obvious placeholders such as `example_token_do_not_use` when documenting a
class of issue.

## Useful Security Reports

Useful reports include:

- Secret leakage through context, preflight, adapters, CLI output, or logs.
- Privacy gate bypasses.
- Unsafe context export to external model targets.
- Path traversal or unsafe file access.
- Compiler reads outside the intended project boundary.
- Destructive behavior in doctor, compile, preflight, publish, or migration
  commands.
- Adapter manifest sandbox bypasses.
- Raw memory exposure through MCP, runtime, or action replay paths.
- Cross-project memory contamination.
- Publish preflight false negatives for protected files or unsafe remotes.

## Limitations

- LMTI is local alpha software.
- Some command families are experimental.
- The Go core path is not fully verified on machines without a Go toolchain.
- Secret detection is best effort and can miss novel formats.
- Human review is still required before publishing, opening PRs, changing
  remotes, or sharing generated context with external systems.
