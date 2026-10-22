# Kế hoạch dọn dẹp và thống nhất LMTI

> Planning status, 2026-10-13: this is a dated scope/evidence record.
> The [consolidated master plan](../LMTI_MASTER_PLAN.md) owns current priorities
> and M0–M4 milestones. Earlier stage orders and unfinished work below are
> reference material, not a separate active backlog. Accepted architecture and
> recorded evidence remain valid within their stated scope.

Ngày: 2026-10-11. Trạng thái: **đã triển khai C0–C3; C4 và nghiệm thu thủ công C5 còn gate**. Xem [báo cáo thực thi](2026-10-11-cleanup-execution.md) cho kết quả hiện tại.

Tài liệu này cụ thể hóa việc chuyển tiếp trong [master plan](../LMTI_MASTER_PLAN.md), dựa trên [ADR native topology đã chấp nhận](../adr/2026-10-11-native-topology.md). Đây là backlog dọn dẹp hỗ trợ các mốc P0–P3, không tạo thêm một roadmap sản phẩm. Các nhận xét hiện trạng bên dưới lưu baseline lúc lập kế hoạch; trạng thái mới được ghi riêng trong báo cáo thực thi. Mọi thay đổi có sẵn trong working tree được bảo toàn.

## 1. Hướng thống nhất

**Ưu tiên Architecture Studio C++/Qt và ranh giới Agent Python; bảo toàn memory, context, privacy, verification và lesson của LMTI bằng contract và bằng chứng kiểm thử.** Không đặt mục tiêu chuyển toàn bộ repository sang một ngôn ngữ.

Đề xuất cách mô tả chung để đồng bộ tài liệu:

> LMTI tổ chức hiểu biết dự án và kiến trúc hệ thống, cung cấp context tối thiểu có kiểm chứng cho AI Agent. Architecture Studio là ứng dụng desktop cho domain topology/IoT; memory, privacy, verification và lesson tiếp tục là các năng lực nền tảng độc lập.

Cách mô tả này giữ tầm nhìn IoT trong master plan và giá trị ban đầu của LMTI. Năng lực hiện có vẫn là công cụ local alpha: topology editor, lưu SQLite, context theo scope và proposal cấu hình. Connectivity, gateway, telemetry, RBAC nhiều người dùng và thực thi thiết bị là các mốc sau, không được tính là đã có.

Phân công công nghệ:

| Thành phần | Vai trò trong giai đoạn chuyển tiếp |
| --- | --- |
| C++ domain core | Sở hữu mô hình topology có kiểu, validation và quy tắc revision; độc lập Qt |
| Qt adapters / Qt Widgets | SQLite và JSON boundary cho topology; desktop/canvas/inspector/review |
| Python SDK / MCP | Truy cập topology có scope, tạo proposal; gọi native CLI theo contract hiện tại |
| TypeScript | Tiếp tục phục vụ memory/context/privacy/compiler/lesson và CLI hiện hữu; implementation tham chiếu cho các contract cần tái sử dụng |
| Go | Giữ các lệnh memory thử nghiệm tương thích; sửa lỗi cần thiết, đóng băng mở rộng domain mới |
| SQLite | Các database theo domain và schema riêng; không đồng nghĩa dùng chung một file |
| JSON | CLI/API/MCP/proposal, artifact trao đổi; JSON memory cũ được giữ trong diện tương thích cho tới khi migration đủ điều kiện |

Python control service trong master plan là bước tương lai. Không tạo service, gateway hoặc port memory sang C++ chỉ để làm sơ đồ thư mục trông thống nhất.

## 2. Giá trị cốt lõi phải giữ và cách chứng minh

