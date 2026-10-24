# Open-source readiness — v0.2.0-alpha.1

Canonical repository: `https://github.com/vuthuanphat/lmti-atlas`.
Status: unpublished release candidate. After the startup/readiness work, the
owner authorized integrating the latest source into `main` and refreshing the
README on 2026-10-24. This supersedes the earlier no-main hold for source
integration only. **Public runtime release and tag publication remain held.**
Authorization is not evidence that a push, CI run or merge has completed.

## Prepared scope

- Workspace version `0.2.0-alpha.1`, Python `0.2.0a1`, native numeric `0.2.0`.
- React + Vite local web Windows x64 package and source build; Node.js local API
  and native/Python owners. Qt Core/Sql remains a backend dependency; the Qt
  desktop UI and fallback launcher have been removed.
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

## Recorded baseline and current work

Commit `771fc40f439ec1fe49a1fa1bca3183e58ccbae28` passed the four hosted jobs in
[CI](https://github.com/vuthuanphat/lmti-atlas/actions/runs/39950637360) and
[native/Python CI](https://github.com/vuthuanphat/lmti-atlas/actions/runs/39950637385).
Those PR test-merge results have the same tree as the recorded head. They do not
validate later startup/readiness edits or a future merge/tag. The
[QA record](releases/v0.2.0-alpha.1-qa.md) separates that baseline from current
verification and open external acceptance.

The latest verified local runtime is commit
`85eda3c2b63a4131508078908105b012c76a6a01`: UI 139 and API 458 pass with one API
skip, plus fresh native/TS/Python/Go/broker/client regressions and actual saved
launcher browser journeys. Its 405-file extracted package passed doctor and
archive checks. See [exact validation and provenance](releases/v0.2.0-alpha.1-qa.md#latest-verified-local-runtime--85eda3c).
The checks include five native internal capability skips and six TS skips; they
are not independent operator or clean-Windows acceptance. Documentation changes
and eventual merged/tag artifacts must retain their own commit/hash provenance.

## Remaining gates before runtime release publication

- Verify the final candidate's checksums, third-party source/license materials
  and exact release notes. Confirm `.gitignore` and tracked files exclude local
  data and secrets, including archives and historical reachable commits.
- Run and record clean-Windows and independent operator acceptance. Retain
  experimental/unverified labels for integrations not accepted with real clients.
- GitHub Private Vulnerability Reporting was enabled and verified on 2026-10-23.
  Recheck the channel before release publication.
- Rerun local checks and hosted CI for changed source; verify the eventual
  merged/tag SHA and the exact extracted distribution after any authorized merge.
- Run `lmti publish preflight` before public pushes, PRs, remote changes or release.
  ERROR/BLOCKED stops publication; the gate must not be weakened to force a pass.
- Keep the runtime prerelease in draft. Source integration into `main` is now
  authorized separately; clean Windows and independent operator acceptance remain
  open for the runtime release. Do not create a public tag or publish the release
  under that source-only authorization, and do not move historical tags.

See [release notes](releases/v0.2.0-alpha.1.md) and [build instructions](release-build.md).
