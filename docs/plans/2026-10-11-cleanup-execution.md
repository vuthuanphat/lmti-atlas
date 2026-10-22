# Báo cáo thực thi cleanup LMTI

Ngày: 2026-10-11. Phạm vi: thực hiện [kế hoạch consolidation](2026-10-11-consolidation-cleanup.md)
theo [master plan](../LMTI_MASTER_PLAN.md), tại working tree cục bộ hiện có.
Không có push, PR, release, thay remote hoặc migration dữ liệu người dùng.

## Kết quả theo đợt

| Đợt | Trạng thái | Đầu ra / bằng chứng |
| --- | --- | --- |
| C0 | Hoàn thành baseline cục bộ | Snapshot 283 source/config/docs có hash trong thư mục build bị ignore; lưu git status/HEAD và phân biệt source chưa tracked; baseline build/test cả bốn stack |
| C1 | Hoàn thành | README, constitution, template AGENTS, architecture, development, naming, JSON contract, roadmap và support map cùng một hướng C++/Qt/Python; giữ lõi memory/privacy/verification/lesson |
| C2 | Hoàn thành phần bảo vệ cleanup | Tái dùng coverage hiện có; thêm regression TS/Go chặn migration mất semantics, xác nhận source/target không bị đổi và dry-run không xuất nội dung |
| C3 | Hoàn thành lát cắt có bằng chứng | CLI dùng `@atlas/runtime/agent`; demo tách riêng, root export tương thích; reasoning placeholder archive ngoài workspace; MCP stub và reference apps có trạng thái rõ; Go CI được bổ sung |
| C4 | Chưa mở gate chuyển dữ liệu | Không port/gộp store; TS/Go JSON import writes bị chặn tới khi có mapping lossless, backup/cutover/rollback được kiểm chứng |
| C5 | Tự động đã qua; thủ công còn gate | Build/package, native/Python test, CLI migration smoke, runtime isolation và Agent SDK smoke đã qua; còn operator UI, product MCP-client configuration và máy Windows sạch |

## Các thay đổi cụ thể

