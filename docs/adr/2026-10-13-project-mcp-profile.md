# Project MCP profiles and client configuration ownership

Date: 2026-10-13. Status: accepted for implementation by the owner's CP-01 request;
client/operator/live-provider acceptance remains separate.

The owner selected project MCP setup shared by Codex/Cursor. Native C++ owns
typed profiles (project ID, revision, bounded server definitions). Qt Core/Sql
owns a separate LMCP SQLite v1 store alongside the library. It does not modify
LMPR/topology or TS memory. Qt adapters generate Codex TOML and Cursor JSON from
the same saved profile revision; a new Qt panel is the project entry point.

Remote definitions support HTTPS endpoints and client-owned OAuth or unauthenticated
access. URL credentials, query/fragment and secret-like metadata are rejected.
Local definitions initially support only the existing LMTI read server, launched
through fixed publisher-configured Python/entry/native paths and saved project/site
arguments. General local commands, package installation and literal credentials
are unsupported rather than accepted as arbitrary interpreter arguments.

A dependency-free Python client-config owner handles bounded TOML/JSON parsing,
preview, merge and atomic project-scoped writes. This is an explicit file-format
adapter, not an Agent tool. Requests use a bounded JSON process boundary from the
trusted desktop; it is not exposed to MCP clients. Existing values never enter
preview/log output. Codex uses a managed TOML region; Cursor uses ownership hashes
in a nonsecret client-config sidecar. Unowned name collisions and edits of owned
entries fail closed. Global IDE configuration and approval policies are untouched.

On Windows, backups and recovery journals use same-user DPAPI encryption.
Existing file DACLs are preserved for replacement files. The owner restores only
when current file bytes match a recorded transaction result; intervening edits
block restoration. Unix automatic apply is unsupported until equivalent backup
protection is designed. Explicit export remains available. DPAPI is not an OS
sandbox and does not protect against the same authenticated user.

Definitions are configuration intent, not tool-call enforcement. Authentication,
actual client tool access and network health have separate states. The desktop
does not impersonate OAuth users or claim that configuring a portal enforces all
Agent activity. Cloudflare/Tailscale endpoints remain optional user-selected
integrations. No cloud, ACL, deployment or device operations are performed.

Required verification: project/revision isolation, invalid metadata rejection,
config parsers, collision/drift/recovery behavior, bounded process errors, Qt
empty/edit/export flow, installed Codex and Cursor capability evidence where
available. Missing installed clients must be reported without inventing proof.
