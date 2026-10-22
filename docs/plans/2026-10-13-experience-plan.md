# LMTI — Trải nghiệm kết nối Agent và quản trị nguồn dự án

Ngày: 2026-10-13. Trạng thái: **luồng kết nối trước r4, prototype chưa nghiệm thu**.

Ưu tiên hiện tại là [CP-01: bộ MCP theo dự án dùng chung Codex/Cursor](2026-10-13-project-mcp-profile.md).
Luồng/màn hình kết nối bên dưới là thiết kế trước khi chủ sản phẩm làm rõ quản
trị MCP. Dùng CP-01 cho điểm vào và thiết lập; giữ phần cấu trúc/IoT/review dưới
đây làm tham chiếu cho các gate sau. Không sửa Qt theo prototype cũ như đã được duyệt.

[Master](../LMTI_MASTER_PLAN.md) là kế hoạch duy nhất. LMTI là lớp giữa Agent và
dự án. Giao diện giúp con người cấu hình, hiểu dữ liệu LMTI cung cấp và kiểm soát
đề xuất; chủ sản phẩm đã yêu cầu thực hiện master r3. Gói M1 hiện có
[prototype tương tác](../design/2026-10-13-agent-layer/index.html) và
[contract/client evidence](2026-10-13-agent-layer-m1.md); nghiệm thu UX còn mở.

## 1. Trải nghiệm chính

Người dùng tiếp tục làm việc với Agent trong công cụ quen thuộc. Agent gọi LMTI
để lấy cấu trúc, context, quan hệ và observation được phép. Người dùng mở LMTI khi
cần kết nối nguồn, kiểm tra mapping/bằng chứng hoặc review.

Không yêu cầu mở desktop cho mỗi truy vấn Agent. LMTI vẫn cho phép con người duyệt
cấu trúc và trạng thái trực tiếp, dùng cùng identity/source/freshness semantics.

## 2. Ba hành trình phải thử trước khi viết UI mới

| Hành trình | Luồng mẫu | Bằng chứng thành công |
| --- | --- | --- |
| Kết nối dự án với Agent | Chọn dự án → thêm nguồn/phạm vi → preview mapping/quyền → kết nối một client → thử truy vấn | Người dùng biết Agent được thấy gì; câu trả lời có nguồn và phần thiếu; không yêu cầu nhập lại inventory có sẵn |
| Hiểu cấu trúc và trạng thái | Agent hỏi về component/firmware → LMTI nối code–release–thiết bị → người dùng kiểm tra entity/evidence/observation | Đúng identity, phân biệt khai báo/desired/observed, biết thời điểm và nguồn; truy được quan hệ theo phạm vi |
| Kiểm soát thay đổi | Agent gửi proposal có revision/evidence → người review diff → owner lưu → Agent đọc outcome mới | Biết thay đổi gì, ai review, dựa trên phiên bản nào; stale proposal bị chặn; không gửi lệnh tới thiết bị |

Mẫu tương tác dùng fixture phải ghi rõ mô phỏng. Nghiệm thu bản đầu theo master
vẫn cần một Agent client và nguồn IoT thật.

## 3. Cấu trúc giao diện đề xuất

Giữ số điểm vào chính nhỏ; prototype thử ba vùng sau, chưa chốt bố cục/sidebar:

- **Dự án:** tóm tắt phạm vi và coverage; tìm đối tượng, cây logic/vị trí,
  inventory và sơ đồ theo phân hệ; panel chi tiết chung.
- **Kết nối:** nguồn và Agent client, quyền, trạng thái truy cập/đồng bộ,
  mapping cần xử lý, kiểm tra truy vấn và thu hồi kết nối.
- **Xét duyệt:** diff nguồn, mapping không chắc chắn, proposal và kết quả kiểm chứng.

Cây/bảng/sơ đồ là view cùng dữ liệu. Giữ selection, Back và bộ lọc khi chuyển
view; tải phân trang/subgraph. Không hiển thị hàng nghìn node mặc định.
Work, memory, Drive, impact và tài liệu xuất hiện tại đối tượng/ngữ cảnh liên quan.

Chi tiết đối tượng trả lời: đây là gì, thuộc đâu, liên quan gì, do nguồn nào
quản lý, điều gì được khai báo/đo/kiểm chứng, và thao tác nào người dùng có quyền làm.
Hiển thị phần chưa biết có lý do và cách xử lý cụ thể.

## 4. Trạng thái bắt buộc trong prototype

- Dự án mới; chưa có nguồn; Agent chưa kết nối; client không tương thích.
- Đang đọc/cập nhật nguồn; lỗi truy cập; revoked; nguồn hoặc token hết hạn.
- Identity chưa mapping/trùng; nguồn đổi tên/xóa/thay thiết bị; conflict cần review.
- Nguồn cấu trúc cũ; thiếu đường liên kết; query partial/cursor/budget exceeded.
- Observation mới, chưa từng có, stale, invalid, unavailable hoặc có history gap.
- Nguồn/collector mất kết nối; device timeout; health chưa có phép đo.
- Proposal mới, stale, bị từ chối hoặc đã lưu; draft chưa lưu, revision conflict.

Reachability khác health. Mất nguồn không được vẽ mọi thiết bị thành hỏng.
Không dùng màu xanh làm bằng chứng live. Lỗi quyền không tiết lộ tên/ID ngoài scope.

## 5. Kết nối đơn giản nhưng rõ quyền

Kết nối nhanh nghĩa là người dùng chọn nguồn/phạm vi rồi xác nhận quyền dễ hiểu;
không đưa thuật ngữ cấu hình nội bộ vào hành trình thông thường.

Drive: nhà phát hành chuẩn bị OAuth; người dùng đăng nhập và chọn thư mục.
Đọc preview và cho phép gửi context tới model là hai quyền cần thể hiện rõ.
Credential không xuất hiện trong thuộc tính, log UI hoặc nội dung export.

Nguồn IoT: chọn kết nối đã hỗ trợ, xem chỉ số/thời gian đọc/quyền và kiểm tra nguồn.
Protocol/provider chưa chọn không được thể hiện như một integration đã chạy.

## 6. Đầu ra và nghiệm thu M1

Một bộ wireframe/mẫu tương tác xuyên suốt ba hành trình, kèm ví dụ response Agent,
bảng ánh xạ trang hiện có sang luồng mới và danh sách phần tái dùng/phần thiếu.
Thiết kế contract/source trước khi sửa diện mạo.

Người thử phải kết nối đúng phạm vi, tìm được entity/owner/nguồn, phân biệt desired
với observed, phát hiện dữ liệu cũ/thiếu và review đúng diff. Đo số bước và công
thiết lập theo protocol master; không tự đặt số thành công khi chưa thử.

Giữ EN mặc định/VI tùy chọn, điều khiển bàn phím, draft/save/reopen, kích thước
1280×720 và 1440×900. Thao tác dài có trạng thái/hủy; credential không bị lộ.
Bản build UI hiện có là nền tham chiếu, chưa được người dùng nghiệm thu luồng r3.
