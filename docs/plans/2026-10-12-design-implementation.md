# AI design implementation and completion audit

> Planning status, 2026-10-13: this is a dated scope/evidence record.
> The [consolidated master plan](../LMTI_MASTER_PLAN.md) owns current priorities
> and M0–M4 milestones. Earlier stage orders and unfinished work below are
> reference material, not a separate active backlog. Accepted architecture and
> recorded evidence remain valid within their stated scope.

The operator subsequently requested further UI correction. See the current
[management UI layout contract](2026-10-12-management-ui-fix.md). Earlier
“Verified” labels below record engineering checks of that package, not operator
acceptance of its layout; they do not certify the later package automatically.

Date: 2026-10-12. Objective: implement the full selected 26-screen design set in the
native Qt application. The selected local-alpha implementation is complete; operator preference and clean-machine acceptance remain separate.
The user selected the Image AI direction after rejecting earlier UI iterations.

## Requirements and evidence

All rows must have source behavior, representative runtime rendering and relevant
interaction evidence before completion. A green build or aggregate test result
alone does not prove visual fidelity or all page workflows. Real data may differ
from synthetic image examples; typed domain states and privacy boundaries remain
binding, including the notes in the design gallery.

| Screen | Required behavior | Current evidence | Status |
| --- | --- | --- | --- |
| [Overview](../design/2026-10-12-ai-ui/01-overview.png) | Two priorities panels, actionable attention rows, open work table and truthful count strip | Two panels with explicit Open buttons, blockers first, three visible priorities and truthful omitted-item count, open work/state badges and real metadata counts. Correct record/Back-to-Overview, Validation/Internal planning defaults, milestone eligibility, quiet empty state and creation prerequisites verified in both languages/all three sizes/four simulated DPI levels and native Windows; selected native renders inspected | Verified for the local-alpha scope |
| [Project library](../design/2026-10-12-ai-ui/02-project-library-v2.png) | Global recent navigation, list/cards, local search/sort/pins, Open/Locate/More, neutral availability | Global shell hides project navigation/Save; actual list/card/pin/search/sort and folder workflows, missing file/folder states, identity-preserving Locate and safe switching tested. Available locally stays neutral and folder actions recheck at activation. Current native/full/compact EN/VI renders inspected; capture coverage spans all size/DPI profiles | Verified for the local-alpha scope |
| [Software · Components](../design/2026-10-12-ai-ui/03-software-components.png) | Component inventory/filter, typed badges, reserved Summary/Related work details and related release/work actions | Typed kind/visibility, declared binding counts and Unknown observed versions; Summary/Related work modes, real links, creation actions, empty related-work state and Back preserving the mode/record. Fixed title remains visible while details scroll. All three sizes/both languages/four simulated DPI levels/native Windows interaction checks pass; current compact/full renders inspected | Verified for the local-alpha scope |
| [Software · Repositories](../design/2026-10-12-ai-ui/04-software-repositories.png) | Repository metadata table, linked components, no cloning/source scan | Four columns, typed visibility and actual linked-component counts; selected locator facts, related component identity/Back and real retained locator edits followed by explicit Save verified. Search/More use the shared inventory; no source reader or clone operation exists. Current EN/VI full/compact renders inspected | Verified for the local-alpha scope |
| [Software · Dependencies](../design/2026-10-12-ai-ui/05-software-dependencies-v2.png) | Correct three tabs, source/target contract inventory and component links | Three Software tabs, explicit source/target component headers and typed contract rows; selected target identity/related component/Back verified. Real edit retains invalid self-dependency input before accepting a valid contract into the draft; Save remains separate. Current native EN/VI and compact VI renders inspected | Verified for the local-alpha scope |
| [Hardware · Devices](../design/2026-10-12-ai-ui/06-hardware-devices.png) | Device/site filters, desired vs Unknown observed fields, related bindings/work | Kind/site/search filters preserve IDs through language changes; actual desired bindings and Unknown observed facts remain separate. Binding/work/target navigation, metadata editing/undo and topology action are operational. Current native/compact EN/VI renders and related-record interaction tests inspected | Verified for the local-alpha scope |
| [Hardware · Targets](../design/2026-10-12-ai-ui/07-hardware-targets-v2.png) | Targets tab and compatibility metadata with related candidate releases | Exact target/revision/architecture/visibility facts and actual linked-release identity; related keyboard activation/Back preserves the target and document. Three hardware tabs and compatibility-only notice match the domain boundary. Current EN/VI full/compact captures inspected; shared inventory controls remain operational | Verified for the local-alpha scope |
| [Hardware · Software bindings](../design/2026-10-12-ai-ui/08-software-bindings-v2.png) | Desired binding metadata, all unsupported observed values Unknown | Actual device/component/target/release facts, Unknown observed state and correct related identities. Real edit validates mismatched links; Add validation work pre-fills the actual binding links, defaults Internal, opens the created work, links back and requires Save. Native/offscreen workflow and current EN/VI full/compact renders inspected | Verified for the local-alpha scope |
| [Architecture · Device topology](../design/2026-10-12-ai-ui/09-architecture-topology.png) | Light topology canvas, compact toolbar/legend and typed selected-node details | Directed declared connections, selected-device fields and Unknown observations; reachable Select/Pan/Zoom/Fit/Add/Connect controls. Compact fitted cards retain readable identity/type, protocol labels keep their size, full names remain in tooltips. Positions/domain are unchanged by views; drag is undoable. Current compact/full renders inspected and typed edits/controls verified in both languages/all sizes/four simulated DPI levels/native Windows | Verified for the local-alpha scope |
| [Architecture · Software relationships](../design/2026-10-12-ai-ui/10-architecture-relationships.png) | Readable component/device graph, correct dependency and binding edges, zoom/fit/count | Rounded semantic cards, exact directed component dependencies/device bindings, actual displayed/total counts and explicit metadata-only notice. Selection persists across compact resize; zoom/fit and related details do not mutate the document. Current compact/full renders inspected and all supported control profiles verified | Verified for the local-alpha scope |
| [Work · List](../design/2026-10-12-ai-ui/11-work-list.png) | List/Board view switch, state/kind filters, work/evidence table and details | Actual state/kind/text filters and stable IDs synchronized with Board; evidence/checklist/related facts and retained validation edits. Add/view/More/Edit remain reachable at all sizes/languages/DPI profiles. Single-click reopens the selected row after closing/returning; current compact/full captures inspected | Verified for the local-alpha scope |
| [Work · Board](../design/2026-10-12-ai-ui/12-work-board.png) | Five state columns, readable cards with component/version/milestone/evidence and selection | Five native columns with truthful counts and component/release/milestone/evidence cards; synchronized filters/selection and mode retained on resize. Columns scroll independently of tools. Closing/reopening the same card works without edits, across both languages/all sizes/four simulated DPI levels/native Windows; current captures inspected | Verified for the local-alpha scope |
| [Work · Milestones](../design/2026-10-12-ai-ui/13-milestones.png) | Milestone inventory, due/completion/acceptance/evidence and gated acceptance | Actual due/completion/acceptance/evidence fields and linked-work states; explicit acceptance requires all work Done plus evidence. Empty/missing evidence remains gated. Undo, separate draft/Save and typed reopening rejection tested. Reopening the selected row and fixed acceptance/Edit actions are reachable at every supported control profile; current captures inspected | Verified for the local-alpha scope |
| [Releases · Versions](../design/2026-10-12-ai-ui/14-releases.png) | Release inventory/filter, source revision/review state, immutable approved metadata | Component/state/text filters; exact source/target/review facts. Approved records retain a visible locked badge/Create new version, disabled Edit and core immutability. Cancel preserves the record; creation opens a separate Internal draft and Save persists it. Controls and reopening work at every supported profile; current captures inspected | Verified for the local-alpha scope |
| [Releases · Evidence](../design/2026-10-12-ai-ui/15-release-evidence.png) | Evidence record table/result/source/time and typed details without device execution | Separate actual evidence/result/source/time fields with exact UTC tooltip and full details; linked work/device/release identities, no self-link and release/result filters. Evidence is operator metadata, never a test/device execution claim. Controls and read-only view/filtering preserve the document at all supported profiles; current captures inspected | Verified for the local-alpha scope |
| [Knowledge · References](../design/2026-10-12-ai-ui/16-knowledge-references-v2.png) | First flat Knowledge tab; unloaded reference metadata never grants source access | Declared component/fingerprint/visibility/source facts; creation defaults Internal and remains Not connected without starting a reader. Real retained-input/edit/related navigation and separate Save verified; native/compact EN/VI captures inspected. | Verified for the local-alpha scope |
| [Knowledge · Project map](../design/2026-10-12-ai-ui/17-knowledge-project-map-v2.png) | Searchable read-only Project map, source status, matched/allowed count and summary/provenance | Actual owner-adapter public summaries, localized kinds, source provenance and scrolling details. Local search preserves record data, starts no reader and distinguishes unloaded/empty/no-match states; reload retains query and switching projects clears it. Both languages/all sizes/four simulated DPI levels and native Windows tested; current native/compact captures inspected | Verified for the local-alpha scope |
| [Knowledge · Memory](../design/2026-10-12-ai-ui/18-knowledge-memory-v2.png) | Searchable allowed summaries, classification/update/provenance, truthful connection/count and independent egress policy | Internal classification, source/category/update details and independent checked-context export preserved. Actual missing-store read neither creates storage nor reports a zero-record database; explicit owner creation/reload then loads the memory. Search/selection/non-mutating context and geometry verified in both languages/all sizes/four simulated DPI levels/native Windows; current captures inspected | Verified for the local-alpha scope |
| [Knowledge · Lessons](../design/2026-10-12-ai-ui/19-knowledge-lessons.png) | Searchable lesson states and evidence/privacy review under explicit capability | Real owner grant/confirmation/approval/reusability integration; hidden selections clear confirmation and cannot approve, pending lessons remain outside context. Wrapped confirmation retains full Vietnamese text at compact widths, native checkbox/Space behavior and fixed decision actions. Both languages/all sizes/four simulated DPI levels/native Windows tested; current compact/full captures inspected | Verified for the local-alpha scope |
| [Knowledge · Task context](../design/2026-10-12-ai-ui/20-knowledge-task-context.png) | Separate input/checked preview, recommendation-only skill, intentional Copy/Export | Separate task input and scoped structured checked preview; JSON collapsed and skill routing recommendation-only. Actual owner integration, real file-dialog export with exact content, task-change invalidation and denied/stale scope gates pass. Actions remain reachable at all sizes/languages/four simulated DPI levels and native Windows; captures inspected. | Verified for the local-alpha scope |
| [Agent · Context](../design/2026-10-12-ai-ui/21-agent-context.png) | Saved/draft/site/public scope structured preview, counts/allowed records, collapsed JSON | Actual saved/draft/site/public counts and allowed records, collapsed JSON and local search. Private/other-site exclusion and no-match/unavailable states verified without document changes. Controls remain reachable at all sizes/languages/four simulated DPI levels/native Windows; current full/compact captures inspected. | Verified for the local-alpha scope |
| [Agent · Review](../design/2026-10-12-ai-ui/22-agent-review-v2.png) | Import/compare/apply work-state proposal only, clean matching revision, no stale apply | Actual work-state-only proposal comparison; clean saved revision, settings pending, dirty/stale/wrong-project and forbidden Done gates enforced. Apply edits only the draft state; Cancel and Undo preserve other metadata and disk. Import/Apply/Cancel fit all supported profiles; full/compact EN/VI captures inspected. | Verified for the local-alpha scope |
| [Agent · Setup](../design/2026-10-12-ai-ui/23-agent-setup-v2.png) | SDK/MCP documentation/capabilities, no fabricated versions or verified client state | Compact panels, measured complete three-row tables and visible unverified status at 1440×900; translated rows/tooltips and accessible compact scrolling checked at all three sizes in both languages at 100/125/150/200% simulation, plus native Windows; instructions dialog and supported SDK/MCP boundary verified | Verified for the local-alpha scope |
| [Project settings](../design/2026-10-12-ai-ui/24-project-settings-v2.png) | General/Local files page, validated Apply to draft, Cancel, retained form and Save boundary | General/Local files tabs, complete page captions in EN/VI, retained form across tabs, typed UTF-8 validation and focus, Apply/Cancel and separate Save verified. Actions reachable at all sizes/languages/four simulated DPI levels/native Windows; real draft/disk invariants and current captures inspected. | Verified for the local-alpha scope |
| [Create project](../design/2026-10-12-ai-ui/25-create-project.png) | Grouped project/local-folder form, destination preview, fixed actions and safe creation | Actual dialog validates traversal/existing-folder input without writes, retains input, clears stale destination preview when a field is emptied, then creates a separate Internal saved project. Fixed footer verified at 620/700/740 px, both languages and four simulated DPI levels, plus native Windows; populated destination captures | Verified for the local-alpha scope |
| [Edit work · Validation state](../design/2026-10-12-ai-ui/26-edit-work-validation.png) | Grouped Summary/Links/Completion form, retained invalid input/focus, fixed actions | Actual edit of validate-sampling retains its component/device/release/milestone; invalid Done preserves draft and disk, focuses and reveals the full field/error container; Escape cancels without history changes. Localized title/groups and fixed footer verified at 620/700/740 px, both languages/four simulated DPI levels and native Windows; actual edit captures | Verified for the local-alpha scope |

