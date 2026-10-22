# M1 — Gói thiết kế và kiểm tra khả thi Agent–dự án

Ngày: 2026-10-13. Theo [master r3](../LMTI_MASTER_PLAN.md).
Chủ sản phẩm đã yêu cầu thực hiện roadmap. M0 định hướng được nhận để triển khai.
**M1 đang thực hiện:** contract, prototype và smoke cục bộ có thể kiểm chứng;
nguồn/site/workload thật và nghiệm thu prototype vẫn còn mở.
Đây là gói thiết kế của một mốc, không phải master/roadmap mới.

## 1. Quyết định triển khai cục bộ

- Client đầu tiên: Codex đang cài trên máy; transport MCP stdio Python.
- Profile: một operator local; model target external chỉ nhận public metadata.
- Nguồn kiểm tra khả thi: native LMPR synthetic demo qua API owner, không dùng
  project đang mở hoặc memory của người dùng.
- Phần cần chuẩn hóa: envelope có nguồn/quyền/độ mới/completeness và typed errors.
- Không chọn nhà cung cấp IoT khi chưa biết nguồn thực tế. Adapter phải tách khỏi
  contract; nguồn hiện hữu được ưu tiên, direct collector là nhánh có điều kiện.
- UI giữ Qt/native; HTML dưới đây là wireframe review, không thay frontend/runtime.

[ADR boundary](../adr/2026-10-13-agent-project-layer.md) và
[contract](../agent-layer-contract.md) ghi quyết định, giới hạn và threat model.
Contract đích chưa được tuyên bố là một API sản phẩm đã chạy.

## 2. Kiểm kê capability theo nguồn

| Nguồn/owner | Có thể tái dùng ngay | Khoảng thiếu cho M2/M3 |
| --- | --- | --- |
| Native project/topology | Saved revision, site/public filtering, bounded context, declared dependency neighborhood | Project/subsystem hierarchy đầy đủ; direct identity lookup/pagination; ownership; snapshot-consistent subgraph |
| Python project MCP | Transport stdio, trusted argv/grant, context/impact/work-proposal | Envelope chung, adapters tới TS/context và observation; capability discovery theo nguồn |
| TS compiler/context/privacy | Compiled Project Atlas, source freshness, bounded context, policy/egress | API owner ổn định để Python dùng; mapping AMF/code entity ↔ native component; không gọi TS MCP stub như server hoàn chỉnh |
| TS impact | Source mapping/review, graph/evidence, reports có giới hạn | Quan hệ code/release/device cần bằng chứng; không suy observed từ binding |
| Drive | Session reader và local preview | OAuth thật và quyền xuất context nếu pilot chọn Drive |
| IoT | Chưa cấu hình nguồn | Schema/authority, account chỉ đọc, endpoint, workload/freshness và adapter cụ thể |

Đường client đã kiểm tra là native/Python hiện có; chưa hợp nhất các owner TS/IoT.
M2 chỉ bắt đầu tính năng mới sau khi contract/prototype và workload tương ứng được
review; không sửa store schema hay UI trong gói M1 này.

## 3. Identity và authority

| Dữ kiện | Nguồn chịu trách nhiệm | LMTI giữ/cung cấp |
| --- | --- | --- |
| File/symbol/code contract | Repository/indexer được phép, đúng revision/content fingerprint | Source-relative ref, compiled summary, mapping tới component |
| Yêu cầu/thiết kế | Tài liệu được chọn, đúng version, người phụ trách | Tham chiếu/summary được cấp quyền, binding có evidence |
| Cấu trúc logic/declared dependency | Native owner hoặc catalog được chọn | Identity có source namespace, typed relation, reviewer/source version |
| Release mong muốn/binding | Owner cấu hình/deployment declaration | Desired relation, không gắn nhãn observed |
| Firmware đang chạy/metric/reachability | IoT/monitoring source đã được xác thực | Observation có sample time, receive time, TTL, chất lượng và device mapping |
| Health chức năng | Nguồn đo có định nghĩa metric/điều kiện cụ thể | Kết luận trong phạm vi phép đo; thiếu phép đo thì unknown |
| Lesson/decision | TS memory owner có privacy/evidence/review | Guidance có policy, không nâng thành observed fact |
| Verification | Owner review, đúng evidence/source revision | Outcome phiên bản hóa; source đổi thì historical/stale |