| Giá trị | Yêu cầu khi dọn dẹp | Bằng chứng nghiệm thu |
| --- | --- | --- |
| Hiểu biết tái sử dụng | Giữ compiler, Project Atlas, ID và liên kết nguồn; không biến topology thành một bản dump repo | Cùng fixture vẫn dựng được context liên quan và lần về nguồn |
| Memory có chủ đích | Giữ lesson/rule/decision, vòng đời short memory và trạng thái review; không lưu raw chat | Lesson candidate chưa duyệt không tự thành lesson đáng tin; expiry/promotion đúng contract |
| Privacy theo quyền | Không hạ nhãn, bỏ `do_not_prompt`, mở scope hoặc bỏ egress gate để đạt parity | Các ca deny vẫn deny sau refactor/migration; đầu ra không chứa nội dung bị chặn |
| Verification và provenance | Phân biệt khai báo, quan sát, suy luận; memory là prior belief | Revision/source/freshness còn kiểm tra được; thiếu telemetry vẫn là unknown |
| Quyền kiểm soát của người vận hành | Proposal tách khỏi apply/save; không sinh quyền thực thi từ đường nối canvas | Proposal không thay database; revision cũ và scope sai bị từ chối |
| Modularity và khả năng thay thế | Tách domain, storage, UI và Agent; không phụ thuộc riêng một model | Core không nhập Qt; Agent không nhận store handle; contract chạy độc lập adapter |
| Giảm lý luận lặp lại | Context có giới hạn, tái dùng compiled understanding, skill routing chỉ cung cấp hướng dẫn | So sánh context size/token và truy vấn trên cùng fixture; tăng chi phí phải có lý do |
| Host-project boundary | `.lmti/` vẫn là lớp context bên ngoài ứng dụng host | Không di chuyển/import `.lmti/` vào runtime ứng dụng; không xóa memory trong cleanup |

Năm câu hỏi trong constitution đều có mục tiêu cụ thể: làm rõ ownership tăng hiểu biết; một bản đồ hiện trạng giảm khảo sát lặp; contract giữ kiến thức tái sử dụng; privacy/provenance bảo vệ tri thức; adapter cho phép từng phần tiến hóa độc lập. Hạng mục chỉ đổi tên/di chuyển thư mục mà không đạt các mục tiêu này có ưu tiên thấp.

## 3. Hiện trạng và các điểm cần sửa trước

Khảo sát này đọc source/config/docs; **không chạy lại toàn bộ build/test**. Các số 185 test TS, 8 test Python và 3 executable CTest trong [Studio guide](../topology-studio.md) là kết quả đã được tài liệu ghi nhận trước lượt này, không phải bằng chứng mới của kế hoạch.

- Không có `.lmti/project.amf.json` trong workspace tại lúc khảo sát. Đã đọc manifest và dùng hàm `detectFramework` sẵn có ở chế độ chỉ đọc; detector nhận pnpm monorepo, 20 app/package, nhưng framework `unknown`. CMake, Qt và Python được xác nhận bổ sung từ `CMakeLists.txt` và `python/pyproject.toml`; không lấy detector JS làm toàn bộ build matrix.
- Working tree có cả thay đổi tracked và source native/Python chưa tracked. Một commit SHA riêng lẻ không đại diện đầy đủ baseline này. Cần lưu inventory/diff nguồn trước khi thực hiện cleanup.
- [README](../../README.md) và [architecture](../architecture.md) còn định nghĩa chủ yếu theo memory cho coding agent; master plan đã mở domain IoT. Cần giải thích quan hệ giữa năng lực nền tảng và Studio.
- [Roadmap Go](../roadmap.md) vẫn ghi `Go = Core Runtime`; [JSON boundary](../json-boundary.md) còn mô tả core bằng Go structs. ADR mới chỉ thay lựa chọn cho domain topology, không chuyển toàn bộ memory sang C++.
- JSON boundary còn quy định envelope CLI quá rộng: memory CLI có `lmti.cli.v1`, topology có `lmti.topology.context.v1`/`lmti.topology.proposal.v1`, MCP dùng JSON-RPC. Cần bảng contract theo entry point, không ép đổi tất cả envelope trong một lần cleanup.
- [ROADMAP gốc](../../ROADMAP.md), roadmap trong docs và các build spec cũ có thứ tự ưu tiên khác nhau. Master plan phải điều phối; tài liệu lịch sử cần nhãn phạm vi và liên kết thay thế.
- README còn hạng mục thiếu Go toolchain trong khi Studio guide ghi đã chạy Go test. Cần ngày kiểm chứng và trạng thái rõ ràng, không kéo baseline cũ thành lỗi hiện tại.
- `packages/runtime`, `cognition`, `world-model` còn được CLI dùng. `packages/context` là loader của demo runtime, khác context chính trong `kernel`; không quyết định xóa chỉ từ tên thư mục.
- MCP TypeScript là stub project-memory; MCP Python có transport thật nhưng chỉ cho topology. Chưa có bằng chứng thay thế toàn bộ semantics hoặc nghiệm thu qua một sản phẩm Agent bên ngoài.

