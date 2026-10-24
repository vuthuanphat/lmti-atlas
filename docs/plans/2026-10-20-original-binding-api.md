# Increment 19 — private API original-binding integration

Cập nhật 20/10, STRUCT-01 increment 19: API đã nối kiểm tra đích ghi gốc
qua lệnh native có điều kiện. Chuỗi đọc catalog → project → catalog cũ được bỏ;
quyền, identity file gốc, guard hàng đợi và so sánh binding sau đọc vẫn được giữ.
JSON riêng giới hạn 64 KiB đầu vào / 128 KiB phản hồi đầy đủ có LF, timeout 30 giây;
không tự quay về cách đọc cũ và không dùng phản hồi lỗi để gán lại kết quả ghi.

Build TypeScript đạt. **90/90 ca tập trung**
đạt trong 8763.7447 ms; **251/251
ca toàn API** đạt trong 60039.286 ms, không lỗi/cancel/skip/todo.
Bốn phase prepare/build/focused/full đều đạt ngay lần initial, không có lần chạy
API thất bại trong mốc này. Năm ca mới dùng native thật kiểm tra Unicode/BigInt,
cặp schema cũ/mới, profile vắng/xuất hiện, thay file cùng tên, ghi profile có guard
và quan sát đầy đủ trước acknowledgment riêng. Barrier unknown trong ca cuối là
fixture cùng tiến trình; không phải thử mất ACK, kill writer hay restart broker.

Increment 18 vẫn là bằng chứng native riêng: 29/29 suite, 13 ca/290 kiểm tra,
một skip có điều kiện trong suite mới. Không chạy lại toàn native trong đợt API.
Suite API có HTTP loopback; không phải bằng chứng không mở socket. Chưa đóng gói
mới, chưa nghiệm thu browser/Windows sạch; không tuyên bố atomic nhiều store hay
atomic giữa lần đọc kiểm tra với lệnh ghi sau đó. Toàn MVP còn các gate mở.

## Scope and evidence

Four applied files contain one production change (`owners.ts`), two new test files
and updates to existing legacy recovery tests. Fifteen new synthetic/controlled
process cases cover strict envelopes, native error codes, immutable returned pins,
exact bytes/LF/cap, queued revocation, independent verification capacity and known
save acknowledgments. Five new cases use the current native binaries, including
library/project schema pairs (1,1) and (3,2), with real Node BigInt provenance.
Existing legacy real-native cases and the broader API regression also remain enabled.

The final snapshot pins 47 API/compiler/test inputs, 38 dist files and ten support
environment bindings. A six-file current native/Qt runtime plus five installed
system dependencies is verified against the original files. It is a controlled test
runtime on this workstation, not a distributable package or clean-machine result.
Test producers use the configured trusted Qt PATH; production ProcessPool child
environments remain sanitized. Historical package manifests/listed 116 and 105 files
and the 117-member delivery ZIP retain their hashes; unlisted files are not inventoried.

The existing original-target subject, marker, coordinator, routes and public DTOs
are unchanged. Capture conditionally confirms the saved review; verification and
recovery use the original immutable target without repinning. Native refusal codes
remain bounded; malformed response/transport is unavailable. A known successful
write acknowledgment is not demoted by a later read. Reads do not clear recovery:
complete-union review and a separate deliberate acknowledgment remain required.

## Remaining limits

Native protection is Windows-specific and concerns ordinary namespace replacement.
It does not prevent hostile in-place writes, privileged modifications or establish
cross-store atomicity. The conditional read and later writer are separate operations.
Python client-root races, missing-original-profile creation evidence, marker-v1
migration and unresolved cross-schema/UUID subjects remain open. Existing TS path
byte limits can conservatively refuse longer native-valid Unicode paths.

No new hierarchy route/editor, physical hierarchy authoring, mapping/import workflow,
package/browser acceptance, live provider/device test, independent operator trial or
full MVP completion is claimed. Native18 failure/repair history is referenced unchanged;
it is not relabeled as an API failure. Tests and recorder are local; no installs,
publishing or external provider/model/device actions are part of this increment.