Khóa entity: project ID + source namespace + source-native ID + entity kind.
Quan hệ liên nguồn là mapping riêng có owner/evidence, không đổi ID nguồn.
Đổi tên giữ ID; thay thiết bị cùng IP giữ identity mới. Không auto-merge theo nhãn.
Authority xác định theo **từng trường/loại assertion**, không theo “nguồn được nhập cuối”.

## 4. Hành trình UX đã phác thảo

[Prototype tương tác](../design/2026-10-13-agent-layer/index.html) gồm:

1. Kết nối dự án/nguồn/Agent và xem phạm vi Agent nhận được.
2. Hỏi về firmware, đi từ code/component tới thiết bị, kiểm tra declared/observed,
   evidence và các trạng thái dữ liệu mới/cũ/mất nguồn/thu hồi.
3. Xem proposal, expected revision và kết quả review mô phỏng.

Prototype chỉ dùng dữ liệu cố định mô phỏng, không đọc file, không OAuth, không
gọi network, không ghi project. Nút review không sửa dữ liệu thực.
Người thử cần xác nhận số bước, nhãn/điểm vào và cách tìm nguồn; chưa có
human UX acceptance. EN/VI của app giữ nguyên.

## 5. Bộ ca nghiệm thu khóa cho thiết kế

| ID | Hành vi / đáp án đích | Mốc và evidence |
| --- | --- | --- |
| A01 | Client thật launch, discover đúng allowlist và đọc đúng project/site/revision | M1 smoke; synthetic native fixture |
| A02 | Agent không thể override project/site/target/binary trong arguments | M1/M2 negative tool call |
| A03 | Native desired binding không trở thành installed firmware/online | M1/M2; observedVersion unknown |
| A04 | Identity không đọc được trả generic unavailable, không lộ existence | M2; oracle có authorized và denied cùng ID shape |
| A05 | Context/subgraph partial có completeness/reason; không suy không có ảnh hưởng | M2; node nằm sau limit, cycle/diamond/depth budget |
| A06 | Đổi source/revision, dirty content cùng commit, delete/tombstone | M2; mapping/source diff và stale context/proposal |
| A07 | Đổi tên giữ ID, thay thiết bị cùng địa chỉ không gộp; conflict nguồn rõ | M2; oracle do chủ nguồn xác nhận |
| A08 | Prompt injection trong label/doc/tool output không đổi quyền hoặc gọi shell | M2; dữ liệu mô phỏng cố định, không chứa secret thật |
| A09 | Code–release–device path có evidence; binding desired tách observed | M2/M3; mapping gaps phải được nêu |
| A10 | Live observation đúng thiết bị/metric/unit/sample/receive time | M3; đối chiếu với nguồn độc lập |
| A11 | Mất nguồn khác device failure; stale/reconnect/out-of-order/gap rõ | M3; test được chủ nguồn cho phép |
| A12 | Revoke chặn query/cache/report tiếp theo; context đã gửi không thể thu hồi | M2/M3; không thay grant để làm test pass |
| A13 | Proposal chỉ diff được phép, stale revision bị chặn, review/save qua owner | M2; old/new state/evidence rõ |
| A14 | Read không ghi store; migration/recovery không mất dữ liệu | M2/M4; disposable fixtures và restore evidence |
| A15 | Same Agent direct-source baseline vs LMTI, cùng dữ liệu/quyền/revision | M4; oracle và human timing độc lập |
| A16 | Người thứ hai duy trì source/mapping, cài Windows sạch | M4; checklist và exact package digest |

