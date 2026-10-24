import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { ProposalReview } from './ProposalReview';
import { Icon } from './Icon';
import { watchPresentationClock } from './presentation-clock';
import './StructureView.css';

export type StructureRequest = <T>(path: string, method?: string, body?: unknown, signal?: AbortSignal) => Promise<T>;
export type StructureViewProps = { project: string; request: StructureRequest; language: 'en' | 'vi'; mode?: 'architecture' | 'knowledge'; visible?: boolean; onLockChange?: (locked: boolean) => void };
type Identity = { sourceId: string; kind: string; sourceEntityId: string };
type Entity = { identity: Identity; label: string; classification: string; semantics: string; attributes: Record<string, unknown>; evidenceIds: string[] };
type Relation = { identity: Identity; type: string; from: Identity; to: Identity; semantics: string; evidenceIds: string[] };
type Source = { sourceId: string; kind: string; version: { type: string; value: string | number; fingerprint?: string } | null; checkedAt: string; authority: string; freshness: { state: string; sampleAt?: string | null; ttlSeconds?: number | null } };
type Evidence = { evidenceId: string; sourceId: string; sourceRevision: string | number; reference: { kind: string; sourceEntityId: string }; basis: string };
type ContextItem = { id: string; kind: string; title: string; summary: string; semantics: string; classification: 'public' | 'internal'; disclosure: 'owner_safe_summary' | 'public_compiled_summary'; evidenceId: string; referenceKind: string; referenceId: string };
type Observation = { identity: Identity; assetId: string; deviceId: string; metric: string; unit: string; value: string | number | boolean | null; sampleAt: string; receivedAt: string; checkedAt: string; ttlSeconds: number; quality: string; freshness: { state: string; ageSeconds: number; reasons: string[] }; evidenceIds: string[] };
type Limitation = { code: string; field?: string; assetId?: string; metric?: string; sourceId?: string; entity?: Identity };
type Envelope = { schema: string; operation: string; status: 'ok' | 'partial' | 'error'; scope: { projectId: string; site: string; modelTarget: string } | null; sources: Source[]; evidence: Evidence[]; completeness: { state: string; reasons: string[]; nextCursor: string | null }; data: { entities: Entity[]; relations: Relation[]; observations: Observation[]; contextItems?: ContextItem[] } | null; unknowns: Limitation[]; conflicts: Limitation[]; error: { code: string } | null };
type Operation = 'context' | 'entity' | 'related' | 'task_context' | 'observations';
type ReadState = { scope: string; loading: boolean; error: string; result: Envelope | null; receivedAt: number };
type Text = (en: string, vi: string) => string;
const entityKey = (identity: Identity) => `${identity.sourceId}:${identity.kind}:${identity.sourceEntityId}`;
const keyPattern = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;
const kinds = ['component', 'asset', 'release', 'repository', 'knowledge'];
const states = ['fresh', 'stale', 'unknown', 'unavailable', 'invalid', 'revoked', 'checked'];
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, limit = 256): value is string => typeof value === 'string' && value.length <= limit;
const strings = (value: unknown, limit = 2000): value is string[] => Array.isArray(value) && value.length <= limit && value.every(item => text(item, 1024));
const identity = (value: unknown): value is Identity => record(value) && [value.sourceId, value.kind, value.sourceEntityId].every(item => text(item, 128) && keyPattern.test(item));
const timestamp = (value: unknown): value is string => text(value, 64) && Number.isFinite(Date.parse(value));
const version = (value: unknown) => typeof value === 'number' ? Number.isSafeInteger(value) && value >= 0 : text(value, 128) && /^[A-Za-z0-9_.-]+$/.test(value);

class ReadError extends Error { constructor(readonly code: string) { super('Read refused'); } }

// Rendering checks complement the owner boundary. Never render arbitrary error
// messages, object payloads, filesystem locators, HTML, or server-provided URLs.
export function checkedStructureResponse(value: unknown, operation: Operation): Envelope {
  if (!record(value) || value.schema !== 'lmti.agent.response.v1' || value.operation !== `project.${operation}` ||
      !['ok', 'partial', 'error'].includes(String(value.status))) throw new ReadError('INVALID_SOURCE_RESPONSE');
  if (value.status === 'error') {
    const code = record(value.error) && text(value.error.code, 64) && /^[A-Z_]+$/.test(value.error.code) ? value.error.code : 'INVALID_SOURCE_RESPONSE';
    throw new ReadError(code);
  }
  const data = value.data, completion = value.completeness;
  if (!record(value.scope) || !text(value.scope.projectId, 128) || !text(value.scope.site, 128) || !['external', 'local'].includes(String(value.scope.modelTarget)) ||
      !record(data) || !record(completion) || !strings(completion.reasons) ||
      (completion.nextCursor !== null && !text(completion.nextCursor, 1024)) ||
      !Array.isArray(data.entities) || data.entities.length > 2000 ||
      !data.entities.every(row => record(row) && identity(row.identity) && text(row.label, 512) && record(row.attributes) && strings(row.evidenceIds)) ||
      !Array.isArray(data.relations) || data.relations.length > 2000 ||
      !data.relations.every(row => record(row) && identity(row.identity) && identity(row.from) && identity(row.to) && text(row.type, 128) && strings(row.evidenceIds)) ||
      !Array.isArray(value.sources) || value.sources.length > 16 ||
      !value.sources.every(row => record(row) && text(row.sourceId, 128) && keyPattern.test(row.sourceId) && text(row.kind, 128) && timestamp(row.checkedAt) && record(row.freshness) && states.includes(String(row.freshness.state)) && (row.version === null || record(row.version) && version(row.version.value))) ||
      !Array.isArray(value.evidence) || value.evidence.length > 5000 ||
      !value.evidence.every(row => record(row) && text(row.evidenceId, 128) && text(row.sourceId, 128) && version(row.sourceRevision) && record(row.reference) && text(row.reference.kind, 128) && text(row.reference.sourceEntityId, 128) && text(row.basis, 128)) ||
      !Array.isArray(data.observations) || data.observations.length > 128 ||
      !data.observations.every(row => record(row) && identity(row.identity) && text(row.assetId, 128) && text(row.deviceId, 128) && text(row.metric, 128) && text(row.unit, 24) &&
        (row.value === null || typeof row.value === 'boolean' || typeof row.value === 'number' && Number.isFinite(row.value) || text(row.value, 64)) &&
        timestamp(row.sampleAt) && timestamp(row.receivedAt) && timestamp(row.checkedAt) && typeof row.ttlSeconds === 'number' && row.ttlSeconds > 0 && row.ttlSeconds <= 86400 &&
        record(row.freshness) && states.includes(String(row.freshness.state)) && typeof row.freshness.ageSeconds === 'number' && Number.isFinite(row.freshness.ageSeconds) && row.freshness.ageSeconds >= 0 && strings(row.freshness.reasons) && strings(row.evidenceIds)) ||
      (data.contextItems !== undefined && (!Array.isArray(data.contextItems) || data.contextItems.length > 200 || !data.contextItems.every(row => record(row) && text(row.id, 128) && text(row.kind, 128) && text(row.title, 512) && text(row.summary, 8000) && text(row.semantics, 128) && ['public', 'internal'].includes(String(row.classification)) && ['owner_safe_summary', 'public_compiled_summary'].includes(String(row.disclosure)) && text(row.evidenceId, 128) && text(row.referenceId, 128)))) ||
      ![value.unknowns, value.conflicts].every(rows => Array.isArray(rows) && rows.length <= 5000 && rows.every(row => record(row) && text(row.code, 128) && /^[A-Z_]+$/.test(row.code)))) throw new ReadError('INVALID_SOURCE_RESPONSE');
  return value as unknown as Envelope;
}

