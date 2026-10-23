import { basename, dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { lstat, open, realpath, stat } from 'node:fs/promises';
import { ApiError, codes, exact, hash, record, requireThat, trustedPath } from './security.js';
import { ProcessPool, WriteOutcomeUnknown } from './process.js';
import { ProjectOperationOwner } from './project-operations-owner.js';
import { LogicalHierarchyOwner, type LogicalHierarchyGrant } from './logical-hierarchy-owner.js';
import { LogicalHierarchyRecovery } from './logical-hierarchy-recovery.js';
import { PhysicalHierarchyOwner, type PhysicalHierarchyGrant } from './physical-hierarchy-owner.js';
import { PhysicalHierarchyRecovery } from './physical-hierarchy-recovery.js';
import type { BrokerGuardConfig } from './broker-guard.js';
import { contentResponse } from './project-content.js';
import type { ContentCollection } from './project-content-contract.js';
import {LibraryManager,type LibraryManagementConfig} from './library-management.js';
import type { ClientId, ProfileDto, McpServerDto } from './contracts.js';
import { capturePhysicalTarget, checkedLegacyEffect, checkedLegacyTarget, clientTargetNames,
  freezeRecovery, recoveryValueKey, verifyPhysicalTarget } from './legacy-recovery-target.js';
import type { LegacyEffect, LegacyOriginalTarget, RecoveryGuard } from './legacy-recovery-target.js';

export interface LaunchConfig {
  adminBinary: string; projectBinary: string; library: string; profiles: string;
  python: string; agentEntry: string; configOwner: string; allowedProjects: string[];
  port: number; openBrowser: boolean;
  agentRead?: {entry: string; projects: AgentGrant[]};
  logicalHierarchy?: {projects: readonly LogicalHierarchyGrant[]};
  physicalHierarchy?: {projects: readonly PhysicalHierarchyGrant[]};
  projectContent?: {projectIds: readonly string[]};
  libraryManagement?: LibraryManagementConfig;
  projectOperations?: {copyParent: string; backupParent: string; projectIds: readonly string[]; allowLibraryUpgrade: boolean};
}
export interface AgentGrant {projectId: string; site: string; target: 'local'|'external'; integrationConfig: string|null}
export type AgentOperation = 'context'|'entity'|'related'|'task_context'|'observations';
export interface DesiredConfig {enabled: boolean; pollMs: number}
export interface ConfigProposal {schema: 'lmti.topology.proposal.v1'; baseRevision: number; assetId: string; site: string; expected: DesiredConfig; desired: DesiredConfig}
export interface ProposalRequest {expectedProjectRevision: number; proposal: ConfigProposal}
const identifier = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(v);
// Finite query vocabulary only. The pinned owner configuration decides whether
// structure is enabled; accepting a kind here never grants that capability.
const agentKinds = ['component','asset','release','repository','knowledge','subsystem','site','area','environment'];
const agentRelationTypes = ['declared_dependency','deployed_to_desired','has_release','declared_connection','implemented_in','documented_by',
  'contains_subsystem','contains_component','contains_area','contains_asset','in_environment'];
export function checkedProposal(value: unknown): ConfigProposal {
  const p = exact(value,['schema','baseRevision','assetId','site','expected','desired']);
  requireThat(p.schema === 'lmti.topology.proposal.v1' && identifier(p.assetId) && identifier(p.site));
  requireThat(typeof p.baseRevision === 'number' && Number.isSafeInteger(p.baseRevision) && p.baseRevision >= 1 && p.baseRevision <= Number.MAX_SAFE_INTEGER-1);
  const config = (v: unknown): DesiredConfig => {
    const c = exact(v,['enabled','pollMs']);
    requireThat(typeof c.enabled === 'boolean' && typeof c.pollMs === 'number' && Number.isInteger(c.pollMs) && c.pollMs >= 100 && c.pollMs <= 3600000);
    return {enabled:c.enabled,pollMs:c.pollMs};
  };
  return {schema:'lmti.topology.proposal.v1',baseRevision:p.baseRevision,assetId:p.assetId,site:p.site,expected:config(p.expected),desired:config(p.desired)};
}
export function agentArguments(operation: unknown, value: unknown): {operation: AgentOperation; arguments: Record<string,unknown>} {
  requireThat(typeof operation === 'string' && ['context','entity','related','task_context','observations'].includes(operation));
  const args = record(value), allowed: Record<string,string[]> = {
    context:['limit','cursor'],entity:['kind','entityId'],related:['kind','entityId','depth','limit','direction','relationTypes','cursor'],
    task_context:['task','kind','entityId','depth'],observations:['assetId']
  };
  requireThat(Object.keys(args).every((key) => allowed[operation].includes(key)) && Object.values(args).every((v) => v !== null));
  if (['entity','related','task_context'].includes(operation)) requireThat(typeof args.kind === 'string' && agentKinds.includes(args.kind) && identifier(args.entityId));
  if (operation === 'observations') requireThat(identifier(args.assetId));
  if (operation === 'task_context') requireThat(typeof args.task === 'string' && args.task.trim() && Buffer.byteLength(args.task) <= 1000 && !/[\x00-\x1f\x7f]/.test(args.task));
  for (const [key,max] of [['limit',200],['depth',operation === 'task_context' ? 4 : 8]] as const)
    if (Object.hasOwn(args,key)) requireThat(typeof args[key] === 'number' && Number.isInteger(args[key]) && (args[key] as number) >= 1 && (args[key] as number) <= max);
  if (Object.hasOwn(args,'cursor')) requireThat(typeof args.cursor === 'string' && args.cursor.length > 0 && args.cursor.length <= 1024);
  if (Object.hasOwn(args,'direction')) requireThat(typeof args.direction === 'string' && ['both','inbound','outbound'].includes(args.direction));
  if (Object.hasOwn(args,'relationTypes')) requireThat(Array.isArray(args.relationTypes) && args.relationTypes.length >= 1 && args.relationTypes.length <= agentRelationTypes.length && new Set(args.relationTypes).size === args.relationTypes.length && args.relationTypes.every((v) => typeof v === 'string' && agentRelationTypes.includes(v)));
  return {operation:operation as AgentOperation,arguments:args};
}
// Private native evidence only. These fields never become browser path authority.
export interface LibraryIdentity {schema: 1|2|3; canonicalPath: string; uuid: string|null; generation: number|null; digest: string}
export interface ProjectIdentity {schema: 1|2; storeUuid: string|null; revision: number}
export interface Binding {
  id: string; name: string; database: string; root: string; projectRevision: number;
  libraryIdentity: LibraryIdentity; projectIdentity: ProjectIdentity;
}
export interface NativeRead {binding: Binding; profile: ProfileDto; content?: string; servers?: Record<string,unknown>}
const ownerUuid = (v: unknown): v is string => typeof v === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v) && v !== '00000000-0000-0000-0000-000000000000';
const ownerDigest = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const ownerInteger = (v: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= minimum && v <= maximum;
const ownerText = (v: unknown, cap = 1024): v is string => typeof v === 'string' &&
  v.length > 0 && Buffer.byteLength(v) <= cap && !/[\x00-\x1f\x7f]/.test(v);
function ownerPath(value: unknown, optional = false): string {
  if (optional && value === '') return '';
  requireThat(typeof value === 'string' && Buffer.byteLength(value) <= 1024 && isAbsolute(value) &&
    !/[\x00-\x1f\x7f]/.test(value),'OWNER_UNAVAILABLE');
  const path = value.replaceAll('\\','/');
  requireThat(!path.startsWith('//') && !path.replace(/^[A-Za-z]:/,'').includes(':'),'OWNER_UNAVAILABLE');
  requireThat(path.split('/').every((part) => !part.endsWith('.') && !part.endsWith(' ') &&
    !part.includes('"') && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)),'OWNER_UNAVAILABLE');
  const normalized = resolve(value).replaceAll('\\','/');
  requireThat(process.platform === 'win32' ? normalized.toLowerCase() === path.toLowerCase() : normalized === path,'OWNER_UNAVAILABLE');
  return value;
}
function checkedLibraryIdentity(value: unknown): LibraryIdentity {
  const o = exact(value,['schema','canonicalPath','uuid','generation','digest']);
  requireThat(o.schema === 1 || o.schema === 2 || o.schema === 3,'OWNER_UNAVAILABLE');
  const canonicalPath = ownerPath(o.canonicalPath);
  // Qt owns this identity spelling (including Unicode case folding). Treat it
  // as an opaque key; only the trusted launcher path selects the native store.
  requireThat(ownerDigest(o.digest),'OWNER_UNAVAILABLE');
  requireThat(o.schema === 1 ? o.uuid === null && o.generation === null :
    ownerUuid(o.uuid) && ownerInteger(o.generation,1),'OWNER_UNAVAILABLE');
  return {schema:o.schema,canonicalPath,uuid:o.uuid as string|null,generation:o.generation as number|null,digest:o.digest};
}
function checkedBinding(value: unknown, project?: unknown): Binding {
  const b = exact(value,['id','name','database','root','projectRevision','libraryIdentity','projectIdentity']);
  requireThat(identifier(b.id) && (project === undefined || b.id === project) && ownerText(b.name) &&
    ownerInteger(b.projectRevision,1,Number.MAX_SAFE_INTEGER-1),'OWNER_UNAVAILABLE');
  const libraryIdentity = checkedLibraryIdentity(b.libraryIdentity);
  const p = exact(b.projectIdentity,['schema','storeUuid','revision']);
  requireThat((p.schema === 1 || p.schema === 2) && p.revision === b.projectRevision &&
    (p.schema === 1 ? p.storeUuid === null : ownerUuid(p.storeUuid)),'OWNER_UNAVAILABLE');
  return {id:b.id,name:b.name,database:ownerPath(b.database),root:ownerPath(b.root,true),projectRevision:b.projectRevision,
    libraryIdentity,projectIdentity:{schema:p.schema,storeUuid:p.storeUuid as string|null,revision:b.projectRevision}};
}
function checkedProfile(value: unknown, project: string): ProfileDto {
  const p = exact(value,['projectId','revision','servers']);
  requireThat(p.projectId === project && ownerInteger(p.revision,0) && Array.isArray(p.servers) && p.servers.length <= 32,'OWNER_UNAVAILABLE');
  const ids = new Set<string>();
  const servers = p.servers.map((value): McpServerDto => {
    const item = record(value), local = item.transport === 'lmti_local';
    const s = exact(item,['id','label','enabled','transport','auth',...(local ? ['site'] : ['endpoint','privateEndpoint'])]);
    requireThat(typeof s.id === 'string' && /^[a-z][a-z0-9_-]{0,47}$/.test(s.id) && !ids.has(s.id) &&
      ownerText(s.label,120) && typeof s.enabled === 'boolean','OWNER_UNAVAILABLE'); ids.add(s.id);
    if (local) {
      requireThat(s.auth === 'none' && ownerText(s.site,64),'OWNER_UNAVAILABLE');
      return {id:s.id,label:s.label,enabled:s.enabled,transport:'lmti_local',auth:'none',site:s.site};
    }
    requireThat(s.transport === 'remote_https' && s.auth === 'client_oauth' && ownerText(s.endpoint,512) &&
      typeof s.privateEndpoint === 'boolean','OWNER_UNAVAILABLE');
    return {id:s.id,label:s.label,enabled:s.enabled,transport:'remote_https',auth:'client_oauth',endpoint:s.endpoint,privateEndpoint:s.privateEndpoint};
  });
  return {projectId:project,revision:p.revision,servers};
}
function ownerDto<T>(parse: () => T): T {
  try { return parse(); } catch { throw new ApiError('OWNER_UNAVAILABLE'); }
}
// These stricter checks apply to the optional participating operation runtime.
// Check every raw spelling before any filesystem call, then walk volume-first.
function operationPath(value: unknown): string {
  requireThat(typeof value === 'string' && value.length > 0 && value.length <= 1024 && isAbsolute(value) &&
    !/[\x00-\x1f\x7f<>"|?*]/.test(value),'OWNER_UNAVAILABLE');
  const normalized = value.replaceAll('\\','/');
  requireThat(!normalized.startsWith('//') && !normalized.replace(/^[A-Za-z]:/,'').includes(':'),'OWNER_UNAVAILABLE');
  const tail = normalized.slice(parse(value).root.replaceAll('\\','/').length);
  requireThat(!tail || tail.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..' &&
    !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)),'OWNER_UNAVAILABLE');
  return value;
}
const pathKey = (value: string) => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value);
async function operationLocation(value: string, kind: 'file'|'directory', optional = false): Promise<void> {
  operationPath(value);
  const location = resolve(value), volume = parse(location).root;
  const segments = location.slice(volume.length).split(/[\\/]/).filter(Boolean);
  let current = volume;
  for (let index = -1; index < segments.length; index++) {
    if (index >= 0) current = join(current,segments[index]);
    const leaf = index === segments.length-1;
    let info;
    try { info = await lstat(current); }
    catch (error) {
      if (optional && leaf && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new ApiError('OWNER_UNAVAILABLE');
    }
    requireThat(!info.isSymbolicLink() && (leaf && kind === 'file' ? info.isFile() && info.nlink === 1 : info.isDirectory()),'OWNER_UNAVAILABLE');
    try { requireThat(pathKey(await realpath(current)) === pathKey(current),'OWNER_UNAVAILABLE'); }
    catch { throw new ApiError('OWNER_UNAVAILABLE'); }
  }
}
function frozenConfig(value: LaunchConfig): LaunchConfig {
  try {
    const copy = structuredClone(value), seen = new WeakSet<object>();
    const freeze = (v: unknown) => {
      if (v && typeof v === 'object' && !seen.has(v)) {
        seen.add(v); for (const child of Object.values(v)) freeze(child); Object.freeze(v);
      }
    };
    freeze(copy); return copy;
  } catch { throw new ApiError('INVALID_INPUT'); }
}
function checkedOwnerFailure(value: unknown, write: boolean, python = false): Record<string,unknown> {
  let result: Record<string,unknown>;
  try {
    result = record(value);
    if (result.ok === true) return result;
    exact(result,python ? ['ok','code','error'] : ['ok','code']);
    requireThat(result.ok === false && codes.includes(result.code as never) &&
      (!python || ownerText(result.error,1024)),'OWNER_UNAVAILABLE');
  } catch { if (write) throw new WriteOutcomeUnknown(); throw new ApiError('OWNER_UNAVAILABLE'); }
  if (write && ['OWNER_UNAVAILABLE','RECOVERY_REQUIRED'].includes(String(result.code))) throw new WriteOutcomeUnknown();
  throw new ApiError(result.code as ApiError['code']);
}
export class Owners {
  libraryManager:LibraryManager|null=null;
  readonly pool = new ProcessPool();
  // A queued write cannot use its occupied main-pool slot to queue another
  // owner read. This dedicated one-slot verifier prevents that deadlock while
  // preserving a strict bound on child processes.
  private readonly verificationPool = new ProcessPool(1);
  private readonly integrationPins = new Map<string,{path:string|null; digest:string|null; revoked?:boolean}>();
  private readonly permitted: Set<string>;
  readonly config: LaunchConfig;
  private operationOwner: ProjectOperationOwner|null = null;
  private hierarchyOwner: LogicalHierarchyOwner|null = null;
  private hierarchyRecoveryOwner: LogicalHierarchyRecovery|null = null;
  private physicalOwner: PhysicalHierarchyOwner|null = null;
  private physicalRecoveryOwner: PhysicalHierarchyRecovery|null = null;
  private guardConfig: BrokerGuardConfig|null = null;
  private operationFingerprint: string|null = null;
  private recoveryFingerprint: string|null = null;
  constructor(config: LaunchConfig) {
    this.config = frozenConfig(config);
    this.permitted = new Set(Array.isArray(this.config.allowedProjects) ? this.config.allowedProjects : []);
  }
  get projectOperationOwner(): ProjectOperationOwner|null { return this.operationOwner; }
  get logicalHierarchyOwner(): LogicalHierarchyOwner|null { return this.hierarchyOwner; }
  get hierarchyRecovery(): LogicalHierarchyRecovery|null { return this.hierarchyRecoveryOwner; }
  hasLogicalHierarchy(project:string): boolean { return this.hierarchyOwner !== null && this.permitted.has(project) && this.hierarchyOwner.has(project); }
  hierarchyGrants(): readonly LogicalHierarchyGrant[] { return this.hierarchyOwner?.config.projects ?? Object.freeze([]); }
  hierarchyGrantId(project:string): string {
    const grant = this.hierarchyGrants().find(g => g.projectId === project);
    requireThat(grant && this.permitted.has(project),'SCOPE_DENIED');
    return hash(recoveryValueKey({domainId:this.recoveryDomainId(),projectId:grant.projectId,allowInternal:grant.allowInternal}));
  }
  get physicalHierarchyOwner(): PhysicalHierarchyOwner|null { return this.physicalOwner; }
  get physicalHierarchyRecovery(): PhysicalHierarchyRecovery|null { return this.physicalRecoveryOwner; }
  hasPhysicalHierarchy(project:string): boolean { return this.physicalOwner !== null && this.permitted.has(project) && this.physicalOwner.has(project); }
  physicalHierarchyGrants(): readonly PhysicalHierarchyGrant[] { return this.physicalOwner?.config.projects ?? Object.freeze([]); }
  physicalHierarchyGrantId(project:string): string {
    const grant = this.physicalHierarchyGrants().find(g => g.projectId === project);
    requireThat(grant && this.permitted.has(project),'SCOPE_DENIED');
    return hash(recoveryValueKey({domainId:this.recoveryDomainId(),kind:'physical_hierarchy',
      projectId:grant.projectId,allowInternal:grant.allowInternal}));
  }
  get brokerGuardConfig(): BrokerGuardConfig|null { return this.guardConfig; }
  hasProjectOperations(project: string): boolean {
    return this.operationOwner !== null && this.permitted.has(project) && this.config.projectOperations!.projectIds.includes(project);
  }
  operationGrantId(): string { requireThat(this.operationFingerprint !== null,'NOT_SUPPORTED'); return this.operationFingerprint; }
  recoveryDomainId(): string { requireThat(this.recoveryFingerprint !== null,'NOT_SUPPORTED'); return this.recoveryFingerprint; }
  isIdle(): boolean { return this.pool.isIdle() && this.verificationPool.isIdle(); }
  async waitForIdle(): Promise<void> { await Promise.all([this.pool.waitForIdle(),this.verificationPool.waitForIdle()]); }
  private async validateOperations(): Promise<void> {
    const op = exact(this.config.projectOperations,['copyParent','backupParent','projectIds','allowLibraryUpgrade']);
    requireThat(typeof op.allowLibraryUpgrade === 'boolean' && Array.isArray(op.projectIds) && op.projectIds.length <= 500 &&
      new Set(op.projectIds).size === op.projectIds.length && op.projectIds.every((id) => identifier(id) && this.permitted.has(id)) &&
      (op.projectIds.length > 0 || op.allowLibraryUpgrade));
    const paths = [op.copyParent,op.backupParent,this.config.adminBinary,this.config.projectBinary,this.config.python,
      this.config.agentEntry,this.config.configOwner,this.config.library,this.config.profiles];
    for (const value of paths) operationPath(value);
    const helper = join(dirname(this.config.configOwner),'web-broker-guard.py'); operationPath(helper);
    requireThat(basename(dirname(this.config.adminBinary)).toLowerCase() === 'bin','OWNER_UNAVAILABLE');
    const packageRoot = pathKey(dirname(dirname(this.config.adminBinary)));
    const outside = (value: string) => {
      const key = pathKey(value);
      requireThat(key !== packageRoot && !key.startsWith(packageRoot+parse(value).root.slice(-1)) &&
        !value.split(/[\\/]/).some(part => part.toLowerCase() === '.lmti'),'SCOPE_DENIED');
    };
    for (const value of [op.copyParent,op.backupParent,dirname(this.config.library),dirname(this.config.profiles)]) outside(value as string);
    requireThat(pathKey(op.copyParent as string) !== pathKey(op.backupParent as string),'SCOPE_DENIED');
    for (const value of [op.copyParent,op.backupParent]) await operationLocation(value as string,'directory');
    for (const value of [this.config.adminBinary,this.config.projectBinary,this.config.python,this.config.agentEntry,this.config.configOwner,helper])
      await operationLocation(value,'file');
    for (const value of [this.config.library,this.config.profiles]) await operationLocation(value,'file',true);
  }
  private async validateHierarchy(value:unknown): Promise<void> {
    const h = exact(value,['projects']);
    requireThat(Array.isArray(h.projects) && h.projects.length > 0 && h.projects.length <= 500);
    const ids = new Set<string>();
    for (const value of h.projects) {
      const g = exact(value,['projectId','allowInternal']);
      requireThat(identifier(g.projectId) && this.permitted.has(g.projectId) && !ids.has(g.projectId) && typeof g.allowInternal === 'boolean');
      ids.add(g.projectId);
    }
    operationPath(this.config.configOwner);
    const helper = join(dirname(this.config.configOwner),'web-broker-guard.py');
    const files = [this.config.adminBinary,this.config.projectBinary,this.config.python,this.config.agentEntry,this.config.configOwner,helper];
    for (const value of [...files,this.config.library,this.config.profiles]) operationPath(value);
    requireThat(basename(dirname(this.config.adminBinary)).toLowerCase() === 'bin','OWNER_UNAVAILABLE');
    const packageRoot = pathKey(dirname(dirname(this.config.adminBinary)));
    for (const value of [this.config.library,this.config.profiles]) {
      const key = pathKey(value);
      requireThat(key !== packageRoot && !key.startsWith(packageRoot+sep) &&
        !value.split(/[\\/]/).some(part => part.toLowerCase() === '.lmti'),'SCOPE_DENIED');
    }
    for (const value of files) await operationLocation(value,'file');
    for (const value of [this.config.library,this.config.profiles]) await operationLocation(value,'file',true);
    if (this.config.agentRead) {
      const read = exact(this.config.agentRead,['entry','projects']); requireThat(Array.isArray(read.projects));
      operationPath(read.entry); await operationLocation(read.entry as string,'file');
      for (const value of read.projects) {
        const grant = exact(value,['projectId','site','target','integrationConfig']);
        if (grant.integrationConfig !== null) {
          operationPath(grant.integrationConfig); await operationLocation(grant.integrationConfig as string,'file');
        }
      }
    }
  }
  async validateLaunch() {
    exact(this.config,['adminBinary','projectBinary','library','profiles','python','agentEntry','configOwner','allowedProjects','port','openBrowser',...(Object.hasOwn(this.config,'agentRead') ? ['agentRead'] : []),...(Object.hasOwn(this.config,'projectOperations') ? ['projectOperations'] : []),...(Object.hasOwn(this.config,'logicalHierarchy') ? ['logicalHierarchy'] : []),...(Object.hasOwn(this.config,'physicalHierarchy') ? ['physicalHierarchy'] : []),...(Object.hasOwn(this.config,'projectContent') ? ['projectContent'] : []),...(Object.hasOwn(this.config,'libraryManagement') ? ['libraryManagement'] : [])]);
    requireThat(Number.isInteger(this.config.port) && this.config.port >= 0 && this.config.port <= 65535);
    requireThat(typeof this.config.openBrowser === 'boolean');
    requireThat(Array.isArray(this.config.allowedProjects) && this.config.allowedProjects.length <= 500 && this.permitted.size === this.config.allowedProjects.length && this.config.allowedProjects.every((s) => typeof s === 'string' && /^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(s)));
    if (Object.hasOwn(this.config,'projectOperations')) await this.validateOperations();
    if (Object.hasOwn(this.config,'logicalHierarchy')) await this.validateHierarchy(this.config.logicalHierarchy);
    if (Object.hasOwn(this.config,'physicalHierarchy')) await this.validateHierarchy(this.config.physicalHierarchy);
    for (const path of [this.config.adminBinary,this.config.projectBinary,this.config.python,this.config.agentEntry,this.config.configOwner]) await trustedPath(path,'file');
    requireThat(['lmti-mcp-admin','lmti-mcp-admin.exe'].includes(basename(this.config.adminBinary)) && ['lmti-project','lmti-project.exe'].includes(basename(this.config.projectBinary)) && basename(this.config.agentEntry) === 'lmti-agent-mcp.py' && basename(this.config.configOwner) === 'mcp-config-owner.py','OWNER_UNAVAILABLE');
    await trustedPath(this.config.library,'file',true); await trustedPath(this.config.profiles,'file',true);
    if (Object.hasOwn(this.config,'agentRead')) {
      const read = exact(this.config.agentRead,['entry','projects']);
      requireThat(typeof read.entry === 'string' && basename(read.entry) === 'agent-read-owner.py','OWNER_UNAVAILABLE');
      await trustedPath(read.entry,'file');
      requireThat(Array.isArray(read.projects) && read.projects.length <= 500);
      const ids = new Set<string>();
      for (const value of read.projects) {
        const p = exact(value,['projectId','site','target','integrationConfig']);
        requireThat(identifier(p.projectId) && this.permitted.has(p.projectId) && !ids.has(p.projectId) && identifier(p.site) && (p.target === 'local' || p.target === 'external') && (p.integrationConfig === null || typeof p.integrationConfig === 'string'));
        ids.add(p.projectId);
        const pin = {path:p.integrationConfig as string|null,digest:p.integrationConfig === null ? null : await this.integrationFingerprint(p.integrationConfig as string)};
        const previous = this.integrationPins.get(p.projectId);
        requireThat(!previous || (!previous.revoked && previous.path === pin.path && previous.digest === pin.digest),'CONFIG_CHANGED');
        this.integrationPins.set(p.projectId,pin);
      }
    }
    if(this.config.projectContent){
      const value=exact(this.config.projectContent,['projectIds']);
      requireThat(Array.isArray(value.projectIds)&&value.projectIds.length<=500&&new Set(value.projectIds).size===value.projectIds.length&&value.projectIds.every(id=>identifier(id)&&this.permitted.has(id)));
    }
    // Every write family participates, including a legacy-only launcher. The
    if(this.config.libraryManagement){
      const manager=new LibraryManager(this.config.libraryManagement,this.config.projectBinary,this.config.library,this.pool,this.verificationPool,()=>this.recoveryDomainId());
      await manager.validate();if(!this.libraryManager)this.libraryManager=manager;
    }
    // fixed sibling helper is a trusted launch dependency, never a request path.
    const helper = join(dirname(this.config.configOwner),'web-broker-guard.py');
    await operationLocation(helper,'file');
    const domain = hash(recoveryValueKey({
      adminBinary:this.config.adminBinary,projectBinary:this.config.projectBinary,python:this.config.python,
      agentEntry:this.config.agentEntry,configOwner:this.config.configOwner,helper,
      library:this.config.library,profiles:this.config.profiles,allowedProjects:[...this.permitted].sort(),
      agentRead:this.config.agentRead ? {entry:this.config.agentRead.entry,projects:this.config.agentRead.projects
        .map(p => ({...p,integrationSha256:this.integrationPins.get(p.projectId)!.digest}))
        .sort((a,b) => a.projectId < b.projectId ? -1 : a.projectId > b.projectId ? 1 : 0)} : null,
      projectOperations:this.config.projectOperations ? {...this.config.projectOperations,
        projectIds:[...this.config.projectOperations.projectIds].sort()} : null,
      ...(this.config.projectContent ? {projectContent:{projectIds:[...this.config.projectContent.projectIds].sort()}} : {}),
      ...(this.config.libraryManagement ? {libraryManagement:this.config.libraryManagement} : {}),
      // Absence preserves the exact legacy domain object and hash.
      ...(this.config.logicalHierarchy ? {logicalHierarchy:{projects:[...this.config.logicalHierarchy.projects]
        .sort((a,b) => a.projectId < b.projectId ? -1 : a.projectId > b.projectId ? 1 : 0)}} : {}),
      ...(this.config.physicalHierarchy ? {physicalHierarchy:{projects:[...this.config.physicalHierarchy.projects]
        .sort((a,b) => a.projectId < b.projectId ? -1 : a.projectId > b.projectId ? 1 : 0)}} : {})
    }));
    requireThat(this.recoveryFingerprint === null || this.recoveryFingerprint === domain,'CONFIG_CHANGED');
    if (this.config.projectOperations && this.operationOwner === null) {
      const op = this.config.projectOperations;
      const owner = new ProjectOperationOwner({adminBinary:this.config.adminBinary,library:this.config.library,
        copyParent:op.copyParent,backupParent:op.backupParent},this.pool,this.verificationPool);
      const fingerprint = hash(JSON.stringify([this.config.adminBinary,this.config.library,op.copyParent,op.backupParent,
        [...op.projectIds].sort(),op.allowLibraryUpgrade]));
      this.operationOwner = owner; this.operationFingerprint = fingerprint;
    }
    this.recoveryFingerprint = domain;
    if (this.config.logicalHierarchy && this.hierarchyOwner === null) {
      this.hierarchyOwner = new LogicalHierarchyOwner({adminBinary:this.config.adminBinary,library:this.config.library,
        projects:this.config.logicalHierarchy.projects},this.pool,this.verificationPool);
      this.hierarchyRecoveryOwner = new LogicalHierarchyRecovery(this.hierarchyOwner,project => this.hierarchyGrantId(project));
    }
    if (this.config.physicalHierarchy && this.physicalOwner === null) {
      this.physicalOwner = new PhysicalHierarchyOwner({adminBinary:this.config.adminBinary,library:this.config.library,
        projects:this.config.physicalHierarchy.projects},this.pool,this.verificationPool);
      this.physicalRecoveryOwner = new PhysicalHierarchyRecovery(this.physicalOwner,project => this.physicalHierarchyGrantId(project));
    }
    this.guardConfig = Object.freeze({python:this.config.python,helper,library:this.config.library,domainId:domain});
  }
  private trustedLegacyTarget(value:LegacyOriginalTarget): LegacyOriginalTarget {
    const target = checkedLegacyTarget(value);
    requireThat(target.domainId === this.recoveryDomainId() && target.library.physical.path === this.config.library &&
      target.profiles.path === this.config.profiles,'SCOPE_DENIED');
    this.scope(target.projectId); return target;
  }
  private async readOriginalLegacyTarget(target:LegacyOriginalTarget, allowMissingProfile:boolean, guard:RecoveryGuard): Promise<NativeRead> {
    // Native compares the original locator and physical identities before opening
    // its project under held Windows namespace leases. Never fall back to read().
    const input = JSON.stringify({action:'read-original',allowMissingProfile,expected:{
      version:1,projectId:target.projectId,library:target.library,project:target.project,
      profiles:target.profiles,linkedRoot:target.linkedRoot
    }});
    requireThat(Buffer.byteLength(input) <= 64*1024,'LIMIT_EXCEEDED');
    await trustedPath(this.config.adminBinary,'file');
    let raw:unknown;
    try {
      raw = await this.verificationPool.run(this.config.adminBinary,[
        '--original-binding-read','--library',this.config.library,'--profiles',this.config.profiles
      ],input,{cap:128*1024,newlineTerminated:true,timeoutMs:30000,guard});
    } catch (error) {
      // Preserve admission/session failures from the queued guard. Transport
      // errors have the pool's bounded code; unexpected failures reveal nothing.
      if (error instanceof ApiError) throw error;
      throw new ApiError('OWNER_UNAVAILABLE');
    }
    const result = ownerDto(() => record(raw));
    if (result.ok === false) {
      const code = ownerDto(() => {
        exact(result,['ok','code']);
        requireThat(typeof result.code === 'string' && [
          'INVALID_INPUT','SCOPE_DENIED','CONFIG_CHANGED','OWNER_UNAVAILABLE',
          'NOT_SUPPORTED','LIMIT_EXCEEDED','RECOVERY_REQUIRED'
        ].includes(result.code),'OWNER_UNAVAILABLE');
        return result.code as ApiError['code'];
      });
      throw new ApiError(code);
    }
    return ownerDto(() => {
      exact(result,['ok','schema','action','binding','profile']);
      requireThat(result.ok === true && result.schema === 'lmti.mcp.original-read.v1' &&
        result.action === 'read-original','OWNER_UNAVAILABLE');
      return {binding:checkedBinding(result.binding,target.projectId),profile:checkedProfile(result.profile,target.projectId)};
    });
  }
  async captureLegacyTarget(read:NativeRead, value:LegacyEffect): Promise<LegacyOriginalTarget> {
    const effect = checkedLegacyEffect(value), binding = checkedBinding(read.binding,read.profile.projectId);
    checkedProfile(read.profile,binding.id); this.scope(binding.id);
    const domainId = this.recoveryDomainId();
    const library = await capturePhysicalTarget(this.config.library,'file');
    const target = checkedLegacyTarget({
      version:1,action:effect.kind,projectId:binding.id,domainId,
      library:{schema:binding.libraryIdentity.schema,canonicalPath:binding.libraryIdentity.canonicalPath,uuid:binding.libraryIdentity.uuid,physical:library},
      project:{schema:binding.projectIdentity.schema,storeUuid:binding.projectIdentity.storeUuid,
        physical:await capturePhysicalTarget(binding.database,'file')},
      profiles:await capturePhysicalTarget(this.config.profiles,'file',true),linkedRoot:binding.root,
      client:'client' in effect ? {id:effect.client,root:await capturePhysicalTarget(binding.root,'directory'),
        ...clientTargetNames(effect.client)} : null
    });
    const fresh = await this.verifyLegacyTarget(target,{verify:true,allowMissing:true});
    requireThat(this.bindingId(fresh) === this.bindingId(read) &&
      recoveryValueKey(fresh.profile) === recoveryValueKey(read.profile),'REVISION_CONFLICT');
    return target;
  }
  async verifyLegacyTarget(value:LegacyOriginalTarget, options:{guard?:RecoveryGuard;verify:true;allowMissing?:boolean}): Promise<NativeRead> {
    requireThat(options.verify === true);
    const target = this.trustedLegacyTarget(value), guard = options.guard;
    const physical = async () => {
      await verifyPhysicalTarget(target.library.physical);
      await verifyPhysicalTarget(target.project.physical);
      await verifyPhysicalTarget(target.profiles,{allowMissing:options.allowMissing});
      if (target.client) await verifyPhysicalTarget(target.client.root);
    };
    await guard?.(); await physical(); await guard?.();
    const current = await this.readOriginalLegacyTarget(target,options.allowMissing === true,async () => {
      await guard?.(); await physical(); await guard?.();
    });
    requireThat(current.binding.database === target.project.physical.path && current.binding.root === target.linkedRoot &&
      current.binding.projectIdentity.schema === target.project.schema &&
      current.binding.projectIdentity.storeUuid === target.project.storeUuid &&
      current.binding.libraryIdentity.schema === target.library.schema &&
      current.binding.libraryIdentity.canonicalPath === target.library.canonicalPath &&
      current.binding.libraryIdentity.uuid === target.library.uuid,'CONFIG_CHANGED');
    await physical(); await guard?.(); return current;
  }
  async inspectLegacyRecovery(value:LegacyOriginalTarget, options:{guard?:RecoveryGuard;verify:true}): Promise<{
    evidence:unknown;summary:{projectId:string;projectRevision:number;profileRevision:number;clients:{client:ClientId;state:string}[]}
  }> {
    const target = this.trustedLegacyTarget(value), current = await this.verifyLegacyTarget(target,options);
    let inspection:Record<string,unknown>|null = null;
    if (target.client) {
      await options.guard?.();
      await trustedPath(this.config.configOwner,'file');
      const raw = await this.verificationPool.run(this.config.python,['-I',this.config.configOwner],JSON.stringify({
        action:'inspect',root:target.client.root.path,project:target.projectId,client:target.client.id
      }),{cap:32768,timeoutMs:8000,guard:async () => {
        await options.guard?.(); await verifyPhysicalTarget(target.client!.root); await options.guard?.();
      }});
      const result = checkedOwnerFailure(raw,false,true), o = exact(result,['ok','state','appliedRevision','canRestore','verified']);
      requireThat(typeof o.state === 'string' && ['not_applied','configured','recovery_required'].includes(o.state) && o.verified === false &&
        typeof o.canRestore === 'boolean' && (o.appliedRevision === null || ownerInteger(o.appliedRevision,0)),'OWNER_UNAVAILABLE');
      requireThat((o.state !== 'not_applied' || o.appliedRevision === null) &&
        (o.state !== 'configured' || o.appliedRevision !== null) &&
        (o.state !== 'recovery_required' || o.canRestore === true),'OWNER_UNAVAILABLE');
      inspection = {state:o.state,appliedRevision:o.appliedRevision,canRestore:o.canRestore,verified:false};
    }
    const after = await this.verifyLegacyTarget(target,options);
    requireThat(recoveryValueKey(current) === recoveryValueKey(after),'CONFIG_CHANGED');
    return freezeRecovery({evidence:{binding:after.binding,profile:after.profile,client:inspection},
      summary:{projectId:target.projectId,projectRevision:after.binding.projectRevision,profileRevision:after.profile.revision,
        clients:target.client && inspection ? [{client:target.client.id,state:inspection.state as string}] : []}});
  }
  private async integrationFingerprint(path: string): Promise<string> {
    await trustedPath(path,'file');
    const before = await stat(path,{bigint:true});
    requireThat(before.size <= 65536n,'OWNER_UNAVAILABLE');
    const handle = await open(path,'r');
    try {
      const opened = await handle.stat({bigint:true});
      requireThat(opened.dev === before.dev && opened.ino === before.ino && opened.size === before.size && opened.mtimeNs === before.mtimeNs,'CONFIG_CHANGED');
      const bytes = Buffer.alloc(65537), {bytesRead} = await handle.read(bytes,0,bytes.length,0);
      const afterHandle = await handle.stat({bigint:true});
      await trustedPath(path,'file');
      const after = await stat(path,{bigint:true});
      requireThat(BigInt(bytesRead) === opened.size && bytesRead <= 65536 &&
        afterHandle.size === opened.size && afterHandle.mtimeNs === opened.mtimeNs &&
        after.dev === opened.dev && after.ino === opened.ino && after.size === opened.size && after.mtimeNs === opened.mtimeNs,'CONFIG_CHANGED');
      return createHash('sha256').update(bytes.subarray(0,bytesRead)).digest('hex');
    } finally { await handle.close(); }
  }
  async verifyIntegration(grant: AgentGrant) {
    const pin = this.integrationPins.get(grant.projectId);
    requireThat(pin && !pin.revoked,'SCOPE_DENIED');
    if (pin.path !== grant.integrationConfig) { pin.revoked = true; throw new ApiError('SCOPE_DENIED'); }
    if (pin.path === null) return;
    let digest: string;
    try { digest = await this.integrationFingerprint(pin.path); }
    catch (e) { pin.revoked = true; if (e instanceof ApiError && e.code === 'CONFIG_CHANGED') throw e; throw new ApiError('SCOPE_DENIED'); }
    if (digest !== pin.digest) { pin.revoked = true; throw new ApiError('CONFIG_CHANGED'); }
  }
  private async verifyBinding(read: NativeRead, profile = false) {
    this.scope(read.binding.id);
    const current = this.checkedRead(await this.native({action:'read',projectId:read.binding.id},false,undefined,this.verificationPool),read.binding.id);
    requireThat(current.binding.projectRevision === read.binding.projectRevision,'REVISION_CONFLICT');
    requireThat(this.bindingId(current) === this.bindingId(read),'CONFIG_CHANGED');
    if (profile) requireThat(JSON.stringify(current.profile) === JSON.stringify(read.profile),'REVISION_CONFLICT');
  }
  hasAgent(project: string) { return this.permitted.has(project) && this.config.agentRead?.projects.some((p) => p.projectId === project) === true; }
  agentGrant(project: string): AgentGrant {
    this.scope(project); requireThat(this.config.agentRead,'NOT_SUPPORTED');
    const grant = this.config.agentRead.projects.find((p) => p.projectId === project);
    requireThat(grant,'SCOPE_DENIED'); return {...grant};
  }
  grantId(grant: AgentGrant) { return hash(JSON.stringify([this.config.agentRead?.entry,grant.projectId,grant.site,grant.target,grant.integrationConfig,this.integrationPins.get(grant.projectId)?.digest])); }
  async agent(read: NativeRead, grant: AgentGrant, operation: AgentOperation, args: Record<string,unknown>, cursorKey: string, guard?: RecoveryGuard) {
    const entry = this.config.agentRead!.entry;
    for (const path of [entry,this.config.python,this.config.projectBinary,read.binding.database]) await trustedPath(path,'file');
    requireThat(/^[0-9a-f]{64}$/.test(cursorKey),'OWNER_UNAVAILABLE');
    await this.verifyIntegration(grant);
    const integrationSha256 = this.integrationPins.get(grant.projectId)!.digest;
    requireThat(grant.integrationConfig === null ? integrationSha256 === null :
      typeof integrationSha256 === 'string' && /^[0-9a-f]{64}$/.test(integrationSha256),'SCOPE_DENIED');
    let result: Record<string,unknown>;
    try {
      // Isolated Python ignores PYTHONIOENCODING. Explicit UTF-8 preserves
      // Vietnamese metadata through its piped JSON stdout on Windows.
      result = this.privateResult(await this.pool.run(this.config.python,['-I','-X','utf8',entry],JSON.stringify({
        binary:this.config.projectBinary,database:read.binding.database,projectId:grant.projectId,
        site:grant.site,target:grant.target,integrationConfig:grant.integrationConfig,integrationSha256,operation,arguments:args,cursorKey
      }),{cap:513*1024,timeoutMs:15000,guard:async () => {
        await guard?.(); await this.verifyIntegration(grant); await this.verifyBinding(read);
        await guard?.(); await this.verifyIntegration(grant);
      }}));
    } catch (error) {
      // A child may reject its pin before returning an envelope. Detect and
      // latch that same source change in the parent even on this failure path.
      await guard?.();
      try { await this.verifyIntegration(grant); }
      catch (changed) {
        // The queued guard may already have latched this exact change.
        if (error instanceof ApiError && error.code === 'CONFIG_CHANGED' &&
            changed instanceof ApiError && changed.code === 'SCOPE_DENIED') throw error;
        throw changed;
      }
      throw error;
    }
    try {
      exact(result,['ok','response']);
      const response = exact(result.response,['schema','operation','status','scope','sources','evidence','completeness','data','unknowns','conflicts','error']);
      requireThat(response.schema === 'lmti.agent.response.v1' && response.operation === `project.${operation}` && ['ok','partial','error'].includes(String(response.status)),'OWNER_UNAVAILABLE');
      if (response.status === 'error') requireThat(response.scope === null && response.data === null,'OWNER_UNAVAILABLE');
      else {
        const scope = record(response.scope);
        requireThat(scope.projectId === grant.projectId && scope.site === grant.site && scope.modelTarget === grant.target,'OWNER_UNAVAILABLE');
      }
      requireThat(Buffer.byteLength(JSON.stringify(response)) <= 240*1024,'LIMIT_EXCEEDED');
      return response;
    } catch (e) { if (e instanceof ApiError && e.code === 'LIMIT_EXCEEDED') throw e; throw new ApiError('OWNER_UNAVAILABLE'); }
  }
  async proposal(read: NativeRead, grant: AgentGrant, action: 'proposal-asset'|'review-proposal'|'commit-proposal', request: ProposalRequest|string, guard?: RecoveryGuard): Promise<Record<string,unknown>> {
    for (const path of [this.config.projectBinary,read.binding.database]) await trustedPath(path,'file');
    const inspect = action === 'proposal-asset';
    const args = [action,read.binding.database,grant.projectId,grant.site,grant.target];
    if (inspect) { requireThat(identifier(request)); args.push(request); }
    const input = inspect ? '' : JSON.stringify(request); requireThat(Buffer.byteLength(input) <= 4096,'LIMIT_EXCEEDED');
    const raw = await this.pool.run(this.config.projectBinary,args,input,{cap:4096,write:action === 'commit-proposal',projectProposalErrors:true,guard:async () => {
      await guard?.(); await this.verifyIntegration(grant); await this.verifyBinding(read);
      await guard?.(); await this.verifyIntegration(grant);
    }});
    let value: Record<string,unknown>;
    let refusal: ApiError['code']|null = null;
    try {
      value = record(raw);
      if (value.ok !== true) {
        exact(value,['ok','error']); const failure = exact(value.error,['code']);
        requireThat(value.ok === false && typeof failure.code === 'string' && ['CONFIG_CONFLICT','INVALID_INPUT','SCOPE_DENIED','REVISION_CONFLICT','OWNER_UNAVAILABLE'].includes(String(failure.code)),'OWNER_UNAVAILABLE');
        refusal = failure.code === 'CONFIG_CONFLICT' ? 'CONFIG_CHANGED' : failure.code as ApiError['code'];
      }
    } catch { if (action === 'commit-proposal') throw new WriteOutcomeUnknown(); throw new ApiError('OWNER_UNAVAILABLE'); }
    if (refusal) {
      if (action === 'commit-proposal' && refusal === 'OWNER_UNAVAILABLE') throw new WriteOutcomeUnknown();
      throw new ApiError(refusal);
    }
    try {
      exact(value,inspect ? ['ok','projectId','projectRevision','topologyRevision','asset'] : ['ok','projectId','projectRevision','topologyRevision','proposal','diff','status','deviceActions']);
      requireThat(value.projectId === grant.projectId && typeof value.projectRevision === 'number' && Number.isSafeInteger(value.projectRevision) && value.projectRevision > 0 && value.topologyRevision === value.projectRevision,'OWNER_UNAVAILABLE');
      if (inspect) {
        const asset = exact(value.asset,['id','label','site','kind','privacy','desired','observed']);
        requireThat(asset.id === request && asset.site === grant.site && (grant.target !== 'external' || asset.privacy === 'public'),'OWNER_UNAVAILABLE');
        requireThat(typeof asset.label === 'string' && Buffer.byteLength(asset.label) <= 120 && ['machine','gateway','broker','service','sensor'].includes(String(asset.kind)) && ['public','internal'].includes(String(asset.privacy)),'OWNER_UNAVAILABLE');
        const desired = exact(asset.desired,['enabled','pollMs']), observed = exact(asset.observed,['status','at']);
        requireThat(typeof desired.enabled === 'boolean' && typeof desired.pollMs === 'number' && Number.isInteger(desired.pollMs) && desired.pollMs >= 100 && desired.pollMs <= 3600000 && ['unknown','online','offline'].includes(String(observed.status)) && typeof observed.at === 'number' && Number.isSafeInteger(observed.at) && observed.at >= 0,'OWNER_UNAVAILABLE');
        return {projectId:grant.projectId,projectRevision:value.projectRevision,topologyRevision:value.topologyRevision,asset};
      }
      const expected = request as ProposalRequest, proposal = checkedProposal(value.proposal), diff = exact(value.diff,['expected','desired']);
      requireThat(JSON.stringify(proposal) === JSON.stringify(expected.proposal) && JSON.stringify(diff.expected) === JSON.stringify(proposal.expected) && JSON.stringify(diff.desired) === JSON.stringify(proposal.desired) && value.deviceActions === false && value.status === (action === 'commit-proposal' ? 'committed' : 'reviewed') && value.projectRevision === expected.expectedProjectRevision + (action === 'commit-proposal' ? 1 : 0),'OWNER_UNAVAILABLE');
      return {projectId:grant.projectId,projectRevision:value.projectRevision,topologyRevision:value.topologyRevision,proposal,diff:{expected:proposal.expected,desired:proposal.desired},deviceActions:false};
    } catch { if (action === 'commit-proposal') throw new WriteOutcomeUnknown(); throw new ApiError('OWNER_UNAVAILABLE'); }
  }
  scope(project: string) { requireThat(this.permitted.has(project),'SCOPE_DENIED'); }
  privateResult(value: unknown) {
    const o = record(value);
    if (o.ok !== true) throw new ApiError(codes.includes(o.code as never) ? o.code as typeof codes[number] : 'OWNER_UNAVAILABLE');
    return o;
  }
  async native(request: Record<string,unknown>, write = false, guard?: () => void|Promise<void>, pool: ProcessPool = this.pool) {
    for (const p of [this.config.adminBinary,this.config.projectBinary,this.config.python,this.config.agentEntry]) await trustedPath(p,'file');
    await trustedPath(this.config.library,'file',true); await trustedPath(this.config.profiles,'file',true);
    const raw = await pool.run(this.config.adminBinary,[
      '--library',this.config.library,'--profiles',this.config.profiles,'--python',this.config.python,
      '--entry',this.config.agentEntry,'--binary',this.config.projectBinary
    ],JSON.stringify(request),{write,guard});
    return checkedOwnerFailure(raw,write);
  }
  contentEnabled(project:string):boolean {
    this.scope(project);return !!this.config.projectContent?.projectIds.includes(project);
  }
  async content(read:NativeRead,mode:'read'|'review'|'commit',request:Record<string,unknown>,guard?:RecoveryGuard){
    const project=read.binding.id;requireThat(this.contentEnabled(project),'NOT_SUPPORTED');
    await trustedPath(this.config.projectBinary,'file');
    const raw=await this.pool.run(this.config.projectBinary,['content-'+mode,read.binding.database,project],JSON.stringify(request),{
      cap:256*1024,projectProposalErrors:true,write:mode==='commit',guard:async()=>{
        if(guard)await guard();await this.verifyBinding(read,true);
        requireThat(this.contentEnabled(project),'SCOPE_DENIED');
      }
    });
    const value=record(raw);
    if(value.ok!==true){
      const code=String(record(value.error).code);
      if(mode==='commit'&&code==='OWNER_UNAVAILABLE')throw new WriteOutcomeUnknown();
      throw new ApiError(codes.includes(code as never)?code as ApiError['code']:'OWNER_UNAVAILABLE');
    }
    try{return contentResponse(raw,mode,request.collection as ContentCollection);}
    catch(error){if(mode==='commit')throw new WriteOutcomeUnknown();throw error;}
  }
  async inventory(): Promise<{id:string; name:string; bindingKey:string}[]> {
    const value = await this.native({action:'library'});
    return ownerDto(() => {
      const {items,libraryIdentity} = this.checkedItems(value,500), ids = new Set<string>();
      return items.map((v) => {
        const e = exact(v,['id','name','database','root']);
        requireThat(identifier(e.id) && ownerText(e.name) && !ids.has(e.id),'OWNER_UNAVAILABLE'); ids.add(e.id);
        // Validate stored locators lexically only; offline projects stay listable.
        const database = ownerPath(e.database), root = ownerPath(e.root,true);
        return {id:e.id,name:e.name,bindingKey:hash(JSON.stringify([e.id,database,root,libraryIdentity]))};
      }).filter((e) => this.permitted.has(e.id));
    });
  }
  async summaries(ids: string[]) {
    requireThat(ids.length <= 100 && new Set(ids).size === ids.length && ids.every(identifier));
    for (const id of ids) this.scope(id);
    const value = await this.native({action:'summaries',ids});
    return ownerDto(() => {
      const {items} = this.checkedItems(value,100), remaining = new Set(ids);
      const result = items.map((v) => {
        const e = exact(v,['id','name','projectRevision','profileRevision','linkedRoot']);
        requireThat(identifier(e.id) && remaining.delete(e.id) && ownerText(e.name) &&
          ownerInteger(e.projectRevision,1,Number.MAX_SAFE_INTEGER-1) && ownerInteger(e.profileRevision,0) &&
          typeof e.linkedRoot === 'boolean','OWNER_UNAVAILABLE');
        return {id:e.id,name:e.name,projectRevision:e.projectRevision,profileRevision:e.profileRevision,linkedRoot:e.linkedRoot};
      });
      requireThat(remaining.size === 0,'OWNER_UNAVAILABLE'); return result;
    });
  }
  private checkedItems(value: unknown, cap: number): {items: unknown[]; libraryIdentity: LibraryIdentity|null} {
    const r = exact(value,['ok','items','libraryIdentity']);
    requireThat(r.ok === true && Array.isArray(r.items) && r.items.length <= cap,'OWNER_UNAVAILABLE');
    const libraryIdentity = r.libraryIdentity === null ? null : checkedLibraryIdentity(r.libraryIdentity);
    requireThat(libraryIdentity !== null || r.items.length === 0,'OWNER_UNAVAILABLE');
    return {items:r.items,libraryIdentity};
  }
  private checkedRead(value: unknown, project: string, generated = false): NativeRead {
    return ownerDto(() => {
      const r = exact(value,['ok','binding','profile',...(generated ? ['content','servers'] : [])]);
      requireThat(r.ok === true,'OWNER_UNAVAILABLE');
      const binding = checkedBinding(r.binding,project), profile = checkedProfile(r.profile,project);
      if (!generated) return {binding,profile};
      requireThat(typeof r.content === 'string' && Buffer.byteLength(r.content) <= 4*1024*1024,'OWNER_UNAVAILABLE');
      return {binding,profile,content:r.content,servers:record(r.servers)};
    });
  }
  async read(project: string): Promise<NativeRead> {
    this.scope(project); return this.checkedRead(await this.native({action:'read',projectId:project}),project);
  }
  async save(project: string, revision: number, servers: McpServerDto[], guard?: RecoveryGuard, originalTarget?: LegacyOriginalTarget) {
    this.scope(project);
    // This is the native owner's committed response with a prewrite binding
    // snapshot. A later read must not turn known success into CONFIG_CHANGED.
    if (originalTarget) requireThat(originalTarget.action === 'profile_save' && originalTarget.projectId === project,'SCOPE_DENIED');
    const value = await this.native({action:'save',projectId:project,expectedRevision:revision,servers},true,async () => {
      await guard?.();
      if (originalTarget) {
        const current = await this.verifyLegacyTarget(originalTarget,{verify:true,allowMissing:true});
        requireThat(current.profile.revision === revision,'REVISION_CONFLICT');
      }
      await guard?.();
    });
    try {
      const result = this.checkedRead(value,project);
      requireThat(result.profile.revision === revision+1,'OWNER_UNAVAILABLE'); return result;
    } catch { throw new WriteOutcomeUnknown(); }
  }
  private mcpIntegration(project: string): AgentGrant|null {
    if (!this.hasAgent(project)) return null;
    const grant = this.agentGrant(project);
    if (grant.integrationConfig === null) return null;
    // An operator's local-only permission must never become an external-model export.
    requireThat(grant.target === 'external','SCOPE_DENIED');
    return grant;
  }
  async generate(project: string, client: ClientId, revision: number): Promise<NativeRead> {
    this.scope(project); const grant = this.mcpIntegration(project);
    const request: Record<string,unknown> = {action:'generate',projectId:project,client,expectedRevision:revision};
    if (grant) {
      await this.verifyIntegration(grant);
      request.integration = {configPath:grant.integrationConfig,projectId:project,site:grant.site,target:'external',sha256:this.integrationPins.get(project)!.digest};
    }
    const result = this.checkedRead(await this.native(request,false,async () => { if (grant) await this.verifyIntegration(grant); }),project,true);
    if (grant) await this.verifyIntegration(grant);
    return result;
  }
  bindingId(read: NativeRead) {
    return ownerDto(() => {
      const b = checkedBinding(read.binding,read.profile.projectId);
      return hash(JSON.stringify([b.id,b.database,b.root,b.projectRevision,b.libraryIdentity,b.projectIdentity]));
    });
  }
  async client(action: 'inspect'|'restore_preview'|'preview'|'status'|'apply'|'restore_commit', read: NativeRead, client: ClientId, expected?: string, guard?: RecoveryGuard) {
    requireThat(read.binding.root,'NOT_SUPPORTED'); await trustedPath(read.binding.root,'directory'); await trustedPath(this.config.configOwner,'file');
    requireThat(resolve(read.binding.root) !== parse(resolve(read.binding.root)).root && !read.binding.root.split(/[\\/]/).some((part) => part.toLowerCase() === '.lmti'),'SCOPE_DENIED');
    const request: Record<string,unknown> = {action,root:read.binding.root,project:read.profile.projectId,client};
    if (!['inspect','restore_preview','restore_commit'].includes(action)) {
      requireThat(typeof read.content === 'string' && read.servers,'OWNER_UNAVAILABLE');
      Object.assign(request,{revision:read.profile.revision,content:read.content,servers:read.servers});
    }
    if (expected !== undefined) request.expected = expected;
    const grant = ['status','preview','apply'].includes(action) ? this.mcpIntegration(read.profile.projectId) : null;
    const writing = ['apply','restore_commit'].includes(action);
    const raw = await this.pool.run(this.config.python,['-I',this.config.configOwner],JSON.stringify(request),{write:['apply','restore_commit'].includes(action),cap:32768,timeoutMs:8000,guard:async () => {
      await guard?.(); if (grant) await this.verifyIntegration(grant);
      if (['apply','restore_commit'].includes(action)) await this.verifyBinding(read,true);
      await guard?.(); if (grant) await this.verifyIntegration(grant);
    }});
    const result = checkedOwnerFailure(raw,writing,true);
    if (writing) {
      try {
        exact(result,action === 'apply' ? ['ok','state','expected','changes','target','revision','verified'] : ['ok','state','target']);
        const target = join(read.binding.root,client === 'codex' ? '.codex/config.toml' : '.cursor/mcp.json');
        requireThat(typeof result.target === 'string' && pathKey(ownerPath(result.target)) === pathKey(target) &&
          result.state === (action === 'apply' ? 'applied' : 'restored'),'OWNER_UNAVAILABLE');
        if (action === 'apply') {
          requireThat(ownerDigest(expected) && result.expected === expected && result.revision === read.profile.revision && result.verified === false,'OWNER_UNAVAILABLE');
          const changes = exact(result.changes,['added','updated','removed']);
          for (const ids of Object.values(changes)) requireThat(Array.isArray(ids) && ids.length <= 32 && new Set(ids).size === ids.length &&
            ids.every(id => typeof id === 'string' && /^[a-z][a-z0-9_-]{0,47}$/.test(id)),'OWNER_UNAVAILABLE');
        }
      } catch { throw new WriteOutcomeUnknown(); }
    }
    // Do not turn a successful write into an unknown failure during a later check.
    if (grant && action !== 'apply') await this.verifyIntegration(grant);
    return result;
  }
  async handshake(read: NativeRead, serverId: string) {
    const server = read.profile.servers.find((s) => s.id === serverId);
    requireThat(server?.enabled,'SCOPE_DENIED'); requireThat(server.transport === 'lmti_local','NOT_SUPPORTED');
    const generated = await this.generate(read.profile.projectId,'codex',read.profile.revision);
    const definition = record(generated.servers![serverId]); requireThat(definition.command === this.config.python && Array.isArray(definition.args),'OWNER_UNAVAILABLE');
    const grant = this.mcpIntegration(read.profile.projectId);
    const integrated = (definition.args as unknown[]).includes('--integration-config');
    requireThat(integrated === Boolean(grant),'OWNER_UNAVAILABLE');
    const protocol = '2025-06-18';
    const messages = [
      {jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:protocol,capabilities:{},clientInfo:{name:'lmti-local-web-probe',version:'1'}}},
      {jsonrpc:'2.0',method:'notifications/initialized'}, {jsonrpc:'2.0',id:2,method:'tools/list'}
    ];
    const raw = await this.pool.run(this.config.python,definition.args as string[],messages.map((m) => JSON.stringify(m)).join('\n')+'\n',{raw:true,cap:32768,timeoutMs:8000,guard:async () => {
      if (grant) await this.verifyIntegration(grant);
      await this.verifyBinding(read,true);
      if (grant) await this.verifyIntegration(grant);
    }});
    if (grant) await this.verifyIntegration(grant);
    const responses = (raw as string).trim().split('\n').map((line) => record(JSON.parse(line)));
    const initialized = record(responses.find((v) => v.id === 1)?.result); requireThat(initialized.protocolVersion === protocol,'OWNER_UNAVAILABLE');
    const tools = record(responses.find((v) => v.id === 2)?.result).tools;
    const expected = ['lmti_context','lmti_entity','lmti_observations','lmti_related',...(integrated ? ['lmti_task_context'] : [])];
    requireThat(Array.isArray(tools) && tools.length === expected.length,'OWNER_UNAVAILABLE');
    const names = tools.map((v) => record(v).name);
    requireThat(new Set(names).size === expected.length && expected.every((n) => names.includes(n)),'OWNER_UNAVAILABLE');
    const fresh = await this.read(read.profile.projectId); requireThat(this.bindingId(fresh) === this.bindingId(read) && JSON.stringify(fresh.profile) === JSON.stringify(read.profile),'REVISION_CONFLICT');
    return {serverId,kind:'local_handshake',state:'ok',checkedAt:new Date().toISOString(),toolNames:expected,unknowns:['Actual client use is not verified.','Live IoT observations are not implemented.']};
  }
}
