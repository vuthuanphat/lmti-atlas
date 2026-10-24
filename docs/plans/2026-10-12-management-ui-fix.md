# Sửa giao diện quản trị LMTI Studio

> Planning status, 2026-10-13: this is a dated scope/evidence record.
> The [consolidated master plan](../LMTI_MASTER_PLAN.md) owns current priorities
> and M0–M4 milestones. Earlier stage orders and unfinished work below are
> reference material, not a separate active backlog. Accepted architecture and
> recorded evidence remain valid within their stated scope.

Người dùng yêu cầu ưu tiên giao diện app chính trước phần impact. Đợt này sửa
desktop C++/Qt đang có, dựa trên hướng thiết kế AI đã lưu; không thay app chính
bằng trang báo cáo impact trên trình duyệt.

## Hợp đồng bố cục hiện hành

- Luồng sidebar: Overview → Software → Releases → Work → Hardware → Architecture.
  ID trang và các boundary dữ liệu giữ nguyên; Knowledge/Agent nằm nhóm riêng.
- Danh sách quản trị đặt toolbar, tìm kiếm, bộ lọc, số lượng và bảng trong một
  surface trắng. Software/Releases đặt Add bên trái, Columns/More bên phải;
  Work đặt chế độ xem bên trái và hành động bên phải. Bộ lọc nằm ở hàng sau.
- Software mặc định giữ tên, loại, repository và visibility. Releases giữ
  version, component, target và review state. Work giữ tên, state, component và
  evidence. Các trường còn lại vẫn trong model/inspector và mở được bằng **Columns**.
  Chọn cột chỉ thay cách xem, không sửa document hay quyền dữ liệu.
- Inspector giữ tiêu đề/hành động cố định, một scroll cho thân. Related records
  dùng dòng gọn, tối đa 12 dòng mỗi trang; không loại bỏ phần cuối danh sách.
  Back phục hồi trang, selection và scroll; Enter tiếp tục mở đúng bản ghi.
- Library dùng tên dự án nổi bật và đường dẫn phụ; pin/action gọn, toolbar tự
  chuyển hai hàng khi hẹp. Empty state có hành động ngay bên giải thích và không
  chiếm trọn viewport. Hàng dự án có padding riêng để nút ghim và thao tác không
  bị cắt. Trạng thái local vẫn chỉ phản ánh file/thư mục khả dụng.

Inspector hiện dock cạnh nội dung với chiều rộng thích ứng 280/352 px; bảng mặc
định giảm số cột để dành chỗ. Những mô tả overlay/Add bên phải trong kế hoạch
refinement cũ là phương án lịch sử, không phải hành vi hiện hành của bản này.
Các ảnh AI là hướng thị giác; dữ liệu và tính năng vẫn do domain hiện có quyết định.

## Package và cách mở

Build riêng: `build/native-ui-fix-20261012`. Package riêng:
`build/studio-ui-fix-20261012`. Giữ nguyên các process cũ có thể đang chứa bản nhập
chưa lưu. Hai launcher hiện ưu tiên package mới khi đã có executable:

```powershell
# Mở thư viện theo cấu hình data hiện có của launcher:
& .\scripts\start-studio-ui.ps1

# Xem fixture riêng, không sửa project người dùng:
& .\scripts\start-studio-design-review.ps1

# Xem chính xác executable/hash/data mà không mở app:
& .\scripts\start-studio-ui.ps1 -PrintLaunchInfo
```

Title bản mới bắt đầu bằng **LMTI Studio**. Trang Change Impact Review ở port
25249 vẫn là pilot độc lập, không phải link chạy desktop.

## Kiểm chứng

Build Release và cài package thành công ngày 2026-10-12. CTest đạt **4/4**:
topology core, topology storage, project domain/storage và desktop. Bộ Qt desktop
đạt **36 passed, 0 failed, 0 skipped** (bao gồm setup/cleanup), có kiểm tra chọn
cột, Board/List, phân trang quan hệ, Back/keyboard và EN/VI. Log ghi tại
`build/ui-fix-evidence-20261012`.

Ảnh tại `build/ui-fix-review-20261012`: 12 capture EN/VI ở 1440×900, 4 capture
VI ở 1100×800 và 2 capture Windows thật ở 1440×900 logical (DPR 1.25). Cả 18
capture thành công và cùng hash với package. Empty Library VI cũng được render
riêng bằng executable đó. Đã xem ảnh để sửa cắt pin, chữ vẽ chồng dưới badge,
nhãn tiếng Việt quá dài và độ rộng cột Công việc. Tên dài vẫn được rút gọn trong
bảng hẹp; chọn bản ghi để xem chi tiết. Tất cả ảnh dùng fixture tạm.

Desktop SHA-256:
`B83FF389642C0AEE972E31D2192938F7DA7DAE3B96E3567CD4522880D2766FE4`.
Clang-format, kiểm tra whitespace và cú pháp các launcher đều đạt. Không thêm
dependency và không thay đổi domain, SQLite schema hoặc quyền Agent.

Kiểm thử kỹ thuật và ảnh render không thay thế nghiệm thu trải nghiệm của người
dùng hoặc kiểm tra Windows sạch/screen reader. Không có tính năng quản trị mới
được giả lập bằng nút không hoạt động; các thao tác vẫn đi qua validators và Save.

## Bài học đề xuất

- Kiểm thử widget đạt chưa đủ để xác nhận hình thức. Chụp từ executable đã đóng
  gói và ghi hash để tránh xem nhầm bản cũ; kiểm tra cả cửa sổ hẹp và tiếng Việt.
- Delegate tự vẽ badge phải vẽ nền mà không khởi tạo lại DisplayRole; nếu gọi
  lại `QStyledItemDelegate::paint`, chữ gốc có thể xuất hiện dưới badge.
- Kiểm thử click trên toolbar vừa hiện cần chờ layout có kích thước thật; không
  thêm `processEvents()` vào production chỉ để làm test chạy qua.

Đây là ứng viên bài học có nguồn trong mã và log kiểm tra, chưa tự ghi vào memory.
