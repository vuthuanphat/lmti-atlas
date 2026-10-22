# Increment 20 — hierarchy backend integration

Cập nhật 20/10, STRUCT-01 increment 20: backend phân cấp đã nối quyền
launcher rõ ràng, state/preview/reject/commit qua native, kiểm tra đúng đích gốc
trước ghi và phục hồi chung trên toàn bộ tập đích chưa rõ kết quả. Catalog mới
chỉ đọc vị trí gốc; không phụ thuộc profile hay dùng canonicalPath làm đường mở file.

Native tập trung 8/8
và toàn bộ 30/30 suite đạt
(318.10s); suite mới có 8 ca/127 kiểm tra.
Bốn dòng skip nội bộ về tạo symlink của suite cũ được giữ trong JSON; không suite
CTest nào bị bỏ qua. API tập trung
149/149 và toàn bộ 305/305
đạt, không fail/cancel/skip/todo. Ca HTTP dùng ghi native thật, một ca cố ý làm hỏng
ACK đã nhận sau khi child đóng rồi dựng lại broker trong cùng tiến trình.
Đó không phải thử restart hệ điều hành hay crash broker thật.

Lần build native đầu thất bại vì enum Privacy::Private trong kiểm thử; sửa fixture
và kỳ vọng kế thừa về Internal/Public, không đổi mã sản phẩm. Không có gói phát hành/UI editor mới; decoder
UI cho hierarchyItems còn phải làm. Không coi nhiều store là giao dịch nguyên tử,
không tự thử lại lệnh ghi và không đổi lịch sử unknown thành confirmed qua phục hồi.
Nghiệm thu thiết bị/provider thật, người vận hành thứ hai và Windows sạch còn mở.

## Implemented boundary

Explicit logicalHierarchy grants are unique subsets of allowedProjects. Public
and internal scope are separate. Absent capability preserves the old recovery
domain hash. Main/verification pools and the existing coordinator remain shared;
no new domain database or independent recovery acknowledgment exists.

The original-target subject records immutable physical provenance and bounded
historical snapshot digests, without a replayable proposal. Selected catalog
token equality precedes following the raw project locator. Conditional reads
retain Windows namespace leases through typed project/registry projection,
verify the selected row and original UUID, and accept fresh revisions only for
recovery. A live WAL fixture proves committed rows through the reader while its
keeper is open; this is not a WAL-file byte-immutability or hostile-edit guarantee.

Reviews are session/grant/epoch scoped and consumed at admission. Durable marker
publication is awaited before dispatch; queued guards use the dedicated verifier.
Pending writes remain live through child close and service/session cleanup.
Known successful acknowledgments are latched before fallible refresh; malformed
started acknowledgments remain unknown. The common collector authorizes the full
retained target union before observations, then requires a separate acknowledgment.
Recovery never attributes or retries a historical write.

Input 64 KiB, complete native LF response 512 KiB and complete public HTTP envelope
256 KiB are separate caps. Oversize results are refused, not partial trees.
The unchanged four-field write-status response remains compatible with the old UI.
New hierarchy routes and opt-in hierarchyItems recovery DTO need a subsequent UI.
The common collector checks operation evidence too, but the current generic
presentation has legacy/hierarchy summaries only; the next UI must explain that
full recovery scope without implying that omitted operation rows were unexamined.

## Verification limits

Focused helper/service tests include synthetic typed responses; their lifecycle
models are not child-process or OS-restart proof. Actual HTTP cases use current
native processes for save/readback and deliberately corrupt a received ACK only
after confirmed child close. The subsequent API recreation is same-process.
PowerShell negative-launch tests prove authority refusal before configured paths.
All raw attempts, including the initial test-only native compiler failure, remain.

This workstation runtime is built from current binaries plus installed Qt/system
dependencies. Historical packages and ZIP are preserved only over their recorded
manifest/listed-member scope, not promoted to a new integration package. Loopback
HTTP is used; no external provider/model/device acceptance is claimed.
Namespace leases do not make a multi-store atomic snapshot, prevent hostile
in-place byte modification or make a later write atomic with a preceding read.
Full physical hierarchy authoring, mapping/import, hierarchy UI, new packaging,
live-provider and second-operator/clean-machine gates remain open.
