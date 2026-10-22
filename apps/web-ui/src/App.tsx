import { useCallback, useEffect, useId, useRef, useState, type ReactNode, type FormEvent, type RefObject } from 'react';
import type { ClientId, ClientPreviewDto, ClientStatusDto, CommitResultDto, ConnectionCheckDto, ManagedExportDto, McpServerDto, Page, ProfileDto, ProjectSummary } from '../../web-api/src/contracts';
import { request, RequestError, signOut, subscribeSessionInvalidated } from './api';
import { StructureView } from './StructureView';
import { WorkspaceOverview } from './WorkspaceOverview';
import './WorkspaceShell.css';
import { Icon } from './Icon';
import { Brand } from './Brand';
import { SectionTabs } from './SectionTabs';
import { ProjectOperationsPanel } from './ProjectOperationsPanel';
import { LogicalHierarchyPanel } from './LogicalHierarchyPanel';
import { PhysicalHierarchyPanel } from './PhysicalHierarchyPanel';
import { emptyChildLocks, hasChildLock, updateChildLock } from './ui-locks';
import { translate, type Language } from './i18n';
import { validateConnectionDraft, type ConnectionField } from './connection-editor';
import { endLocalSession } from './session-lifecycle';

type WorkspaceSection = 'overview' | 'work' | 'architecture' | 'knowledge' | 'agent';
const workspaceSections: { id: WorkspaceSection; label: string }[] = [
  { id: 'overview', label: 'Overview' }, { id: 'work', label: 'Work' },
  { id: 'architecture', label: 'Architecture' }, { id: 'knowledge', label: 'Knowledge' },
  { id: 'agent', label: 'Agent' },
];

const clients: ClientId[] = ['codex', 'cursor'];
const clientName = (client: ClientId) => client === 'codex' ? 'Codex' : 'Cursor';
const states = { not_applied: 'Not set up', applied: 'Configured', update_pending: 'Update available', recovery_required: 'Recovery required', review_required: 'Review required', unavailable: 'Unavailable' };
type Modal = { kind: 'edit'; server?: McpServerDto } | { kind: 'remove'; server: McpServerDto } | { kind: 'preview'; preview: ClientPreviewDto };
type Event = { project: string; text: string; detail: string; time: string };
type Job = { project: string; id: string; client: ClientId };

function Dialog({ title, children, close, locked, closeLabel, restoreFocus, fallbackFocus, className = "" }: { title: ReactNode; children: ReactNode; close: () => void; locked: boolean; closeLabel: string; restoreFocus?: RefObject<HTMLElement | null>; fallbackFocus?: RefObject<HTMLElement | null>; className?: string }) {
  const titleId = useId();
  const ref = useRef<HTMLDialogElement>(null);
  const onClose = useRef(close); onClose.current = close;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = ref.current!;
    dialog.showModal();
    dialog.querySelector<HTMLInputElement>('input:not([type=checkbox])')?.focus();
    return () => {
      dialog.close();
      requestAnimationFrame(() => {
        if (document.querySelector('dialog[open]')) return;
        const canFocus = (target: HTMLElement | null | undefined): target is HTMLElement => !!target?.isConnected &&
          target !== document.body && target !== document.documentElement && !target.matches(':disabled') &&
          !target.closest('[inert]') && !!target.getClientRects().length && getComputedStyle(target).visibility === 'visible';
        const current = document.activeElement as HTMLElement | null;
        if (canFocus(current) && !dialog.contains(current)) return;
        for (const target of [previous, restoreFocus?.current, fallbackFocus?.current]) {
          if (!canFocus(target)) continue;
          target.focus();
          if (document.activeElement === target) break;
        }
      });
    };
  }, []);
  return <dialog ref={ref} className={className} aria-labelledby={titleId} onCancel={e => { e.preventDefault(); if (!locked) onClose.current(); }}>
    <div className="dialog-heading"><h2 id={titleId}>{title}</h2><button className="close" aria-label={closeLabel} disabled={locked} onClick={close}>×</button></div>{children}
  </dialog>;
}

