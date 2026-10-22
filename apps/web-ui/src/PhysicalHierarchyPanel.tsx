import {useEffect,useId,useRef,useState,type FormEvent} from 'react';
import type {request as apiRequest} from './api';
import type {Language} from './i18n';
import {Icon} from './Icon';
import {
  addPhysicalHierarchyChange,checkedPhysicalHierarchyJob,checkedPhysicalHierarchyPreview,checkedPhysicalHierarchyRejection,
  checkedPhysicalHierarchyResult,checkedPhysicalHierarchyScopes,checkedPhysicalHierarchyState,checkedPhysicalHierarchyWriteStatus,
  physicalChangeKey,physicalHierarchyErrorCode,physicalHierarchyKinds,physicalHierarchyProposal,physicalHierarchyShouldPoll,PhysicalHierarchyCommitGate,PhysicalHierarchyReadFence,makePhysicalHierarchyChange,
  type Change,type Diff,type Grant,type Kind,type Preview,type State,type Submission,type WriteStatus,
  type Site,type Area,type Environment,type Placement,type Path,type EntityKind,type DraftInput,
} from './physical-hierarchy-ui';
import './PhysicalHierarchyPanel.css';

export interface PhysicalHierarchyPanelProps{
  project:string;language:Language;request:typeof apiRequest;refreshKey:number;disabled?:boolean;
  onLockChange:(locked:boolean)=>void;onChanged:()=>void;onRecovery?:()=>void;
}
type Translate=(en:string,vi:string)=>string;
const labels:Record<Kind,readonly [string,string]>={
  add_site:['Add Site','Thêm Site'],rename_site:['Rename Site','Đổi tên Site'],retire_empty_site:['Retire empty Site','Ngừng dùng Site rỗng'],
  add_area:['Add Area','Thêm Area'],rename_area:['Rename Area','Đổi tên Area'],reparent_area:['Move Area','Chuyển Area'],retire_empty_area:['Retire empty Area','Ngừng dùng Area rỗng'],
  add_environment:['Add Environment','Thêm Environment'],rename_environment:['Rename Environment','Đổi tên Environment'],retire_empty_environment:['Retire empty Environment','Ngừng dùng Environment rỗng'],
  set_asset_placement:['Set Asset placement','Đặt vị trí Asset'],
};
const entityNames:Record<EntityKind,readonly [string,string]>={site:['Site','Site'],area:['Area','Area'],environment:['Environment','Environment'],asset:['Asset','Asset']};
function targetKind(kind:Kind):EntityKind{
  if(kind==='set_asset_placement')return 'asset';
  if(kind.endsWith('_environment'))return 'environment';
  if(kind.endsWith('_area'))return 'area';
  return 'site';
}
const adding=(kind:Kind)=>kind==='add_site'||kind==='add_area'||kind==='add_environment';
const retiring=(kind:Kind)=>kind==='retire_empty_site'||kind==='retire_empty_area'||kind==='retire_empty_environment';
const ascii=(a:{id:string},b:{id:string})=>a.id<b.id?-1:a.id>b.id?1:0;
const base=(project:string)=>`/api/v1/projects/${encodeURIComponent(project)}/physical-hierarchy`;
export function physicalHierarchyMessage(code:string,t:Translate):string{
  switch(code){
    case 'SCOPE_DENIED':return t('This view or change is outside the granted scope.','Phạm vi được cấp không cho phép xem hoặc thay đổi này.');
    case 'NOT_SUPPORTED':return t('Physical hierarchy editing is not enabled for this launch.','Phiên khởi chạy này chưa bật chỉnh sửa phân cấp vật lý.');
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
function CatalogValue({value,t}:{value:Site|Area|Environment|null;t:Translate}){
  return value===null?<p>{t('Absent','Không tồn tại')}</p>:<dl className="physical-hierarchy-values">
    <dt>{t('Name','Tên')}</dt><dd>{value.label}</dd><dt>ID</dt><dd>{value.id}</dd>
    {'siteId' in value&&<><dt>Site</dt><dd>{value.siteId}</dd><dt>{t('Parent Area','Area cha')}</dt><dd>{value.parentAreaId||t('Site root','Gốc Site')}</dd></>}
    <dt>{t('Stored classification','Phân loại đã lưu')}</dt><dd><Classification value={value.privacy} t={t}/></dd>
  </dl>;
}
function PlacementValue({value,t}:{value:Placement|null;t:Translate}){
  return value===null?<p>{t('No placement declared','Chưa khai báo vị trí')}</p>:<div>
    <p><strong>{t('Declared placement','Vị trí đã khai báo')}</strong></p>
    <dl className="physical-hierarchy-values"><dt>Asset</dt><dd>{value.assetId}</dd>
      <dt>Area</dt><dd>{value.areaId||t('No Area','Không có Area')}</dd>
      <dt>{t('Parent Asset','Asset cha')}</dt><dd>{value.parentAssetId||t('No parent Asset','Không có Asset cha')}</dd>
      <dt>{t('Environment membership','Thành viên Environment')}</dt><dd>{value.environmentId||t('No Environment','Không có Environment')}</dd>
      <dt>{t('Role','Vai trò')}</dt><dd>{value.role===null?t('Unknown','Chưa biết'):value.role==='host'?t('Host','Máy chủ'):value.role==='gateway'?t('Gateway','Cổng kết nối'):t('Device','Thiết bị')}</dd>
    </dl>
  </div>;
}
function PathValue({value,t}:{value:Path;t:Translate}){
  return <dl className="physical-hierarchy-values physical-hierarchy-path">
    <dt>Site</dt><dd>{value.siteId||t('Not applicable','Không áp dụng')}</dd>
    <dt>{t('Area ancestry, root first','Chuỗi Area, gốc trước')}</dt><dd>{value.areaAncestors.join(' / ')||t('No Area ancestry','Không có Area tổ tiên')}</dd>
    <dt>{t('Asset ancestry, root first','Chuỗi Asset, gốc trước')}</dt><dd>{value.assetAncestors.join(' / ')||t('No Asset ancestry','Không có Asset tổ tiên')}</dd>
    <dt>{t('Environment membership','Thành viên Environment')}</dt><dd>{value.environmentId||t('No Environment','Không có Environment')}</dd>
  </dl>;
}
/** Complete public presentation; no hidden-row inference or list truncation. */
export function PhysicalHierarchyDiffView({diff,language}:{diff:Diff;language:Language}){
  const t:Translate=(en,vi)=>language==='vi'?vi:en;
  const catalogs:readonly {kind:'site'|'area'|'environment';rows:readonly {id:string;before:Site|Area|Environment|null;after:Site|Area|Environment|null}[]}[]=[
    {kind:'site',rows:diff.sites},{kind:'area',rows:diff.areas},{kind:'environment',rows:diff.environments}];
  return <div className="physical-hierarchy-diff">
    {catalogs.map(group=><section key={group.kind} aria-label={`${t(...entityNames[group.kind])}: ${t('changes','thay đổi')}`}>
      <h4>{t(...entityNames[group.kind])}: {t('changes','thay đổi')}</h4>
      {group.rows.length===0?<p>{t('No catalog row changes.','Không thay đổi dòng danh mục.')}</p>:<ul>{group.rows.map(row=><li key={row.id}>
        <h5>{row.id}</h5><div className="physical-hierarchy-before-after">
          <section><h6>{t('Before','Trước')}</h6><CatalogValue value={row.before} t={t}/></section>
          <section><h6>{t('After','Sau')}</h6><CatalogValue value={row.after} t={t}/></section>
        </div></li>)}</ul>}
    </section>)}
    <h4>{t('Asset placement changes','Thay đổi vị trí Asset')}</h4>
    {diff.placements.length===0?<p>{t('No placement changes.','Không thay đổi vị trí.')}</p>:<ul>{diff.placements.map(row=><li key={row.assetId}>
      <h5>{row.assetId}</h5><div className="physical-hierarchy-before-after">
        <section><h6>{t('Before','Trước')}</h6><PlacementValue value={row.before} t={t}/></section>
        <section><h6>{t('After','Sau')}</h6><PlacementValue value={row.after} t={t}/></section>
      </div></li>)}</ul>}
    <h4>{t('All affected identities and inherited paths','Tất cả đối tượng bị ảnh hưởng và đường dẫn kế thừa')}</h4>
    <p>{t('Includes descendants whose own stored rows do not change. Environment is membership, not containment.','Bao gồm đối tượng con có dòng đã lưu không đổi. Environment là quan hệ thành viên, không phải quan hệ chứa.')}</p>
    <ul>{diff.affected.map(row=><li key={`${row.kind}:${row.id}`}>
      <h5>{t(...entityNames[row.kind])}: {row.id}</h5><div className="physical-hierarchy-before-after">
        <section><h6>{t('Before','Trước')}</h6><Classification value={row.beforeClassification} t={t}/><PathValue value={row.beforePath} t={t}/></section>
        <section><h6>{t('After','Sau')}</h6><Classification value={row.afterClassification} t={t}/><PathValue value={row.afterPath} t={t}/></section>
      </div></li>)}</ul>
  </div>;
}
export function PhysicalHierarchyStateView({state,language}:{state:State;language:Language}){
  const t:Translate=(en,vi)=>language==='vi'?vi:en;
  const filterId=useId();
  const [filter,setFilter]=useState({project:state.projectId,value:''});
  const [selection,setSelection]=useState<{project:string;kind:EntityKind;id:string}|null>(null);
  const query=filter.project===state.projectId?filter.value:'';
  const groups=[{kind:'site' as const,label:t('Sites','Địa điểm'),rows:state.sites},{kind:'area' as const,label:t('Areas','Khu vực'),rows:state.areas},{kind:'environment' as const,label:t('Environment memberships','Thành viên môi trường'),rows:state.environments},{kind:'asset' as const,label:t('Assets','Thiết bị'),rows:state.assets}];
  const rows=groups.flatMap(group=>group.rows.map(row=>({kind:group.kind,id:row.value.id,label:row.value.label})));
  const current=rows.find(row=>selection?.project===state.projectId&&selection.kind===row.kind&&selection.id===row.id)??rows[0];
  const catalog=current?.kind==='site'?state.sites.find(row=>row.value.id===current.id):current?.kind==='area'?state.areas.find(row=>row.value.id===current.id):current?.kind==='environment'?state.environments.find(row=>row.value.id===current.id):undefined;
  const asset=current?.kind==='asset'?state.assets.find(row=>row.value.id===current.id):undefined;
  const matches=(row:{value:{id:string;label:string}})=>`${row.value.label} ${row.value.id}`.toLocaleLowerCase().includes(query.toLocaleLowerCase());
  return <div className="physical-hierarchy-state physical-hierarchy-explorer">
    <div className="physical-hierarchy-explorer-header"><span>{t('Declared locations & roles','Vị trí & vai trò khai báo')}</span><span className="pill neutral">r{state.revision}</span></div>
    <p className="physical-hierarchy-boundary">{t('Environment is membership, not containment. Declarations do not establish running device state.','Environment là quan hệ thành viên. Khai báo không xác minh trạng thái thiết bị đang chạy.')}</p>
    <div className="physical-hierarchy-explorer-grid">
      <nav className="physical-hierarchy-browser" aria-label={t('Visible physical hierarchy','Phân cấp vật lý được phép xem')}>
        <label htmlFor={filterId}>{t('Find in the authorized view','Tìm trong phạm vi được phép')}</label><input id={filterId} type="search" maxLength={120} value={query} onChange={event=>setFilter({project:state.projectId,value:event.target.value})}/>
        {groups.map(group=><details key={group.kind} open><summary>{group.label} <span>{group.rows.filter(matches).length}</span></summary><ul>{group.rows.filter(matches).map(row=><li key={row.value.id}><button type="button" aria-pressed={current?.kind===group.kind&&current.id===row.value.id} onClick={()=>setSelection({project:state.projectId,kind:group.kind,id:row.value.id})}><strong>{row.value.label}</strong><code>{row.value.id}</code></button></li>)}</ul>{!group.rows.filter(matches).length&&<p className="physical-hierarchy-boundary">{query?t('No matches in this group.','Không có kết quả trong nhóm.'):t('No visible entries.','Chưa có mục hiển thị.')}</p>}</details>)}
      </nav>
      <section className="physical-hierarchy-inspector" aria-label={t('Selected identity details','Chi tiết đối tượng đã chọn')}>
        {current?<><p className="eyebrow">{t(...entityNames[current.kind])}</p><h3>{current.label}</h3><code>{current.id}</code>
          {catalog&&<><CatalogValue value={catalog.value} t={t}/><p>{t('Effective classification','Phân loại hiệu lực')}: <Classification value={catalog.classification} t={t}/></p></>}
          {asset&&<><dl className="physical-hierarchy-values"><dt>{t('Fixed Site','Site cố định')}</dt><dd>{asset.value.site}</dd><dt>{t('Asset kind','Loại Asset')}</dt><dd>{asset.value.kind}</dd><dt>{t('Effective classification','Phân loại hiệu lực')}</dt><dd><Classification value={asset.classification} t={t}/></dd></dl><PlacementValue value={asset.placement} t={t}/><details><summary>{t('Declared ancestry','Chuỗi vị trí khai báo')}</summary><PathValue value={asset.path} t={t}/></details></>}
          <p className="physical-hierarchy-boundary">{t('Use the draft editor to prepare a reviewed change. No command is sent to the device.','Dùng trình soạn bản nháp để chuẩn bị thay đổi cần duyệt. Không gửi lệnh đến thiết bị.')}</p>
        </>:<p>{t('Select a visible identity to inspect its declaration.','Chọn đối tượng được phép xem để đọc khai báo.')}</p>}
      </section>
    </div>
    <details className="physical-hierarchy-complete"><summary>{t('Complete authorized details','Toàn bộ chi tiết được phép xem')}</summary><PhysicalHierarchyDetailsView state={state} language={language}/></details>
  </div>;
}
function PhysicalHierarchyDetailsView({state,language}:{state:State;language:Language}){
  const t:Translate=(en,vi)=>language==='vi'?vi:en;
  return <div className="physical-hierarchy-state">
    <p>{t('Project revision','Phiên bản dự án')}: <strong>{state.revision}</strong></p>
    <p>{t('This is the complete authorized view. Hidden rows are not counted or inferred.','Đây là toàn bộ phần được phép xem. Các dòng ẩn không được đếm hoặc suy đoán.')}</p>
    <details><summary>Sites ({state.sites.length})</summary>
      {state.sites.length===0?<p>{t('No visible Sites.','Không có Site hiển thị.')}</p>:<ul>{state.sites.map(row=><li key={row.value.id}>
        <CatalogValue value={row.value} t={t}/><p>{t('Effective classification','Phân loại hiệu lực')}: <Classification value={row.classification} t={t}/></p>
      </li>)}</ul>}
    </details>
    <details><summary>Areas ({state.areas.length})</summary>
      {state.areas.length===0?<p>{t('No visible Areas.','Không có Area hiển thị.')}</p>:<ul>{state.areas.map(row=><li key={row.value.id}>
        <CatalogValue value={row.value} t={t}/><p>{t('Containment path, Site first','Đường dẫn chứa, Site trước')}: {[row.value.siteId,...row.ancestors,row.value.id].join(' / ')}</p>
        <p>{t('Effective classification','Phân loại hiệu lực')}: <Classification value={row.classification} t={t}/></p>
      </li>)}</ul>}
    </details>
    <details><summary>Environments ({state.environments.length})</summary>
      <p>{t('Environments are project-wide membership catalogs, including visible unused rows.','Environment là danh mục thành viên toàn dự án, gồm cả các dòng hiển thị chưa được dùng.')}</p>
      {state.environments.length===0?<p>{t('No visible Environments.','Không có Environment hiển thị.')}</p>:<ul>{state.environments.map(row=><li key={row.value.id}>
        <CatalogValue value={row.value} t={t}/><p>{t('Effective classification','Phân loại hiệu lực')}: <Classification value={row.classification} t={t}/></p>
      </li>)}</ul>}
    </details>
    <details><summary>Assets ({state.assets.length})</summary>
      {state.assets.length===0?<p>{t('No visible Assets.','Không có Asset hiển thị.')}</p>:<ul>{state.assets.map(row=><li key={row.value.id}>
        <h4>{row.value.label} ({row.value.id})</h4>
        <dl className="physical-hierarchy-values"><dt>{t('Fixed Site','Site cố định')}</dt><dd>{row.value.site}</dd>
          <dt>{t('Asset kind','Loại Asset')}</dt><dd>{row.value.kind}</dd>
          <dt>{t('Stored classification','Phân loại đã lưu')}</dt><dd><Classification value={row.value.privacy} t={t}/></dd>
          <dt>{t('Effective classification','Phân loại hiệu lực')}</dt><dd><Classification value={row.classification} t={t}/></dd>
        </dl><PlacementValue value={row.placement} t={t}/><PathValue value={row.path} t={t}/>
      </li>)}</ul>}
    </details>
  </div>;
}
function DraftChangeView({change,t}:{change:Change;t:Translate}){
  switch(change.kind){
    case 'add_site':case 'add_area':case 'add_environment':return <CatalogValue value={change.desired} t={t}/>;
    case 'rename_site':case 'rename_area':case 'rename_environment':return <p>{t('New name','Tên mới')}: {change.desiredLabel}</p>;
    case 'reparent_area':return <p>{t('Desired parent Area','Area cha mong muốn')}: {change.desiredParentId||t('Site root','Gốc Site')}</p>;
    case 'set_asset_placement':return <PlacementValue value={change.desired} t={t}/>;
    default:return <p>{t('Retire only when empty in the final batch.','Chỉ ngừng dùng khi rỗng trong lô cuối cùng.')}</p>;
  }
}
function targetId(change:Change):string{return change.kind==='set_asset_placement'?change.expectedAsset.id:'desired' in change?change.desired.id:change.expected.id;}
export function PhysicalHierarchyPanel({project,language,request,refreshKey,disabled=false,onLockChange,onChanged,onRecovery}:PhysicalHierarchyPanelProps){
  const t:Translate=(en,vi)=>language==='vi'?vi:en;
  const uid=useId(),mounted=useRef(true),generation=useRef(new PhysicalHierarchyReadFence()),readAbort=useRef<AbortController|null>(null),
    busyRef=useRef(false),writingRef=useRef(false),gate=useRef(new PhysicalHierarchyCommitGate()),previewRef=useRef<Preview|null>(null),
    currentProject=useRef(project),refreshSeen=useRef(''),pollAttempts=useRef(0),callbacks=useRef({onLockChange,onChanged,onRecovery}),
    currentSelection=useRef(''),disabledRef=useRef(disabled),
    reviewHeading=useRef<HTMLHeadingElement|null>(null),errorHeading=useRef<HTMLDivElement|null>(null),
    reviewButton=useRef<HTMLButtonElement|null>(null);
  callbacks.current={onLockChange,onChanged,onRecovery};
  disabledRef.current=disabled;
  currentSelection.current=`${project}\n${refreshKey}`;
  const [state,setState]=useState<State|null>(null),[grant,setGrant]=useState<Grant|null>(null),[scopeLoaded,setScopeLoaded]=useState(false),
    [write,setWrite]=useState<WriteStatus|null>(null),[changes,setChanges]=useState<readonly Change[]>([]),
    [preview,setPreview]=useState<Preview|null>(null),[submission,setSubmission]=useState<Submission|null>(null),
    [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),
    [priorUnknown,setPriorUnknown]=useState(false),[now,setNow]=useState(Date.now()),
    [kind,setKind]=useState<Kind>('add_site'),[target,setTarget]=useState(''),[label,setLabel]=useState(''),
    [site,setSite]=useState(''),[area,setArea]=useState(''),[parentArea,setParentArea]=useState(''),
    [parentAsset,setParentAsset]=useState(''),[environment,setEnvironment]=useState(''),
    [role,setRole]=useState<''|'host'|'gateway'|'device'>(''),[placementDeclared,setPlacementDeclared]=useState(false);
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
    try{await work(abort.signal,accept);}catch(e){accept(()=>setError(physicalHierarchyErrorCode(e)));}
    finally{if(generation.current.current(ticket))finishBusy();}
  }
  async function refresh(){
    if(gate.current.current?.locked||disabledRef.current)return;
    const selected=currentProject.current;
    await readTask(async(signal,accept)=>{
      accept(()=>{setState(null);setGrant(null);setScopeLoaded(false);setChanges([]);setReview(null);setWrite(null);});
      const grants=checkedPhysicalHierarchyScopes(await request('/api/v1/physical-hierarchy-scopes','GET',undefined,signal)),
        selectedGrant=grants.find(g=>g.projectId===selected)??null;
      accept(()=>{
        setGrant(selectedGrant);setScopeLoaded(true);
        if(selectedGrant&&!selectedGrant.allowInternal)setKind(value=>adding(value)?'rename_site':value);
      });
      const status=checkedPhysicalHierarchyWriteStatus(await request('/api/v1/write-status','GET',undefined,signal));
      accept(()=>setWrite(status));
      if(!selectedGrant)return;
      const next=checkedPhysicalHierarchyState(await request(base(selected),'GET',undefined,signal),selectedGrant);
      accept(()=>setState(next));
    });
  }
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;invalidateRead();};},[]);
  useEffect(()=>{
    const next=`${project}\n${refreshKey}`;
    if(gate.current.current?.locked||writingRef.current||disabled||refreshSeen.current===next)return;
    invalidateRead();busyRef.current=false;setBusy(false);
    refreshSeen.current=next;currentProject.current=project;
    resetForm(kind);setNotice('');
    void refresh();
  },[project,refreshKey,busy,submission?.locked,disabled]);
  useEffect(()=>{if(!preview)return;reviewHeading.current?.focus();const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[preview]);
  useEffect(()=>{if(error)errorHeading.current?.focus();},[error]);
  const locked=!!submission?.locked,exhausted=!!state&&state.revision>=Number.MAX_SAFE_INTEGER-1,
    blocked=disabled||busy||locked||exhausted||!state||state.projectId!==project||!grant||!write||!write.admitted||write.recoveryRequired;
  const entity=targetKind(kind),isAdd=adding(kind),isRetire=retiring(kind),
    originalTargets=entity==='site'?state?.sites:entity==='area'?state?.areas:entity==='environment'?state?.environments:state?.assets,
    selectedAsset=state?.assets.find(row=>row.value.id===target),
    selectedArea=state?.areas.find(row=>row.value.id===target);
  // These are option lists only. The helper validates the entire final draft.
  const siteOptions=[...(state?.sites.map(row=>row.value)??[]),...changes.flatMap(c=>c.kind==='add_site'?[c.desired]:[])]
    .filter(row=>!changes.some(c=>c.kind==='retire_empty_site'&&c.expected.id===row.id)).sort(ascii);
  const areaOptions=[...(state?.areas.map(row=>row.value)??[]),...changes.flatMap(c=>c.kind==='add_area'?[c.desired]:[])]
    .filter(row=>!changes.some(c=>c.kind==='retire_empty_area'&&c.expected.id===row.id)).sort(ascii);
  const environmentOptions=[...(state?.environments.map(row=>row.value)??[]),...changes.flatMap(c=>c.kind==='add_environment'?[c.desired]:[])]
    .filter(row=>!changes.some(c=>c.kind==='retire_empty_environment'&&c.expected.id===row.id)).sort(ascii);
  const areaSite=kind==='add_area'?site:kind==='reparent_area'?selectedArea?.value.siteId:selectedAsset?.value.site;
  const parentAreaOptions=areaOptions.filter(row=>row.siteId===areaSite&&row.id!==target);
  const placementAreaOptions=areaOptions.filter(row=>row.siteId===selectedAsset?.value.site);
  const parentAssetOptions=(state?.assets??[]).filter(row=>row.value.site===selectedAsset?.value.site&&row.value.id!==target);
  function resetForm(next:Kind){
    setKind(next);setTarget('');setLabel('');setSite('');setArea('');setParentArea('');
    setParentAsset('');setEnvironment('');setRole('');setPlacementDeclared(false);
  }
  function selectTarget(value:string){
    setTarget(value);
    const row=originalTargets?.find(r=>r.value.id===value);
    setLabel(row?.value.label??'');
    const selected=state?.areas.find(r=>r.value.id===value);
    setParentArea(selected?.value.parentAreaId??'');
    const placement=state?.assets.find(r=>r.value.id===value)?.placement??null;
    setPlacementDeclared(placement!==null);setArea(placement?.areaId??'');setParentAsset(placement?.parentAssetId??'');
    setEnvironment(placement?.environmentId??'');setRole(placement?.role??'');
  }
  function draftInput():DraftInput{
    switch(kind){
      case 'add_site':case 'add_environment':case 'rename_site':case 'rename_area':case 'rename_environment':
        return {kind,targetId:target,label};
      case 'add_area':return {kind,targetId:target,label,siteId:site,parentAreaId:parentArea};
      case 'reparent_area':return {kind,targetId:target,parentAreaId:parentArea};
      case 'retire_empty_site':case 'retire_empty_area':case 'retire_empty_environment':return {kind,targetId:target};
      case 'set_asset_placement':return {kind,targetId:target,desired:placementDeclared?
        {areaId:area,parentAssetId:parentAsset,environmentId:environment,role:role||null}:null};
    }
  }
  function addDraft(event:FormEvent){
    event.preventDefault();if(blocked||!state||!grant||previewRef.current)return;
    try{
      const change=makePhysicalHierarchyChange(state,grant,draftInput());
      setChanges(addPhysicalHierarchyChange(changes,change));setError('');setNotice('');resetForm(kind);
    }catch(e){setError(physicalHierarchyErrorCode(e));}
  }
  async function review(){
    if(blocked||!state||!grant||previewRef.current)return;
    const snapshot=state,authority=grant;
    let proposal;try{proposal=physicalHierarchyProposal(snapshot,authority,changes);}catch(e){setError(physicalHierarchyErrorCode(e));return;}
    await readTask(async(signal,accept)=>{
      const value=checkedPhysicalHierarchyPreview(await request(`${base(snapshot.projectId)}/previews`,'POST',{proposal},signal),snapshot,authority,proposal);
      accept(()=>{setNow(Date.now());setReview(value);setNotice('');});
    });
  }
  async function reject(){
    const value=previewRef.current;if(!value||disabledRef.current||busyRef.current||gate.current.current?.locked)return;
    setReview(null);
    await readTask(async(signal,accept)=>{
      checkedPhysicalHierarchyRejection(await request(`${base(value.projectId)}/previews/${value.id}`,'DELETE',undefined,signal));
      accept(()=>setNotice('rejected'));
    });
    reviewButton.current?.focus();
  }
  function acceptResult(value:unknown){
    const original=gate.current.current;if(!original)return;
    const result=checkedPhysicalHierarchyResult(value,original.project,original.revision,original.result?.operationId);
    const previous=original.phase;publish(gate.current.observe(result));
    if(result.outcome==='confirmed'&&previous!=='confirmed'){
      setState(null);setChanges([]);setWrite(null);changed();
    }
  }
  async function confirm(){
    const value=previewRef.current;if(!value||value.projectId!==project||refreshSeen.current!==currentSelection.current||
      disabled||busyRef.current||gate.current.current?.locked||!write?.admitted||write.recoveryRequired)return;
    let body;try{body=gate.current.begin(value,Date.now());}catch(e){setError(physicalHierarchyErrorCode(e));return;}
    // Both refs change before await; a double event cannot submit the old token.
    setReview(null);setWrite(null);invalidateRead();pollAttempts.current=0;writingRef.current=true;busyRef.current=true;setBusy(true);setError('');setNotice('');publish(gate.current.current!);
    try{
      const result=await request(`${base(value.projectId)}/commits`,'POST',body);
      if(mounted.current)acceptResult(result);
      else{
        const checked=checkedPhysicalHierarchyResult(result,value.projectId,value.revision);
        const terminal=gate.current.observe(checked);callbacks.current.onLockChange(terminal.locked);
      }
    }catch(e){
      publish(gate.current.uncertain());if(mounted.current)setError(physicalHierarchyErrorCode(e));
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
        const job=checkedPhysicalHierarchyJob(await request(`/api/v1/operations/${key}`,'GET',undefined,signal),s.project,s.revision,key);
        accept(()=>{if(job.result)acceptResult(job.result);});
      }catch(e){
        accept(()=>{publish(gate.current.uncertain());setError(physicalHierarchyErrorCode(e));});
      }
    });
    if(mounted.current&&!gate.current.current?.locked)void refresh();
  }
  useEffect(()=>{
    if(!physicalHierarchyShouldPoll(submission,pollAttempts.current,busy))return;
    const timer=setTimeout(()=>void checkJob(),1500);return()=>clearTimeout(timer);
  },[submission?.phase,submission?.result?.operationId,busy]);
  async function inspectWriteStatus(){
    const original=gate.current.current;if(!original||original.phase!=='unknown')return;
    await readTask(async(signal,accept)=>{
      const status=checkedPhysicalHierarchyWriteStatus(await request('/api/v1/write-status','GET',undefined,signal));
      accept(()=>{gate.current.observeWriteStatus(status,original);setWrite(status);});
    });
  }
  function endLocalUnknown(){
    if(!write||busyRef.current)return;
    try{publish(gate.current.endUnknown());setState(null);setChanges([]);setReview(null);setNotice('unknown_retained');}
    catch(e){setError(physicalHierarchyErrorCode(e));}
  }
  const title=t('Physical hierarchy','Phân cấp vật lý'),working=t('Working…','Đang xử lý…');
  return <section className="physical-hierarchy-panel" aria-labelledby={`${uid}-heading`} aria-busy={busy}>
    <header><h2 id={`${uid}-heading`}><Icon name="project" /> {title}</h2>
      <button type="button" disabled={disabled||busy||locked} onClick={()=>void refresh()}>{busy?working:t('Load current hierarchy','Tải phân cấp hiện tại')}</button>
    </header>
    <p>{t('Review the complete change before confirming it once.','Xem xét toàn bộ thay đổi trước khi xác nhận một lần.')}</p>
    <div role="status" aria-live="polite" className="physical-hierarchy-status">
      {notice==='rejected'&&t('Review rejected. No hierarchy change was submitted.','Đã từ chối bản xem xét. Chưa gửi thay đổi phân cấp.')}
      {notice==='unknown_retained'&&t('Local waiting ended. The prior outcome is still unconfirmed; use Work to review recovery.','Đã kết thúc chờ cục bộ. Kết quả trước đó vẫn chưa xác định; mở Công việc để xem xét khôi phục.')}
      {busy&&working}
    </div>
    {error&&<div ref={errorHeading} tabIndex={-1} role="alert" className="physical-hierarchy-error">{physicalHierarchyMessage(error,t)}</div>}
    {priorUnknown&&<p className="soft-panel">{t('An earlier submitted outcome remains unconfirmed. New reads do not establish whether it happened.','Một thao tác đã gửi trước đó vẫn chưa xác định kết quả. Việc đọc mới không chứng minh thao tác đó có xảy ra hay không.')}</p>}
    {submission&&<section className="physical-hierarchy-submission" aria-label={t('Submitted operation','Thao tác đã gửi')}>
      <h3>{submission.phase==='confirmed'?t('Change confirmed','Đã xác nhận thay đổi'):submission.phase==='refused'?t('Change refused','Thay đổi bị từ chối'):
        submission.phase==='unknown'?t('Outcome unconfirmed','Chưa xác định kết quả'):t('Operation in progress','Thao tác đang xử lý')}</h3>
      <p>{t('Project','Dự án')}: {submission.project}; {t('Reviewed revision','Phiên bản đã xem xét')}: {submission.revision}</p>
      {submission.result?.summary&&<p>{t('Saved revision','Phiên bản đã lưu')}: {submission.result.summary.revision}</p>}
      {submission.phase==='confirmed'&&submission.result?.summary===null&&<p>{t('The owner confirmed the write; detailed readback is unavailable. A fresh read or recovery may still be required.','Chủ sở hữu đã xác nhận ghi; chưa có chi tiết đọc lại. Có thể vẫn cần đọc mới hoặc khôi phục.')}</p>}
      {submission.result?.code&&<p>{physicalHierarchyMessage(submission.result.code,t)}</p>}
      {submission.result?.operationId&&['pending','unknown'].includes(submission.phase)&&
        <button type="button" disabled={busy} onClick={()=>void checkJob()}>{t('Check submitted operation','Kiểm tra thao tác đã gửi')}</button>}
      {submission.phase==='pending'&&pollAttempts.current>=40&&<p>{t('Automatic status checks paused. Check manually; the submitted write is not retried.','Đã tạm dừng kiểm tra trạng thái tự động. Hãy kiểm tra thủ công; thao tác ghi không được gửi lại.')}</p>}
      {submission.phase==='unknown'&&<><button type="button" disabled={busy} onClick={()=>void inspectWriteStatus()}>{t('Inspect write status','Kiểm tra trạng thái ghi')}</button>
        <button type="button" disabled={busy||!gate.current.canEndUnknown()} onClick={endLocalUnknown}>{t('End local waiting; keep unknown outcome','Kết thúc chờ; giữ kết quả chưa xác định')}</button></>}
    </section>}
    {(write?.recoveryRequired||priorUnknown)&&onRecovery&&<button type="button" disabled={disabled||busy||locked} onClick={()=>callbacks.current.onRecovery?.()}>{t('Review recovery in Work','Xem xét khôi phục ở Công việc')}</button>}
    {!project&&<p>{t('Select a project to inspect its explicit hierarchy grant.','Chọn dự án để kiểm tra quyền phân cấp được cấp rõ ràng.')}</p>}
    {scopeLoaded&&!grant&&project&&<p>{t('This project has no physical-hierarchy grant in this launch.','Dự án này không có quyền phân cấp vật lý trong phiên khởi chạy này.')}</p>}
    {grant&&<p>{t('Granted visibility','Phạm vi được cấp')}: {grant.allowInternal?t('Public and Internal','Công khai và Nội bộ'):t('Public only','Chỉ Công khai')}</p>}
    <div className="physical-hierarchy-workbench">
    {state&&<PhysicalHierarchyStateView state={state} language={language}/>}
    <div className="physical-hierarchy-draft-column">
    {exhausted&&<p role="status">{t('This revision can be inspected, but no further revision can be saved.','Có thể xem phiên bản này nhưng không thể lưu thêm phiên bản mới.')}</p>}
    {state&&grant&&!preview&&<form onSubmit={addDraft} className="physical-hierarchy-editor">
      <fieldset disabled={blocked}><legend>{t('Draft changes','Bản nháp thay đổi')}</legend>
        <label htmlFor={`${uid}-action`}>{t('Action','Thao tác')}</label>
        <select id={`${uid}-action`} value={kind} onChange={e=>resetForm(e.target.value as Kind)}>
          {physicalHierarchyKinds.map(value=><option key={value} value={value} disabled={adding(value)&&!grant.allowInternal}>{t(...labels[value])}</option>)}
        </select>
        {isAdd?<><label htmlFor={`${uid}-target`}>{t('New ID','ID mới')} ({t(...entityNames[entity])})</label>
          <input id={`${uid}-target`} required maxLength={64} pattern="[A-Za-z][A-Za-z0-9._\-]{0,63}" value={target} onChange={e=>setTarget(e.target.value)}/></>:
          <><label htmlFor={`${uid}-target`}>{t(...entityNames[entity])}</label>
            <select id={`${uid}-target`} required value={target} onChange={e=>selectTarget(e.target.value)}>
              <option value="">{t('Choose an identity','Chọn đối tượng')}</option>
              {originalTargets?.map(row=><option key={row.value.id} value={row.value.id}>{row.value.label} ({row.value.id})</option>)}
            </select></>}
        {(isAdd||kind==='rename_site'||kind==='rename_area'||kind==='rename_environment')&&<>
          <label htmlFor={`${uid}-label`}>{t('Name (up to 120 UTF-8 bytes)','Tên (tối đa 120 byte UTF-8)')}</label>
          <input id={`${uid}-label`} required maxLength={120} value={label} onChange={e=>setLabel(e.target.value)}/>
        </>}
        {kind==='add_area'&&<><label htmlFor={`${uid}-site`}>Site</label>
          <select id={`${uid}-site`} required value={site} onChange={e=>{setSite(e.target.value);setParentArea('');}}>
            <option value="">{t('Choose a Site','Chọn Site')}</option>
            {siteOptions.map(row=><option key={row.id} value={row.id}>{row.label} ({row.id})</option>)}
          </select></>}
        {kind==='reparent_area'&&selectedArea&&<p>{t('Fixed Site','Site cố định')}: <strong>{selectedArea.value.siteId}</strong></p>}
        {(kind==='add_area'||kind==='reparent_area')&&<><label htmlFor={`${uid}-parent-area`}>{t('Desired parent Area','Area cha mong muốn')}</label>
          <select id={`${uid}-parent-area`} value={parentArea} onChange={e=>setParentArea(e.target.value)}>
            <option value="">{t('Site root','Gốc Site')}</option>
            {parentAreaOptions.map(row=><option key={row.id} value={row.id}>{row.label} ({row.id})</option>)}
          </select></>}
        {kind==='set_asset_placement'&&<>
          {selectedAsset&&<p>{t('Fixed Asset Site','Site cố định của Asset')}: <strong>{selectedAsset.value.site}</strong></p>}
          <label htmlFor={`${uid}-placement`}>{t('Placement declaration','Khai báo vị trí')}</label>
          <select id={`${uid}-placement`} value={placementDeclared?'declared':'absent'} onChange={e=>setPlacementDeclared(e.target.value==='declared')}>
            <option value="absent">{t('No placement declared','Chưa khai báo vị trí')}</option>
            <option value="declared">{t('Declared placement','Vị trí đã khai báo')}</option>
          </select>
          <p>{t('A declared placement may have no optional IDs and an unknown role. This differs from no placement. Asset Site cannot be changed here.','Vị trí đã khai báo có thể không có ID tùy chọn và chưa biết vai trò. Trạng thái này khác với chưa khai báo vị trí. Không thể đổi Site của Asset tại đây.')}</p>
          {placementDeclared&&<fieldset className="physical-hierarchy-placement"><legend>{t('Desired placement','Vị trí mong muốn')}</legend>
            <label htmlFor={`${uid}-area`}>Area</label>
            <select id={`${uid}-area`} value={area} onChange={e=>setArea(e.target.value)}>
              <option value="">{t('No Area','Không có Area')}</option>
              {placementAreaOptions.map(row=><option key={row.id} value={row.id}>{row.label} ({row.id})</option>)}
            </select>
            <label htmlFor={`${uid}-parent-asset`}>{t('Parent Asset','Asset cha')}</label>
            <select id={`${uid}-parent-asset`} value={parentAsset} onChange={e=>setParentAsset(e.target.value)}>
              <option value="">{t('No parent Asset','Không có Asset cha')}</option>
              {parentAssetOptions.map(row=><option key={row.value.id} value={row.value.id}>{row.value.label} ({row.value.id})</option>)}
            </select>
            <label htmlFor={`${uid}-environment`}>{t('Environment membership','Thành viên Environment')}</label>
            <select id={`${uid}-environment`} value={environment} onChange={e=>setEnvironment(e.target.value)}>
              <option value="">{t('No Environment','Không có Environment')}</option>
              {environmentOptions.map(row=><option key={row.id} value={row.id}>{row.label} ({row.id})</option>)}
            </select>
            <label htmlFor={`${uid}-role`}>{t('Role','Vai trò')}</label>
            <select id={`${uid}-role`} value={role} onChange={e=>setRole(e.target.value as typeof role)}>
              <option value="">{t('Unknown','Chưa biết')}</option><option value="host">{t('Host','Máy chủ')}</option>
              <option value="gateway">{t('Gateway','Cổng kết nối')}</option><option value="device">{t('Device','Thiết bị')}</option>
            </select>
            <p>{t('A parent Asset must have a declared placement with the same Site, Area and Environment in the final batch. Environment is membership, not containment.','Asset cha phải có vị trí đã khai báo với cùng Site, Area và Environment trong lô cuối cùng. Environment là quan hệ thành viên, không phải quan hệ chứa.')}</p>
          </fieldset>}
        </>}
        {isAdd&&<p>{t('New catalog rows are Internal. This editor does not change classification.','Dòng danh mục mới thuộc Nội bộ. Trình sửa này không thay đổi phân loại.')}</p>}
        {isRetire&&<p>{t('No cascade. Detach or move members in this batch first. The owner verifies final emptiness and prevents ID reuse.','Không xóa lan truyền. Hãy tách hoặc chuyển thành viên trong cùng lô. Chủ sở hữu kiểm tra trạng thái rỗng cuối cùng và ngăn tái sử dụng ID.')}</p>}
        <button type="submit" disabled={blocked||changes.length>=32||isAdd&&!grant.allowInternal}>{t('Add to draft','Thêm vào bản nháp')}</button>
      </fieldset>
    </form>}
    {changes.length>0&&!preview&&<section className="physical-hierarchy-draft" aria-labelledby={`${uid}-draft`}>
      <h3 id={`${uid}-draft`}>{t('Draft batch','Lô bản nháp')} ({changes.length}/32)</h3>
      <p>{t('Expected values stay pinned to the loaded revision. Remove an entry before changing the same target again.','Giá trị kỳ vọng được giữ theo phiên bản đã tải. Xóa mục trước khi sửa lại cùng đối tượng.')}</p>
      <ol>{changes.map(change=><li key={physicalChangeKey(change)}><strong>{t(...labels[change.kind])}: {targetId(change)}</strong>
        <DraftChangeView change={change} t={t}/>
        <button type="button" disabled={blocked} onClick={()=>setChanges(changes.filter(c=>physicalChangeKey(c)!==physicalChangeKey(change)))} aria-label={`${t('Remove draft entry','Xóa mục bản nháp')}: ${targetId(change)}`}>{t('Remove','Xóa')}</button>
      </li>)}</ol>
      <button ref={reviewButton} type="button" disabled={blocked} onClick={()=>void review()}>{t('Preview all changes','Xem trước toàn bộ thay đổi')}</button>
    </section>}
    </div></div>
    {preview&&<section className="physical-hierarchy-review" aria-labelledby={`${uid}-review`} onKeyDown={event=>{
      if(event.key==='Escape'&&!disabled&&!busy&&!locked){event.preventDefault();void reject();}
    }}>
      <h3 ref={reviewHeading} id={`${uid}-review`} tabIndex={-1}>{t('Review the complete change','Xem xét toàn bộ thay đổi')}</h3>
      <p>{t('Project','Dự án')}: {preview.projectId}; {t('Revision','Phiên bản')}: {preview.revision}</p>
      <p>{t('Review expires at','Bản xem xét hết hạn lúc')}: <time dateTime={preview.expiresAt}>{preview.expiresAt}</time></p>
      <PhysicalHierarchyDiffView diff={preview.diff} language={language}/>
      {Date.parse(preview.expiresAt)<=now&&<p role="status">{physicalHierarchyMessage('PREVIEW_EXPIRED',t)}</p>}
      <div className="physical-hierarchy-actions"><button type="button" disabled={disabled||busy||locked} onClick={()=>void reject()}>{t('Reject preview','Từ chối bản xem trước')}</button>
        <button type="button" className="primary" disabled={disabled||busy||locked||!write?.admitted||write.recoveryRequired||Date.parse(preview.expiresAt)<=now} onClick={()=>void confirm()}>{t('Confirm this operation once','Xác nhận thao tác này một lần')}</button></div>
    </section>}
  </section>;
}