export function visibleObservationState(row: Pick<Observation, 'freshness' | 'ttlSeconds'>, elapsedSeconds: number): string {
  const state = row.freshness.state;
  if ((state === 'fresh' || state === 'unknown') && row.freshness.ageSeconds + Math.max(0, elapsedSeconds) > row.ttlSeconds) return 'stale';
  return state;
}

function errorCode(error: unknown): string {
  return record(error) && text(error.code, 64) ? error.code : 'NETWORK';
}
function useRead(request: StructureRequest, endpoint: string, scope: string) {
  const sequence = useRef(0), controller = useRef<AbortController | null>(null), currentScope = useRef(scope);
  currentScope.current = scope;
  const [state, setState] = useState<ReadState>({ scope, loading: false, error: '', result: null, receivedAt: 0 });
  const cancel = useCallback(() => { sequence.current++; controller.current?.abort(); }, []);
  useEffect(() => { cancel(); setState({ scope, loading: false, error: '', result: null, receivedAt: 0 }); return cancel; }, [scope, cancel]);
  const run = useCallback(async (operation: Operation, args: Record<string, unknown>) => {
    cancel(); const serial = sequence.current, abort = new AbortController(); controller.current = abort;
    setState({ scope, loading: true, error: '', result: null, receivedAt: 0 });
    try {
      const raw = await request<unknown>(endpoint, 'POST', { operation, arguments: args }, abort.signal);
      const result = checkedStructureResponse(raw, operation);
      if (serial !== sequence.current || currentScope.current !== scope || abort.signal.aborted) return null;
      setState({ scope, loading: false, error: '', result, receivedAt: performance.now() });
      return result;
    } catch (error) {
      if (serial === sequence.current && currentScope.current === scope && !abort.signal.aborted)
        setState({ scope, loading: false, error: errorCode(error), result: null, receivedAt: 0 });
      return null;
    }
  }, [request, endpoint, scope, cancel]);
  return { ...state.scope === scope ? state : { scope, loading: false, error: '', result: null, receivedAt: 0 }, run };
}

