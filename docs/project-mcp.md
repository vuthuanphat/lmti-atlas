# Project MCP setup

> **Scope update 2026-10-23:** Qt desktop has been removed. Desktop screens,
> screenshots and launcher instructions below are historical and no longer runnable.
> Use the [React + Vite workspace](local-web.md) and [headless build](release-build.md).
> Standalone CLI/SDK owners retain their documented boundaries; former Qt-only
> features are not automatically available in the browser UI.

Status: local-alpha implementation of the owner-selected CP-01 workflow.
The [master plan](LMTI_MASTER_PLAN.md) sets priority; the
[profile ADR](adr/2026-10-13-project-mcp-profile.md) defines ownership.

Open a saved project in Studio. **MCP & Agents** is the first project page.
Choose **Add connection**, provide a nonsecret label and unique server key, then
select remote HTTPS, Cloudflare, private via Tailscale, or the local LMTI read
server. Provider choices label a connection; they do not create cloud resources
or configure Tailscale. Remote URLs must use HTTPS port 443 and contain no user
info, query, fragment or encoded characters. Credentials never belong in URLs.

The local LMTI connection needs a site. It launches the existing read MCP server
with fixed Python/script/native paths and the saved document/project/site grant.
The launcher uses Python isolated mode. General local executables, shell commands,
package installation and arbitrary Agent storage access remain unsupported.

The native profile stores up to 32 server definitions per project in the separate
`mcp-profiles.sqlite` LMCP v1 store beside the library. Saving a connection updates
the profile revision independently of project undo/save. Metadata is nonsecret;
this SQLite store is not encrypted and is not an OS sandbox or multi-user RBAC.

## Set up Codex and Cursor

Choose **Set up client** on either card. Both previews come from the same saved
profile revision: TOML for Codex, JSON for Cursor. Local paths may be visible in
this operator preview; no credentials or existing client-config contents are shown.

- **Export new file** writes a fresh file. It does not install the configuration,
  authenticate or prove that the IDE is using it.
- **Apply to project** requires a linked project folder, a working trusted Python
  launcher and a successful merge preview. It writes only `.codex/config.toml` or
  `.cursor/mcp.json` under that folder. It never changes global config or approval
  settings. Codex requires project trust; client reload and OAuth sign-in happen
  in the client, using that client's supported workflow/version.
- **Restore last update** restores the previous config and ownership state using
  the protected local backup, including exact original bytes. Changes made since
  that transaction block restore, so unrelated edits are not overwritten.

Unowned server-key collisions require a different key. Changes to LMTI-owned
entries or the managed TOML region require manual review. Other servers/settings
are preserved. A preview is bound to the current config and owner-state hashes;
external edits invalidate it. Interrupted updates have a recovery journal and
must be restored before a read-only preview can proceed.

Windows apply uses current-user DPAPI backups/recovery journals under
`.lmti-client/`; existing replacement-file DACLs are preserved. This protection
does not defend against the same signed-in user. Automatic apply is Windows-only
in this slice; other platforms can preview/export. File limits are 1 MiB for
config and 128 KiB for a request. The helper response/process timeout are bounded.

The card reports applied/not applied/update pending/review needed at its latest
check. It does not monitor the IDE or claim continuous sync. Reopen setup to check
current files. Disabling a server removes it from the next managed project config;
global client definitions can still exist. It does not revoke upstream credentials.

## Check access

**Check local LMTI MCP** performs a bounded `initialize` and `tools/list` against
the fixed local launcher. It reports the time and four advertised tools. It does
not call a tool, inspect remote endpoints or prove Codex/Cursor access.

Actual client verification must use the installed client and a permitted read on
the expected project/site. Codex and Cursor authentication/session state is
separate. The profile is configuration intent; tool-call policy is enforced by
the relevant client, server or gateway. LMTI is not an aggregation proxy here.

**[CẢNH BÁO BẢO MẬT]** A remote MCP may expose write operations. Use an approved
endpoint and scoped upstream credentials/gateway policy. Do not interpret a
configured URL or a local handshake as read-only authorization for that provider.
No Cloudflare/Tailscale account, ACL, network or device has been changed by this
implementation. Live provider/OAuth and operator acceptance remain open.

`.gitignore` excludes local client state, `.codex/` and `.cursor/mcp.json` in this
repository. Check the host project's ignore rules before sharing generated
configs; share only reviewed nonsecret templates. Run `lmti publish preflight`
before push/PR/release/remote changes.

## Run and verify

Use Python 3.11+ and the trusted Qt/MSVC tools already described in
[development](development.md). No new Python runtime package is required.

```powershell
./scripts/build-studio.ps1 -BuildDirectory build/native-mcp-20261013 -InstallDirectory build/studio-mcp-verified-20261013
./scripts/start-studio-ui.ps1 -PackageDirectory build/studio-mcp-verified-20261013
```

The package includes the Python launcher, SDK source and config helper under
`share/lmti/`. Source fallback is explicit in the Studio launcher. The launcher
sets the trusted per-process runtime paths and restores them when Studio exits.

See [CP-01 execution evidence](plans/2026-10-13-project-mcp-execution.md) for exact
build/tests and remaining client/operator gates. Creating valid Cursor JSON is
not proof of a running Cursor client; passing native M2 tests is not CP-01 acceptance.
