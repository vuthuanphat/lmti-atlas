# Reviewed physical hierarchy: native domain and SQLite owner

## STRUCT-01 increment 22 — physical hierarchy native owner

Đã thêm lõi C++ và owner SQLite cho 11 thao tác site/khu vực/môi trường/vị trí
thiết bị hiện có. Mỗi lô có tối đa 32 thay đổi, đối chiếu giá trị gốc, xem đủ
sai khác và các đối tượng bị ảnh hưởng trước khi ghi một lần. Site của asset
và toàn bộ dữ liệu ngoài phạm vi được giữ nguyên; bỏ vị trí không nghỉ hưu asset.
Quyền ghi vật lý tách riêng; không tự hạ dữ liệu Internal thành Public khi di chuyển.

Build native đạt; tập trung **8/8**, toàn bộ **32/32 suite CTest**
đạt (350.85 giây). Suite domain có 13 ca /
340 kiểm tra; owner có 11 ca /
210 kiểm tra, 0 skip.
Danh sách skip nội bộ và mọi lần chạy được giữ trong JSON bằng chứng;
không suite CTest nào bị bỏ qua.

Kiểm thử dùng SQLite thật trong thư mục tạm: xung đột revision dùng chung với
phân cấp logic, thay file cùng tên, dữ liệu WAL, lịch sử ID không tái sử dụng,
rollback khi có lỗi chèn giữa các câu lệnh ghi, lỗi trước COMMIT và mất phản hồi
sau COMMIT. Các điểm gây lỗi chỉ được biên dịch vào target kiểm thử.
Đây không phải bằng chứng crash tiến trình/hệ điều hành hay atomic nhiều store.

Phần này mới là native domain/owner. CLI có kiểm soát, API/quyền/phục hồi chung và
UI phân cấp vật lý là bước kế tiếp. Không chạy lại API/UI, không tạo gói phát hành
mới. Kết quả API 321/321 và UI 55/55 thuộc increment 21; nghiệm thu browser thực
vẫn còn mở. Mapping/import, provider/thiết bị thật và Windows sạch chưa nghiệm thu;
toàn bộ MVP chưa hoàn tất.

## Source and validation evidence

- Closed variants: AddSite, RenameSite, RetireEmptySite, AddArea, RenameArea, ReparentArea, RetireEmptyArea, AddEnvironment, RenameEnvironment, RetireEmptyEnvironment, SetAssetPlacement.
- Complete typed catalog projection preserves stored privacy separately from inherited classification; unused authorized catalogs are included. Environment membership is separate from containment.
- Original-value pins, stable complete affected paths, final-draft references/emptiness, shared revision, immutable review with process-local shared one-use consumption, registry/content/UUID/path pins and truthful Unknown are covered. Exported/restored tokens are original snapshot pins, not durable idempotency or outcome receipts.
- Pre-application review corrected hidden/missing desired-reference error ordering. Independent tests include stale expected rows with hidden or missing references. This draft issue was corrected before the tested source was applied.
- Machine-readable evidence: `LMTI_Kiem_chung_phan_cap_vat_ly_native_2026-10-20.json`; 119 native inputs and 40 executables fingerprinted through build/focused/full.
- Complete original logs and receipt hashes are retained; source review was separate from runtime verification.

## Internal conditional skips

- `SKIP: local directory symlink creation unavailable/denied.`
- `SKIP: local intent symlink creation unavailable/denied.`
- `SKIP: local file symlink creation unavailable/denied.`
- `SKIP: local project file symlink creation unavailable/denied.`

## Limits and next work

- Native domain/SQLite owner only; physical CLI, conditional original state, API/recovery and UI not yet implemented.
- Deterministic test-only exception injection between DML statements, before COMMIT and after actual COMMIT; no process crash or OS restart proof.
- Existing cooperative-owner/ordinary local-file assumptions remain; no hostile in-place editing or cross-store atomicity claim.
- No new API/UI tests, browser interaction, deployment package, clean-Windows or real-device/provider acceptance in this increment.
- The earlier logical browser attempt remains not_exercised; prior UI/API results are historical.
- Existing package artifacts remain historical and do not include this physical hierarchy feature.
