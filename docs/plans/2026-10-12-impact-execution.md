# LMTI — kết quả triển khai lát cắt impact đầu tiên

Ngày 2026-10-12. Đây là kết quả kỹ thuật của checkout local, không phải xác nhận
hoàn tất sáu tuần pilot hoặc sản phẩm thương mại. Kế hoạch gốc ở
[evidence-backed change impact](2026-10-12-evidence-backed-change-impact.md).

## Phần đã chạy được

1. Sửa ba hồi quy context: kiểm tra nguồn cũ/không xác minh được; dùng reader
   SQLite/JSON nhất quán cho context và preflight; lọc quyền rồi xếp hạng toàn bộ
   ứng viên trước khi lấy top-k. Context/preflight không tự migrate kho cũ.
2. Thêm owner TypeScript/SQLite riêng cho entities, typed assertions, evidence,
   source revision, import delta/history và review có optimistic revision/scope.
   Không chuyển owner project/topology của C++/Qt hoặc runtime memory Go.
3. Tạo báo cáo truy quan hệ có hướng, rollout, paths, nguồn stale/unknown,
   conflict, coverage và checklist chờ người xác minh. Không suy ra an toàn từ
   việc thiếu đường liên kết; service cùng host không tự chịu tác động.
4. Adapter code hẹp đọc named exported function từ file TS/JS được map rõ ràng.
   ID không phụ thuộc tên đường dẫn; kiểm tra hash cả code và mapping. Snapshot
   không chứa raw code. Mapping quan hệ code/service vẫn là khai báo cần review.
5. CLI, Python SDK/MCP và trang review chỉ đọc dùng cùng owner. Request Agent
   không được cung cấp đường dẫn, grant hoặc freshness. Mở report lưu phải kiểm
   tra lại quyền/nguồn và nội dung canonical; report bị sửa không được coi là hợp lệ.
6. Protocol 20 họ tình huống, 12 development/8 holdout và công cụ cộng person-minutes
   đã chuẩn bị. Template chưa đo trả `insufficient_evidence`, tỷ lệ tiết kiệm `null`.

## Demo đã mở

- Trang local: `http://127.0.0.1:25249/` trên máy dev đang chạy server.
- Fixture riêng: `build/impact-review-final-20261012/launcher.json`.
- Graph revision 4, 9 entities, 8 assertions, hai nguồn code/manifest giả lập.
- Browser được kiểm tra trực tiếp: change A → B, 4 thành phần có thể ảnh hưởng,
  1 máy là bối cảnh liên quan, 4 mục xác minh còn pending và nguồn có thể truy lại.
- Đây là trang browser mới của impact pilot; chưa phải bản cập nhật 26 trang Qt.
  Link phụ thuộc process local; cách khởi chạy lại có trong [runbook](../impact-review.md).

## Kiểm chứng cuối

| Phép kiểm tra | Kết quả | Evidence local |
| --- | --- | --- |
| Build toàn bộ workspace TypeScript | Pass | `build/impact-evidence/build-final.txt` |
| Suite TypeScript toàn workspace | 25 files, 272 tests pass | `build/impact-evidence/typescript-tests-final.txt` |
| Python, gồm native và impact SDK/MCP chạy thật | 26 tests pass, 0 skip | `build/impact-evidence/python-full-final.txt` |
| Bộ cộng công sức | 8 tests pass | `build/impact-evidence/effort-tests-final.txt` |
| Hiệu năng synthetic, gồm đọc SQLite | 1.000 entities/5.000 assertions, 15 runs sau 2 warmups; p50 117 ms, p95 228 ms | `build/impact-evidence/impact-benchmark-final.txt` |
| Whitespace patch | `git diff --check` pass | Thực hiện trên checkout sau sửa |

Các tổng số trên bao gồm test đã có trước; không phải 306 tình huống nghiệp vụ
độc lập. Benchmark chạy Node v24.13.0, Windows x64, Intel i7-11800H; không đại diện
mọi máy hoặc quy mô production. Built-in SQLite vẫn có experimental warning.
Không sửa native code trong đợt này; các native integration dùng executable đã
có với fixture test riêng, không kiểm định lại toàn bộ native UI.

Ba CLI regression fail trước sửa được lưu ở
`build/impact-evidence/context-regressions-before.txt`; baseline file/SHA ở
`build/impact-evidence/baseline-20261012/manifest.json`. Các thay đổi dở trước đó
được giữ lại, không reset/stash/clean checkout. Không chạm memory `.lmti` thực,
database người dùng, process Qt đang mở, remote, publication hoặc thiết bị thật.

Rà soát bổ sung đã đóng các lỗi scope khi duyệt import, change-path bị thay bằng
junction sau startup, report lưu bị giả mạo, bỏ sót thay đổi mapping code và ghi
fixture vào protected tree trước khi từ chối. Có hồi quy tương ứng; giới hạn scan
được kiểm tra lại sau lần đọc cuối.

## Những phần chưa đủ điều kiện nghiệm thu

- Chưa có adapter native snapshot/repository đa ngôn ngữ và chưa có graph UI,
  form review/checklist hoặc lưu xác minh nghiệp vụ trong Qt.
- Chưa có identity nhiều người hoặc mã hóa store. Launcher grant là ranh giới
  ứng dụng do operator cấu hình, không phải OS sandbox. Chỉ dùng synthetic/nonsecret.
- Chưa chốt quy trình NOIR/IoT thật, SME và 20 đáp án độc lập được khóa trước thử.
- Chưa chạy đối chứng cùng Agent/budget, chưa đo công người, công duy trì hoặc
  khả năng người thứ hai cập nhật mapping. Mục tiêu khoảng 20% chưa được kiểm chứng.

Bước tiếp theo là hoàn thiện luồng review vào shell quản trị đã chọn và chuẩn bị
packet tình huống cụ thể cho SME, theo [protocol đánh giá](../impact-evaluation.md).
Chỉ kết luận giá trị pilot từ các phép đo thật sau những gate này.