## Cross-page gates

| Gate | Final evidence and limits |
| --- | --- |
| Shared shell, theme, readable tables/cards, page actions | All 26 selected routes implemented; reserved inspector, compact toolbar/sidebar, List/Board and List/Cards controls verified. Current native/full/compact renders inspected. |
| EN/VI and metadata | Both UI languages captured and exercised; authored metadata is unchanged. Literal SDK commands and domain exception messages remain verbatim. |
| Sizes/DPI/keyboard/scroll | 1100?800, 1280?720, 1440?900; four simulated DPI levels. Real geometry, navigation/Enter/Escape/Space, form focus, inspector and page scrolling tested. Native Windows runs separately; the monitor limits visible height at its 125% setting. |
| Empty/loading/error/missing/read-only/conflict | Inventory no-match/empty/prerequisite states; Knowledge no-source/loading/cancel/denied/malformed/timeout; missing library paths; immutable approved release and stale/conflicting proposals covered by actual controls/core. |
| Drafts, history and project/library switching | Actual Save/Discard/Cancel, switch/reopen, Undo/Redo, safe Locate and draft preservation tests pass on disposable projects. |
| Settings/object validation | Typed validation, UTF-8 bounds, retained invalid input, full field reveal, fixed form footer and separate Apply/Save tested. Settings drafts survive tab changes and Cancel restores the baseline. |
| Knowledge privacy/process boundaries | Owning adapter only; bounded asynchronous reads, deadline/cancel, strict scope/schema and stale-export clearing verified. Actual owner round trip and exact file-dialog export pass. |
| Lesson/proposal writes | Explicit grant + evidence/privacy confirmation for reviewed lessons; clean matching saved revision and work-state-only proposal application. Hidden/stale/denied selections stay gated. |
| Regression/package | CTest 4/4; desktop 34 passing results; bridge/memory 38; deployed SDK/MCP 12. Final context/settings subset has seven passing results per DPI/native profile. |
| Capture/guide/launcher/handoff | 676 current hash-bound images; paired EN/VI galleries, current guide and both launcher routes verified. Current isolated package opened as process 45676; older unsaved process 63288 preserved. |

