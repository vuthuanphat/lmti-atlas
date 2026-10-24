> Historical r1 proposal, superseded by the owner's explicit priority:
> large-project structure governance and real-device state monitoring.
> Use the [current master](../LMTI_MASTER_PLAN.md). r1's task/memory-centered
> release and value gates were not accepted. Relative links were rebased.

# LMTI — Kế hoạch sản phẩm và phát triển thống nhất

Ngày: 2026-10-13. Phiên bản kế hoạch: r1, hợp nhất để chủ sản phẩm chốt.
**Trạng thái hiện tại: M0 — lập kế hoạch; chưa triển khai các mốc mới.**

Đây là nơi duy nhất quyết định ưu tiên, phạm vi release và thứ tự công việc.
Yêu cầu hiện tại là chốt toàn bộ kế hoạch trước khi xây tiếp. Những hướng đã được
người dùng xác nhận được ghi riêng với lựa chọn đề xuất dưới đây; tài liệu không
coi việc đọc kế hoạch là chấp thuận prototype, mở dữ liệu thật hoặc phát hành.

## 1. Định vị duy nhất

**LMTI giúp người và AI giữ được hiểu biết đáng tin về một dự án, dùng đúng ngữ
cảnh để làm việc và kiểm chứng thay đổi trước khi tái sử dụng kết quả.**

Lời hứa cần chứng minh: mở lại một dự án ở phiên sau, hiểu việc đang làm và lý do
của các quyết định; khi thay đổi, biết phần liên quan, căn cứ và việc cần xác minh.

- Người dùng đầu tiên: kỹ sư/tech lead phối hợp với một AI Agent trên dự án
  phần mềm–phần cứng/IoT. Đây là ưu tiên người dùng đã chọn.
- Người đánh giá kết quả: người hiểu hệ thống, chịu trách nhiệm review và xác minh.
- Tầm nhìn: nền tảng hiểu biết dùng lại trong nhiều loại dự án con người làm với AI.
  Mỗi domain mới phải chứng minh lại giá trị và có adapter riêng.
- Kiến trúc sản phẩm: nền tảng memory/context/privacy/verification/lesson;
  Architecture Studio là ứng dụng cho phần mềm–phần cứng và topology;
  connector cung cấp nguồn theo quyền. Ba lớp cùng phục vụ một luồng công việc.
- Giá trị của thiết kế: lưu mô hình thành phần, quan hệ và quyết định có căn cứ để
  người/Agent hiểu hệ thống. CAD, thiết kế đồ họa tổng quát và mô phỏng cần phạm vi riêng.
- Định vị local alpha tiếp tục theo hiến chương: dữ liệu cục bộ, context nhỏ,
  có nguồn, hỗ trợ nhiều Agent qua hợp đồng thay thế được.

## 2. Những gì đã chốt và quyết định của bản r1

| Loại | Nội dung |
| --- | --- |
| Đã được người dùng xác nhận | IoT/phần mềm–phần cứng là nhóm chứng minh đầu tiên; toàn bộ UI cần đơn giản; Drive kết nối nhanh và đọc thư mục chọn; lập kế hoạch trước khi xây tiếp |
| Ràng buộc kiến trúc đã nhận | C++ core, Qt desktop/SQLite, Python SDK/MCP, TS memory độc lập; bảo toàn tương thích Go; không thực thi thiết bị trong local MVP |
| Đề xuất r1 để chốt | Một release hoàn thành luồng nhiệm vụ → context → review → kiến thức dùng lại; M0–M4 tuần tự; Drive là nguồn tùy chọn; một backlog duy nhất |
| Còn chốt đúng thời điểm | Bố cục và Agent client/đường truy cập qua M1; người chấm/dữ liệu/ngân sách ở M3; OAuth nhà phát hành khi nhận Drive vào release |

Không cần quyết định cloud, giá bán, hỗ trợ mọi loại dự án hoặc giao thức thiết bị
để hoàn thành release này. Câu hỏi về ô nhập mục tiêu/sidebar thuộc M1 và không
tách thành hướng phát triển sản phẩm khác.

