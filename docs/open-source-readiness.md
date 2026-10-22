# Open-source readiness — v0.2.0-alpha.1

Canonical repository: `https://github.com/vuthuanphat/lmti-atlas`.
Status: local candidate; no publication is authorized by preparation alone.

## Prepared scope

- Workspace version `0.2.0-alpha.1`, Python `0.2.0a1`, native numeric `0.2.0`.
- Local web Windows x64 package and source build; Qt fallback retained.
- Source-based CLI/SDK/MCP; no npm/PyPI publication or full Linux/macOS support claim.
- Apache-2.0 source with separate third-party licenses and corresponding Qt source.
- Public layer documentation is under `docs/integration/`; operational `.lmti/`
  remains ignored and must not be committed.

## Evidence required for candidate acceptance

The accompanying local acceptance report must identify the candidate commit,
artifact hashes, tool versions and actual suite pass/fail/skip counts. Required
checks are frozen dependency installation, TS/web build, TS/UI/API tests,
native CTest, Python/native integrations, Go compatibility, package integrity,
browser workflows, secret scanning and dependency/license review. Record any
failure and repair history; do not convert unexecuted integration tests to passes.

## Remaining gates before publication

- Verify the final candidate's checksums, third-party source/license materials
  and exact release notes. Confirm `.gitignore` and tracked files exclude local
  data and secrets, including archives and historical reachable commits.
- Run and record clean-Windows and independent operator acceptance. Retain
  experimental/unverified labels for integrations not accepted with real clients.
- Enable and verify GitHub Private Vulnerability Reporting or provide an approved
  private security contact. The API reported it disabled on 2026-10-22.
- Hosted CI must pass on the actual release commit after a future authorized push.
- Run `lmti publish preflight` before public pushes, PRs, remote changes or release.
  ERROR/BLOCKED stops publication; the gate must not be weakened to force a pass.
- Publish only after a separate explicit decision. Do not move historical tags.

See [release notes](releases/v0.2.0-alpha.1.md) and [build instructions](release-build.md).
