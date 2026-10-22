# LMTI local web

Giao diện React chạy trên máy, mở vào **Overview (Tổng quan)**, dùng cùng C++/SQLite
owners với Qt Studio và cùng Python owner để quản lý file client. Không cần
Vite dev server, dịch vụ cloud hay tài khoản LMTI.

## Candidate v0.2.0-alpha.1

Bản chuẩn bị release dùng package `build/lmti-v0.2.0-alpha.1-windows-x64`.
Truyền `-PackageDirectory` tường minh khi chạy script trong repository; launcher
bên trong ZIP chọn chính package chứa nó. Xem [release notes](releases/v0.2.0-alpha.1.md)
và hồ sơ nghiệm thu đi kèm. Đây là candidate local, chưa công bố.

## Chạy bản đóng gói

`build/studio-web-mcp-bridge-20261019-r2` là snapshot kiểm chứng MCP trước đây;
gói đó chưa có cổng thao tác bản sao/kích hoạt và phục hồi mô tả dưới đây.
Các chức năng mới cần package mới từ source và Release native hiện tại.
Truyền `-PackageDirectory` tường minh khi chạy launcher từ repository. Default cũ
vẫn giữ đến gate cutover; launcher bên trong package chọn chính package chứa nó.
[Contract, cấu hình nguồn và bằng chứng](plans/2026-10-19-integrated-mvp.md).
Tài liệu trong source bổ sung kết quả kiểm chứng mới nhất; bản tài liệu nằm trong
package là snapshot lúc build. Không sửa package chỉ để cập nhật kết quả kiểm thử.
Danh sách dự án dùng projection metadata của owner C++ để tránh tải cả graph.
Metadata không chứng minh toàn bộ graph hợp lệ; context/generation/ghi vẫn kiểm
tra tài liệu đầy đủ. [Baseline tổng hợp](benchmarks/2026-10-14-web-local-baseline.md)
không thay nghiệm thu client/operator hay Windows sạch.

Cần Windows x64, Node.js 24 trở lên, Python 3.11 trở lên và MSVC runtime phù hợp
với bản Qt/native từ nguồn tin cậy. Cài mới trên Windows sạch còn là gate nghiệm thu.
Qt DLL/plugins và Python SDK đã nằm trong package; Node/Python chưa được bundle.

Gói mới còn chứa `bin/lmti-audit-acl.exe`, helper Windows native để giữ nguyên
DACL khi thay file audit. Helper được publisher build và đưa vào manifest;
không cần khởi động PowerShell cho mỗi lần ghi audit. Khi tự build package,
build helper bằng `cmake -S native/privacy -B build/audit-acl -A x64` và
`cmake --build build/audit-acl --config Release`; packaging lấy đúng helper
trong `build/audit-acl/bin` hoặc tham số `-AuditAclHelper` dưới `build/`.
Launcher kiểm tra runtime x64, phiên bản Node/Python, SHA256 của các file được
liệt kê và khả năng nạp native/Qt Core trước khi mở dữ liệu. Nếu lỗi, launcher
dừng, không chuyển sang API source hoặc bỏ xác thực. Có thể chạy kiểm tra riêng:

```powershell
& .\scripts\test-local-web-package.ps1
```

Doctor không đọc dữ liệu Studio hay cấu hình cá nhân và không kiểm tra mạng.
Manifest là bằng chứng tính toàn vẹn, không phải chữ ký nhà phát hành. File ngoài
danh sách bị từ chối, ngoại trừ cache `.pyc` trong SDK; cache này không được xác
thực bằng manifest. Chỉ chạy gói
và Node/Python từ nguồn đã tin cậy. Kiểm tra này không thay nghiệm thu Windows sạch.
Chọn thư mục dữ liệu Studio đang có `project-library.sqlite`; dự án và thư mục
liên kết phải được đăng ký trong Qt Studio trước.

```powershell
& .\scripts\start-local-web.ps1 -DataDirectory 'C:\path\to\studio-data'
```

Launcher mở trình duyệt với mã dùng một lần, xóa mã khỏi thanh địa chỉ ngay khi
UI bắt đầu. Không sao chép URL khởi động riêng tư hoặc gửi token vào chat.
Mở lại bằng launcher nếu tải lại trang hoặc phiên hết hạn. `-NoBrowser` chỉ dành
cho kiểm tra startup, không cấp phiên cho một tab mở thủ công. Service chỉ bind
`127.0.0.1`; không expose qua LAN, Cloudflare Tunnel hay Tailscale Serve.
Service tự đóng khi không còn phiên/mã khởi động hợp lệ hoặc thao tác ghi đang
chạy, kiểm tra mỗi 30 giây. Đóng tab không hủy thao tác ghi đã được nhận.