## 3. Release kế tiếp: một vòng làm việc hoàn chỉnh

Tên phạm vi: **Local alpha — hiểu dự án và review thay đổi cùng AI**.
Đây là tên mốc, không tự đổi phiên bản package hoặc hứa ngày phát hành.

Một người dùng phải làm được chuỗi sau trên cùng dự án:

1. Mở/tạo dự án, chọn hoặc ghi mục tiêu công việc.
2. Chuẩn bị và liên kết nguồn được phép bằng owner hiện có, rồi xác định
   component/thiết bị/tài liệu liên quan. Với dự án mới, hướng dẫn init/compile và
   Connect source rõ ràng; không giả định tạo/link dự án đã tự tạo memory.
3. Xem context có nguồn, phạm vi, revision và phần thiếu trước khi dùng với Agent.
4. Một Agent client thật nhận context qua boundary hỗ trợ và hỗ trợ nhiệm vụ;
   các đề xuất có cấu trúc chỉ nằm trong contract hiện có.
5. Review ảnh hưởng dựa trên quan hệ có căn cứ, ghi việc cần xác minh và bằng chứng;
   người có trách nhiệm quyết định trạng thái xác minh.
6. Lưu kết quả, đề xuất lesson nếu có kiến thức tái sử dụng; review lesson riêng.
7. Mở phiên mới để tiếp tục từ nguồn hiện hành và lesson đã được duyệt.

“Hồ sơ công việc” ở đây là cách trình bày các bản ghi và tham chiếu sẵn có,
không yêu cầu tạo một database hoặc mô hình domain tổng hợp mới.

Nghiệm thu bao gồm cả dự án mẫu chưa chuẩn bị memory từ trước và dự án mở lại.
Chỉ nối luồng/hướng dẫn các lệnh owner đã hỗ trợ; không tự quét/nhập nguồn hoặc
tạo kho tri thức chỉ vì người dùng liên kết một thư mục.

Kịch bản nghiệm thu đề xuất: một bộ đo nhiệt độ → gateway → dịch vụ/dashboard.
Thay đổi hợp đồng dữ liệu firmware; review các bên phụ thuộc, nguồn thiếu/cũ,
checklist xác minh và kết quả ở phiên sau. Dùng dữ liệu mô phỏng không nhạy cảm.
Fixture kho/xuất hàng hiện có tiếp tục làm bằng chứng hồi quy; không xây demo
domain thứ hai chỉ để đổi câu chuyện. Chốt fixture nhỏ nhất có thể tái sử dụng ở M1.

## 4. Hiện trạng thực tế

Đối chiếu hồ sơ ngày 2026-10-13. “Có mã + kiểm thử” khác “đã nghiệm thu sản phẩm”.
Lượt hợp nhất kế hoạch chỉ kiểm tra tài liệu; không chạy lại build/test ứng dụng.

| Thành phần | Đã có | Phần cần khép lại cho release |
| --- | --- | --- |
| Memory, compiler, context, privacy và lesson | TS CLI, memory owner, freshness/policy và review flows | Đo khả năng dùng lại trong phiên Agent thật; xử lý lỗi/nguồn thiếu dễ hiểu |
| Projects, work, milestone, component/release, thiết bị, topology | C++/Qt local alpha và SQLite có revision | Chọn đường đi tối thiểu, nghiệm thu thao tác, nháp, save/reopen và recovery |
| Knowledge/Agent bridge | Adapter và scoped SDK/MCP; kiểm thử boundary | Một product Agent client thật chạy luồng đã chọn; không lấy test transport thay nghiệm thu này |
| Impact/evidence | Snapshot native → TS, báo cáo, review và lịch sử | Oracle độc lập, người khác tiếp tục review, đo công cập nhật mapping |
| Giao diện | Nhiều đợt UI; bản tham chiếu mới nhất: studio-simple-20261013 | Chưa chốt trải nghiệm cuối; duyệt prototype trước lần sửa tiếp |
| Google Drive | Đăng nhập/chọn thư mục/đọc trong phiên đã có mã và test mô phỏng | OAuth publisher, consent/login/read thật, lỗi/thu hồi quyền và đóng gói |
| Phân phối | Có package chạy trên máy phát triển | Windows sạch không phụ thuộc toolchain dev, hướng dẫn cài/chạy, backup/recovery |
| Giá trị kinh doanh | Có protocol đo | Chưa có kết quả pilot, chưa chứng minh giảm công hoặc nhu cầu trả tiền |

