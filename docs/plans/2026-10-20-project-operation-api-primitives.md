# STRUCT-01 increment 11 — private API/native primitives

Cập nhật 20/10: đã build lớp nối riêng giữa API và cổng native, phân biệt
chưa khởi chạy với kết quả ghi chưa xác định, giữ tiến trình ghi đến khi đóng
hẳn và kiểm tra phản hồi theo đúng thao tác đã duyệt. Helper Windows từ chối
yêu cầu nhận quyền khi broker cũ hoặc tiến trình con còn sống; nhận lại quyền vẫn phải đọc
đối chiếu trạng thái. Đã sửa lỗi UUID rỗng schema 1 bị chuyển thành SQL NULL khi
chuẩn bị kích hoạt và thêm kiểm thử migration/clone qua cổng tiến trình thật.

**84/84 kiểm thử API**, **34/34 ca tập trung**, **16/16 kiểm thử helper Windows**
và **24/24 suite native/Qt đạt** (193.16 giây); discovery còn
2 ca symlink skip có điều kiện. Đây là các thành phần riêng đã kiểm chứng;
quyền launcher, điều phối ghi/phục hồi trong service và giao diện review vẫn
phải nối tiếp. Chưa có package MVP tích hợp mới hoặc nghiệm thu thiết bị thật.

## Implemented and verified

ProcessPool retains a writing child through close after stream/process errors
or overflow. Excess output drains without retention; no timeout kill or retry
is added to writes. No-start remains a known refusal; unreliable started legacy
transport raises RECOVERY_REQUIRED and is nonretryable at HTTP.

ProjectOperationOwner freezes config and requests, validates all nine private
reads and six writes, bounds stdin/stdout, checks UTF-8/duplicate keys/exact
fields/final LF and correlates acknowledgments with unchanged reviewed tokens.
Its default verifier has a separate slot, preventing a queued write guard from
deadlocking its own main pool. Known minimal confirmed fallback stays confirmed.
Full terminal activation receipts still need service comparison against the
retained reviewed immutable fields; a token alone cannot reconstruct them.

The Windows helper uses fixed bounded coordination files, an exclusive startup
file lock, parent PID/creation identity and a complete bounded direct-child scan.
It never kills writers or queries command lines, images or environment.
BrokerRestartGuard fences queued and late claim replies on shutdown. A claim
does not reconcile native outcome or enable a browser operation by itself.

The integration test exposed a real native migration parser defect: schema1
storeUuid was validated as empty but left as null QString, then bound as SQL
NULL into a NOT NULL activation receipt column. Explicit empty QString fixes
the representation; native CAS, input validation and unknown outcomes are
unchanged. The process lifecycle matrix covers migration/clone and nullable roots.

## Integration work still required

Wire fixed packaged launcher capabilities and one scope coordinator across
every mutating route. Add bounded session-scoped opaque previews/recovery
handles, shared/exclusive reservations, explicit unknown jobs, read-only
reconciliation and graceful HTTP/job/owner drain. Update UI consumers before
changing public job shapes; expose reviewed operations only after these gates.

First enrollment covers participating brokers only; drain known older runtimes
or use a fresh controlled scope. A reused scope requires reconciliation before
a deliberate fresh review, never automatic replay. Same-PID helper repeat is
intentional, so multiple API instances in one Node process must share the scope
coordinator or refuse duplicate enrollment.

Hierarchy mapping/import, Agent proposal handoff, integrated packaging and
bounded workload checks remain. Live devices/providers, remaining clients,
second operator and clean Windows are post-build acceptance. Component tests
do not satisfy those gates.

## Evidence and local-state hygiene

Task output LMTI_Kiem_chung_lop_API_native_2026-10-20.json records exact source,
runtime and log hashes, complete pass counts, conditional skips, initial failed
runs and corrections. No new dependencies were installed. Local broker marker,
lock and temporary files are now ignored by Git; existing secret/config ignores
remain. Check .gitignore before any future push.