- [Support/ownership map](../component-support.md) liên kết component → command → store → contract/test. Master plan điều phối; roadmap coding-agent cũ được giữ ở [archive](../archive/coding-agent-roadmap.md), roadmap Go có nhãn lịch sử.
- TS CLI memory tiếp tục hoạt động. `runtime/src/agent.ts` chỉ xuất context/mind/Action View; `demo-runtime.ts` giữ session/tool/sample-agent code. API package root còn các export trước đây. Smoke process xác nhận entry point Agent không nạp demo runtime và root vẫn xuất `createDefaultRuntime`.
- `research/archive/reasoning/` giữ source/metadata placeholder. Không có caller/import hoặc dependency nào ngoài build references khi kiểm kê; loại khỏi build/clean/TS project references và lockfile workspace importer. Cognition/world-model/kernel còn consumer nên được giữ.
- TS importer đọc inventory của long-term, lessons và short-term, có giới hạn kích thước/số record và lỗi input ổn định. `memory migrate-json --dry-run` chỉ trả count/warning; import có dữ liệu legacy bị chặn trước khi mở target. `memory init --migrate-json` chạy guard trước khi tạo SQLite. Importer Go cũng chặn write, giữ đường dry-run độc lập.
- Guard là thay đổi có chủ đích của command migration **experimental**: không âm thầm nhập rồi bỏ nhãn/provenance. Các command memory read/write, lesson, context và JSON compatibility vẫn được bảo toàn. Chưa có triển khai migration parity hay căn cứ retire nguồn.
- Vitest dùng `vitest.config.mts` và native config loader cho Node 24; tránh lỗi esbuild đọc thư mục cha trong sandbox. Archive/build output được loại khỏi test discovery.
- Script build Studio giữ stderr/cảnh báo nhưng kiểm tra exit code từng CMake process. Khắc phục Windows PowerShell dừng nhầm khi redirect cảnh báo Qt về DX compiler; đã xác nhận exit code khác 0 vẫn chặn build.
- CI TS và native/Python hiện hữu được giữ; thêm Go lane với Node 24, kiểm tra `node:sqlite`, kết quả test/skip, và chặn storage test skip. Go compiler dùng kênh `stable`, in version được chọn; không phải pin toolchain giống máy dev. Action mới dùng [setup-go v7.0.0 chính thức](https://github.com/actions/setup-go/releases/tag/v7.0.0), pin full commit SHA. Đã đối chiếu [advisory công bố của action](https://github.com/actions/setup-go/security/advisories) khi chuẩn bị workflow; không coi đây là bảo đảm không có lỗ hổng. Hosted CI chưa chạy trong lượt cục bộ này.

## Kết quả kiểm chứng thực tế

| Kiểm tra | Baseline trước cleanup | Sau cleanup |
| --- | --- | --- |
| TS build | Qua | Qua |
| Vitest | 185/185, không test skip | 188/188, không test skip |
| Go | 25 test qua; 9 package pass, 4 package không có test | 26 test qua; không test skip |
| Native build/package MSVC/Qt | Có build hiện hữu; CTest qua | Configure/build/install Release chạy lại thành công |
| CTest | 3/3 executable test qua | 3/3 qua sau build/package |
| Python unittest | 8/8, gồm native integration | 8/8 sau package, không skip |
| Lockfile | Pin sẵn có | Frozen/offline/ignore-scripts/lockfile-only kiểm tra qua, không tải/cài dependency mới tại máy |
| Runtime API smoke | Chưa tách | Agent entry point không nạp demo; root API tương thích |
| CLI migration smoke | Importer chưa có gate lossless | Dry-run qua; write và init-import bị chặn; source nguyên vẹn, không tạo target DB |
| Build failure gate | Cảnh báo có thể bị coi là lỗi khi redirect | Lệnh CMake có exit khác 0 vẫn gây lỗi rõ ràng |
| Tài liệu | Các roadmap/contract có mâu thuẫn | 51 Markdown file được rà link cục bộ, không link thiếu; diff whitespace qua |

Toolchain tại máy: Node **24.13.0**, pnpm **10.13.1**, TypeScript **5.9.3** từ lockfile,
Vitest **4.1.11**, Go **1.26.4 windows/amd64**, Python **3.14.2**,
MSVC **19.44.35222.0** (Build Tools 2022), CMake **3.31.6-msvc6** và Qt Base
**6.12.0** ở SDK cục bộ. Kết quả Go phân biệt package không có test với test
bị skip; Python integration chạy với binary đóng gói được cấu hình rõ.

Sau chỉnh header CLI và giới hạn đọc inventory cuối cùng, chạy lại build TS,
suite CLI **40/40** và suite memory **32/32**; không có test skip. Code JavaScript
đếm test/skip trong Go CI đã chạy với báo cáo thật (26 pass/0 skip) và fixture
storage-skip để xác nhận gate từ chối. Workflow đã chuẩn bị nhưng chưa có kết quả
hosted runner; không báo cáo kiểm tra local như một CI run.

## Agent SDK smoke và giới hạn nghiệm thu

Trong phiên Codex này, dùng scoped Python SDK đọc file topology tổng hợp mới:
site `factory-demo`, external/public, revision 1, ba asset và hai link khai báo
`machine-a → gateway-b → broker-c`. Observed state của cả ba là `unknown`;
không suy ra live connectivity từ link. Agent tạo proposal `pollMs 1000 → 2000`
cho machine-a với expected values/base revision. Hash database trước/sau không đổi.
Proposal được lưu trong build fixture bị ignore, chưa apply.

Đây là smoke qua SDK do Agent thực hiện; MCP process đã được integration test
riêng. Nó chưa chứng minh cấu hình của một sản phẩm MCP client, tương tác operator
trên desktop hoặc nghiệm thu OT. QtTest offscreen đã kiểm tra review/revision/UI,
nhưng không được báo cáo thay cho người dùng thao tác thực tế.

## Bảo toàn và việc còn lại

Source native, desktop, Python và `internal/secrets` có sẵn được đối chiếu hash
với snapshot và giữ nguyên; `.gitignore` có sẵn cũng giữ nguyên. Runtime demo và
reasoning source được giữ khi tách/archive. Không xóa `.lmti/`, `.atlas/`, database,
memory, lesson, audit hoặc topology của người dùng. Snapshot và log nằm trong
`build/cleanup/2026-10-11/`, không chứa bản sao runtime memory và không đưa vào Git.

Các gate chưa đạt:

1. **C4:** mapping scope/privacy/promptPolicy/provenance/ID/time/TTL/review/lifecycle,
   migration idempotency, backup nhất quán và rollback dữ liệu sau cutover. Chỉ mở
   lại write importer sau khi có contract và bằng chứng đầy đủ; giữ store riêng.
2. **C5/P3:** operator tạo/sửa/save/open và review proposal trên Windows; cấu hình
   một product MCP client/Agent; xác nhận document chưa lưu khác dữ liệu đã lưu.
3. **Phân phối:** máy Windows sạch, runtime/license notices; hosted CI thật và
   `lmti publish preflight` trước push/PR/release/đổi remote.
4. **P4 trở đi:** network/gateway/telemetry, encryption, multi-user policy, tải và
   recovery. Cleanup không cung cấp quyền điều khiển thiết bị.

Lesson candidates an toàn để review, chưa ghi vào memory: semantics và ownership
đi trước port/merge; nhãn legacy không chứng minh hết consumer; test xanh có skip
không chứng minh bridge/integration đã chạy; migration ghi phải fail-closed khi
không bảo toàn được policy và provenance.
