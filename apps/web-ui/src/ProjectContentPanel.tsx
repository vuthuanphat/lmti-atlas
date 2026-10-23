import {useEffect,useRef,useState,type FormEvent} from 'react';
import {contentCollections,type ContentCollection,type ContentPage,type ContentRecord} from '../../web-api/src/project-content-contract';
import type {StructureRequest} from './StructureView';

type Preview={id:string;projectId:string;collection:ContentCollection;revision:number;before:ContentRecord|null;after:ContentRecord|null;expiresAt:string;deviceActions:false};
type Result={operationId:string;outcome:'pending'|'committed'|'unknown';projectRevision?:number};
const labels:Record<string,[string,string]>={
  id:['ID','Mã định danh'],label:['Name','Tên'],goal:['Goal','Mục tiêu'],privacy:['Visibility','Phạm vi hiển thị'],
  locator:['Repository reference','Tham chiếu kho mã'],repositoryId:['Repository ID','Mã kho mã'],kind:['Type','Loại'],
  hardwareRevision:['Hardware revision','Phiên bản phần cứng'],architecture:['Architecture','Kiến trúc'],
  componentId:['Component ID','Mã thành phần'],targetId:['Hardware target ID','Mã phần cứng đích'],sourceRevision:['Source revision','Phiên bản nguồn'],
  state:['State','Trạng thái'],assetId:['Device / service ID','Mã thiết bị / dịch vụ'],releaseId:['Release ID','Mã phiên bản'],
  from:['From ID','Mã nguồn'],to:['To ID','Mã đích'],contract:['Declared contract','Hợp đồng khai báo'],
  evidence:['Evidence','Bằng chứng'],source:['Evidence source','Nguồn bằng chứng'],at:['Evidence time (UTC seconds)','Thời điểm bằng chứng (giây UTC)'],result:['Verification result','Kết quả kiểm chứng'],
  criteria:['Acceptance criteria','Tiêu chí nghiệm thu'],dueDate:['Due date','Ngày đến hạn'],accepted:['Accepted','Đã nghiệm thu'],
  milestoneId:['Milestone ID','Mã mốc công việc'],checklist:['Checklist','Danh sách kiểm tra'],reference:['Reference','Tham chiếu'],fingerprint:['Source fingerprint','Dấu vân tay nguồn'],
  site:['Site ID','Mã địa điểm'],enabled:['Desired enabled','Mong muốn bật'],pollMs:['Desired poll interval (ms)','Chu kỳ đọc mong muốn (ms)'],protocol:['Declared protocol','Giao thức khai báo'],
};
export function blankContentRecord(id:ContentCollection):ContentRecord{
  const definition=contentCollections.find(c=>c.id===id)!;const row:ContentRecord={};
  for(const field of definition.fields)row[field.id]=field.type==='boolean'?false:field.type==='number'?(field.id==='pollMs'?1000:0):'options'in field?field.options[0]:'';
  return row;
}
function checkPage(value:unknown,id:ContentCollection):ContentPage {
  const p=value as ContentPage;
  if(!p||p.collection!==id||!Number.isSafeInteger(p.revision)||p.revision<1||!Array.isArray(p.items)||p.items.length>100||
    !Number.isSafeInteger(p.total)||p.total<0||(p.nextOffset!==null&&(!Number.isSafeInteger(p.nextOffset)||p.nextOffset<=0)))throw Error('OWNER_UNAVAILABLE');
  return p;
}
export function ProjectContentPanel({project,language,request,disabled,onLockChange,onChanged,onRecovery,visible=true}:{
  project:string;language:'en'|'vi';request:StructureRequest;disabled:boolean;visible?:boolean;
  onLockChange:(locked:boolean)=>void;onChanged:()=>void;onRecovery:()=>void;
}){
  const t=(en:string,vi:string)=>language==='vi'?vi:en;
  const [category,setCategory]=useState<ContentCollection>('work'),[page,setPage]=useState<ContentPage|null>(null),[offset,setOffset]=useState(0);
  const [enabled,setEnabled]=useState<boolean|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [draft,setDraft]=useState<ContentRecord|null>(null),[operation,setOperation]=useState<'add'|'update'|'remove'>('add');
  const [preview,setPreview]=useState<Preview|null>(null),[job,setJob]=useState<string|null>(null),[unknown,setUnknown]=useState(false),[refresh,setRefresh]=useState(0);
  const current=useRef(project),attempt=useRef(false),mounted=useRef(true);current.current=project;
  const locked=busy||draft!==null||preview!==null||job!==null;
  const endpoint=`/api/v1/projects/${project}/content`;
  const definition=contentCollections.find(c=>c.id===category)!;
  useEffect(()=>{onLockChange(locked);return()=>onLockChange(false);},[locked,onLockChange]);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>{setOffset(0);setPage(null);setDraft(null);setPreview(null);setJob(null);setError('');setUnknown(false);setNotice('');},[project]);
  useEffect(()=>{
    if(!project||!visible)return;
    const controller=new AbortController(),captured=project;
    setError('');setBusy(true);
    (async()=>{
      const cap=await request(`${endpoint}/capabilities`,'GET',undefined,controller.signal) as {enabled:boolean};
      if(typeof cap.enabled!=='boolean')throw Error('OWNER_UNAVAILABLE');
      if(controller.signal.aborted||current.current!==captured)return;setEnabled(cap.enabled);
      if(!cap.enabled){setPage(null);return;}
      const value=checkPage(await request(`${endpoint}/read`,'POST',{collection:category,offset,limit:50},controller.signal),category);
      if(!controller.signal.aborted&&current.current===captured)setPage(value);
      const status=await request('/api/v1/write-status','GET',undefined,controller.signal) as {admitted:boolean;recoveryRequired:boolean};
      if(!controller.signal.aborted&&current.current===captured&&status.admitted===true&&status.recoveryRequired===false)setUnknown(false);
    })().catch(e=>{if(!controller.signal.aborted&&current.current===captured){setPage(null);setError(String((e as {code?:string}).code||'OWNER_UNAVAILABLE'));}})
      .finally(()=>{if(!controller.signal.aborted&&current.current===captured)setBusy(false);});
    return()=>controller.abort();
  },[project,category,offset,refresh,visible,request]);
  function fail(e:unknown,writing=false){
    if(!mounted.current)return;
    const code=(e as {code?:string}).code||'NETWORK';setError(code);setPreview(null);setDraft(null);
    if(writing&&['NETWORK','RECOVERY_REQUIRED'].includes(code))setUnknown(true);
  }
  async function exclusive(action:()=>Promise<void>,writing=false){
    if(attempt.current||disabled)return;attempt.current=true;setBusy(true);setError('');setNotice('');
    try{await action();}catch(e){fail(e,writing);}finally{attempt.current=false;if(mounted.current)setBusy(false);}
  }
  function edit(row:ContentRecord|null,op:'add'|'update'|'remove'){
    if(disabled||locked||!page)return;setOperation(op);setDraft(row?{...row}:blankContentRecord(category));setError('');setNotice('');
  }
  async function review(event:FormEvent){event.preventDefault();if(!draft||!page)return;
    await exclusive(async()=>{
      const value=await request(`${endpoint}/previews`,'POST',{collection:category,operation,expectedRevision:page.revision,
        record:operation==='remove'?{id:draft.id}:draft}) as Preview;
      if(value.projectId!==project||value.collection!==category||typeof value.id!=='string'||!Number.isFinite(Date.parse(value.expiresAt))||value.deviceActions!==false)throw Error('OWNER_UNAVAILABLE');
      setPreview(value);setDraft(null);
    });
  }
  function confirmed(result:Result){
    if(result.outcome==='pending'){setJob(result.operationId);return;}
    if(result.outcome==='unknown'){setUnknown(true);setJob(null);return;}
    if(result.outcome!=='committed'||!Number.isSafeInteger(result.projectRevision))throw Error('OWNER_UNAVAILABLE');
    setJob(null);setNotice('saved');setOffset(0);setRefresh(v=>v+1);onChanged();
  }
  if(!project)return <p className="notice">{t('Choose a project to manage its content.','Chọn dự án để quản lý nội dung.')}</p>;
  return <section className="section" aria-labelledby="project-content-title" aria-busy={busy}>
    <div className="section-heading"><div><h2 id="project-content-title">{t('Project content','Nội dung dự án')}</h2>
      <p>{t('Manage declared software, hardware, releases, work and evidence. Review every change before saving.','Quản lý phần mềm, phần cứng, phiên bản, công việc và bằng chứng khai báo. Duyệt từng thay đổi trước khi lưu.')}</p></div>
      <button disabled={disabled||locked} onClick={()=>setRefresh(v=>v+1)}>{t('Refresh','Tải lại')}</button></div>
    <p className="muted">{t('Nonsecret metadata only. These changes do not deploy software or control devices.','Chỉ lưu metadata không chứa bí mật. Các thay đổi không triển khai phần mềm hay điều khiển thiết bị.')}</p>
    {error&&<p className="notice error-notice" role="alert">{error==='REVISION_CONFLICT'||error==='CONFIG_CHANGED'?t('Project changed. Refresh and create a new review.','Dự án đã thay đổi. Tải lại và tạo lượt duyệt mới.'):t('The owner refused this change or is unavailable. Check required fields, references and immutable records, then refresh.','Owner từ chối thay đổi hoặc chưa sẵn sàng. Kiểm tra trường bắt buộc, tham chiếu và bản ghi bất biến rồi tải lại.')} <code>{error}</code></p>}
    {notice&&<p className="notice success" role="status">{t('Saved. Current owner state is loaded below.','Đã lưu. Trạng thái hiện tại được tải lại bên dưới.')}</p>}
    {unknown&&<p className="notice" role="alert">{t('The write outcome is unknown. Do not repeat it. Inspect recovery in Work before another change.','Chưa xác định kết quả ghi. Không gửi lại. Kiểm tra phục hồi trong Công việc trước khi thay đổi tiếp.')} <button onClick={onRecovery}>{t('Inspect recovery','Kiểm tra phục hồi')}</button></p>}
    {enabled===false?<p className="notice">{t('Content editing was not granted to this session. Relaunch with ProjectContent and explicit ContentProjectId values for the projects you intend to edit.','Phiên này chưa được cấp quyền sửa nội dung. Mở lại launcher với ProjectContent và ContentProjectId tường minh cho các dự án cần sửa.')}</p>:<>
      <label>{t('Category','Danh mục')} <select value={category} disabled={disabled||locked||enabled!==true} onChange={e=>{setCategory(e.target.value as ContentCollection);setOffset(0);setPage(null);}}>
        {contentCollections.map(c=><option key={c.id} value={c.id}>{language==='vi'?c.vi:c.label}</option>)}
      </select></label>
      {page&&<><p className="muted">{t('Project revision','Phiên bản dự án')} {page.revision} · {page.total} {t('records','bản ghi')}</p>
        {category!=='project'&&<button className="primary" disabled={disabled||locked||unknown} onClick={()=>edit(null,'add')}>{t('Add record','Thêm bản ghi')}</button>}
        {!page.items.length&&<p>{t('No records in this category.','Danh mục chưa có bản ghi.')}</p>}
        <div className="table-scroll"><table><thead><tr><th>{t('ID','Mã')}</th><th>{t('Name / reference','Tên / tham chiếu')}</th><th>{t('Actions','Thao tác')}</th></tr></thead>
          <tbody>{page.items.map(row=><tr key={String(row.id)}><td><code>{String(row.id)}</code></td><td>{String(row.label??row.componentId??row.assetId??row.from??'')}</td><td>
            <button disabled={disabled||locked||unknown} onClick={()=>edit(row,'update')}>{t('Edit','Sửa')}</button>
            {category!=='project'&&<button disabled={disabled||locked||unknown} onClick={()=>edit(row,'remove')}>{t('Remove','Gỡ')}</button>}
          </td></tr>)}</tbody></table></div>
        <button disabled={disabled||locked||offset===0} onClick={()=>setOffset(Math.max(0,offset-50))}>{t('Previous','Trang trước')}</button>
        <button disabled={disabled||locked||page.nextOffset===null} onClick={()=>setOffset(page.nextOffset!)}>{t('Next','Trang sau')}</button>
      </>}
    </>}
    {draft&&<form onSubmit={review}><h3>{operation==='remove'?t('Review removal','Duyệt gỡ bản ghi'):t('Edit record','Chỉnh sửa bản ghi')}</h3>
      {operation==='remove'?<p>{t('Remove this metadata record? Referenced or immutable records cannot be removed. Source files are preserved.','Gỡ bản ghi metadata này? Bản ghi đang được tham chiếu hoặc bất biến không thể gỡ. File nguồn được giữ nguyên.')} <code>{String(draft.id)}</code></p>:
        definition.fields.map(field=><label key={field.id}>{labels[field.id]?.[language==='vi'?1:0]??field.id}
          {field.type==='boolean'?<input type="checkbox" checked={draft[field.id]===true} disabled={busy} onChange={e=>setDraft({...draft,[field.id]:e.target.checked})}/>:
            'options'in field?<select value={String(draft[field.id])} disabled={busy} onChange={e=>setDraft({...draft,[field.id]:e.target.value})}>{field.options.map(v=><option key={v} value={v}>{v}</option>)}</select>:
            <input type={field.type==='number'?'number':'text'} value={String(draft[field.id]??'')} disabled={busy||(field.id==='id'&&operation==='update')}
              required={field.id==='id'||field.id==='label'} min={field.type==='number'?0:undefined} step={field.type==='number'?1:undefined}
              maxLength={field.type==='text'?8192:undefined} onChange={e=>setDraft({...draft,[field.id]:field.type==='number'?Number(e.target.value):e.target.value})}/>}
        </label>)}
      <div className="dialog-footer"><button type="button" disabled={busy} onClick={()=>setDraft(null)}>{t('Cancel','Hủy')}</button><button className="primary" disabled={busy||disabled} type="submit">{t('Review changes','Xem trước thay đổi')}</button></div>
    </form>}
    {preview&&<div className="soft-panel" role="region" aria-label={t('Review changes','Xem trước thay đổi')}><h3>{t('Review changes','Xem trước thay đổi')}</h3>
      <p>{t('Before','Trước')}</p><dl>{Object.entries(preview.before??{}).map(([k,v])=><div key={k}><dt>{labels[k]?.[language==='vi'?1:0]??k}</dt><dd>{String(v)}</dd></div>)}</dl>
      <p>{t('After','Sau')}</p><dl>{Object.entries(preview.after??{}).map(([k,v])=><div key={k}><dt>{labels[k]?.[language==='vi'?1:0]??k}</dt><dd>{String(v)}</dd></div>)}</dl>
      {!preview.after&&<p>{t('This record will be removed.','Bản ghi sẽ được gỡ.')}</p>}
      <p>{t('Review expires at','Lượt duyệt hết hạn lúc')} {new Date(preview.expiresAt).toLocaleTimeString(language==='vi'?'vi-VN':'en-GB')}</p>
      <button disabled={busy} onClick={()=>exclusive(async()=>{await request(`${endpoint}/previews/${preview.id}`,'DELETE');setPreview(null);})}>{t('Reject changes','Từ chối thay đổi')}</button>
      <button className="primary" disabled={busy||disabled||Date.parse(preview.expiresAt)<=Date.now()} onClick={()=>exclusive(async()=>{const id=preview.id;setPreview(null);confirmed(await request(`${endpoint}/commit`,'POST',{previewId:id}) as Result);},true)}>{t('Confirm and save','Xác nhận và lưu')}</button>
    </div>}
    {job&&<p className="notice" role="status">{t('The owner is completing the write. Inspect its result; do not submit again.','Owner đang hoàn tất thao tác ghi. Kiểm tra kết quả; không gửi lại.')} <button disabled={busy} onClick={()=>exclusive(async()=>{
      const value=await request(`/api/v1/operations/${job}`,'GET') as {state:string;result:Result|null;errorCode:string|null};
      if(value.state==='pending')return;if(value.result)confirmed(value.result);else{setJob(null);throw Object.assign(Error('Operation refused'),{code:value.errorCode||'OWNER_UNAVAILABLE'});}
    },true)}>{t('Check operation status','Kiểm tra kết quả')}</button></p>}
  </section>;
}
