"use strict";
const pages = ["connect", "project", "review"];
function showPage(name) {
  if (!pages.includes(name)) return;
  for (const id of pages) document.getElementById(id).hidden = id !== name;
  for (const button of document.querySelectorAll("[data-page]")) {
    const active = button.dataset.page === name;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  }
  document.getElementById(name + "-title").focus();
}
for (const button of document.querySelectorAll("[data-page],[data-go]"))
  button.addEventListener("click", () => showPage(button.dataset.page || button.dataset.go));
document.getElementById("preview-mapping").addEventListener("click", () => {
  document.getElementById("mapping-note").textContent =
    "Mapping mẫu: tài liệu sampling → Sensor Firmware. Cần nguồn và người phụ trách xác nhận trước khi dùng.";
});
const states = {
  unknown: ["Chưa có dữ liệu", "Chưa biết", "Chưa liên kết", "Không có",
    "Cần nguồn quan sát thật để xác nhận. Không suy từ phiên bản mong muốn.", false],
  fresh: ["Mẫu mới · mô phỏng", "v1.0.0 · mẫu mô phỏng", "Nguồn IoT mẫu", "13/10/2026 09:00 · mô phỏng",
    "Mẫu giả định còn trong TTL 60 giây của nguồn mẫu. Phiên bản không chứng minh health chức năng.", false],
  stale: ["Dữ liệu cũ · mô phỏng", "v1.0.0 · giá trị lịch sử", "Nguồn IoT mẫu", "13/10/2026 08:30 · mô phỏng",
    "Mẫu đã quá TTL. Cần đọc lại nguồn trước khi kết luận phiên bản đang chạy.", true],
  unavailable: ["Mất nguồn · mô phỏng", "Không xác nhận được", "Nguồn IoT không đọc được", "Không có mẫu mới",
    "Nguồn không truy cập được. Chưa thể kết luận thiết bị đã hỏng hoặc offline.", true],
  revoked: ["Đã thu hồi quyền · mô phỏng", "Không được cung cấp", "Quyền đọc đã thu hồi", "Không được cung cấp",
    "Không cung cấp lại observation hoặc cache cũ sau thu hồi quyền. Cần chủ nguồn cấp quyền hợp lệ.", true]
};
document.getElementById("scenario").addEventListener("change", (event) => {
  const state = states[event.target.value];
  if (!state) return;
  for (const [id, value] of [
    ["observation-badge", state[0]], ["observed-value", state[1]],
    ["observed-source", state[2]], ["observed-time", state[3]], ["observation-note", state[4]]
  ]) document.getElementById(id).textContent = value;
  document.getElementById("observation-badge").className = "tag " + (state[5] ? "warning" : "muted");
});
let changedRevision = false;
const reviewNote = document.getElementById("review-note");
document.getElementById("stale-proposal").addEventListener("click", () => {
  changedRevision = !changedRevision;
  document.getElementById("current-revision").textContent = changedRevision ? "2 · mô phỏng" : "1";
  document.getElementById("accept").disabled = changedRevision;
  document.getElementById("review-badge").textContent = changedRevision ? "Nguồn đã đổi · mô phỏng" : "Chờ review · mô phỏng";
  reviewNote.textContent = changedRevision ?
    "Chặn chấp nhận: proposal dựa trên revision 1. Cần đọc lại và review diff theo revision mới." :
    "Các nút chỉ đổi trạng thái giao diện mô phỏng, không lưu project.";
});
document.getElementById("accept").addEventListener("click", () => {
  if (changedRevision) return;
  document.getElementById("review-badge").textContent = "Đã review · mô phỏng";
  reviewNote.textContent = "Chấp nhận mô phỏng. Trong app, owner cần kiểm tra revision và Save; review không triển khai firmware.";
});
document.getElementById("reject").addEventListener("click", () => {
  document.getElementById("review-badge").textContent = "Đã từ chối · mô phỏng";
  reviewNote.textContent = "Từ chối mô phỏng. Không có file hoặc thiết bị thật nào bị thay đổi.";
});

