# Cổng đọc mapping cho LMPR schema3 — 21/10/2026

Increment32 nối LMPR3 có biên nhận với luồng đọc mapping đã duyệt. Lệnh
`mapping-observation-v2` chỉ nhận schema3 thật; giao thức cũ vẫn nhận schema2.
TS/Python kiểm tra phiên bản khớp cấu hình, giữ nguyên vector hash schema2.
Không tự nâng cấp hoặc fallback.

Phiên process thực tế dùng project tổng hợp, nâng cấp và ghi desired qua CLI
riêng, rồi đăng ký **source ID mới cùng association mới được duyệt**. Lịch sử
cũ được giữ lại và tái dùng source ID cũ bị từ chối. Năm công cụ MCP vẫn chỉ
đọc, kiểm tra revision/mapping mới, từ chối cursor cũ và giữ kín nội dung khi
privacy của Asset, Site hoặc nguồn thay đổi.

DTO Asset công khai không thêm `enabled`/`pollMs`. Các giá trị này được đối
chiếu riêng bằng biên nhận; ledger, token ghi, đường dẫn và backup không được
đưa ra MCP.

| Kiểm chứng thực tế | Kết quả |
| --- | --- |
| Native Release / CTest | Build PASS; focused 5/5; full 38/38 |
| Mapping observation | 12 case, 36.560 kiểm tra, 0 lỗi |
| TS Impact + CLI | 323/323 test, 20 file |
| Python unit / process đóng đủ | 189/189 / 8/8 |
| API + UI build / doctor package | 3 lệnh build PASS / 4/4 |

Full native có 5 nhánh symlink bỏ qua do host; không có suite CTest bị skip.
Các nhóm TS/Python/doctor không có fail, skip hay todo. Số liệu lấy từ receipt
và raw report đã chốt.

Bản ZIP mới chỉ chứa file được manifest liệt kê cùng `manifest.json`, không có
cache hay dữ liệu fixture. ZIP/bằng chứng increment30 và bằng chứng increment31
được giữ nguyên; increment31 không có ZIP riêng. Gói: [LMTI_Build_Cong_Schema3_2026-10-21.zip](C:/example-user/Documents/Codex/2026-10-19/b-n/outputs/LMTI_Build_Cong_Schema3_2026-10-21.zip); SHA256 `0ee305348e0e01fbaa9224b4cf1a5c6fc11be8c9acfd56e0f3f03a6d0d01a4a1`.

Giới hạn: kiểm tra cục bộ trên Windows hiện tại; ghi/replay chỉ trong API riêng
và fixture được kiểm soát. Không có thiết bị thật, thử mất điện, browser,
Windows sạch hay nghiệm thu operator độc lập.

Các gate còn mở:

- Proposal → operator → LMIP handoff/finalization.
- Xoay authority cho nguồn đang được sử dụng.
- Schema3 đầy đủ cho copy, hierarchy và web recovery.

Chưa tuyên bố hoàn thành toàn bộ MVP.

Bằng chứng chi tiết: [LMTI_Kiem_chung_Cong_Schema3_2026-10-21.json](C:/example-user/Documents/Codex/2026-10-19/b-n/outputs/LMTI_Kiem_chung_Cong_Schema3_2026-10-21.json).
