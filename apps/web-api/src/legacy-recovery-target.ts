import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, parse, resolve } from 'node:path';
import { ApiError, exact, requireThat } from './security.js';

// Private owner provenance. Never project these paths or identities into HTTP DTOs.
export interface PhysicalIdentity {readonly dev:string; readonly ino:string; readonly birthtimeNs:string}
export interface PhysicalTarget {
  readonly version:1; readonly path:string; readonly kind:'file'|'directory';
  readonly state:'present'|'missing'|'unsupported';
  readonly chain:readonly (PhysicalIdentity|null)[];
}
export type LegacyEffect = {kind:'profile_save'|'desired_proposal'} |
  {kind:'client_apply'|'client_restore'; client:'codex'|'cursor'};
export interface LegacyOriginalTarget {
  readonly version:1; readonly action:LegacyEffect['kind']; readonly projectId:string; readonly domainId:string;
  readonly library:{readonly schema:1|2|3; readonly canonicalPath:string; readonly uuid:string|null; readonly physical:PhysicalTarget};
  readonly project:{readonly schema:1|2; readonly storeUuid:string|null; readonly physical:PhysicalTarget};
  readonly profiles:PhysicalTarget; readonly linkedRoot:string;
  readonly client:null|{
    readonly id:'codex'|'cursor'; readonly root:PhysicalTarget;
    readonly config:string; readonly state:string; readonly recovery:string; readonly backup:string;
  };
}
export type RecoveryGuard = () => void|Promise<void>;
const uuid = (v:unknown): v is string => typeof v === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v) &&
  v !== '00000000-0000-0000-0000-000000000000';
