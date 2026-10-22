# Historical master r2 — superseded product framing

Archived 2026-10-13. The owner clarified that LMTI is the layer between AI Agents
and projects. The [current master](../LMTI_MASTER_PLAN.md) replaces the standalone
governance framing below and retains large-project structure plus real read-only
IoT monitoring. This record is not an active backlog or implementation approval.

---

# LMTI — Kế hoạch quản trị cấu trúc dự án và thiết bị IoT

Ngày: 2026-10-13. Phiên bản: **r2 — theo trọng tâm chủ sản phẩm vừa xác nhận**.
Trạng thái: **M0 / thiết kế kế hoạch; chưa triển khai phần mở rộng mới**.

## 1. Mục tiêu sản phẩm đã chốt

**LMTI là không gian quản trị cấu trúc dự án quy mô lớn, liên kết các phân hệ,
phần mềm, hạ tầng và thiết bị IoT, đồng thời theo dõi trạng thái thiết bị thật.**

Người dùng phải trả lời được: dự án gồm những gì; từng phần thuộc hệ nào,
do ai phụ trách, phụ thuộc vào đâu; thiết bị đang thế nào; sự cố hoặc thay đổi
có thể ảnh hưởng tới phần nào.

Chủ sản phẩm đã chọn **quản trị cấu trúc + theo dõi trạng thái thiết bị thật
trong bản đầu**. Đây là trục của roadmap. AI, memory, context và lesson phục vụ
việc quản trị; hoàn tất một chu trình chat/task/memory không còn là mục tiêu release.

“Toàn bộ cấu trúc” là quản lý các thành phần và quan hệ trong phạm vi dự án được
khai báo, có cách mở rộng loại thành phần. Chưa có cơ sở hứa tự hiểu mọi repository,
mọi loại thiết bị hoặc mọi ngành mà không cần nguồn và người xác nhận.

Các phần đã thống nhất khác: trải nghiệm gọn; lập kế hoạch/prototype trước code;
C++ core, Qt desktop, SQLite adapters, Python Agent boundary; TS memory độc lập;
Drive kết nối nhanh do nhà phát hành cấu hình. Hướng r1 ưu tiên nhiệm vụ/context
được thay thế bởi r2, không chạy song song.

## 2. Các năng lực quản trị chính

| Năng lực | Nội dung phải quản trị được |
| --- | --- |
| Phân rã dự án | Dự án → hệ thống/phân hệ → thành phần; nhóm và truy vết từ tổng thể xuống chi tiết |
| Phần mềm và dữ liệu | Repository/module, service/API, database, giao diện giao tiếp, phiên bản và dependency |
| Hạ tầng và triển khai | Site/khu vực, môi trường, máy chủ/gateway, nơi triển khai service, liên kết phần mềm–phần cứng |
| Thiết bị IoT | Identity, loại/model, vị trí, owner, firmware/cấu hình mong muốn, kết nối và lịch sử trạng thái quan sát |
| Quan hệ và thiết kế | Chứa, phụ thuộc, giao tiếp, chạy trên, kết nối vật lý/logic; tài liệu và quyết định thiết kế có nguồn |
| Quản trị thay đổi | Revision, lịch sử, thay đổi ai/lúc nào, review khác biệt, ảnh hưởng và công việc liên quan |
| Trạng thái vận hành | Dữ liệu quan sát thật, thời điểm, chất lượng/độ mới, lỗi thu thập và phạm vi bị ảnh hưởng |
| Trợ giúp AI | Tra cứu, giải thích cấu trúc/sự cố theo nguồn và đề xuất; người dùng kiểm soát phạm vi và thay đổi |

Thiết kế hệ thống và quản trị tài sản là giá trị trực tiếp. Work/milestone, lesson
và tài liệu gắn vào thành phần liên quan; không tạo nhiều ứng dụng ngang hàng để
người dùng tự ghép. CAD chi tiết/mô phỏng có thể được tham chiếu bằng tài liệu;
xây công cụ CAD riêng chưa thuộc phạm vi.

## 3. Mô hình cấu trúc phải chốt trước UI