These gates establish the accepted native local-alpha implementation, not a
pixel-identical copy of synthetic record counts, an installed SDK client,
production device execution, encrypted storage or clean-machine distribution.
No real project/memory data was used for fixtures and no user draft was discarded.

## Current runtime evidence

The [side-by-side review gallery](../design/2026-10-12-ai-ui/runtime-review.html)
contains all 26 AI references and 26 actual native screenshots; the
[Vietnamese gallery](../design/2026-10-12-ai-ui/runtime-review-vi.html) adds the
same 26 pages in Vietnamese. Both sets match the current package. The companion
render results bind each screenshot to the current package SHA-256. These bind render provenance; operator visual acceptance remains separate. Knowledge screens 17–20 now use a
populated disposable source through the owning adapter. Its modules are explicit
public examples; memory keeps the owner's Internal minimum and exports only the
allowed summaries. Pending lessons stay outside task context. Fixture evidence
records an actual scoped adapter check rather than invented test execution.

Current native CTest: 4/4 passed, including 34 desktop QtTest results with no
failures/skips. The actual Windows control test also passes: the compact Save
button/breadcrumb fit, Recent projects stays near the top, and real segmented
buttons change List/Board and List/Cards. This verifies the current Windows
environment, not every required DPI. Scope/privacy/stale proposal and retained
invalid form input tests cover behavior independently of screenshots. New checks
cover combined inventory filters, stable IDs across language/Back navigation,
List/Board synchronization and real opt-in lesson approval through the owning
writer. Bridge/memory regression: 38 passed. Packaged Python SDK/MCP: 12 passed.
The SDK intentionally strips broad runtime search paths, so its integration
checks use deployed binaries with local Qt libraries, rather than build-tree
binaries that depend on the development PATH.

