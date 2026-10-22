import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHmac, randomBytes } from 'node:crypto';
import { loadAssets } from './assets.js';
import { Owners, agentArguments, checkedProposal, type LaunchConfig, type NativeRead, type ProposalRequest } from './owners.js';
import { ApiError, exact, hash, opaque, record, requireThat, safeRevision, secureEqual, strictJson } from './security.js';
import { ProjectOperationsService } from './project-operations-service.js';
import { LogicalHierarchyService } from './logical-hierarchy-service.js';
import { PhysicalHierarchyService } from './physical-hierarchy-service.js';
import { ProjectOperationRecovery } from './project-operations-recovery.js';
import { collectOriginalTargets } from './recovery-collection.js';
import { checkedRecoverySubject, type RecoverySubject } from './recovery-subject.js';
import type { LegacyEffect, LegacyOriginalTarget } from './legacy-recovery-target.js';
import { WriteOutcomeUnknown } from './process.js';
import { BrokerRestartGuard } from './broker-guard.js';
import { WriteCoordinator, type RecoveryToken } from './write-coordinator.js';
import type { ClientId, ClientStatusDto, McpServerDto } from './contracts.js';

interface Session {key: string; created: number; touched: number; revoked: boolean}
interface Preview {epoch: number; session: Session; project: string; client: ClientId; operation: 'apply'|'restore'; revision: number; binding: string; expected: string; expires: number; generated: NativeRead; subject: RecoverySubject}
interface Cursor {session: Session; ids: string[]; inventory: string; offset: number; limit: number; expires: number}
interface Job {session: Session; client?: ClientId; state: 'pending'|'succeeded'|'failed'|'unknown'; result?: unknown; code?: string; finished?: number}
interface ProposalPreview {epoch: number; session: Session; project: string; binding: string; grant: string; request: ProposalRequest; expires: number; subject: RecoverySubject}
const statuses: Record<string,number> = {INVALID_INPUT:400,UNAUTHENTICATED:401,SESSION_EXPIRED:401,ORIGIN_REJECTED:403,SCOPE_DENIED:403,REVISION_CONFLICT:409,CONFIG_CHANGED:409,RECOVERY_REQUIRED:409,UNMANAGED_COLLISION:409,OWNED_CONFIG_DRIFT:409,PREVIEW_EXPIRED:410,LIMIT_EXCEEDED:413,BUSY:429,NOT_SUPPORTED:501,OWNER_UNAVAILABLE:503};