Hai chiều phân cấp và đồ thị quan hệ cùng mô tả một tập identity:

- Chiều logic: dự án → phân hệ → component/service.
- Chiều vật lý/triển khai: site → khu vực → host/gateway/device, kèm environment.
- Quan hệ xuyên hai chiều: component được triển khai tại host/device, service dùng
  database, thiết bị cung cấp dữ liệu cho service, giao diện phụ thuộc phiên bản.
- Một thành phần có thể xuất hiện trong nhiều view nhưng giữ một identity.
  Mỗi cây có quy tắc cha/con rõ và không vòng; quan hệ dependency có thể là đồ thị có chu trình.
- IP, tên, địa chỉ mạng là thuộc tính thay đổi được, không phải identity.
  Mapping identity ngoài hệ thống cần nguồn, namespace và xử lý trùng/đổi thiết bị.
- Mỗi thành phần có phạm vi, người/nhóm phụ trách, nguồn, vòng đời và tham chiếu;
  không bắt buộc mọi thành phần dùng cùng một túi JSON thuộc tính tùy ý.
- Tách **thiết kế/khai báo**, **cấu hình mong muốn**, **quan sát thực tế** và
  **đề xuất thay đổi**. Thời gian nhập không tự chứng minh dữ liệu còn mới hay đúng.

Mô hình typed hiện có được kiểm kê và mở rộng có chủ đích. Các loại subsystem,
deployment/environment, observation hoặc ownership chưa đủ cần thiết kế/migration
riêng; bảng này là yêu cầu đích, không khẳng định tất cả đã được triển khai.

Nhập và duy trì cấu trúc là phần cốt lõi ở quy mô lớn: tái dùng snapshot/export
qua owner, hỗ trợ dữ liệu có nguồn và review khác biệt, idempotency và rollback.
Nhập ban đầu/cập nhật không được buộc người vận hành vẽ lại hàng nghìn node.
Không tự quét mạng, clone repo hoặc nhập raw documents chỉ vì đã liên kết thư mục.

## 4. Phạm vi bản đầu

**Bản đầu = quản trị cấu trúc lớn + một luồng quan sát thiết bị thật hoàn chỉnh.**

| Trong phạm vi | Giới hạn thực hiện |
| --- | --- |
| Duyệt cây cấu trúc, inventory, tìm kiếm, lọc, sơ đồ theo phạm vi | Dùng cùng identity/selection; tải theo trang/subgraph, tránh dựng toàn bộ dự án trên một canvas |
| Thêm/sửa/nhập cấu trúc có validation, nguồn, revision và lịch sử | Tái sử dụng owner hiện có; nhập/thay thế phải có preview và kiểm tra xung đột |
| Quản lý software–infrastructure–device và quan hệ | Tách cấu hình mong muốn với trạng thái/phiên bản thực tế; có unknown khi thiếu nguồn |
| Quan sát trực tiếp tập thiết bị thật đã xác định | Một site/môi trường pilot, một protocol/adapter ban đầu; nguồn và quyền truy cập được phép |
| Trạng thái/lịch sử gần của thiết bị | Danh sách chỉ số, interval, timeout, TTL, retention và ngưỡng được chốt theo protocol/site |
| Điều tra một sự cố/thay đổi | Đi từ thiết bị lên phân hệ, xem phần phụ thuộc, nguồn dữ liệu và việc cần xử lý |
| Kiểm soát người dùng/collector qua dịch vụ | Identity, scope và audit phải có trước khi mở chia sẻ/mạng; quyền xem/sửa/quản lý kết nối tách biệt |
| AI đọc thông tin quản trị được phép | Dùng boundary hiện có nơi phù hợp; bổ sung observation contract riêng khi đủ nguồn và policy |

Mô hình nhiều site và tải lớn được thiết kế/benchmark; kết nối thật bắt đầu tại
một site. Số lượng thiết bị thật thử nghiệm không được báo thành quy mô production.

Ngoài bản đầu: điều khiển/deploy/OTA thiết bị, scan mạng tự động, marketplace,
multi-agent runtime, model training, CAD/mô phỏng, connector hàng loạt.
Tailscale hoặc gateway chỉ được chọn nếu đường kết nối pilot cần; không mặc định
xây thêm một nền tảng mạng. Google Drive vẫn là nguồn tài liệu tùy chọn, không
chặn nghiệm thu cấu trúc và thiết bị.

