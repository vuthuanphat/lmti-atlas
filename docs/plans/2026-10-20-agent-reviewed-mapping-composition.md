# Reviewed mapping Agent composition verification


## STRUCT-01 increment 30 — mapping đã duyệt trong ngữ cảnh Agent

Đã nối reader accepted-current của increment 29 vào generated Agent bằng
`lmti.agent.integration.v3`, chế độ `reviewed`. Mỗi cấu hình gắn với một nguồn
Impact đã đăng ký, hỗ trợ manifest hoặc code với tập file được cấp quyền cố định.
Entry riêng chỉ đọc `accepted-mappings`; Agent không được stage, accept, migrate
hay ghi native. Python không đọc SQLite Impact/native trực tiếp. Mapping
pending/rejected không thay head đã chấp nhận. Native-as-source v3 vẫn chưa hỗ trợ.

Cấu hình ghim grant, project/site/environment, UUID store, nguồn gốc file và hash
của executable/bundle/config. Thay đổi bị phát hiện sẽ thu hồi quyền tương ứng
trong phiên; khôi phục bytes không tự hồi sinh quyền. Lượt ghép đối chiếu mapping
trước/sau, knowledge trước/sau và native đầu/cuối. Nó chỉ dùng target nằm trong
neighborhood native được phép đọc. Selection trùng được nhóm, nhưng giữ đủ
contributor và không hạ classification. Association biểu thị liên kết đã duyệt,
không chứng minh sức khỏe thiết bị hoặc việc thực thi ngoài hệ thống.

Phản hồi chỉ thêm association, metadata review và evidence ID opaque; không xuất
store UUID, đường dẫn riêng, selection, external key/alias hay body/locator
evidence thô. Năm tên tool vẫn giữ nguyên. Chỉ phiên reviewed mở thêm
`limit`/`cursor` cho `lmti_task_context`; cursor gắn phiên, truy vấn và bằng chứng
hiện tại. Default bốn tool và manual v1/v2 năm tool được kiểm tra bằng phiên
generated thực tế.

Giới hạn vẫn là đầy đủ hoặc từ chối: request mapping 4 KiB, config 128 KiB,
phản hồi mapping gồm LF 4 MiB và envelope Agent 512 KiB. Tối đa 100 selection đủ
điều kiện, đếm trước nhóm trùng/phân trang; tối đa một memory mapping với disclosure
tường minh. Trang 1–200 association/context item kiểm tra lại toàn bộ nguồn;
không cắt nội dung để vừa frame. Lỗi riêng phần reviewed có thể trả native-only
partial khi native và quyền hiện tại còn hợp lệ; không gắn lại proof reviewed cũ.

Ngân sách 240 giây bao trùm cả lượt ghép. Deadline hết không chứng minh child đã
đóng: worker còn sống tiếp tục giữ BUSY đến close/drain, kể cả khi API wait lỗi.
Đây là kiểm tra phối hợp giữa các owner local, không phải giao dịch nguyên tử
xuyên Impact/native/code, lease chống mọi thay đổi filesystem hay bảo đảm đóng
toàn cây tiến trình khi hệ điều hành kết thúc Agent.

### Kết quả chạy thực tế

| Hạng mục | Kết quả cuối và phạm vi |
|---|---|
| Native/Qt | Build đạt; 35/35 suite CTest đạt. Năm kiểm tra symlink nội bộ skip có điều kiện do môi trường không tạo được link: copy discovery 2, upgrade recovery 1, original binding 1, mapping observation 1. Không suite CTest nào bị skip. |
| TypeScript | Build CLI cùng project references đạt; 308/308 test Impact/CLI trong 20 file đạt, không fail/pending. |
| Python | Unit-r3: 184/184 test trong 11 file đạt, không fail/error/skip; gồm decoder, revocation, lifecycle có điều khiển và hồi quy cũ. |
| Generated MCP | Process-r3: 4/4 ca đạt, không skip, child của harness đã đóng. Dùng argv `-I` do native sinh, native/LMIP thật và knowledge bundle thực trong package-r2. |
| Web/package | API build, UI typecheck/build đạt; doctor-r2 4/4 test đạt. Đây không phải lượt chạy lại toàn bộ API/UI hoặc thao tác browser. |

Bốn ca process kiểm tra accepted mapping và loại pending/rejected, nhóm selection
trùng, không lộ trường riêng; manifest drift rồi operator accept head mới trong
cùng phiên; các trang/cursor đổi hoặc khác phiên; config revocation và tương thích
default/v1/v2 manual. Chuỗi thực dùng nguồn manifest và nội dung code đã compile;
không suy rộng thành kiểm chứng mọi nguồn code/memory, client MCP bên thứ ba hoặc
mọi tổ hợp giới hạn tối đa.

Giữ nguyên ba lần thất bại và sửa tương ứng. Unit-initial có 180/181 đạt: v2 bị
thêm keyword `retain_until_closed=False`, làm đổi call shape cũ; sửa chỉ truyền
`True` cho v3, unit-r2 đạt 181/181. Process-initial thất bại cả bốn trước MCP vì
fixture so đường dẫn Windows bằng raw separator; sửa kiểm tra canonical path và
samefile, giữ nguyên argv/hash. Process-r2 tiếp tục thất bại cả bốn lúc khởi tạo:
`FilePin` so `ctime` path/handle như cùng một giá trị. Chẩn đoán Python 3.14 trên
Windows hiện tại cho thấy Node đã cài và native được copy có hai `ctime` khác
nhau, còn identity/size/mtime/birthtime/link count khớp. Bản sửa giữ hai chữ ký
riêng, vẫn kiểm tra thay đổi trong từng API và SHA-256; thêm ba test, gồm đọc
Node đã cài. Unit-r3 và process-r3 đạt sau sửa. Không xóa log thất bại hoặc gán
thành công mới cho package cũ.

Package được kiểm chứng là `studio-web-mapping-composition-20261020-r2`, manifest
SHA-256 `ce0a08de743168d2d14da842b2c1c866a0449d3d719ab057bed86576b3700aed`.
Nó chứa native hiện tại, Python đã sửa và hai bundle knowledge/mapping; package
ban đầu được giữ nguyên làm bằng chứng lịch sử. Đã xuất ZIP `LMTI_Build_Mapping_Da_Duyet_2026-10-20.zip`: 145 file (144 file được manifest liệt kê và manifest), 16.153.094 byte,
SHA-256 `545fa3d261c3b5d19f453c757182723e659eddd34a5a1ff091957a5fcf76a122`. Đã đọc lại và đối chiếu hash từng file trong ZIP;
24 cache SDK Python sinh khi kiểm thử được loại khỏi ZIP. Hash local là bằng chứng
đối chiếu, không phải chữ ký của nhà phát hành. Tài liệu tiến độ này được cập nhật
sau đóng gói; tài liệu trong ZIP giữ đúng snapshot khi build.

Ưu tiên tiếp tục foundation/build có kiểm soát theo lựa chọn của người dùng.
Handoff proposal schema-2, operator inbox và receipt native bền vững để đối chiếu
lost ACK vẫn còn mở; đường đọc reviewed vừa kiểm chứng không hoàn thành đường ghi.
Browser workflow, client MCP bên thứ ba với timeout riêng, provider/thiết bị thật,
crash hệ điều hành, người vận hành độc lập và Windows sạch là các bước nghiệm thu
sau. Không yêu cầu live pilot để tiếp tục phần nền tảng này.
**Toàn bộ MVP chưa hoàn tất.**
