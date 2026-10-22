# STRUCT-01 increment 14 — private hierarchy transport

Cập nhật 20/10: cổng native riêng đã có đọc trạng thái, xem trước và commit
phân cấp logic qua các tiến trình khác nhau. Token giữ nguyên snapshot/scope và
được kiểm tra lại đầy đủ; quyền từ argv tin cậy, đường dẫn từ thư viện đã chọn.
Thư viện, dự án và các sidecar được kiểm tra đường dẫn; cổng hierarchy từ chối
hardlink thư viện. Kết quả phân biệt refused/confirmed/unknown, không tự gửi lại.

Build Release đạt; **27/27 suite native/Qt đạt trong 372.82 giây**,
**6/6 suite tập trung đạt**. Bộ transport mới có **11 ca, 503 kiểm tra**,
không lỗi/skip; discovery cũ còn **2 ca symlink skip có điều kiện**.
Các kiểm tra owner/domain trước vẫn đạt. Fault được chèn trước/sau COMMIT thật,
không được gọi là thử nghiệm kill process.

Đã đo cây hợp lệ sâu 32: 104 component lá trả
trọn 522,935 byte và commit thành công;
105 lá cần 527,284
byte nên bị từ chối nguyên khối. Mẫu 2.000 lá cũng bị từ chối; phản hồi thực tế
chỉ 38 byte lỗi, không chứa token/diff
thiếu. Đây là giới hạn của một họ workload đã đo, không phải SLA hoặc cam kết
hỗ trợ mọi graph schema 2.

Chưa nối cổng này vào launcher/API/UI và chưa đóng gói lại. Tiếp theo hoàn thiện
lớp nối TypeScript, điều phối ghi/phục hồi, editor logic; phân cấp vật lý,
mapping/import và Agent handoff vẫn còn. Gói ZIP trước giữ nguyên.

## Original review and current state

The pure projection includes authorized subsystem/component rows, stored and
effective classification, original complete ancestor IDs and explicit nullable
membership. Repository and ancestor privacy are inherited before disclosure.
Hidden descendants are not promoted to roots.

The storage export validates its own versioned token; restoration validates
scope, schema, project, canonical key, UUID, revision, full graph/registry
digests, normalized proposal and complete diff digest. It retains original pins,
then the existing commit owner rechecks them under BEGIN IMMEDIATE. State is a
single consistent schema-2 read and remains available at the last valid revision.
The linked project root need not be online for native hierarchy edits.

## Wire and lifecycle

Fixed read/write modes accept library, project and public/internal visibility
from trusted launch arguments. Strict JSON input is bounded to 64 KiB/depth16;
the typed batch remains at most 32 changes/32 KiB. Every complete emitted preview
fits a subsequent commit request. Responses are bounded to 512 KiB including LF.
The registered library row, never a token path, chooses the project database.

Read failures expose only bounded codes. Commit uses the seven-field private
write envelope; native operationId is null because no durable operation receipt
exists. Full confirmed bytes and fallback frames are allocated before commit.
The confirmed result is latched before fallible follow-up. Started ambiguity
requires reconciliation, not a retry. Reading current state does not rewrite
the old operation's unknown outcome or prove its actor.

Only the isolated test admin reads the facade fault environment selector.
Production ignores it. This is verified in source, selected generated build
definitions and the actual process test. The separate owner test executable
also intentionally compiles its existing callback hook; it is not shipped.

## Remaining integration

Trusted launcher grants, immutable private TS codecs, session-bound opaque
reviews, coordinated writes and unknown recovery are required before browser
authoring. Physical hierarchy, mapping/import, Agent handoff, complete generated
MCP/package/browser checks and external operator/Windows/device gates remain.
The previous package is retained as historical evidence. Check .gitignore for
private configuration, fixtures and secrets before any future push.