function Editor({ server, t, busy, blocked, save }: { server?: McpServerDto; t: (s: string) => string; busy: boolean; blocked: boolean; save: (server: McpServerDto) => void }) {
  const [kind, setKind] = useState(server?.transport === 'lmti_local' ? 'local' : server?.privateEndpoint ? 'private' : server ? 'remote' : 'local');
  const [label, setLabel] = useState(server?.label ?? '');
  const [key, setKey] = useState(server?.id ?? '');
  const [site, setSite] = useState(server?.transport === 'lmti_local' ? server.site : '');
  const [endpoint, setEndpoint] = useState(server?.transport === 'remote_https' ? server.endpoint : '');
  const [enabled, setEnabled] = useState(server?.enabled ?? true);
  const [keyEdited, setKeyEdited] = useState(false);
  const [validation, setValidation] = useState<{ field: ConnectionField; message: string } | null>(null);
  const validationRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (validation) validationRef.current?.focus(); }, [validation]);
  const disabled = busy || blocked;
  function submit(e: FormEvent) {
    e.preventDefault();
    const result = validateConnectionDraft({ kind, label, key, site, endpoint, enabled });
    if (!result.ok) { setValidation(result); return; }
    setValidation(null);
    save(result.server);
  }
  return <form onSubmit={submit}>
    {validation && <p id="connection-validation" className="notice error-notice" role="alert" ref={validationRef} tabIndex={-1}>{t(validation.message)}</p>}
    <label htmlFor="kind">{t('Connection type')}</label><select id="kind" value={kind} onChange={e => setKind(e.target.value)} disabled={disabled}>
      <option value="local">{t('Local LMTI')}</option><option value="remote">{t('Remote MCP')}</option><option value="cloudflare">Cloudflare</option><option value="private">{t('Private network (Tailscale)')}</option>
    </select>
    <label htmlFor="name">{t('Name')}</label><input id="name" autoFocus required value={label} disabled={disabled} aria-invalid={validation?.field === 'label'} aria-describedby={`connection-name-help${validation?.field === 'label' ? ' connection-validation' : ''}`} onChange={e => { setValidation(null); setLabel(e.target.value); if (!server && !keyEdited) setKey(e.target.value.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^[^a-z]+/, '').slice(0, 48)); }} /><p className="field-help" id="connection-name-help">{t('Maximum 120 UTF-8 bytes. Vietnamese characters may use more than one byte.')}</p>
    {kind === 'local' ? <><label htmlFor="site">{t('Site')}</label><input id="site" required value={site} disabled={disabled} aria-invalid={validation?.field === 'site'} aria-describedby={`connection-site-help${validation?.field === 'site' ? ' connection-validation' : ''}`} onChange={e => { setValidation(null); setSite(e.target.value); }} /><p className="field-help" id="connection-site-help">{t('Maximum 64 UTF-8 bytes. The site must already exist in the project topology.')}</p></> :
      <><label htmlFor="endpoint">{t('Endpoint')}</label><input id="endpoint" type="url" required pattern="https://.*" value={endpoint} disabled={disabled} aria-invalid={validation?.field === 'endpoint'} aria-describedby={`connection-endpoint-help${validation?.field === 'endpoint' ? ' connection-validation' : ''}`} onChange={e => { setValidation(null); setEndpoint(e.target.value); }} placeholder="https://mcp.example.com/mcp" /><p className="field-help" id="connection-endpoint-help">{t('Maximum 512 UTF-8 bytes. Use HTTPS without credentials, query parameters or fragments.')}</p></>}
    <label htmlFor="key">{t('Server key')}</label><input id="key" required pattern={'[a-z][a-z0-9_\\-]{0,47}'} maxLength={48} value={key} disabled={disabled} aria-invalid={validation?.field === 'key'} aria-describedby={validation?.field === 'key' ? 'connection-validation' : undefined} onChange={e => { setValidation(null); setKeyEdited(true); setKey(e.target.value); }} /><p className="field-help">{t('A saved connection needs a stable, unique server key.')}</p>
    <label className="checkbox"><input type="checkbox" checked={enabled} disabled={disabled} onChange={e => setEnabled(e.target.checked)} />{t('Include in configuration when applied')}</label>
    <p className="soft-panel">{t('No API keys or tokens here. Authentication belongs to the client.')}</p>
    <div className="dialog-footer"><button className="primary" type="submit" disabled={disabled}>{t(busy ? 'Working…' : 'Save connection')}</button></div>
  </form>;
}

