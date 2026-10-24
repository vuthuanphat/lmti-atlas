# STRUCT-01 increment 15 — private TypeScript hierarchy adapter

Cập nhật 20/10, STRUCT-01 increment 15: lớp nối TypeScript riêng đã kiểm tra
quyền dự án bất biến, JSON/token/diff chặt chẽ và kết quả refused/confirmed/unknown.
Build API đạt; **20/20 kiểm tra tập trung**
trong 2015.693 ms và **152/152
kiểm tra toàn bộ API** trong 49312.1449 ms đều đạt, không lỗi,
cancel, skip hay todo. Ca tiến trình native thật thêm một subsystem có Unicode,
commit rồi đọc lại, giữ nguyên thư viện/UUID, tăng đúng một revision và từ chối
replay cũ. Guard dùng PREVIEW qua pool kiểm tra riêng khi pool chính chỉ có một slot.
Kiểm chứng đủ năm thao tác native thuộc increment 14 trước đó; không chạy lại
27 suite native trong đợt TypeScript này.

Hai lần runner dừng sớm do kiểm tra DirectoryInfo và đường dẫn junction của
compiler pnpm đã được giữ lại; compiler chưa chạy ở cả hai lần, không phải lỗi
sản phẩm. Suite API có fixture HTTP loopback; “không network” trong receipt
được hiểu là không gọi mạng ngoài/provider, không phải bằng chứng không mở socket.

Chưa nối adapter phân cấp vào launcher, service/routes, điều phối ghi/phục hồi
hoặc editor UI; chưa đóng gói mới. Bước tiếp theo giữ token riêng trong review
opaque, điều phối ghi và phục hồi đầy đủ các scope bị ảnh hưởng; không tự gửi lại
ghi chưa rõ kết quả, không dùng trạng thái hiện tại để gán lại kết quả lịch sử.
Gói cũ gồm manifest/116 file đã liệt kê và ZIP giữ nguyên hash.

## Verified scope and review

Four applied files add the private LogicalHierarchyOwner and focused tests, plus
an opt-in strict JSON array bound in security/process. The default remains 2000;
only the hierarchy adapter requests 4000. Per-kind state stays at 2000 rows.
Component and subsystem ancestry is capped at 31 IDs because the native depth
32 includes the leaf. Independent peer review found and corrected that draft
depth boundary before application; source review is separate from runtime proof.

Explicit immutable grants choose project/visibility and fixed native argv.
Native path keys remain private opaque identity data, never browser paths or
I/O destinations. Strict original proposal/full-diff correlation and independent
digests preserve scope, UUID, revision and nullable fields. The 32 KiB proposal,
64 KiB outer input and 512 KiB LF response limits remain. A dishonest native owner
that recomputes tokens cannot be authenticated by this decoder; it is not a
second graph authority.

The focused suite includes synthetic/native-shaped decoding across all five
operations, actual Node process array/framing checks, and one enabled real
native Unicode add/readback with a dedicated PREVIEW verifier. It does not prove
all five operations through TypeScript or implement a service queued-state guard.
Native14 separately established the five-operation native process contract.

Writes retain the existing close-only ProcessPool lifetime. No-start is refused;
unreliable started output is unknown without automatic retry. A confirmed
null-details fallback remains confirmed if a later independent read fails.
There is no hierarchy operation receipt, durable consumed-token ledger or
cross-store transaction. Synthetic ACK tests are not killed-process trials.

## Next integration and remaining work

The planning handoff is workspace work/hierarchy-broker-integration-next.md,
not an implemented capability. It must preserve original target provenance on
rebind, all affected recovery subjects across legacy/hierarchy/project operations,
session/grant/epoch-bound reviews, writer lifetime after HTTP/session end and
explicit fresh recovery acknowledgement. Restart quiescence is not proof of
historical outcome or complete scope coverage. A current read must not repin an
old write or clear an unrelated barrier. HTTP and native output caps differ and
require explicit bounded handling.

Trusted launcher grants, broker/service routes, editor UI, integrated package and
browser acceptance remain. Physical hierarchy, reviewed mapping/import, Agent
handoff, complete workload gates and external operator/device acceptance remain.
No new dependency install, external network/provider/model/device call, push or
publish was performed in this slice. Existing local HTTP tests did run. Runtime
files use this workstation's installed Qt/system dependencies; this is not
clean-Windows acceptance. Check .gitignore for private configuration and secrets
before any future push.
