# Accepted-current Impact mapping verification


## STRUCT-01 increment 29 — đọc mapping đã duyệt theo trạng thái hiện tại

Đã thêm reader chỉ đọc trong gói Impact và hai factory nguồn/native cố định.
Reader giữ quyền, store UUID và nguồn gốc file ban đầu; lấy snapshot LMIP đã
duyệt, kiểm tra nguồn/native hai lần và đối chiếu lại snapshot trước khi trả dữ
liệu đầy đủ. Quyền hiện tại, current head, thời hạn của cả nguồn đã duyệt lẫn
current head, evidence và endpoint assertion từ nguồn khác đều có thể làm
reader từ chối toàn bộ kết quả; không trả một phần Public.

Nguồn hiện tại hỗ trợ manifest và code với tập file được cấp quyền cố định.
Native-as-source vẫn trả UNSUPPORTED_MAPPING trước I/O. Native target được đọc
qua owner của increment 28, không đọc SQLite native trực tiếp từ TS. Mode local
bị từ chối trước spawn nếu grant không cho Internal. Revision/ancestry hiện tại
có thể đổi sau khi duyệt; không giả vờ rằng fingerprint native lúc stage là
quan sát hiện tại. Repository/knowledge reference vẫn là giá trị opaque, không
được mở theo đường dẫn hoặc tải từ mạng.

Reader không ghi hoặc tự duyệt mapping, migrate store, retry native child hay
thay kết quả lịch sử. Khi hủy/timeout, một worker chưa kết thúc vẫn giữ BUSY;
native child được giữ đến close. Đây là cơ chế vòng đời đã kiểm thử trong phạm
vi fixture, không phải bảo đảm chống mọi cuộc đua từ tiến trình cùng người dùng.

Build CLI cùng project references đạt. **79/79 ca tập trung và
278/278 ca toàn bộ Impact/CLI trong 19 file** đạt, không
fail/pending/todo. Trong 79 ca mới: 20 dùng LMIP thật với observer có kiểm soát,
55 kiểm tra adapter/file (child native ở suite adapter được mô phỏng), và bốn
ca chạy native28 thật cùng LMIP, manifest cố định và thao tác native có duyệt.
Bốn ca thực kiểm tra đọc không đổi bytes, thay UUID cùng đường dẫn, revision
và privacy ancestry mới, manifest drift/duyệt lại và retirement.

Giới hạn byte được kiểm tra bằng payload lưu trữ riêng được tăng JSON whitespace
quá 4 MiB và bị chặn trước observer; đây không phải kiểm chứng biên envelope lớn
nhất của mọi kết quả đã duyệt hợp lệ. Adapter native nhận 4.000 targets và từ
chối 4.001; adapter nguồn nhận hai fixture riêng có 5.000 evidence và 5.000
assertion trong giới hạn 4 MiB. Đây là các ca chấp nhận cụ thể, không phải bằng
chứng về mọi tổ hợp tối đa hoặc biên từ chối 5.001. Không cắt ngắn dữ liệu để
vừa frame. Full initial giữ nguyên kết quả 267/278: 11 fixture publish cũ thất bại
do PATH kiểm thử thiếu Git (`spawnSync git ENOENT`), còn 79 ca mới đều đạt.
Full-only r2 bổ sung đúng Git đã pin và config Git global rỗng/no-system,
không đổi source/test, build lại hoặc chạy lại focused. Một sửa nhỏ AbortSignal
cleanup được review trước lần apply đầu và giữ riêng trong provenance.

Runtime bảy file chỉ phục vụ kiểm thử local, lấy executable từ native28 và
Qt/config/plugin đã xác minh; không tạo package phát hành mới. Chưa nghiệm thu
đường phục vụ Agent/generated integration, Python, API/UI, thiết bị thật,
người vận hành độc lập hoặc Windows sạch cho chặng này. Những đường cũ được
kiểm tra hồi quy trong phạm vi Impact/CLI; không đồng nghĩa các tích hợp mới đã
được bật. **Toàn bộ MVP chưa hoàn tất.**

