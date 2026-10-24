# Projects, software and work

Current scope: 2026-10-24. React + Vite is the sole UI. Open the local browser
package using the [launcher guide](local-web.md). Qt Core/Sql remains a native
storage dependency; there is no Qt desktop executable or fallback launcher.

## Set up the local library

The launcher selects a local library and freezes the session's project scope.
Use the [fresh-workspace setup](local-web.md#thiết-lập-workspace-mới), or the
[advanced operator commands](local-web.md#khởi-tạo-dự-án-không-cần-desktop) for
existing data. A browser refresh, O or restart of the saved default opener keeps
the original IDs. Select newly registered IDs explicitly through the
[local opener](library-management.md#open-a-newly-registered-project); content
editing requires its separate grant. Existing libraries are preserved; schema
upgrades require the separate reviewed maintenance workflow.

The empty-library screen explains setup in English and Vietnamese. A failed
owner read has a different screen and never claims that existing data is empty.
Create/register, approved folder linking, pins and reference removal are now
browser workflows under an independent [library grant](library-management.md).
Relocating a missing database remains a separate reviewed native recovery task;
see the [capability matrix](web-capabilities.md). Removing a library
reference is distinct from deleting a project or its source folder.

## Edit declared project content

Grant editing explicitly when starting the current package:

```powershell
& .\scripts\start-local-web.ps1 -DataDirectory 'C:\path\to\studio-data' -ProjectId factory-monitor -ProjectContent -ContentProjectId factory-monitor -Interactive
```

Open **Work → Project content**. Choose a category, add/edit/remove a record,
review the before/after values, then confirm. A rejected review makes no change.
The owner reads back the saved revision; stale reviews require a fresh read and
new review. Pending or unknown writes must be inspected through operation status
and recovery before any retry. Closing the browser does not cancel an accepted write.

The 13 categories are project details, repositories, software components, hardware
targets, releases, software bindings, component dependencies, verification records,
milestones, work items, knowledge references, devices/services and declared connections.
Project identity is immutable. Referenced records cannot be removed while their
dependents remain. Approved release metadata is immutable; create a new release.
Done work requires a completed checklist; validation work also requires evidence.
Milestone acceptance requires completed linked work and operator evidence.

References and desired device settings are declarations, not deployed software,
observed health or executed device commands. Knowledge references do not import
documents. The existing native owner validates every record and preserves fields
outside the editor, including observed state and structural hierarchy.

## Other browser workflows

Logical and physical hierarchy editors use their own explicit grants and typed
review/commit contracts. MCP profile/client setup, restore, source context and
evidence remain available under their independent scope. Project copy, explicit
library upgrades, activation and recovery are documented in [local web](local-web.md).
Drive and advanced Impact owners have separate CLI/SDK interfaces; the removed
Qt panels are not browser features. No canvas/Qt inspector/undo-redo is shipped.

## Ownership and protection

LMPR project documents, LMLB library index, profile/config stores, TypeScript memory,
compiled Project Atlas and LMIP Impact records have distinct owners and versions.
JSON is a bounded process/API boundary, not a replacement durable project format.
Node does not write native SQLite. Agent SDK/MCP access does not include the local
operator content editor or a raw storage handle.

**[CẢNH BÁO BẢO MẬT]** Project/library/profile SQLite is unencrypted. Store only
nonsecret metadata; never passwords, API keys, access tokens or confidential raw
documents. DPAPI protects specific client backups/journals, not these databases.
Trusted launcher grants are not an OS sandbox against another process of the same user.

See [component support](component-support.md), [project ADR](adr/2026-10-11-project-document.md),
[browser-only decision](adr/2026-10-23-browser-only-ui.md) and [release build](release-build.md).
Clean Windows, an independent operator and live provider/client acceptance remain open gates.