Đây là bộ ca development. Holdout/business oracle cần người hiểu pilot và
người chấm độc lập chuẩn bị; không tái dùng test development như holdout.
Smoke không chứng minh A04/A06–A16 hoặc khả năng model suy luận.

## 6. Workload và ngưỡng

**Profile D0 khóa cho smoke M1:** một synthetic project/site, ba component,
context limit 100 và một query limit 1 để kiểm tra partial; một client;
request deadline 30s, owner deadline 10s; byte cap 2 MiB; không telemetry.
Đạt D0 không đồng nghĩa đạt quy mô lớn hoặc SLA production.

Các profile thiết kế D1/D2 đề xuất 1.000/10.000 entity trên graph phân bố đại diện.
Native hiện có cap 2.000/category và 64 MiB file, whole-document read, context
200/category. Phải đo/load hoặc thiết kế pagination phù hợp trước dùng D1/D2;
không tăng cap để thay bằng chứng. Số edge, hierarchy depth, concurrent readers,
p95/CPU/RAM và máy thử chưa khóa.

**Profile P0 thật chưa khóa:** site, device count, metric/device, protocol,
interval/burst/payload, delay/clock skew, history/retention, downtime và account
chỉ đọc. Chủ nguồn cung cấp schema mẫu nonsecret. Chưa có P0 không được đánh dấu
M3 hoặc M1 tổng thể hoàn tất.

Evaluation khóa same-Agent, same revisions, same observation window/replay,
scope và ngân sách. Đo tổng person-minutes setup + mapping/update + review + repair;
token/cost/wall-clock/tool calls báo riêng. Thiếu oracle/human timing thì
businessValue=unmeasured. Ngưỡng chất lượng/giảm công chốt theo pilot trước phép đo;
mục tiêu 20% impact không tự áp lên release.

## 7. Chạy và đọc bằng chứng

Không cài dependency bổ sung. Dùng Python và packaged native binary sẵn có:

```powershell
python scripts/m1-agent-smoke.py --binary C:/path/to/lmti-atlas/build/studio-simple-20261013/bin/lmti-project.exe
```

Thêm `--codex <absolute-codex-executable>` để kiểm tra Codex client:
discovery theo allowlist, ephemeral client thread, MCP tool read.
Không chạy model turn, không tạo sub-agent thực hiện công việc, không gọi IoT
hay sửa cấu hình Codex toàn cục. App-server có thể dùng hạ tầng/cache cục bộ
của Codex; không coi đây là một client hoàn toàn cô lập hệ điều hành.

Mỗi lần chạy tạo thư mục mới `build/m1-smoke-*/` với synthetic DB, config snippet
và report số đo. Không overwrite file có sẵn; không dùng project của người dùng.
Snippet có đường dẫn máy, chỉ dành local và đã nằm trong build được ignore.
Trước push kiểm tra .gitignore; chạy `lmti publish preflight` theo quy tắc repo.

Report phân biệt native transport checks, Codex tool read, model turn,
liveIoT và businessValue. Generic errors không in config, secret hoặc raw stderr.
Thất bại không mở rộng grant, đổi sandbox hay sửa policy tự động.

## 8. Thứ tự công việc tiếp theo

Một hạng mục triển khai chính: AGENT-01/STRUCT-01 chỉ sau gate M1 tương ứng.
Cần review envelope/prototype và chọn nguồn/code mapping của pilot; SOURCE-01
vẫn chờ thông tin IoT và quyền truy cập. Sau đó triển khai additive read API
qua owner, direct lookup/pagination, mapping/delta và proposal theo master M2.
OBS-01 chỉ chọn adapter khi P0 đã khóa. Không xây trước nhiều protocol/provider.

Chưa có deadline theo tuần khi thiếu workload/nhân lực. Không thay gate thực bằng
số dòng code, số screen hoặc số unit test.