Additional interaction checks cover exact graph edge endpoints, selection and
view-only controls, native typed device edits after translation, milestone
completion/evidence/acceptance gates and explicit Save, separate evidence
source/date/UTC tooltip and linked work. Work Board retains the selected mode on
resize. Inspector links omit the inspected record and repeated identities.
Software and hardware details now share structured typed facts, including an
explicit Unknown observed version on devices/bindings. Related records use
two-line icon cards with native selection, Enter activation and Back navigation.
Six inventory routes verify the actual linked identity and non-mutating history;
repository/dependency/binding edits verify retained invalid input and draft/Save
separation. Work and release evidence also expose separate facts rather than a
single dense paragraph. Caption/value widths remain bounded in compact inspectors.
Work selected-record Edit/Remove actions move into More, keeping Add and List/Board
visible with details open. Only the Board columns scroll horizontally; a hidden
Board no longer widens the List page. The primary controls and keyboard-opened
More menu are verified at all three sizes in English/Vietnamese, and pass on the
native Windows platform as well as offscreen. The native inventory/dialog subset
has five results including setup/cleanup, with no failures/skips.
Form errors aggregate across all checks on a field; a passing check cannot erase
another check's invalid state. Settings name errors use typed validation for
focus, including multibyte UTF-8 limits. Shared controls explicitly paint readable
checkbox, dropdown and numeric-step indicators while retaining native interaction.

