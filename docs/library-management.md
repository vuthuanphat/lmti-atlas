# Browser library management

The local operator can grant **Work → Project library** independently from
project content, Agent reads, hierarchy and maintenance. The browser chooses
opaque folder/candidate keys; it never supplies a filesystem path. Library
membership never grants content or Agent access. Restart the launcher after
creating/registering or changing bindings to establish a fresh explicit scope.

## Trusted launcher setup

Create a reviewed local JSON file outside the repository and `.lmti`. It contains
nonsecret locators only; do not put credentials in this file or project metadata.
Use existing ordinary local directories and exact approved database files:

```json
{
  "parent": "C:\\path\\to\\project-data",
  "folders": [
    {"key": "workspace", "label": "Approved workspace", "path": "C:\\path\\to\\workspace"}
  ],
  "candidates": [
    {"key": "existing", "label": "Existing project", "id": "existing-project", "database": "C:\\path\\to\\existing.sqlite", "folderKey": "workspace"}
  ]
}
```

`candidates` may be empty. The file is limited to 12 KiB; at most 32 approved
folders and 32 candidates are accepted. Total launcher configuration remains
limited to 16 KiB. Paths in the package, `.lmti`, network/device paths, alternate
streams, symlinks/junctions, hardlinked database files and root directories are
refused. The parent is only for new metadata databases; source folders must
already exist. Only the trusted operator chooses this file:

```powershell
& .\scripts\start-local-web.ps1 -DataDirectory 'C:\path\to\studio-data' -LibraryManagementFile 'C:\path\to\library-grants.json'
```

Content editing has a separate grant, for example
`-ProjectId existing-project -ProjectContent -ContentProjectId existing-project`.
This grant cannot be inferred from the library management file.

## Review and confirm

- **Create project** creates an internal, empty metadata database named
  `<project-id>.sqlite` in the approved parent and registers the chosen existing
  source folder. It does not copy/scan a repository or create source files.
- **Register existing project** validates the exact candidate's native project
  ID. Existing IDs are never replaced with another database path.
- **Link folder** chooses from the explicit folder list and changes only the
  library binding. It grants no new access in the current session.
- **Pin / Unpin** changes presentation metadata with an expected pin value.
- **Remove reference** removes the index row and preserves the database and folder.

Every change has a short-lived, session-bound review. Rejection never writes.
Confirmation consumes the review once, obtains the library-wide writer lease,
rechecks original physical targets and the full library signature, then calls
the typed native owner. Pins use CAS; registration/link/removal use native
binding generation CAS. Node never writes SQLite.

A missing library can be bootstrapped exclusively with its first project. The
result is schema 1, matching the existing initialization contract. Further
registration/link/removal requires the explicit reviewed library upgrade
workflow under [local web maintenance](local-web.md#bật-bản-sao-kích-hoạt-và-phục-hồi).
No implicit schema upgrade or overwrite is performed. Pins work with all supported formats.

## Pending and unknown outcomes

Do not repeat an accepted operation. Inspect its operation status first. A lost
reply, process loss or uncertain native completion keeps the durable writer gate
closed. Recovery reads the original library/parent, candidate or planned target,
validates current native state and requires explicit acknowledgment of fresh
state. This does not attribute a prior outcome or retry the write.

Creation uses an exclusive staging directory and a no-overwrite rename. Staging
artifacts are retained for operator inspection after failure; do not remove them
automatically. A created but unregistered database must be inspected and then
registered through a freshly reviewed candidate grant. A corrupt/inaccessible or
replaced original target fails closed; recovery cannot silently switch libraries.
Moving a missing database to another path is outside this editor: use a separately
reviewed native recovery/copy operation and relaunch. The UI cannot replace an
existing ID's database path under a “locate” shortcut.

SQLite remains unencrypted and nonsecret-only. DPAPI protects the writer journal,
not the project/library database. See [capabilities](web-capabilities.md) and
[ownership](component-support.md).

For interrupted operations, relaunch with the original reviewed grant file and
explicit original `-ProjectId` scope to inspect recovery before widening grants.
Changing recovery authority while an unknown operation remains does not bypass
the retained writer gate. Keep the original launcher arguments available.