function stateName(state: string, t: Text) {
  return ({ fresh: t('Fresh', 'Còn mới'), stale: t('Stale', 'Đã cũ'), unknown: t('Unknown', 'Chưa rõ'), unavailable: t('Unavailable', 'Không khả dụng'), invalid: t('Invalid', 'Không hợp lệ'), revoked: t('Access revoked', 'Đã thu hồi quyền'), checked: t('Checked', 'Đã kiểm tra') } as Record<string, string>)[state] ?? t('Unknown', 'Chưa rõ');
}
function kindName(kind: string, t: Text) {
  return ({ component: t('Component', 'Thành phần'), asset: t('Device / asset', 'Thiết bị / tài sản'), release: t('Release', 'Bản phát hành'), repository: t('Repository', 'Kho mã'), knowledge: t('Document reference', 'Tham chiếu tài liệu'), code: t('Compiled code', 'Mã đã biên dịch'), document: t('Compiled document', 'Tài liệu đã biên dịch'), memory: t('Project memory', 'Bộ nhớ dự án') } as Record<string, string>)[kind] ?? kind;
}
function reasonName(code: string, t: Text) {
  const labels: Record<string, string> = {
    NO_OBSERVATION_IN_SCOPE: t('No observations in this scope.', 'Chưa có quan sát trong phạm vi này.'),
    OBSERVATION_SOURCE_NOT_CONFIGURED: t('Observation source is not configured.', 'Chưa cấu hình nguồn quan sát.'),
    OBSERVATION_SOURCE_REVOKED: t('Observation access has been revoked.', 'Quyền đọc quan sát đã bị thu hồi.'),
    OBSERVATION_SOURCE_UNAVAILABLE: t('The observation source could not be read.', 'Không đọc được nguồn quan sát.'),
    OBSERVATION_SOURCE_INVALID: t('The observation source failed validation.', 'Nguồn quan sát không vượt qua kiểm tra dữ liệu.'),
    REFERENCE_CONTENT_NOT_LOADED: t('Reference content has not been loaded.', 'Nội dung tham chiếu chưa được tải.'),
    CODE_MAPPING_NOT_INCLUDED: t('Code mapping has not been included.', 'Chưa có ánh xạ mã nguồn.'),
    KNOWLEDGE_SOURCE_NOT_CONFIGURED: t('Code, document and memory sources are not configured.', 'Chưa cấu hình nguồn mã, tài liệu và bộ nhớ.'),
    TTL_EXPIRED: t('The freshness window has expired.', 'Đã hết thời gian hiệu lực.'),
    CLOCK_SKEW: t('Source timestamps are inconsistent.', 'Thời gian của nguồn không nhất quán.'),
    BAD_QUALITY: t('The source marked this sample as bad quality.', 'Nguồn đánh dấu mẫu không đạt chất lượng.'),
    UNCERTAIN_QUALITY: t('The source reported uncertain quality.', 'Nguồn báo chất lượng chưa chắc chắn.'),
    RECONNECT_GAP: t('A reconnect interrupted the sample sequence.', 'Kết nối lại làm gián đoạn chuỗi mẫu.'),
    SEQUENCE_GAP: t('Samples are missing from the sequence.', 'Chuỗi quan sát thiếu mẫu.'),
    OUT_OF_ORDER_SAMPLE: t('An older out-of-order sample was ignored.', 'Đã bỏ qua mẫu cũ đến sai thứ tự.'),
    DUPLICATE_SAMPLE: t('Repeated copies of a sample were removed.', 'Đã loại bỏ các bản sao của mẫu.'),
    CONFLICTING_SAMPLE: t('Conflicting samples were withheld.', 'Đã ẩn giá trị của các mẫu mâu thuẫn.'),
    CONFLICTING_SEQUENCE: t('Samples conflict at the same sequence number.', 'Các mẫu mâu thuẫn tại cùng số thứ tự.'),
    RESULT_PAGE_LIMIT: t('More results are on the next page.', 'Còn kết quả ở trang tiếp theo.'),
    NEIGHBORHOOD_BUDGET: t('The neighborhood exceeded the read budget.', 'Phạm vi liên quan vượt giới hạn đọc.'),
    TRAVERSAL_BUDGET: t('The relationship walk reached its limit.', 'Đã đạt giới hạn duyệt quan hệ.'),
    OBSERVATION_STALE: t('A measurement is stale.', 'Có giá trị quan sát đã cũ.'),
    OBSERVATION_UNKNOWN: t('A measurement cannot be confirmed.', 'Có giá trị quan sát chưa thể xác nhận.'),
    OBSERVATION_INVALID: t('A measurement is invalid.', 'Có giá trị quan sát không hợp lệ.'),
    OBSERVATION_CONFLICT: t('Observation evidence conflicts.', 'Bằng chứng quan sát mâu thuẫn.'),
    MAPPED_CONTENT_UNAVAILABLE: t('A mapped source is unavailable or no longer matches its reference.', 'Nguồn đã ánh xạ không khả dụng hoặc không còn khớp tham chiếu.'),
    COMPILED_CONTENT_STALE: t('Compiled context no longer matches the source. Recompile through its owner.', 'Ngữ cảnh đã biên dịch không còn khớp nguồn. Biên dịch lại qua owner.'),
    MEMORY_SOURCE_NOT_CONNECTED: t('Project memory is not connected.', 'Chưa kết nối bộ nhớ dự án.'),
    OWNER_WINDOW_LIMIT: t('The source owner returned a bounded window.', 'Owner nguồn chỉ trả về một phần kết quả trong giới hạn.'),
    RESULT_LIMIT: t('The context result reached its size limit.', 'Kết quả ngữ cảnh đã đạt giới hạn dung lượng.'),
    OBSERVATION_LIMITATIONS: t('Observation quality or freshness limits this result.', 'Chất lượng hoặc độ mới của quan sát giới hạn kết quả này.'),
  };
  return labels[code] ?? t('This source has additional coverage limitations.', 'Nguồn còn có giới hạn về phạm vi bao phủ.');
}
function errorName(code: string, t: Text) {
  if (code === 'STALE_CURSOR' || code === 'SOURCE_CHANGED') return t('The source changed. Refresh this view to read its current version.', 'Nguồn đã thay đổi. Làm mới để đọc phiên bản hiện tại.');
  if (code === 'NOT_SUPPORTED') return t('This source is not configured for the selected project.', 'Chưa cấu hình nguồn này cho dự án đã chọn.');
  if (code === 'INVALID_ARGUMENT' || code === 'INVALID_INPUT') return t('Check the request and try again.', 'Kiểm tra nội dung yêu cầu rồi thử lại.');
  if (code === 'INVALID_SOURCE_RESPONSE') return t('The source response failed validation. No data is shown.', 'Phản hồi nguồn không hợp lệ. Không hiển thị dữ liệu.');
  if (code === 'UNAVAILABLE') return t('This information is unavailable in the current scope.', 'Thông tin không khả dụng trong phạm vi hiện tại.');
  return t('The local owner could not complete this read. Retry when it is available.', 'Nguồn cục bộ chưa hoàn thành lần đọc. Thử lại khi nguồn sẵn sàng.');
}
function Badge({ state, t }: { state: string; t: Text }) {
  const tone = ['invalid', 'revoked'].includes(state) ? 'bad' : ['stale', 'unknown', 'unavailable'].includes(state) ? 'warn' : state === 'checked' ? 'neutral' : '';
  return <span className={`pill ${tone}`}>{stateName(state, t)}</span>;
}
function Status({ state, t }: { state: ReadState; t: Text }) {
  if (state.loading) return <p className="structure-status" role="status">{t('Reading the current owner…', 'Đang đọc nguồn hiện tại…')}</p>;
  if (state.error) return <p className="structure-error" role="alert">{errorName(state.error, t)}</p>;
  if (state.result?.status === 'partial') return <p className="structure-warning" role="status">{t('Partial result. Review source coverage and unknowns below.', 'Kết quả một phần. Xem phạm vi nguồn và các điểm chưa rõ bên dưới.')}</p>;
  return null;
}

/** A task is sent as one explicit line; all remaining control characters are rejected. */
export function prepareTaskText(value: string) {
  const normalized = value.replace(/\r\n?|\n/g, ' ');
  const task = normalized.trim();
  const bytes = new TextEncoder().encode(task).length;
  return { task, bytes, valid: bytes > 0 && bytes <= 1000 && !/[\x00-\x1f\x7f]/.test(normalized) };
}

function EvidenceList({ result, ids, t, onInspect }: { result: Envelope; ids?: string[]; t: Text; onInspect?: (id: string) => void }) {
  const evidence = ids ? result.evidence.filter(row => ids.includes(row.evidenceId)) : result.evidence;
  if (!evidence.length) return null;
  return <details className="structure-evidence"><summary>{t('Source evidence', 'Bằng chứng nguồn')} ({evidence.length})</summary>
    <ul>{evidence.map(row => <li key={row.evidenceId}><strong>{row.reference.sourceEntityId}</strong><span>{row.sourceId} · {String(row.sourceRevision).slice(0, 16)}</span><span>{row.basis.replaceAll('_', ' ')} · {row.reference.kind}</span><code>{row.evidenceId}</code>{onInspect && <button type="button" onClick={() => onInspect(row.evidenceId)}>{t('Inspect evidence', 'Xem bằng chứng')}</button>}</li>)}</ul>
  </details>;
}

