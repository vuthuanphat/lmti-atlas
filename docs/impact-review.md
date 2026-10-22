# LMTI — chạy thử review thay đổi có bằng chứng

Ngày 2026-10-13. Đây là lát cắt kỹ thuật local dùng dữ liệu không nhạy cảm. Chưa phải bản
thương mại hoặc kết quả nghiệm thu toàn bộ kế hoạch sáu tuần.

## Năng lực đã chạy

- Context/preflight kiểm tra lại boundary và hash của compiler. Nguồn thay đổi
  trả `stale`; không xác minh đủ trả `unknown`. Cảnh báo đi vào cả payload của Agent.
- Context/preflight dùng cùng reader memory chỉ đọc: SQLite nếu đã tồn tại, JSON
  tương thích nếu chưa có SQLite. `--memory-source legacy_json` chọn rõ kho cũ.
  Không tự migrate/gộp kho; preflight vẫn ghi audit theo chức năng có trước.
- Xếp hạng sau privacy gate rồi mới lấy top-k. Vượt ngân sách đọc memory báo lỗi,
  không gắn nhãn complete cho tập bị cắt. SQLite có thể tạo WAL/SHM để phối hợp
  đọc; không ghi dữ liệu ứng dụng, access, decay hoặc schema từ reader mới.
- Impact có owner TypeScript/SQLite riêng, import có revision, delta/history,
  duyệt có kiểm tra quyền, nguồn/evidence và truy quan hệ có hướng.
- Báo cáo phân biệt tác động tiềm năng, bối cảnh liên quan và phần chưa xác minh;
  giữ checklist, paths, nguồn cũ, conflict và giới hạn truy vấn. Agent không tự
  hoàn tất checklist hay cho phép triển khai.
- CLI, Python MCP và trang review chỉ đọc dùng cùng engine. Mỗi lượt báo cáo,
  mở báo cáo lưu và export đều kiểm tra nguồn/quyền. Báo cáo lưu bị sửa phải bị từ chối.

Trang review trình duyệt local vẫn chỉ đọc. Studio có thêm trang **Impact** nối
snapshot project/topology đã lưu, duyệt import và lưu xác minh của con người.
Native project/topology, impact, TS memory và Go compatibility giữ owner riêng.
Xem [ADR](adr/2026-10-13-native-impact-review.md) và
[biên bản triển khai](plans/2026-10-13-native-impact-review.md).

## Review trong Studio

Build bằng toolchain đã cài và package riêng, không ghi đè package cũ:

```powershell
node node_modules/typescript/bin/tsc -b packages/cli packages/mcp
& .\scripts\build-studio.ps1 -BuildDirectory build\native-impact-20261013 -InstallDirectory build\studio-impact-20261013
& .\scripts\start-studio-ui.ps1 -PackageDirectory build\studio-impact-20261013 -AllowImpactReview
```

Nếu không có `-AllowImpactReview`, desktop chỉ cho đọc. Python/MCP Agent không có
capability này. Launcher dùng Node/CLI tin cậy và binary native trong package;
workspace JSON không tự được cấp quyền chạy executable khác.

Khi build lại hoặc thay binary `lmti-project`, digest đã pin trong workspace cũ
không còn khớp dù đường dẫn/tên file giống nhau. Hệ thống từ chối đọc bằng binary đã
đổi; chưa có chức năng repin. Giữ nguyên workspace/lịch sử cũ, tạo workspace review
mới với package mới đã tin cậy rồi inspect/accept import lại. Không sửa tay digest,
nới quyền hoặc coi lịch sử cũ đã được chuyển sang workspace mới.

1. Mở và **Save** dự án. Trang **Impact** yêu cầu đúng đường dẫn document, project ID
   và revision đã lưu; không nhận dự án copy trùng ID từ database khác.
2. **Create review workspace…** vào thư mục mới; chọn site, environment và quyền đọc
   metadata internal nếu cần. Hoặc **Connect review workspace…** với workspace đã tạo.
3. **Stage project changes** → **Inspect changes**. Đọc source revision, quan hệ,
   contract và evidence; đánh dấu đã review rồi **Accept** hoặc **Reject**.
4. Chọn component thay đổi, mô tả, baseline/proposed revision và rollout targets;
   **Review impact**. Path là ảnh hưởng tiềm năng từ khai báo, không phải kiểm chứng
   thiết bị thật. Phần thiếu mapping và observed version vẫn cần xác minh.
5. **Save review report** giữ chính bản đang hiển thị. Trong **Verification**, chọn
   việc, nhập kết quả, tóm tắt bằng chứng và tham chiếu tương đối như
   `checks/contract-review.md#result`; xác nhận đã kiểm tra rồi lưu.
