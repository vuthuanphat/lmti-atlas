# LMTI impact: protocol đánh giá công sức và chất lượng

Điều phối 2026-10-13: [master r3](LMTI_MASTER_PLAN.md) định vị lớp Agent–dự án,
bao gồm cấu trúc lớn và quan sát thiết bị thật. Protocol này giữ cho tính năng impact; mục tiêu 20%
không còn là gate toàn bộ release. Các nhãn tuần dưới đây là lịch sử; phương pháp
đo riêng tính năng impact không thay đổi. Đối chứng toàn sản phẩm r3 dùng cùng
Agent truy nguồn/công cụ trực tiếp và được khóa riêng theo master; không thay thế
bằng baseline file đơn giản của protocol impact bên dưới.

Trạng thái: **protocol và công cụ đo đã chuẩn bị; chưa có kết quả pilot với người dùng**.
Theo [kế hoạch impact](plans/2026-10-12-evidence-backed-change-impact.md), mục tiêu khoảng 20% giảm công là giả thuyết cần kiểm chứng. Chưa chốt hệ thử thật, người hiểu hệ thống (SME), đáp án độc lập hoặc số phút đo được. Không thay các phần còn thiếu bằng thời gian Agent tự ước lượng.

## Bộ 20 tình huống

Đây là các họ tình huống, không phải bộ đáp án đã được SME duyệt. Người phụ trách phải chuẩn bị input/revision/diff/rollout, tập dữ liệu được phép, đáp án với path/evidence ID, phần chưa biết và mức nghiêm trọng cho từng biến thể cụ thể. Khóa version đáp án trước khi chạy so sánh.

| ID | Nhóm | Tình huống | Nội dung SME cần xác nhận trong đáp án |
| --- | --- | --- | --- |
| C01 | Development | Code unit đổi contract | Service và bước nghiệp vụ nào liên quan; path và evidence hỗ trợ. |
| C02 | Development | Chỉ đổi mô tả/comment | Diff có thật sự giữ nguyên contract; giới hạn kết luận vận hành. |
| C03 | Development | Service đổi version | Desired release, deployment quan sát được và rollout dự kiến. |
| C04 | Development | Cấu hình device thay đổi | Consumer nào có dependency và điều kiện propagation. |
| C05 | Development | Đổi schema datastore | Reader/writer nào liên quan theo hướng cạnh và loại thay đổi. |
| C06 | Development | Hai service cùng host | Quan hệ co-location nào chỉ là thông tin bối cảnh. |
| C07 | Development | Khác site/environment hoặc ngoài rollout | Instance được phép xét và điều kiện triển khai cụ thể. |
| C08 | Development | Thiếu liên kết tới workflow | Mapping gap nào bắt buộc nêu; không đồng nhất với không ảnh hưởng. |
| C09 | Development | Source revision cũ | Evidence nào stale, câu trả lời nào phải yêu cầu xác minh lại. |
| C10 | Development | Checkout bẩn, commit giữ nguyên | Content đã thay đổi; fingerprint và kết luận bị ảnh hưởng. |
| C11 | Development | Hai nguồn mâu thuẫn | Assertions mâu thuẫn và câu hỏi cần người phụ trách giải quyết. |
| C12 | Development | Nguồn bị xóa hoặc không đọc được | Trường hợp tombstone, unavailable và unknown phù hợp. |
| C13 | Holdout | Đổi tên code unit/device | Stable identity khi có mapping; khoảng trống khi chưa có mapping. |
| C14 | Holdout | Cycle và diamond graph | Tập tác động/path hợp lệ, tránh lặp vô hạn hoặc nhân đôi findings. |
| C15 | Holdout | Bản ghi quan trọng nằm cuối danh sách | Relevance sau policy/ranking, không phụ thuộc thứ tự nhập. |
| C16 | Holdout | Vượt node/depth/time/byte budget | Phần kết quả còn thiếu và cảnh báo bắt buộc. |
| C17 | Holdout | Entity/evidence ngoài quyền | Nội dung nào được phép trả; kiểm tra rò rỉ ID, tên, đường dẫn hoặc số lượng ẩn. |
| C18 | Holdout | Thu hồi quyền sau tạo report | Lookup, mở report và export nào phải bị chặn/kiểm tra lại. |
| C19 | Holdout | Liên kết inferred hoặc model tự bịa | Giới hạn suy luận; không tự biến thành observed/verified. |
| C20 | Holdout | Import hỏng, import lặp lại và phục hồi | Snapshot/history phải giữ, idempotency và công xử lý lại. |

