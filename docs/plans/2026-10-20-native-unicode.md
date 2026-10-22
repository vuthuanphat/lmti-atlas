# Native decoded-string Unicode validation


## STRUCT-01 increment 24 — kiểm tra Unicode ở ranh giới JSON native

Đã bổ sung kiểm tra UTF-16 sau giải mã cho mọi chuỗi và khóa JSON dùng chung,
đồng thời chuyển cổng proposal cũ sang parser này. Chuỗi surrogate sai bị từ chối
trước khi xử lý; cặp Unicode hợp lệ và ký tự gốc được giữ nguyên. Giới hạn byte,
độ sâu, khóa trùng và các quy tắc kiểm tra theo trường vẫn được giữ.

Build đạt; kiểm thử tập trung **12/12**, hồi quy native/Qt **34/34** đạt.
Các ca mới kiểm tra cả parser trực tiếp, xem trước/ghi phân cấp logic, proposal
và thao tác sao chép dự án; yêu cầu bị từ chối giữ nguyên dữ liệu thử.
Các skip nội bộ có điều kiện được ghi trong JSON; không suite CTest nào bị bỏ qua.

Đây là bước sửa dùng chung sau lỗi Unicode đã ghi ở increment 23. Không mở rộng
hồi tố bằng chứng cũ. API phân cấp vật lý đã áp dụng nhưng chưa được kiểm chứng
trong increment này; UI, browser thực, gói mới, thiết bị thật và Windows sạch còn
mở. Toàn bộ MVP chưa hoàn tất.

The shared boundary validates every quoted token after JSON escape decoding, including object keys and nested strings. It does not normalize text or repair stored files. Existing physical/original-read field checks remain intact. The separate proposal byte facade keeps its 4 KiB cap and exact error envelope. Typed QJsonObject callers, unrelated formats and OS arguments are outside this change.
