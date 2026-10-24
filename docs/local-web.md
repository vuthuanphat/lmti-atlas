# LMTI local web

Giao diện React chạy trên máy, mở vào **Overview (Tổng quan)**, dùng cùng C++/SQLite
owners và Python owner để quản lý file client. React + Vite là giao diện duy nhất;
ứng dụng Qt desktop và launcher dự phòng đã được gỡ. Không cần
Vite dev server, dịch vụ cloud hay tài khoản LMTI.

## Candidate v0.2.0-alpha.1

Bản chuẩn bị release dùng package `build/lmti-v0.2.0-alpha.1-windows-x64`.
Truyền `-PackageDirectory` tường minh khi chạy script trong repository; launcher
bên trong ZIP chọn chính package chứa nó. Xem [release notes](releases/v0.2.0-alpha.1.md)
và hồ sơ nghiệm thu đi kèm. Đây là candidate local, chưa công bố.

## Chạy bản đóng gói

Cần Windows x64, Node.js 24 trở lên, Python 3.11 trở lên và MSVC runtime phù hợp
với bản Qt/native từ nguồn tin cậy. Cài mới trên Windows sạch còn là gate nghiệm thu.
Qt Core/Sql, SQLite driver và Python SDK đã nằm trong package; Node/Python chưa được bundle.
Lấy runtime từ nhà phát hành chính thức. Setup kiểm tra các điều kiện này, không
tự tải/cài package hoặc thay ExecutionPolicy. Nếu Windows chặn script, xử lý qua
chính sách máy/người quản trị; không dùng lệnh bypass để chạy gói chưa tin cậy.

Kiểm tra `SHA256SUMS.txt`, giải nén ZIP tin cậy vào thư mục mới. Tài liệu nằm trong
package là snapshot lúc build; QA nguồn có thể ghi kết quả kiểm thử mới hơn.
Không sửa package chỉ để cập nhật test. Khi chạy script từ repository, truyền
`-PackageDirectory` trỏ tới candidate cụ thể; script trong ZIP chọn chính gói đó.

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

## Thiết lập workspace mới

Nhấp đúp **`LMTI.cmd` ở thư mục gốc package đã giải nén** để bắt đầu lần đầu.
Đây là lối mở cùng setup đã review; không tự tải dependency hay bypass policy.
Hoặc từ thư mục đã giải nén, chạy một lệnh:

```powershell
& .\scripts\setup-local-web.ps1
```

1. Chọn đường dẫn tuyệt đối cho một **thư mục workspace mới**, ngoài package và
   `.lmti/`. Không dùng thư mục đã tồn tại, thư mục mạng hoặc symlink/junction.
2. Chọn `demo` để có **Factory Monitor** (`factory-monitor`), hoặc `empty` và
   nhập ID/tên dự án. Demo chỉ chứa dữ liệu giả; không kết nối thiết bị/client.
3. Xem quyền được cấp: sửa nội dung của đúng dự án ban đầu, metadata thư viện
   trong `projects/` và các thư mục nguồn mới được duyệt của workspace. Mặc định
   có bốn thư mục: `source/` cho dự án ban đầu và `source-2/`, `source-3/`,
   `source-4/` để dành cho các dự án tiếp theo. Setup hiển thị đầy đủ trước CREATE.
   Agent, hierarchy, sao chép và activation không được bật mặc định.
4. Chọn quyền bảo trì thư viện nếu thật sự cần. Tùy chọn này chỉ cấp quyền nâng
   schema, với thư mục `copies/` và `backups/` riêng; mỗi lần nâng vẫn phải xem
   trước/xác nhận trên web. Không tự nâng schema hoặc cấp thao tác trên dự án khác.
5. Gõ đúng `CREATE`. Doctor phải đạt trước khi setup tạo workspace. Nếu hủy,
   setup không tạo dữ liệu; nếu lỗi sau khi bắt đầu, giữ thư mục dở dang để kiểm
   tra, không chạy lại trên đó hay xóa bằng chứng tự động.