Release details now show component, target, source revision, review state and
classification as separate fields, with the metadata-versus-installation notice.
Approved records show a locked badge and a prominent Create new version action
above the facts. Creation defaults to a separate Internal draft, preserves the
approved record, opens the new record after submission and still requires Save
for storage. Cancel and immutability are verified through the real dialog/core.
Inspector actions retain full translated text and wrap it to the available width.

Setup's documentation tables measure their actual themed row/header heights and
show all three rows without nested vertical scrolling. Compact margins bring the
unverified connection section into the 1440×900 view. Three-size/two-language
layout checks pass at all four simulated DPI levels and on native Windows.
Knowledge now distinguishes a verified loaded snapshot from a selected source:
loading, denial, malformed/wrong-scope output, cancellation and document changes
clear readiness and disable Prepare/Copy/Export until a valid response. The source
identity pin remains intact. An invalid task clears only the outgoing context,
preserving a still-valid source snapshot for correction. Real owner integration,
lesson confirmation/approval and wrong-scope/timeout checks pass. The populated
Reference fixture remains declared metadata and never launches a source reader.
Creation captures now include a destination preview in the disposable fixture;
they reject the dialog after capture and create no operator project.

Forms now reveal the entire focused field container rather than Qt's caret-only
visibility target; label/error layout and scrollbar range updates cannot leave
part of the invalid field below the viewport. General submission failures remain
outside the scrolling body, above the fixed buttons. Real edit/create checks cover
620/700/740-pixel dialog heights in both languages at 100/125/150/200% simulation,
plus the native Windows platform. They retain invalid work drafts, reject traversal
and existing folders, clear stale destination previews and create six isolated
Internal projects through the actual dialog before reopening the unchanged original.
The validation render now edits an existing saved work record instead of depicting
an Add dialog as Edit. Dialog captures use the requested parent's supported bounds;
they do not inherit an arbitrary offscreen monitor size.