export function App({ ready }: { ready: Promise<void> }) {
  const [language, setLanguage] = useState<Language>('en'); const t = (s: string) => translate(language, s);
  const [session, setSession] = useState<'loading' | 'ready' | 'ended'>('loading');
  const [projects, setProjects] = useState<ProjectSummary[]>([]), [cursor, setCursor] = useState<string | null>(null);
  const [listLoaded, setListLoaded] = useState(false);
  const [project, setProject] = useState(''), [query, setQuery] = useState('');
  const [profile, setProfile] = useState<ProfileDto | null>(null);
  const [statusSnapshot, setStatusSnapshot] = useState<{ projectId: string; values: Partial<Record<ClientId, ClientStatusDto>> }>({ projectId: '', values: {} });
  const statuses = statusSnapshot.projectId === project ? statusSnapshot.values : {};
  const [checks, setChecks] = useState<Record<string, ConnectionCheckDto>>({});
  const [tab, setTab] = useState<WorkspaceSection>('overview'), [modal, setModal] = useState<Modal | null>(null);
  const [navigationOpen, setNavigationOpen] = useState(false), [projectPicker, setProjectPicker] = useState(false);
  const mobileMenuRef = useRef<HTMLButtonElement>(null), contentRef = useRef<HTMLElement>(null);
  const [architectureTab, setArchitectureTab] = useState<'logical' | 'physical' | 'inventory'>('logical');
  const [architectureVisited, setArchitectureVisited] = useState({ physical: false, inventory: false });
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [events, setEvents] = useState<Event[]>([]), [job, setJob] = useState<Job | null>(null), [refresh, setRefresh] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [needsReload, setNeedsReload] = useState(false);
  const mounted = useRef(true), locked = useRef(false), localSessionEnded = useRef(false);
  const selected = projects.find(p => p.id === project);
  const endpoint = (client: ClientId, action = '') => `/api/v1/projects/${project}/clients/${client}${action ? '/' + action : ''}`;
  const [childLocks,setChildLocks]=useState(emptyChildLocks);
  const [visited,setVisited]=useState({architecture:false,knowledge:false,work:false});
  const clearLocalSession = useCallback(() => {
    if (localSessionEnded.current || !mounted.current) return;
    localSessionEnded.current = true;
    setSession('ended'); setProfile(null); setModal(null); setEvents([]);
    setProjects([]); setProject(''); setCursor(null); setListLoaded(false); setQuery('');
    setStatusSnapshot({ projectId: '', values: {} }); setChecks({}); setJob(null);
    setNavigationOpen(false); setProjectPicker(false); setNeedsReload(false); setLoading(false);
    setError(''); setNotice(''); setVisited({ architecture: false, knowledge: false, work: false });
    setArchitectureVisited({ physical: false, inventory: false });
    // Leave child write gates untouched. Ending this UI cannot settle an owner operation.
  }, []);
  const lockAgent=useCallback((value:boolean)=>setChildLocks(locks=>updateChildLock(locks,'agent',value)),[]);
  const lockHierarchy=useCallback((value:boolean)=>setChildLocks(locks=>updateChildLock(locks,'hierarchy',value)),[]);
  const lockPhysical=useCallback((value:boolean)=>setChildLocks(locks=>updateChildLock(locks,'physical',value)),[]);
  const lockOperations=useCallback((value:boolean)=>setChildLocks(locks=>updateChildLock(locks,'operations',value)),[]);
  const changed=useCallback(()=>{setNeedsReload(false);setRefresh(value=>value+1);},[]);
  const openRecovery=useCallback(()=>setTab('work'),[]);
  const structureLocked=hasChildLock(childLocks);
  useEffect(()=>{if(tab==='architecture'||tab==='knowledge'||tab==='work'){const key=tab;setVisited(value=>value[key]?value:{...value,[key]:true});}},[tab]);
  const frozen = busy || !!job || structureLocked;
  const writeBlocked = frozen || needsReload;
  function navigate(section: WorkspaceSection) {
    if (frozen || modal || session !== 'ready') return;
    setTab(section); setNavigationOpen(false);
    requestAnimationFrame(() => document.getElementById('content')?.focus());
  }
  function fail(e: unknown, writing = false) {
    if (e instanceof DOMException && e.name === 'AbortError') return;
    if (e instanceof RequestError && ['SESSION_EXPIRED', 'UNAUTHENTICATED'].includes(e.code)) { clearLocalSession(); return; }
    if (localSessionEnded.current) return;
    const code = e instanceof RequestError ? e.code : 'NETWORK';
    if (code === 'RECOVERY_REQUIRED' || code === 'REVISION_CONFLICT' || code === 'CONFIG_CHANGED' || (code === 'NETWORK' && writing)) setNeedsReload(true);
    setError(code === 'REVISION_CONFLICT' ? 'Profile changed elsewhere. Reload before editing again.' :
      code === 'RECOVERY_REQUIRED' ? 'The result is unknown. Open Work to inspect recovery before another write.' :
      code === 'CONFIG_CHANGED' ? 'Configuration changed. Refresh and review a new preview.' :
      code === 'PREVIEW_EXPIRED' ? 'Preview expired. Close and create a new preview.' :
      code === 'NOT_SUPPORTED' ? 'Remote checks are not supported. Sign in through the selected client.' :
      code === 'INVALID_INPUT' ? 'Invalid input. Check the server key, site or HTTPS endpoint.' :
      code === 'NETWORK' && writing ? 'The result is unknown. Refresh status before creating a new preview; do not repeat the write.' :
      code === 'NETWORK' || code === 'OWNER_UNAVAILABLE' ? 'The local owner is unavailable. Check the package and retry a read.' : 'The operation was refused to protect existing configuration.');
  }
  async function run(action: () => Promise<void>, writing = false) {
    if (locked.current) return; locked.current = true; setBusy(true); setError(''); setNotice('');
    try { await action(); } catch (e) { if (mounted.current) fail(e, writing); }
    finally { locked.current = false; if (mounted.current) setBusy(false); }
  }
  function record(text: string, detail: string) { setEvents(v => [{ project, text, detail, time: new Date().toISOString() }, ...v].slice(0, 100)); }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => subscribeSessionInvalidated(clearLocalSession), [clearLocalSession]);
  useEffect(() => { document.documentElement.lang = language; }, [language]);
  useEffect(() => { if (session !== 'ready') { setNavigationOpen(false); setProjectPicker(false); } }, [session]);
  useEffect(() => {
    const screen = window.matchMedia('(min-width: 1200px)');
    const closeDrawer = () => { if (screen.matches) setNavigationOpen(false); };
    screen.addEventListener('change', closeDrawer); return () => screen.removeEventListener('change', closeDrawer);
  }, []);
  useEffect(() => {
    const cancel = new AbortController();
    let booted = false;
    ready.then(() => { booted = true; return request<Page<ProjectSummary>>('/api/v1/projects?limit=50', 'GET', undefined, cancel.signal); })
      .then(page => { if (!cancel.signal.aborted && !localSessionEnded.current) { setProjects(page.items); setCursor(page.nextCursor); setProject(page.items[0]?.id ?? ''); setListLoaded(true); setSession('ready'); } })
      .catch(e => { if (!cancel.signal.aborted) { fail(e); if (!booted) clearLocalSession(); else if (!localSessionEnded.current && !(e instanceof RequestError && ['SESSION_EXPIRED','UNAUTHENTICATED'].includes(e.code))) setSession('ready'); } });
    return () => cancel.abort();
  }, [ready]);
  useEffect(() => {
    if (!project || session !== 'ready') return;
    const cancel = new AbortController(); setLoading(true); setProfile(null); setStatusSnapshot({ projectId: '', values: {} }); setChecks({});
    request<ProjectSummary>(`/api/v1/projects/${project}`, 'GET', undefined, cancel.signal)
      .then(summary => { if (!cancel.signal.aborted) setProjects(v => v.map(p => p.id === summary.id ? summary : p)); })
      .catch(e => { if (!cancel.signal.aborted) fail(e); });
    request<ProfileDto>(`/api/v1/projects/${project}/mcp-profile`, 'GET', undefined, cancel.signal)
      .then(p => { if (!cancel.signal.aborted) setProfile(p); })
      .catch(e => { if (!cancel.signal.aborted) fail(e); })
      .finally(() => { if (!cancel.signal.aborted) setLoading(false); });
    for (const client of clients) request<ClientStatusDto>(endpoint(client), 'GET', undefined, cancel.signal)
      .then(status => { if (!cancel.signal.aborted) setStatusSnapshot(v => ({ projectId: project, values: { ...(v.projectId === project ? v.values : {}), [client]: status } })); })
      .catch(e => { if (!cancel.signal.aborted) fail(e); });
    return () => cancel.abort();
  }, [project, refresh, session]);
  useEffect(() => { if (modal?.kind !== 'preview') return; setNow(Date.now()); const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [modal]);
  async function checkJob(current: Job, signal?: AbortSignal) {
    const result = await request<{ state: 'pending' | 'succeeded' | 'failed' | 'unknown'; result: CommitResultDto | null; errorCode: string | null }>(`/api/v1/operations/${current.id}`, 'GET', undefined, signal);
    if (result.state === 'pending') return false;
    setJob(null); setModal(null); setRefresh(v => v + 1);
    if (result.state === 'unknown' || result.result?.outcome === 'unknown') {
      record('Outcome unknown',clientName(current.client)); setNeedsReload(true);
      throw new RequestError('RECOVERY_REQUIRED','Inspect and review recovery before another write.');
    }
    if (result.state === 'failed') throw new RequestError(result.errorCode as RequestError['code'], 'Operation refused');
    record(result.result?.outcome === 'restored' ? 'Restored' : 'Applied', clientName(current.client)); setNotice(result.result?.outcome === 'restored' ? 'Restored' : 'Applied'); return true;
  }
  useEffect(() => {
    if (!job || session !== 'ready') return;
    const cancel = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const poll = async () => { try { if (!await checkJob(job, cancel.signal) && !cancel.signal.aborted) timer = setTimeout(poll, 1500); } catch (e) { if (!cancel.signal.aborted) fail(e); } };
    timer = setTimeout(poll, 1200); return () => { cancel.abort(); clearTimeout(timer); };
  }, [job, session]);
  async function save(servers: McpServerDto[]) {
    if (!profile) return;
    const saved = await request<ProfileDto>(`/api/v1/projects/${project}/mcp-profile`, 'PUT', { expectedRevision: profile.revision, servers });
    setProfile(saved); setModal(null); setRefresh(v => v + 1); record('Saved', `r${saved.revision}`); setNotice('Saved');
  }
  async function preview(client: ClientId, operation: 'apply' | 'restore') {
    if (!profile) return;
    const result = await request<ClientPreviewDto>(endpoint(client, 'previews'), 'POST', { expectedProfileRevision: profile.revision, operation });
    setModal({ kind: 'preview', preview: result });
  }
  async function commit(preview: ClientPreviewDto) {
    // Close capability-bearing preview immediately; never reuse after any response/error.
    setModal(null);
    const result = await request<CommitResultDto>(endpoint(preview.client, 'commit'), 'POST', { previewId: preview.id });
    if (result.outcome === 'pending') { setJob({ project, client: preview.client, id: result.operationId }); return; }
    if (result.outcome === 'unknown') {
      record('Outcome unknown',clientName(preview.client)); setNeedsReload(true);
      throw new RequestError('RECOVERY_REQUIRED','Inspect and review recovery before another write.');
    }
    record(result.outcome === 'restored' ? 'Restored' : 'Applied', clientName(preview.client));
    setNotice(result.outcome === 'restored' ? 'Restored' : 'Applied'); setRefresh(v => v + 1);
  }
  async function exportConfig(client: ClientId) {
    const result = await request<ManagedExportDto>(endpoint(client, 'export'), 'POST', { expectedProfileRevision: profile!.revision });
    const url = URL.createObjectURL(new Blob([result.content], { type: 'text/plain;charset=utf-8' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = result.filename; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    record('Managed configuration exported', clientName(client)); setNotice('Managed configuration exported');
  }
  async function loadMoreProjects() {
    try {
      const page = await request<Page<ProjectSummary>>(`/api/v1/projects?limit=50&cursor=${encodeURIComponent(cursor!)}`);
      setProjects(v => [...v, ...page.items]); setCursor(page.nextCursor);
    } catch (e) {
      if (!(e instanceof RequestError && e.code === 'PREVIEW_EXPIRED')) throw e;
      // A cursor is a disposable read capability. Restart discovery, never retry a write.
      const page = await request<Page<ProjectSummary>>('/api/v1/projects?limit=50');
      setProjects(page.items); setCursor(page.nextCursor); setQuery('');
      setProject(current => page.items.some(p => p.id === current) ? current : page.items[0]?.id ?? '');
      setNotice('Project list refreshed.');
    }
  }
  function reload() { setModal(null); setError(''); setNotice(''); setNeedsReload(false); setRefresh(v => v + 1); }
  const refreshButton = <button disabled={frozen} onClick={reload}>{t('Refresh')}</button>;
  const navigation = <nav aria-label={t('Workspace')}>{workspaceSections.map(({ id, label }) => <button key={id} className={`nav ${tab === id ? 'active' : ''}`} aria-current={tab === id ? 'page' : undefined} disabled={frozen || !!modal || session !== 'ready'} onClick={() => navigate(id)}><Icon name={id} /><span>{t(label)}</span></button>)}</nav>;
  const projectSwitcher = <button className="project-switcher" aria-haspopup="dialog" aria-label={`${t('Choose a project')}: ${selected?.name ?? t('No projects registered')}`} disabled={writeBlocked || !!modal || session !== 'ready'} onClick={() => { setNavigationOpen(false); setQuery(''); setProjectPicker(true); }}><Icon name="project" size={22} /><span>{selected?.name ?? t('Choose a project')}</span><span className="chevron" aria-hidden="true">⌄</span></button>;
  const endSession = () => run(() => endLocalSession(signOut, clearLocalSession));
  const filteredProjects = projects.filter(p => `${p.name} ${p.id}`.toLowerCase().includes(query.toLowerCase()));
  return <div className="app-shell workspace-shell">
    <a className="skip" href="#content">{t('Skip to content')}</a>
    <aside className="sidebar"><Brand />
      {projectSwitcher}<p className="workspace-nav-label">{t('Workspace')}</p>{navigation}
      <div className="sidebar-bottom"><div className="local-label"><span className="dot" />{t('Local workspace')}</div><p>{t('Local, project-scoped configuration.')}</p></div>
    </aside>
    <div className="workspace"><header className="topbar">
      <div className="topbar-start"><button ref={mobileMenuRef} className="mobile-menu-button" aria-label={t('Open navigation')} aria-haspopup="dialog" aria-expanded={navigationOpen} disabled={!!modal || projectPicker} onClick={() => setNavigationOpen(true)}><span className="menu-lines" aria-hidden="true" /></button><Brand compact className="mobile-brand" /><div className="breadcrumb"><span>{selected?.name ?? 'LMTI'}</span><span aria-hidden="true">/</span><strong>{t(workspaceSections.find(section => section.id === tab)!.label)}</strong></div></div>
      <div className="topbar-actions"><select aria-label={t('Language')} value={language} onChange={e => setLanguage(e.target.value as Language)}><option value="en">EN</option><option value="vi">VI</option></select>{session === 'ready' && <button className="topbar-end-session text-button" disabled={frozen || !!modal} onClick={endSession}>{t('End session')}</button>}</div>
    </header><div className="mobile-project">{projectSwitcher}</div>
      <main ref={contentRef} id="content" tabIndex={-1}>
        {session === 'loading' ? <div className="session-loading" role="status"><Icon name="overview" size={32} /><span>{t('Loading…')}</span></div> : session === 'ended' ? <div className="empty"><h1>{t('Private session ended')}</h1><p>{t('Open LMTI again using the local launcher.')}</p><p>{t('If an operation was interrupted, inspect its status and recovery in Work before another change. Do not repeat the submitted operation.')}</p></div> : <>
          {error && <div className="notice error-notice" role="alert">{t(error)} <button disabled={frozen} onClick={reload}>{t('Reload current profile')}</button></div>}
          {notice && <div className="notice success" role="status">{t(notice)}</div>}
          {job && <div className="notice" role="status">{t('Operation pending')} · {clientName(job.client)}<p>{t('Keep this page open while the owner completes the operation.')}</p><button disabled={busy} onClick={() => run(async () => { await checkJob(job); })}>{t('Check operation status')}</button></div>}
          {frozen && <p className="notice owner-lock-notice" role="status">{t('An operation is in progress. Project and navigation are locked until its outcome is inspected.')}</p>}
          {(visited.work||tab==='work')&&<div hidden={tab!=='work'}>
            <div className="page-heading workspace-section-heading"><div><p className="eyebrow">{t('PROJECT WORKSPACE')}</p><h1>{t('Work')}</h1><p className="subtitle">{t('Review project operations and recover interrupted changes.')}</p></div></div>
            <ProjectOperationsPanel project={project} language={language} onLockChange={lockOperations} onChanged={changed} refreshKey={refresh} disabled={busy||!!job||hasChildLock(childLocks,'operations')} />
            <section className="workspace-session section" aria-labelledby="session-activity"><div className="section-heading"><h2 id="session-activity">{t('Session activity')}</h2><span className="pill neutral">{t('This browser session')}</span></div>
              <p className="subtitle">{t('Only actions from this browser session appear here. Agent tool calls are not audited here.')}</p>
              <div className="timeline">{events.filter(e => e.project === project).map((event, i) => <article className="timeline-item" key={i}><h3>{t(event.text)}</h3><p>{event.detail} · <time dateTime={event.time}>{new Date(event.time).toLocaleTimeString(language === 'vi' ? 'vi-VN' : 'en-GB')}</time></p></article>)}{!events.some(e => e.project === project) && <p className="muted">{t('No activity in this session.')}</p>}</div>
            </section>
          </div>}
          {(visited.architecture||tab==='architecture')&&<div hidden={tab!=='architecture'}>
            <div className="page-heading workspace-section-heading"><div><p className="eyebrow">{t('PROJECT WORKSPACE')}</p><h1>{t('Architecture')}</h1><p className="subtitle">{t('Explore project structure, devices and their relationships.')}</p></div></div>
            <SectionTabs label={t('Architecture')} value={architectureTab} disabled={frozen || !!modal} onChange={value => { setArchitectureTab(value); if (value !== 'logical') setArchitectureVisited(previous => ({ ...previous, [value]: true })); }} items={[
              { id: 'logical', label: t('Logical structure'), panel: 'architecture-logical' },
              { id: 'physical', label: t('Physical infrastructure'), panel: 'architecture-physical' },
              { id: 'inventory', label: t('Inventory & relationships'), panel: 'architecture-inventory' },
            ]} />
            <div id="architecture-logical" role="tabpanel" aria-label={t('Logical structure')} hidden={architectureTab !== 'logical'}><LogicalHierarchyPanel project={project} language={language} request={request} onLockChange={lockHierarchy} onChanged={changed} onRecovery={openRecovery} refreshKey={refresh} disabled={busy||!!job||hasChildLock(childLocks,'hierarchy')} /></div>
            <div id="architecture-physical" role="tabpanel" aria-label={t('Physical infrastructure')} hidden={architectureTab !== 'physical'}>{(architectureVisited.physical || architectureTab==='physical')&&<PhysicalHierarchyPanel project={project} language={language} request={request} onLockChange={lockPhysical} onChanged={changed} onRecovery={openRecovery} refreshKey={refresh} disabled={busy||!!job||hasChildLock(childLocks,'physical')} />}</div>
            <div id="architecture-inventory" role="tabpanel" aria-label={t('Inventory & relationships')} hidden={architectureTab !== 'inventory'}>{project&&(architectureVisited.inventory || architectureTab==='inventory')&&<fieldset className="structure-owner-controls" disabled={busy||!!job||hasChildLock(childLocks,'agent')}><StructureView key={`${project}:${refresh}`} mode="architecture" visible={tab==='architecture'&&architectureTab==='inventory'} project={project} request={request} language={language} onLockChange={lockAgent} /></fieldset>}</div>
          </div>}
          {(visited.knowledge||tab==='knowledge')&&<div hidden={tab!=='knowledge'}>
            <fieldset className="structure-owner-controls" disabled={frozen}><StructureView key={`${project}:${refresh}`} mode="knowledge" visible={tab==='knowledge'} project={project} request={request} language={language} /></fieldset>
          </div>}

          {!projects.length && !['work', 'knowledge', 'architecture'].includes(tab) ? <div className="empty"><h1>{t(listLoaded ? 'No projects registered' : 'Unavailable')}</h1><p>{t('Open the Qt Studio fallback to create/link projects or edit topology.')}</p><button disabled={frozen} onClick={() => run(async () => { const page = await request<Page<ProjectSummary>>('/api/v1/projects?limit=50'); setProjects(page.items); setCursor(page.nextCursor); setProject(page.items[0]?.id ?? ''); setListLoaded(true); })}>{t('Refresh')}</button></div> : tab === 'overview' && selected ? <WorkspaceOverview project={selected} profile={profile} statuses={profile?.projectId === project ? statuses : {}} loading={loading} disabled={frozen || !!modal} language={language} onNavigate={navigate} /> : tab === 'agent' ? <>
            <div className="page-heading"><div><p className="eyebrow">{t('PROJECT WORKSPACE')}</p><h1>{t('Agent')}</h1><p className="subtitle">{t('Manage MCP connections and configuration for each client.')}</p></div><button className="primary" disabled={!profile || writeBlocked || loading || profile.servers.length >= 32} onClick={() => { setError(''); setModal({ kind: 'edit' }); }}>＋ {t('Add connection')}</button></div>
            <div className="agent-layout"><div className="agent-connections"><div className="agent-profile"><Icon name="connection" size={32} /><div><h2>{t('Connection profile')} {profile ? `r${profile.revision}` : '—'}</h2><p>{t('Profile edits do not update client files until you review and apply.')}</p></div></div>
            <section className="section" aria-labelledby="connections"><div className="section-heading"><h2 id="connections">{t('Connections')}</h2><span className="muted">{profile ? `r${profile.revision} · ${profile.servers.length}/32` : t('Loading…')}</span></div>
              <div className="connection-list">{loading ? <p className="empty" role="status">{t('Loading…')}</p> : !profile ? <div className="empty">{t('Unavailable')} {refreshButton}</div> : !profile.servers.length ? <div className="empty"><h3>{t('No connections yet')}</h3><p>{t('Add the first connection for this project.')}</p></div> : profile.servers.map(server => <div className="connection-row" key={server.id}>
                <div className="connection-icon" aria-hidden="true"><Icon name="connection" size={24} /></div>
                <div className="connection-main"><h3>{server.label}</h3><p>{server.transport === 'lmti_local' ? `${t('Local LMTI')} · ${server.site}` : `${server.privateEndpoint ? 'Tailscale / HTTPS' : 'HTTPS MCP'} · ${t('OAuth handled by client')}`}</p><span className={`pill ${!server.enabled ? 'neutral' : checks[server.id]?.state === 'ok' ? '' : 'neutral'}`}>{t(!server.enabled ? 'Disabled' : checks[server.id]?.state === 'ok' ? 'Local handshake passed' : 'Not checked')}</span></div>
                <div className="connection-actions"><button disabled={frozen || !server.enabled || server.transport !== 'lmti_local'} title={server.transport !== 'lmti_local' ? t('Remote checks are not supported. Sign in through the selected client.') : undefined} onClick={() => run(async () => { const result = await request<ConnectionCheckDto>(`/api/v1/projects/${project}/connections/${server.id}/check`, 'POST', {}); setChecks(v => ({ ...v, [server.id]: result })); record('Check completed', `${server.id} · ${result.toolNames.length} tools`); })}>{t('Check')}</button><button disabled={writeBlocked} aria-label={`${t('Edit')} ${server.label}`} onClick={() => { setError(''); setModal({ kind: 'edit', server }); }}>{t('Edit')}</button><button className="icon-button" disabled={writeBlocked} aria-label={`${t('Remove connection')} ${server.label}`} onClick={() => { setError(''); setModal({ kind: 'remove', server }); }}>×</button></div>
              </div>)}</div><p className="section-footnote">{t('Profile edits do not update client files until you review and apply.')}</p>
            </section>
            <details className="help"><summary>{t('Advanced')}</summary><p>{t('Setup affects the selected project folder only. Restart or reload the client to use the configuration.')}</p><p>{t('Remote checks are not supported. Sign in through the selected client.')}</p></details>
            </div><section className="section agent-clients" aria-labelledby="agents"><div className="section-heading"><h2 id="agents">{t('Client setup')}</h2>{refreshButton}</div>
              <div className="client-grid">{clients.map(client => { const status = statuses[client]; const tone = status?.configuration === 'applied' ? '' : status?.configuration === 'recovery_required' ? 'bad' : status?.configuration === 'update_pending' || status?.configuration === 'review_required' ? 'warn' : 'neutral'; return <article className="client-card" key={client}>
                <div className="client-heading"><h3><span className="client-logo" aria-hidden="true"><Icon name="agent" size={24} /></span>{clientName(client)}</h3></div>
                <div className="client-state-row"><span>{t('Configuration')}</span><span className={`pill ${tone}`}>{t(status ? states[status.configuration] : 'Status unknown')}{status?.appliedRevision != null ? ` · r${status.appliedRevision}` : ''}</span></div>
                <div className="client-state-row"><span>{t('Client use')}</span><span className={`pill ${status?.clientUse === 'verified' ? '' : 'neutral'}`}>{t(status?.clientUse === 'verified' ? 'Client use verified' : 'Client use not verified')}</span></div>
                <p className="client-detail">{selected?.linkedRoot ? `${t('Profile revision')} r${profile?.revision ?? '—'}` : t('Folder not linked')}</p>
                <div className="client-buttons"><button className="primary" disabled={!profile || !profile.revision || !selected?.linkedRoot || writeBlocked} onClick={() => run(() => preview(client, 'apply'))}>{t('Preview setup')}</button><button disabled={!profile || writeBlocked || !status?.canRestore} onClick={() => run(() => preview(client, 'restore'))}>{t('Restore')}</button><button disabled={!profile?.revision || frozen} onClick={() => run(() => exportConfig(client))}>{t('Export')}</button></div>
              </article>; })}</div><p className="section-footnote">{t('Configuration and client use are tracked separately.')}</p>
            </section></div>
          </> : null}
        </>}
      </main><footer className="preview-footer"><span>LMTi · {t('Local workspace')}</span><span>{t('Local, project-scoped configuration.')}</span></footer>
    </div>
    {navigationOpen && <Dialog className="navigation-drawer" title={<Brand />} closeLabel={t('Close')} locked={false} close={() => setNavigationOpen(false)}>
      {projectSwitcher}<p className="workspace-nav-label">{t('Workspace')}</p>{navigation}
      <div className="sidebar-bottom"><div className="local-label"><span className="dot" />{t('Local workspace')}</div><p>{t('Local, project-scoped configuration.')}</p></div>
      {session === 'ready' && <button className="drawer-session" disabled={frozen || !!modal} onClick={endSession}>{t('End session')}</button>}
    </Dialog>}
    {projectPicker && session === 'ready' && <Dialog className="project-picker" title={t('Choose a project')} closeLabel={t('Close')} locked={busy} close={() => setProjectPicker(false)} restoreFocus={mobileMenuRef} fallbackFocus={contentRef}>
      {error && <p className="notice error-notice" role="alert">{t(error)}</p>}
      {notice && <p className="notice success" role="status">{t(notice)}</p>}
      <p className="subtitle">{t('Search only the projects already loaded in this session.')}</p><label className="sr-only" htmlFor="project-search">{t('Find project')}</label>
      <input id="project-search" className="project-search" placeholder={t('Find project')} value={query} onChange={e => setQuery(e.target.value)} disabled={busy} />
      <div className="project-picker-list">{filteredProjects.map(p => <button key={p.id} className="project-option" aria-pressed={p.id === project} disabled={writeBlocked} onClick={() => { setProject(p.id); setError(''); setNotice(''); setNeedsReload(false); setProjectPicker(false); }}><Icon name="project" /><span><strong>{p.name}</strong><small>{p.id}</small></span><span aria-hidden="true">{p.id === project ? '✓' : '○'}</span></button>)}</div>
      {!filteredProjects.length && <p role="status" className="empty">{t(projects.length ? 'No matching projects in the loaded list.' : 'No projects registered')}</p>}
      <div className="project-picker-footer"><span>{projects.length} {t('projects loaded')}</span>{cursor && <button disabled={frozen} onClick={() => run(loadMoreProjects)}>{t('Load more projects')}</button>}</div>
    </Dialog>}
    {modal && session === 'ready'  && <Dialog locked={busy} closeLabel={t('Close')} close={() => { setModal(null); if (!needsReload) setError(''); }} title={t(modal.kind === 'edit' ? modal.server ? 'Edit connection' : 'Add connection' : modal.kind === 'remove' ? 'Remove connection' : modal.preview.operation === 'apply' ? 'Preview changes' : 'Preview restore')}>
      {error && <div className="error" role="alert"><p>{t(error)}</p>{needsReload && <button disabled={busy} onClick={reload}>{t('Reload current profile')}</button>}</div>}
      {modal.kind === 'edit' ? <Editor server={modal.server} t={t} busy={busy} blocked={needsReload} save={server => run(async () => { const servers = profile!.servers.filter(s => s.id !== modal.server?.id); if (servers.some(s => s.id === server.id)) throw new RequestError('INVALID_INPUT', 'Duplicate server key'); await save([...servers, server]); }, true)} /> : modal.kind === 'remove' ? <><p>{modal.server.label}</p><p className="muted">{t('This removes it from the profile. Review and apply to update each client.')}</p><div className="dialog-footer"><button disabled={busy} onClick={() => setModal(null)}>{t('Cancel')}</button><button className="danger" disabled={writeBlocked} onClick={() => run(async () => { await save(profile!.servers.filter(s => s.id !== modal.server.id)); record('Connection removed', modal.server.id); }, true)}>{t('Remove connection')}</button></div></> : <>
        <p className="muted">{clientName(modal.preview.client)} · {selected?.name} · r{modal.preview.profileRevision}</p>
        <p className="soft-panel">{t(modal.preview.operation === 'apply' ? 'Existing unmanaged connections are preserved.' : 'Restore uses the protected recovery snapshot for this project and client.')}</p>
        {modal.preview.changes && <div className="diff">{(['added', 'updated', 'removed'] as const).flatMap(kind => modal.preview.changes![kind].map(id => <div className="diff-row" key={`${kind}-${id}`}><span>{t(kind === 'added' ? 'Added' : kind === 'updated' ? 'Updated' : 'Removed')}</span><code>{id}</code></div>))}{!Object.values(modal.preview.changes).some(ids => ids.length) && <p>{t('Nothing to change')}</p>}</div>}
        {modal.preview.generatedConfig && <details><summary>{t('Generated configuration')} · {modal.preview.generatedConfig.format.toUpperCase()}</summary><pre>{modal.preview.generatedConfig.content}</pre></details>}
        <p className="field-help">{t('Preview expires in two minutes. The owner rechecks files before writing.')} <time dateTime={modal.preview.expiresAt}>{new Date(modal.preview.expiresAt).toLocaleTimeString(language === 'vi' ? 'vi-VN' : 'en-GB')}</time></p>
        {now >= Date.parse(modal.preview.expiresAt) && <p className="error" role="alert">{t('Preview expired. Close and create a new preview.')}</p>}
        <div className="dialog-footer"><button disabled={busy} onClick={() => setModal(null)}>{t('Cancel')}</button><button className="primary" disabled={writeBlocked || now >= Date.parse(modal.preview.expiresAt)} onClick={() => run(() => commit(modal.preview), true)}>{t(busy ? 'Working…' : modal.preview.operation === 'apply' ? 'Apply to project' : 'Confirm restore')}</button></div>
      </>}
    </Dialog>}
  </div>;
}