Kết quả gồm `data/`, `projects/`, các thư mục `source/`/`source-N/` đã duyệt, `library-grants.json`,
`lmti-workspace.json` và `Open-LMTI.cmd`/`Open-LMTI.ps1`. Profile chỉ lưu locator,
quyền đã duyệt và pin tính toàn vẹn package, không lưu session token hay mật khẩu.
Các thư mục mới chưa chứa repository thật. Không đưa secret vào project metadata.

Ví dụ có tham số tường minh, vẫn xem và xác nhận quyền trước khi tạo:

```powershell
& .\scripts\setup-local-web.ps1 -WorkspaceDirectory 'C:\LMTI-demo' -Mode demo
& .\scripts\setup-local-web.ps1 -WorkspaceDirectory 'C:\LMTI-empty' -Mode empty -ProjectId my-project -ProjectName 'My project' -NoLaunch
```

`-EnableMaintenance` là lựa chọn bảo trì ở bước 4. `-NoLaunch` chỉ tạo workspace;
`-NonInteractive` dành cho tự động hóa đã review, bỏ bước hỏi và yêu cầu truyền
`-WorkspaceDirectory` tường minh. Không dùng chế độ này để bỏ qua việc xét quyền.
Workspace cũ không được import hoặc ghi đè qua setup; dùng runbook operator phía dưới.

`-ProjectFolderCount` chọn từ **1 đến 8**, mặc định **4**, và chỉ tạo/cấp các thư
mục mới dẫn xuất bên trong workspace. Ví dụ thêm `-ProjectFolderCount 2` để chỉ
chuẩn bị `source/` và `source-2/`. Không cấp đường dẫn repository thật, không scan
nguồn và không sửa các profile cũ chỉ có một folder. Với profile một folder đã
liên kết ban đầu, không có folder trống để tạo thêm project; dùng launcher nâng
cao với JSON folder-grant đã review riêng nếu cần mở rộng.

## Mở lại và đóng đúng cách

Mở **`Open-LMTI.cmd` bên trong workspace**. Có thể mở từ PowerShell:

```powershell
& .\scripts\open-local-workspace.ps1 -WorkspaceFile 'C:\LMTI-demo\lmti-workspace.json'
```

Opener kiểm tra profile, package/pin, grant và runtime trước khi mở dữ liệu.
`-ValidateOnly` kiểm tra mà không bắt đầu phiên web. Không sửa profile để trỏ sang
package/database khác hoặc bật thêm quyền; lỗi pin/path cần được kiểm tra như
một thay đổi cấu hình có chủ đích. Giữ gói gốc cho workspace đó.

Mặc định `Open-LMTI.cmd` và lệnh không có override giữ đúng dự án ban đầu cùng
quyền sửa đã duyệt. Nhấn **O**, đóng/mở lại console hoặc đăng ký dự án trong thư
viện **không tự thêm ID vào quyền phiên**. Để đọc một dự án vừa đăng ký, chỉ định
ID qua opener; native owner kiểm tra mọi ID đã có trong thư viện. Đóng console
workspace cũ bằng Q và đợi drain trước khi mở lựa chọn mới để tránh writer cạnh tranh:

```powershell
& .\scripts\open-local-workspace.ps1 -WorkspaceFile 'C:\LMTI-demo\lmti-workspace.json' -ProjectId new-project
```

Nội dung của dự án mới này chỉ được đọc; các quyền metadata thư viện/bảo trì đã
duyệt vẫn giữ nguyên, nên toàn phiên không phải chế độ chỉ đọc. Để cấp sửa nội
dung có chủ đích cho các ID vừa chọn:

```powershell
& .\scripts\open-local-workspace.ps1 -WorkspaceFile 'C:\LMTI-demo\lmti-workspace.json' -ProjectId new-project -GrantProjectContent
```