**[CẢNH BÁO BẢO MẬT]** `migrateJsonMemoryToProjectMemory` hiện chỉ nhập long-term/lessons và chưa truyền tường minh `sensitivity`, `promptPolicy`, `sourceRefs` gốc. Đây là khoảng trống kiểm tra tĩnh, chưa phải kết luận đã xảy ra rò rỉ. Không dùng kết quả import thành công làm căn cứ xóa nguồn hoặc cho phép xuất context sau migration.

**[CẢNH BÁO BẢO MẬT]** SQLite topology MVP chưa mã hóa, chỉ hỗ trợ metadata public/internal không bí mật. Không đưa memory private/secret vào đó hoặc diễn giải launcher grant thành sandbox OS/RBAC. Taxonomy topology không được thay thế policy memory phong phú hơn.

## 4. Ma trận giữ, chỉnh, đóng băng và lưu trữ lịch sử

“Đóng băng” nghĩa là ngừng thêm tính năng ngoài hướng hiện tại, vẫn giữ tương thích và sửa lỗi/bảo mật. “Ứng viên archive” chưa phải cho phép xóa hoặc bỏ khỏi build.

| Nhóm | Quyết định đề xuất | Điều kiện / công việc |
| --- | --- | --- |
| `native/`, `apps/desktop/`, `python/` | Trục phát triển chính | Giữ domain/UI/storage/Agent tách biệt; không thêm execution trong cleanup |
| `packages/memory`, `privacy`, `compiler`, `graph`, `kernel`, `types` | Giữ và củng cố contract | Bảo toàn retrieval, privacy, compiled context và lesson; không port hàng loạt |
| `packages/frameworks`, `migration`, `cli`; `skills/`, `schemas/` | Giữ và đồng bộ | Giữ verification, publish preflight, command/schema và skill routing; kiểm kê entry point thật |
| `packages/runtime` | Tách theo trách nhiệm khi có nhu cầu | Giữ context/mind/action đang dùng; cô lập `CoreRuntime` demo trước khi giảm dependency |
| `packages/cognition`, `world-model` | Đóng băng phần experimental | Chỉ archive sau khi các command/caller còn cần được thay bằng contract tương đương |
| `packages/context`, `security`, `tools`, `agents` | Phân loại từng API | Còn phục vụ runtime/demo; tách phần giá trị khỏi demo, không xóa trọn nhóm |
| `packages/mcp` | Gắn nhãn legacy stub | Không quảng bá như MCP server đã phát hành; chỉ retire khi xác nhận consumer/contract và đường thay thế |
| `packages/reasoning` | Ứng viên archive sớm | Source hiện là placeholder; cần kiểm tra đầy đủ caller/export/build references trước khi loại khỏi workspace |
| `apps/playground`, `apps/codex-assistant` | Giữ dưới diện demo/reference | Đưa ra khỏi quickstart chính; chỉ đổi build profile sau khi xác nhận test/consumer |
| `cmd/lmti`, `internal/`, `pkg/` | Giữ compatibility Go | Giữ memory/privacy/migration/publish/skill contracts; không tiếp tục coi Go là đích topology |
| RFC, papers, research, sprint/spec ATLAS cũ | Archive bằng trạng thái/chỉ mục trước | Giữ ý tưởng, quyết định và bằng chứng; không dùng như backlog đang hiệu lực; di chuyển vật lý là bước riêng |
| `.lmti/`, `.atlas/`, database, lessons, audit | Bảo vệ dữ liệu | Không nằm trong danh sách xóa source; migration/retention là workflow riêng |
| `.tools/`, build output, cache | Ưu tiên thấp | Chỉ dọn artifact đã xác định tái tạo được; không coi mọi file dưới `build/` là rác vì có thể chứa topology người dùng lưu |