async function jsonBody(req: IncomingMessage) {
  requireThat(/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '') && !req.headers['content-encoding']);
  requireThat(Number(req.headers['content-length'] ?? 0) <= 128*1024,'LIMIT_EXCEEDED');
  const chunks: Buffer[] = []; let size = 0;
  for await (const b of req) { size += b.length; requireThat(size <= 128*1024,'LIMIT_EXCEEDED'); chunks.push(b); }
  return strictJson(Buffer.concat(chunks));
}
export async function createLocalApi(config: LaunchConfig, clock: () => number = Date.now) {
  const owners = new Owners(config); await owners.validateLaunch();
  const assets = await loadAssets();
  const coordinator = await WriteCoordinator.create(owners.config.library,
    owners.brokerGuardConfig ? new BrokerRestartGuard(owners.brokerGuardConfig) : undefined,clock,{domainId:owners.recoveryDomainId()});
  let stopping = false, closing: Promise<void>|null = null;
  const activeTasks = new Set<Promise<unknown>>(), activeRequests = new Set<Promise<void>>();
  function track<T>(task: Promise<T>): Promise<T> {
    activeTasks.add(task); void task.then(() => activeTasks.delete(task),() => activeTasks.delete(task)); return task;
  }
  const recoveryPreviews = new Map<string,{session:Session;token:RecoveryToken;digest:string;expires:number}>();
  async function legacySubject(read:NativeRead,effect:LegacyEffect):Promise<RecoverySubject> {
    const target=await owners.captureLegacyTarget(read,effect);
    return checkedRecoverySubject({version:1,kind:'legacy',action:effect.kind,
      projectId:read.profile.projectId,grantId:owners.recoveryDomainId(),target});
  }
  async function verifyLegacySubject(subject:RecoverySubject,session:Session) {
    guard(session);owners.scope(subject.projectId!);
    requireThat(subject.kind==='legacy'&&subject.grantId===owners.recoveryDomainId(),'SCOPE_DENIED');
    return owners.verifyLegacyTarget(subject.target as unknown as LegacyOriginalTarget,
      {verify:true,allowMissing:true,guard:()=>guard(session)});
  }
  const sessions = new Map<string,Session>(), launches = new Map<string,number>(), previews = new Map<string,Preview>(), cursors = new Map<string,Cursor>(), jobs = new Map<string,Job>();
  const proposalPreviews = new Map<string,ProposalPreview>(), cursorSecret = randomBytes(32);
  let origin = '', bootstrapWindow = clock(), bootstrapTries = 0;
  const alive = (s: Session) => !s.revoked && clock()-s.created < 4*60*60*1000 && clock()-s.touched < 20*60*1000;
  const guard = (s: Session) => requireThat(!stopping && alive(s),'SESSION_EXPIRED');
  function cleanup() {
    const now = clock(); operations?.cleanup(); hierarchy?.cleanup(); physicalHierarchy?.cleanup();
    for (const [k,p] of recoveryPreviews) if (p.expires < now || !alive(p.session)) recoveryPreviews.delete(k);
    for (const [k,s] of sessions) if (!alive(s)) { s.revoked = true; sessions.delete(k); }
    for (const [k,expires] of launches) if (expires < now) launches.delete(k);
    for (const [k,p] of previews) if (p.expires < now || !alive(p.session)) previews.delete(k);
    for (const [k,p] of proposalPreviews) if (p.expires < now || !alive(p.session)) proposalPreviews.delete(k);
    for (const [k,c] of cursors) if (c.expires < now || !alive(c.session)) cursors.delete(k);
    for (const [k,j] of jobs) if (j.finished && (now-j.finished > 10*60*1000 || !alive(j.session))) jobs.delete(k);
  }
  const operationRecovery=owners.projectOperationOwner?
    new ProjectOperationRecovery(owners.projectOperationOwner,()=>owners.operationGrantId()):null;
  async function recoveryState(session:Session) {
    const authorize=(subject:RecoverySubject)=>{
      guard(session);
      if(subject.kind==='legacy') {
        requireThat(subject.grantId===owners.recoveryDomainId()&&subject.projectId!==null,'SCOPE_DENIED');
        owners.scope(subject.projectId);
      } else if(subject.kind==='project_operations') {
        requireThat(operationRecovery&&subject.grantId===owners.operationGrantId(),'SCOPE_DENIED');
        requireThat(subject.projectId===null?owners.config.projectOperations?.allowLibraryUpgrade===true:
          owners.hasProjectOperations(subject.projectId),'SCOPE_DENIED');
      } else if(subject.kind==='logical_hierarchy') {
        requireThat(owners.hierarchyRecovery,'SCOPE_DENIED');
        owners.hierarchyRecovery.authorize(subject);
      } else if(subject.kind==='physical_hierarchy') {
        requireThat(owners.physicalHierarchyRecovery,'SCOPE_DENIED');
        owners.physicalHierarchyRecovery.authorize(subject);
      } else requireThat(false,'NOT_SUPPORTED');
    };
    return collectOriginalTargets(coordinator,{
      guard:()=>guard(session),authorize,includeCoverage:!!owners.logicalHierarchyOwner||!!owners.physicalHierarchyOwner,
      inspect:async subject=>{
        if(subject.kind==='legacy') {
          const value=await owners.inspectLegacyRecovery(subject.target as unknown as LegacyOriginalTarget,
            {verify:true,guard:()=>guard(session)});
          return {digest:hash(JSON.stringify(value.evidence)),summary:value.summary};
        }
        if(subject.kind==='logical_hierarchy')
          return owners.hierarchyRecovery!.inspect(subject,()=>guard(session));
        if(subject.kind==='physical_hierarchy')
          return owners.physicalHierarchyRecovery!.inspect(subject,()=>guard(session));
        return operationRecovery!.inspect(subject,()=>guard(session),project=>{
          guard(session);requireThat(owners.hasProjectOperations(project),'SCOPE_DENIED');
        });
      },
      ...(owners.projectOperationOwner?{librarySchema:async()=>{
        const value=await owners.projectOperationOwner!.read({action:'library-format-status'},{verify:true,guard:()=>guard(session)});
        requireThat(value.action==='library-format-status','OWNER_UNAVAILABLE');
        return value.libraryIdentity.schema;
      }}:{})
    });
  }
  const operations = owners.projectOperationOwner ? new ProjectOperationsService({
    owner:owners.projectOperationOwner,coordinator,clock,
    guard:(s) => guard(s as Session),alive:(s) => alive(s as Session),
    authorize:(s,p) => {
      guard(s as Session);
      requireThat(p === null ? owners.config.projectOperations?.allowLibraryUpgrade === true : owners.hasProjectOperations(p),'SCOPE_DENIED');
    },
    grantId:() => owners.operationGrantId(),
    captureSubject:(request,receipt)=>operationRecovery!.capture(request,receipt),
    verifySubject:subject=>operationRecovery!.verify(subject),
    collectRecovery:async s=>{
      const result=await recoveryState(s as Session);
      requireThat(result.librarySchema!==null,'OWNER_UNAVAILABLE');
      return {digest:result.digest,librarySchema:result.librarySchema};
    },
    onReconciled:() => { recoveryPreviews.clear(); previews.clear(); proposalPreviews.clear(); cursors.clear(); hierarchy?.invalidate(); physicalHierarchy?.invalidate(); },
    onConfirmed:(_action,_project) => { previews.clear(); proposalPreviews.clear(); cursors.clear(); recoveryPreviews.clear(); hierarchy?.invalidate(); physicalHierarchy?.invalidate(); }
  }) : null;
  const hierarchy = owners.logicalHierarchyOwner ? new LogicalHierarchyService({
    owner:owners.logicalHierarchyOwner,coordinator,clock,
    guard:s=>guard(s as Session),alive:s=>alive(s as Session),
    authorize:(s,project)=>{guard(s as Session);requireThat(owners.hasLogicalHierarchy(project),'SCOPE_DENIED');},
    grants:()=>owners.hierarchyGrants(),grantId:project=>owners.hierarchyGrantId(project),
    captureSubject:(project,expected,options)=>owners.hierarchyRecovery!.captureSubject(project,expected,options),
    conditionalState:(subject,options)=>owners.hierarchyRecovery!.conditionalState(subject,options),
    onConfirmed:project=>{
      previews.clear();proposalPreviews.clear();cursors.clear();recoveryPreviews.clear();operations?.invalidate(project);physicalHierarchy?.invalidate(project);
    }
  }) : null;
  const physicalHierarchy = owners.physicalHierarchyOwner ? new PhysicalHierarchyService({
    owner:owners.physicalHierarchyOwner,coordinator,clock,
    guard:s=>guard(s as Session),alive:s=>alive(s as Session),
    authorize:(s,project)=>{guard(s as Session);requireThat(owners.hasPhysicalHierarchy(project),'SCOPE_DENIED');},
    grants:()=>owners.physicalHierarchyGrants(),grantId:project=>owners.physicalHierarchyGrantId(project),
    captureSubject:(project,expected,options)=>owners.physicalHierarchyRecovery!.captureSubject(project,expected,options),
    conditionalState:(subject,options)=>owners.physicalHierarchyRecovery!.conditionalState(subject,options),
    onConfirmed:project=>{
      previews.clear();proposalPreviews.clear();cursors.clear();recoveryPreviews.clear();
      operations?.invalidate(project);hierarchy?.invalidate(project);
    }
  }) : null;
  const capabilities = (project: string, linked: unknown) => [
    'profile.read','profile.update',...(linked ? ['client.preview','client.apply','client.restore'] : []),'client.export','connection.check',
    ...(owners.hasProjectOperations(project) ? ['project.operations'] : []),
    ...(owners.hasLogicalHierarchy(project) ? ['logical.hierarchy'] : []),
    ...(owners.hasPhysicalHierarchy(project) ? ['physical.hierarchy'] : []),
    ...(owners.hasAgent(project) ? ['agent.read','proposal.review','proposal.commit'] : [])
  ];
  async function recheck(session: Session, project: string, read: NativeRead, grant: string) {
    guard(session); requireThat(owners.grantId(owners.agentGrant(project)) === grant,'SCOPE_DENIED');
    await owners.verifyIntegration(owners.agentGrant(project));
    const fresh = await owners.read(project);
    requireThat(fresh.binding.projectRevision === read.binding.projectRevision,'REVISION_CONFLICT');
    requireThat(owners.bindingId(fresh) === owners.bindingId(read),'CONFIG_CHANGED');
    guard(session); requireThat(owners.grantId(owners.agentGrant(project)) === grant,'SCOPE_DENIED');
    await owners.verifyIntegration(owners.agentGrant(project));
    return fresh;
  }
  const publicStatus = (read: NativeRead, client: ClientId, r: Record<string,unknown>): ClientStatusDto => ({
    client,configuration:r.state === 'recovery_required' ? 'recovery_required' : r.appliedRevision === null ? 'not_applied' : r.appliedRevision === read.profile.revision ? 'applied' : 'update_pending',
    appliedRevision:typeof r.appliedRevision === 'number' ? r.appliedRevision : null,checkedAt:new Date().toISOString(),clientUse:'not_verified',evidenceId:null,
    canRestore:r.canRestore === true,capabilities:read.binding.root && process.platform === 'win32' ? ['client.preview','client.apply','client.restore'] : []
  });
  async function status(read: NativeRead, client: ClientId) {
    if (!read.binding.root) return {client,configuration:'unavailable',appliedRevision:null,checkedAt:new Date().toISOString(),clientUse:'not_verified',evidenceId:null,canRestore:false,capabilities:[]};
    const inspection = await owners.client('inspect',read,client);
    if (inspection.state === 'recovery_required' || read.profile.revision === 0) return publicStatus(read,client,inspection);
    let checked: Record<string,unknown>;
    try {
      const generated = await owners.generate(read.profile.projectId,client,read.profile.revision);
      checked = await owners.client('status',generated,client);
    } catch (e) {
      // Inspection and protected Restore remain available after an integration
      // grant is revoked; generation, apply and Check retain their own denial.
      if (e instanceof ApiError && ['OWNED_CONFIG_DRIFT','UNMANAGED_COLLISION','CONFIG_CHANGED','SCOPE_DENIED'].includes(e.code))
        return {...publicStatus(read,client,inspection),configuration:'review_required'};
      throw e;
    }
    return {...publicStatus(read,client,inspection),configuration:checked.state === 'applied' ? 'applied' : checked.state === 'update_pending' ? 'update_pending' : 'not_applied'};
  }
  async function dispatch(req: IncomingMessage) {
    requireThat(!stopping,'SESSION_EXPIRED'); cleanup();
    const path = req.url!;
    if (path === '/api/v1/session/bootstrap' && req.method === 'POST') {
      if (clock()-bootstrapWindow > 60000) { bootstrapWindow = clock(); bootstrapTries = 0; }
      requireThat(++bootstrapTries <= 32,'BUSY'); const body = exact(await jsonBody(req),['nonce']);
      requireThat(typeof body.nonce === 'string' && /^[A-Za-z0-9_-]{43}$/.test(body.nonce),'UNAUTHENTICATED');
      const key = hash(body.nonce); let found: string | undefined;
      for (const candidate of launches.keys()) if (secureEqual(candidate,key)) found = candidate;
      requireThat(found && launches.get(found)! >= clock(),'UNAUTHENTICATED'); launches.delete(found);
      requireThat(sessions.size < 8,'BUSY'); const token = opaque(), tokenKey = hash(token);
      sessions.set(tokenKey,{key:tokenKey,created:clock(),touched:clock(),revoked:false});
      return {token,expiresInSeconds:1200};
    }
    const authorization = req.headers.authorization;
    requireThat(typeof authorization === 'string' && /^Bearer [A-Za-z0-9_-]{43}$/.test(authorization),'UNAUTHENTICATED');
    const session = sessions.get(hash(authorization.slice(7))); requireThat(session,'UNAUTHENTICATED'); guard(session); session.touched = clock();
    if (path === '/api/v1/session' && req.method === 'DELETE') { session.revoked = true; sessions.delete(session.key); cleanup(); return {revoked:true}; }
    if (path === '/api/v1/project-operation-scopes' && req.method === 'GET') {
      requireThat(operations && owners.config.projectOperations,'NOT_SUPPORTED');
      return {projectIds:[...owners.config.projectOperations.projectIds],allowLibraryUpgrade:owners.config.projectOperations.allowLibraryUpgrade};
    }
    if (path === '/api/v1/logical-hierarchy-scopes' && req.method === 'GET') {
      requireThat(hierarchy,'NOT_SUPPORTED');return hierarchy.scopes(session);
    }
    const hierarchyRoute = /^\/api\/v1\/projects\/([A-Za-z][A-Za-z0-9._-]{0,63})\/logical-hierarchy(?:\/(previews|commits|previews\/[A-Za-z0-9_-]{43}))?$/.exec(path);
    if(hierarchyRoute) {
      requireThat(hierarchy,'NOT_SUPPORTED');
      const project=hierarchyRoute[1],action=hierarchyRoute[2]??'';
      if(!action){requireThat(req.method==='GET');return hierarchy.state(session,project);}
      if(action.startsWith('previews/')){requireThat(req.method==='DELETE');return hierarchy.reject(session,project,action.slice(9));}
      requireThat(req.method==='POST');const body=await jsonBody(req);
      return action==='previews'?hierarchy.preview(session,project,body):hierarchy.commit(session,project,body);
    }
    if (path === '/api/v1/physical-hierarchy-scopes' && req.method === 'GET') {
      requireThat(physicalHierarchy,'NOT_SUPPORTED');return physicalHierarchy.scopes(session);
    }
    const physicalHierarchyRoute = /^\/api\/v1\/projects\/([A-Za-z][A-Za-z0-9._-]{0,63})\/physical-hierarchy(?:\/(previews|commits|previews\/[A-Za-z0-9_-]{43}))?$/.exec(path);
    if(physicalHierarchyRoute) {
      requireThat(physicalHierarchy,'NOT_SUPPORTED');
      const project=physicalHierarchyRoute[1],action=physicalHierarchyRoute[2]??'';
      if(!action){requireThat(req.method==='GET');return physicalHierarchy.state(session,project);}
      if(action.startsWith('previews/')){requireThat(req.method==='DELETE');return physicalHierarchy.reject(session,project,action.slice(9));}
      requireThat(req.method==='POST');const body=await jsonBody(req);
      return action==='previews'?physicalHierarchy.preview(session,project,body):physicalHierarchy.commit(session,project,body);
    }
    if (path === '/api/v1/write-claim' && req.method === 'POST') {
      exact(await jsonBody(req),[]); requireThat(owners.brokerGuardConfig,'NOT_SUPPORTED');
      const result = await coordinator.claim(); guard(session);
      return {outcome:result.outcome,recoveryRequired:coordinator.snapshot().recoveryRequired};
    }
    const operationRoute = /^\/api\/v1\/(?:projects\/([A-Za-z][A-Za-z0-9._-]{0,63})|library)\/project-operations(?:\/(copy-previews|copies|activations|activation-previews|decision-previews|previews|commits|recovery-previews|recoveries|recovery\/[A-Za-z0-9_-]{43}|previews\/[A-Za-z0-9_-]{43}))?$/.exec(path);
    if (operationRoute) {
      requireThat(operations,'NOT_SUPPORTED');
      const project = operationRoute[1] ?? null, action = operationRoute[2] ?? '';
      if (!action) {
        requireThat(req.method === 'GET');
        return project === null ? operations.libraryStatus(session) : operations.projectStatus(session,project);
      }
      if (action.startsWith('previews/')) { requireThat(req.method === 'DELETE'); return operations.reject(session,project,action.slice(9)); }
      if (action.startsWith('recovery/')) { requireThat(req.method === 'GET' && project !== null); return operations.recovery(session,project,action.slice(9)); }
      requireThat(req.method === 'POST'); const body = await jsonBody(req);
      if (action === 'commits') return operations.commit(session,project,body);
      if (action === 'recovery-previews') return operations.recoveryPreview(session,project,body);
      if (action === 'recoveries') return operations.acknowledgeRecovery(session,project,body);
      if (project === null) { requireThat(action === 'previews'); return operations.libraryPreview(session,body); }
      switch (action) {
        case 'copy-previews': return operations.copyPreview(session,project,body);
        case 'copies': return operations.copies(session,project,body);
        case 'activations': return operations.activations(session,project,body);
        case 'activation-previews': return operations.activationPreview(session,project,body);
        case 'decision-previews': return operations.decisionPreview(session,project,body);
        default: throw new ApiError('INVALID_INPUT');
      }
    }
    if (path === '/api/v1/write-status' && req.method === 'GET') {
      const state = coordinator.snapshot();
      return {recoveryRequired:state.recoveryRequired,admitted:state.admitted,activeWrites:state.activeLeases,projectOperations:!!owners.projectOperationOwner};
    }
    if (path === '/api/v1/recovery-previews' && req.method === 'POST') {
      requireThat(!owners.projectOperationOwner || hierarchy || physicalHierarchy,'NOT_SUPPORTED'); exact(await jsonBody(req),[]);
      requireThat(recoveryPreviews.size < 64,'BUSY');
      const token = coordinator.beginReconciliation(), evidence = await recoveryState(session); guard(session);
      requireThat(token.epoch === coordinator.snapshot().epoch,'CONFIG_CHANGED');
      const id = opaque(), expires = clock()+120000;
      requireThat(!(hierarchy||physicalHierarchy)||evidence.coverage,'OWNER_UNAVAILABLE');
      const result = {id,expiresAt:new Date(expires).toISOString(),items:evidence.items,
        ...((hierarchy||physicalHierarchy)?{hierarchyItems:evidence.hierarchyItems,coverage:evidence.coverage}:{}),
        ...(physicalHierarchy?{physicalHierarchyItems:evidence.physicalHierarchyItems}:{}),priorOutcome:'unknown'};
      // Gate the complete success frame before retaining an actionable review.
      requireThat(Buffer.byteLength(JSON.stringify({apiVersion:1,requestId:'x'.repeat(43),ok:true,data:result}))<=256*1024,'LIMIT_EXCEEDED');
      recoveryPreviews.set(id,{session,token,digest:evidence.digest,expires});
      return result;
    }
    if (path === '/api/v1/recoveries' && req.method === 'POST') {
      requireThat(!owners.projectOperationOwner || hierarchy || physicalHierarchy,'NOT_SUPPORTED');
      const body = exact(await jsonBody(req),['previewId']); requireThat(typeof body.previewId === 'string');
      const review = recoveryPreviews.get(body.previewId);
      requireThat(review && review.session === session && review.expires >= clock(),'PREVIEW_EXPIRED');
      const evidence = await recoveryState(session); guard(session);
      requireThat(evidence.digest === review.digest,'CONFIG_CHANGED');
      await coordinator.acknowledge(review.token); recoveryPreviews.clear(); previews.clear(); proposalPreviews.clear();
      cursors.clear();operations?.invalidate();hierarchy?.invalidate(); physicalHierarchy?.invalidate();
      return {reviewed:true,priorOutcome:'unknown',freshReviewRequired:true};
    }
    if (path.startsWith('/api/v1/operations/') && req.method === 'GET') {
      const id = path.slice('/api/v1/operations/'.length); const job = jobs.get(id);
      if (!job) { const operation = operations?.lookup(session,id) ?? hierarchy?.lookup(session,id) ?? physicalHierarchy?.lookup(session,id); requireThat(operation,'SCOPE_DENIED'); return operation; }
      requireThat(job.session === session,'SCOPE_DENIED'); return {operationId:id,state:job.state,result:job.result ?? null,errorCode:job.code ?? null};
    }
    if (/^\/api\/v1\/projects(?:\?|$)/.test(path) && req.method === 'GET') {
      const url = new URL(path,origin); const params = url.searchParams;
      requireThat([...params.keys()].every((p) => ['limit','cursor'].includes(p)) && [...params.keys()].length === new Set(params.keys()).size);
      const limit = Number(params.get('limit') ?? 50); requireThat(Number.isInteger(limit) && limit >= 1 && limit <= 100);
      const inventory = await owners.inventory(), ids = inventory.map((p) => p.id), inventoryHash = hash(JSON.stringify(inventory));
      let offset = 0; const cursorId = params.get('cursor');
      if (cursorId) {
        const c = cursors.get(cursorId); requireThat(c && c.session === session && c.expires >= clock() && c.inventory === inventoryHash && c.limit === limit,'PREVIEW_EXPIRED'); offset = c.offset; cursors.delete(cursorId);
      }
      const slice = ids.slice(offset,offset+limit), items = await owners.summaries(slice);
      const projected = items.map((v) => { const item = exact(v,['id','name','projectRevision','profileRevision','linkedRoot']); return {...item,capabilities:capabilities(String(item.id),item.linkedRoot)}; });
      let nextCursor: string | null = null;
      if (offset+limit < ids.length) { requireThat(cursors.size < 256,'BUSY'); nextCursor = opaque(); cursors.set(nextCursor,{session,ids,inventory:inventoryHash,offset:offset+limit,limit,expires:clock()+120000}); }
      return {items:projected,nextCursor};
    }
    const summaryId = /^\/api\/v1\/projects\/([A-Za-z][A-Za-z0-9._-]{0,63})$/.exec(path)?.[1];
    if (summaryId) {
      requireThat(req.method === 'GET'); owners.scope(summaryId);
      const items = await owners.summaries([summaryId]); requireThat(items.length === 1,'OWNER_UNAVAILABLE');
      const item = exact(items[0],['id','name','projectRevision','profileRevision','linkedRoot']);
      return {...item,capabilities:capabilities(summaryId,item.linkedRoot)};
    }
    const agentRoute = /^\/api\/v1\/projects\/([A-Za-z][A-Za-z0-9._-]{0,63})\/(agent\/read|proposals\/(inspect|previews|commit)|proposals\/previews\/([A-Za-z0-9_-]{43}))$/.exec(path);
    if (agentRoute) {
      const project = agentRoute[1]; owners.scope(project);
      if (agentRoute[4]) {
        requireThat(req.method === 'DELETE');
        const preview = proposalPreviews.get(agentRoute[4]);
        requireThat(preview && preview.session === session && preview.project === project && preview.expires >= clock(),'PREVIEW_EXPIRED');
        proposalPreviews.delete(agentRoute[4]); return {rejected:true};
      }
      requireThat(req.method === 'POST');
      const body = await jsonBody(req), grant = owners.agentGrant(project), grantKey = owners.grantId(grant);
      if (agentRoute[2] === 'agent/read') {
        const input = exact(body,['operation','arguments']);
        const query = agentArguments(input.operation,input.arguments);
        const read = await owners.read(project);
        const cursorKey = createHmac('sha256',cursorSecret).update(session.key+'\0'+project).digest('hex');
        const response = await owners.agent(read,grant,query.operation,query.arguments,cursorKey,() => {
          guard(session); requireThat(owners.grantId(owners.agentGrant(project)) === grantKey,'SCOPE_DENIED');
        });
        await recheck(session,project,read,grantKey); return response;
      }
      if (agentRoute[3] === 'inspect') {
        const input = exact(body,['assetId']);
        requireThat(typeof input.assetId === 'string' && /^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(input.assetId));
        const read = await owners.read(project);
        const result = await owners.proposal(read,grant,'proposal-asset',input.assetId,() => guard(session));
        await recheck(session,project,read,grantKey); return result;
      }
      if (agentRoute[3] === 'previews') {
        const reviewEpoch = coordinator.snapshot().epoch; coordinator.assertAllowed(reviewEpoch);
        const input = exact(body,['expectedProjectRevision','proposal']);
        const expected = safeRevision(input.expectedProjectRevision); requireThat(expected > 0 && expected < Number.MAX_SAFE_INTEGER);
        const request = {expectedProjectRevision:expected,proposal:checkedProposal(input.proposal)};
        requireThat(request.proposal.site === grant.site,'SCOPE_DENIED');
        requireThat(proposalPreviews.size < 256 && [...proposalPreviews.values()].filter((p) => p.session === session).length < 64,'BUSY');
        const read = await owners.read(project);
        requireThat(read.binding.projectRevision === expected,'REVISION_CONFLICT');
        const result = await owners.proposal(read,grant,'review-proposal',request,() => guard(session));
        await recheck(session,project,read,grantKey);
        const subject=await legacySubject(read,{kind:'desired_proposal'});
        await verifyLegacySubject(subject,session);
        const id = opaque(), expires = clock()+120000;
        coordinator.assertAllowed(reviewEpoch);
        proposalPreviews.set(id,{epoch:reviewEpoch,session,project,binding:owners.bindingId(read),grant:grantKey,request,expires,subject});
        return {id,projectId:project,expectedProjectRevision:expected,topologyRevision:result.topologyRevision,proposal:request.proposal,diff:result.diff,expiresAt:new Date(expires).toISOString(),deviceActions:false};
      }
      const input = exact(body,['previewId']); requireThat(typeof input.previewId === 'string');
      const preview = proposalPreviews.get(input.previewId);
      requireThat(preview && preview.session === session && preview.project === project && preview.expires >= clock(),'PREVIEW_EXPIRED');
      requireThat(preview.grant === grantKey,'SCOPE_DENIED');
      requireThat(jobs.size < 128,'BUSY');
      const lease = coordinator.acquire('shared',project,preview.epoch,preview.subject);
      proposalPreviews.delete(input.previewId);
      let id:string, job:Job;
      try { id = opaque(); job = {session,state:'pending'}; jobs.set(id,job); }
      catch (e) { lease.release('known'); throw e; }
      const task = track((async () => {
        try {
          guard(session);
          const fresh = await verifyLegacySubject(preview.subject,session);
          requireThat(fresh.binding.projectRevision === preview.request.expectedProjectRevision,'REVISION_CONFLICT');
          requireThat(owners.bindingId(fresh) === preview.binding,'CONFIG_CHANGED');
          requireThat(owners.grantId(owners.agentGrant(project)) === preview.grant,'SCOPE_DENIED');
          // The native commit reloads typed state and validates old values and
          // both revisions before its existing atomic store transaction.
          const result = await owners.proposal(fresh,grant,'commit-proposal',preview.request,async () => {
            await lease.beforeStart(); await verifyLegacySubject(preview.subject,session);
            guard(session); coordinator.assertAllowed(preview.epoch); requireThat(preview.expires >= clock(),'PREVIEW_EXPIRED');
            requireThat(owners.grantId(owners.agentGrant(project)) === preview.grant,'SCOPE_DENIED');
          });
          job.result = {operationId:id,outcome:'committed',projectRevision:result.projectRevision,topologyRevision:result.topologyRevision,deviceActions:false};
          job.state = 'succeeded';hierarchy?.invalidate(project);physicalHierarchy?.invalidate(project);operations?.invalidate(project);
        } catch (e) {
          job.code = e instanceof ApiError ? e.code : 'OWNER_UNAVAILABLE';
          job.state = e instanceof WriteOutcomeUnknown ? 'unknown' : 'failed';
          if (job.state === 'unknown') { job.result = {operationId:id,outcome:'unknown',deviceActions:false}; }
        } finally { job.finished = clock(); lease.release(job.state === 'unknown' ? 'unknown' : 'known'); }
      })());
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([task,new Promise<void>((resolve) => { timer = setTimeout(resolve,8000); })]); if (timer) clearTimeout(timer);
      if (job.state === 'failed') throw new ApiError(job.code as ApiError['code']);
      return job.state === 'succeeded' || job.state === 'unknown' ? job.result : {operationId:id,outcome:'pending',deviceActions:false};
    }
    const match = /^\/api\/v1\/projects\/([A-Za-z][A-Za-z0-9._-]{0,63})\/(mcp-profile|clients\/(codex|cursor)(?:\/(previews|commit|export))?|connections\/([a-z][a-z0-9_-]{0,47})\/check)$/.exec(path);
    requireThat(match,'SCOPE_DENIED'); const project = match[1]; owners.scope(project);
    if (match[2] === 'mcp-profile') {
      if (req.method === 'GET') return (await owners.read(project)).profile;
      requireThat(req.method === 'PUT'); const body = exact(await jsonBody(req),['expectedRevision','servers']);
      const expected = safeRevision(body.expectedRevision); requireThat(Array.isArray(body.servers) && body.servers.length <= 32);
      const leaseEpoch = coordinator.snapshot().epoch; coordinator.assertAllowed(leaseEpoch);
      const initial=await owners.read(project);requireThat(initial.profile.revision===expected,'REVISION_CONFLICT');
      const subject=await legacySubject(initial,{kind:'profile_save'});
      const lease = coordinator.acquire('shared',project,leaseEpoch,subject);
      let unknown = false;
      try { return (await owners.save(project,expected,body.servers as McpServerDto[],async () => {
        await lease.beforeStart();await verifyLegacySubject(subject,session);
        guard(session);coordinator.assertAllowed(leaseEpoch);
      },subject.target as unknown as LegacyOriginalTarget)).profile; }
      catch (e) { unknown = e instanceof WriteOutcomeUnknown; throw e; }
      finally { lease.release(unknown ? 'unknown' : 'known'); }
    }
    if (match[5]) {
      requireThat(req.method === 'POST'); exact(await jsonBody(req),[]); return owners.handshake(await owners.read(project),match[5]);
    }
    const client = match[3] as ClientId;
    if (!match[4]) { requireThat(req.method === 'GET'); return status(await owners.read(project),client); }
    requireThat(req.method === 'POST'); const body = await jsonBody(req);
    if (match[4] === 'export') {
      const r = exact(body,['expectedProfileRevision']);
      const generated = await owners.generate(project,client,safeRevision(r.expectedProfileRevision));
      requireThat(typeof generated.content === 'string' && Buffer.byteLength(generated.content) <= 128*1024,'LIMIT_EXCEEDED');
      return {projectId:project,client,profileRevision:generated.profile.revision,format:client === 'codex' ? 'toml' : 'json',
        filename:`lmti-${project}-${client}.${client === 'codex' ? 'toml' : 'json'}`,content:generated.content};
    }
    if (match[4] === 'previews') {
      const reviewEpoch = coordinator.snapshot().epoch; coordinator.assertAllowed(reviewEpoch);
      const r = exact(body,['expectedProfileRevision','operation']); const revision = safeRevision(r.expectedProfileRevision); requireThat(r.operation === 'apply' || r.operation === 'restore');
      requireThat(previews.size < 256 && [...previews.values()].filter((p) => p.session === session).length < 64,'BUSY');
      const read = await owners.read(project); requireThat(read.profile.revision === revision,'REVISION_CONFLICT');
      const generated = r.operation === 'apply' ? await owners.generate(project,client,revision) : read;
      const ownerPreview = await owners.client(r.operation === 'apply' ? 'preview' : 'restore_preview',generated,client);
      requireThat(typeof ownerPreview.expected === 'string','OWNER_UNAVAILABLE'); const id = opaque(), expires = clock()+120000;
      const subject=await legacySubject(generated,{kind:r.operation==='apply'?'client_apply':'client_restore',client});
      await verifyLegacySubject(subject,session);
      guard(session); coordinator.assertAllowed(reviewEpoch); previews.set(id,{epoch:reviewEpoch,session,project,client,operation:r.operation,revision,binding:owners.bindingId(generated),expected:ownerPreview.expected,expires,generated,subject});
      return {id,projectId:project,client,operation:r.operation,profileRevision:revision,expiresAt:new Date(expires).toISOString(),
        changes:ownerPreview.changes ?? null,preservesUnmanagedServers:r.operation === 'apply',protectedRecovery:process.platform === 'win32',
        generatedConfig:r.operation === 'apply' ? {format:client === 'codex' ? 'toml' : 'json',content:generated.content} : null};
    }
    const commit = exact(body,['previewId']); requireThat(typeof commit.previewId === 'string'); const p = previews.get(commit.previewId);
    requireThat(p && p.session === session && p.project === project && p.client === client && p.expires >= clock(),'PREVIEW_EXPIRED');
    requireThat(jobs.size < 128,'BUSY'); const lease = coordinator.acquire('shared',project,p.epoch,p.subject); previews.delete(commit.previewId);
    let id:string, job:Job;
    try { id = opaque(); job = {session,client,state:'pending'}; jobs.set(id,job); }
    catch (e) { lease.release('known'); throw e; }
    const task = track((async () => {
      try {
        const fresh = await verifyLegacySubject(p.subject,session); requireThat(fresh.profile.revision === p.revision,'REVISION_CONFLICT');
        requireThat(owners.bindingId(fresh) === p.binding && JSON.stringify(fresh.profile) === JSON.stringify(p.generated.profile),'CONFIG_CHANGED');
        const generated = p.operation === 'apply' ? await owners.generate(project,client,p.revision) : fresh; requireThat(owners.bindingId(generated) === p.binding,'CONFIG_CHANGED');
        const freshPreview = await owners.client(p.operation === 'apply' ? 'preview' : 'restore_preview',generated,client);
        requireThat(freshPreview.expected === p.expected,'CONFIG_CHANGED');
        await owners.client(p.operation === 'apply' ? 'apply' : 'restore_commit',generated,client,p.expected,async () => {
          await lease.beforeStart(); await verifyLegacySubject(p.subject,session);
          guard(session); coordinator.assertAllowed(p.epoch); requireThat(p.expires >= clock(),'PREVIEW_EXPIRED');
        });
        let checked = null; try { checked = await status(await owners.read(project),client); } catch { /* Write succeeded; status is now unknown. */ }
        job.result = {operationId:id,client,outcome:p.operation === 'apply' ? 'applied' : 'restored',status:checked}; job.state = 'succeeded';
      } catch (e) {
        job.code = e instanceof ApiError ? e.code : 'OWNER_UNAVAILABLE';
        job.state = e instanceof WriteOutcomeUnknown ? 'unknown' : 'failed';
        if (job.state === 'unknown') { job.result = {operationId:id,client,outcome:'unknown',status:null}; }
      } finally { job.finished = clock(); lease.release(job.state === 'unknown' ? 'unknown' : 'known'); }
    })());
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([task,new Promise<void>((resolve) => { timer = setTimeout(resolve,8000); })]); if (timer) clearTimeout(timer);
    if (job.state === 'failed') throw new ApiError(job.code as ApiError['code']);
    return job.state === 'succeeded' || job.state === 'unknown' ? job.result : {operationId:id,client,outcome:'pending',status:null};
  }
  const server = createServer({maxHeaderSize:8192},async (req,res) => {
    let finishRequest!: () => void;
    const requestDone = new Promise<void>(resolve => { finishRequest = resolve; }); activeRequests.add(requestDone);
    const requestId = opaque();
    res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'");
    res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('Cache-Control','no-store'); res.setHeader('Referrer-Policy','no-referrer'); res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Cross-Origin-Resource-Policy','same-origin'); res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
    const reply = (code: number, value: unknown) => { if (res.destroyed) return; const bytes = Buffer.from(JSON.stringify(value)); requireThat(bytes.length <= 256*1024,'LIMIT_EXCEEDED'); res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Content-Length':bytes.length}); res.end(bytes); };
    try {
      // A launcher may open the public shell as a cross-site top-level document.
      // This exception carries no session data and never applies to an API call.
      const entryNavigation = req.method === 'GET' && req.url === '/' &&
        req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document';
      requireThat(req.headers.host === origin.slice(7) && (!req.headers.origin || req.headers.origin === origin) &&
        (req.headers['sec-fetch-site'] !== 'cross-site' || entryNavigation),'ORIGIN_REJECTED');
      if (assets.has(req.url!) && ['GET','HEAD'].includes(req.method!)) { const asset = assets.get(req.url!)!; res.writeHead(200,{'Content-Type':asset.type,'Content-Length':asset.body.length}); res.end(req.method === 'HEAD' ? undefined : asset.body); return; }
      requireThat(req.url?.startsWith('/api/v1/') && req.headers['x-lmti-ui'] === '1','UNAUTHENTICATED');
      requireThat(['GET','POST','PUT','DELETE'].includes(req.method!));
      if (req.method !== 'GET') requireThat(req.headers.origin === origin,'ORIGIN_REJECTED');
      const data = await dispatch(req); reply((data as {outcome?:string}).outcome === 'pending' ? 202 : 200,{apiVersion:1,requestId,ok:true,data});
    } catch (e) { const error = e instanceof ApiError ? e : new ApiError('OWNER_UNAVAILABLE'); if (!res.headersSent) reply(statuses[error.code],{apiVersion:1,requestId,ok:false,error:{code:error.code,message:error.message,retryable:['BUSY','OWNER_UNAVAILABLE'].includes(error.code)}}); }
    finally { activeRequests.delete(requestDone); finishRequest(); }
  });
  server.maxConnections = 32; server.requestTimeout = 5000; server.headersTimeout = 5000; server.keepAliveTimeout = 2000;
  server.on('clientError',(_e,socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'));
  try { await new Promise<void>((resolve,reject) => { server.once('error',reject); server.listen(owners.config.port,'127.0.0.1',resolve); }); }
  catch (e) { await coordinator.close(); throw e; }
  const address = server.address(); requireThat(address && typeof address !== 'string','OWNER_UNAVAILABLE'); origin = `http://127.0.0.1:${address.port}`;
  return {
    origin, server,
    isIdle() { cleanup(); return sessions.size === 0 && launches.size === 0 && activeRequests.size === 0 && activeTasks.size === 0 && coordinator.snapshot().activeLeases === 0 && owners.isIdle() && (!operations || operations.isIdle()) && (!hierarchy || hierarchy.isIdle()) && (!physicalHierarchy || physicalHierarchy.isIdle()); },
    issueLaunch() { requireThat(!stopping,'SESSION_EXPIRED'); cleanup(); requireThat(launches.size < 8,'BUSY'); const nonce = opaque(); launches.set(hash(nonce),clock()+30000); return `${origin}/#bootstrap=${nonce}`; },
    close(): Promise<void> {
      if (closing) return closing;
      stopping = true; coordinator.stop(); launches.clear();
      for (const s of sessions.values()) s.revoked = true;
      closing = (async () => {
        const httpClosed = new Promise<void>(resolve => server.close(() => resolve()));
        await Promise.all([...activeRequests]); await Promise.allSettled([...activeTasks]);
        await operations?.waitForIdle(); await hierarchy?.waitForIdle(); await physicalHierarchy?.waitForIdle(); await owners.waitForIdle(); await coordinator.close(); await httpClosed;
      })(); return closing;
    }
  };
}
