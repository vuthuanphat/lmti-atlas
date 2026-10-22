# Thư viện thư mục dự án và giao diện quản lý

> Planning status, 2026-10-13: this is a dated scope/evidence record.
> The [consolidated master plan](../LMTI_MASTER_PLAN.md) owns current priorities
> and M0–M4 milestones. Earlier stage orders and unfinished work below are
> reference material, not a separate active backlog. Accepted architecture and
> recorded evidence remain valid within their stated scope.

Ngày: 2026-10-12. Hướng triển khai theo yêu cầu của chủ dự án: quản lý thư mục
dưới dạng thư viện và giảm độ khó của giao diện desktop. Đây là phần tiếp theo
của [quản lý phần mềm gắn thiết bị](2026-10-11-software-hardware-projects.md).

## Hợp đồng sản phẩm

Điểm vào chính là **Thư viện dự án**, không phải danh sách file mở gần đây.
Thư viện lưu tham chiếu tới dự án và thư mục trên máy; nó không sao chép repo,
quét mã nguồn, hợp nhất memory hay tự cấp quyền đọc thư mục cho Agent.

- **Tạo dự án:** người dùng chọn thư mục chứa và tên thư mục mới. Hiển thị đường
  dẫn trước khi tạo; không ghi đè thư mục đang có. File `project.lmti.sqlite`
  lưu document trong thư mục mới, không phải store `.lmti/`.
- **Liên kết thư mục:** chọn thư mục có sẵn. Nếu đã có file project chuẩn thì mở
  file đó; nếu chưa có, metadata được lưu trong `data/documents/` cạnh thư viện.
  Mã nguồn và `.lmti/` trong thư mục được giữ nguyên.
- **Thư viện:** thẻ dự án, tìm theo tên/đường dẫn, ghim, gần đây, trạng thái file
  và thư mục, chọn lại đường dẫn, gỡ tham chiếu. Gỡ không xóa file/thư mục.
- **Trong dự án:** sidebar cố định và breadcrumb; Tổng quan, Phần mềm, Thiết bị,
  Kiến trúc, Công việc, Phiên bản, Agent nâng cao. Lưu và trạng thái thay đổi
  rõ ràng; menu ít dùng nằm trong nút tùy chọn. Không ép người dùng xem JSON.
- **Đổi dự án:** kiểm tra thay đổi chưa lưu; Cancel phải giữ document và đường
  dẫn. Chọn lại file phải khớp project ID, không nhận nhầm một dự án khác.

Giao diện áp dụng bố cục quen thuộc của thư viện/workspace và dashboard quản
trị: sidebar, tìm kiếm, thẻ, một hành động chính, các chi tiết được mở theo nhu
cầu. Không sao chép thương hiệu hay hứa tương đương sản phẩm OpenAI/Claude/
Cloudflare. **English là ngôn ngữ mặc định; tiếng Việt là lựa chọn phụ** ở cuối
sidebar. Đổi ngôn ngữ ngay trong ứng dụng giữ document, thay đổi chưa lưu và trang
đang mở; lựa chọn được lưu trong `ui-settings.ini` cạnh thư viện. Không dịch tên
dự án, nội dung người dùng hoặc ID/enum của domain. Editor topology legacy và một
số lỗi kỹ thuật vẫn dùng tiếng Anh.

L0–L3 đã có implementation và kiểm tra tự động/render cục bộ; xem
[báo cáo thực thi](2026-10-12-library-execution.md). Nghiệm thu trực tiếp của người
dùng và trên Windows sạch vẫn là gate riêng.

## Các bước và bằng chứng cần có

| Bước | Đầu ra | Kiểm tra |
| --- | --- | --- |
| L0 | Hợp đồng thư mục/document/library và luồng tạo/liên kết | Thư mục khác identity; library không là quyền Agent |
| L1 | Adapter SQLite thư viện độc lập, ghim và folder refs bền vững | Không tự loại dự án sau 30 mục; không sửa catalog/document cũ |
| L2 | Library cards, search/filter/paging, sidebar/breadcrumb và dialog tạo | Luồng thư viện → dự án → quay lại; empty/missing/dirty states |
| L3 | Native/UI/process checks, đóng gói, render Windows và mở dùng thử | Không ghi đè bản đang mở; không sửa source khi liên kết/gỡ |

## Kiến trúc và rủi ro

`project_library.hpp`/adapter sở hữu index cục bộ; ProjectDocument và Qt-independent
core giữ nguyên. `ProjectLibraryView` sở hữu bố cục, tìm kiếm/phân trang và phát
các thao tác cho ProjectWindow; view không có quyền ghi SQLite hay domain.

SQLite thư viện mới dùng LMLB `0x4c4d4c42`, schema 1, tên `project-library.sqlite`.
LMCA/LMPR/topology/memory không nâng schema. Catalog gần đây cũ được đọc để nhập
tham chiếu một lần khi thư viện chưa có; nguồn không sửa, mục đã gỡ không tự hồi
sinh. Không suy luận lại ngày mở cũ. Save as cùng identity giữ ghim/thư mục.

Giới hạn 500 dự án, 24 thẻ mỗi trang, 3 cột tự thích nghi. Tìm kiếm dùng metadata
trong index; chỉ kiểm tra tồn tại của các đường dẫn đang hiển thị. Không nạp toàn
bộ document hoặc quét cây thư mục để dựng thư viện. Folder identity chuẩn hóa
case trên Windows; một thư mục chỉ liên kết với một project identity trong index.

Library refs là dữ liệu cục bộ, không được gửi qua project CLI/SDK/MCP. Public
project không làm đường dẫn thư viện thành public. Document được kiểm tra schema,
ID và validation khi mở, không coi index là nguồn sự thật.

**[CẢNH BÁO BẢO MẬT]** SQLite chưa mã hóa, nên chỉ hỗ trợ metadata không bí mật.
Không đặt token/URL chứa thông tin đăng nhập vào tên hoặc trường dự án. Kiểm tra
`.gitignore` cho database/WAL/SHM và secrets trước khi push; publication vẫn cần
`lmti publish preflight`. Liên kết thư mục không là quyền đọc/export toàn bộ repo.

Library backup/recovery, đồng bộ nhiều máy, khóa hệ điều hành, encrypted storage,
file browser/editor và đọc compiled memory cần hợp đồng riêng. Các giới hạn về
device execution và memory bridge của bản Projects trước vẫn áp dụng.

Thay đổi này cải thiện khả năng tìm và hiểu dự án, giảm chọn lại đường dẫn,
lưu tham chiếu có thể dùng lại, giữ tri thức/source trong ranh giới riêng và tách
view/index khỏi domain để thay thế độc lập. Không thêm framework hoặc dependency.

Lesson candidates để review, chưa tự lưu: thư viện là index chứ không là quyền;
gỡ tham chiếu không xóa source; lựa chọn file thay thế phải kiểm tra project ID;
đi về thư viện không được làm mất thay đổi chưa lưu.