## 5. Quan sát thiết bị thật phải có nghĩa rõ ràng

Mỗi observation gắn device identity, site/environment, loại chỉ số/đơn vị, nguồn,
thời điểm thiết bị/collector (kèm thông tin đồng hồ nếu có), thời điểm nhận,
chất lượng và quy tắc hết hạn.

Giao diện tách ít nhất:

- Collector có kết nối/được cấp quyền hay không.
- Thiết bị hoặc endpoint có phản hồi theo phép kiểm tra đã định nghĩa hay không.
- Trạng thái chức năng đo được, chẳng hạn nhiệt độ hoặc health do thiết bị báo.
- Chưa có dữ liệu, dữ liệu cũ, lỗi thu thập, dữ liệu không hợp lệ hoặc bị thu hồi quyền.

Mất collector không tự chứng minh thiết bị đã hỏng. Có heartbeat không chứng minh
máy hoạt động đúng. Reconnect, dữ liệu trùng/lệch thứ tự, reset thiết bị và lệch giờ
phải có quy tắc. Trạng thái degraded/offline chỉ dùng khi nguồn và điều kiện đủ.

Telemetry dùng luồng/lưu trữ và retention riêng. Không tăng revision cấu trúc,
đưa vào undo của UI hoặc ghi toàn bộ project SQLite ở mỗi mẫu đo.
Có bounded queues, retry/backoff, backpressure và chính sách khi đầy; ghi rõ
khoảng mất dữ liệu, không âm thầm giả một lịch sử liên tục.

## 6. Kiến trúc: tái dùng lõi, bổ sung đường quan sát có kiểm soát

| Khối | Hiện trạng / quyết định |
| --- | --- |
| C++ typed core + Qt/SQLite adapters | Đã có project/topology/revision; tiếp tục là owner cấu trúc, bổ sung schema theo ADR khi cần |
| Qt desktop | Đã có library, inventory/canvas, work, impact; thiết kế lại điểm vào quanh cấu trúc và thiết bị |
| TS memory/context/impact | Đã có owner riêng; hỗ trợ tri thức/review, không sở hữu telemetry hoặc thay authority cấu trúc |
| Python SDK/MCP | Đã có boundary native; đọc observation cần contract mới. TS memory MCP tham chiếu vẫn chưa phải transport hoàn chỉnh |
| Control/ingest service và collector read-only | **Cần thiết kế và triển khai** identity/scope, nhận observation, query và adapter thiết bị; không coi stdio launcher hiện tại là service mạng |
| Observation storage | **Chưa có trong MVP hiện tại**; owner riêng, timestamp/cursor/retention, hợp đồng query có giới hạn |
| Drive adapter | Có mã/test session reader; OAuth đăng nhập thật và release acceptance còn thiếu |

Luồng đích: **thiết bị → collector chỉ đọc → dịch vụ ingest/query có quyền →
observation owner → desktop/Agent được cấp quyền**. Desktop sửa cấu trúc qua owner
cấu trúc; collector không có quyền sửa topology hoặc dispatch lệnh điều khiển.

C++/Qt/SQLite và Python boundary tiếp tục là nền tảng. Thiết kế service/collector
bổ sung phải chọn phương án nhỏ nhất theo protocol, workload và môi trường
triển khai; không port toàn bộ hệ thống hoặc thêm Protobuf/gRPC để mặc định mở rộng.