Bằng chứng theo đợt: [UI đơn giản](../plans/2026-10-13-simple-studio.md),
[native impact](../plans/2026-10-13-native-impact-review.md),
[Drive](../plans/2026-10-13-google-drive.md), [ownership](../component-support.md).
Kết quả kiểm thử trong các hồ sơ là kết quả của đúng bản/đợt đó.

## 5. Phạm vi giữ, hỗ trợ và tạm dừng

| Nhóm | Quyết định cho release này |
| --- | --- |
| Cốt lõi bắt buộc | Dự án/nhiệm vụ, mô hình quan hệ đủ dùng, context theo policy, Agent client thật, review có evidence, lesson có review, tiếp tục phiên sau |
| Trình bày bắt buộc | Một điểm bắt đầu rõ, trạng thái nguồn/lưu dễ hiểu, chi tiết mở khi cần, EN mặc định/VI tùy chọn, bàn phím và cửa sổ nhỏ |
| Dùng lại có giới hạn | CRUD, canvas, work/release/inventory hiện có; chỉ sửa khi phục vụ luồng nghiệm thu hoặc độ tin cậy |
| Drive tùy chọn | Giữ adapter đã xây; bật lời hứa kết nối thật khi đủ OAuth và bằng chứng. Local source phải dùng độc lập được |
| Khai thác nội dung Drive cho AI | Tách khỏi đọc cục bộ; chỉ mở sau thiết kế policy/consent/provenance và duyệt phạm vi |
| Chat AI nhúng, chọn model, tự điều phối nhiều Agent | Tạm dừng. Hoàn thành tích hợp một Agent client trước; ô mục tiêu trong prototype không được giả làm chat đang hoạt động |
| Gateway, Tailscale, telemetry, scan mạng, điều khiển/deploy thiết bị | Tạm dừng; chỉ xem lại khi có nhu cầu vận hành đã đo và thiết kế quyền, cách ly, audit, phục hồi riêng |
| Cloud sync, nhiều người dùng/site, dịch vụ server, marketplace | Tạm dừng; cần bằng chứng local alpha và yêu cầu sử dụng cụ thể |
| Port ngôn ngữ, gộp kho, đổi namespace, graph/vector infrastructure mới | Tạm dừng; chỉ mở từ bottleneck được đo hoặc yêu cầu tương thích thực tế |
| CAD/mô phỏng/thiết kế đa ngành, connector hàng loạt | Tầm nhìn dài hạn; từng domain cần một tình huống và người nghiệm thu riêng |

“Tạm dừng” giữ nguyên mã/dữ liệu/tương thích đã có. Đây là quyết định về công việc
mới, không phải yêu cầu xóa tính năng hay bỏ các lỗi cần sửa.

## 6. Kiến trúc và dữ liệu cố định trong đợt này

| Owner | Trách nhiệm và hợp đồng |
| --- | --- |
| C++ domain + SQLite adapters | Project/topology, validation, revision và ghi tài liệu |
| Qt desktop | Trình bày, thao tác và review qua owner; không sao chép engine hoặc đọc kho của owner khác |
| TS memory/compiler/privacy | Project Atlas, memory, context và lifecycle lesson |
| TS impact/evidence | Projection có revision, assertions/evidence, báo cáo và lịch sử review |
| Python SDK/MCP + CLI boundary | Context/proposal trong scope do launcher cấp; không trao SQLite handle hoặc shell tùy ý cho Agent |
| Drive adapter | OAuth/session và đọc nguồn; không ngầm chuyển tài liệu thành memory/context |

