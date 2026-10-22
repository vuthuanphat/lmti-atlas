# Cursor CLI discovery — partial client evidence

Date: 2026-10-14. The owner confirmed Cursor Editor is not installed.
This record advances the client gate; it does **not** close CP-01d or WEB-03.

## Official client and isolation

Cursor's official Windows installer identified CLI version
`2026.10.12-d47ca18`. Its ZIP was downloaded directly from
[Cursor's distribution](https://downloads.cursor.com/lab/2026.10.12-d47ca18/windows/x64/agent-cli-package.zip)
into ignored `build/`. ZIP SHA-256:
`43ebf568c0be49c1f2308545bebceefbb8fe19b6b67a91151b146bb0c06f961c`.
This is a locally measured identity, not a publisher-provided checksum.
Archive entries were bounded and checked for traversal, aliases and links before
extraction. Bundled Node has a valid OpenJS signature; auxiliary executables are
unsigned. No global installer, PATH change or old installation deletion ran.

The signed bundled Node ran the original CLI entrypoint with
`--disable-auto-update`. Fresh home/config/data/temp directories and a minimal
environment excluded personal config and credentials. The reviewed `lmti_m1`
definition points only to trusted Python and the packaged LMTI server on synthetic
data. The normal `mcp enable lmti_m1` command approved that single definition in
the isolated workspace; no broad auto-approval or sandbox/TLS bypass was used.

The first workspace beneath this repository did not find its nested config.
Parent project-root discovery is a suspected cause, not a captured runtime root.
A separate temporary workspace then found the project
config, correctly refused the unapproved server, and succeeded after its explicit
single-server setup. This is also a project-root discovery limitation to retain
in acceptance testing.

## Results and limits

Authenticated exports from package `build/studio-web03-projection-20261014`
produced matching Codex/Cursor definitions. Installed Codex
`0.162.0-alpha.17.2` discovered the four tools and read the expected synthetic
project/site with an isolated home and no model turn. The smoke runner now loads
the selected packaged API and verifies the package before export, rather than
hardcoding an older source API/package.

The actual Cursor CLI discovered exactly `lmti_context`, `lmti_entity`,
`lmti_observations` and `lmti_related`. Source SQLite bytes remained unchanged.
Evidence: `build/web02-client-aKY6CE/web-export-report.json` and
`build/cursor-cli-discovery-latest.json`.

Cursor **scoped tool reads, Editor interaction, project switching, update/rollback,
account/provider authentication and operator acceptance remain unverified**.
The documented CLI MCP commands provide discovery, not a standalone tool-call
command. We did not manufacture a model turn or use an internal API to claim
scoped-read success. Cursor Editor and an authenticated, approved client session
remain the next external dependency for that acceptance path.

References: [CLI parameters](https://cursor.com/docs/cli/reference/parameters),
[config isolation](https://cursor.com/docs/cli/reference/configuration),
[MCP commands](https://prod.cursor.com/docs/cli/mcp).

Safe lesson candidate: distinguish actual-client discovery from a scoped tool
read, and verify project-root selection before assuming a nested client config
will be selected. Retain synthetic evidence, never personal client credentials.
