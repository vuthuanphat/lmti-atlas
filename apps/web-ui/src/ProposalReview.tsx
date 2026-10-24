import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { StructureRequest } from './StructureView';
import './ProposalReview.css';

type Desired = { enabled: boolean; pollMs: number };
type Inspection = { projectId: string; projectRevision: number; topologyRevision: number; asset: { id: string; label: string; site: string; kind: string; privacy: string; desired: Desired; observed: { status: string; at: number | null } } };
type Proposal = { schema: 'lmti.topology.proposal.v1'; baseRevision: number; assetId: string; site: string; expected: Desired; desired: Desired };
type Preview = { id: string; projectId: string; expectedProjectRevision: number; topologyRevision: number; proposal: Proposal; diff: { expected: Desired; desired: Desired }; expiresAt: string; deviceActions: false };
type Commit = { operationId: string; outcome: 'committed' | 'pending' | 'unknown'; projectRevision?: number; topologyRevision?: number; deviceActions: false };
type Mode = 'idle' | 'edit' | 'review' | 'pending' | 'unknown' | 'success' | 'conflict';
type Props = { project: string; assetId: string; request: StructureRequest; language: 'en' | 'vi'; onLockChange: (locked: boolean) => void; onChanged: () => void };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
const identity = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const entityId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(value);
const desired = (value: unknown): value is Desired => object(value) && typeof value.enabled === 'boolean' && integer(value.pollMs) && value.pollMs >= 100 && value.pollMs <= 3600000;
const same = (left: Desired, right: Desired) => left.enabled === right.enabled && left.pollMs === right.pollMs;
const codeOf = (error: unknown): string => object(error) && typeof error.code === 'string' ? error.code : 'NETWORK';
class InvalidResponse extends Error { readonly code = 'INVALID_SOURCE_RESPONSE'; }

export function checkedProposalInspection(value: unknown, assetId: string, projectId: string): Inspection {
  if (!object(value) || value.projectId !== projectId || !entityId(value.projectId) || !integer(value.projectRevision) || !integer(value.topologyRevision) || !object(value.asset) || value.asset.id !== assetId ||
      typeof value.asset.label !== 'string' || value.asset.label.length > 512 || !entityId(value.asset.site) || !desired(value.asset.desired)) throw new InvalidResponse();
  return value as unknown as Inspection;
}
export function proposalFailureMode(code: string): 'conflict' | 'unknown' {
  // A failed status can mean the owner committed but its acknowledgement was
  // lost. Only definitive refusals release the pinned transaction.
  return ['REVISION_CONFLICT', 'CONFIG_CHANGED', 'PREVIEW_EXPIRED', 'SCOPE_DENIED', 'INVALID_INPUT'].includes(code) ? 'conflict' : 'unknown';
}
export function checkedProposalPreview(value: unknown, inspected: Inspection, proposal: Proposal): Preview {
  if (!object(value) || !identity(value.id) || value.projectId !== inspected.projectId || value.expectedProjectRevision !== inspected.projectRevision || value.topologyRevision !== inspected.topologyRevision ||
      value.deviceActions !== false || typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt)) ||
      !object(value.proposal) || value.proposal.schema !== proposal.schema || value.proposal.baseRevision !== proposal.baseRevision || value.proposal.assetId !== proposal.assetId || value.proposal.site !== proposal.site ||
      !desired(value.proposal.expected) || !same(value.proposal.expected, proposal.expected) || !desired(value.proposal.desired) || !same(value.proposal.desired, proposal.desired) ||
      !object(value.diff) || !desired(value.diff.expected) || !desired(value.diff.desired) || !same(value.diff.expected, proposal.expected) || !same(value.diff.desired, proposal.desired)) throw new InvalidResponse();
  return value as unknown as Preview;
}
function checkedCommit(value: unknown): Commit {
  if (!object(value) || !identity(value.operationId) || value.deviceActions !== false || !['committed', 'pending', 'unknown'].includes(String(value.outcome)) ||
      value.outcome === 'committed' && (!integer(value.projectRevision) || !integer(value.topologyRevision))) throw new InvalidResponse();
  return value as unknown as Commit;
}