## Luồng chính

1. Chọn dự án, mở **Agent** để thêm/sửa/xóa kết nối. Local LMTI cần site đã có trong topology.
2. Remote/Cloudflare/Tailscale dùng endpoint MCP HTTPS không chứa credential,
   query hoặc fragment. Đăng nhập OAuth trong Codex/Cursor; không nhập token ở đây.
3. **Preview setup** cho từng client → kiểm tra diff → **Apply to project**.
   Lưu profile riêng không tự ghi file client. Cấu hình ngoài phạm vi LMTI được giữ.
4. **Restore** → xem trước → xác nhận; owner dùng bản sao được DPAPI bảo vệ.
5. **Export** chỉ xuất cấu hình do LMTI tạo. **Check** kiểm tra handshake LMTI local;
   endpoint từ xa và trạng thái sử dụng client thật chưa được kiểm chứng bởi UI.

Khi profile/file thay đổi ở nơi khác, tải lại và tạo preview mới. Nếu mạng ngắt
trong thao tác ghi, kiểm tra trạng thái trước; không gửi lặp. Nếu service trả
pending, giữ trang mở và xem kết quả. Hoạt động chỉ là các thao tác trong phiên
browser hiện tại trong **Work → Session activity**, không phải nhật ký tool-call của Agent. **Work**
còn có phần đọc bằng chứng bản sao/biên nhận do native owner giữ lại; phần này
khác với timeline của phiên.

## Bật bản sao, kích hoạt và phục hồi

Quyền này độc lập với `-AgentSite` và nguồn context. Truyền `-ProjectOperations`,
hai thư mục local đã tồn tại `-CopyParent`/`-BackupParent`, và danh sách rõ ràng
`-OperationProjectId`. Thư mục bản sao và sao lưu phải khác nhau, nằm ngoài
package và mọi thư mục `.lmti`; launcher từ chối đường dẫn mạng, device,
alternate stream và symlink/junction. Browser không chọn đường dẫn hay nâng quyền.

```powershell
& .\scripts\start-local-web.ps1 -DataDirectory 'C:\path\to\studio-data' -PackageDirectory 'C:\path\to\current-web-package' -ProjectId factory-monitor -ProjectOperations -OperationProjectId factory-monitor -CopyParent 'C:\path\to\project-copies' -BackupParent 'C:\path\to\library-backups'
```

Mọi `OperationProjectId` phải thuộc `ProjectId` của phiên. Tự lấy danh sách dự án
để hiển thị không tự cấp quyền thao tác. Với dự án đã bị bỏ khỏi danh sách hiện
tại, truyền ID lịch sử rõ ràng ở cả hai tham số; **Granted project scope** trong
**Work** vẫn cho chọn phạm vi đã cấp để đọc biên nhận. Không cần mở được dự án
nguồn để đọc lịch sử kết thúc hoặc hủy một biên nhận prepared hợp lệ.

Chỉ thêm `-AllowLibraryUpgrade` khi chủ đích cấp bảo trì toàn thư viện, kể cả
các dự án khác trong thư viện. Có thể bỏ `-OperationProjectId` để chỉ cấp bảo
trì; vẫn phải truyền hai thư mục cố định. Hai bước nâng thư viện 1→2 và 2→3
có bản xem trước và xác nhận riêng. Tạo bản sao chuyển đổi/clone không tự chọn
bản sao làm dự án đang dùng. Chuẩn bị biên nhận, kích hoạt và hủy biên nhận đều
là thao tác được duyệt riêng; giữ nguyên nguồn và thư mục liên kết, không gửi
lệnh thiết bị hay tự sửa cấu hình Codex/Cursor sau kích hoạt.

Trong **Work**, kiểm tra trạng thái → đọc bản sao/biên nhận →
xem trước → xác nhận. Preview chỉ dùng một lần và hết hạn sau hai phút.
`pending` giữ thao tác sống cho đến khi process kết thúc; đóng HTTP, hết phiên
hoặc chuyển trạng thái UI không hủy writer. `unknown` không phải bằng chứng
thao tác thất bại. Không gửi lại; đọc trạng thái hiện tại, tạo lượt duyệt phục hồi
và xác nhận bằng chứng mới trước một preview riêng tiếp theo. Lịch sử cũ vẫn
giữ kết quả chưa rõ. Phục hồi chỉ xác nhận phạm vi đã đọc, không chứng minh toàn
bộ dữ liệu đã được đối chiếu hoặc xác định được yêu cầu ghi bị mất phản hồi.

