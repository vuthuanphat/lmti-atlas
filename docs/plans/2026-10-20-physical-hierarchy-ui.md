# Physical hierarchy UI verification


## STRUCT-01 increment 26 — giao diện phân cấp vật lý

Đã nối editor vật lý vào Structure: 11 thao tác Site/Area/Environment và vị trí
Asset, hiển thị đầy đủ đường dẫn/quyền, bản nháp theo revision, xem trước rồi
xác nhận một lần. Quyền vật lý được phát hiện riêng; quyền logic hoặc thao tác
dự án không tự cấp quyền này. Vị trí chưa khai báo khác vị trí đã khai báo nhưng
các trường tùy chọn rỗng; Environment là quan hệ thành viên.

Khóa thao tác ghi vật lý được giữ cùng các khóa hiện có. Phản hồi muộn, review
hết hạn và ghi chưa rõ kết quả không tự gửi lại. Activity đọc phục hồi chung
của bốn họ thao tác, giữ các quan sát lặp của cùng dự án và kiểm tra toàn bộ
tập đích trước xác nhận. Xác nhận trạng thái hiện tại không đổi kết quả lịch sử
từ unknown thành confirmed.

Build TypeScript/Vite đạt. **52/52 kiểm thử tập trung và 81/81 kiểm thử UI đầy đủ**
đạt, không fail/skip/cancel/todo. Các ca kiểm tra DTO, bản nháp, quyền/đường dẫn,
giới hạn, vòng đời review/job, khóa ghi và render EN/VI. Đây là kiểm thử helper,
state và SSR; chưa chứng minh click, focus, bàn phím hay trình đọc màn hình
trên browser thật.

API đã được kiểm chứng riêng ở increment 25 (395/395 API, 43/43 Python).
Increment này chỉ sửa UI, không chạy lại native/API/Python và không tạo package
mới. Browser thật, mapping/import có review, Agent handoff, workload tích hợp
và đóng gói vẫn còn; thiết bị thật, người vận hành độc lập và Windows sạch thuộc
nghiệm thu sau build. **Toàn bộ MVP chưa hoàn tất.**

