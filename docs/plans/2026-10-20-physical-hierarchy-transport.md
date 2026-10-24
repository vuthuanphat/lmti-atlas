# Physical hierarchy native facade and conditional original reads

## STRUCT-01 increment 23 — cổng native phân cấp vật lý

Đã nối 11 thao tác vật lý qua cổng tiến trình có đầu vào cố định, quyền theo dự án,
xem sai khác rồi xác nhận ghi. Phản hồi phân biệt rõ từ chối trước khi ghi, kết quả
chưa xác định sau khi bắt đầu và ghi đã xác nhận. Đọc phục hồi có điều kiện kiểm tra
đúng tệp gốc, thư viện, UUID và liên kết đã chọn; không chuyển sang tệp thay thế.

Build native đạt; kiểm thử tập trung **10/10**, hồi quy toàn bộ **34/34 suite CTest**
đạt (360.56 giây). Suite giao tiếp có 10 ca / 2450 kiểm tra;
suite đọc đích gốc có 8 ca / 186 kiểm tra. Cả hai không lỗi,
không skip. Các skip nội bộ của suite cũ được liệt kê trong JSON; không suite CTest
nào bị bỏ qua.

Lượt tập trung đầu tiên đạt 9/10, phát hiện nhãn có Unicode surrogate không hợp lệ
bị nhận rồi mất ký tự khi chuyển mã. Tái hiện độc lập chỉ đọc xác nhận lỗi, các file
thử không thay đổi. Bản r2 kiểm tra UTF-16 hợp lệ trước chuyển mã; thêm ca từ chối
surrogate cao/thấp/đảo thứ tự và giữ nguyên cặp Unicode hợp lệ. Log lỗi ban đầu
và hai checkpoint áp dụng đều được giữ lại.

Kiểm thử tiến trình thật bao phủ cả 11 thao tác, token/quyền sai, thay đổi thư viện,
dữ liệu Unicode, khung JSON sai, giới hạn byte, rollback và mất phản hồi sau COMMIT.
Cây thử độ sâu 32 với 16 asset đi qua đọc/xem/ghi; cây 2.000 asset hợp lệ ở owner
được từ chối đầy đủ khi phản hồi vượt giới hạn. Không trả cây bị cắt thiếu.
Các điểm gây lỗi chỉ nằm trong executable kiểm thử; đây không phải nghiệm thu
crash hệ điều hành hay giao dịch nguyên tử giữa nhiều store.

API/quyền/phục hồi chung cho vật lý đang được triển khai; chưa build hoặc nghiệm thu
API/UI cho phần này. Chưa đóng gói phát hành mới. Bằng chứng API 321/321 và UI 55/55
thuộc increment 21; browser thực vẫn chưa nghiệm thu. Mapping/import, nguồn thiết bị
thật và máy Windows sạch vẫn còn mở; toàn bộ MVP chưa hoàn tất.

## Contract and evidence

- Fixed physical read/write entrypoints take trusted library, granted project and visibility only. No caller path or profiles parameter selects a physical read.
- Strict complete UTF-8/JSON input at64 KiB and complete output at512 KiB; all11 closed variants, full typed paths, privacy classification and native review digests retained.
- Preview checks the complete future commit frame. Write ACK is exactly seven keys, with latched confirmed fallback; native operationId is null.
- Original library-only locator is checked before opening the pinned project. Same-connection snapshot checks schema/project/store identity under retained original namespace leases; final locator/root and sidecars are checked again.
- Static fixture corrections before the first build: actual SQLite table names, fresh project identity setup, legal identifier length, C++ declaration typing and explicit invalid byte construction. No product correction or runtime failure is inferred from these static edits.
- Separate runtime defect: initial focused10 had one failed suite (9/10 cases,2443 checks,two assertions). A single read-only shipped preview reproduced unpaired escaped surrogate loss while project/library/profile hashes stayed unchanged. Repair r2 validates QString UTF-16 before UTF-8 conversion, with high/low/reversed refusal and exact valid-pair preservation. Original failed evidence is retained.
- 123 native inputs and 42 executables fingerprinted consistently across all three verification phases.

## Representative complete-frame results

- `Physical workload accepted: assets=16; depth=32; stateBytes=72920; responseBytes=133304; commitBytes=1306.`
- `Physical workload refused: assets=2000; depth=32; affected=2032; emittedStateBytes=38; emittedResponseBytes=38; no partial review.`

## Internal conditional skips

- `SKIP: local directory symlink creation unavailable/denied.`
- `SKIP: local intent symlink creation unavailable/denied.`
- `SKIP: local file symlink creation unavailable/denied.`
- `SKIP: local project file symlink creation unavailable/denied.`

## Limits

- Native fixed process facade and conditional original-state only; staged physical API/recovery is not applied or verified by this increment.
- No physical UI, API tests, browser interaction, new package, clean-Windows or real-provider/device acceptance here.
- Faults are deterministic exceptions in isolated test binaries, including after actual COMMIT; no OS crash/restart or exactly-once outcome receipt claim.
- Complete native input/reply caps remain authoritative; maximum model counts need not fit an editor response.
- Original reads retain existing Windows ordinary local-file/cooperative-owner assumptions and fail closed for unsupported identity/provenance.
- Historical UI/browser and package limits remain; prior packages do not contain this increment.
