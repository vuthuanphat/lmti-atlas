# Browser library management

The local operator can grant **Work → Project library** independently from
project content, Agent reads, hierarchy and maintenance. The browser chooses
opaque folder/candidate keys; it never supplies a filesystem path. Library
membership never grants content or Agent access. Opening another tab with O or
restarting the default saved launcher keeps the original IDs and grants.

## Trusted launcher setup

For a new demo or empty workspace, use the
[reviewed setup flow](local-web.md#thiết-lập-workspace-mới) and its reusable
`Open-LMTI.cmd`. It prepares a bounded nonsecret library grant and grants content
editing only for the initial project. By default it creates four approved source
folders: initial `source/` and unused `source-2/`, `source-3/`, `source-4/`.
`-ProjectFolderCount` selects 1–8, default 4, entirely within the new workspace;
all folders appear in the CREATE review. This grants no access to a real repository.
It does not grant Agent, hierarchy or
project copy/activation access. The JSON procedure below is the advanced path
for explicitly selected existing data.

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
& .\scripts\start-local-web.ps1 -DataDirectory 'C:\path\to\studio-data' -LibraryManagementFile 'C:\path\to\library-grants.json' -Interactive
```

Content editing has a separate grant, for example
`-ProjectId existing-project -ProjectContent -ContentProjectId existing-project`.
This grant cannot be inferred from the library management file.

## Open a newly registered project

Before creating a second project, complete the explicit reviewed library upgrade
with separately granted maintenance, then select an **unused** approved folder,
such as key `workspace-source-2` (`source-2/`). The initial `source/` is already
bound; native library folder keys are unique and cannot be reused for another
project. Existing one-folder profiles stay valid but have no spare folder; use a
separate reviewed advanced grant instead of editing the saved profile to widen it.

After the native owner confirms registration, open a new session with an
explicit catalog selection. First use Q in the older workspace console and wait
for drain; a second broker must not bypass its writer admission. From the trusted
package directory:

```powershell
& .\scripts\open-local-workspace.ps1 -WorkspaceFile 'C:\LMTI-demo\lmti-workspace.json' -ProjectId new-project
```

The new project's content is read-only. Saved library-management/maintenance
grants remain active, so the whole session is not read-only. To explicitly grant
content editing to every selected ID, use the `-GrantProjectContent` **switch**:

```powershell
& .\scripts\open-local-workspace.ps1 -WorkspaceFile 'C:\LMTI-demo\lmti-workspace.json' -ProjectId new-project -GrantProjectContent
```

The native catalog validates each selected ID; the profile is not rewritten.
With a selection containing the initial and new project but no switch, only
the original content grant is retained. `-GrantProjectContent` requires explicit
IDs and grants all selected IDs, so select only projects you intend to edit.
Add `-ValidateOnly` to inspect `selectedProjectIds` and `contentProjectIds`
without starting a service. This grants neither Agent nor hierarchy/copy/activation
access. A normal double-click still uses the original saved scope. Retain that
original scope for unresolved recovery; changing IDs does not clear a writer gate.

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