`-GrantProjectContent` là **switch**, yêu cầu `-ProjectId` tường minh và cấp sửa
cho **tất cả ID được chọn**. Nếu chọn `factory-monitor,new-project` mà không có
switch, chỉ dự án ban đầu giữ quyền sửa, dự án mới chỉ đọc. Các lựa chọn này chỉ
áp dụng cho lần mở đó, không sửa profile hay launcher đã lưu và không cấp Agent,
hierarchy, copy hoặc activation. Thêm `-ValidateOnly` để xem
`selectedProjectIds`/`contentProjectIds` trước khi mở. Với recovery đang chặn,
giữ phiên mặc định/phạm vi đích ban đầu để đối chiếu trước khi đổi lựa chọn.

Giữ console vận hành mở trong lúc dùng web:

- **O**: mở tab mới với mã xác thực dùng một lần, không lưu token vào profile.
- **Q**: ngừng nhận việc mới, chờ các writer đã nhận hoàn tất rồi đóng service.
  Kết thúc input console (EOF) cũng yêu cầu đóng có drain.

URL cũ, bookmark và reload tab không tạo lại quyền. Khi phiên hết hạn, dùng **O**
ở console đang chạy; nếu console đã đóng, mở lại `Open-LMTI.cmd`. Không chia sẻ
URL khởi động hay token. Mã dùng một lần được xóa khỏi thanh địa chỉ khi UI bắt đầu.
Đóng tab không hủy thao tác ghi đã được nhận; không force-kill service để hủy ghi.
Service chỉ bind `127.0.0.1`; không expose qua LAN, Cloudflare Tunnel hay Tailscale Serve.

## Khi không mở được hoặc không ghi được

| Trạng thái thấy trên web/console | Việc cần làm |
| --- | --- |
| Không kết nối được dịch vụ cục bộ / Local service could not be reached | Kiểm tra console của workspace; nếu đã đóng, chạy lại `Open-LMTI.cmd`. Sau đó dùng O. Cổng cũ có thể thuộc phiên đã dừng. |
| Phiên đã kết thúc/hết hạn hoặc cần phiên riêng tư mới | Dùng O ở console đang chạy. Mở URL cũ hoặc refresh không cấp phiên mới. |
| Private session could not start | Kiểm tra console, đúng package/profile và runtime; mở phiên mới sau khi xử lý nguyên nhân. Không copy mã cũ. |
| Chỉ thấy hướng dẫn dự phòng EN/VI trước khi app tải | JavaScript chính chưa tải/chạy được. Kiểm tra console/package và browser, rồi mở lại bằng launcher; không coi trang trắng hoặc lỗi asset là thao tác ghi thất bại. |
| Lỗi kết nối tạm thời khi phiên còn mở | **Kiểm tra kết nối dịch vụ / Check service connection** chỉ GET trạng thái; không gửi lại thao tác ghi hay xóa recovery. |
| Writer cũ còn giữ quyền / writer busy | Dùng Q trong console cũ để đóng có drain, đợi writer kết thúc; ở Work nhấn **Check writer admission**. Không xóa lock/marker. |
| Không xác minh được điều phối / writer unavailable | Kiểm tra console/package trước. Đây chưa phải bằng chứng database hỏng hoặc thao tác ghi thất bại. |
| Owner không đọc được hoặc kết quả ghi unknown | Giữ nguyên dữ liệu/grant, đọc trạng thái và bằng chứng phục hồi của đích ban đầu. Không tạo project mới để thay thế và không gửi lại thao tác. |

Khi admission và recovery cùng chặn: **kiểm tra admission → xem bằng chứng phục
hồi mới → xác nhận riêng nếu yêu cầu → tạo preview mới**. Admission đã nhận lại
không xác nhận kết quả lần ghi trước. Recovery chỉ xác nhận trạng thái đã đọc;
kết quả trước có thể vẫn `unknown`. Không tự xác nhận thay người vận hành.

Nghiệm thu thủ công theo [phiếu từng bước](operator-acceptance.md); ghi rõ lỗi và
ca chưa chạy. Hướng dẫn này không tự xác nhận nghiệm thu độc lập hoặc Windows sạch.

## Launcher nâng cao và tự động hóa

