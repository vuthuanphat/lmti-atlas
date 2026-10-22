# Reviewed Impact mapping owner verification


## STRUCT-01 increment 27 — owner mapping có duyệt

Đã thêm hợp đồng mapping và owner SQLite trong Impact: đăng ký nguồn theo quyền
cố định, nhập bản đầy đủ, xem diff nguồn/entity/evidence/assertion/mapping rồi
duyệt hoặc từ chối. Mapping chỉ liên kết các định danh native đã được cấp quyền;
không ghi topology hoặc memory. Alias và thế hệ được giữ để ngăn tái sử dụng
định danh; bản nhập đầy đủ bỏ một association sẽ tạo trạng thái retired.
Bằng chứng của mapping retired giữ đúng batch gốc qua nhiều phiên bản.

Owner kiểm tra đầy đủ dữ liệu trước/sau và quyền nguồn, bằng chứng, entity cùng
native ancestry. Cho phép đọc Internal không cho phép đổi nhãn Internal thành
Public. Quyền được kiểm tra lại sau chờ observer; timeout rollback và bỏ kết quả
trả muộn. Biên nhận xác nhận được lưu cùng giao dịch; gửi lại yêu cầu đã xác nhận
đọc biên nhận cũ. COMMIT không rõ kết quả trả unknown, không tự gửi lại.

Nâng LMIP từ format 2 lên 3 là thao tác riêng, có backup VACUUM được đối chiếu,
kể cả dữ liệu đã commit chỉ nằm trong WAL. Khởi tạo vẫn dùng format 2; đọc cũ và
luồng import/report/review không thuộc nguồn mapping giữ tương thích.

Build cuối đạt; **54/54 ca mapping tập trung và 100/100 ca toàn bộ Impact** đạt,
không fail/pending/todo. Có kiểm thử SQLite thật cho transaction, rollback,
COMMIT contention, replay, quyền, schema/triggers và migration. Observer nguồn
và native trong các ca này là fixture có kiểm soát, chưa phải adapter thiết bị.

Lịch sử lỗi được giữ: build đầu thiếu một trường kiểu evidence, đã sửa khai báo;
focused r2 đạt 48/50 do fixture WAL chưa giữ read transaction và một nhóm test
vượt 5 giây. R3 đạt 52/53 sau sửa WAL, còn nhóm biên 2.000/2.001 dòng xử lý lặp.
Test được tách và đóng khung payload độc lập để mỗi ca xác thực một lần; r4 đạt
54/54. Không tăng timeout, đổi giới hạn sản phẩm hay bỏ assertion. Các lượt này
không phải benchmark hiệu năng và không chứng minh khôi phục sau crash hệ điều hành.

Increment này chỉ build/test gói Impact và các project reference hiện có, không
chạy lại native/API/UI/Python, không tạo release package hay migrate dữ liệu
người dùng. Bước tiếp theo là đọc mapping đã duyệt với kiểm tra nguồn/native
hiện tại, rồi nối Agent knowledge và giao diện review/handoff. Browser thực,
đóng gói/workload tích hợp, thiết bị thật, người vận hành độc lập và Windows sạch
vẫn còn mở. **Toàn bộ MVP chưa hoàn tất.**