Giữ public name **LMTI**, dùng **Architecture Studio** cho ứng dụng. **Project Atlas** tiếp tục là compiled project map. Chưa đổi hàng loạt `@atlas/*`, root package hoặc alias CLI; đổi namespace không phải điều kiện đạt kiến trúc mới.

## 5. Quy tắc sở hữu dữ liệu và migration

| Store / artifact hiện tại | Chủ sở hữu đang dùng | Xử lý trong cleanup |
| --- | --- | --- |
| `.lmti/memory/project-memory.sqlite` | TS project-memory, schema v4 | Giữ đường memory/lesson/short-memory hiện tại |
| `.lmti/memory.sqlite` | Go schema qua Node SQLite bridge | Giữ riêng; Go không phải đường SQLite hoàn toàn độc lập Node |
| `.lmti/memory/{long-term,short-term,lessons}.json` | Legacy TS; còn dùng bởi `remember`, `context` và các đường compatibility | Kiểm kê reader/writer trước migration; không xóa chỉ vì có SQLite |
| Runtime InMemoryStore | Session/demo | Không giả định có durability; chỉ chuyển nếu cần giữ dữ liệu thực |
| File topology SQLite do operator chọn | Native topology schema/application ID | Không mở như memory DB, không hợp nhất schema |
| Project Atlas / AMF | Compiler artifact | Giữ version/source boundary; có thể tái tạo từ source phù hợp, không thay thế deliberate memory |

Mỗi schema/version cần một implementation chịu trách nhiệm ghi và migration, với transaction/revision để điều phối nhiều phiên. Nguyên tắc này không có nghĩa gom tất cả domain vào một database hay cấm nhiều reader.

Nếu cần hợp nhất các đường **memory**, làm thành thay đổi riêng sau khi contract đã ổn định:

1. Kiểm kê command → reader/writer → path → schema → privacy/provenance → consumer. Chỉ thu metadata cần thiết; không đưa raw memory vào báo cáo.
2. Chọn store đích cho đúng domain; chưa chọn bằng cách so tên file. Với secret/confidential cần storage và quản lý khóa phù hợp trước khi tiếp nhận; không coi redaction hoặc ignore rule là mã hóa.
3. Viết bảng ánh xạ ID, sensitivity, prompt policy, source refs, timestamps, TTL, review/approval, confidence, trạng thái archive và liên kết. Không có ánh xạ an toàn thì chặn/quarantine cục bộ; không mặc định về public/internal hoặc active/approved.
4. Dùng fixture tổng hợp, bao gồm nội dung trông bình thường nhưng nhãn `secret`/`do_not_prompt`. Chứng minh policy không bị hạ, nguồn vẫn truy vết được, lesson pending không tự được duyệt và short memory không được hồi sinh sai TTL.
5. Dry-run chỉ lập báo cáo. Backup nhất quán bằng cơ chế SQLite phù hợp hoặc dừng writer; không copy mỗi file `.sqlite` khi WAL đang hoạt động. Backup được bảo vệ như dữ liệu nguồn, không đưa vào Git.
6. Import vào đích mới, giữ nguồn; kiểm tra integrity, số lượng theo loại, mapping ID, policy/provenance, idempotency và kết quả truy vấn. Short-term/audit/associations phải có quyết định giữ/chuyển/retention rõ ràng, không bỏ qua im lặng.
7. Chuyển writer theo một điểm cắt có kiểm soát; không dual-write tự phát. Lưu kế hoạch rollback gồm cả dữ liệu phát sinh sau cutover; không khôi phục backup cũ đè lên các ghi mới.
8. Chỉ ngừng reader/writer cũ sau parity, đối soát và diễn tập rollback. Xóa dữ liệu nguồn cần một quyết định retention riêng; hoàn thành cleanup source không tự cấp quyền xóa memory.

