# Changelog

All notable changes to LMTI Atlas will be documented in this file.

This project follows an alpha-first release process. Until a stable release
exists, commands and storage contracts may change with migration notes.

## v0.2.0-alpha.1 — local candidate

Not published. See [release notes](docs/releases/v0.2.0-alpha.1.md) for the full
compatibility, known-limitations and rollback information.

### Added

- Authenticated local web UI/API and typed native project/topology owners.
- Scoped Python Agent SDK/MCP, evidence-bearing context and controlled replay.
- Project MCP setup, hierarchy, reviewed proposals, project copy/activation and
  recovery workflows, with Qt desktop fallback.
- Windows native audit ACL helper and artifact/third-party release materials.

### Changed

- Align workspace release metadata, canonical repository identity and supported
  Node requirement with the verified Node 24 workflow.
- Split CLI dispatch; retain Go compatibility and internal `@atlas/*` namespaces.
- Reduce delivery artwork size, hidden-panel clock work and repeated metadata reads.
- Move public layer documentation out of the operational `.lmti/` directory.
- Preserve the current complete workspace lockfile; the old public lockfile
  omitted the CLI's `@atlas/runtime` dependency and failed frozen installation.
- Update the Qt Knowledge round-trip fixture to use the supported
  `--privacy-level` flag under strict CLI argument validation.

### Security

- Move Go credential-scanning source to `internal/credentialscan`; remove obsolete
  source-only exceptions for `internal/secrets`. Secret-path rules remain enforced.

- Strengthen memory/migration boundaries and audit writer coordination while
  preserving permission checks, review requirements and failure behavior.
- Upgrade Vitest to 4.1.12 for GHSA-qxg6-89mg-rqv8 / GHSA-xp26-3454-mjgp.
- Pin CI actions to verified revisions and install dependencies without lifecycle
  scripts; keep workflow permissions read-only.

### Compatibility

- Python version is `0.2.0a1`; native numeric version is `0.2.0`.
- Product version changes do not rewrite storage, AMF or policy schema versions.
- Registry publishing, live integrations and platform acceptance remain explicit
  gates; local test results are not production certification.

## v0.1.0-alpha.1

Initial public alpha preparation.

### Added

- Release-facing README with honest alpha status and capability boundaries.
- Apache-2.0 license file and package license metadata.
- pnpm-based CI for build and test verification.
- Publish preflight documentation for release, PR, and remote-change workflows.
- Open-source readiness checklist with current pass, warning, and blocked
  items.
- Security and contributing guidance for local memory, secrets, and docs.

### Changed

- Normalized workspace package versions to `0.1.0-alpha.1`.
- Updated `.gitignore` to protect local `.lmti/`, legacy `.atlas/`, temporary
  files, package-manager debug logs, and secret-like files.
- Clarified that LMTI is a local-first project memory and safety layer, not a
  full AI framework or replacement for tests and human review.

### Known Limitations

- The repository may still contain tracked local-alpha `.lmti/` documentation
  files from earlier setup. New `.lmti/` runtime state is ignored.
- Go-core verification requires a local Go toolchain.
- Package installation and global CLI usage are release targets; source-based
  commands are the verified alpha path.
- Publish preflight can remain blocked while the working tree is dirty or the
  Git remote does not match the expected public repository identity.