export function EvidenceInspector({ result, evidenceId, t, formatDate, sourceState, onClose }: { result: Envelope; evidenceId: string; t: Text; formatDate: (value: string) => string; sourceState: (source: Source) => string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null), titleId = useId();
  useEffect(() => {
    const node = dialog.current;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (node && !node.open) node.showModal();
    return () => { node?.close(); if (trigger?.isConnected) trigger.focus(); };
  }, []);
  const evidence = result.evidence.find(row => row.evidenceId === evidenceId);
  const source = result.sources.find(row => row.sourceId === evidence?.sourceId);
  const item = result.data?.contextItems?.find(row => row.evidenceId === evidenceId);
  return <dialog ref={dialog} className="structure-inspector" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); onClose(); }}>
    <header><div><p className="eyebrow">{t('Read-only inspector', 'Chi tiết chỉ đọc')}</p><h2 id={titleId}>{t('Evidence & source', 'Bằng chứng & nguồn')}</h2></div><button type="button" autoFocus onClick={onClose}>{t('Close', 'Đóng')}</button></header>
    {evidence && <><h3>{item?.title ?? evidence.reference.sourceEntityId}</h3><dl><dt>{t('Evidence ID', 'ID bằng chứng')}</dt><dd><code>{evidence.evidenceId}</code></dd><dt>{t('Source', 'Nguồn')}</dt><dd>{evidence.sourceId}</dd><dt>{t('Referenced revision', 'Phiên bản tham chiếu')}</dt><dd>{evidence.sourceRevision}</dd><dt>{t('Basis', 'Cơ sở')}</dt><dd>{evidence.basis.replaceAll('_', ' ')}</dd><dt>{t('Reference', 'Tham chiếu')}</dt><dd>{evidence.reference.kind} · {evidence.reference.sourceEntityId}</dd>
      {item && <><dt>{t('Classification', 'Phân loại')}</dt><dd>{item.classification === 'public' ? t('Public', 'Công khai') : t('Internal', 'Nội bộ')}</dd><dt>{t('Disclosure', 'Phạm vi công bố')}</dt><dd>{item.disclosure === 'owner_safe_summary' ? t('Owner-approved safe summary', 'Bản tóm tắt an toàn do owner duyệt') : t('Public compiled summary', 'Bản tóm tắt công khai đã biên dịch')}</dd></>}
      {source && <><dt>{t('Checked', 'Kiểm tra')}</dt><dd><time dateTime={source.checkedAt}>{formatDate(source.checkedAt)}</time></dd><dt>{t('Source state', 'Trạng thái nguồn')}</dt><dd><Badge state={sourceState(source)} t={t} /></dd></>}
    </dl></>}
    <section className="structure-inspector-boundary"><h3>{t('Coverage of this response', 'Phạm vi phản hồi này')}</h3><p>{t('Evidence identifies what the configured source returned. It does not grant access to the original document or establish a live device state.', 'Bằng chứng xác định nội dung nguồn đã cấu hình trả về. Nó không cấp quyền đọc tài liệu gốc hoặc xác minh trạng thái thiết bị trực tiếp.')}</p><ul>{[...new Set([...result.completeness.reasons, ...result.unknowns.map(row => row.code), ...result.conflicts.map(row => row.code)])].map(reason => <li key={reason}>{reasonName(reason, t)} <code>{reason}</code></li>)}</ul></section>
  </dialog>;
}

