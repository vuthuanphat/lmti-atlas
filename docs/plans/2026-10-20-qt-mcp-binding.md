# STRUCT-01 increment 8 — Qt MCP review and writer lifetime

Cập nhật 20/10: MCP Qt đã giữ cố định dự án/cấu hình được xem trước, kiểm tra
lại trước thao tác và giữ tiến trình ghi khi đóng hộp thoại. Phản hồi thiếu hoặc
sai không được coi là ghi thành công; review trạng thái hiện tại không tự ghi lại.
Build Release đạt; **21/21 native/Qt đạt trong 207.38 giây**. Suite MCP mới
đạt **45/45** (43 ca hành vi + khởi tạo/kết thúc), không skip.
Chín kiểm tra Qt mới ↔ API bridge-r2 đạt trên fixture; đây là kiểm thử kết hợp
với package cũ, chưa phải package MVP tích hợp mới. UI activation/recovery,
mapping/import và Agent proposal handoff vẫn còn trong phạm vi build.

## Binding and effect boundaries

The desktop passes its trusted library path and saved native document into an
immutable MCP review. Material selection changes increment a local epoch;
native owner reads compare library identity, full project state and profile.
Library v2/v3 cosmetics remain compatible; v1 uses its conservative full token.
Remote-only editing/export needs no local runtime. Registered rootless projects
support export/Check, and offline linked roots still permit independent export.
Export creates a new file exclusively and reports incomplete writes explicitly.

Apply/restore jobs belong to the panel, outlive setup closure and withhold normal
window/application quit until the writer exits. A timeout or output overflow does
not kill or replay a writer. Exact action-specific acknowledgments classify known
success before advisory freshness checks. Unknown results require inspection.
Restore remains fixed to the original reviewed root, with a new recovery token.

An explicit current-configuration review handles an unconfirmed APPLY with no
protected recovery: strict inspect, fresh preview and second inspect, with source
rechecks, establish only a reviewable current state. The old modal closes and a
separate setup must obtain a new preview before Apply. The prior result remains
unconfirmed. Unknown restore or changed/unavailable source stays gated.

## Validation and limits

Release build, focused MCP 2/2 and full native/Qt 21/21 passed. The new Qt suite
passed 45 rows in 60.679s. Independent production/test review found
no remaining concrete blocker. The first run's five failures were an ABA fixture
using another project's unique folder; a third unassigned folder corrected the
fixture. Failed logs remain retained; production uniqueness was unchanged.

Nine coordinated checks used the current Qt probe with immutable bridge-r2 API,
native/config owners and verified Qt runtime components. They cover identical
exports, cross-UI apply/restore, stale revisions and project isolation. This is
hybrid compatibility evidence, not new-package or live-client acceptance.
Current web API 50/50 remains the separate increment-7 evidence, not rerun here.

Preflight reads are not a cross-store transaction; forced termination still needs
owner journal recovery. Qt Check remains the existing four-tool contract.
Operator copy/activation/reconciliation, hierarchy authoring/reviewed mapping,
Agent proposal handoff and integrated packaging remain open. Controlled replay
comes first; live provider/device, independent operator and clean Windows follow
the completed build. Private config and fixtures must stay in .gitignore before
any repository push.

Evidence: task output LMTI_Kiem_chung_MCP_Qt_2026-10-20.json, with source/binary/log
hashes, scoped interoperability checks and retained initial failure.