6. Mở lại qua danh sách saved reports hoặc report ID. Đọc lại nguồn/quyền trước khi
   hiện kết quả verified; thay đổi nguồn làm kết quả cũ hết hiệu lực hiện hành.

Exporter đọc một transaction LMPR, gồm phần mềm cấp dự án và asset/binding của site
được chọn. `complete` nghĩa là đầy đủ trong phạm vi xuất đã được cấp quyền. Kết nối
vật lý không được tự suy diễn thành dependency nhân quả. Không xuất raw code,
repositories, knowledge, cấu hình hay observed telemetry. Local projection được
phân loại internal; external projection chỉ gồm public đã qua gate của owner.

Kho mới dùng LMIP schema 2. Kho schema 1 vẫn đọc được; **Enable verification history…**
tạo backup SQLite riêng có cả WAL đã commit, kiểm tra backup rồi nâng schema trong
transaction. Nếu lỗi, giữ nguyên schema gốc và backup; chọn tên backup mới nếu bị
trùng. Không tự thay thế hoặc xóa database. Khi cần phục hồi, đóng mọi process đang
dùng kho và chọn một bản sao backup làm kho riêng; giữ nguyên bản lỗi để đối chiếu.

Lịch sử xác minh chỉ được nối thêm, giới hạn 1.000 event/report; nó không sửa checklist
canonical, không thay graph thành observed và không cấp quyền deploy. Danh sách báo
cáo chỉ trả ID/thời gian/revision theo đúng grant; bản cũ có thể không mở được như
report hiện hành. Chưa có historical/as-of viewer. Native và impact không có transaction
chung: kiểm tra nguồn trước ghi và trước khi hiển thị kết quả sau ghi; mở lại luôn kiểm
tra lần nữa. Đây không phải bảo đảm chống mọi thay đổi đồng thời ở database khác.

## Khởi chạy

Cần Node.js 24 cho CLI impact; Python 3.11+ nếu dùng MCP. Dùng dependency đã cài của
checkout, không cần thêm package bên ngoài. Từ thư mục gốc:

```powershell
node node_modules/typescript/bin/tsc -b packages/cli packages/mcp
node packages/cli/dist/index.js impact demo --out build/impact-demo-new
node packages/cli/dist/index.js impact serve --config build/impact-demo-new/launcher.json
```

Lệnh demo chỉ tạo thư mục mới; từ chối ghi đè. Lệnh serve in URL `127.0.0.1` với
port được cấp. Mở đúng URL đó trên máy đang chạy; giữ process serve để link hoạt động.
HTTP chỉ có hai GET endpoint `/` và `/api/report`, không có thao tác ghi hoặc CORS.
Trang kiểm tra lại nguồn khi tải/reload hoặc bấm **Recheck sources**.

Demo có 9 thành phần, 8 quan hệ, hai nguồn code/manifest. Dữ liệu được đánh dấu
`synthetic-fixture-not-human-validation`; đó không phải chữ ký xác minh của SME.
Nguồn code được tạo từ file giả lập `src/labels.ts` qua mapping ID/export tường minh.
Adapter nhỏ chỉ nhận một số khai báo named exported function `.ts`/`.js`; không
phân tích dependency tự động. Raw code không vào DB hoặc payload; binding theo dõi
SHA của file code và file mapping, nên sửa một trong hai mà chưa import lại cũng
làm nguồn hết hiệu lực.

```powershell
node packages/cli/dist/index.js impact report --config build/impact-demo-new/launcher.json
node packages/cli/dist/index.js impact export --config build/impact-demo-new/launcher.json --out review.html
node packages/cli/dist/index.js impact save-report --config build/impact-demo-new/launcher.json
```

Export được ghi trong thư mục launcher, không ghi đè file. HTML/JSON đã xuất là
snapshot tại thời điểm xuất; mở file offline không tự kiểm tra nguồn. Dùng server
hoặc `open-report` để kiểm tra lại trước khi coi kết quả còn hiện hành.

## Demo nguồn A → B → review

1. Demo mới có graph revision **4**: code và manifest A đã được chấp nhận bởi
   fixture runner. Báo cáo truy từ label code tới service, deployment, máy quét
   và bước xác nhận xuất kho. Gateway chỉ là associated context; service metrics
   cùng máy không tự bị suy ra chịu tác động.
2. Thay nội dung `warehouse-manifest.json` mà không đổi revision/digest khai báo,
   rồi reload: adapter so fingerprint của toàn snapshot với binding đã đăng ký,
   báo stale. Không tự coi metadata do file tự khai là bằng chứng freshness.
3. Với demo nguyên bản chưa sửa, chạy:

```powershell
node packages/cli/dist/index.js impact import --config build/impact-demo-new/launcher.json --file source-B.json --revision 4
```