Overview now opens attention records through explicit row buttons, prioritizes
blocked work and bounds visible priority widgets to three while reporting the
actual total. Milestone work counts are computed once instead of repeatedly
scanning work for every milestone. Navigation can return to an Overview with no
prior inspected entity; Back hides the inspector in that empty view rather than
showing stale details. Plan verification work uses a typed Validation preset and
retains Internal defaults. Inventory overlays distinguish empty data from filtered
no-match results without inventing rows/identities. Creation prerequisites gate
release/dependency/binding/evidence actions with translated explanations. Runtime
checks verify gates reopening with real metadata and preserve the document while
changing filters/language. Shared template and row model text no longer double-paint
the priority title beneath the native widgets.

Library availability is computed from current file/folder metadata in both views;
missing and unsupported locations are distinguished, and missing paths are not
claimed to be healthy or proven moved. The owner-based synthetic render physically
moves one file and pins two projects. A real Locate dialog rejects another
project identity and repairs the same identity without changing either project
file or losing its pin. Folder actions revalidate through the existing folder
boundary at invocation and refresh the warning if the folder changed. The
regression uses a process-local URL probe, so it does not launch Explorer.
Old deferred-delete controls relinquish their names before rebuilding, ensuring
interaction checks reach the current controls.

Details now reserve a separate horizontal region at 1100×800, 1280×720 and
1440×900 rather than covering the workspace below 1280. Both UI languages have
geometry and keyboard-Escape checks at all three logical sizes; view changes do
not mutate the document. The relationship graph uses compact node/column/lane
spacing below 1440 and rebuilds only when crossing that layout breakpoint.
Selection and declared edge identities survive resizing; compact text keeps full
metadata in its tooltip.
Native Windows geometry/Escape and graph-resize checks also pass. On this
monitor Windows clamps the 1440×900 request at native 125% DPI to its work area;
those native interaction results do not prove a physically visible 900-logical-
pixel window. Exact-size simulated captures and offscreen interaction evidence
remain separate from monitor-limited native behavior.

The launcher now prefers `build/studio-design`, preserves the existing data
directory fallback and still honors explicit package/data overrides. Its
`-PrintLaunchInfo` mode verifies the chosen binary/hash/arguments without launching
or writing application data; lesson review remains off by default. The Projects
guide documents this selection. A separate `build/studio-design-review` package
was opened with an isolated synthetic demo directory, keeping development
installation and older unsaved windows separate. That already-open window still
uses the earlier C6071443 package. Current development captures use package
EE28C7DE54E7CA361B09B9F553539EEE9056A255E8EB98BF6FB8172FC2E996FD.
Do not overwrite or stop this review window while
it may have unsaved work.
Older review process is 63288 (`build/studio-design-review/bin/lmti-desktop.exe`);
the original `studio-ui-v2` process 19944 is no longer present in the current
process inventory; it was not terminated by this work. Process IDs are
session evidence, not durable application identifiers.