Các unit test hiện có cũng có thể dùng những họ tình huống trên; điều đó **không** làm chúng thành holdout độc lập. SME phải tạo biến thể và đáp án chưa dùng để phát triển. Nếu dùng C13–C20 để sửa code sau chấm, chuyển lượt đó thành development, khóa một bộ holdout mới rồi đánh giá lại. Không tái sử dụng kết quả cũ như kiểm chứng độc lập.

## Cách chạy đối chứng

1. Khóa protocol, oracle version, reviewer, scope dữ liệu, severity và ngưỡng chất lượng. Mặc định đề xuất không giảm recall/precision; thay ngưỡng cần SME đồng ý trước lượt chạy.
2. Baseline là một file mô tả hệ thống đơn giản + cùng Agent. Cả hai nhánh nhận cùng thông tin được phép và chuỗi source update; cùng model/version, prompt policy, tool và ngân sách token/thời gian. Cập nhật baseline như sử dụng thực tế; không cố ý để file baseline cũ. Không cho baseline đọc report LMTI hoặc đáp án.
3. Dùng phiên Agent riêng, luân phiên thứ tự baseline/LMTI; ẩn tên nhánh với người chấm nếu khả thi. Ghi người thực hiện và mọi công SME cung cấp cho từng nhánh.
4. Dự kiến ba lượt/case nếu ngân sách cho phép. Nếu ít hơn, ghi lý do trước khi chạy. Lặp lại không làm tăng số tình huống độc lập. Ghi cả timeout, thất bại và lần phải sửa lại; không xóa lượt lỗi.
5. SME chấm từng output theo oracle, gồm candidate impact, path/evidence, stale/unknown/conflict và nội dung ngoài quyền. Nhãn `associated_context` không tự được tính là một dự báo ảnh hưởng đúng. Khóa quy tắc tính TP/FP/FN trước khi chạy.
6. Ghi nhật ký thời gian tại thời điểm làm việc. Token/model cost, wall-clock, cấu hình máy và thời gian kỹ thuật xây sản phẩm ghi riêng. Công cụ dưới đây chỉ tổng hợp công sức đã ghi, không xác minh log hay oracle là thật.

## Công cụ cộng person-minutes

Không cần thư viện bổ sung. Từ root repository:

```powershell
New-Item -ItemType Directory -Force build/impact-evidence | Out-Null
node scripts/impact-effort.mjs --template build/impact-evidence/effort-log.json
node scripts/impact-effort.mjs build/impact-evidence/effort-log.json
node --test scripts/impact-effort.test.mjs
```

`--template <file>` tạo UTF-8 bằng chế độ exclusive, từ chối ghi đè file đã có. `--template` không có tên file in template ra stdout. Template có 20 cặp và mọi số phút là `null`; chạy ngay sẽ trả `status: "insufficient_evidence"`, `targetAssessment: "not_evaluable"` và phần trăm tiết kiệm `null`.

Schema `lmti.impact.effort.v1`:

| Trường | Ý nghĩa |
| --- | --- |
| `protocol` | ID, `locked`, `oracleVersion`, `reviewerId`, số `repetitions` từ 1–10; lý do nếu ít hơn 3; `maxRecallDrop`/`maxPrecisionDrop` là mức giảm được duyệt (0–1, đề xuất 0). |
| `setup.baseline`, `setup.lmti` | Danh sách `{personId, minutes}` cho toàn bộ công nhập/chuẩn bị ban đầu, bao gồm SME. Không ghi lại cùng công đó ở từng run. |
| `runs[]` | Một cặp cho mỗi `caseId`/`repetition`; C01–C12 `development`, C13–C20 `holdout`. Không thiếu, trùng hoặc đổi nhóm. Khi tăng repetitions phải thêm đủ 20 cặp mỗi lượt. |
| Mỗi nhánh trong run | `status`: `unmeasured/completed/failed/timeout`; cùng `dataRevision`, `modelVersion`, `budgetId` giữa hai nhánh. Budget ID tham chiếu packet đã khóa, gồm giới hạn và ngân sách thực dùng ghi riêng. |
| `effort.update/staleConflict/review/repair` | Mỗi nhóm là danh sách `{personId, minutes}`. `[]` nghĩa đã xác nhận không tốn công ở nhóm đó; `null` hoặc thiếu nghĩa chưa đo, không được tự tính bằng 0. Một người có nhiều mục nếu là các lần làm việc khác nhau. |
| `quality` | `reviewed` và số đếm `truePositive`, `falsePositive`, `falseNegative`, `evidenceErrors`, `unknownHandlingErrors`, `criticalMisses`, `seriousFailures`, `unauthorizedDisclosures`. Số 0 phải là kết quả chấm, không phải giá trị thay cho chưa kiểm tra. |
| `wallClockMinutes` | Thời gian trôi qua của lượt; có thể chưa đo. Báo riêng và không trừ khỏi person-minutes. |

`personId` nên là nhãn vai trò/pseudonym, không cần dữ liệu cá nhân. Mỗi lần làm việc ghi đúng một lần; nếu kỹ sư và SME làm song song, **cộng công cả hai**. Thống nhất trước cách ghi thời gian cần chú ý và thời gian chờ: chờ tự động không cần người theo dõi thuộc wall-clock, không tự thành công người. Giữ cùng quy tắc ở hai nhánh.

`cold = setup + update + stale/conflict + review + repair`; `operating` bỏ riêng phần setup. Phần trăm giảm = `(baseline − LMTI) / baseline × 100`. Công cụ trả tổng tuyệt đối, trung vị/min/max chênh lệch theo cặp, nhóm holdout riêng và số lượt lỗi. Không trừ công đã thất bại, không lấy thời gian song song lớn nhất thay cho tổng, không dùng một số thay đổi tương lai giả định để làm đẹp chi phí khởi tạo.

Thiếu phép đo/cặp/điều kiện so sánh/duyệt oracle thì chỉ trả tổng **đã ghi được**, không công bố mức tiết kiệm. Mẫu số bằng 0 không tạo tỷ lệ. Dữ liệu hợp lệ đầy đủ có thể trả `complete_logged_workload`; đạt mục tiêu trong log cần giảm cold effort ít nhất 20%, không vượt ngưỡng chất lượng ở toàn bộ workload **và** holdout, không có critical miss/serious failure/disclosure trong nhánh LMTI. Các nhãn này chỉ là phép tính trên log được cung cấp, không tự cấp phép thử hệ thật.

## Bằng chứng kỹ thuật và gate còn lại

- [Compiler freshness](../packages/compiler/test/freshness.test.ts), [impact core](../packages/impact/test/impact.test.ts), [MCP handlers](../packages/mcp/test/server.test.ts) và [Python impact](../python/tests/test_impact.py) kiểm tra hành vi phần mềm/ranh giới; không đo tiết kiệm công người hay xác nhận nghiệp vụ kho thật.
- [Kiểm thử bộ cộng thời gian](../scripts/impact-effort.test.mjs) dùng số **hư cấu chỉ để kiểm tra phép toán**. Không đưa các số đó vào benchmark hoặc log pilot.
- Chưa có SME/oracle độc lập, human timing, người thứ hai duy trì mapping, chi phí model đã ghi hay kết quả workload thật. Hiện tại kết luận kinh doanh là **chưa đủ bằng chứng**.
- Tuần 6: chỉ mở pilot read-only đã được chủ nguồn cho phép khi cả chất lượng, công sức và khả năng người khác duy trì đều đạt. Nếu ngang baseline thì thu gọn; nếu công mapping triệt tiêu lợi ích thì ưu tiên adapter/delta review; nếu có lỗi nghiêm trọng thì sửa và tái kiểm chứng trước dữ liệu thật.

Giữ log và evidence thực trong `build/impact-evidence/` đã được ignore; không ghi secrets, raw chat hoặc dữ liệu khách hàng vào log. Kiểm tra `.gitignore` và chạy `lmti publish preflight` trước mọi push/publication theo quy tắc repository.