ADR đã nhận tiếp tục có hiệu lực: [native](../adr/2026-10-11-native-topology.md),
[project](../adr/2026-10-11-project-document.md), [knowledge](../adr/2026-10-12-desktop-knowledge.md),
[impact](../adr/2026-10-12-evidence-impact.md), [native review](../adr/2026-10-13-native-impact-review.md),
[Drive](../adr/2026-10-13-google-drive.md). Kế hoạch chỉ thay thứ tự công việc, không
ghi đè contract an toàn. JSON ở biên; mỗi schema có một owner; TS/Go giữ tương thích.

M1 phải chọn Agent client dùng thử và ghi rõ đường CLI/MCP/export được hỗ trợ
cho từng loại context, impact và lesson. Python native MCP không đồng nghĩa TS
memory đã có MCP transport hoàn chỉnh; phần memory MCP tham chiếu vẫn là stub.
Kiểm kê khoảng trống trước khi hứa trải nghiệm thống nhất; ưu tiên đường owner
sẵn có, không dựng thêm một framework để nối các phần này.

**[CẢNH BÁO BẢO MẬT]** Kho topology hiện chưa mã hóa; launcher cùng người dùng hệ
điều hành không phải sandbox hay phân quyền nhiều người. Nghiệm thu hiện tại dùng
dữ liệu mẫu/không nhạy cảm. Tiếp nhận dữ liệu nhạy cảm cần thiết kế và kiểm chứng
bảo vệ tương ứng trước, không chỉ thêm nhãn privacy trên giao diện.

Tài liệu bên ngoài là dữ liệu, không cấp quyền cho Agent. Source thiếu/cũ hoặc vượt
giới hạn phải thể hiện unknown/stale/incomplete; không kết luận “không ảnh hưởng”
từ dữ liệu thiếu. Không tự xác minh, tự duyệt lesson hoặc đẩy dữ liệu tới model.
Không lưu secrets/raw chat/raw customer data vào memory. Trước push/publication,
kiểm tra .gitignore và chạy lmti publish preflight theo hiến chương.

## 7. Một lộ trình M0–M4

| Mốc | Đầu ra bắt buộc | Điều kiện hoàn tất |
| --- | --- | --- |
| **M0 — Chốt sản phẩm** (hiện tại) | Master duy nhất, scope, hiện trạng, thứ tự và danh mục kế hoạch cũ | Chủ sản phẩm chốt r1; tài liệu không còn backlog chính cạnh tranh |
| **M1 — Chốt luồng và prototype** | Một fixture, ba hành trình, wireframe/mẫu tương tác có trạng thái trống/lỗi; ánh xạ công cụ cũ và đường truy cập của một Agent client thật | Chủ sản phẩm đi qua được kịch bản và duyệt; contract Agent khả thi; sau đó mới ước lượng phần sửa mã |
| **M2 — Khép vòng sản phẩm** | Thực hiện chuỗi ở mục 3, dùng owner sẵn có và một Agent client thật; tài liệu chạy từ đầu | Save/reopen, phiên Agent mới, source update/thu hồi quyền/lỗi, lesson review và nháp được kiểm chứng; không có bước dev bí mật |
| **M3 — Đo khả dụng và giá trị** | Người thử, đáp án độc lập, so baseline, log tổng công và chất lượng; sửa các lỗi cản luồng | Chất lượng và giá trị đạt tiêu chí khóa trước khi đo, người thứ hai duy trì được; nếu thu hẹp phạm vi, khóa tiêu chí và đo lại trước M4 |
| **M4 — Đóng gói local alpha/pilot giới hạn** | Gói chạy trên Windows sạch, hướng dẫn/support scope, backup/recovery; báo cáo phần còn thiếu | M2/M3 đạt; người dùng nghiệm thu; dữ liệu/pilot được cho phép. Tính năng Drive chỉ được nhận nếu đủ evidence riêng |

Chuẩn bị test/package trong M2 khi cần để phát hiện lỗi sớm; bằng chứng phát hành
thuộc M4. Lượt lập kế hoạch này không mở auth thật, pilot dữ liệu khách hàng,
publish hay gửi lời mời bên ngoài.

