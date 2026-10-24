import {dirname,join,parse,resolve} from 'node:path';
import {ApiError,codes,exact,hash,requireThat,trustedPath} from './security.js';
import {ProcessPool,WriteOutcomeUnknown} from './process.js';
import {capturePhysicalTarget,checkedPhysicalTarget,recoveryValueKey,verifyPhysicalTarget,type PhysicalTarget,type RecoveryGuard} from './legacy-recovery-target.js';
import {checkedRecoverySubject,type RecoverySubject} from './recovery-subject.js';

export interface LibraryManagementConfig {
  parent:string;
  folders:readonly {key:string;label:string;path:string}[];
  candidates:readonly {key:string;label:string;id:string;database:string;folderKey:string}[];
}
export type LibraryAction='create'|'register'|'link'|'pin'|'forget';
export interface LibraryState {ok:true;schema:'lmti.library.management.v1';signature:string;uuid:string;format:0|1|2|3;entries:{id:string;label:string;pinned:boolean;folderLinked:boolean}[]}
export interface LibraryChange {action:LibraryAction;expected:string;id:string;label:string;folder:string;database:string;parent:string}
const id=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(v)&&!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(v)&&!/[.]$/.test(v);
const title=(v:unknown):v is string=>typeof v==='string'&&Buffer.byteLength(v)>0&&Buffer.byteLength(v)<=120&&!/[\x00-\x1f\x7f]/.test(v);
const same=(a:unknown,b:unknown)=>requireThat(recoveryValueKey(a)===recoveryValueKey(b),'CONFIG_CHANGED');
export function checkedLibraryState(value:unknown):LibraryState {
  const o=exact(value,['ok','schema','signature','uuid','format','entries']);
  requireThat(o.ok===true&&o.schema==='lmti.library.management.v1'&&typeof o.signature==='string'&&/^[a-f0-9]{64}$/.test(o.signature)&&
    typeof o.uuid==='string'&&typeof o.format==='number'&&[0,1,2,3].includes(o.format)&&
    (o.format<2?o.uuid==='':/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(o.uuid))&&Array.isArray(o.entries)&&o.entries.length<=500,'OWNER_UNAVAILABLE');
  const seen=new Set<string>();for(const value of o.entries as unknown[]){const e=exact(value,['id','label','pinned','folderLinked']);requireThat(id(e.id)&&!seen.has(e.id)&&title(e.label)&&typeof e.pinned==='boolean'&&typeof e.folderLinked==='boolean','OWNER_UNAVAILABLE');seen.add(e.id);}
  return o as unknown as LibraryState;
}
export function libraryPublic(s:LibraryState){return {format:s.format,entries:s.entries};}
export class LibraryManager {
  constructor(readonly config:LibraryManagementConfig,private binary:string,private library:string,private pool:ProcessPool,private verification:ProcessPool,private domain:()=>string){}
  async validate(){
    exact(this.config,['parent','folders','candidates']);
    requireThat(!this.library.split(/[\\/]/).some(p=>p.toLowerCase()==='.lmti'),'SCOPE_DENIED');
    const safe=async(path:string,kind:'file'|'directory')=>{await trustedPath(path,kind);requireThat(!path.split(/[\\/]/).some(p=>p.toLowerCase()==='.lmti')&&resolve(path)!==parse(resolve(path)).root,'SCOPE_DENIED');
      const physical=await capturePhysicalTarget(path,kind);requireThat(physical.state==='present','OWNER_UNAVAILABLE');};
    await safe(this.config.parent,'directory');
    requireThat(Array.isArray(this.config.folders)&&this.config.folders.length<=32&&this.config.folders.length>0&&Array.isArray(this.config.candidates)&&this.config.candidates.length<=32);
    const folders=new Set<string>();for(const value of this.config.folders){const f=exact(value,['key','label','path']);requireThat(id(f.key)&&!folders.has(f.key)&&title(f.label)&&typeof f.path==='string');folders.add(f.key);await safe(f.path,'directory');}
    const candidates=new Set<string>();for(const value of this.config.candidates){const c=exact(value,['key','label','id','database','folderKey']);requireThat(id(c.key)&&!candidates.has(c.key)&&title(c.label)&&id(c.id)&&typeof c.database==='string'&&typeof c.folderKey==='string'&&folders.has(c.folderKey));candidates.add(c.key);await safe(c.database,'file');}
    const packageRoot=resolve(dirname(this.binary),'..');
    for(const p of [this.library,this.config.parent,...this.config.folders.map(f=>f.path),...this.config.candidates.map(c=>c.database)])
      requireThat(!resolve(p).toLowerCase().startsWith(packageRoot.toLowerCase()+'/')&&!resolve(p).toLowerCase().startsWith(packageRoot.toLowerCase()+'\\')&&resolve(p).toLowerCase()!==packageRoot.toLowerCase(),'SCOPE_DENIED');
  }
  async native(mode:'state'|'review'|'commit'|'recover',input:unknown,guard?:RecoveryGuard,verify=false){
    const raw=await (verify?this.verification:this.pool).run(this.binary,['library-'+mode,this.library],JSON.stringify(input),{cap:240*1024,write:mode==='commit',projectProposalErrors:true,guard});
    if(!raw||typeof raw!=='object') {if(mode==='commit')throw new WriteOutcomeUnknown();throw new ApiError('OWNER_UNAVAILABLE');}
    const v=raw as Record<string,unknown>;
    if(v.ok!==true){const code=String((v.error as {code?:string})?.code);if(mode==='commit'&&code==='OWNER_UNAVAILABLE')throw new WriteOutcomeUnknown();throw new ApiError(codes.includes(code as never)?code as ApiError['code']:'OWNER_UNAVAILABLE');}
    return v;
  }
  async state(guard?:RecoveryGuard,verify=false){return checkedLibraryState(await this.native('state',{},guard,verify));}
  capabilities(){return {enabled:true,folders:this.config.folders.map(({key,label})=>({key,label})),candidates:this.config.candidates.map(({key,label})=>({key,label}))};}
  change(value:unknown,state:LibraryState):LibraryChange {
    requireThat(value!==null&&typeof value==='object');const action=(value as {action:unknown}).action;
    requireThat(['create','register','link','pin','forget'].includes(String(action)));
    const keys=action==='create'?['action','id','label','folderKey']:action==='register'?['action','candidateKey']:action==='link'?['action','id','folderKey']:action==='pin'?['action','id','pinned']:['action','id'];
    const o=exact(value,keys);const out:LibraryChange={action:action as LibraryAction,expected:state.signature,id:'',label:'',folder:'',database:'',parent:''};
    requireThat(state.format!==1||action==='pin','NOT_SUPPORTED');
    if(action==='register'){
      const c=this.config.candidates.find(c=>c.key===o.candidateKey);requireThat(c,'SCOPE_DENIED');out.id=c.id;out.database=c.database;out.folder=this.config.folders.find(f=>f.key===c.folderKey)!.path;
    }else{
      requireThat(id(o.id));out.id=o.id;
      if(action==='create'||action==='link'){const folder=this.config.folders.find(f=>f.key===o.folderKey);requireThat(folder,'SCOPE_DENIED');out.folder=folder.path;}
      if(action==='create'){requireThat(title(o.label));out.label=o.label;out.parent=this.config.parent;}
      if(action==='pin'){requireThat(typeof o.pinned==='boolean');out.label=String(o.pinned);}
    }
    return Object.freeze(out);
  }
  private targetDatabase(request:LibraryChange){return request.action==='create'?join(this.config.parent,request.id+'.sqlite'):request.database;}
  async capture(request:LibraryChange,state:LibraryState):Promise<RecoverySubject>{
    const locations=[{path:this.library,kind:'file' as const},...(request.action==='create'?[{path:this.config.parent,kind:'directory' as const}]:[]),
      ...(request.folder?[{path:request.folder,kind:'directory' as const}]:[]),...(this.targetDatabase(request)?[{path:this.targetDatabase(request),kind:'file' as const}]:[])];
    const physical=[];for(const location of locations)physical.push(await capturePhysicalTarget(location.path,location.kind,true));
    return checkedRecoverySubject({version:1,kind:'library_management',action:request.action,projectId:request.id,grantId:this.domain(),target:{version:1,request,stateUuid:state.uuid,physical}});
  }
  private target(subject:RecoverySubject){
    requireThat(subject.kind==='library_management'&&subject.grantId===this.domain(),'SCOPE_DENIED');const t=exact(subject.target,['version','request','stateUuid','physical']);requireThat(t.version===1&&typeof t.stateUuid==='string'&&Array.isArray(t.physical)&&t.physical.length<=4);
    const q=exact(t.request,['action','expected','id','label','folder','database','parent']) as unknown as LibraryChange;
    requireThat(q.id===subject.projectId&&q.action===subject.action&&typeof q.expected==='string'&&/^[a-f0-9]{64}$/.test(q.expected));
    // Recreate the private intent from current immutable launch grants; retained
    // metadata can never add another path or operation.
    const input=q.action==='create'?{action:q.action,id:q.id,label:q.label,folderKey:this.config.folders.find(f=>f.path===q.folder)?.key}:
      q.action==='register'?{action:q.action,candidateKey:this.config.candidates.find(c=>c.id===q.id&&c.database===q.database)?.key}:
      q.action==='link'?{action:q.action,id:q.id,folderKey:this.config.folders.find(f=>f.path===q.folder)?.key}:
      q.action==='pin'?{action:q.action,id:q.id,pinned:q.label==='true'}:{action:q.action,id:q.id};
    same(this.change(input,{signature:q.expected} as LibraryState),q);
    const physical=t.physical.map(checkedPhysicalTarget);
    const expected=[{path:this.library,kind:'file'},...(q.action==='create'?[{path:this.config.parent,kind:'directory'}]:[]),
      ...(q.folder?[{path:q.folder,kind:'directory'}]:[]),...(this.targetDatabase(q)?[{path:this.targetDatabase(q),kind:'file'}]:[])];
    same(physical.map(p=>({path:p.path,kind:p.kind})),expected);
    return {request:q,stateUuid:t.stateUuid,physical};
  }
  async verify(subject:RecoverySubject){const t=this.target(subject);for(const p of t.physical)await verifyPhysicalTarget(p,{allowMissing:true});const s=await this.state(undefined,true);requireThat(s.signature===t.request.expected,'CONFIG_CHANGED');}
  async inspect(subject:RecoverySubject,guard:RecoveryGuard){
    const t=this.target(subject);await guard();
    for(const p of t.physical){
      if(p.state==='present')await verifyPhysicalTarget(p);
      else {
        requireThat(p.state==='missing','RECOVERY_REQUIRED');const current=await capturePhysicalTarget(p.path,p.kind,true);
        same(current.chain.slice(0,p.chain.length),p.chain);
      }
    }
    const raw=await this.native('recover',{database:this.targetDatabase(t.request),id:t.request.id},guard,true);
    const {projectRevision,...state}=raw;const s=checkedLibraryState(state);
    requireThat(t.stateUuid===''||s.uuid===t.stateUuid,'CONFIG_CHANGED');await guard();
    return {digest:hash(JSON.stringify([s,projectRevision]))};
  }
}