const digest = (v:unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const decimal = (v:unknown, positive = false): v is string => typeof v === 'string' &&
  /^(0|[1-9][0-9]{0,39})$/.test(v) && (!positive || v !== '0');

export function freezeRecovery<T>(value:T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeRecovery(child);
    Object.freeze(value);
  }
  return value;
}
// Used only on already decoded exact DTOs, never as a permissive JSON codec.
export function recoveryValueKey(value:unknown): string {
  if (Array.isArray(value)) return '['+value.map(recoveryValueKey).join(',')+']';
  if (value !== null && typeof value === 'object')
    return '{'+Object.keys(value).sort().map(key => JSON.stringify(key)+':'+recoveryValueKey((value as Record<string,unknown>)[key])).join(',')+'}';
  return JSON.stringify(value);
}
function localPath(value:unknown, optional = false): string {
  if (optional && value === '') return '';
  requireThat(typeof value === 'string' && value.length > 0 && value.length <= 1024 && isAbsolute(value) &&
    Buffer.from(value).toString('utf8') === value && !/[\x00-\x1f\x7f<>"|?*]/.test(value));
  const spelling = value.replaceAll('\\','/'), volume = parse(value).root.replaceAll('\\','/');
  requireThat(!spelling.startsWith('//') && !spelling.replace(/^[A-Za-z]:/,'').includes(':'));
  const tail = spelling.slice(volume.length);
  requireThat(!tail || tail.split('/').every(part => part.length > 0 && part !== '.' && part !== '..' &&
    !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)));
  const normalized = resolve(value).replaceAll('\\','/');
  requireThat(process.platform === 'win32' ? normalized.toLowerCase() === spelling.toLowerCase() : normalized === spelling);
  requireThat(pathParts(value).length <= 64,'LIMIT_EXCEEDED');
  return value;
}
function pathParts(value:string): string[] {
  const volume = parse(value).root, segments = value.slice(volume.length).split(/[\\/]/).filter(Boolean);
  const paths = [volume]; for (const segment of segments) paths.push(join(paths.at(-1)!,segment));
  return paths;
}
const fileKey = (value:string) => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value);
export function checkedPhysicalTarget(value:unknown): PhysicalTarget {
  const o = exact(value,['version','path','kind','state','chain']), path = localPath(o.path);
  requireThat(o.version === 1 && (o.kind === 'file' || o.kind === 'directory') &&
    typeof o.state === 'string' && ['present','missing','unsupported'].includes(o.state) && Array.isArray(o.chain));
  const count = pathParts(path).length;
  requireThat(o.kind === 'directory' || count > 1);
  requireThat(o.state === 'missing' ? o.chain.length < count : o.chain.length === count);
  const chain = o.chain.map(v => {
    if (v === null) return null;
    const p = exact(v,['dev','ino','birthtimeNs']);
    requireThat(decimal(p.dev) && decimal(p.ino,true) && decimal(p.birthtimeNs,true));
    return {dev:p.dev,ino:p.ino,birthtimeNs:p.birthtimeNs};
  });
  requireThat(o.state === 'present' ? chain.every(v => v !== null) :
    o.state === 'unsupported' ? chain.some(v => v === null) : true);
  return freezeRecovery({version:1,path,kind:o.kind,state:o.state as PhysicalTarget['state'],chain});
}
async function physicalSnapshot(path:string, kind:PhysicalTarget['kind'], allowMissing:boolean): Promise<PhysicalTarget> {
  const paths = pathParts(path), chain:(PhysicalIdentity|null)[] = [];
  for (let index = 0; index < paths.length; ++index) {
    let info;
    try { info = await lstat(paths[index],{bigint:true}); }
    catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT')
        return checkedPhysicalTarget({version:1,path,kind,state:'missing',chain});
      throw new ApiError('OWNER_UNAVAILABLE');
    }
    const file = index === paths.length-1 && kind === 'file';
    requireThat(!info.isSymbolicLink() && (file ? info.isFile() && info.nlink === 1n : info.isDirectory()),'OWNER_UNAVAILABLE');
    try { requireThat(fileKey(await realpath(paths[index])) === fileKey(paths[index]),'OWNER_UNAVAILABLE'); }
    catch { throw new ApiError('OWNER_UNAVAILABLE'); }
    const id = {dev:info.dev.toString(),ino:info.ino.toString(),birthtimeNs:info.birthtimeNs.toString()};
    chain.push(decimal(id.dev) && decimal(id.ino,true) && decimal(id.birthtimeNs,true) ? id : null);
  }
  return checkedPhysicalTarget({version:1,path,kind,state:chain.some(v => v === null) ? 'unsupported' : 'present',chain});
}
export async function capturePhysicalTarget(path:string, kind:'file'|'directory', allowMissing = false): Promise<PhysicalTarget> {
  localPath(path); requireThat(kind === 'file' || kind === 'directory');
  requireThat(typeof allowMissing === 'boolean');
  const first = await physicalSnapshot(path,kind,allowMissing), second = await physicalSnapshot(path,kind,allowMissing);
  requireThat(recoveryValueKey(first) === recoveryValueKey(second),'CONFIG_CHANGED');
  return second;
}
export async function verifyPhysicalTarget(value:PhysicalTarget, options:{allowMissing?:boolean} = {}): Promise<void> {
  const target = checkedPhysicalTarget(value);
  requireThat(Object.keys(options).every(k => k === 'allowMissing') &&
    (options.allowMissing === undefined || typeof options.allowMissing === 'boolean'));
  requireThat(target.state === 'present' || (target.state === 'missing' && options.allowMissing === true),'RECOVERY_REQUIRED');
  const current = await capturePhysicalTarget(target.path,target.kind,true);
  requireThat(recoveryValueKey(current) === recoveryValueKey(target),'CONFIG_CHANGED');
}
export function checkedLegacyEffect(value:unknown): LegacyEffect {
  const o = exact(value,value !== null && typeof value === 'object' &&
    ['client_apply','client_restore'].includes(String((value as {kind?:unknown}).kind)) ? ['kind','client'] : ['kind']);
  if (o.kind === 'profile_save' || o.kind === 'desired_proposal') return freezeRecovery({kind:o.kind});
  requireThat((o.kind === 'client_apply' || o.kind === 'client_restore') && (o.client === 'codex' || o.client === 'cursor'));
  return freezeRecovery({kind:o.kind,client:o.client});
}
export function clientTargetNames(client:'codex'|'cursor') {
  requireThat(client === 'codex' || client === 'cursor');
  return {config:client === 'codex' ? '.codex/config.toml' : '.cursor/mcp.json',
    state:`.lmti-client/${client}.state.json`,recovery:`.lmti-client/${client}.recovery.dpapi`,backup:`.lmti-client/${client}.backup.dpapi`};
}
export function checkedLegacyTarget(value:unknown): LegacyOriginalTarget {
  const o = exact(value,['version','action','projectId','domainId','library','project','profiles','linkedRoot','client']);
  requireThat(o.version === 1 && typeof o.action === 'string' && ['profile_save','desired_proposal','client_apply','client_restore'].includes(o.action) &&
    typeof o.projectId === 'string' && /^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(o.projectId) && digest(o.domainId));
  const l = exact(o.library,['schema','canonicalPath','uuid','physical']), p = exact(o.project,['schema','storeUuid','physical']);
  requireThat(typeof l.schema === 'number' && [1,2,3].includes(l.schema) &&
    (l.schema === 1 ? l.uuid === null : uuid(l.uuid)));
  requireThat((p.schema === 1 || p.schema === 2) && (p.schema === 1 ? p.storeUuid === null : uuid(p.storeUuid)));
  const libraryPhysical = checkedPhysicalTarget(l.physical), projectPhysical = checkedPhysicalTarget(p.physical);
  const profiles = checkedPhysicalTarget(o.profiles), linkedRoot = localPath(o.linkedRoot,true);
  requireThat(libraryPhysical.kind === 'file' && projectPhysical.kind === 'file' && profiles.kind === 'file');
  let client:LegacyOriginalTarget['client'] = null;
  if (o.action === 'client_apply' || o.action === 'client_restore') {
    const c = exact(o.client,['id','root','config','state','recovery','backup']);
    requireThat(c.id === 'codex' || c.id === 'cursor');
    const root = checkedPhysicalTarget(c.root), names = clientTargetNames(c.id);
    requireThat(root.kind === 'directory' && root.path === linkedRoot && linkedRoot !== '' &&
      root.path !== parse(root.path).root && !root.path.split(/[\\/]/).some(part => part.toLowerCase() === '.lmti'));
    requireThat(c.config === names.config && c.state === names.state && c.recovery === names.recovery && c.backup === names.backup);
    client = {id:c.id,root,...names};
  } else requireThat(o.client === null);
  const target:LegacyOriginalTarget = {version:1,action:o.action as LegacyEffect['kind'],projectId:o.projectId,domainId:o.domainId,
    library:{schema:l.schema as 1|2|3,canonicalPath:localPath(l.canonicalPath),uuid:l.uuid as string|null,physical:libraryPhysical},
    project:{schema:p.schema,storeUuid:p.storeUuid as string|null,physical:projectPhysical},profiles,linkedRoot,client};
  // Reserve space for the coordinator's subject and entry framing.
  requireThat(Buffer.byteLength(recoveryValueKey(target)) <= 30*1024,'LIMIT_EXCEEDED');
  return freezeRecovery(target);
}