Không khởi động lại P0–P6/S0–S5/L0–L3/U1–U5 hoặc lịch W1–W6 cũ. Ước lượng
công việc **còn thiếu** sau M1 và kiểm kê M2; lịch sáu tuần cũ là giả thuyết lịch sử,
không là deadline hiện hành. Mỗi mốc báo đầu ra, bằng chứng, blocker và phần còn lại.

## 8. Backlog duy nhất và thứ tự

| ID | Công việc | Owner làm / người nghiệm thu | Ưu tiên |
| --- | --- | --- | --- |
| PLAN-01 | Hợp nhất master, roadmap và chỉ mục hồ sơ | Research engineer / chủ sản phẩm | M0: tài liệu đã hợp nhất; chờ chốt |
| UX-01 | Prototype một kịch bản, trạng thái lỗi và ánh xạ trang | UI engineer / chủ sản phẩm | Kế tiếp sau M0 |
| FLOW-01 | Kiểm kê khoảng trống; chuẩn bị/liên kết nguồn cho dự án mới bằng owner hiện có; nối nhiệm vụ → context → Agent → review → dùng lại | Các owner hiện có / kỹ sư dùng thử | M2, sau UX-01 |
| REL-01 | Nháp, revision/freshness, nguồn thiếu, policy, lookup/recovery và kiểm thử phù hợp | Domain/adapter/UI owners / reviewer kỹ thuật | Là điều kiện của FLOW-01, không nhánh mở rộng |
| EVAL-01 | Thử người dùng + đo đối chứng và công duy trì | Engineer đo / chủ hệ thống hoặc SME độc lập | M3 |
| PACK-01 | Windows sạch, launcher/support, backup/recovery và bản nghiệm thu | Release engineer / người dùng thứ hai | M4 |
| DRIVE-01 | Cấu hình publisher + kiểm chứng account thật/consent/read/revoke | Chủ phát hành + adapter owner / người dùng thử | Tùy chọn M4; thiếu thì giữ trạng thái chưa khả dụng |

Owner là vai trò, không giả định đã có đội ngũ riêng. Chủ sản phẩm chỉ định người
thử/SME khi đến mốc đo. Engineer không tự thay nghiệm thu độc lập bằng kết quả tự chấm.

## 9. Nghiệm thu và điều kiện dừng

Các ngưỡng dưới đây là **mục tiêu đề xuất**, chưa phải thành tựu:

- Khả dụng: biết dự án và bước tiếp theo trong 30 giây; tạo nhiệm vụ mẫu đầu tiên
  trong 2 phút. Ba hành trình thực hiện không cần người hướng dẫn chỉ vị trí.
- Hiểu biết: người thử tìm được nguồn, revision, phần chưa xác minh; phiên mới dùng
  lại được context hiện hành/lesson đã duyệt và biết khi nguồn đã đổi.
- Tin cậy: không mất dữ liệu/bản nháp; có đường quay lại/hủy; phạm vi policy giữ
  nguyên qua UI/Agent; lỗi nguồn, thu hồi quyền, conflict và giới hạn được báo đúng.
- Khả dụng kỹ thuật: EN/VI, bàn phím, 1280×720 và 1440×900; thao tác dài có phản
  hồi/hủy, I/O và kết quả có giới hạn. Đo hiệu năng trên fixture và máy được ghi rõ;
  chốt budget sau baseline, không hứa hàng nghìn thiết bị từ thử nghiệm nhỏ.
- Giá trị: mục tiêu giảm ít nhất 20% **tổng công người** gồm nhập ban đầu, cập nhật
  mapping, xử lý stale/conflict, review và sửa sai; chất lượng không giảm, không
  có critical miss hoặc lộ dữ liệu trong bộ đánh giá. Chi phí model ghi riêng.
- Đối chứng: cùng Agent/model, thông tin được phép và ngân sách; theo
  [protocol đánh giá](../impact-evaluation.md), có oracle và holdout độc lập. Smoke
  nhỏ chỉ chứng minh luồng, không thay kết quả formal 20-case workload.
- Duy trì: người thứ hai cập nhật một thay đổi nguồn và tiếp tục review qua hướng
  dẫn; ghi công và lỗi của người đó.