// Workspace modes use separate persistent instances so navigation never replaces
// a reviewed-write owner while its outcome is pending or unknown.
export function StructureView({ project, request, language, mode = 'architecture', visible = true, onLockChange }: StructureViewProps) {
  const knowledge = mode === 'knowledge';
  const t: Text = (en, vi) => language === 'vi' ? vi : en;
  const formId = useId();
  const [selectionRecord, setSelectionRecord] = useState<{ project: string; identity: Identity } | null>(null), [active, setActive] = useState<'related' | 'task' | 'observations' | 'desired'>(knowledge ? 'task' : 'related');
  const selected = selectionRecord?.project === project ? selectionRecord.identity : null;
  const setSelected = (value: Identity | null) => setSelectionRecord(value ? { project, identity: value } : null);
  const [proposalLocked, setProposalLocked] = useState(false);
  const proposalLockChanged = useCallback((value: boolean) => { setProposalLocked(value); onLockChange?.(value); }, [onLockChange]);
  const [search, setSearch] = useState(''), [kindFilter, setKindFilter] = useState(''), [task, setTask] = useState('');
  const [contextKind, setContextKind] = useState('');
  const [evidenceView, setEvidenceView] = useState<{ scope: string; id: string } | null>(null);
  const [page, setPage] = useState(0), [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [relationPage, setRelationPage] = useState(0), [relationCursors, setRelationCursors] = useState<(string | null)[]>([null]);
  const [refresh, setRefresh] = useState(0), [detailRefresh, setDetailRefresh] = useState(0), [sessionEnded, setSessionEnded] = useState(false), [taskError, setTaskError] = useState('');
  const [clock, setClock] = useState(() => performance.now());
  const endpoint = `/api/v1/projects/${encodeURIComponent(project)}/agent/read`;
  const guardedRequest = useCallback<StructureRequest>(async <T,>(path: string, method?: string, body?: unknown, signal?: AbortSignal) => {
    try { return await request<T>(path, method, body, signal); }
    catch (error) { if (!signal?.aborted && ['SESSION_EXPIRED', 'UNAUTHENTICATED'].includes(errorCode(error))) setSessionEnded(true); throw error; }
  }, [request]);
  const selection = selected ? entityKey(selected) : '';
  const inventory = useRead(guardedRequest, endpoint, `${project}:inventory:${refresh}`);
  const scope = `${project}:${mode}:${selection}:${refresh}:${detailRefresh}`;
  const entity = useRead(guardedRequest, endpoint, `${scope}:entity`);
  const related = useRead(guardedRequest, endpoint, `${scope}:related`);
  const context = useRead(guardedRequest, endpoint, `${scope}:task`);
  const observation = useRead(guardedRequest, endpoint, `${scope}:observations`);
  useEffect(() => {
    setSelected(null); setPage(0); setCursors([null]); setSearch(''); setKindFilter(''); setTask(''); setTaskError(''); setContextKind('');
    if (project) void inventory.run('context', { limit: 50 });
  }, [project, refresh, inventory.run]);
  useEffect(() => {
    setRelationPage(0); setRelationCursors([null]); setTaskError('');
    if (selected) {
      void entity.run('entity', { kind: selected.kind, entityId: selected.sourceEntityId });
      if (!knowledge) void related.run('related', { kind: selected.kind, entityId: selected.sourceEntityId, depth: 2, limit: 50 });
    }
  }, [selection, project, detailRefresh, refresh, knowledge, entity.run, related.run]);
  useEffect(() => {
    if (!visible || !observation.result) return;
    return watchPresentationClock(() => setClock(performance.now()));
  }, [observation.result, visible]);
  function choose(value: Identity) { if (proposalLocked) return; setSelected(value); setActive(knowledge ? 'task' : 'related'); setTask(''); setContextKind(''); }
  async function inventoryPage(next: number, cursor: string | null) {
    if (proposalLocked) return;
    const result = await inventory.run('context', { limit: 50, ...(cursor ? { cursor } : {}) });
    if (result) { setPage(next); setCursors(current => [...current.slice(0, next), cursor]); setSelected(null); }
  }
  async function relationsPage(next: number, cursor: string | null) {
    if (!selected || proposalLocked) return;
    const result = await related.run('related', { kind: selected.kind, entityId: selected.sourceEntityId, depth: 2, limit: 50, ...(cursor ? { cursor } : {}) });
    if (result) { setRelationPage(next); setRelationCursors(current => [...current.slice(0, next), cursor]); }
  }
  function ask(event: FormEvent) {
    event.preventDefault(); setTaskError('');
    if (!selected || proposalLocked) return;
    const prepared = prepareTaskText(task);
    if (!prepared.valid) { setTaskError(t('Enter a short task (up to 1,000 UTF-8 bytes), without control characters.', 'Nhập yêu cầu ngắn (tối đa 1.000 byte UTF-8), không chứa ký tự điều khiển.')); return; }
    setContextKind('');
    void context.run('task_context', { task: prepared.task, kind: selected.kind, entityId: selected.sourceEntityId, depth: 2 });
  }
  const shownEntities = (inventory.result?.data?.entities ?? []).filter(row => (!kindFilter || row.identity.kind === kindFilter) && `${row.label} ${row.identity.sourceEntityId}`.toLowerCase().includes(search.toLowerCase()));
  const currentEntity = entity.result?.data?.entities.find(row => selected && entityKey(row.identity) === selection);
  const activeRead = knowledge || active === 'task' ? context : active === 'observations' ? observation : related;
  const contextItems = context.result?.data?.contextItems ?? [];
  const shownContext = contextItems.filter(item => !contextKind || item.kind === contextKind);
  const result = selected ? activeRead.result ?? entity.result : inventory.result;
  const preparedTask = prepareTaskText(task);
  const evidenceScope = `${scope}:${active}:${result?.operation ?? ''}`;
  const inspectEvidence = (id: string) => setEvidenceView({ scope: evidenceScope, id });
  const elapsed = Math.max(0, clock - observation.receivedAt) / 1000;
  const formatDate = (value: string) => new Date(value).toLocaleString(language === 'vi' ? 'vi-VN' : 'en-GB', { dateStyle: 'medium', timeStyle: 'medium' });
  const revision = (source: Source) => source.version ? (typeof source.version.value === 'number' ? `r${source.version.value}` : source.version.value.slice(0, 16)) : t('No accessible version', 'Không có phiên bản khả dụng');
  function sourceState(source: Source) {
    const rows = result?.data?.observations.filter(row => row.identity.sourceId === source.sourceId) ?? [];
    const rank: Record<string, number> = { fresh: 0, checked: 0, unknown: 1, stale: 2, unavailable: 3, invalid: 4, revoked: 5 };
    return rows.length ? rows.map(row => visibleObservationState(row, elapsed)).sort((a, b) => rank[b] - rank[a])[0] : source.freshness.state;
  }
  if (sessionEnded) return <div className="structure-empty"><h1>{t('Private session ended', 'Phiên riêng tư đã kết thúc')}</h1><p>{t('Open LMTI again using the local launcher.', 'Mở lại LMTI bằng trình khởi chạy cục bộ.')}</p></div>;
  if (!project) return <p className="structure-empty">{knowledge ? t('Choose a project to browse its knowledge.', 'Chọn dự án để xem tri thức.') : t('Choose a project to inspect its structure.', 'Chọn dự án để xem cấu trúc.')}</p>;
  return <div className={`structure-view${knowledge ? ' knowledge-workspace' : ''}`}>
    <div className="page-heading"><div>{knowledge ? <h1><Icon name="knowledge" size={28} />{t('Knowledge', 'Tri thức')}</h1> : <h2><Icon name="connection" size={24} />{t('Inventory & relationships', 'Danh mục & quan hệ')}</h2>}<p className="subtitle">{knowledge ? t('Find the project understanding behind your next task.', 'Tìm hiểu biết về dự án để thực hiện công việc tiếp theo.') : t('Follow project relationships and check what each source can establish.', 'Xem quan hệ trong dự án và kiểm tra bằng chứng từ từng nguồn.')}</p></div><button onClick={() => setRefresh(value => value + 1)} disabled={inventory.loading || proposalLocked}>{t('Refresh inventory', 'Làm mới danh mục')}</button></div>
    {knowledge && <details className="knowledge-intro"><summary>{t('How to explore project knowledge', 'Cách tra cứu tri thức dự án')}</summary><div className="knowledge-intro-steps">
      <div><span className="knowledge-step" aria-hidden="true">01</span><h2>{t('Choose the subject', 'Chọn đối tượng')}</h2><p>{t('Start from an entity visible in your project scope.', 'Bắt đầu từ đối tượng được phép xem trong dự án.')}</p></div>
      <div><span className="knowledge-step" aria-hidden="true">02</span><h2>{t('Describe your task', 'Nêu công việc')}</h2><p>{t('Read the mapped code, documents and reviewed memory relevant to it.', 'Đọc tóm tắt mã, tài liệu và bộ nhớ đã duyệt có liên quan.')}</p></div>
      <div><span className="knowledge-step" aria-hidden="true">03</span><h2>{t('Check the evidence', 'Đối chiếu bằng chứng')}</h2><p>{t('Review source versions, freshness and any missing coverage.', 'Xem phiên bản nguồn, độ mới và phạm vi còn thiếu.')}</p></div>
    </div></details>}
    <div className="structure-layout">
      <section className="structure-inventory" aria-labelledby={`${formId}-inventory`}>
        <div className="section-heading"><h2 id={`${formId}-inventory`}>{knowledge ? t('Explore by entity', 'Tra cứu theo đối tượng') : t('Project inventory', 'Danh mục dự án')}</h2><span className="muted">{t('Page', 'Trang')} {page + 1}</span></div>
        <label htmlFor={`${formId}-filter`}>{t('Filter this page', 'Lọc trang hiện tại')}</label><input id={`${formId}-filter`} type="search" value={search} maxLength={120} onChange={event => setSearch(event.target.value)} />
        <label className="structure-sr-only" htmlFor={`${formId}-kind`}>{t('Entity type', 'Loại đối tượng')}</label><select id={`${formId}-kind`} value={kindFilter} onChange={event => setKindFilter(event.target.value)}><option value="">{t('All entity types', 'Tất cả loại đối tượng')}</option>{kinds.map(kind => <option value={kind} key={kind}>{kindName(kind, t)}</option>)}</select>
        <Status state={inventory} t={t} />
        {knowledge && inventory.error === 'NOT_SUPPORTED' && <p className="structure-hint">{t('Entity access is not configured for this project. Open Agent to review its project profile and scope.', 'Chưa cấu hình quyền đọc đối tượng cho dự án. Mở Agent để xem hồ sơ và phạm vi của dự án.')}</p>}
        <ul className="structure-entity-list">{shownEntities.map(row => <li key={entityKey(row.identity)}><button disabled={proposalLocked} aria-pressed={selection === entityKey(row.identity)} className={selection === entityKey(row.identity) ? 'selected' : ''} onClick={() => choose(row.identity)}><strong>{row.label}</strong><span>{kindName(row.identity.kind, t)}</span><code>{row.identity.sourceEntityId}</code></button></li>)}</ul>
        {inventory.result && !shownEntities.length && <p className="structure-empty">{search || kindFilter ? t('No matches on this page.', 'Không có kết quả phù hợp trên trang này.') : t('No entities are visible in this scope.', 'Không có đối tượng hiển thị trong phạm vi này.')}</p>}
        <div className="structure-pager"><button disabled={!page || inventory.loading || proposalLocked} onClick={() => void inventoryPage(page - 1, cursors[page - 1])}>{t('Previous', 'Trước')}</button><button disabled={!inventory.result?.completeness.nextCursor || inventory.loading || proposalLocked} onClick={() => void inventoryPage(page + 1, inventory.result!.completeness.nextCursor)}>{t('Next', 'Tiếp')}</button></div>
      </section>
      <section className="structure-detail" aria-labelledby={`${formId}-detail`}>
        {!selected ? <div className="structure-empty"><span className="structure-symbol" aria-hidden="true"><Icon name={knowledge ? 'knowledge' : 'architecture'} size={48} /></span><h2 id={`${formId}-detail`}>{t('Select an entity', 'Chọn một đối tượng')}</h2><p>{knowledge ? t('Select an entity on the left, then describe your task to retrieve its connected knowledge.', 'Chọn đối tượng trong danh mục, rồi nêu công việc để đọc tri thức đã liên kết.') : t('Inspect its declared relationships, ask for task context, or read an asset’s observations.', 'Xem quan hệ khai báo, lấy ngữ cảnh công việc hoặc đọc quan sát của thiết bị.')}</p>{knowledge && <p className="knowledge-boundary">{t('Only summaries returned by the configured sources appear here. A reference alone does not mean its content is connected.', 'Chỉ hiển thị tóm tắt do nguồn đã cấu hình trả về. Có tham chiếu chưa có nghĩa là nội dung đã được kết nối.')}</p>}</div> : <>
          <div className="section-heading"><div><p className="eyebrow">{kindName(selected.kind, t)}</p><h2 id={`${formId}-detail`}>{currentEntity?.label ?? selected.sourceEntityId}</h2><p className="muted">{selected.sourceEntityId}</p></div><button disabled={entity.loading || related.loading || proposalLocked} onClick={() => setDetailRefresh(value => value + 1)}>{t('Refresh entity', 'Làm mới đối tượng')}</button></div>
          <Status state={entity} t={t} />
          {currentEntity && <dl className="structure-attributes"><dt>{t('Classification', 'Phân loại')}</dt><dd>{currentEntity.classification === 'public' ? t('Public metadata', 'Metadata công khai') : t('Internal metadata', 'Metadata nội bộ')}</dd>{Object.entries(currentEntity.attributes).filter(([key, value]) => ['componentType', 'assetType', 'site', 'state', 'contentState'].includes(key) && typeof value === 'string').map(([key, value]) => <div key={key}><dt>{({ componentType: t('Component type', 'Loại thành phần'), assetType: t('Asset type', 'Loại thiết bị'), site: t('Site', 'Địa điểm'), state: t('Release state', 'Trạng thái phát hành'), contentState: t('Content state', 'Trạng thái nội dung') } as Record<string, string>)[key]}</dt><dd>{String(value).replaceAll('_', ' ')}</dd></div>)}</dl>}
          {!knowledge && <div className="structure-views" role="group" aria-label={t('Entity views', 'Các góc nhìn đối tượng')}><button disabled={proposalLocked} aria-pressed={active === 'related'} onClick={() => setActive('related')}>{t('Relationships', 'Quan hệ')}</button><button disabled={proposalLocked} aria-pressed={active === 'task'} onClick={() => setActive('task')}>{t('Task context', 'Ngữ cảnh công việc')}</button>{selected.kind === 'asset' && <button disabled={proposalLocked} aria-pressed={active === 'observations'} onClick={() => setActive('observations')}>{t('Observations', 'Quan sát')}</button>}{selected.kind === 'asset' && <button disabled={proposalLocked} aria-pressed={active === 'desired'} onClick={() => setActive('desired')}>{t('Desired settings', 'Cấu hình mong muốn')}</button>}</div>}
          {!knowledge && active === 'related' && <><p className="structure-hint">{t('Declared relationships within two steps. A desired deployment does not establish a device’s running version.', 'Quan hệ khai báo trong hai bước. Khai báo triển khai mong muốn chưa xác nhận phiên bản thiết bị đang chạy.')}</p><Status state={related} t={t} /><ul className="structure-relations">{related.result?.data?.relations.map(edge => {
            const label = (id: Identity) => related.result?.data?.entities.find(row => entityKey(row.identity) === entityKey(id))?.label ?? id.sourceEntityId;
            return <li key={entityKey(edge.identity)}><div><button className="text-button" onClick={() => choose(edge.from)}>{label(edge.from)}</button><span aria-hidden="true">→</span><button className="text-button" onClick={() => choose(edge.to)}>{label(edge.to)}</button></div><span>{({ declared_dependency: t('Declared dependency', 'Phụ thuộc khai báo'), declared_connection: t('Declared connection', 'Kết nối khai báo'), deployed_to_desired: t('Desired deployment', 'Triển khai mong muốn'), has_release: t('Has release', 'Có bản phát hành'), implemented_in: t('Implemented in', 'Được triển khai trong'), documented_by: t('Documented by', 'Được mô tả bởi') } as Record<string, string>)[edge.type] ?? edge.type}</span></li>;
          })}</ul>{related.result && !related.result.data?.relations.length && <p className="structure-empty">{t('No declared relationships were found within this scope.', 'Không tìm thấy quan hệ khai báo trong phạm vi này.')}</p>}<div className="structure-pager"><button disabled={!relationPage || related.loading || proposalLocked} onClick={() => void relationsPage(relationPage - 1, relationCursors[relationPage - 1])}>{t('Previous', 'Trước')}</button><span>{t('Page', 'Trang')} {relationPage + 1}</span><button disabled={!related.result?.completeness.nextCursor || related.loading || proposalLocked} onClick={() => void relationsPage(relationPage + 1, related.result!.completeness.nextCursor)}>{t('Next', 'Tiếp')}</button></div></>}
          {(knowledge || active === 'task') && <>
            <form className="structure-task" onSubmit={ask}>
              <label htmlFor={`${formId}-task`}>{t('What are you working on?', 'Bạn đang làm việc gì?')}</label>
              <textarea id={`${formId}-task`} rows={3} value={task} maxLength={1000} required aria-invalid={!!task && !preparedTask.valid} aria-describedby={`${formId}-task-help ${formId}-task-count${taskError ? ` ${formId}-task-error` : ''}`} placeholder={t('For example: change the firmware sample format', 'Ví dụ: thay đổi định dạng mẫu của firmware')} onChange={event => { setTask(event.target.value); setTaskError(''); }} />
              <p className="field-help" id={`${formId}-task-help`}>{t('Reads mapped code, documents and deliberate memory for this entity. Line breaks become spaces before sending; other control characters are not accepted.', 'Đọc mã, tài liệu đã ánh xạ và bộ nhớ có chủ đích cho đối tượng này. Xuống dòng được chuyển thành khoảng trắng trước khi gửi; không chấp nhận ký tự điều khiển khác.')}</p>
              <div className="structure-task-footer"><span id={`${formId}-task-count`} className={preparedTask.bytes > 1000 ? 'structure-byte-limit' : 'muted'}>{preparedTask.bytes.toLocaleString(language === 'vi' ? 'vi-VN' : 'en-GB')} / {t('1,000 UTF-8 bytes', '1.000 byte UTF-8')}</span><button className="primary" type="submit" disabled={context.loading || proposalLocked || !preparedTask.valid}>{t('Read task context', 'Đọc ngữ cảnh công việc')}</button></div>
              {taskError && <p id={`${formId}-task-error`} className="structure-error" role="alert">{taskError}</p>}
            </form>
            <Status state={context} t={t} />
            {knowledge && context.error === 'NOT_SUPPORTED' && <div className="knowledge-unavailable"><h3>{t('Knowledge is not connected yet', 'Chưa kết nối nguồn tri thức')}</h3><p>{t('You can browse the project entities. Task context becomes available when the project owner connects a code, document or memory source and approves its mappings.', 'Bạn vẫn có thể xem các đối tượng dự án. Ngữ cảnh công việc sẽ khả dụng khi người quản lý dự án kết nối nguồn mã, tài liệu hoặc bộ nhớ và duyệt ánh xạ của nguồn.')}</p></div>}
            {knowledge && !context.result && !context.loading && !context.error && <div className="knowledge-ready"><h3>{t('Bring the relevant context into view', 'Đọc ngữ cảnh cần cho công việc')}</h3><p>{t('Describe what you want to understand or change. Connected sources return compiled summaries with evidence; availability depends on this entity’s approved mappings.', 'Mô tả điều bạn muốn hiểu hoặc thay đổi. Nguồn đã kết nối trả về tóm tắt đã biên dịch kèm bằng chứng; kết quả phụ thuộc ánh xạ được duyệt cho đối tượng này.')}</p></div>}
            {knowledge && context.result && <div className="knowledge-results-heading">
              <h3>{t('Retrieved knowledge', 'Tri thức tìm được')}</h3>
              <p className="structure-hint">{t('Counts describe this response only.', 'Số lượng chỉ tính trong phản hồi này.')}</p>
              <div className="knowledge-kind-filter" role="group" aria-label={t('Filter retrieved knowledge', 'Lọc tri thức tìm được')}>
                {['', 'code', 'document', 'memory'].map(kind => <button key={kind} aria-pressed={contextKind === kind} onClick={() => setContextKind(kind)}>{kind ? kindName(kind, t) : t('All', 'Tất cả')}<span>{kind ? contextItems.filter(item => item.kind === kind).length : contextItems.length}</span></button>)}
              </div>
            </div>}
            <div className="structure-context">{(knowledge ? shownContext : contextItems).map(item => {
              const evidence = context.result!.evidence.find(row => row.evidenceId === item.evidenceId);
              const source = evidence && context.result!.sources.find(row => row.sourceId === evidence.sourceId);
              return <article key={item.id}>
                <div className="knowledge-card-heading"><span className="pill neutral">{kindName(item.kind, t)}</span>{knowledge && source && <Badge state={source.freshness.state} t={t} />}</div>
                <h3>{item.title}</h3>
                <p className="muted">{item.classification === 'internal' ? t('Internal source', 'Nguồn nội bộ') : t('Public source', 'Nguồn công khai')} · {item.disclosure === 'owner_safe_summary' ? t('Owner-approved safe summary', 'Bản tóm tắt an toàn do owner duyệt') : t('Public compiled summary', 'Bản tóm tắt công khai đã biên dịch')}</p>
                <p>{item.summary}</p>
                <p className="muted">{item.referenceId} · {item.semantics.replaceAll('_', ' ')}</p>
                {knowledge && source && <p className="knowledge-card-source">{source.sourceId} · {revision(source)} · <time dateTime={source.checkedAt}>{formatDate(source.checkedAt)}</time></p>}
                <EvidenceList result={context.result!} ids={[item.evidenceId]} t={t} onInspect={inspectEvidence} />
              </article>;
            })}</div>
            {context.result && !contextItems.length && <p className="structure-empty">{t('No matching source context was returned. Review the source limitations.', 'Chưa có ngữ cảnh nguồn phù hợp. Xem các giới hạn của nguồn.')}</p>}
            {knowledge && context.result && contextItems.length > 0 && !shownContext.length && <p className="structure-empty">{t('No summaries of this type were returned. Choose another filter or check the source coverage below.', 'Phản hồi chưa có tóm tắt thuộc loại này. Chọn bộ lọc khác hoặc xem phạm vi nguồn bên dưới.')}</p>}
          </>}
          {!knowledge && active === 'desired' && selected.kind === 'asset' && <ProposalReview project={project} assetId={selected.sourceEntityId} request={request} language={language} onLockChange={proposalLockChanged} onChanged={() => setDetailRefresh(value => value + 1)} />}
          {!knowledge && active === 'observations' && selected.kind === 'asset' && <><div className="structure-read-heading"><p className="structure-hint">{t('Read-only measurements, with their source quality and expiry.', 'Giá trị chỉ đọc, kèm chất lượng nguồn và thời hạn hiệu lực.')}</p><button disabled={observation.loading} onClick={() => void observation.run('observations', { assetId: selected.sourceEntityId })}>{t('Read observations', 'Đọc quan sát')}</button></div><Status state={observation} t={t} />{observation.result?.sources.some(source => source.kind === 'controlled_replay') && <p className="structure-warning">{t('Controlled replay: test observations, not a live device connection.', 'Dữ liệu phát lại có kiểm soát: quan sát thử nghiệm, chưa phải kết nối thiết bị thật.')}</p>}<div className="structure-observations">{observation.result?.data?.observations.map(row => { const state = visibleObservationState(row, elapsed); return <article key={entityKey(row.identity)}><div className="section-heading"><h3>{row.metric.replaceAll('_', ' ')}</h3><Badge state={state} t={t} /></div><p className="structure-measurement">{row.value === null || ['invalid', 'revoked', 'unavailable'].includes(state) ? '—' : typeof row.value === 'boolean' ? row.value ? t('Yes', 'Có') : t('No', 'Không') : row.value}<small>{row.unit}</small></p><p className="muted">{row.deviceId} · {t('Validity', 'Hiệu lực')}: {row.ttlSeconds}s</p><dl><dt>{t('Sampled', 'Lấy mẫu')}</dt><dd><time dateTime={row.sampleAt}>{formatDate(row.sampleAt)}</time></dd><dt>{t('Received', 'Nhận mẫu')}</dt><dd><time dateTime={row.receivedAt}>{formatDate(row.receivedAt)}</time></dd><dt>{t('Checked', 'Kiểm tra')}</dt><dd><time dateTime={row.checkedAt}>{formatDate(row.checkedAt)}</time></dd></dl>{state === 'stale' && <p className="structure-warning">{t('Historical sample. Read again to check the current source.', 'Mẫu đã cũ. Đọc lại để kiểm tra nguồn hiện tại.')}</p>}{row.freshness.reasons.length > 0 && <ul className="structure-reasons">{row.freshness.reasons.map(reason => <li key={reason}>{reasonName(reason, t)}</li>)}</ul>}<EvidenceList result={observation.result!} ids={row.evidenceIds} t={t} onInspect={inspectEvidence} /></article>; })}</div>{observation.result && !observation.result.data?.observations.length && <p className="structure-empty">{t('No measurements can be shown for this asset.', 'Không có giá trị quan sát có thể hiển thị cho thiết bị này.')}</p>}</>}
        </>}
      </section>
    </div>
    {result && <section className="structure-sources" aria-labelledby={`${formId}-sources`}><div className="section-heading"><h2 id={`${formId}-sources`}>{t('Sources & coverage', 'Nguồn & phạm vi')}</h2><span className="muted">{t('For the view above', 'Cho góc nhìn phía trên')}</span></div>{result.scope && <p className="structure-hint">{t('Project', 'Dự án')}: {result.scope.projectId} · {t('Site', 'Địa điểm')}: {result.scope.site} · {result.scope.modelTarget === 'external' ? t('Context allowed for external agents', 'Ngữ cảnh được phép cung cấp cho Agent bên ngoài') : t('Local metadata scope', 'Phạm vi metadata cục bộ')}</p>}<div className="structure-source-grid">{result.sources.map(source => <article key={source.sourceId}><div className="section-heading"><h3>{source.kind === 'controlled_replay' ? t('Controlled observation replay', 'Quan sát phát lại có kiểm soát') : source.kind === 'project_memory' ? t('Project memory', 'Bộ nhớ dự án') : source.kind === 'compiled_knowledge' ? t('Compiled code & documents', 'Mã & tài liệu đã biên dịch') : source.kind === 'native_project' ? t('Declared project structure', 'Cấu trúc dự án khai báo') : t('Observation provider', 'Nhà cung cấp quan sát')}</h3><Badge state={sourceState(source)} t={t} /></div><p>{revision(source)}</p><p className="muted"><time dateTime={source.checkedAt}>{formatDate(source.checkedAt)}</time></p><code>{source.sourceId}</code></article>)}</div>{(result.unknowns.length > 0 || result.conflicts.length > 0 || result.completeness.reasons.length > 0) && <details className="structure-coverage" open={result.status === 'partial'}><summary>{t('Unknowns and coverage limits', 'Điểm chưa rõ và giới hạn phạm vi')}</summary><ul>{[...new Set([...result.completeness.reasons, ...result.unknowns.map(row => row.code), ...result.conflicts.map(row => row.code)])].map(reason => <li key={reason}>{reasonName(reason, t)} <code>{reason}</code></li>)}</ul></details>}<EvidenceList result={result} t={t} onInspect={inspectEvidence} /></section>}
    {result && evidenceView?.scope === evidenceScope && result.evidence.some(row => row.evidenceId === evidenceView.id) && <EvidenceInspector key={evidenceScope} result={result} evidenceId={evidenceView.id} t={t} formatDate={formatDate} sourceState={sourceState} onClose={() => setEvidenceView(null)} />}
  </div>;
}

