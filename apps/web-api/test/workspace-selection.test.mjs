import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm,stat} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {join,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createWorkspace,openWorkspace} from '../../../scripts/workspace-profile.mjs';
import {ProjectOperationOwner} from '../dist/project-operations-owner.js';
import {ProcessPool} from '../dist/process.js';

const repo=fileURLToPath(new URL('../../../',import.meta.url));
const pkg=process.env.LMTI_WEB_TEST_PACKAGE??join(repo,'build/lmti-v0.2.0-alpha.1-windows-x64');
const quote=value=>"'"+value.replaceAll("'","''")+"'";
const powershell=join(process.env.SystemRoot??'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe');

test('new registered project selection stays explicit and does not change saved profile or edit grants',{timeout:120000},async t=>{
  const root=await mkdtemp(join(repo,'build/workspace-selection-'));
  t.after(()=>{assert.ok(resolve(root).startsWith(resolve(repo,'build')+sep));return rm(root,{recursive:true,force:true});});
  const workspace=join(root,'workspace');
  await createWorkspace({action:'create',packageDirectory:pkg,workspaceDirectory:workspace,mode:'empty',
    projectId:'original-project',projectName:'Selection fixture',enableMaintenance:false});
  const profilePath=join(workspace,'lmti-workspace.json'),grantPath=join(workspace,'library-grants.json');
  const savedProfile=await readFile(profilePath),savedGrants=await readFile(grantPath);
  const profile=JSON.parse(savedProfile);assert.equal(profile.libraryManagement.folders.length,4);
  const copyParent=join(root,'reviewed-copies'),backupParent=join(root,'reviewed-backups');await mkdir(copyParent);await mkdir(backupParent);
  // The test explicitly upgrades through the existing native owner; opening a
  // profile must never perform this migration or alter the maintenance grant.
  const pool=new ProcessPool(1),owner=new ProjectOperationOwner({adminBinary:join(pkg,'bin/lmti-mcp-admin.exe'),
    library:join(workspace,'data/project-library.sqlite'),copyParent,backupParent},pool);
  const review=await owner.read({action:'library-format-preview',fromSchema:1});
  const upgrade=await owner.write({action:'library-upgrade-v1',expected:review.expected});
  assert.equal(upgrade.reply.outcome,'confirmed');await pool.waitForIdle();
  const binary=join(pkg,'bin/lmti-project.exe'),database=join(workspace,'projects/new-project.sqlite'),library=join(workspace,'data/project-library.sqlite');
  const native=(mode,body)=>{
    const result=spawnSync(binary,['library-'+mode,library],{input:JSON.stringify(body),windowsHide:true,shell:false,timeout:15000,maxBuffer:16384});
    assert.equal(result.status,0,'The native library review/commit must accept the exact approved distinct folder.');
    const value=JSON.parse(result.stdout);assert.equal(value.ok,true);return value;
  };
  const state=native('state',{}),change={action:'create',expected:state.signature,id:'new-project',label:'New selection fixture',
    folder:profile.libraryManagement.folders[1].path,database:'',parent:profile.libraryManagement.parent};
  assert.equal(change.folder,join(workspace,'source-2'));
  native('review',change);await assert.rejects(stat(database),{code:'ENOENT'},'Preview cannot create project metadata.');
  const committed=native('commit',change);assert.ok(committed.state.entries.some(entry=>entry.id==='new-project'));
  const request={action:'open',profilePath};
  const original=await openWorkspace(request);
  assert.deepEqual(original.selectedProjectIds,['original-project']);assert.deepEqual(original.contentProjectIds,['original-project']);
  const readonly=await openWorkspace({...request,projectIds:['new-project']});
  assert.deepEqual(readonly.selectedProjectIds,['new-project']);assert.deepEqual(readonly.contentProjectIds,[]);assert.equal(readonly.enableMaintenance,false);
  const mixed=await openWorkspace({...request,projectIds:['original-project','new-project']});
  assert.deepEqual(mixed.contentProjectIds,['original-project']);
  const editable=await openWorkspace({...request,projectIds:['new-project'],grantProjectContent:true});
  assert.deepEqual(editable.contentProjectIds,['new-project']);assert.equal(editable.enableMaintenance,false);
  await assert.rejects(openWorkspace({...request,projectIds:['missing-project']}),{code:'SCOPE_DENIED'});
  assert.deepEqual(await readFile(profilePath),savedProfile);assert.deepEqual(await readFile(grantPath),savedGrants);
  const script="$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';& "+quote(join(repo,'scripts/open-local-workspace.ps1'))+
    ' -WorkspaceFile '+quote(profilePath)+" -ProjectId 'new-project' -GrantProjectContent -ValidateOnly | ConvertTo-Json -Compress";
  const run=spawnSync(powershell,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],
    {encoding:'utf8',windowsHide:true,timeout:40000,maxBuffer:16384});
  assert.equal(run.status,0,'The real opener must validate an explicit new-project edit scope.');
  const validated=JSON.parse(run.stdout);assert.deepEqual(validated.selectedProjectIds,['new-project']);assert.deepEqual(validated.contentProjectIds,['new-project']);
  assert.equal(validated.enableMaintenance,false);assert.deepEqual(await readFile(profilePath),savedProfile);
});

test('invalid or implicit expanded selection is refused before profile access',async()=>{
  const request={action:'open',profilePath:join(repo,'build','missing-workspace-not-read','lmti-workspace.json')};
  for(const change of [{projectIds:[]},{projectIds:['first','first']},{projectIds:['CON']},{projectIds:['bad id']},
    {projectIds:Array.from({length:501},(_,i)=>'project-'+i)},{grantProjectContent:true},{projectIds:['first'],grantProjectContent:'yes'}])
    await assert.rejects(openWorkspace({...request,...change}),{code:'INVALID_INPUT'});
  const script="$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';try{& "+quote(join(repo,'scripts/open-local-workspace.ps1'))+
    ' -WorkspaceFile '+quote(request.profilePath)+" -GrantProjectContent -ValidateOnly}catch{[Console]::Error.Write($_.Exception.Message);exit 7};exit 9";
  const run=spawnSync(powershell,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],
    {encoding:'utf8',windowsHide:true,timeout:10000,maxBuffer:8192});
  assert.equal(run.status,7);assert.equal(run.stdout,'');
  assert.equal(run.stderr,'GrantProjectContent requires explicit registered ProjectId selection.');
});
