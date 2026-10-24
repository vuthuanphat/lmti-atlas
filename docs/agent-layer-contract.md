# Agent layer contract v1 — thiết kế và native M2

Ngày: 2026-10-13. Trạng thái: **native read slice đã triển khai local alpha;
phần TS/IoT/proposal xuyên owner còn dự kiến**.
Theo [ADR](adr/2026-10-13-agent-project-layer.md) và
[gói M1](plans/2026-10-13-agent-layer-m1.md).
Các tool legacy giữ schema cũ. Endpoint additive lmti_agent.mcp đã trả envelope
mới cho context/entity/related và typed unsupported observations. Xem
[hướng dẫn](agent-layer.md) và [bằng chứng](plans/2026-10-13-agent-layer-m2-execution.md).
Contract độc lập model/client/storage, tái sử dụng validation/privacy của owner.

## Phạm vi đã triển khai

Tool hiện có: lmti_context(limit,cursor), lmti_entity(kind,entityId),
lmti_related(kind,entityId,depth,limit,direction,relationTypes,cursor),
lmti_observations(assetId). Kinds component/asset/release; related dùng
declared_dependency, has_release, deployed_to_desired và declared_connection.
Binding được biểu diễn release → asset và component → release; không causal claim.
Payload trả cả structuredContent và JSON text. Cursor có HMAC theo Client/session,
query/fingerprint/TTL; lookup không bị cửa sổ legacy 200 chặn.

Logical request envelope và intent/proposal/review_result bên dưới còn là thiết kế;
runtime dùng SDK methods hoặc MCP tool arguments, không có generic request proxy.
Chưa nối TS memory/compiler, code/docs hoặc IoT thật. Phân trang chỉ bounds output;
owner vẫn đọc full bounded snapshot, recheck trước return.

## 1. Request và capabilities

Request `lmti.agent.request.v1` gồm operation và arguments typed riêng.
Project/site/model target/grant/binary/endpoint đến từ cấu hình launcher tin cậy.
Agent chỉ được thu hẹp scope; không nhận SQL, shell, URL fetch hoặc payload tùy ý.

| Operation dự kiến | Arguments | Giới hạn / ngữ nghĩa |
| --- | --- | --- |
| project.context | intent?, limit? | Intent là dữ liệu, không lệnh; limit 1–200 cho owner hiện tại |
| project.entity | kind, entityId | Qua mapping có source namespace được phép; unavailable dùng lỗi chung |
| project.related | kind, entityId, relationKinds?, depth?, limit?, cursor? | Directed typed relation, scope có giới hạn |
| project.observations | deviceId, metrics?, window?, limit?, cursor? | Source adapter đã đăng ký; UTC, history có giới hạn |
| project.propose | type, expectedRevision, targetId, desired | Allowlist owner: work review/blocked hoặc desired config đã hỗ trợ |
| project.review_result | proposalId | Outcome/evidence/revision, historical/stale rõ |

Đây là operation logic, không phải danh sách MCP tools đã phát hành.
Discovery phải nêu supported/unsupported. Không proxy tool nguồn IoT có khả năng
ghi chỉ vì có readOnlyHint. Unknown field/type coercion, duplicate JSON keys,
nonfinite numbers, byte/time budget vượt ngưỡng bị từ chối trước xử lý.

## 2. Response envelope

`schema: lmti.agent.response.v1`.

| Trường bắt buộc | Ý nghĩa |
| --- | --- |
| operation / status | Operation đã xử lý; status ok, partial hoặc error |
| scope | Effective project/site/model target/classification/policyRevision từ authority; null nếu chưa đủ quyền tiết lộ |
| sources | Nguồn được phép: opaque sourceId/kind, typed version, checkedAt, authority và freshness |
| evidence | Opaque evidenceId, sourceId, sourceRevision, typed source-relative reference, basis |
| completeness | complete/partial, coverage của query, reason codes, nextCursor nếu hỗ trợ |
| data | Typed result theo operation; null trên error |
| unknowns / conflicts | Gaps hoặc assertions mâu thuẫn trong scope được phép; không lộ phía bị denied |
| error | null khi thành công; typed code + fixed safe message + retryable khi lỗi |

Không trả raw principal credential, local path, private endpoint, secret hoặc
hidden counts/IDs. Policy revision không phải token cấp quyền. Complete chỉ
nghĩa hoàn tất query được phép/budget đó, không chứng minh toàn hệ thật đã được
mô hình hóa. Mỗi source có version riêng; không bịa global atomic revision.

## 3. Typed result và provenance

| Kiểu | Fields tối thiểu |
| --- | --- |
| Entity | identity {sourceId, kind, sourceEntityId}, label/typed attributes được phép, classification/semantics/evidenceIds |
| Relation | Identity riêng, type/direction, from/to identities, source/evidence, semantics |
| Observation | Source/device/metric, typed value/unit, sampleAt/receivedAt, quality/freshness/TTL, sequence nếu có |
| Proposal | Allowed type, target, expected owner revision/old value, typed desired, rationale/evidence, review state |
| Review outcome | Owner outcome, proposal/report identity, evidence/version; historical nếu source đã đổi |

