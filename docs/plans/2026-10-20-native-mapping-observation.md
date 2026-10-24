# Native fixed mapping observation


## STRUCT-01 increment 28 — cổng đọc mapping native

Đã thêm cổng `mapping-observation` chỉ đọc. Đường dẫn kho, Project, UUID, Site,
Environment và quyền local/external do launcher cố định; request chỉ chọn các
đối tượng cần đọc. Schema, Project và UUID được kiểm tra trước nội dung; đồ thị
và registry được lấy từ cùng một snapshot SQLite. Kết quả giữ đủ tập yêu cầu,
không trả nhãn, đường dẫn, nội dung nguồn hoặc registry thô.

Quyền được tính theo toàn bộ quan hệ liên quan: repository/subsystem cho
Component và Knowledge; Site/Area/Environment/thiết bị cha cho Asset. Asset
phải có Environment khai báo khớp phạm vi; role chưa khai báo vẫn là null.
Đối tượng không tồn tại, retired, bị ẩn hoặc ngoài phạm vi đều từ chối cả lượt
đọc bằng cùng một khung lỗi. Danh sách rỗng vẫn kiểm tra quyền Project.

Fingerprint quan hệ giữ cả đường dẫn tổ tiên và phân loại quyền; fingerprint
repository/knowledge tương thích cổng native v3 hiện có. Cổng giới hạn 4.000
đối tượng và 4 MiB cho request/phản hồi hoàn chỉnh, kiểm tra JSON UTF-8/scalar,
khóa trùng, EOF và một LF kết thúc.

Build đạt; **10/10 suite tập trung và 35/35 suite native/Qt đầy đủ** đạt.
Bộ test mới gồm tám nhóm, có SQLite/WAL thật, ghi đồng thời tại điểm kiểm soát,
kiểm tra giữ/nhả khóa đường dẫn, đối chiếu fingerprint độc lập và gọi CLI thật.
Cả hai lượt đều có 20.337 kiểm tra mới đạt, phản hồi đủ 4.000 dòng là 1.440.165
byte. Suite mới bỏ qua một ca do môi trường không tạo được symlink
(unavailable/denied); toàn bộ suite có năm skip nội bộ có điều kiện, được giữ
trong JSON. Không suite CTest nào bị bỏ
qua. Build và hai lượt test đều đạt ngay ở lần chạy đầu, không cần sửa nguồn.

Lease bảo vệ namespace trong lượt gọi này; không chứng minh inode của lượt gọi
cũ, không chặn ghi tại chỗ hay tạo giao dịch nguyên tử với Impact. SQLite chỉ
phối hợp qua SHM đã tồn tại; test đối chiếu main/WAL và danh sách file, không
khẳng định từng byte SHM bất biến. Đây là Windows hiện tại, chưa là nghiệm thu
trên máy Windows sạch hoặc thử crash hệ điều hành.

Bước tiếp theo là reader mapping đã duyệt kiểm tra trạng thái hiện tại, nối
transport cố định và Python knowledge, rồi handoff có review và gói/workload
tích hợp. Increment này chưa nối API/UI/Agent hay thiết bị thật và chưa tạo
package mới. Browser thực, người nghiệm thu độc lập và máy Windows sạch còn
mở. **Toàn bộ MVP chưa hoàn tất.**

The new private native boundary reads only the fixed store. It neither resolves profiles/libraries nor migrates schema or writes topology/memory. Logical and reference targets are project-wide; Site/Area/Environment targets prove scoped catalog existence, not deployment. Empty requests do not prove the configured Site/Environment exists. Repository/knowledge reference hashes bind declared evidence, not fetched external freshness. The storage seam captures an owned typed snapshot and registry on one connection and returns only after that connection closes; namespace leases remain held through projection and sidecar checking. The cooperative 30-second storage budget continues through projection. Output is buffered and bounded before writing; an I/O failure is unavailable, not partial authority. Unsupported platforms refuse rather than bypass leases.
