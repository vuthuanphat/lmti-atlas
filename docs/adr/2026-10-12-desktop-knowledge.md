# Desktop knowledge source boundary

Date: 2026-10-12. Status: accepted local implementation for the requested UI plan.

The Qt desktop retains the native project model, validator, history and SQLite
writer. Knowledge is a separate source connection, selected deliberately by the
local operator. It does not dereference KnowledgeRef values, inherit a library
folder grant or equate a native project ID with an AMF project name.

`KnowledgePanel` calls a trusted, explicitly configured Node executable and built
TypeScript CLI through QProcess. There is no shell, command construction from
metadata, network request, device operation or dependency installation. Arguments
are fixed to `index.js desktop-bridge`; a request of at most 16 KiB is on stdin.
NODE_OPTIONS/NODE_PATH are removed from the child environment. Node 24 is the
verified runtime. It is a trusted same-user process, not an OS sandbox.

`lmti.desktop.knowledge.v1` carries operation, native project ID, selected source
root, expected source identity and the fixed external-context target. Operations
are snapshot/context/approve/reject. The canonical source root and compiled AMF
project name identify the source independently; AMF root must match the selected
root. Subsequent operations retain that identity. Switching native projects
removes the connection. Changing the document invalidates pending reads and
exports. Language changes retain the validated data and task input.

All source files and existing SQLite sidecars must resolve inside the source.
AMF is limited to 2 MiB, memory DB/WAL to 128 MiB, SHM to 16 MiB. Missing AMF,
wrong root, malformed input, unknown versions and escaping paths are denied.
The bridge never compiles, initializes, migrates, scans source or reads raw files
referenced by AMF. AMF entries require explicit public classification; entries
without one are omitted. Map categories are modules/files/architecture/rules/
summaries. Source compilation time and fetch time are displayed independently.

The existing TypeScript memory owner supplies a new read-only snapshot API.
It opens only an existing schema-v4 store, uses a read-only connection and a
query-only transaction, and does not update access times, expire records, migrate
schemas or append audit/retrieval events. SQLite may maintain its normal reader
locks/SHM; read-only means no logical memory/schema mutation. Output uses the
existing safe-mode privacy gate and summaries. Unknown classification/lifecycle,
secret/do_not_prompt, expired/inactive records and unapproved lesson memory are
excluded. Pending/rejected lesson summaries appear only in the local review view,
never in copied/exported task context. The envelope is for the trusted local UI;
its context field is the separately checked external-model payload.

Task context is read-only and bounded, with optional read-only routing through
the existing skill registry. A recommendation never executes a skill or test.
Only explicit Copy/Export exports the checked context, which omits source roots,
raw memory and lesson candidates. Results cap at 200 per category and 2 MiB total,
mark truncation, and have a ten-second deadline plus cancellation. Desktop rejects
wrong project/source/target/schema and invalid records before displaying anything.
Technical JSON is collapsed by default. Errors/stderr never expose raw source
content. The bounded native metadata scanner is reused in overlapping windows
for larger output; its original 512-byte domain guard is unchanged.

Lesson writes require the trusted launcher's separate review capability, an
explicit evidence/privacy checkbox and a pending candidate fingerprint. The
memory owner checks status, privacy, fingerprint, confidence and substantive
evidence inside BEGIN IMMEDIATE, inserts approved memory and its audit event,
updates candidate status and commits together. Reject also uses that transaction.
No schema upgrade or automatic approval is allowed. Suggested verification and
last verification remain visible; approval does not claim test execution. If a
write is cancelled or fails to return a response, reload the source to inspect
its actual state; a completed commit can precede cancellation.

Native topology/project formats and TS/Go memory formats remain independent.
The default launcher has lesson review disabled. Real Agent authorization,
encrypted storage, source identity recovery after moving folders, multi-user
RBAC and clean-machine distribution remain separate gates. A source move or
AMF rename needs a new explicit connection; no silent rebind occurs.