Khi khởi động lại, **Check writer admission** chỉ kiểm tra broker/writer cũ đã
yên; đây là bước riêng với đối chiếu native. Không xóa marker/lock để bỏ qua
trạng thái chặn. Lần bật đầu tiên không có marker không chứng minh các runtime
cũ chưa tham gia điều phối đã dừng: đóng/drain chúng trước, hoặc dùng phạm vi
dữ liệu thử nghiệm mới. Đây là điều phối local, không phải khóa phân tán hay
bảo đảm exactly-once qua mọi tình huống máy dừng đột ngột.

## Bật inventory trong Architecture và nguồn context

Quyền đọc phải được chọn ở launcher cho đúng một project/site; browser không
được chọn file nguồn hoặc nâng quyền. Ví dụ với ID dự án mẫu đã đăng ký:

```powershell
& .\scripts\start-local-web.ps1 -DataDirectory 'C:\path\to\studio-data' -PackageDirectory 'C:\path\to\studio-web-integrated-20261019-r3' -ProjectId factory-monitor -AgentSite factory-demo -AgentTarget external -IntegrationConfig 'C:\path\to\integration.json'
```

Bỏ `-IntegrationConfig` để chỉ đọc cấu trúc và review desired configuration.
File integration JSON là cấu hình tin cậy chứa mapping/source pin, không chứa
credential; xem mẫu đầy đủ trong báo cáo tích hợp. Memory chỉ xuất summary của
owner khi có `disclosure: owner_safe_summary`, giữ nguyên phân loại public/internal.
Khi bật integration với `AgentTarget external`, Export/Preview/Apply đưa đường
dẫn config và SHA-256 đã duyệt vào launcher MCP. Site của mọi kết nối local đang
bật phải khớp site được cấp quyền; scope local không thể xuất cho client ngoài.
Sau khi sửa config có chủ đích, kiểm tra rồi khởi động lại launcher, tạo preview
và áp dụng cấu hình mới, sau đó kết nối lại MCP trong client. Config cũ giữ digest
cũ sẽ bị từ chối. Phát hiện file đổi/xóa thu hồi scope của phiên; chép lại byte
cũ không tự khôi phục quyền. Restore cấu hình client vẫn có thể dùng khi nguồn
bị thu hồi; thao tác này không cấp lại quyền đọc nguồn.
Observation hiện chỉ là controlled replay. Giá trị cũ, unknown hoặc nguồn thu hồi
quyền không được trình bày như kết nối thiết bị live.

## Qt dự phòng và giới hạn

```powershell
& .\scripts\start-local-studio-fallback.ps1 -DataDirectory 'C:\path\to\studio-data'
```

Qt vẫn tạo/liên kết dự án và sửa topology. Web gọi cùng native owner cho bản sao,
nâng định dạng thư viện và kích hoạt được duyệt; không tự ghi SQLite. Trong
**Architecture → Inventory & relationships**, inventory/entity/relations được đọc
qua native owner; **Knowledge** hiển thị source/evidence và task context khi launcher
đã cấp quyền. Tab Desired settings
cho asset có review/commit `enabled` và `pollMs`; chỉ ghi desired configuration,
không gửi lệnh thiết bị. Không có quyền đọc opt-in thì tính năng này báo chưa hỗ trợ.
Trạng thái thiết bị thật thuộc OBS-01, chưa được kết nối. Google Drive, lesson và
impact review giữ luồng native hiện có; launcher Qt trong package này không tự
bật các quyền tích hợp đó. Dùng launcher repository hiện có khi cần các quyền ấy.
SQLite topology/profile chỉ lưu dữ liệu nonsecret và chưa mã hóa. Phiên web là
quyền operator local, không phải sandbox hay phân quyền nhiều người.

## Build trong repository

```powershell
corepack pnpm install --frozen-lockfile --ignore-scripts --store-dir .pnpm-store
corepack pnpm web:build
& .\scripts\package-local-web.ps1
& .\scripts\start-local-web.ps1 -DataDirectory 'C:\path\to\studio-data'
```

Package script cần hai package native đã build, nhận đường dẫn tương đối trong
`build/`, ghi vào thư mục mới để giữ bản cũ. `manifest.json` ghi SHA256 file để
review tính toàn vẹn, gồm helper cố định `web-broker-guard.py`; doctor kiểm tra
mọi file được liệt kê. Dùng cùng một lần cài native Release mới cho cả
`-NativePackage` và `-AdminPackage` để không trộn Qt desktop cũ với CLI mới.
Đây không phải chữ ký publisher. Chạy `lmti publish preflight`
trước push/PR/release; kiểm tra `.gitignore` cho `.env`, secrets và client runtime.