Capture verification now records actual logical and pixel dimensions, DPR and
font family. Missing Latin/Vietnamese glyphs reject a capture. The Windows
initial-show height clamp is corrected for a full requested synthetic viewport.
The native gallery uses 1440×900 logical frames and records the actual Windows
DPR per capture. DPI simulation uses the matching local Qt SDK offscreen platform
and local Windows fonts; it is separate from native Windows control evidence.
[`QT_SCALE_FACTOR` multiplies native DPR](https://doc.qt.io/qt-6/highdpi.html#qt-scale-factor),
so the measured capture ratio, not the requested multiplier, is authoritative.
Successful capture is not visual or keyboard acceptance. Compact layouts and
all page/state combinations still require inspection.

The earlier EB12 package has 26 measured native captures per language at 1440×900,
26 offscreen captures at 1100×800/100% (English), and 26 at 1280×720/200%
(Vietnamese). All 26 pages additionally have 1440×900/125% (English) and
1280×720/150% (Vietnamese) captures. All report Segoe UI, matching logical dimensions and
package hash. These 156 captures are layout evidence, not proof that all 26
screens passed every size/DPI/state combination. Their results are in
`build/design-review`, `build/design-compact-1100-100`,
`build/design-compact-1280-200`, `build/design-dpi-1440-125` and
`build/design-dpi-1280-150`. Board captures now require the actual Board view;
an automatic fallback to List cannot silently satisfy that screen requirement.

The current DCB2 matrix in `build/design-matrix` contains 624 successful captures:
all 26 screens at three logical sizes, four simulated DPI levels and both
languages. Together with 52 current native captures, all 676 results were checked
for the package hash, image presence, Segoe UI, matching logical window dimensions
and pixel dimensions consistent with the recorded DPR. This proves capture
coverage, not universal visual/state/keyboard acceptance.

The earlier 868A package had native EN/VI captures for all 26 screens and
seven compact Vietnamese inventory/Board captures in `build/design-compact-toolbar`.
Both comparison galleries were rebuilt against its hash. Generic inventories now
keep Add/Search/filters visible and move Edit/Remove into the keyboard-accessible
More menu; the inspector retains Edit. Add keeps its intrinsic width rather than
stretching into a broad blue bar on larger windows. Library Locate actions reserve their full
translated text. Recent-project, availability, starter and Board evidence captions
are translated, while project metadata remains verbatim. Dependency headers name
the source and target components explicitly rather than translating Target as hardware.

The updated real-dialog test opens More with Space, selects the correct component
at all three sizes in both languages, checks a usable search width and cancels
without mutating the document/selection. The inventory edit/facts/library subset
passes at all four simulated DPI levels and on native Windows (five results each,
zero failures/skips). Full current CTest passed 4/4, including 29 desktop results
with no failures/skips; that subset covers the corrected dependency
and its related identity. Standalone library checks explicitly restore their
language state, removing test-order dependence. Full cross-page acceptance remains pending.

Knowledge now supplies local search and matched/allowed counts for Project map,
Memory and Lessons, over the bounded checked snapshot only. Details expose the
actual source and available category, never invented provenance. Filtered-out
selections clear their details and lesson confirmation; activation guards also
reject a hidden candidate. Missing memory storage is distinct from an empty
connected store, and inconsistent adapter connection/record states are rejected.
The real owner integration confirms that reading a missing store creates no
database, then explicitly creates a synthetic memory through the CLI and reloads
it. A pending candidate remains pending during search; checked task context is
unchanged by local filters and is cleared when switching projects.

Lesson confirmation uses a wrapping native checkbox with its complete accessible
text, native indicator and Space/click behavior. Geometry checks require the full
caption height at every supported size/language; compact Vietnamese renders now
show the complete privacy phrase. The source/lesson policy/status, settings notes,
proposal actions and SDK instructions have missing UI translations filled in.
User names, summaries, paths and literal commands remain verbatim. Agent Context
has explicit no-match/no-allowed/unavailable scope states; changing classification
cannot silently expose private records. Search and source/lesson/Agent interaction
checks pass at all four simulated DPI levels and on native Windows (five results
per profile, no failures/skips). That Knowledge stage passed CTest 4/4 with 30
desktop results; malformed/denied/wrong-scope/cancelled/timed-out/oversized source responses
and stale context/proposal guards remain covered.

Component details now implement the selected design's Summary/Related work
switch, with declared binding count and explicit Unknown observed versions.
Related work filters to actual linked work, clears hidden selections and shows
a useful empty state. Back restores the selected component and mode. Inspector
titles, review badges and prominent version actions remain outside the scrolling
details body; the inspector never loses the visible identity of the edited record.
Real interaction checks cover linked work/Back, empty work, keyboard mode change,
truthful facts and non-mutating scrolling at all three sizes/both languages.

Sidebar navigation now coalesces a post-layout visibility update after page and
viewport changes. It scrolls only the navigation body to reveal the selected row;
Library reveals its own global entry. Actual full-row geometry and keyboard
navigation checks cover all eight project pages, Library return and all three
sizes/both languages. The component/navigation/related-record/inspector subset
passes at all four simulated DPI levels and on native Windows (six results each,
no failures/skips). That component/navigation stage had 32 passing desktop results. The current
review process 63288 retains its older package and unsaved document unchanged.

The fitted topology canvas now preserves readable identifying text at compact
zoom without changing device positions or the graph. Secondary metadata is
available in the selected-device panel; full labels/IDs/sites stay in the tooltip.
Protocol labels ignore view scaling and remain centered over their declared
connection as zoom changes. Node types, directed endpoints, typed edits and
undoable dragging remain unchanged and verified.

The control audit found and fixed selected-row reopening: selection-change alone
was insufficient after closing details or returning to a page. Inventory and
Board clicks now reopen the same selected record without redundant refresh for
an already-visible inspector. Real mouse checks use the visible row intersection
and re-observe after layout changes, preserving the document. Work List/Board,
milestone acceptance, approved-release creation and both graph toolbars remain
reachable at all three sizes in both languages. The workflow/graph/filter/
acceptance/release/evidence/drag subset passes at all four simulated DPI levels
and on native Windows (nine results each, no failures/skips). That workflow/graph stage passed CTest
4/4 with 33 desktop results. The final page/control/export stage passes 4/4
with 34 desktop results, no failures/skips.

`scripts/render-design.ps1` captures disposable synthetic native fixtures;
`scripts/write-design-review.ps1` refuses incomplete or stale package results.
The development package is `build/studio-design`. The older open `studio-design-review`
window and real user project/memory data remain untouched.

All 26 page requirements are now independently verified against the selected
visual direction and actual typed workflows. Final page/control/export checks
cover References, Task context, Agent Context/Review and Settings, including
non-mutating tab changes, disabled unloaded-source export, retained/cancelled
settings drafts, clean proposal actions and exact file-dialog export. They pass
at four simulated DPI levels and native Windows (seven results per profile).
The current 676 captures cover all 26 pages, three logical sizes, both languages,
four simulated DPI levels and native Windows. Every result matches the current
binary hash, successful exit, existing PNG, Segoe UI and measured DPR dimensions.
No image is substituted for a behavior check. Translation keeps authored metadata
verbatim. Technical domain errors and literal SDK commands may remain English.

Final handoff: `build/studio-design-20261012-ee28c7de` is installed with the
current binary hash. `scripts/start-studio-design-review.ps1` and its double-click
CMD wrapper use isolated `review-data` and a synthetic demo, without granting
lesson review. Current process 45676 opened successfully; older unsaved process
63288 remains unchanged. The normal launcher still selects `build/studio-design`
and its existing user data directory. All three gallery URLs return HTTP 200.
Manual operator visual preference and clean-machine distribution are separate
acceptance activities; neither is inferred from passing automated checks.

## Architectural rationale and risks

A shared theme and reusable Qt view helpers reduce repeated layout work and keep
screen-level presentation replaceable. Settings is separate from document/storage
ownership. More pages must not trigger new memory scans, source grants or runtime
framework changes. Full document refresh and large native tables remain possible
main-thread costs; existing limits must be measured again after meaningful changes.

Current package for development is `build/studio-design`, separate from the open
`studio-design-review` process. Do not overwrite/terminate older windows or unsaved documents.
No actual user project/memory is used for render fixtures. No new dependency,
publication, push or external message is required for this implementation.

Before publishing, verify ignored secrets/database/WAL/SHM paths and run
`lmti publish preflight`. No publish was performed.
