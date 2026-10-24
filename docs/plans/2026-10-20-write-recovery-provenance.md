# STRUCT-01 increment 16 — original-target recovery provenance

**Implemented and verified locally; full MVP acceptance remains open.**

Increment này mở rộng marker điều phối hiện có để giữ đích ghi ban đầu trước
khi tiến trình owner được chạy. Subject riêng chứa phạm vi và bằng chứng đích;
không chứa credential, proposal đầy đủ hay quyền để phát lại thao tác. Helper
không mở các đường dẫn nằm trong subject. Marker v2 giữ toàn bộ entry đang hoạt
động hoặc chưa rõ kết quả, tối đa 32 entry và 240 KiB canonical JSON.

Coordinator giữ lease qua thời gian ghi và dọn metadata. Kết quả ghi đã được
owner xác nhận có thể trả về trước khi helper dọn entry xong; trong khoảng đó,
ghi cạnh tranh vẫn trả BUSY. Nếu dọn metadata thất bại, giữ rào cản phục hồi mà
không đổi kết quả ghi đã biết thành thất bại. Không kill hoặc tự gửi lại writer.

Các luồng phục hồi dùng chung tập đích đầy đủ, kiểm tra quyền hiện tại cho cả
tập trước khi đọc, thu bằng chứng hai lần và yêu cầu một lần xác nhận riêng.
Kiểm tra đích thư viện/physical ban đầu và locator-only trước khi đọc project
legacy; luồng project operations kiểm tra library token trước selected read.
Không dùng ID dự án hiện tại để âm thầm gắn lại một thao tác cũ sang store/root mới.
Không chọn copy có nội dung tương đương để suy ra operation ID đã mất.

Marker v1 thiếu provenance được giữ nguyên và từ chối tự chuyển đổi. Domain mới
chỉ được nhận từ v2 sạch, coverage đầy đủ, không còn entry hoặc cờ recovery, sau
kiểm tra runtime phù hợp. Domain/grant trùng khớp không tự chứng minh đích cũ hay
kết quả lịch sử. Việc xác nhận phục hồi chỉ mở đường cho một review mới.

## Verification

Cập nhật 20/10, STRUCT-01 increment 16: marker v2 giữ đích ghi ban đầu
trước khi owner chạy. Coordinator giữ toàn bộ entry và khóa ghi qua bước cập
nhật metadata. Phục hồi kiểm tra quyền cho toàn bộ tập đích, thu bằng chứng hai
lần và yêu cầu xác nhận riêng; không tự chạy lại ghi unknown hoặc đổi kết quả
lịch sử dựa trên trạng thái hiện tại.

Build API đạt; **96/96 kiểm thử tập trung**, **211/211 kiểm thử API đầy đủ** và
**25/25 kiểm thử marker Python trên Windows** đều đạt, không bỏ qua. Lượt API
đầy đủ mất 73.852 giây; Python unittest mất 30.903 giây. Các lần build/kiểm thử
lỗi trước đó được giữ lại: hai type annotation còn thiếu và các fixture chưa
chờ hết bước cập nhật marker sau kết quả ghi đã biết. Bản sửa fixture chỉ đợi
trạng thái đọc, giữ nguyên cơ chế khóa và không gửi lại thao tác unknown.

Unknown library upgrade vẫn bị chặn chờ kiểm tra native đầy đủ thư mục backup.
Marker v1 chưa có chuyển đổi tự động; thiếu identity ban đầu không được coi là
đã phục hồi. Kiểm tra binding hiện tại chưa phải phép đọc native có điều kiện
nguyên tử. Chưa nối hierarchy vào launcher/service/editor, chưa có browser
acceptance hoặc gói mới. Gói/ZIP cũ giữ nguyên; không đóng STRUCT-01 hay toàn MVP.

## Required follow-on and boundaries

Phục hồi unknown của library upgrade vẫn bị chặn: chưa có native inspection
đầy đủ cho backup parent, artifact đã reserve hoặc backup chưa hoàn tất. Library
receipt và physical identity của thư mục không đủ đóng gate này.

Physical/locator/token checks không phải atomic conditional native read, không
loại bỏ race của tiến trình cùng người dùng có quyền thay filesystem. Đường dẫn
canonical trong token Qt là khóa nhận dạng riêng, không dùng làm đích I/O.
Đích ban đầu thiếu hoặc có identity không xác minh được không được coi là đã
phục hồi chỉ vì pathname vẫn giống.

Chưa nối hierarchy adapter vào launcher/service/routes/editor, chưa kiểm chứng
browser hay đóng gói mới. Không đóng STRUCT-01, M2/M3 hoặc toàn MVP; hierarchy vật
lý, reviewed mapping/import, workload và các gate operator/device vẫn còn.
Suite HTTP cục bộ dùng loopback; không suy ra “không có socket” từ việc không
gọi mạng ngoài. Kiểm tra `.gitignore` cho cấu hình riêng và secrets trước một lần
push sau này.

