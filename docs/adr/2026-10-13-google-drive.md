# Google Drive local document reader

Status: accepted local-alpha slice, requested 2026-10-13. Live OAuth release verification remains required.

The operator requested quick connection and documents from a selected Drive
folder. End users must not create OAuth clients or paste credentials. This
improves project understanding through a deliberate document source, reduces
repeated navigation within a session, protects knowledge through local-only
preview and uses a replaceable provider. Reusable compiled knowledge is a
later, privacy-reviewed step; raw text is not automatically memory/AI context.

## Decision

Append Google Drive to Knowledge. A separate Qt panel owns the operator flow;
a persistent `drive-desktop` JSONL child owns credentials and the provider.
`@atlas/drive` uses Node built-ins with no memory/native storage dependency.
Project identities/revisions and connection IDs bind every request. Project
changes and cancellation clear the session. Native domain, LMPR/SQLite,
Python/MCP and the existing knowledge bridge retain their owners.

The publisher registers a Desktop OAuth client, enables Drive API and packages
its public client ID. Users sign in using their system browser and choose a
folder. PKCE S256, random state, a loopback listener on 127.0.0.1, bounded
responses and fixed Google endpoints protect login. Credentials remain in
process memory only; no local token cache or credential form is introduced.

Google's `drive.readonly` covers all accessible Drive files; it is not a
server-enforced folder grant. The UI requires acknowledgment before login.
Folder choice lists only direct folder metadata. After selection, file
metadata/content operations enforce account/root ancestry. Shortcuts are
denied. Traversal, cursors, pagination, time and sizes are bounded. Current
permissions and versions are checked before/after content reads. These checks
are snapshots, not continuous revocation monitoring.

Docs/Slides exports and textual files have bounded plain-text previews.
Unsupported formats stay metadata-only. Content is never executed, written
to SQLite/disk/`.lmti`, or sent to impact review or external AI. A future
compiled-knowledge import must independently define classification,
provenance, refresh/deletion and egress approval. No Agent Drive tool is added.

## Limits

* Google's broad restricted scope requires publisher verification before a
  public release; folder filtering must not be advertised as Google ACLs.
* Session-only credentials require login again after quitting/changing projects.
* My Drive folder navigation is default. The broker also accepts a standard
  accessible folder URL, but resource-key URLs and a Shared Drives directory
  browser are not supported in this slice.
* No cache, recursive indexing, PDF extraction, write/sync or AI context import.
* Trusted launcher/child validation is not an OS sandbox against the same user.
  Local preview is not encrypted storage.

## Sources

* [Google Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)
* [Installed application OAuth](https://developers.google.com/identity/protocols/oauth2/native-app)
* [Download/export guidance](https://developers.google.com/workspace/drive/api/guides/manage-downloads)
