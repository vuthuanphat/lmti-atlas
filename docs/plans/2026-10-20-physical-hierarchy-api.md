# Physical hierarchy API verification


## STRUCT-01 increment 25 — API phân cấp vật lý

Đã tích hợp API cho 11 thao tác vật lý, quyền riêng theo dự án, xem trước rồi xác
nhận một lần, theo dõi job và phục hồi chung. Quyền logic hoặc quyền sao chép
không tự cấp quyền vật lý. Phản hồi vượt giới hạn bị từ chối đầy đủ.

Build API đạt; kiểm thử tập trung **124/124**, toàn bộ API **395/395** đạt,
không fail/skip/cancel/todo. Bốn ca HTTP dùng native thật kiểm tra ghi lô và đọc
lại, từ chối ghi khi thay tệp dự án trước dispatch, cách ly quyền, và phục hồi
sau khi ACK nhận về bị làm hỏng sau lúc tiến trình ghi kết thúc.

Python đạt **43/43** ca ở bốn suite launcher/marker. Hai lượt đầu đều có 3/6 ca
launcher thất bại ở bước khởi tạo PowerShell; ba suite sau chưa chạy. Thử riêng
lệnh khởi tạo chưa đủ xác minh toàn bộ chuỗi chạy. Hai log lỗi được giữ lại;
runner được sửa riêng rồi chạy lại. Các ca mong đợi từ chối ở hai lượt lỗi không
được dùng làm bằng chứng chính sách vì lỗi khởi tạo cũng có thể trả mã khác 0.
Bản sửa giữ danh sách biến môi trường cố định, xóa biến bằng giá trị null thực
và đặt RemoteSigned chỉ cho tiến trình kiểm thử; không đổi chính sách máy hoặc
mã sản phẩm.

API dùng bản native đã đạt 34/34 ở increment 24. Việc tái tạo broker được thử
trong cùng tiến trình; chưa chứng minh crash/restart hệ điều hành. UI vật lý đang
ở stage, chưa apply/build/nghiệm thu. Browser thực, đóng gói mới, mapping/import,
thiết bị thật và Windows sạch còn mở; toàn bộ MVP chưa hoàn tất.

