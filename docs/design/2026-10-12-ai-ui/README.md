# LMTI — AI interface design review

Date: 2026-10-12. Status: selected visual references; native local-alpha implementation verified.

The operator requested Image AI designs before further interface implementation.
The selected visual direction is tracked by the implementation matrix. Built-in
`image_gen` creates one individual image per page from the stored prompt set.
All metadata is synthetic. No real project files, memory, credentials or paths
are sent to the generator.

## Coverage

26 images cover Library, Overview, Software (3), Hardware (3), Architecture (2),
Work (List/Board/Milestones), Releases/Evidence, Knowledge (5), Agent (3),
Project settings and two representative create/edit forms.

The shared system uses a compact navy sidebar, light content surfaces, one page
primary action and readable inventories with details on demand. The Knowledge
tabs and dedicated settings page propose a clearer information architecture;
the current Qt implementation follows these routes.

## Review

Review the shell and primary workflow first: Library → Overview → Software →
Releases → Work. Then review secondary pages, Knowledge/Agent and forms. Choose
the visual direction before converting images into deterministic widgets,
design tokens, interaction specifications, translations and accessibility rules.

Generated text, counts and geometry are illustrative and must be reconciled with
the typed domain and real source boundaries. Approval never implies installation;
desired bindings never imply observed software; lessons never auto-approve.

Open the [local gallery](index.html) to review all 26 individual screens. Click an
image for its full-resolution PNG. The generator used the built-in tool, not the
CLI/API fallback; no API key was configured for this work.

The [runtime comparison gallery](runtime-review.html) pairs the AI concepts with
26 screenshots from the current native package. It separates operator visual acceptance from the documented native interaction checks; capture success alone is not a behavior test.
The [Vietnamese comparison](runtime-review-vi.html) captures the same 26 pages.
Synthetic record names/content remain unchanged when the UI language changes.

Initial briefs are in [prompts.json](prompts.json). [manifest.json](manifest.json)
records exact generation prompts, targeted correction prompts and the selected
filename for each screen. Ten screens have a non-destructive `-v2` correction;
their earlier draft PNGs remain alongside them. The Overview's first draft remains
in the generator output archive; its selected edited output is saved here.

## Selected images

- [Overview](01-overview.png)
- [Project library](02-project-library-v2.png)
- [Software · Components](03-software-components.png)
- [Software · Repositories](04-software-repositories.png)
- [Software · Dependencies](05-software-dependencies-v2.png)
- [Hardware · Devices](06-hardware-devices.png)
- [Hardware · Targets](07-hardware-targets-v2.png)
- [Hardware · Software bindings](08-software-bindings-v2.png)
- [Architecture · Device topology](09-architecture-topology.png)
- [Architecture · Software relationships](10-architecture-relationships.png)
- [Work · List](11-work-list.png)
- [Work · Board](12-work-board.png)
- [Work · Milestones](13-milestones.png)
- [Releases · Versions](14-releases.png)
- [Releases · Evidence](15-release-evidence.png)
- [Knowledge · References](16-knowledge-references-v2.png)
- [Knowledge · Project map](17-knowledge-project-map-v2.png)
- [Knowledge · Memory](18-knowledge-memory-v2.png)
- [Knowledge · Lessons](19-knowledge-lessons.png)
- [Knowledge · Task context](20-knowledge-task-context.png)
- [Agent · Context](21-agent-context.png)
- [Agent · Review](22-agent-review-v2.png)
- [Agent · Setup](23-agent-setup-v2.png)
- [Project settings](24-project-settings-v2.png)
- [Create project](25-create-project.png)
- [Edit work · Validation state](26-edit-work-validation.png)

## Source constraints for implementation

Images establish visual direction, not new schema or grants. Additional sample
descriptions, dates, record counts, kinds, visibility labels and menus invented by
the model are illustrative, and must be reconciled with the typed domain. The
gallery lists relevant review notes beside each screen.

- Local availability uses a neutral badge and never certifies health.
- Observed versions stay Unknown without a supported source.
- Dependency edges connect components; bindings connect components to devices.
- Project map and Memory remain read-only through the existing policy adapter.
- Reference metadata never grants source access; external context is checked
  independently from local summary display.
- Lessons require explicit review capability and evidence/privacy confirmation.
- Agent proposals change work state only, against a clean matching saved revision;
  they do not edit descriptions, checklists or related documents.
- SDK/MCP transport, version claims and connection state need actual runtime
  evidence; setup documentation does not prove a client is connected.
- Apply edits a draft; Save persists it. Metadata visibility is not multi-user
  authentication or OS filesystem protection.

English designs are the initial visual baseline. Vietnamese text, narrow windows,
DPI, focus behavior and empty/loading/error/missing/conflict states must be
specified and reviewed before implementation. The two form concepts illustrate
creation and retained invalid draft input; they are not every domain form or state.

The images were generated without real project/memory data. Subsequent UI source
changes are partial and remain pending verification in the
[implementation matrix](../../plans/2026-10-12-design-implementation.md); they do
not prove that the running app matches these images. This gallery remains the
design review artifact. No publish/push was performed.