export function ProposalReview({ project, assetId, request, language, onLockChange, onChanged }: Props) {
  const t = (en: string, vi: string) => language === 'vi' ? vi : en;
  const formId = useId(), mounted = useRef(true), locked = useRef(false), requestBusy = useRef(false);
  const notifyLock = useRef(onLockChange), notifyChanged = useRef(onChanged); notifyLock.current = onLockChange; notifyChanged.current = onChanged;
  const readController = useRef<AbortController | null>(null), generation = useRef(0);
  const target = useRef({ project, assetId });
  if (!locked.current) target.current = { project, assetId };
  const [inspection, setInspection] = useState<Inspection | null>(null), [recovery, setRecovery] = useState<Inspection | null>(null), [preview, setPreview] = useState<Preview | null>(null);
  const [mode, setMode] = useState<Mode>('idle'), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [recoveryAttempted, setRecoveryAttempted] = useState(false);
  const [enabled, setEnabled] = useState(true), [pollMs, setPollMs] = useState('1000'), [operationId, setOperationId] = useState<string | null>(null), [now, setNow] = useState(Date.now());
  const shownScope = useRef(`${project}:${assetId}`), scope = `${project}:${assetId}`;
  const endpoint = (selected = target.current) => `/api/v1/projects/${encodeURIComponent(selected.project)}/proposals`;
  function lock(value: boolean) { if (locked.current !== value) { locked.current = value; notifyLock.current(value); } }
  function start() { if (requestBusy.current) return false; requestBusy.current = true; setBusy(true); setError(''); return true; }
  function finish() { requestBusy.current = false; if (mounted.current) setBusy(false); }
  function clearRead() { generation.current++; readController.current?.abort(); }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; clearRead(); }; }, []);
  useEffect(() => {
    if (locked.current || shownScope.current === scope) return;
    clearRead(); shownScope.current = scope; setInspection(null); setRecovery(null); setRecoveryAttempted(false); setPreview(null); setMode('idle'); setError(''); setNotice(''); setOperationId(null); finish();
  }, [scope, mode]);
  useEffect(() => {
    if (!preview) return;
    setNow(Date.now()); const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer);
  }, [preview]);
  async function inspect(recover = false) {
    if (!start()) return;
    if (recover) setRecoveryAttempted(true);
    clearRead(); const serial = generation.current, selected = { ...target.current }, abort = new AbortController(); readController.current = abort;
    try {
      const value = checkedProposalInspection(await request<unknown>(`${endpoint(selected)}/inspect`, 'POST', { assetId: selected.assetId }, abort.signal), selected.assetId, selected.project);
      if (!mounted.current || generation.current !== serial || abort.signal.aborted) return;
      if (recover) setRecovery(value);
      else { setInspection(value); setEnabled(value.asset.desired.enabled); setPollMs(String(value.asset.desired.pollMs)); setPreview(null); setMode('edit'); setNotice(''); }
    } catch (caught) { if (mounted.current && generation.current === serial && !abort.signal.aborted) { setError(codeOf(caught)); if (!recover) { setInspection(null); setMode('idle'); } } }
    finally { if (generation.current === serial) finish(); }
  }
  async function createPreview(event: FormEvent) {
    event.preventDefault(); if (!inspection || !start()) return;
    setNotice('');
    const next = { enabled, pollMs: Number(pollMs) };
    if (!desired(next) || !pollMs.trim() || same(next, inspection.asset.desired)) { setError('INVALID_INPUT'); finish(); return; }
    clearRead(); const serial = generation.current, abort = new AbortController(); readController.current = abort;
    const proposal: Proposal = { schema: 'lmti.topology.proposal.v1', baseRevision: inspection.topologyRevision, assetId: inspection.asset.id, site: inspection.asset.site, expected: { ...inspection.asset.desired }, desired: next };
    try {
      const value = checkedProposalPreview(await request<unknown>(`${endpoint()}/previews`, 'POST', { expectedProjectRevision: inspection.projectRevision, proposal }, abort.signal), inspection, proposal);
      if (!mounted.current || generation.current !== serial || abort.signal.aborted) return;
      setPreview(value); setMode('review');
    } catch (caught) { if (mounted.current && generation.current === serial && !abort.signal.aborted) { setError(codeOf(caught)); if (['REVISION_CONFLICT', 'CONFIG_CHANGED'].includes(codeOf(caught))) { setMode('conflict'); setInspection(null); } } }
    finally { if (generation.current === serial) finish(); }
  }
  async function reject() {
    if (!preview || !start()) return;
    clearRead(); const serial = generation.current, abort = new AbortController(); readController.current = abort;
    const captured = preview;
    try {
      const result = await request<{ rejected: boolean }>(`${endpoint()}/previews/${encodeURIComponent(captured.id)}`, 'DELETE', undefined, abort.signal);
      if (!result || result.rejected !== true) throw new InvalidResponse();
      if (mounted.current && generation.current === serial && !abort.signal.aborted) { setPreview(null); setMode('edit'); setNotice('rejected'); }
    } catch (caught) { if (mounted.current && generation.current === serial && !abort.signal.aborted) { if (codeOf(caught) === 'PREVIEW_EXPIRED') { setPreview(null); setMode('edit'); setNotice('rejected'); } else setError(codeOf(caught)); } }
    finally { if (generation.current === serial) finish(); }
  }
  async function completed(result: Commit) {
    if (!mounted.current) return;
    setOperationId(null); setRecovery(null); setInspection(null); setMode('success'); setNotice('committed'); setError('');
    const selected = { ...target.current };
    try {
      const current = checkedProposalInspection(await request<unknown>(`${endpoint(selected)}/inspect`, 'POST', { assetId: selected.assetId }), selected.assetId, selected.project);
      if (mounted.current) setRecovery(current);
    } catch { if (mounted.current) setError('REINSPECTION_UNAVAILABLE'); }
    finally { if (mounted.current) { notifyChanged.current(); lock(false); } }
  }
  async function confirm() {
    if (!preview || Date.now() >= Date.parse(preview.expiresAt) || !start()) return;
    const captured = preview, selected = { ...target.current }; lock(true); setPreview(null); setRecovery(null); setRecoveryAttempted(false); setNotice('');
    try {
      // The preview is consumed before dispatch. A write is not aborted, retried,
      // or recreated when the transport result is uncertain.
      const result = checkedCommit(await request<unknown>(`${endpoint(selected)}/commit`, 'POST', { previewId: captured.id }));
      if (!mounted.current) return;
      if (result.outcome === 'pending') { setOperationId(result.operationId); setMode('pending'); }
      else if (result.outcome === 'unknown') { setOperationId(result.operationId); setMode('unknown'); setError('RECOVERY_REQUIRED'); }
      else await completed(result);
    } catch (caught) {
      if (!mounted.current) return;
      const code = codeOf(caught); setError(code); setInspection(null);
      setMode(proposalFailureMode(code));
      if (proposalFailureMode(code) === 'conflict') lock(false);
    } finally { finish(); }
  }
  async function checkOperation() {
    if (!operationId || !start()) return;
    try {
      const value = await request<unknown>(`/api/v1/operations/${encodeURIComponent(operationId)}`);
      if (!object(value) || value.operationId !== operationId || !['pending', 'succeeded', 'failed', 'unknown'].includes(String(value.state))) throw new InvalidResponse();
      if (!mounted.current) return;
      if (value.state === 'pending') setMode('pending');
      else if (value.state === 'succeeded') { const result = checkedCommit(value.result); if (result.operationId !== operationId || result.outcome !== 'committed') throw new InvalidResponse(); await completed(result); }
      else {
        const code = value.state === 'unknown' ? 'RECOVERY_REQUIRED' : typeof value.errorCode === 'string' ? value.errorCode : 'OWNER_UNAVAILABLE';
        setMode(proposalFailureMode(code)); setError(code); setInspection(null);
        if (proposalFailureMode(code) === 'conflict') { setOperationId(null); lock(false); }
      }
    } catch (caught) { if (mounted.current) { setMode('unknown'); setError(codeOf(caught)); } }
    finally { finish(); }
  }
  useEffect(() => {
    if (mode !== 'pending' || !operationId || busy) return;
    const timer = setTimeout(() => { void checkOperation(); }, 1500); return () => clearTimeout(timer);
  }, [mode, operationId, busy]);
  function endUnknownReview() {
    if (busy || !recoveryAttempted || mode !== 'unknown') return;
    setOperationId(null); setMode('idle'); setInspection(null); setRecovery(null); setNotice('unconfirmed'); setError(''); lock(false); notifyChanged.current();
  }
  const bool = (value: boolean) => value ? t('Enabled', 'Bật') : t('Disabled', 'Tắt');
  const expired = !!preview && now >= Date.parse(preview.expiresAt);
  const displayedInspection = recovery ?? inspection;
  function errorText() {
    if (error === 'REVISION_CONFLICT' || error === 'CONFIG_CHANGED') return t('Saved settings changed. Inspect again before preparing a new proposal.', 'Cấu hình đã lưu đã thay đổi. Đọc lại trước khi chuẩn bị đề xuất mới.');
    if (error === 'PREVIEW_EXPIRED') return t('This preview expired. Inspect the current settings and create a new review.', 'Bản xem trước đã hết hạn. Đọc cấu hình hiện tại và tạo lượt duyệt mới.');
    if (error === 'INVALID_INPUT') return t('Change at least one value. Poll interval must be a whole number from 100 to 3,600,000 ms.', 'Thay đổi ít nhất một giá trị. Chu kỳ đọc phải là số nguyên từ 100 đến 3.600.000 ms.');
    if (error === 'REINSPECTION_UNAVAILABLE') return t('The save succeeded, but the current settings could not be read again.', 'Đã lưu thành công, nhưng chưa đọc lại được cấu hình hiện tại.');
    if (['SESSION_EXPIRED', 'UNAUTHENTICATED', 'SCOPE_DENIED'].includes(error)) return t('This session cannot access the selected settings.', 'Phiên này không có quyền đọc cấu hình đã chọn.');
    return t('The owner could not verify this operation. No automatic write retry will be made.', 'Owner chưa xác minh được thao tác. Không tự động thử lại thao tác ghi.');
  }
  if (shownScope.current !== scope && !locked.current) return <p role="status">{t('Loading selected asset…', 'Đang tải thiết bị đã chọn…')}</p>;
  return <section className="proposal-review" aria-labelledby={`${formId}-heading`}>
    <h3 id={`${formId}-heading`}>{t('Review desired settings', 'Duyệt cấu hình mong muốn')}</h3><p className="proposal-help">{t('Save a reviewed change to the project declaration. This sends no command to the device.', 'Lưu thay đổi đã duyệt vào khai báo dự án. Thao tác này không gửi lệnh đến thiết bị.')}</p>
    {locked.current && <p className="proposal-warning" role="status">{t('This review is pinned to', 'Lượt duyệt này gắn với')} {target.current.project} / {target.current.assetId}. {t('Resolve its result before switching projects.', 'Xác minh kết quả trước khi chuyển dự án.')}</p>}
    {error && <p className="proposal-error" role="alert">{errorText()}</p>}
    {notice === 'rejected' && <p className="proposal-success" role="status">{t('Preview rejected. No change was submitted.', 'Đã từ chối bản xem trước. Không gửi thay đổi để lưu.')}</p>}
    {notice === 'committed' && <p className="proposal-success" role="status">{t('Reviewed settings saved by the project owner.', 'Owner dự án đã lưu cấu hình được duyệt.')}</p>}
    {notice === 'unconfirmed' && <p className="proposal-warning" role="status">{t('Review ended without retrying. The previous submission’s outcome was not confirmed.', 'Đã kết thúc lượt duyệt và không thử lại. Kết quả lần gửi trước chưa được xác nhận.')}</p>}
    {displayedInspection && <div className="proposal-saved"><strong>{displayedInspection.asset.label}</strong><p>{t('Saved project revision', 'Phiên bản dự án đã lưu')} r{displayedInspection.projectRevision} · {displayedInspection.asset.site}</p><dl><dt>{t('Desired state', 'Trạng thái mong muốn')}</dt><dd>{bool(displayedInspection.asset.desired.enabled)}</dd><dt>{t('Poll interval', 'Chu kỳ đọc')}</dt><dd>{displayedInspection.asset.desired.pollMs.toLocaleString(language === 'vi' ? 'vi-VN' : 'en-GB')} ms</dd></dl></div>}
    {(mode === 'idle' || mode === 'conflict' || mode === 'success') && <button disabled={busy} onClick={() => void inspect()}>{t('Inspect saved settings', 'Đọc cấu hình đã lưu')}</button>}
    {mode === 'edit' && inspection && <form onSubmit={createPreview}><label className="checkbox"><input type="checkbox" checked={enabled} disabled={busy} onChange={event => setEnabled(event.target.checked)} />{t('Desired enabled state', 'Trạng thái bật mong muốn')}</label><label htmlFor={`${formId}-poll`}>{t('Desired poll interval (ms)', 'Chu kỳ đọc mong muốn (ms)')}</label><input id={`${formId}-poll`} type="number" inputMode="numeric" min={100} max={3600000} step={1} required value={pollMs} disabled={busy} onChange={event => setPollMs(event.target.value)} /><div className="proposal-actions"><button type="button" disabled={busy} onClick={() => void inspect()}>{t('Reload settings', 'Đọc lại cấu hình')}</button><button type="submit" className="primary" disabled={busy}>{t('Preview changes', 'Xem trước thay đổi')}</button></div></form>}
    {mode === 'review' && preview && <div className="proposal-diff"><h4>{t('Review before saving', 'Kiểm tra trước khi lưu')}</h4><p className="proposal-help">{t('Project revision', 'Phiên bản dự án')} r{preview.expectedProjectRevision} · {t('Topology revision', 'Phiên bản cấu trúc')} r{preview.topologyRevision}</p><table><caption className="structure-sr-only">{t('Desired settings change', 'Thay đổi cấu hình mong muốn')}</caption><thead><tr><th>{t('Setting', 'Cấu hình')}</th><th>{t('Before', 'Trước')}</th><th>{t('After', 'Sau')}</th></tr></thead><tbody><tr><th>{t('Enabled', 'Bật')}</th><td>{bool(preview.diff.expected.enabled)}</td><td>{bool(preview.diff.desired.enabled)}</td></tr><tr><th>{t('Poll interval', 'Chu kỳ đọc')}</th><td>{preview.diff.expected.pollMs} ms</td><td>{preview.diff.desired.pollMs} ms</td></tr></tbody></table><p className={expired ? 'proposal-error' : 'proposal-help'} role={expired ? 'status' : undefined}>{expired ? t('Preview expired. Reject it and inspect again.', 'Bản xem trước hết hạn. Từ chối rồi đọc lại cấu hình.') : `${t('Expires in', 'Hết hạn sau')} ${Math.max(0, Math.ceil((Date.parse(preview.expiresAt) - now) / 1000))}s`}</p><div className="proposal-actions"><button disabled={busy} onClick={() => void reject()}>{t('Reject proposal', 'Từ chối đề xuất')}</button><button className="primary" disabled={busy || expired} onClick={() => void confirm()}>{t('Accept and save declaration', 'Chấp nhận và lưu khai báo')}</button></div></div>}
    {mode === 'pending' && <div className="proposal-warning" role="status"><p>{t('The owner is completing the save. Checking this operation only.', 'Owner đang hoàn thành lưu. Chỉ kiểm tra thao tác đang chạy.')}</p><button disabled={busy} onClick={() => void checkOperation()}>{t('Check operation status', 'Kiểm tra trạng thái thao tác')}</button></div>}
    {mode === 'unknown' && <div className="proposal-warning"><h4>{t('Save outcome is unknown', 'Chưa xác định kết quả lưu')}</h4><p>{t('The one-use preview has been discarded. Inspect the saved state before deciding what to do next; an inspection does not confirm the earlier request’s outcome.', 'Bản xem trước dùng một lần đã được bỏ. Đọc trạng thái đã lưu trước khi quyết định bước tiếp; lần đọc này không xác nhận kết quả yêu cầu trước.')}</p><div className="proposal-actions">{operationId && <button disabled={busy} onClick={() => void checkOperation()}>{t('Check operation status', 'Kiểm tra trạng thái thao tác')}</button>}<button disabled={busy} onClick={() => void inspect(true)}>{t('Inspect saved settings', 'Đọc cấu hình đã lưu')}</button>{recoveryAttempted && <button disabled={busy} onClick={endUnknownReview}>{t('End review without retrying', 'Kết thúc duyệt và không thử lại')}</button>}</div></div>}
    {busy && <p className="proposal-help" role="status">{t('Waiting for the project owner…', 'Đang chờ owner dự án…')}</p>}
  </section>;
}
