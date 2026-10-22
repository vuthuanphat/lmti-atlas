# Project library implementation evidence

Date: 2026-10-12. Status: implemented experimental local alpha under the
[library plan](2026-10-12-project-library.md); direct operator and clean-machine
acceptance remain pending. This is not a production-readiness percentage.

## Delivered behavior

- Default desktop home is Project library: create a new folder, link an existing
  folder, open a file or explore a clearly synthetic sample. Cards support search,
  pins, recent filtering, missing-file/folder states, relocation and removal.
- New folders contain `project.lmti.sqlite`. Linking source without that file
  stores metadata under the portable package's `data/documents/`, preserving
  source files. Paths inside `.lmti/` are rejected. Removing a ref deletes no file.
- Sidebar, breadcrumb, compact workspace toolbar and Overview metrics expose
  software, hardware, architecture, work, versions and advanced Agent functions.
- English is default; Vietnamese is selectable at the sidebar bottom. Runtime
  changes retain unsaved data, page and project identity. A bounded local INI
  stores only the language choice; user text and domain IDs/enums are not translated.
- Independent LMLB SQLite index retains at most 500 entries, with 24 cards/page
  and responsive 1–3 columns. Canonical folders are unique. Legacy LMCA recent
  refs import once without modifying the source; removed refs do not reappear.
  LMPR/topology/memory schemas and Agent grants are unchanged.

## Verification on this Windows development machine

- Release MSVC/CMake build succeeds with the existing Qt 6.12.0 toolchain.
- CTest: **4/4** suites pass, including domain/storage and offscreen Qt UI tests.
  New coverage checks catalog preservation, more than 30 library entries,
  persistent pins/folder identity, wrong schema/relative path rejection,
  source-preserving linking/removal, traversal/reserved/existing-folder rejection,
  `.lmti` rejection, wrong-project relocation and Cancel preserving dirty work.
  Switching English/Vietnamese preserves the document and page. A resized
  1100×800 library has no horizontal scrollbar and all seven sidebar entries fit.
- Python SDK/MCP integration: **12/12** tests passed with no skips, including
  project and topology boundaries using packaged CLIs and real MCP subprocesses. UI refinements
  after this run do not change CLI/SDK behavior. Existing TS/Go memory sources
  were not changed for this library task; their earlier baseline remains separate.
- Actual Qt window renders use isolated temporary synthetic projects/catalogs,
  never the user's library. English/Vietnamese library, Overview, Work and
  relationship screenshots are included in the [guide](../project-studio.md).
- Portable package: `build/studio-library`, separate from older running packages
  to preserve their unsaved work. Each installation has its own writable `data/`;
  references are not silently copied from another install's live SQLite database.
- Normal packaged launch, without demo arguments, returned InputReady/Responding
  and a nonzero window handle with title `LMTI · Project library`. It was left
  open for review; the older Projects window with unsaved work remains open.
- Formatting and `git diff --check` pass. Local links in the nine updated
  coordination/guide/decision documents resolve. Deployment still logs the
  existing optional DX compiler/VCINSTALLDIR warnings; clean-machine verification
  is not claimed.

These checks cover local behavior, not a benchmark of 500 loaded documents,
manual operator sign-off, an actual product Agent client or a clean Windows install.

## Limits and next gates

**[CẢNH BÁO BẢO MẬT]** SQLite metadata and local paths are unencrypted. Do not
store secrets; classification is not OS isolation. Check `.gitignore` for
databases/WAL/SHM and secrets before push; run `lmti publish preflight` before
publishing. No packages, external assets, cloud calls or Agent filesystem grants
were added. Folder linking does not scan a repository or dereference memory.

Library backup/recovery, schema upgrade, cross-machine/profile location policy,
encrypted storage, file editing, memory bridge and device execution need separate
contracts. Some legacy topology controls and technical errors remain English.
If creation fails after making the new folder, it can leave an empty folder for
explicit recovery; it never recursively removes source to hide the failure.
Existing project acceptance and deployment gates remain in force.

Lesson candidates, not stored automatically: a library index is not permission;
removal preserves source; relocation checks project identity; language changes
must preserve dirty data; rendering uses isolated fixtures.