4. Import trả `batchId`, `graphRevision` và delta; batch còn pending. Báo cáo vẫn
   dùng projection A được chấp nhận, đánh dấu stale do đầu nguồn đã đổi. Sao chép
   đúng ID/revision vừa nhận vào lệnh review sau khi kiểm tra candidate:

```text
node packages/cli/dist/index.js impact review --config build/impact-demo-new/launcher.json --batch <batchId> --revision <graphRevision> --decision accept --reviewer <reviewer> --evidence-reviewed true
```

5. Reload thấy revision B; source fresh chỉ có nghĩa fingerprint khớp. Thiết bị
   thật vẫn chưa được xác minh. Lặp với `source-C.json` và revision hiện tại để
   xem observation giả lập, không biến nó thành bằng chứng vận hành thật.

Sai expected revision bị từ chối. Reject B không tự làm A fresh trở lại. Import,
review và save là thao tác operator; MCP không cung cấp những thao tác đó.

Nếu sửa code giả lập, cập nhật revision/mapping trong `code-mapping.json`, rồi dùng
`impact import-code --config ... --file code-mapping.json --revision <expected>`.
Snapshot mới được tạo từ file được phép và stage để review; lệnh import JSON thông
thường không được bỏ mất các binding raw-input của nguồn đã map code.

## Agent boundary

Trusted launcher chọn executable, CLI và `launcher.json`; request không được
chọn database, file, grant, source checks hoặc shell. Python SDK gọi CLI bằng
fixed argv, không qua shell, có timeout và giới hạn input/output.

```powershell
$env:PYTHONPATH = 'python/src'
python -m lmti_impact.mcp --node '<absolute node.exe>' --cli '<absolute packages/cli/dist/index.js>' --config '<absolute launcher.json>'
```

Thay các placeholder bằng đường dẫn tuyệt đối trên máy. Năm tool chỉ đọc:
`impact_snapshot`, `impact_lookup_entity`, `impact_get_evidence`,
`impact_trace_change`, `impact_open_report`. Snapshot/entity/evidence mô tả
projection đã được chấp nhận, không khẳng định quan sát máy thật hiện tại.

CLI stdin tương ứng:

```json
{"schema":"lmti.impact.request.v1","op":"snapshot"}
```

Các op khác: `entity`/`evidence`/`open-report` kèm `id`; `report` kèm `change`;
`inbox` trả import queue và lịch sử được phép xem. Contract nằm trong
[model.ts](../packages/impact/src/model.ts), giới hạn ở [package guide](../packages/impact/README.md).

## Kiểm chứng và những gate còn mở

```powershell
node node_modules/vitest/vitest.mjs run --configLoader native --dir packages
node packages/impact/scripts/benchmark.mjs
$env:PYTHONPATH = 'python/src'
python -m unittest discover -s python/tests -p 'test_impact.py' -v
```

Python integration thật cần thêm `LMTI_IMPACT_NODE`, `LMTI_IMPACT_CLI`,
`LMTI_IMPACT_CONFIG` trỏ tới executable, compiled CLI và demo launcher. Không có
những biến đó, hai bài integration được skip rõ ràng; unit/transport tests vẫn chạy.

Evidence local của đợt sửa ở `build/impact-evidence/`: baseline SHA/hash/file copy,
ba CLI regression fail trước sửa, memory red/green, kết quả suite và benchmark.
Đây là thư mục được ignore. Đã thử Python MCP → CLI → SQLite trên fixture riêng,
kiểm tra database không đổi và request tự mở rộng quyền bị chặn.
Các số liệu và phạm vi đã kiểm chứng được ghi trong
[biên bản triển khai](plans/2026-10-12-impact-execution.md).

Các gate chưa đạt: adapter repository đa ngôn ngữ, đồ thị impact tương tác đầy đủ,
nghiệm thu form review với người dùng và Windows sạch, bộ 20 đáp án do người hiểu hệ thống
duyệt, baseline cùng Agent/budget, phép đo công duy trì và mức giảm khoảng 20%.
Protocol và công cụ tổng hợp công người dùng nằm trong [evaluation](impact-evaluation.md).
Demo nhỏ không thay thế các gate đó. Chưa bật model local, network scan, SSH hoặc
device execution. Chưa chọn quy trình NOIR/IoT thật.

**[CẢNH BÁO BẢO MẬT]** Store chưa mã hóa, grant trong launcher không phải OS sandbox
hoặc identity nhiều người. Chỉ dùng synthetic/nonsecret. Không đưa dữ liệu khách
hàng, secrets hoặc source riêng tư vào fixture. Kiểm tra `.gitignore` cho `.env`,
DB/WAL/SHM và evidence trước khi push; chạy `lmti publish preflight` trước publication.
Đợt triển khai này không push, publish hoặc thay remote.