Nếu công duy trì triệt tiêu lợi ích: giảm số nguồn/quan hệ hoặc sửa luồng cập nhật.
Nếu người thử không hiểu: quay về prototype. Nếu kết quả ngang baseline: thu hẹp
lời hứa và đo lại. Nếu có lỗi dữ liệu/quyền nghiêm trọng: sửa và kiểm chứng trước
khi mở rộng. Kết quả không đạt không được bù bằng thêm màn hình hoặc connector.

## 10. Quy tắc để không build lan man

1. Mỗi lúc chỉ có **một mốc sản phẩm đang triển khai**. Có thể song song kiểm tra
   các phần phục vụ cùng đầu ra, không mở nhiều roadmap độc lập.
2. Mỗi ticket phải trỏ tới một bước ở mục 3, nêu vấn đề, owner, đầu ra quan sát được,
   bằng chứng nghiệm thu, rủi ro dữ liệu và phạm vi loại trừ.
3. Ý tưởng mới ghi vào nhóm hoãn ở mục 5. Muốn ưu tiên ngay phải nêu công việc nào
   bị thay thế và được chủ sản phẩm quyết định; không tự cộng vào release.
4. UI đi qua prototype trước code. Một mốc đã được duyệt cho phép thực hiện các
   bước kỹ thuật thường lệ; không xin lại xác nhận cho từng sửa chữa/kiểm tra nhỏ.
5. Một bản build chỉ được ghi “đạt kỹ thuật” khi có evidence; “đạt sử dụng” cần
   người dùng; “đạt giá trị” cần phép đo. Không dùng ba nhãn thay cho nhau.
6. Giữ compatibility và dữ liệu hiện có. Migration, quyền mới, nguồn dữ liệu mới
   hoặc mô hình triển khai mới cần thiết kế riêng, không lồng vào dọn UI.
7. Cập nhật cùng master này khi đổi phạm vi. Chỉ tạo ADR khi đổi contract và
   execution record khi có bằng chứng; không tạo thêm một master plan cạnh tranh.

## 11. Sau local alpha

Chỉ chọn **một** hướng mở rộng sau M4 dựa trên kết quả:

- Nhiều dự án/nguồn hơn: nếu duy trì tri thức là nút thắt, ưu tiên cập nhật nguồn
  và connector có chủ dữ liệu/nghiệm thu.
- Domain khác: thử cùng vòng công việc với người dùng ngoài IoT; tách adapter
  domain, giữ nền tảng context/privacy/verification.
- Làm việc nhóm hoặc dữ liệu nhạy cảm: thiết kế identity, mã hóa, khóa, audit và
  recovery trước khi nhận dữ liệu/quyền mới.
- Quan sát/vận hành thiết bị: cần bài toán, giao thức/site và quyền được phép;
  một pilot chỉ đọc riêng trước khi xem xét thao tác ghi.

Thương mại hóa cần người dùng thật chứng minh nhu cầu và mức sẵn sàng trả tiền.
Mô hình giá/hosting không nằm trên đường hoàn thành local alpha hiện tại.

## 12. Thứ bậc tài liệu

- [Hiến chương](../../AGENTS.md) và chỉ đạo người dùng: nguyên tắc, quyền và phạm vi.
- **Master này:** định vị, release, ưu tiên và mốc hiện hành.
- [ADR](../plans/README.md#architecture-decisions): contract kiến trúc được nhận.
- [Support map](../component-support.md), hướng dẫn vận hành: owner và khả năng hiện có.
- [Chỉ mục kế hoạch/bằng chứng](../plans/README.md): lịch sử theo đợt và phụ lục M1.
- [Master trước hợp nhất](../archive/2026-10-13-master-plan-before-consolidation.md):
  lưu dấu vết; các lịch/backlog cũ không còn là thứ tự thực hiện.

**Bước tiếp theo duy nhất:** chốt r1, rồi UX-01 với một prototype xuyên suốt.
Chưa sửa tiếp ứng dụng, đổi công nghệ hoặc mở thêm nhánh tính năng ở bước lập kế hoạch.
