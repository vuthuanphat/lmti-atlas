# Increment 21 — reviewed logical hierarchy web UI

Cập nhật 20/10, STRUCT-01 increment 21: đã thêm trình sửa phân cấp logic
EN/VI trong trang Structure, với năm thao tác có kiểu, lô tối đa 32 thay đổi,
xem đủ sai khác và phạm vi bị ảnh hưởng trước khi từ chối hoặc xác nhận một lần.
Quyền phân cấp được kiểm tra riêng; không suy ra từ quyền Agent hay copy dự án.
Activity trình bày đủ nhóm phạm vi phục hồi chung, không tạo trạng thái profile giả
cho phân cấp và không đổi kết quả ghi lịch sử chưa xác định thành đã thành công.

TypeScript/Vite và UI 55/55 đạt; API tập trung
26/26, toàn bộ 321/321
đạt, không fail/cancel/skip/todo ở các lượt cuối. Lượt API tập trung đầu có
25/26 đạt: fixture trả cùng đối tượng snapshot nên không mô phỏng được thay đổi
generation. Sửa kiểm thử để trả snapshot độc lập; không sửa sản phẩm trong lượt r2.
Kết quả UI ban đầu vẫn áp dụng vì toàn bộ đầu vào và bundle UI được giữ nguyên.

Thử mở browser qua cơ chế được hỗ trợ chỉ trả trạng thái queued; CUA không thấy tab. Host giả lập đã khởi động, đọc trạng thái và đóng/drain thành công; projection dự án, library và profile không đổi. Chưa có navigation, thao tác UI hay ảnh chụp được kiểm chứng. Nghiệm thu tương tác trình duyệt vẫn còn mở.

Không có thay đổi native hay gói phát hành mới. Kết quả native 30/30 của increment 20
là bằng chứng trước đó, không phải chạy lại ở increment này. Phân cấp vật lý,
mapping/import, nghiệm thu provider/thiết bị thật, người vận hành thứ hai và
Windows sạch còn mở; chưa nghiệm thu toàn bộ MVP.

## Implemented scope

The existing Structure page exposes five typed operations: add, rename, reparent,
component membership and empty-subsystem retirement. Original expected rows stay
bound to one read; final-draft references may use newly added parents. The full
authorized state/diff is validated, including unchanged affected descendants and
inherited Internal classification. This is not physical hierarchy authoring.

Complete public success envelopes retain the 256 KiB gate, distinct from native
512 KiB frames. Oversized/unavailable state is not an empty or partial editable
tree. Dedicated hierarchy bounds permit valid collections above 256 rows.
Browser contracts contain public IDs and opaque reviews/jobs, not native pins,
physical paths or authority derived from display data.

Confirmation consumes the local review synchronously. Reads use selection and
generation fences; confirmed results survive failed refresh and absent details.
Pending job polling is finite and read-only. Unknown unlock requires a fresh,
submission-bound post-unknown write-status observation, never the pre-dispatch
idle result. App combines keyed child locks so one sibling cannot unlock another.
Ending local waiting does not acknowledge the common barrier or retry the write.

Activity preserves legacy-only recovery and requires complete coverage for the
hierarchy-enabled mixed reply. Public kind/action/project groups and counts come
from the authorized retained snapshot; repeated project observations are retained.
Coverage summarizes coordination records, not completed writes or unique physical
targets. All-family authorization/inspection and explicit acknowledgment remain
the existing common mechanism. No marker, coordinator or native protocol changed.

## Evidence and limits

UI tests exercise pure draft/decoder/lifecycle logic, lock models and React server
rendering in EN/VI. They do not prove real focus, keyboard interaction, component
effects in a browser, screen-reader usability or operating-system restart.
API collector tests include synthetic snapshots. Real HTTP/native regression
tests exercise reviewed native commits and persisted readback; their corrupted
received-ACK case occurs after child close and uses same-process broker recreation.
This is separate from browser and crash/restart acceptance.

Static review repaired stale pre-dispatch unlock, late previous-project reads,
and incomplete final-ancestor classification checking before the first build.
Those are review findings, not claimed failing runtime tests. The initial API
fixture failure and all subsequent successful receipts remain retained.

One bounded supported browser-opening attempt returned queued; CUA listed no tab. The synthetic host started and closed/drained successfully, and final native projection, library and profile comparisons were unchanged. No navigation, UI interaction, browser write or screenshot was verified. Actual browser acceptance remains pending.

No new package was produced. Current UI/API bundles and a workstation-only native
runtime are pinned. Historical packages/ZIP remain referenced to their audited
increment-20 scope; this recorder rechecks manifests and the ZIP byte hash only.
There is no cross-store atomicity or hostile in-place filesystem-edit guarantee.
Physical hierarchy/mapping/import, packaging and external acceptance remain open.
