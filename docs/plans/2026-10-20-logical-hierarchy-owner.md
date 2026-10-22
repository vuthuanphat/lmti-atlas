# STRUCT-01 increment 13 — reviewed logical hierarchy owner

Cập nhật 20/10: đã triển khai domain và owner native cho năm thao tác phân cấp
logic: thêm/đổi tên/di chuyển subsystem, đổi membership component và nghỉ dùng
subsystem rỗng. Bản review giữ snapshot, scope, UUID kho và registry riêng;
commit kiểm tra lại rồi ghi graph, lịch sử ID và một revision trong cùng transaction.
Quyền kế thừa cả tổ tiên và repository liên kết; di chuyển không được giảm
classification. ID đã nghỉ dùng không thể tái sử dụng, kể cả sau clone.

Build Release đạt; **26/26 suite native/Qt đạt trong 217.21 giây**,
**5/5 suite tập trung đạt**. Hai bộ mới có **128 kiểm tra domain** và
**13 ca SQLite với 163 kiểm tra**, không lỗi/skip. Suite discovery cũ còn
**2 ca symlink skip có điều kiện**, ghi riêng trong bằng chứng.
Rollback trước commit, mất phản hồi giả lập sau COMMIT thật, xung đột revision/
UUID/registry và quyền repository đều được kiểm tra.

Đây là owner native dùng review trong cùng process; chưa có cổng CLI/HTTP hay
editor hierarchy mới. Bước tiếp theo nối token review qua process, quyền launcher,
broker và UI; phân cấp vật lý, mapping/import và Agent handoff vẫn còn trong kế
hoạch. Gói thao tác dự án trước đó được giữ nguyên, không coi là đã chứa increment này.

## Contract and privacy

The pure typed batch contains 1–32 operations. Expected values refer to the
original snapshot; references and empty-retirement checks use the final draft,
including IDs added in that batch. Same-target conflicting operations and pure
no-ops are refused. Unrelated project fields and stored classifications stay
unchanged. Native revision and the private lineage remain storage responsibilities.

The diff includes affected subsystem/component identities, complete old/new
ancestor paths and effective classification. Visibility covers affected
descendants and linked repository privacy before disclosure; missing/denied
references use bounded errors. Effective Internal-to-Public moves are refused.
The private registry enforces no reuse, including history preserved by clone.

## Transaction and review lifetime

Preview normalizes bounded input before filesystem access and captures one
consistent schema-2 graph/registry snapshot. The review's immutable data pins
scope, canonical store, UUID, revision, graph/registry digests, normalized batch
and exact diff. Copies share atomic consumption state.

Commit opens an existing regular local single-link store, holds BEGIN IMMEDIATE,
recaptures and compares identity, reapplies domain policy, then writes graph,
registry and revision using the same connection. The ordinary-save row writer
was factored without changing statement order. Review consumption starts before
DML; known rollback consumes it too. COMMIT ambiguity returns Unknown without
replay. Known success is prepared before COMMIT; no reload can demote it.

Test-only fault hooks occur after actual graph/registry DML and after actual
COMMIT. The generated production storage/core targets do not define the hook
macro. This is injected owner-response loss, not a real killed-process trial.

## Follow-on integration

This process-local C++ review is a prerequisite, not the finished operator flow.
Cross-process review needs a versioned private token and strict owner restoration
of the full identity/proposal/scope. The existing broker must retain it behind
opaque bounded one-use handles, coordinate writes and reconcile unknown results.
No path, UUID or private digest belongs in browser DTOs or untrusted proposals.

Next work remains private facade/launcher/broker/UI integration, physical
hierarchy authoring, reviewed mapping/import and Agent proposal handoff. Source
and workload acceptance precede real-device/provider/operator/clean-Windows gates.
The earlier operation package remains sealed. No dependency install, network
provider/model/device call, push or publish occurred. Verify private config,
fixture and secret exclusions in .gitignore before any future push.
