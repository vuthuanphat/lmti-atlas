# Google Drive in LMTI Studio

The local-alpha integration adds **Knowledge → Google Drive**. In a publisher
configured build, save/open a project, acknowledge Google's read-only account
scope, click **Connect Google Drive**, sign in through the system browser,
then choose a folder and use it. Select a supported document to preview text.
Disconnect, quitting, editing or switching the bound project clears the local
session; save the project before reconnecting.

Google Docs/Slides, plain text, Markdown and CSV support bounded preview.
Other formats remain metadata-only with an explicit Open in Drive action.
Preview is capped at 512 KiB; pages contain up to 100 entries. There is no
write/sync, indexing, document cache or automatic transfer to AI. Drive text
is not copied into `.lmti` or project files. Disconnect forgets the local
session; permissions can be revoked separately in Google account settings.

Google grants `drive.readonly` across accessible files; LMTI adds a selected
folder gate. The checkbox explains this before login. Permissions/version
are checked when an operation runs, not continuously.

## Publisher setup (not an end-user task)

This checkout has no OAuth client registration. Without publisher configuration
the UI reports setup required and cannot perform real login. The publisher
must create a Desktop app OAuth client, enable Drive API, configure consent/
test users and complete Google's verification for public distribution. See
the [installed app guide](https://developers.google.com/identity/protocols/oauth2/native-app)
and [Drive scope requirements](https://developers.google.com/workspace/drive/api/guides/api-specific-auth).

For development the trusted launcher can receive `LMTI_GOOGLE_CLIENT_ID` and
optional `LMTI_GOOGLE_CLIENT_SECRET` from its environment. Never put tokens or
secrets in source, command arguments, screenshots or chat. `.gitignore`
excludes `.env*`, `credentials/` and `build/`; verify exclusions before pushing.

For a package, pass `scripts/build-studio.ps1 -GoogleDriveClientFile` a local
JSON file containing only a `clientId` string. The build validates it and
writes the public identifier to `share/lmti/google-drive-client.json`. Never
put a secret in that file. Use a fresh package directory when changing release
configuration. `scripts/start-studio-ui.ps1` discovers this trusted package
config and enables the feature; users do not enter an ID. `-AllowGoogleDrive`
is also available for development but does not replace publisher setup.

The source launcher requires trusted Node.js 24+ and the built TS workspace.
A standalone signed installer/runtime bundle and public OAuth verification
remain release work; this is not yet a standalone consumer release.

## Validation boundary

Offline provider/OAuth/protocol tests use synthetic data and injected network
responses. Qt tests use a fake JSONL child and injected browser handler.
These prove local behavior, not connection to a real account. Live consent,
Google verification, shared-folder policies and clean Windows installation
still require publisher/operator verification.

See [the architecture decision](adr/2026-10-13-google-drive.md) and
[execution evidence](plans/2026-10-13-google-drive.md).
