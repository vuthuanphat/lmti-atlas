# Workspace web gồm năm khu vực — 21/10/2026

Chủ sản phẩm xác nhận giao diện workspace đã bàn gồm **Tổng quan, Công việc,
Kiến trúc, Knowledge và Agent**. Bản thay đổi này đưa năm khu vực đó lên thanh
điều hướng và mở Tổng quan mặc định. Đây là cập nhật giao diện trên backend
hiện có; không suy ra đã triển khai đủ mọi tính năng trong bản thiết kế Qt.

## Hành vi đã triển khai

| Khu vực | Dữ liệu và thao tác thực tế |
| --- | --- |
| Tổng quan | Thông tin dự án, revision, liên kết thư mục, profile MCP và trạng thái cấu hình client từ API hiện có; lối vào bốn khu vực còn lại. Không suy số công việc, tiến độ hay trạng thái online. |
| Công việc | Duyệt bản sao, kích hoạt và phục hồi qua `ProjectOperationsPanel`; hoạt động của phiên trình duyệt được ghi nhãn riêng. Chưa có API tạo/sửa/lưu danh sách công việc hoặc bảng Kanban. |
| Kiến trúc | Giữ editor phân cấp logic/vật lý và trình đọc đối tượng, quan hệ, observation, desired review đã có; vẫn tuân theo capability thực của owner. |
| Knowledge | Đọc ngữ cảnh theo đối tượng và yêu cầu cụ thể, hiển thị summary code/tài liệu/memory cùng nguồn, evidence và giới hạn phạm vi. Chế độ này chỉ đọc, không gắn owner duyệt ghi. |
| Agent | Giữ cấu hình MCP, xem trước, áp dụng/khôi phục cấu hình client và xuất cấu hình; cấu hình xong không đồng nghĩa client đang kết nối. |

Các panel sở hữu thao tác ghi tiếp tục được giữ khi đổi khu vực; không tháo rồi
tạo lại để làm mất trạng thái pending/unknown. Khóa của từng owner vẫn độc lập.
Đổi trang, đổi dự án, làm mới và kết thúc phiên bị chặn khi có thao tác đang giữ
khóa. Chủ sở hữu thao tác vẫn đọc được kết quả/phục hồi của chính nó.
Panel Công việc không bị tạo lại theo refresh và vẫn cho xem phạm vi lịch sử
được cấp quyền khi danh sách dự án hiện tại trống. Trạng thái client được gắn
với đúng project; không hiển thị snapshot của dự án trước trên Tổng quan mới.

Không thay đổi API, native binary, Python Agent, dữ liệu hay quyền launcher.
Gói mới phải sao chép release32 đã kiểm chứng vào thư mục mới, thay riêng UI
dist và manifest, rồi đối chiếu byte của toàn bộ tệp ngoài UI. Gói/ZIP release32
được giữ nguyên. Không cài dependency mới, kết nối thiết bị hoặc push repository.

## Kiểm chứng tại thời điểm ghi nhận này

- TypeScript UI typecheck đạt. Lần chạy hạn chế sandbox gặp lỗi phân giải
  pnpm/esbuild được giữ riêng; kiểm tra cùng source với quyền phù hợp đã đạt.
- **88/88 kiểm thử UI đạt**, không fail, cancelled, skip hoặc todo.
- Vite production build đạt, chuyển đổi **46 module**.
- Gate build ghi hash source, UI dist và log thực tế trước khi đóng gói.
- Package cuối `build/studio-web-workspace-20261021-final`: 4/4 doctor đạt;
  140 tệp ngoài UI giữ nguyên byte, ZIP 145 mục đã đối chiếu hash.
- Trình duyệt kiểm tra đủ năm khu vực EN/VI; Knowledge trả về code 1,
  document 1, memory 2, lọc và giữ nội dung khi đổi trang; Agent handshake
  đạt với 5 tool; Work ghi đúng sự kiện trong phiên; Kiến trúc đọc 3 quan sát
  replay được ghi nhãn rõ. Ở viewport 390×844 không tràn ngang; đã reset.
- Không có lỗi/cảnh báo console trong lượt này. Native/memory DB giữ nguyên hash.
- Manifest package cuối: `65110e369a98f1ca326b367abb9a1869a23b5b2963ea3fc6b428903b5018e06d`.
- ZIP cuối SHA256: `e8dee6ca14b68b055eb6768a8bccff62d17f5f81d0768d8ddc677f3684266d27`.
- Tên tab sửa thành `LMTI — Workspace`; chỉ HTML title đổi ở lượt cuối,
  Vite chạy lại và JS/CSS không đổi. Typecheck/88 test là kết quả lượt source
  trước đã xác minh không thay đổi, không ghi thành lần chạy mới.
- Phiên browser chỉ có một dự án; không thử commit ghi, sign-out hay
  chuyển nhiều dự án trong browser. Khóa owner được kiểm tra qua test và review.

Không chạy lại native/Python vì phạm vi này chỉ sửa UI. Bằng chứng release32
vẫn thuộc lượt kiểm chứng trước, không được ghi thành kiểm thử mới của UI này.

## Phạm vi còn mở

Proposal → operator → LMIP handoff/finalization, xoay authority, schema3 đầy đủ
cho copy/hierarchy/web recovery và nghiệm thu độc lập vẫn theo kế hoạch chung.
Work CRUD/bảng công việc chưa được thêm trong cập nhật này. Thiết bị thật,
provider, client bên thứ ba và Windows sạch cần nghiệm thu riêng.
**Không tuyên bố hoàn thành toàn bộ MVP.**

Trước khi push, kiểm tra `.gitignore` đã loại cấu hình riêng, `.env` và secrets.


## Bổ sung giao diện trắng–đen

Theo yêu cầu chủ sản phẩm ngày 21/10/2026, bảy stylesheet chuyển sang nền trắng,
chữ/nút chính đen và bề mặt xám trung tính. Thanh đang chọn nền đen, chữ/icon
trắng. Warning/error giữ nhãn và phân biệt thêm bằng viền nét đứt/nét liền;
focus bàn phím, trạng thái disabled và selected vẫn giữ nguyên.

Không đổi TSX/API/native/Python hay quyền dữ liệu. Vite build đạt (46 module),
4/4 package-doctor đạt; 140 file ngoài UI giữ nguyên byte so với bản workspace
trước. Đã mở đủ năm mục bằng tiếng Việt, xác minh màu tính toán của nền/active
nav và không ghi nhận lỗi/cảnh báo console. Đây là kiểm tra theme, không phải
lượt nghiệm thu lại toàn bộ MVP. Không thêm/chạy lại unit test cho thay đổi CSS.

Package: `build/studio-web-monochrome-20261021`.
Manifest SHA256: `21511179861c784c7f7251264058e208ec6e5907a5aa367244cc4c0280409ded`.