[ADR native](../adr/2026-10-11-native-topology.md) vẫn mô tả đúng **local MVP trước**.
Yêu cầu mới đã đưa live monitoring vào mục tiêu release; trước khi triển khai cần
ADR bổ sung về ownership observation, mạng, identity, lưu trữ và recovery.
Không sửa lịch sử ADR thành lời khẳng định telemetry đã tồn tại. Các
[ADR khác](../plans/README.md#architecture-decisions) giữ nguyên contract đã nhận.

**[CẢNH BÁO BẢO MẬT]** Kho topology hiện chưa mã hóa; quyền launcher cùng người dùng
hệ điều hành không phải sandbox/RBAC. Kết nối thiết bị thật có credential và rủi ro
ảnh hưởng mạng/thiết bị dù chỉ đọc. Trước pilot phải có endpoint được phép, tài khoản
tối thiểu, nơi giữ credential an toàn, giới hạn tải đọc, thu hồi và ngắt collector.
Không đưa secret vào SQLite topology, mã nguồn, log, chat hoặc context AI.
Dữ liệu nhạy cảm cần mã hóa/kiểm soát khóa và quyền phù hợp trước khi lưu.
Trước push/publication kiểm tra .gitignore và chạy lmti publish preflight.

Nhiều người dùng cần service identity/quyền thực thi ở server và audit; không
chia sẻ trực tiếp file SQLite qua mạng rồi coi là đã có phối hợp an toàn.
Triển khai xác thực/phân quyền cơ bản là điều kiện của chia sẻ/mạng, không để sau pilot.
LIVE-ADR-01 phải chọn rõ profile một người dùng local hoặc profile chia sẻ.
Trong profile chia sẻ, mọi ghi cấu trúc đi qua dịch vụ xác thực → owner; desktop
không có đường ghi SQLite trực tiếp vượt quyền. Quyền filesystem phải phù hợp.
Đường observation phải xác thực nguồn/endpoint và bảo vệ credential/dữ liệu khi
truyền. Dùng kênh mã hóa khi giao thức hỗ trợ; thiết bị legacy cần ranh giới
mạng/gateway, phạm vi tin cậy và rủi ro được đánh giá trước pilot.

## 7. Hiện trạng và khoảng trống

| Đã có mã và bằng chứng local alpha | Còn phải thiết kế/kiểm chứng |
| --- | --- |
| Project/component/release/device/work, topology và quan hệ khai báo | Phân cấp dự án lớn đầy đủ, vòng duy trì nguồn và ownership theo phạm vi |
| SQLite có revision; thao tác lưu/mở và UI thử nghiệm | Query/render ở workload mục tiêu, cập nhật đồng thời và recovery |
| Snapshot native, impact và review có evidence | Quan hệ với observation thật, semantics tình trạng và sự cố |
| SDK/MCP, context/privacy/lesson | Service/collector được xác thực, observation API và nghiệm thu Agent trên trạng thái thật |
| Package trên máy dev | Cài đặt sạch cả desktop và collector/service theo profile đã chọn |
| Drive session reader có test mô phỏng | OAuth thật, chưa tự trở thành nguồn AI |

Chưa có telemetry thật, gateway production, RBAC nhiều người dùng hoặc bằng chứng
quy mô lớn trong bản hiện tại. Các báo cáo [native impact](../plans/2026-10-13-native-impact-review.md),
[UI](../plans/2026-10-13-simple-studio.md), [Drive](../plans/2026-10-13-google-drive.md) và
[support map](../component-support.md) ghi phạm vi bằng chứng, không nghiệm thu r2.

Snapshot/context hiện có các giới hạn kích thước và có đường xử lý toàn bộ tài
liệu. M2 cần đo chi phí load/save/query và thiết kế phân trang/snapshot nhất quán
nếu cần; không chỉ tăng giới hạn số bản ghi rồi coi là đã hỗ trợ dự án lớn.

## 8. Lộ trình và backlog duy nhất

| Mốc | Đầu việc | Điều kiện hoàn tất |
| --- | --- | --- |
| **M0 — Chốt phạm vi** (hiện tại) | PLAN-02: sửa định vị, capability map và roadmap theo cấu trúc lớn + thiết bị thật | Hướng sản phẩm đã được người dùng xác nhận; thông số pilot còn mở được ghi rõ |
| **M1 — Thiết kế cấu trúc và đường quan sát** | MODEL-01: identity/phân cấp/quan hệ/import; UX-01: cây–sơ đồ–chi tiết–trạng thái; LIVE-ADR-01: protocol, collector/service, quyền và workload | Chủ sản phẩm duyệt prototype và thiết kế; xác định thiết bị/nguồn thật, scope/quyền, kế hoạch migration và ngưỡng nghiệm thu |
| **M2 — Hoàn chỉnh quản trị cấu trúc** | STRUCT-01: bổ sung phần thiếu, import/delta review, tìm kiếm, dependency, owner/history và lưu/mở; đo tải cấu trúc sớm | Một dự án đại diện quản trị được từ tổng thể đến thiết bị, bảo toàn identity/quan hệ; lỗi và xung đột không làm mất dữ liệu |
| **M3 — Theo dõi thiết bị thật** | OBS-01: service/collector/observation store/API + UI trạng thái; quyền/audit trước kết nối; một adapter thực | Nhận dữ liệu thật, đúng identity/thời gian; reconnect/revoke/TTL/retention/backpressure đạt; không có ghi/điều khiển thiết bị |
| **M4 — Nghiệm thu quy mô và phát hành giới hạn** | SCALE-01: workload công bố, vận hành dài hạn và lỗi; PACK-01: Windows sạch, cài collector, backup/recovery, hướng dẫn | Người vận hành thứ hai dùng được; đạt tải và an toàn đã khóa; nghiệm thu site thật và giới hạn hỗ trợ công khai rõ |

Mỗi mốc có một đầu ra sản phẩm; có thể song song kiểm thử các phần của cùng mốc.
Thực hiện đủ M2 **và M3** mới đáp ứng bản đầu đã chọn. Không đổi “theo dõi thật”
thành demo mô phỏng để đánh dấu hoàn thành.

M1 phải đóng khoảng trống kiến trúc của live monitoring, không chỉ duyệt màu sắc
hay số mục sidebar. Lịch và ước lượng công việc được chốt sau thiết bị/protocol,
workload và prototype; không tái sử dụng lịch sáu tuần cũ.

## 9. Thế nào là quy mô lớn và thế nào là đạt

Quy mô là một workload có số đo, không phải tên gọi. Đề xuất các bậc thử để thiết kế:
1.000 rồi 10.000 thành phần, quan hệ theo dữ liệu đại diện và nhiều phân hệ/site
trong mô hình. Đây là **mục tiêu thử đề xuất**, chưa được người dùng chốt hoặc đo đạt.
Không suy ra số kết nối thiết bị đồng thời từ số node cấu trúc.

M1 phải ghi rõ: số project/site/component/relation/device; concurrent users/readers;
devices quan sát đồng thời; metrics/device; tần suất, burst, retention, downtime và
yêu cầu truy vấn. Công thức tải quan sát và dung lượng phải tính theo workload đó.

Nghiệm thu release tập trung vào:

1. **Đúng cấu trúc:** số lượng/import được đối soát, identity ổn định, quan hệ đúng,
   không mất bản ghi khi phân trang/đổi nguồn; đổi tên/thay thiết bị không gộp sai.
2. **Dùng được:** tìm thành phần, biết owner/vị trí, đi từ hệ xuống thiết bị và từ
   thiết bị tới phần phụ thuộc; sửa/nhập/lưu/mở mà không mất nháp hoặc lịch sử.
3. **Quan sát thật:** đối chiếu nguồn độc lập, đúng thời gian/identity, không giả online;
   có thử mất kết nối, timeout, stale, dữ liệu trùng/lệch thứ tự và thu hồi quyền.
4. **Đáp ứng tải:** đo p95 truy vấn/tìm kiếm, frame time UI, độ trễ ingest→hiển thị,
   CPU/RAM, hàng đợi, tốc độ tăng kho và recovery. Khóa ngưỡng trên máy/workload
   được chọn trước nghiệm thu; không kéo toàn bộ graph/telemetry vào UI hoặc context.
5. **Quyền và vận hành:** từ chối đọc/ghi ngoài scope, credential không rò,
   collector chỉ đọc; retry không gây bão request; đầy ổ/mất điện/phục hồi không
   tạo báo cáo sai; người thứ hai cài và vận hành qua hướng dẫn.
6. **Hỗ trợ AI:** câu trả lời tra đúng cấu trúc/observation được phép, dẫn nguồn
   và freshness, không tự nâng quyền hoặc coi suy luận thành trạng thái đo được.

Tiết kiệm thời gian quản trị/review là phép đo bổ sung. Mục tiêu 20% và bộ 20 tình
huống trong [impact evaluation](../impact-evaluation.md) chỉ áp dụng khi đánh giá
riêng tính năng impact; không còn là gate quyết định toàn bộ sản phẩm.

## 10. Trải nghiệm giao diện

Điểm vào là **dự án và bản đồ cấu trúc**. Đi sâu theo phân hệ hoặc vị trí, tìm thành
phần, xem quan hệ và trạng thái thật ngay trong ngữ cảnh đó.

Cây, bảng inventory và sơ đồ là các view của cùng dữ liệu; panel chi tiết chứa
thuộc tính, desired/observed, lịch sử, nguồn, tài liệu và công việc liên quan.
Tải tổng hợp ở tầng trên, tải chi tiết khi mở; giữ chọn/zoom/filter khi quay lại.
Hiển thị tình trạng chưa kết nối hoặc nguồn cũ rõ ràng.

AI hỗ trợ theo phần đang chọn; người dùng vẫn quản trị được khi không có model.
Drive và memory nằm trong nguồn/tài liệu, không chiếm luồng chính.
[Phụ lục UX](../plans/2026-10-13-experience-plan.md) mô tả prototype cần duyệt.
EN mặc định, VI tùy chọn; giữ nháp, bàn phím và kích thước cửa sổ nhỏ.

## 11. Thông tin còn cần trước triển khai live

Hướng cấu trúc lớn + trạng thái thật đã chốt. Các thông số sau chưa được cung cấp:

- Site/môi trường và tập thiết bị được phép dùng; người vận hành nghiệm thu.
- Loại thiết bị, protocol/API, đường mạng, dữ liệu đọc được và tài khoản tối thiểu.
- Số lượng/tần suất/retention/concurrency và máy chạy service/collector.
- Phạm vi một người quản trị hay nhóm dùng chung; nơi giữ credential, phân loại dữ liệu.
- Chỉ số/trạng thái nào có ý nghĩa, phép đối soát và điều kiện stale/offline.
- Ngân sách công việc và lịch pilot sau khi có thiết kế/ước lượng.

Có thể tiếp tục mô hình/wireframe với fixture được ghi rõ trong lúc chờ thông số.
Không chọn bừa MQTT/OPC UA hoặc một vendor, không truy cập mạng/thiết bị khi chưa
có đích và phạm vi được phép. Nếu gặp blocker giao thức, báo cụ thể; không tự cắt
live monitoring ra khỏi release.

## 12. Quy tắc giữ tập trung và tài liệu

Mọi ticket phải phục vụ: **mô hình hóa → quản trị → quan sát → điều tra/thay đổi**,
ghi owner, đầu ra, kiểm thử và phạm vi. Ý tưởng mới phải nêu ưu tiên bị thay thế;
không thêm roadmap ngang hàng. Tái sử dụng phần đã có và bảo toàn TS/Go/memory.
Schema mới có migration/rollback; quyền mới có thiết kế boundary.

Một bản build pass là bằng chứng kỹ thuật; nghiệm thu operator, thiết bị thật và
quy mô là ba bằng chứng riêng. Không dùng mock, snapshot cũ hoặc benchmark graph
để thay thế chúng. Nếu không đạt, sửa đúng bottleneck trước khi mở rộng.

Hiến chương và chỉ đạo người dùng giữ nguyên tắc; master này quyết định thứ tự;
ADR quyết định contract; [support map](../component-support.md) ghi capability;
[chỉ mục](../plans/README.md) giữ bằng chứng. [Master cũ](../archive/2026-10-13-master-plan-before-consolidation.md)
và [r1 chưa được chấp nhận](../archive/2026-10-13-master-plan-r1.md) là lịch sử.

Lượt này chỉ cập nhật kế hoạch. Bước kế tiếp là **MODEL-01 + UX-01 + LIVE-ADR-01
trong M1**, để có bản thiết kế quản trị và đường theo dõi thiết bị đủ rõ trước code.

