# STRUCT-01 increment 10 — private native writes and read-only recovery

Cập nhật 20/10: cổng native đã hỗ trợ sao chép, hai bước nâng định dạng
thư viện và chuẩn bị/kích hoạt/hủy yêu cầu kích hoạt đang chờ. Mỗi thao tác dùng bản xem
trước hoặc receipt cụ thể; kết quả phân biệt từ chối trước khi ghi, xác nhận hoàn
tất và chưa xác định. Khi phản hồi bị mất hoặc lỗi sau commit, chỉ đọc trạng thái
để phục hồi; không tự ghi lại. Hủy thao tác đang chờ chỉ cần thư viện, không cần
nguồn hay thư mục bản sao còn truy cập được.
Build Release đạt; **24/24 native/Qt đạt trong 206.14 giây**, cùng **7/7 suite
tập trung**. Cổng này dành cho tiến trình vận hành nội bộ; broker, quyền launcher
và giao diện review/phục hồi vẫn cần nối tiếp. Đây là bằng chứng source build,
chưa phải package MVP tích hợp mới hoặc nghiệm thu thiết bị thật.

## Implemented boundary

The private admin adds --project-operation-write with exactly the launcher-owned
library, copy parent and backup parent. Input remains one strict UTF-8 JSON
object up to 32 KiB; output is one compact frame up to 512 KiB including LF.
Both standard streams are binary on Windows. The existing profile mode and
separate read-only mode retain their dispatch and authority boundaries.

Six writes are supported: copy-prepare, library-upgrade-v1, library-upgrade-v2,
activation-prepare, activation-activate and activation-abandon. Source selection
comes from the native library; payload paths are checked identity values. The
existing domain owners remain responsible for copying, typed backups, held
reservations and CAS. Copy does not change the library binding.

Read additions provide explicit format previews/status, activation candidates
and receipt inspection. Durable metadata comes from native owners. Terminal
receipt history does not need project or copy files; readiness for a prepared
receipt is advisory. Abandon performs only library/history preflight and passes
the unchanged exact token to the owner.

Every private write response has the seven-key schema documented in
[project operations](../project-operations.md). Refused is possible only before
entering the mutating owner. An exception or recovery status after entry is
unknown. Known completion is latched before allocating/serializing the response;
prebuilt minimal confirmed/unknown frames preserve that outcome if details
cannot be encoded. A receiver that loses the frame still has an unknown result.
No automatic retry, cleanup, rollback or newest-candidate inference is added.

## Verification and limits

The focused run exercises real process writes/recovery, existing copy/library
owners, read-only facade and MCP compatibility. The full native/Qt run covers
24 suites. A separate non-installed executable enables existing owner fault
points plus facade-only response faults; production omits those controls.
Detailed executed cases, conditional skips and any initial failures are retained
in task output LMTI_Kiem_chung_cong_ghi_2026-10-20.json.

The native gateway is private operator IPC, not an Agent grant or public HTTP
API. The next increment must enforce launcher project/maintenance capabilities,
one-use previews, write lifetime and unknown-outcome recovery in the broker,
then expose the existing UI review flow. Mapping/import, proposal handoff,
integrated packaging and bounded workload verification remain required.
Live providers/devices, remaining actual clients, another operator and clean
Windows are post-build acceptance. No such evidence is claimed by this run.
Private configuration and fixtures must be covered by .gitignore before push.