Identity gồm project + source namespace + source-native ID + kind, không dựa tên/IP.
Mapping giữ hai endpoint và reviewer/evidence; authority theo từng field/assertion.
Relation ban đầu: contains, depends_on, communicates_with, deployed_to_desired,
observed_on, documented_by; mỗi adapter chỉ claim loại có evidence.

Semantics: declared, desired, observed, inferred, proposed, verified.
Chỉ observation adapter có nguồn xác thực mới tạo observed.
Inferred không tự promote thành fact; verified gắn evidence/revision/phạm vi.
Unknown/invalid observation không có value giả mặc định.
Proposal reviewed không đồng nghĩa save/deploy; Agent không dispatch thiết bị.

Native impact hiện là dependency neighborhood duyệt cả hai chiều. Adapter giữ
nhãn đó, không đổi thành causal/directed runtime impact nếu chưa có bằng chứng.
Native knowledge reference-only không tự cho phép fetch raw memory/tài liệu.

## 4. Freshness, consistency và failure

| Trạng thái | Nghĩa |
| --- | --- |
| checked | Owner revision/content đối soát khi đọc, basis rõ; không suy freshness cảm biến |
| fresh | Sample xác thực còn trong TTL/quality; phải có sample time |
| stale | Sample hết hạn hoặc source khác bản đã kiểm chứng |
| unknown | Không có nguồn/phép kiểm tra đủ, ví dụ desired binding hiện tại |
| unavailable | Không đọc được nguồn; không chứng minh thiết bị hỏng |
| revoked | Không còn quyền; không trả cache/history của nguồn đó |

receivedAt không thay sampleAt. Clock uncertainty/reset/reorder/gaps cần semantics
nguồn rõ; không dùng heartbeat để suy health chức năng. Content hash chứng minh
identity/change, không chứng minh sự thật.

Error codes: INVALID_ARGUMENT, UNAVAILABLE, NOT_SUPPORTED, SCOPE_REVOKED,
SOURCE_CHANGED, STALE_CURSOR, BUDGET_EXCEEDED, TIMEOUT, INVALID_SOURCE_RESPONSE.
UNAVAILABLE dùng chung missing/unauthorized; SCOPE_REVOKED chỉ nói về grant/source
connection người gọi vốn được phép biết. Không in native stderr/SQL/path/secret.

Partial là dữ liệu đã qua policy nhưng coverage thiếu. Owner chưa có pagination:
nextCursor=null, reason=OWNER_WINDOW_LIMIT; không lặp trang đầu để giả đọc đủ.

- Policy trước load/rank và trước return; không fetch secret rồi hy vọng redaction.
- Multi-owner reads có version vector, checkedAt riêng; source đổi thì bounded
  retry hoặc SOURCE_CHANGED, không claim atomic snapshot.
- Cursor/cache bind query/filter/scope/principal/policy/source versions/expiry/budget;
  do server sở hữu hoặc ký, không coi cursor client là grant.
- Source/policy đổi làm cursor invalid; cache/report phải reauthorize hoặc fail.
  Filter cả endpoints/path và không trả hidden totals.
- Write proposal check expected revision ở owner transaction; draft UI không là
  saved state của Agent. Nội dung nguồn không thay grant/allowlist hoặc thành lệnh.
- LMTI không thu hồi được nội dung đã gửi cho model; isolation ngoài boundary
  phải được host/source/service thực thi.

## 5. Ví dụ và mapping legacy

[Ví dụ JSON](design/2026-10-13-agent-layer/contracts.json) là fixture đích.
Context có desired relation và observed-version unknown. Observation chưa có
source trả NOT_SUPPORTED; partial không có cursor giả.

| Native legacy | Envelope đích |
| --- | --- |
| projectId/site + trusted target | Scope từ Grant, không tin payload tự khai báo quyền |
| revision | Native source version và evidence sourceRevision |
| components/assets/... | Typed entities giữ source identity, không private locator |
| bindings desiredReleaseId | deployed_to_desired; không chứng minh firmware hiện chạy |
| affectedComponentIds + analysis | Declared undirected neighborhood |
| truncated | Partial + OWNER_WINDOW_LIMIT, nextCursor null |
| knowledge reference-only | Ref metadata, không auto-fetch |
| Operator verification | Evidence/outcome theo version, không suy live version |

Native M2 đã chốt inputSchemas, typed transient DTOs và strict snapshot/policy
validation trước expose tool; không thêm dependency/schema-validator library.
Response được factory tạo từ DTO đã validate. Các operation/source tương lai phải
có schema/parser/privacy/semantics riêng trước expose; TS/IoT còn cần pilot.

## 6. Client

[Smoke](../scripts/m1-agent-smoke.py) dùng native API hiện có, digest và Codex
client plumbing. Config snippet có command/args/cwd/PYTHONPATH và allowlist hai
tool đọc, không sửa global config. Khóa cấu hình theo
[OpenAI Docs MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).
Probe dùng [App Server](https://learn.chatgpt.com/docs/app-server) và schema
của bản đang cài. Không chạy model turn, không đo model accuracy/live IoT.

