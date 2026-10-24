import {useEffect,useId,useRef,useState,type FormEvent} from 'react';
import type {request as apiRequest} from './api';
import type {Language} from './i18n';
import {Icon} from './Icon';
import {
  addHierarchyChange,checkedHierarchyJob,checkedHierarchyPreview,checkedHierarchyRejection,
  checkedHierarchyResult,checkedHierarchyScopes,checkedHierarchyState,checkedHierarchyWriteStatus,
  changeKey,hierarchyErrorCode,hierarchyKinds,hierarchyProposal,hierarchyShouldPoll,HierarchyCommitGate,HierarchyReadFence,makeHierarchyChange,
  type Change,type Diff,type Grant,type Kind,type Preview,type State,type Submission,type Subsystem,type WriteStatus,
} from './logical-hierarchy-ui';
import './LogicalHierarchyPanel.css';

export interface LogicalHierarchyPanelProps{
  project:string;language:Language;request:typeof apiRequest;refreshKey:number;disabled?:boolean;
  onLockChange:(locked:boolean)=>void;onChanged:()=>void;onRecovery?:()=>void;
}
type Translate=(en:string,vi:string)=>string;
const labels:Record<Kind,readonly [string,string]>={
  add_subsystem:['Add subsystem','Thêm phân hệ'],
  rename_subsystem:['Rename subsystem','Đổi tên phân hệ'],
  reparent_subsystem:['Move subsystem','Chuyển phân hệ'],
  set_component_membership:['Assign component','Gán thành phần'],
  retire_empty_subsystem:['Retire empty subsystem','Ngừng dùng phân hệ rỗng'],
};
const base=(project:string)=>`/api/v1/projects/${encodeURIComponent(project)}/logical-hierarchy`;
export function hierarchyMessage(code:string,t:Translate):string{
  switch(code){
    case 'SCOPE_DENIED':return t('This view or change is outside the granted scope.','Phạm vi được cấp không cho phép xem hoặc thay đổi này.');
    case 'NOT_SUPPORTED':return t('Logical hierarchy editing is not enabled for this launch.','Phiên khởi chạy này chưa bật chỉnh sửa phân cấp logic.');
    case 'LIMIT_EXCEEDED':return t('The complete state or review exceeds the supported limit. No partial edit is available.','Trạng thái hoặc bản xem xét đầy đủ vượt giới hạn. Không thể chỉnh sửa dữ liệu một phần.');
    case 'INVALID_INPUT':return t('Check the fields, original values and final batch structure. Each target can appear once.','Kiểm tra trường nhập, giá trị gốc và cấu trúc cuối của lô. Mỗi đối tượng chỉ xuất hiện một lần.');
    case 'REVISION_CONFLICT':case 'CONFIG_CHANGED':return t('The project or its binding changed. Load the current state and create a new review.','Dự án hoặc liên kết đã thay đổi. Hãy tải trạng thái hiện tại và tạo bản xem xét mới.');
    case 'PREVIEW_EXPIRED':return t('This review expired. Create a new review before confirming.','Bản xem xét đã hết hạn. Hãy tạo bản mới trước khi xác nhận.');
    case 'RECOVERY_REQUIRED':return t('Review the affected scope in Work before another change. The previous outcome remains unconfirmed.','Hãy xem lại phạm vi bị ảnh hưởng ở Công việc trước khi thay đổi tiếp. Kết quả trước đó vẫn chưa xác định.');
    case 'BUSY':return t('Another operation is still using this scope. Check its status before a new review.','Một thao tác khác đang dùng phạm vi này. Kiểm tra trạng thái trước khi xem xét mới.');
    case 'SESSION_EXPIRED':case 'UNAUTHENTICATED':return t('The session ended. A submitted operation must not be repeated; use a new session to inspect recovery.','Phiên đã kết thúc. Không gửi lại thao tác đã nộp; dùng phiên mới để kiểm tra khôi phục.');
    case 'INVALID_SOURCE_RESPONSE':return t('The complete response could not be verified. No partial review is accepted.','Không xác minh được phản hồi đầy đủ. Không chấp nhận bản xem xét một phần.');
    default:return t('The local owner could not be reached or its response could not be verified.','Không kết nối được chủ sở hữu cục bộ hoặc không xác minh được phản hồi.');
  }
}
function Classification({value,t}:{value:'public'|'internal'|null;t:Translate}){
  return <span>{value===null?t('Absent','Không tồn tại'):value==='public'?t('Public','Công khai'):t('Internal','Nội bộ')}</span>;
}
function SubsystemValue({value,t}:{value:Subsystem|null;t:Translate}){
  return value===null?<span>{t('Absent','Không tồn tại')}</span>:<dl className="hierarchy-values">
    <dt>{t('Name','Tên')}</dt><dd>{value.label}</dd>
    <dt>{t('ID','ID')}</dt><dd>{value.id}</dd>
    <dt>{t('Parent','Phân hệ cha')}</dt><dd>{value.parentSubsystemId||t('Project root','Gốc dự án')}</dd>
    <dt>{t('Stored classification','Phân loại đã lưu')}</dt><dd><Classification value={value.privacy} t={t}/></dd>
  </dl>;
}
/** Exported presentation for SSR accessibility/complete-diff regression checks. */
export function HierarchyDiffView({diff,language}:{diff:Diff;language:Language}){
  const t:Translate=(en,vi)=>language==='vi'?vi:en;
  return <div className="hierarchy-diff">
    <h4>{t('Subsystem changes','Thay đổi phân hệ')}</h4>
    {diff.subsystems.length===0?<p>{t('No subsystem row changes.','Không thay đổi dòng phân hệ.')}</p>:
      <ul>{diff.subsystems.map(row=><li key={row.id}><h5>{row.id}</h5><div className="hierarchy-before-after">
        <section><h6>{t('Before','Trước')}</h6><SubsystemValue value={row.before} t={t}/></section>
        <section><h6>{t('After','Sau')}</h6><SubsystemValue value={row.after} t={t}/></section>
      </div></li>)}</ul>}
    <h4>{t('Component membership changes','Thay đổi phân hệ của thành phần')}</h4>
    {diff.memberships.length===0?<p>{t('No membership changes.','Không thay đổi thành viên.')}</p>:
      <ul>{diff.memberships.map(row=><li key={row.componentId}><strong>{row.componentId}</strong>
        <p>{t('Before','Trước')}: {row.before?.subsystemId??t('Unassigned','Chưa gán')}</p>
        <p>{t('After','Sau')}: {row.after?.subsystemId??t('Unassigned','Chưa gán')}</p></li>)}</ul>}
    <h4>{t('All affected identities and inherited paths','Tất cả đối tượng bị ảnh hưởng và đường dẫn kế thừa')}</h4>
    <p>{t('This includes descendants whose own stored row does not change.','Bao gồm đối tượng con có dòng dữ liệu đã lưu không thay đổi.')}</p>
    <ul>{diff.affected.map(row=><li key={`${row.kind}:${row.id}`}><strong>{row.kind==='subsystem'?t('Subsystem','Phân hệ'):t('Component','Thành phần')}: {row.id}</strong>
      <p>{t('Before','Trước')}: <Classification value={row.beforeClassification} t={t}/> — {row.beforeAncestors.join(' / ')||t('Project root','Gốc dự án')}</p>
      <p>{t('After','Sau')}: <Classification value={row.afterClassification} t={t}/> — {row.afterAncestors.join(' / ')||t('Project root','Gốc dự án')}</p>
    </li>)}</ul>
  </div>;
}
export function HierarchyStateView({state,language}:{state:State;language:Language}){
  const t:Translate=(en,vi)=>language==='vi'?vi:en;
  const filterId=useId();
  const [filter,setFilter]=useState({project:state.projectId,value:''});
  const [selection,setSelection]=useState<{project:string;kind:'subsystem'|'component';id:string}|null>(null);
  const query=filter.project===state.projectId?filter.value:'';
  const rows:{kind:'subsystem'|'component';id:string;label:string;depth:number}[]=[];
  const visibleIds=new Set(state.subsystems.map(row=>row.value.id)), visited=new Set<string>();
  const appendComponents=(parent:string,depth:number)=>state.components.filter(row=>(row.membership?.subsystemId??'')===parent).forEach(row=>rows.push({kind:'component',id:row.value.id,label:row.value.label,depth}));
  function appendSubsystem(id:string,depth:number){
    if(visited.has(id))return;
    const row=state.subsystems.find(item=>item.value.id===id);
    if(!row)return;
    visited.add(id);rows.push({kind:'subsystem',id,label:row.value.label,depth});
    state.subsystems.filter(item=>item.value.parentSubsystemId===id).forEach(item=>appendSubsystem(item.value.id,depth+1));
    appendComponents(id,depth+1);
  }
  state.subsystems.filter(row=>!visibleIds.has(row.value.parentSubsystemId)).forEach(row=>appendSubsystem(row.value.id,0));
  // Only owner-visible identities are displayed, including a bounded defensive fallback.
  state.subsystems.forEach(row=>appendSubsystem(row.value.id,0));
  state.components.filter(row=>!row.membership||!visibleIds.has(row.membership.subsystemId)).forEach(row=>rows.push({kind:'component',id:row.value.id,label:row.value.label,depth:0}));
  const current=rows.find(row=>selection?.project===state.projectId&&selection.kind===row.kind&&selection.id===row.id)??rows[0];
  const subsystem=current?.kind==='subsystem'?state.subsystems.find(row=>row.value.id===current.id):undefined;
  const component=current?.kind==='component'?state.components.find(row=>row.value.id===current.id):undefined;
  const visible=rows.filter(row=>`${row.label} ${row.id}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return <div className="hierarchy-state hierarchy-explorer">
    <div className="hierarchy-explorer-header"><span>{t('Declared structure','Cấu trúc khai báo')}</span><span className="pill neutral">r{state.revision}</span></div>
    <p className="hierarchy-boundary">{t('Project declarations only. Running device state is not established.','Chỉ hiển thị khai báo dự án. Chưa xác minh trạng thái vận hành thiết bị.')}</p>
    <div className="hierarchy-explorer-grid">
      <nav className="hierarchy-browser" aria-label={t('Visible logical hierarchy','Phân cấp logic được phép xem')}>
        <label htmlFor={filterId}>{t('Find in the authorized view','Tìm trong phạm vi được phép')}</label>
        <input id={filterId} type="search" maxLength={120} value={query} onChange={event=>setFilter({project:state.projectId,value:event.target.value})}/>
        <ul>{visible.map(row=><li key={`${row.kind}:${row.id}`}><button type="button" aria-pressed={current?.id===row.id&&current.kind===row.kind} onClick={()=>setSelection({project:state.projectId,kind:row.kind,id:row.id})} style={{paddingInlineStart:12+Math.min(row.depth,4)*12}}><strong>{row.label}</strong><span>{row.kind==='subsystem'?t('Subsystem','Phân hệ'):t('Component','Thành phần')}</span></button></li>)}</ul>
        {!visible.length&&<p className="hierarchy-boundary">{query?t('No matching visible identities.','Không có đối tượng hiển thị phù hợp.'):t('No visible hierarchy entries.','Chưa có đối tượng phân cấp hiển thị.')}</p>}
      </nav>
      <section className="hierarchy-inspector" aria-label={t('Selected identity details','Chi tiết đối tượng đã chọn')}>
        {current?<><p className="eyebrow">{current.kind==='subsystem'?t('Subsystem','Phân hệ'):t('Component','Thành phần')}</p><h3>{current.label}</h3><code>{current.id}</code>
          {subsystem&&<><SubsystemValue value={subsystem.value} t={t}/><p>{t('Effective classification','Phân loại hiệu lực')}: <Classification value={subsystem.classification} t={t}/></p></>}
          {component&&<dl className="hierarchy-values"><dt>{t('Subsystem','Phân hệ')}</dt><dd>{state.subsystems.find(row=>row.value.id===component.membership?.subsystemId)?.value.label??component.membership?.subsystemId??t('Unassigned','Chưa gán')}</dd><dt>{t('Stored','Đã lưu')}</dt><dd><Classification value={component.value.privacy} t={t}/></dd><dt>{t('Effective','Hiệu lực')}</dt><dd><Classification value={component.classification} t={t}/></dd></dl>}
          <p className="hierarchy-boundary">{t('Changes are prepared in the draft editor and reviewed before saving.','Thay đổi được soạn trong bản nháp và xem trước trước khi lưu.')}</p>
        </>:<p>{t('Select an identity to inspect its saved declaration.','Chọn đối tượng để xem khai báo đã lưu.')}</p>}
      </section>
    </div>
    <details className="hierarchy-complete"><summary>{t('Complete authorized details','Toàn bộ chi tiết được phép xem')}</summary><HierarchyDetailsView state={state} language={language}/></details>
  </div>;
}
function HierarchyDetailsView({state,language}:{state:State;language:Language}){
  const t:Translate=(en,vi)=>language==='vi'?vi:en;
  return <div className="hierarchy-state">
    <p>{t('Project revision','Phiên bản dự án')}: <strong>{state.revision}</strong></p>
    <p>{t('This is the complete authorized view. Hidden rows are not counted or inferred.','Đây là toàn bộ phần được phép xem. Các dòng ẩn không được đếm hoặc suy đoán.')}</p>
    <details><summary>{t('Subsystems','Phân hệ')} ({state.subsystems.length})</summary>
      {state.subsystems.length===0?<p>{t('No visible subsystems.','Không có phân hệ hiển thị.')}</p>:<ul>
        {state.subsystems.map(row=><li key={row.value.id}><strong>{row.value.label}</strong> ({row.value.id})
          <p>{t('Path','Đường dẫn')}: {[...row.ancestors,row.value.id].join(' / ')}</p>
          <p>{t('Stored','Đã lưu')}: <Classification value={row.value.privacy} t={t}/>; {t('Effective','Hiệu lực')}: <Classification value={row.classification} t={t}/></p>
        </li>)}</ul>}
    </details>
    <details><summary>{t('Components','Thành phần')} ({state.components.length})</summary>
      {state.components.length===0?<p>{t('No visible components.','Không có thành phần hiển thị.')}</p>:<ul>
        {state.components.map(row=><li key={row.value.id}><strong>{row.value.label}</strong> ({row.value.id})
          <p>{t('Subsystem','Phân hệ')}: {row.membership?.subsystemId??t('Unassigned','Chưa gán')}</p>
          <p>{t('Stored','Đã lưu')}: <Classification value={row.value.privacy} t={t}/>; {t('Effective','Hiệu lực')}: <Classification value={row.classification} t={t}/></p>
        </li>)}</ul>}
    </details>
  </div>;
}
export function LogicalHierarchyPanel({project,language,request,refreshKey,disabled=false,onLockChange,onChanged,onRecovery}:LogicalHierarchyPanelProps){
  const t:Translate=(en,vi)=>language==='vi'?vi:en;
  const uid=useId(),mounted=useRef(true),generation=useRef(new HierarchyReadFence()),readAbort=useRef<AbortController|null>(null),
    busyRef=useRef(false),writingRef=useRef(false),gate=useRef(new HierarchyCommitGate()),previewRef=useRef<Preview|null>(null),
    currentProject=useRef(project),refreshSeen=useRef(''),pollAttempts=useRef(0),callbacks=useRef({onLockChange,onChanged,onRecovery}),
    currentSelection=useRef(''),
    reviewHeading=useRef<HTMLHeadingElement|null>(null),errorHeading=useRef<HTMLDivElement|null>(null),
    reviewButton=useRef<HTMLButtonElement|null>(null);
  callbacks.current={onLockChange,onChanged,onRecovery};
  currentSelection.current=`${project}\n${refreshKey}`;
  const [state,setState]=useState<State|null>(null),[grant,setGrant]=useState<Grant|null>(null),[scopeLoaded,setScopeLoaded]=useState(false),
    [write,setWrite]=useState<WriteStatus|null>(null),[changes,setChanges]=useState<readonly Change[]>([]),
    [preview,setPreview]=useState<Preview|null>(null),[submission,setSubmission]=useState<Submission|null>(null),
    [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),
    [priorUnknown,setPriorUnknown]=useState(false),[now,setNow]=useState(Date.now()),
    [kind,setKind]=useState<Kind>('add_subsystem'),[target,setTarget]=useState(''),[label,setLabel]=useState(''),[parent,setParent]=useState('');
  function setReview(value:Preview|null){previewRef.current=value;setPreview(value);}
  function invalidateRead(){generation.current.invalidate();readAbort.current?.abort();readAbort.current=null;}
  function finishBusy(){busyRef.current=false;if(mounted.current)setBusy(false);}
  function startBusy(){if(busyRef.current)return false;busyRef.current=true;setBusy(true);setError('');return true;}
  function publish(value:Submission){
    callbacks.current.onLockChange(value.locked);
    if(mounted.current){setSubmission({...value});if(value.phase==='unknown'){setPriorUnknown(true);setWrite(null);}}
  }
  function changed(){try{callbacks.current.onChanged();}catch{/* A refresh failure does not change a confirmed write. */}}
  async function readTask(work:(signal:AbortSignal,accept:(action:()=>void)=>void)=>Promise<void>){
    if(!startBusy())return;
    invalidateRead();const ticket=generation.current.begin(currentSelection.current),abort=new AbortController();readAbort.current=abort;
    const accept=(action:()=>void)=>{if(generation.current.accepts(ticket,currentSelection.current,mounted.current)&&!abort.signal.aborted)action();};
    try{await work(abort.signal,accept);}catch(e){accept(()=>setError(hierarchyErrorCode(e)));}
    finally{if(generation.current.current(ticket))finishBusy();}
  }
  async function refresh(){
    if(gate.current.current?.locked)return;
    const selected=currentProject.current;
    await readTask(async(signal,accept)=>{
      accept(()=>{setState(null);setGrant(null);setScopeLoaded(false);setChanges([]);setReview(null);setWrite(null);});
      const grants=checkedHierarchyScopes(await request('/api/v1/logical-hierarchy-scopes','GET',undefined,signal)),
        selectedGrant=grants.find(g=>g.projectId===selected)??null;
      accept(()=>{
        setGrant(selectedGrant);setScopeLoaded(true);
        if(selectedGrant&&!selectedGrant.allowInternal)setKind(value=>value==='add_subsystem'?'rename_subsystem':value);
      });
      const status=checkedHierarchyWriteStatus(await request('/api/v1/write-status','GET',undefined,signal));
      accept(()=>setWrite(status));
      if(!selectedGrant)return;
      const next=checkedHierarchyState(await request(base(selected),'GET',undefined,signal),selectedGrant);
      accept(()=>setState(next));
    });
  }
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;invalidateRead();};},[]);
  useEffect(()=>{
    const next=`${project}\n${refreshKey}`;
    if(gate.current.current?.locked||writingRef.current||refreshSeen.current===next)return;
    invalidateRead();busyRef.current=false;setBusy(false);
    refreshSeen.current=next;currentProject.current=project;
    setTarget('');setLabel('');setParent('');setNotice('');
    void refresh();
  },[project,refreshKey,busy,submission?.locked]);
  useEffect(()=>{if(!preview)return;reviewHeading.current?.focus();const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[preview]);
  useEffect(()=>{if(error)errorHeading.current?.focus();},[error]);
  const locked=!!submission?.locked,blocked=disabled||busy||locked||!state||state.projectId!==project||!grant||!write||!write.admitted||write.recoveryRequired;
  const parentOptions=[...(state?.subsystems.map(r=>r.value)??[]),
    ...changes.flatMap(c=>c.kind==='add_subsystem'?[c.desired]:[])].filter((row,index,all)=>all.findIndex(r=>r.id===row.id)===index).sort((a,b)=>a.id<b.id?-1:1);
  function resetForm(next:Kind){
    setKind(next);setTarget('');setLabel('');setParent('');
  }
  function selectTarget(value:string){
    setTarget(value);const row=state?.subsystems.find(r=>r.value.id===value);
    setLabel(row?.value.label??'');setParent(kind==='set_component_membership'?
      state?.components.find(r=>r.value.id===value)?.membership?.subsystemId??'':row?.value.parentSubsystemId??'');
  }
  function addDraft(event:FormEvent){
    event.preventDefault();if(blocked||!state||!grant||previewRef.current)return;
    try{
      const change=makeHierarchyChange(state,grant,{kind,targetId:target,label,parentId:parent});
      setChanges(addHierarchyChange(changes,change));setError('');setNotice('');resetForm(kind);
    }catch(e){setError(hierarchyErrorCode(e));}
  }
  async function review(){
    if(blocked||!state||!grant||previewRef.current)return;
    const snapshot=state,authority=grant;
    let proposal;try{proposal=hierarchyProposal(snapshot,authority,changes);}catch(e){setError(hierarchyErrorCode(e));return;}
    await readTask(async(signal,accept)=>{
      const value=checkedHierarchyPreview(await request(`${base(snapshot.projectId)}/previews`,'POST',{proposal},signal),snapshot,authority,proposal);
      accept(()=>{setNow(Date.now());setReview(value);setNotice('');});
    });
  }
  async function reject(){
    const value=previewRef.current;if(!value||busyRef.current||gate.current.current?.locked)return;
    setReview(null);
    await readTask(async(signal,accept)=>{
      checkedHierarchyRejection(await request(`${base(value.projectId)}/previews/${value.id}`,'DELETE',undefined,signal));
      accept(()=>setNotice('rejected'));
    });
    reviewButton.current?.focus();
  }
  function acceptResult(value:unknown){
    const original=gate.current.current;if(!original)return;
    const result=checkedHierarchyResult(value,original.project,original.revision,original.result?.operationId);
    const previous=original.phase;publish(gate.current.observe(result));
    if(result.outcome==='confirmed'&&previous!=='confirmed'){
      setState(null);setChanges([]);setWrite(null);changed();
    }
  }
  async function confirm(){
    const value=previewRef.current;if(!value||value.projectId!==project||refreshSeen.current!==currentSelection.current||
      disabled||busyRef.current||gate.current.current?.locked||!write?.admitted||write.recoveryRequired)return;
    let body;try{body=gate.current.begin(value,Date.now());}catch(e){setError(hierarchyErrorCode(e));return;}
    // Both refs change before await; a double event cannot submit the old token.
    setReview(null);setWrite(null);invalidateRead();pollAttempts.current=0;writingRef.current=true;busyRef.current=true;setBusy(true);setError('');setNotice('');publish(gate.current.current!);
    try{
      const result=await request(`${base(value.projectId)}/commits`,'POST',body);
      if(mounted.current)acceptResult(result);
      else{
        const checked=checkedHierarchyResult(result,value.projectId,value.revision);
        const terminal=gate.current.observe(checked);callbacks.current.onLockChange(terminal.locked);
      }
    }catch(e){
      publish(gate.current.uncertain());if(mounted.current)setError(hierarchyErrorCode(e));
    }finally{
      writingRef.current=false;finishBusy();
      if(mounted.current&&!gate.current.current?.locked)void refresh();
    }
  }
  async function checkJob(){
    const s=gate.current.current,key=s?.result?.operationId;
    if(!s||!key||!['pending','unknown'].includes(s.phase))return;
    pollAttempts.current++;
    await readTask(async(signal,accept)=>{
      try{
        const job=checkedHierarchyJob(await request(`/api/v1/operations/${key}`,'GET',undefined,signal),s.project,s.revision,key);
        accept(()=>{if(job.result)acceptResult(job.result);});
      }catch(e){
        accept(()=>{publish(gate.current.uncertain());setError(hierarchyErrorCode(e));});
      }
    });
    if(mounted.current&&!gate.current.current?.locked)void refresh();
  }
  useEffect(()=>{
    if(!hierarchyShouldPoll(submission,pollAttempts.current,busy))return;
    const timer=setTimeout(()=>void checkJob(),1500);return()=>clearTimeout(timer);
  },[submission?.phase,submission?.result?.operationId,busy]);
  async function inspectWriteStatus(){
    const original=gate.current.current;if(!original||original.phase!=='unknown')return;
    await readTask(async(signal,accept)=>{
      const status=checkedHierarchyWriteStatus(await request('/api/v1/write-status','GET',undefined,signal));
      accept(()=>{gate.current.observeWriteStatus(status,original);setWrite(status);});
    });
  }
  function endLocalUnknown(){
    if(!write||busyRef.current)return;
    try{publish(gate.current.endUnknown());setState(null);setChanges([]);setReview(null);setNotice('unknown_retained');}
    catch(e){setError(hierarchyErrorCode(e));}
  }
  const title=t('Logical hierarchy','Phân cấp logic'),working=t('Working…','Đang xử lý…');
  return <section className="logical-hierarchy-panel" aria-labelledby={`${uid}-heading`} aria-busy={busy}>
    <header><h2 id={`${uid}-heading`}><Icon name="architecture" /> {title}</h2>
      <button type="button" disabled={busy||locked} onClick={()=>void refresh()}>{busy?working:t('Load current hierarchy','Tải phân cấp hiện tại')}</button>
    </header>
    <p>{t('Review native project changes before one explicit confirmation.','Xem xét thay đổi dự án gốc trước khi xác nhận một lần.')}</p>
    <div role="status" aria-live="polite" className="hierarchy-status">
      {notice==='rejected'&&t('Review rejected. No hierarchy change was submitted.','Đã từ chối bản xem xét. Chưa gửi thay đổi phân cấp.')}
      {notice==='unknown_retained'&&t('Local waiting ended. The prior outcome is still unconfirmed; use Work to review recovery.','Đã kết thúc chờ cục bộ. Kết quả trước đó vẫn chưa xác định; mở Công việc để xem xét khôi phục.')}
      {busy&&working}
    </div>
    {error&&<div ref={errorHeading} tabIndex={-1} role="alert" className="hierarchy-error">{hierarchyMessage(error,t)}</div>}
    {priorUnknown&&<p className="soft-panel">{t('An earlier submitted outcome remains unconfirmed. New reads do not establish whether it happened.','Một thao tác đã gửi trước đó vẫn chưa xác định kết quả. Việc đọc mới không chứng minh thao tác đó có xảy ra hay không.')}</p>}
    {submission&&<section className="hierarchy-submission" aria-label={t('Submitted operation','Thao tác đã gửi')}>
      <h3>{submission.phase==='confirmed'?t('Change confirmed','Đã xác nhận thay đổi'):submission.phase==='refused'?t('Change refused','Thay đổi bị từ chối'):
        submission.phase==='unknown'?t('Outcome unconfirmed','Chưa xác định kết quả'):t('Operation in progress','Thao tác đang xử lý')}</h3>
      <p>{t('Project','Dự án')}: {submission.project}; {t('Reviewed revision','Phiên bản đã xem xét')}: {submission.revision}</p>
      {submission.result?.summary&&<p>{t('Saved revision','Phiên bản đã lưu')}: {submission.result.summary.revision}</p>}
      {submission.phase==='confirmed'&&submission.result?.summary===null&&<p>{t('The owner confirmed the write; detailed readback is unavailable. A fresh read or recovery may still be required.','Chủ sở hữu đã xác nhận ghi; chưa có chi tiết đọc lại. Có thể vẫn cần đọc mới hoặc khôi phục.')}</p>}
      {submission.result?.code&&<p>{hierarchyMessage(submission.result.code,t)}</p>}
      {submission.result?.operationId&&['pending','unknown'].includes(submission.phase)&&
        <button type="button" disabled={busy} onClick={()=>void checkJob()}>{t('Check submitted operation','Kiểm tra thao tác đã gửi')}</button>}
      {submission.phase==='pending'&&pollAttempts.current>=40&&<p>{t('Automatic status checks paused. Check manually; the submitted write is not retried.','Đã tạm dừng kiểm tra trạng thái tự động. Hãy kiểm tra thủ công; thao tác ghi không được gửi lại.')}</p>}
      {submission.phase==='unknown'&&<><button type="button" disabled={busy} onClick={()=>void inspectWriteStatus()}>{t('Inspect write status','Kiểm tra trạng thái ghi')}</button>
        <button type="button" disabled={busy||!gate.current.canEndUnknown()} onClick={endLocalUnknown}>{t('End local waiting; keep unknown outcome','Kết thúc chờ; giữ kết quả chưa xác định')}</button></>}
    </section>}
    {(write?.recoveryRequired||priorUnknown)&&onRecovery&&<button type="button" disabled={busy||locked} onClick={()=>callbacks.current.onRecovery?.()}>{t('Review recovery in Work','Xem xét khôi phục ở Công việc')}</button>}
    {!project&&<p>{t('Select a project to inspect its explicit hierarchy grant.','Chọn dự án để kiểm tra quyền phân cấp được cấp rõ ràng.')}</p>}
    {scopeLoaded&&!grant&&project&&<p>{t('This project has no logical-hierarchy grant in this launch.','Dự án này không có quyền phân cấp logic trong phiên khởi chạy này.')}</p>}
    {grant&&<p>{t('Granted visibility','Phạm vi được cấp')}: {grant.allowInternal?t('Public and Internal','Công khai và Nội bộ'):t('Public only','Chỉ Công khai')}</p>}
    <div className="hierarchy-workbench">
    {state&&<HierarchyStateView state={state} language={language}/>}
    <div className="hierarchy-draft-column">
    {state&&grant&&!preview&&<form onSubmit={addDraft} className="hierarchy-editor">
      <h3>{t('Draft changes','Bản nháp thay đổi')}</h3>
      <label htmlFor={`${uid}-action`}>{t('Action','Thao tác')}</label>
      <select id={`${uid}-action`} value={kind} disabled={blocked} onChange={e=>resetForm(e.target.value as Kind)}>
        {hierarchyKinds.map(value=><option key={value} value={value} disabled={value==='add_subsystem'&&!grant.allowInternal}>{t(...labels[value])}</option>)}
      </select>
      {kind==='add_subsystem'?<><label htmlFor={`${uid}-target`}>{t('New subsystem ID','ID phân hệ mới')}</label>
        <input id={`${uid}-target`} required maxLength={64} pattern="[A-Za-z][A-Za-z0-9._\-]{0,63}" value={target} disabled={blocked} onChange={e=>setTarget(e.target.value)}/></>:
        <><label htmlFor={`${uid}-target`}>{kind==='set_component_membership'?t('Component','Thành phần'):t('Subsystem','Phân hệ')}</label>
          <select id={`${uid}-target`} required value={target} disabled={blocked} onChange={e=>selectTarget(e.target.value)}>
            <option value="">{t('Choose an identity','Chọn đối tượng')}</option>
            {(kind==='set_component_membership'?state.components:state.subsystems).map(row=><option key={row.value.id} value={row.value.id}>{row.value.label} ({row.value.id})</option>)}
          </select></>}
      {(kind==='add_subsystem'||kind==='rename_subsystem')&&<><label htmlFor={`${uid}-label`}>{t('Name (up to 120 UTF-8 bytes)','Tên (tối đa 120 byte UTF-8)')}</label>
        <input id={`${uid}-label`} required maxLength={120} value={label} disabled={blocked} onChange={e=>setLabel(e.target.value)}/></>}
      {['add_subsystem','reparent_subsystem','set_component_membership'].includes(kind)&&<><label htmlFor={`${uid}-parent`}>{kind==='set_component_membership'?t('Desired subsystem','Phân hệ mong muốn'):t('Desired parent','Phân hệ cha mong muốn')}</label>
        <select id={`${uid}-parent`} value={parent} disabled={blocked} onChange={e=>setParent(e.target.value)}>
          <option value="">{kind==='set_component_membership'?t('Unassigned','Chưa gán'):t('Project root','Gốc dự án')}</option>
          {parentOptions.map(row=><option key={row.id} value={row.id} disabled={kind!=='set_component_membership'&&row.id===target}>{row.label} ({row.id})</option>)}
        </select></>}
      {kind==='add_subsystem'&&<p>{t('New subsystems are Internal. This editor does not change classification.','Phân hệ mới thuộc Nội bộ. Trình sửa này không thay đổi phân loại.')}</p>}
      {kind==='retire_empty_subsystem'&&<p>{t('No cascade. Detach or move members in this batch first. The owner verifies final emptiness and prevents ID reuse.','Không xóa lan truyền. Hãy tách hoặc chuyển thành viên trong cùng lô. Chủ sở hữu kiểm tra trạng thái rỗng cuối cùng và ngăn tái sử dụng ID.')}</p>}
      <button type="submit" disabled={blocked||changes.length>=32||kind==='add_subsystem'&&!grant.allowInternal}>{t('Add to draft','Thêm vào bản nháp')}</button>
    </form>}
    {changes.length>0&&!preview&&<section className="hierarchy-draft" aria-labelledby={`${uid}-draft`}>
      <h3 id={`${uid}-draft`}>{t('Draft batch','Lô bản nháp')} ({changes.length}/32)</h3>
      <p>{t('Expected values stay pinned to the loaded revision. Remove an entry before changing the same target again.','Giá trị kỳ vọng được giữ theo phiên bản đã tải. Xóa mục trước khi sửa lại cùng đối tượng.')}</p>
      <ol>{changes.map(change=><li key={changeKey(change)}>{t(...labels[change.kind])}: {changeKey(change).slice(2)}
        <button type="button" disabled={blocked} onClick={()=>setChanges(changes.filter(c=>changeKey(c)!==changeKey(change)))} aria-label={`${t('Remove draft entry','Xóa mục bản nháp')}: ${changeKey(change).slice(2)}`}>{t('Remove','Xóa')}</button>
      </li>)}</ol>
      <button ref={reviewButton} type="button" disabled={blocked} onClick={()=>void review()}>{t('Preview all changes','Xem trước toàn bộ thay đổi')}</button>
    </section>}
    </div></div>
    {preview&&<section className="hierarchy-review" aria-labelledby={`${uid}-review`} onKeyDown={event=>{
      if(event.key==='Escape'&&!busy&&!locked){event.preventDefault();void reject();}
    }}>
      <h3 ref={reviewHeading} id={`${uid}-review`} tabIndex={-1}>{t('Review the complete change','Xem xét toàn bộ thay đổi')}</h3>
      <p>{t('Project','Dự án')}: {preview.projectId}; {t('Revision','Phiên bản')}: {preview.revision}</p>
      <p>{t('Review expires at','Bản xem xét hết hạn lúc')}: <time dateTime={preview.expiresAt}>{preview.expiresAt}</time></p>
      <HierarchyDiffView diff={preview.diff} language={language}/>
      {Date.parse(preview.expiresAt)<=now&&<p role="status">{hierarchyMessage('PREVIEW_EXPIRED',t)}</p>}
      <div className="hierarchy-actions"><button type="button" disabled={busy||locked} onClick={()=>void reject()}>{t('Reject preview','Từ chối bản xem trước')}</button>
        <button type="button" className="primary" disabled={disabled||busy||locked||!write?.admitted||write.recoveryRequired||Date.parse(preview.expiresAt)<=now} onClick={()=>void confirm()}>{t('Confirm this operation once','Xác nhận thao tác này một lần')}</button></div>
    </section>}
  </section>;
}