## 6. Các đợt thực hiện và điều kiện đi tiếp

Các mã C0–C5 dưới đây là đợt cleanup, không thay P0–P6 trong master plan. Mỗi đợt là một thay đổi nhỏ có thể review và hoàn tác độc lập. Chưa ước lượng lịch trước khi chốt baseline và phạm vi dependency.

| Đợt | Công việc cụ thể | Sản phẩm / điều kiện hoàn thành |
| --- | --- | --- |
| **C0 — Chốt hiện trạng** | Inventory tracked/untracked source, command/store/dependency; ghi toolchain và kết quả chạy thật | Snapshot nguồn cục bộ tái lập được; support matrix TS/Go/native/Python; test pass/fail/skip và blocker ghi riêng |
| **C1 — Một hướng tài liệu** | Đồng bộ README, AGENTS, architecture, development, JSON boundary, naming; roadmap cũ thành chỉ dẫn có nhãn lịch sử | Không còn mô tả Go sở hữu topology; tách implemented/experimental/planned; master plan điều phối một backlog |
| **C2 — Bảo vệ contract** | Lập ma trận invariant và tái dùng test hiện có; bổ sung test thiếu cho privacy migration và boundary | Các behavior đang hỗ trợ được bảo toàn; lỗi bảo mật đã biết có regression gate, không coi là behavior cần giữ |
| **C3 — Thu gọn đường phát triển** | Tách runtime demo khỏi API còn dùng theo từng lát cắt; gắn nhãn stub/demo; loại reference placeholder khi đủ chứng cứ | Build/test/command không mất chức năng; CI theo từng stack; không thêm coupling native ↔ TS nội bộ |
| **C4 — Chuẩn hóa memory nếu cần** | Thực hiện workflow mục 5; đây là bước có điều kiện, không bắt buộc port language | Dry-run, policy/provenance parity, đối soát, cutover và rollback đều có bằng chứng; nguồn chưa bị xóa |
| **C5 — Đóng đợt và xác nhận Studio** | Cập nhật reality checklist; chạy một luồng operator + Agent thật; archive source không còn consumer khi đủ gate | Có báo cáo tái lập, capability đúng thực tế, lesson candidate an toàn và danh sách phần còn deferred |

Thứ tự: **C0 → C1/C2 → C3 → C5**. C1 và C2 có thể làm song song sau inventory. C4 chỉ mở khi việc hợp nhất memory có lợi ích cụ thể, và là điều kiện bắt buộc trước retire store tương ứng. Không để migration lớn chặn việc thống nhất tài liệu và giảm độ rối của MVP.

Các thay đổi đầu tiên nên chuẩn bị:

1. **CLEAN-DOC-01:** sửa các mô tả mâu thuẫn; root roadmap tóm tắt/link master, roadmap Go giữ dưới nhãn lịch sử. Đồng bộ template sinh AGENTS trong `packages/cli/src/index.ts`, không chỉ AGENTS ở root. Không thay các điều khoản privacy/host boundary.
2. **CLEAN-MAP-01:** bảng capability/command/store/dependency có owner và trạng thái. Dựa vào `package.json`, TS project references, CMake targets, Python entry point và Go bridge; không chỉ đếm thư mục.
3. **CLEAN-CONTRACT-01:** coverage map từ test hiện có; ưu tiên lấp khoảng trống migration nhãn privacy/provenance trước mọi thử nghiệm dữ liệu thật.
4. **CLEAN-SURFACE-01:** docs/quickstart đưa Studio và CLI memory vào đúng luồng; stub/demo/experimental có nhãn. Chỉ bỏ placeholder hoặc dependency sau kiểm tra caller.
5. **CLEAN-VERIFY-01:** support matrix toolchain và CI; nghiệm thu một MCP client/Agent bên ngoài bằng dữ liệu tổng hợp trước khi gọi P3 hoàn tất.

