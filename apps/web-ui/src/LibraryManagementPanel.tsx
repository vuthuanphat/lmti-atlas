import {useEffect,useRef,useState,type FormEvent} from 'react';
import type {StructureRequest} from './StructureView';
type Action='create'|'register'|'link'|'pin'|'forget';
type State={enabled:boolean;format?:number;entries?:{id:string;label:string;pinned:boolean;folderLinked:boolean}[];folders?:{key:string;label:string}[];candidates?:{key:string;label:string}[]};
type Preview={id:string;expiresAt:string;action:Action;projectId:string;label:string;sourcePreserved:true;requiresRelaunch:boolean};
type Result={operationId:string;outcome:'pending'|'committed'|'unknown';requiresRelaunch?:boolean};
export const libraryProjectIdPattern='[A-Za-z]([A-Za-z0-9._]|-)*';
export function LibrarySavedNotice({requiresRelaunch,language}:{requiresRelaunch:boolean;language:'en'|'vi'}){
  const t=(en:string,vi:string)=>language==='vi'?vi:en;
  return <p className="notice success" role="status">{requiresRelaunch?
    t('Saved. Changed project bindings require a launcher restart. To access newly registered projects, the operator must explicitly select their IDs with the local opener. O and page refresh keep the current scope.',
      'Đã lưu. Đổi liên kết dự án cần khởi động lại launcher. Muốn truy cập dự án vừa đăng ký, operator phải chọn rõ ID của chúng bằng trình mở cục bộ. Nhấn O hoặc tải lại trang vẫn giữ phạm vi hiện tại.'):
    t('Library metadata saved.','Đã lưu metadata thư viện.')}</p>;
}
export function LibraryManagementPanel({language,request,disabled,visible,onLockChange,onChanged}:{language:'en'|'vi';request:StructureRequest;disabled:boolean;visible:boolean;onLockChange:(v:boolean)=>void;onChanged:()=>void}){
  const t=(en:string,vi:string)=>language==='vi'?vi:en;
  const [state,setState]=useState<State|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [action,setAction]=useState<Action|'none'>('none'),[id,setId]=useState(''),[label,setLabel]=useState(''),[folder,setFolder]=useState(''),[candidate,setCandidate]=useState('');
  const [preview,setPreview]=useState<Preview|null>(null),[job,setJob]=useState<string|null>(null),[unknown,setUnknown]=useState(false),[refresh,setRefresh]=useState(0);
  const attempt=useRef(false),mounted=useRef(true),locked=busy||action!=='none'||!!preview||!!job;
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>{onLockChange(locked);return()=>onLockChange(false);},[locked,onLockChange]);
  useEffect(()=>{if(!visible)return;const controller=new AbortController();setBusy(true);setError('');
    (async()=>{
      const value=await request<State>('/api/v1/library/manage/state','GET',undefined,controller.signal);
      if(typeof value.enabled!=='boolean'||(value.enabled&&(!Array.isArray(value.entries)||!Array.isArray(value.folders)||!Array.isArray(value.candidates))))throw Error('Invalid response');
      if(!controller.signal.aborted){setState(value);setFolder(f=>f||value.folders?.[0]?.key||'');setCandidate(c=>c||value.candidates?.[0]?.key||'');}
      const status=await request<{admitted:boolean;recoveryRequired:boolean}>('/api/v1/write-status','GET',undefined,controller.signal);
      if(!controller.signal.aborted&&status.admitted===true&&status.recoveryRequired===false)setUnknown(false);
    })().catch(()=>{if(!controller.signal.aborted){setState(null);setError('OWNER_UNAVAILABLE');}}).finally(()=>{if(!controller.signal.aborted)setBusy(false);});return()=>controller.abort();
  },[visible,refresh,request]);
  async function run(fn:()=>Promise<void>,writing=false){if(attempt.current||disabled)return;attempt.current=true;setBusy(true);setError('');setNotice('');
    try{await fn();}catch(e){if(mounted.current){const code=(e as {code?:string}).code||'NETWORK';setError(code);setPreview(null);setAction('none');if(writing&&['NETWORK','RECOVERY_REQUIRED'].includes(code))setUnknown(true);}}
    finally{attempt.current=false;if(mounted.current)setBusy(false);}
  }
  async function review(body:unknown){await run(async()=>{const value=await request<Preview>('/api/v1/library/manage/previews','POST',body);
    if(typeof value.id!=='string'||value.sourcePreserved!==true||!Number.isFinite(Date.parse(value.expiresAt)))throw Error('Invalid review');setPreview(value);setAction('none');});}
  function form(e:FormEvent){e.preventDefault();void review(action==='create'?{action,id,label,folderKey:folder}:action==='register'?{action,candidateKey:candidate}:{action,id,folderKey:folder});}
  function result(value:Result){if(value.outcome==='pending'){setJob(value.operationId);return;}setJob(null);
    if(value.outcome==='unknown'){setUnknown(true);return;}if(value.outcome!=='committed')throw Error('Invalid result');
    setNotice(value.requiresRelaunch?'relaunch':'saved');
    setRefresh(v=>v+1);onChanged();
  }
  return <section className="section" aria-labelledby="library-management-title" aria-busy={busy}>
    <div className="section-heading"><h2 id="library-management-title">{t('Project library','Thư viện dự án')}</h2><button disabled={disabled||locked} onClick={()=>setRefresh(v=>v+1)}>{t('Refresh library','Tải lại thư viện')}</button></div>
    <p>{t('Create and register metadata, choose an approved folder, pin projects or remove a library reference. Source files are preserved.','Tạo và đăng ký metadata, chọn thư mục đã được cấp phép, ghim dự án hoặc gỡ tham chiếu thư viện. File nguồn được giữ nguyên.')}</p>
    {error&&<p className="notice error-notice" role="alert">{t('The owner refused the request or is unavailable. Refresh and review again. Existing libraries need an explicit upgrade before registration or link changes.','Owner từ chối hoặc chưa sẵn sàng. Tải lại và duyệt lại. Thư viện cũ cần nâng cấp tường minh trước khi đăng ký hay đổi liên kết.')} <code>{error}</code></p>}
    {notice&&<LibrarySavedNotice requiresRelaunch={notice==='relaunch'} language={language}/>}
    {unknown&&<p className="notice" role="alert">{t('Write outcome unknown. Do not repeat it. Use the recovery controls below to inspect the original library and target; staging artifacts are retained.','Chưa xác định kết quả ghi. Không gửi lại. Dùng phần phục hồi bên dưới để kiểm tra thư viện và đích gốc; artifact trung gian được giữ lại.')}</p>}
    {state?.enabled===false?<p className="notice">{t('Library management is not granted. Relaunch with a reviewed LibraryManagementFile. The browser cannot choose filesystem paths.','Chưa cấp quyền quản lý thư viện. Mở lại với LibraryManagementFile đã kiểm tra. Trình duyệt không chọn đường dẫn hệ thống.')}</p>:state?.enabled&&<>
      <p className="muted">{t('Library format','Định dạng thư viện')}: {state.format||t('new','mới')}. {t('Metadata only; no credentials.','Chỉ metadata, không lưu thông tin xác thực.')}</p>
      {state.format===1&&<p className="notice">{t('Review a library format upgrade in the maintenance controls before adding projects or changing bindings. Pinning remains available.','Duyệt nâng cấp định dạng thư viện trong phần bảo trì trước khi thêm dự án hay đổi liên kết. Vẫn có thể ghim dự án.')}</p>}
      <button disabled={disabled||locked||unknown||state.format===1} onClick={()=>{setAction('create');setId('');setLabel('');}}>{t('Create project','Tạo dự án')}</button>
      <button disabled={disabled||locked||unknown||state.format===1||!state.candidates?.length} onClick={()=>setAction('register')}>{t('Register existing project','Đăng ký dự án có sẵn')}</button>
      <div className="table-scroll"><table><thead><tr><th>{t('Project','Dự án')}</th><th>{t('Folder link','Liên kết thư mục')}</th><th>{t('Actions','Thao tác')}</th></tr></thead><tbody>
        {state.entries?.map(e=><tr key={e.id}><td>{e.label} <code>{e.id}</code></td><td>{e.folderLinked?t('Linked','Đã liên kết'):t('Not linked','Chưa liên kết')}</td><td>
          <button disabled={disabled||locked||unknown} onClick={()=>void review({action:'pin',id:e.id,pinned:!e.pinned})}>{e.pinned?t('Unpin','Bỏ ghim'):t('Pin','Ghim')}</button>
          <button disabled={disabled||locked||unknown||state.format===1} onClick={()=>{setId(e.id);setAction('link');}}>{t('Link folder','Liên kết thư mục')}</button>
          <button disabled={disabled||locked||unknown||state.format===1} onClick={()=>void review({action:'forget',id:e.id})}>{t('Remove reference','Gỡ tham chiếu')}</button>
        </td></tr>)}</tbody></table></div>
    </>}
    {action!=='none'&&<form onSubmit={form}>
      <h3>{action==='create'?t('New project','Dự án mới'):action==='register'?t('Approved existing project','Dự án có sẵn đã được cấp phép'):t('Change folder link','Đổi liên kết thư mục')}</h3>
      {action==='create'&&<><label>{t('Project ID','Mã dự án')}<input value={id} required maxLength={64} pattern={libraryProjectIdPattern} disabled={busy} onChange={e=>setId(e.target.value)}/></label><label>{t('Project name','Tên dự án')}<input value={label} required maxLength={120} disabled={busy} onChange={e=>setLabel(e.target.value)}/></label></>}
      {action==='register'?<label>{t('Approved candidate','Ứng viên đã cấp phép')}<select value={candidate} disabled={busy} onChange={e=>setCandidate(e.target.value)}>{state?.candidates?.map(c=><option key={c.key} value={c.key}>{c.label}</option>)}</select></label>:<label>{t('Approved project folder','Thư mục dự án đã cấp phép')}<select value={folder} disabled={busy} onChange={e=>setFolder(e.target.value)}>{state?.folders?.map(f=><option key={f.key} value={f.key}>{f.label}</option>)}</select></label>}
      <button type="button" disabled={busy} onClick={()=>setAction('none')}>{t('Cancel','Hủy')}</button><button className="primary" disabled={busy||disabled} type="submit">{t('Review library change','Xem trước thay đổi thư viện')}</button>
    </form>}
    {preview&&<div className="soft-panel" role="region" aria-label={t('Review library change','Xem trước thay đổi thư viện')}><h3>{t('Review library change','Xem trước thay đổi thư viện')}</h3><p>{preview.action} · {preview.label} · <code>{preview.projectId}</code></p>
      <p>{t('Source files will be preserved. Project binding changes require relaunch; this session gains no additional project access.','File nguồn được giữ nguyên. Đổi liên kết dự án cần mở lại launcher; phiên này không nhận thêm quyền truy cập dự án.')}</p>
      {preview.action==='forget'&&<p>{t('Only the library reference is removed. The database and repository remain on disk.','Chỉ gỡ tham chiếu thư viện. Database và repository vẫn còn trên ổ đĩa.')}</p>}
      <button disabled={busy} onClick={()=>void run(async()=>{await request(`/api/v1/library/manage/previews/${preview.id}`,'DELETE');setPreview(null);})}>{t('Reject changes','Từ chối thay đổi')}</button>
      <button className="primary" disabled={busy||disabled||Date.parse(preview.expiresAt)<=Date.now()} onClick={()=>void run(async()=>{const id=preview.id;setPreview(null);result(await request<Result>('/api/v1/library/manage/commit','POST',{previewId:id}));},true)}>{t('Confirm library change','Xác nhận thay đổi thư viện')}</button>
    </div>}
    {job&&<p className="notice" role="status">{t('Library operation pending. Do not repeat it.','Thao tác thư viện đang chờ. Không gửi lại.')} <button disabled={busy} onClick={()=>void run(async()=>{const value=await request<{state:string;result:Result|null;errorCode:string|null}>(`/api/v1/operations/${job}`);if(value.state==='pending')return;if(value.result)result(value.result);else{setJob(null);throw Object.assign(Error('Refused'),{code:value.errorCode||'OWNER_UNAVAILABLE'});}},true)}>{t('Check operation status','Kiểm tra kết quả')}</button></p>}
  </section>;
}
