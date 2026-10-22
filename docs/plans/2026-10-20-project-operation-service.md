# STRUCT-01 increment 12 — reviewed project operations

Cập nhật 20/10: đã nối quyền launcher, điều phối các thao tác ghi, API native và giao diện Activity cho sao chép/chuyển đổi, nâng thư viện, chuẩn bị/kích hoạt/hủy và đối chiếu phục hồi. Preview một lần, phiên hết hạn và kết quả chưa rõ được kiểm tra; thao tác ghi đang chạy được giữ đến khi kết thúc, không tự gửi lại.

Build API/UI đạt; **132/132 kiểm thử API, 24/24 UI và 8/8 launcher đạt**, không skip. Gói local `studio-web-operations-20261020` có **116 tệp qua doctor**, đủ bốn binary native từ cùng build Release. Kiểm thử HTTP trên chính gói đạt cả nguồn schema 1 và 2: **14 lượt ghi được xác nhận**, reject không tạo bản sao, nguồn giữ nguyên byte và các broker đóng sạch. Không chạy lại suite C++ vì increment này không đổi nguồn C++.

**Chưa nghiệm thu thao tác trình duyệt:** CUA chặn kênh bootstrap thử nghiệm (`EPERM`/`EACCES`), không có navigation hoặc hành động UI; đã giữ bằng chứng riêng. Gói mới không đồng nghĩa toàn MVP hoàn tất. Hierarchy, mapping/import có review, Agent proposal handoff và workload còn cần build; thiết bị thật, client còn lại, người thứ hai và Windows sạch thuộc nghiệm thu sau build. Kiểm tra `.gitignore` cho cấu hình riêng và secrets trước khi push.

## Implementation

Launcher grants are explicit, exact and immutable. Copy/backup parents are fixed
existing local directories; raw special paths, redirected components and library
hardlinks are refused before admission. The Windows guard is selected only from
the fixed packaged helper. Library maintenance never implicitly grants projects.

One canonical library-parent coordinator admits shared legacy writers or an
exclusive project-operation writer. BUSY precedes preview consumption. Epochs
fence queued reviews; an unknown started outcome blocks later writes independently
of session expiry. Shutdown fences admission and drains owners and jobs. A fresh
quiescence claim is distinct from a fresh read-only reconciliation and deliberate
acknowledgment. Historical unknown outcomes are never rewritten as success.

The service binds bounded opaque reviews, handles, cursors and jobs to session,
project and grant. Nine native read shapes and six native write acknowledgments
are checked. Candidate scans filter both source and target and report incomplete
scans; they do not infer a newest valid copy. Offline abandon reads retained
library/receipt evidence. Native confirmed outcomes survive advisory reload error.

Activity exposes explicit granted scopes including historical IDs, maintenance,
copy/migration, prepare/activate/abandon and recovery in EN/VI. Public DTOs never
grant browser path authority. Pending writers are not aborted, timed out or
automatically replayed. Confirmed success is latched; unknown remains explicit.

## Validation and delivery

Task output LMTI_Kiem_chung_project_operations_2026-10-20.json retains the final
source chain, exact compiled files, test logs and initially failing runs, package
evidence and the unexercised browser status. CUA could not obtain the local
bootstrap session through its in-memory IPC; no navigation or UI action occurred.
Packaged HTTP checks do not substitute for browser interaction. The local package
is not full MVP or clean-Windows acceptance.
No C++ changes were made in this increment; prior native suites were not rerun.

## Remaining planned work

Hierarchy views, reviewed mapping/import, Agent proposal handoff and bounded
workload verification remain build work. Real device/provider, remaining actual
client, independent operator and clean Windows acceptance follow the build.
Controlled replay is first; do not ask again for live endpoints before readiness.

The guard covers participating local brokers and direct mutating children, not
older uncoordinated processes, distributed writers or arbitrary hostile same-user
changes. First enrollment requires draining old runtimes or a fresh controlled
scope. There is no automatic retry or general exactly-once guarantee.

No dependencies were installed and nothing was published or pushed. Check
.gitignore for private configs, fixtures, .env and credentials before future push.