Chủ dự án quyết định scope/retirement và chính sách dữ liệu. Người thực hiện từng đợt chịu trách nhiệm mã/test/tài liệu; reviewer kiểm tra policy, migration và bằng chứng. Không tự giả định có thêm nhân lực hoặc quyền triển khai.

## 7. Kiểm chứng, hiệu năng và rollback

Tái dùng bộ test hiện có trước khi tạo thêm test; chỉ bổ sung nơi thiếu hành vi cần bảo vệ:

| Phạm vi | Kiểm chứng cần giữ |
| --- | --- |
| TS memory/context/privacy | Build và Vitest; secret/do_not_prompt, egress, lesson review, source refs, preflight và publish protected paths |
| Go compatibility | `go test ./...` kèm số test skip; xác nhận Node có `node:sqlite` vì storage test có thể skip khi thiếu runtime |
| Native domain/storage/UI | CTest: validation, round-trip, revision conflict, scope/visibility, malformed/oversized input, save/open/undo/redo |
| Python SDK/MCP | Unittest qua native binary và stdio process thật; argument validation, launcher scope, timeout, proposal không ghi DB; ghi số test skip vì integration suite bỏ qua khi thiếu `LMTI_TOPOLOGY_BINARY` |
| Agent thực | Một client được đặt cấu hình bởi operator: đọc đúng site/public, tra ID, nhận revision, tạo diff; review/apply/save qua UI; ghi rõ dữ liệu đã lưu và document chưa lưu |
| Migration | Nhãn policy không hạ; giữ provenance/TTL/review; idempotency; DB/WAL nhất quán; đối soát và rollback sau cutover |
| Docs/build graph | Link tồn tại; cùng tên công nghệ/trạng thái; không còn import/export/project reference mồ côi sau archive |

Lệnh build native và thiết lập môi trường lấy từ [Studio guide](../topology-studio.md), không tạo thêm một bộ hướng dẫn dễ lệch. Các smoke command có khả năng ghi chạy trong workspace fixture riêng; không dùng memory của chủ dự án làm dữ liệu test. Node 24 là đường kiểm chứng đầy đủ được docs/CI hiện tại sử dụng; cần giải thích lại `engines >=20` thay vì giả định mọi lệnh hỗ trợ giống nhau.

Đối với mở rộng tải, đo riêng query/context p95/p99, dung lượng context, thời gian save/open, frame time và RAM canvas trên cùng fixture node/edge/site. Thử nghiệm mô hình 1.000 assets không chứng minh GUI 10.000 assets hoặc OT production. Không port ngôn ngữ để thay cho đo bottleneck; không gom telemetry vào memory. Ngân sách hiệu năng được chốt từ baseline, không tự đặt cam kết chưa đo.

Các điểm đo ưu tiên từ source hiện tại: [SQLite adapter](../../native/storage/sqlite_store.cpp) có thể duyệt nhiều link trong scope để chọn các link thuộc tập context, nên output cap không đồng nghĩa chi phí query nhỏ; save ghi lại snapshot trong transaction. [Desktop](../../apps/desktop/window.cpp) sao chép document cho undo và dựng lại scene khi cập nhật. Ghi chúng thành benchmark backlog, chưa refactor lớn trước khi có số đo.

Trước phân phối Studio còn cần chạy trên máy Windows sạch, xác minh runtime được đóng gói và hoàn thiện Qt/third-party notices. Build thành công trên máy dev không thay thế gate này; cleanup không tự mở mốc pilot mạng hoặc điều khiển thiết bị.