Với thư viện đang có `project-library.sqlite`, giữ các scope/đường dẫn đã duyệt.
Thêm `-Interactive` cho người vận hành:

```powershell
& .\scripts\start-local-web.ps1 -DataDirectory 'C:\path\to\studio-data' -Interactive
```

Launcher cũ không có `-Interactive` vẫn dành cho tự động hóa. `-NoBrowser` chỉ
kiểm tra startup, không cấp phiên cho tab mở thủ công. Chế độ nền tự đóng khi
không còn phiên/mã khởi động hợp lệ hoặc writer, kiểm tra mỗi 30 giây; không dùng
nó làm console nghiệm thu lâu dài. Không chạy nhiều broker cùng dữ liệu để né
writer gate.

Launcher và doctor dùng pipe UTF-8 tường minh, kể cả Windows PowerShell 5,
để giữ nguyên tên/đường dẫn tiếng Việt. Kiểm tra này không cấp phiên ẩn danh.

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

## Quản lý thư viện trên web

Truyền `-LibraryManagementFile` với JSON local đã duyệt để cấp thư mục metadata,
thư mục nguồn và ứng viên dự án cụ thể. **Work → Project library** hỗ trợ tạo,
đăng ký, ghim, đổi liên kết thư mục và gỡ tham chiếu; giữ nguyên database và file
nguồn. Trình duyệt chỉ chọn key, không gửi đường dẫn. Xem [thiết lập thư viện](library-management.md).
Dự án mới/liên kết mới cần lựa chọn ID tường minh khi mở một phiên mới qua
`open-local-workspace.ps1 -ProjectId`; bật `-GrantProjectContent` riêng nếu cần
sửa. Chỉ nhấn O hoặc chạy lại launcher mặc định vẫn giữ các ID cũ.
Xem [mở lại và chọn phạm vi](#mở-lại-và-đóng-đúng-cách).

Để tạo project thứ hai trong workspace setup mặc định: cấp bảo trì thư viện lúc
setup có chủ đích, chạy **Library upgrade** cần thiết qua preview/xác nhận/sao
lưu, rồi **Create project** với một folder được duyệt **chưa dùng**, ví dụ
`source-2/` (key `workspace-source-2`). `source/` đã thuộc dự án ban đầu; native
owner từ chối dùng chung folder đó cho project khác. Dự án mới được đăng ký
không tự có scope phiên hoặc quyền sửa; dùng lệnh chọn ID tường minh phía trên.

## Sửa nội dung dự án trên web

Cấp quyền tường minh bằng `-ProjectContent -ContentProjectId factory-monitor`
cùng `-ProjectId factory-monitor`. Quyền này độc lập với quyền Agent, hierarchy
và maintenance; mặc định không bật. Mở **Work → Project content** để thêm/sửa/gỡ
13 nhóm nội dung qua xem trước → xác nhận → đọc lại. Xem [hướng dẫn dự án](project-studio.md).
Không gửi lại thao tác có kết quả chưa xác định; kiểm tra trạng thái và phục hồi trước.

## Bật bản sao, kích hoạt và phục hồi

Quyền này độc lập với `-AgentSite` và nguồn context. Truyền `-ProjectOperations`,
hai thư mục local đã tồn tại `-CopyParent`/`-BackupParent`, và danh sách rõ ràng
`-OperationProjectId`. Thư mục bản sao và sao lưu phải khác nhau, nằm ngoài
package và mọi thư mục `.lmti`; launcher từ chối đường dẫn mạng, device,
alternate stream và symlink/junction. Browser không chọn đường dẫn hay nâng quyền.

```powershell
& .\scripts\start-local-web.ps1 -DataDirectory 'C:\path\to\studio-data' -PackageDirectory 'C:\path\to\current-web-package' -ProjectId factory-monitor -ProjectOperations -OperationProjectId factory-monitor -CopyParent 'C:\path\to\project-copies' -BackupParent 'C:\path\to\library-backups' -Interactive
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
& .\scripts\start-local-web.ps1 -DataDirectory 'C:\path\to\studio-data' -PackageDirectory 'C:\path\to\current-web-package' -ProjectId factory-monitor -AgentSite factory-demo -AgentTarget external -IntegrationConfig 'C:\path\to\integration.json' -Interactive
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

## Khởi tạo dự án không cần desktop

Các lệnh dưới đây là CLI operator cục bộ, không được cung cấp cho Agent MCP
hay HTTP. Chọn đường dẫn tuyệt đối trên ổ cục bộ; tạo thư mục dữ liệu và thư mục
dự án trước. Không trỏ vào `.lmti/`. Thay các đường dẫn ví dụ bằng thư mục bạn chọn.

```powershell
& .\bin\lmti-project.exe init-project 'C:\projects\example\project.lmti.sqlite' example 'Example project'
& .\bin\lmti-project.exe library-register 'C:\lmti-data\project-library.sqlite' 'C:\projects\example\project.lmti.sqlite' 'C:\projects\example'
& .\scripts\start-local-web.ps1 -DataDirectory 'C:\lmti-data' -Interactive
```

`init-project` tạo metadata nonsecret/internal trống với ID và tên đã kiểm tra.
Để thử bằng dữ liệu giả, thay lệnh đầu bằng
`lmti-project.exe init-demo <đường-dẫn-file-mới>`; không đăng ký demo vào thư viện
đang có cùng ID. Các lệnh không ghi đè project có sẵn, không scan repository,
không sửa `.lmti/` và không tự cấp quyền cho Agent.

`library-register` tạo thư viện v1 mới bằng reservation độc quyền. Để thêm dự án
khác, trước tiên dùng **Project operations → Library upgrade** với quyền bảo trì
được cấp tường minh theo hướng dẫn phía trên; bản sao lưu được giữ lại. Với thư
viện v2/v3, đăng ký dùng generation/CAS và từ chối ID hoặc thư mục đã tồn tại;
không thay binding cũ. Khi có lỗi, kiểm tra trạng thái hiện tại trước khi thử lại.
Không sửa SQLite trực tiếp hay nâng định dạng ngầm để vượt qua lỗi.

## Phạm vi web và giới hạn

Web gọi native owner cho bản sao, nâng định dạng thư viện và kích hoạt được duyệt;
không tự ghi SQLite. **Architecture → Inventory & relationships** và **Knowledge**
hiển thị dữ liệu/evidence theo scope launcher. Desired settings có review/commit
`enabled` và `pollMs`; chỉ ghi desired configuration, không gửi lệnh thiết bị.
Trạng thái thiết bị thật chưa được kết nối. Các màn hình chỉ có ở Qt trước đây
(canvas topology kéo/thả, Drive/Impact panel) đã bị loại bỏ, không được coi là tính
năng web đã chuyển đổi. CLI/SDK owner độc lập vẫn được giữ.
SQLite topology/profile chỉ lưu dữ liệu nonsecret và chưa mã hóa. Phiên web là
quyền operator local, không phải sandbox hay phân quyền nhiều người.

## Build trong repository

```powershell
corepack pnpm install --frozen-lockfile --ignore-scripts --store-dir .pnpm-store
corepack pnpm web:build
& .\scripts\package-local-web.ps1
& .\scripts\start-local-web.ps1 -DataDirectory 'C:\path\to\studio-data' -Interactive
```

Package script cần hai package native đã build, nhận đường dẫn tương đối trong
`build/`, ghi vào thư mục mới để giữ bản cũ. `manifest.json` ghi SHA256 file để
review tính toàn vẹn, gồm helper cố định `web-broker-guard.py`; doctor kiểm tra
mọi file được liệt kê. Dùng cùng một lần cài native Release mới cho cả
`-NativePackage` và `-AdminPackage` để giữ cùng phiên bản backend. Package từ chối runtime GUI cũ.
Đây không phải chữ ký publisher. Chạy `lmti publish preflight`
trước push/PR/release; kiểm tra `.gitignore` cho `.env`, secrets và client runtime.
