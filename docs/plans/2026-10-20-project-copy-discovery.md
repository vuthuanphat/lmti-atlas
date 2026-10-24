# STRUCT-01 increment 9 — bounded copy discovery and read-only operator facade

Cập nhật 20/10: đã có tìm lại bản sao khi mất mã thao tác và cổng native
chỉ đọc để kiểm tra dự án, bản sao và lịch sử kích hoạt. Mỗi lượt xét tối đa
1.000 mục; vượt giới hạn hoặc không đọc được phải báo chưa đầy đủ. Bản có intent
hợp lệ vẫn chưa được xem là bản sao đã kiểm chứng. Phân trang từ chối tiếp tục
khi nội dung đã thay đổi; không tự chọn bản mới nhất hoặc chạy lại thao tác ghi.
Build Release đạt; **23/23 native/Qt đạt trong 195.44 giây**.
Sáu suite tập trung đều đạt; suite discovery ghi nhận **2 ca skip có điều kiện**.
Cổng ghi, broker/UI activation-recovery, mapping/import và handoff vẫn cần
hoàn thiện; đây là bằng chứng source build, chưa phải package MVP mới.

## Owner and protocol boundaries

The native discovery owner streams immediate entries under one trusted local
parent. Canonical UUID children receive uninspected, incomplete, invalid or
unavailable states. Fixed intent reads are bounded to 8 KiB plus one overflow
byte, compared twice and parsed by the existing strict copy receipt parser.
Source, target and verified receipt paths are never opened during discovery.
All entries count against 1,000 processed items; one extra observed sentinel
reports BudgetExceeded without being processed or attributed.

Completion means bounded enumeration finished without an observed unavailable
or raced entry. It does not certify every copy, prove a complete history or
attribute an interrupted write. Missing parents are unavailable. Invalid and
empty reservations remain unassociated. Explicit independent copy inspection
is required for a selected candidate; discovery never resumes or selects one.

The existing lmti-mcp-admin binary adds a separate private --project-operations
mode with trusted --library and --copy-parent locations. Five actions are
implemented: inspect, copy-preview, copy-discover, copy-inspect and
activation-history. Existing profile mode remains unchanged. Input is strict
JSON capped at 32 KiB; output is capped at 512 KiB. Generic errors disclose no
raw path or exception text. All selector validation precedes dependent I/O.

Inspect and preview resolve source through the library and recheck its token
and row. They do not probe linked folders or require the copy parent to exist.
Discovery and copy inspection do not require a readable library. History does
not require current project registration or a readable source. Pages contain
at most 50 sorted rows and require the exact full bounded inventory digest for
continuation; a changed page set returns CONFIG_CHANGED.

These are private operator DTOs, not Agent projections or browser path grants.
The next broker must enforce launcher capabilities/project scope and expose
opaque handles. The exact [private protocol](../project-operations.md) is
recorded with the source and checked by native process tests.

## Evidence and remaining work

The focused run covers discovery, process facade, existing copy and activation,
and existing MCP export/identity. The full regression covers 23 native/Qt suites.
Controlled fixtures use real native prepare and activation receipts, strict
request refusals, changed pagination, read-only byte checks and Windows file
sharing/reparse cases. Actual conditional skips are reported above.

The initial focused run passed four of six suites and found two production
issues: a Windows UUID junction was classified before its reparse check, and
QFile's stdin error handling rejected valid piped JSON on this runtime. The
corrections retain strict guards, classify junctions as unavailable/incomplete,
and use bounded binary standard streams. Valid-prefix Ctrl-Z/garbage and NUL
requests are explicitly rejected. The original failed log is retained.

Two reads and directory timestamps detect observed changes, not a locked OS
snapshot, guaranteed I/O deadline or protection from every same-user race.
No browser write control is enabled. Next: explicit typed write facade,
launcher capability and unknown-outcome broker, then reviewed web activation
and recovery. Hierarchy authoring/reviewed mapping, Agent proposal handoff,
integrated packaging and bounded workload verification remain required.
Live source/device, actual clients, second operator and clean Windows remain
post-build acceptance. Private config and fixtures must stay in .gitignore
before any repository push.

Evidence: task output LMTI_Kiem_chung_phuc_hoi_ban_sao_2026-10-20.json, including
source/binary/log hashes and explicit scope limits.

Conditional cases not executed:

- local directory symlink creation unavailable/denied.
- local intent symlink creation unavailable/denied.
