## Bổ sung 31 — Nền tảng ghi Desired Asset và biên nhận native

Phần native đã có đường ghi giới hạn cho hai giá trị cấu hình mong muốn của
Asset: `enabled` và `pollMs`. Một giao dịch cập nhật đúng Asset, tăng revision
một lần và lưu biên nhận của thao tác. Đây là cấu hình mong muốn trong dự án;
chưa phải lệnh điều khiển hay trạng thái đo từ thiết bị.

Định dạng LMPR3 được nâng cấp tường minh từ LMPR2. Trước nâng cấp, owner tạo
bản sao dữ liệu có kiểu từ một snapshot được giữ ổn định, gồm các thay đổi đã
commit còn nằm trong WAL, rồi kiểm tra độc lập bản sao. Store UUID, revision,
đồ thị và registry được giữ nguyên. Đọc thông thường không tự nâng cấp.

Quyền ghi riêng, Site/Environment cố định, privacy kế thừa và identity của file
gốc được kiểm tra trước khi tiết lộ xung đột giá trị hoặc revision. Việc tìm lại
biên nhận dùng đúng thao tác và phạm vi cũ, kể cả sau lần lưu thông thường kế
tiếp; file sao chép có cùng UUID không được nhận biên nhận của file gốc.
Đối với nguồn external, lịch sử chỉ được trả khi target và tổ tiên vẫn đủ
điều kiện công khai. Biên nhận vắng mặt không chứng minh chưa từng commit và
không tự cho phép gửi lại lệnh.

CLI riêng có bốn entry cố định cho xem trước/ghi/tìm biên nhận và bảo trì
định dạng. Input giới hạn 64 KiB, độ sâu 16 và phải kết thúc thật; output gồm
newline giới hạn 128 KiB. Không thêm tool MCP ghi hay lệnh shell tùy ý.

| Kiểm chứng | Kết quả |
|---|---|
| Build native Release | Đạt sau hai sửa đổi chỉ trong bộ test. |
| Domain | 11/11 tình huống, 245 kiểm tra hành vi, không bỏ qua. |
| SQLite/biên nhận/nâng cấp | 10/10 tình huống, 174 kiểm tra hành vi, không bỏ qua. |
| CLI bằng tiến trình thật | 8/8 tình huống, 262 kiểm tra hành vi, không bỏ qua. |
| Hồi quy native/Qt | 38/38 suite CTest đạt; không suite nào bị skip. Năm kiểm tra symlink nội bộ bỏ qua có điều kiện do môi trường hiện tại. |

Log thất bại được giữ nguyên. Lượt build đầu phát hiện tên enum sai trong test,
được sửa thành `Committed`. Lượt test trọng tâm đầu đạt hai suite rồi process
fixture crash: hai biến giữ `QJsonValueRef` trỏ vào object tạm đã bị hủy. Sửa
sang giá trị JSON sở hữu độc lập bằng `.value("receipt")`; lần chạy lại đạt cả
ba suite. Hai sửa đổi này không thay đổi mã production hay giảm assertion.

Các ca mới bao gồm rollback trước commit, lỗi được chèn sau COMMIT trong owner
test riêng, mất stdout thực rồi tiến trình mới tra lại/replay, backup live WAL,
snapshot cũ, scope/privacy, file bị thay thế, ledger/schema sai, giữ lịch sử khi
lưu thường và từ chối các API cũ chỉ nhận schema2. Mốc 4.096 biên nhận được
kiểm tra bằng các hàng fixture tổng hợp hợp lệ, không phải 4.096 lần commit thật.
Fault hook không chứng minh độ bền trước mất điện hoặc crash hệ điều hành.

Bản sao lưu được xác minh bằng file thường ở vị trí cố định và hash nội dung.
Định dạng hiện tại không lưu lịch sử inode của backup; một file thay thế có
nội dung hoàn toàn giống vẫn có thể được xác minh. Các trường hợp không rõ sau
đặt chỗ backup giữ operation ID và artifact để đối chiếu.

Tài liệu hợp đồng gốc đã được phục hồi và đối chiếu đúng SHA-256 đã chốt; bản
làm rõ hai đoạn về backup vắng mặt và vị trí fault hook cũng được giữ riêng.
Các ghi nhận tạm thời trước lúc phục hồi còn nguyên trong lịch sử bằng chứng.

Bước tiếp theo là đường đọc mapping dành riêng cho LMPR3, kiểm tra kết hợp
native/TypeScript/Python và phiên generated năm tool với nguồn mới được duyệt.
Binary/config của nguồn đã đăng ký có fingerprint bất biến; nâng binary cần
nguồn mới và association được duyệt lại. Không tự sửa quyền đăng ký cũ.

Handoff proposal qua LMIP, inbox/operator, nối UI và recovery toàn luồng còn
tiếp tục. ZIP của bổ sung 30 giữ nguyên, không chứa bổ sung 31. Chưa có nghiệm
thu browser, client MCP bên thứ ba, thiết bị thật, máy Windows sạch hoặc người
vận hành độc lập từ lượt này. **Toàn bộ MVP chưa hoàn tất.**

Trước khi push repository, kiểm tra `.gitignore` đã loại `.env`, token và cấu
hình riêng chứa thông tin nhạy cảm. Lượt này không push hoặc cài thêm thư viện.