Điều kiện dừng một đợt: policy yếu hơn, schema mất dữ liệu/nguồn, có caller chưa thay thế, build/test regression, hoặc không khôi phục được dữ liệu phát sinh. Rollback chỉ thay đổi của đợt đó; giữ nguyên các thay đổi có sẵn của người dùng. Với dữ liệu, dừng writer và đối soát trước khi trở về phiên bản cũ; schema mới không được mở bằng writer cũ khi chưa chứng minh tương thích.

Trước push/PR/release hoặc đổi remote: kiểm tra `.gitignore` cho secrets, database, WAL/SHM/journal, runtime và topology riêng; chạy **`lmti publish preflight`**. Nếu ERROR/BLOCKED thì dừng và xử lý theo quy tắc repo. Ignore rule không loại được file đã tracked; chỉ rà tên/path và kết quả đã lọc, không đưa nội dung bí mật vào báo cáo. Không cài dependency mới trong đợt lập kế hoạch này; mọi thay đổi dependency sau đó cần xác minh nguồn chính thức và advisory tại thời điểm thực hiện.

## 8. Định nghĩa hoàn thành và bằng chứng tham chiếu

Cleanup được coi hoàn thành khi người mới xác định được hướng chính, phần compatibility và phần deferred từ một đường tài liệu; mọi domain có owner/schema/boundary rõ; contract privacy/verification/lesson còn được kiểm chứng; build graph gọn hơn mà không mất command hay dữ liệu. Tiêu chí không phải số file hoặc ngôn ngữ đã xóa.

Không hoàn tất một đợt archive nếu còn import, re-export, command caller, script build, schema consumer, tài liệu hướng dẫn đang hiệu lực hoặc dữ liệu chưa có đường đọc an toàn. Danh sách kiểm tra áp dụng cả test và tool nội bộ; không có production caller chưa đủ để kết luận thư viện vô dụng.

Nguồn đã đối chiếu:

- [Constitution và integration boundary](../../AGENTS.md), [naming](../naming.md), [host boundary](../host-project-boundary.md), [RFC index](../../rfcs/README.md).
- [Master plan](../LMTI_MASTER_PLAN.md), [ADR native topology](../adr/2026-10-11-native-topology.md), [Studio guide](../topology-studio.md), [khảo sát baseline trước MVP](2026-10-11-iot-agent-platform.md).
- [CLI source](../../packages/cli/src/index.ts): `contextCommand`, `rememberCommand`, framework detection và template AGENTS; [CLI dependency](../../packages/cli/package.json).
- [Memory legacy](../../packages/memory/src/index.ts), [SQLite memory và migration](../../packages/memory/src/sqlite-store.ts): `migrateJsonMemoryToProjectMemory`, schema v4; [verification contract](../verification-model.md).
- [Go storage/Node bridge invocation](../../internal/storage/storage.go), [storage skip condition](../../internal/storage/storage_test.go), [Go schema](../../internal/storage/schema.sql).
- [TS MCP stub](../../packages/mcp/src/server.ts), [Python MCP](../../python/src/lmti_topology/mcp.py), [placeholder reasoning đã archive](../../research/archive/reasoning/src/index.ts).
- [Build TS](../../package.json), [project references](../../tsconfig.json), [CMake](../../CMakeLists.txt), [Python manifest](../../python/pyproject.toml), [TS CI](../../.github/workflows/ci.yml), [native/Python CI](../../.github/workflows/topology.yml).

Lesson candidates để review sau khi có bằng chứng triển khai, chưa lưu vào memory:

- Thống nhất semantics và quyền sở hữu trước khi thống nhất implementation hoặc schema.
- Nhãn experimental/legacy không đủ chứng minh một module hoặc store đã hết consumer.
- Migration chỉ đạt khi policy, provenance và trạng thái review được bảo toàn, không chỉ khi số record khớp.
