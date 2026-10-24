import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,link,symlink,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {join,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {checkedProfile,localPath,createWorkspace,openWorkspace} from '../../../scripts/workspace-profile.mjs';

const repo=fileURLToPath(new URL('../../../',import.meta.url));
const packageRoot=process.env.LMTI_WEB_TEST_PACKAGE??join(repo,'build/lmti-v0.2.0-alpha.1-windows-x64');
const helper=join(repo,'scripts/workspace-profile.mjs');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const quote=value=>"'"+value.replaceAll("'","''")+"'";
const powershell=join(process.env.SystemRoot??'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
async function fixture(t) {
  const root=await mkdtemp(join(repo,'build/workspace-setup-'));
  t.after(()=>{assert.ok(resolve(root).startsWith(resolve(repo,'build')+sep));return rm(root,{recursive:true,force:true});});
  return root;
}
const request=(workspace,extra={})=>({action:'create',packageDirectory:packageRoot,workspaceDirectory:workspace,mode:'empty',projectId:'operator-project',projectName:'Dự án nghiệm thu',enableMaintenance:false,...extra});
function cli(input) {
  return spawnSync(process.execPath,[helper],{input,encoding:'utf8',windowsHide:true,timeout:60000,maxBuffer:32768});
}

test('workspace path spelling rejects redirects, device names, private layer and unsafe components before access',()=>{
  for(const value of ['relative','C:relative','\\\\remote\\share\\data','C:\\data:alternate','C:\\data\\..\\new','C:\\data\\.lmti\\new',
    'C:\\data\\CON','C:\\data\\trailing.','C:\\data\\trailing ','C:\\data\\bad\nname','C:\\data\\bad"name'])assert.throws(()=>localPath(value));
  assert.equal(localPath(join(repo,'build','dữ-liệu')),resolve(repo,'build','dữ-liệu'));
});

test('reserved project IDs and overlong UTF-8 labels refuse before package or workspace access',async()=>{
  const invalid={...request(join(repo,'build','must-not-create')),packageDirectory:join(repo,'build','missing-package-must-not-be-read')};
  for(const projectId of ['CON','con.data','Prn','nul','COM1','lpt9.logs','trailing.'])
    await assert.rejects(createWorkspace({...invalid,projectId}),{code:'INVALID_INPUT'});
  for(const projectName of ['x'.repeat(121),'ề'.repeat(41),'\ud800','bad\nname'])
    await assert.rejects(createWorkspace({...invalid,projectName}),{code:'INVALID_INPUT'});
  for(const projectFolderCount of [0,9,1.5,'4'])
    await assert.rejects(createWorkspace({...invalid,projectFolderCount}),{code:'INVALID_INPUT'});
});

test('fresh workspace creates native metadata, exact least-privilege grants and reusable UTF-8 launchers',{timeout:120000},async t=>{
  const root=await fixture(t),workspace=join(root,'dữ-liệu thử nghiệm');
  const made=await createWorkspace(request(workspace));
  assert.equal(made.projectId,'operator-project');assert.equal(made.maintenance,false);
  const file=join(workspace,'lmti-workspace.json'),profile=JSON.parse(await readFile(file,'utf8'));
  assert.equal(profile.schema,'lmti.local-web.workspace.v1');assert.equal(profile.projectContent,true);
  assert.deepEqual(profile.libraryManagement.candidates,[]);assert.equal(profile.libraryManagement.folders.length,4);
  assert.deepEqual(profile.libraryManagement.folders.map(folder=>folder.key),['workspace-source','workspace-source-2','workspace-source-3','workspace-source-4']);
  assert.deepEqual(profile.maintenance,{enabled:false,copyParent:null,backupParent:null});
  assert.equal(profile.package.manifestSha256,sha(await readFile(join(packageRoot,'manifest.json'))));
  const opened=await openWorkspace({action:'open',profilePath:file});assert.equal(opened.projectId,'operator-project');
  assert.equal(opened.enableMaintenance,false);
  assert.equal((await readFile(join(workspace,'Open-LMTI.ps1'))).subarray(0,3).toString('hex'),'efbbbf');
  const cmd=await readFile(join(workspace,'Open-LMTI.cmd'),'utf8');
  assert.match(cmd,/%~dp0Open-LMTI\.ps1/);assert.doesNotMatch(cmd,/-ExecutionPolicy|-EncodedCommand|bootstrap=|Bearer /i);
  assert.match(cmd,/"%SystemRoot%\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe"/);
  const native=spawnSync(join(packageRoot,'bin/lmti-project.exe'),['library-state',join(workspace,'data/project-library.sqlite')],
    {input:'{}',encoding:'utf8',windowsHide:true,timeout:10000});
  assert.equal(native.status,0);const state=JSON.parse(native.stdout);
  assert.equal(state.format,1);assert.deepEqual(state.entries,[{folderLinked:true,id:'operator-project',label:'Dự án nghiệm thu',pinned:false}]);
  for(const folder of profile.libraryManagement.folders)assert.deepEqual(await readdir(folder.path),[]);
  const before=sha(await readFile(file));await assert.rejects(createWorkspace(request(workspace)),{code:'EEXIST'});
  assert.equal(sha(await readFile(file)),before,'Repeat setup must preserve the existing workspace.');
});

test('demo and optional maintenance remain explicit without upgrading the initial library',{timeout:120000},async t=>{
  const root=await fixture(t),workspace=join(root,'demo');
  await createWorkspace(request(workspace,{mode:'demo',projectId:'factory-monitor',projectName:'Factory Monitor',enableMaintenance:true,projectFolderCount:1}));
  const opened=await openWorkspace({action:'open',profilePath:join(workspace,'lmti-workspace.json')});
  assert.equal(opened.enableMaintenance,true);assert.equal(opened.copyParent,join(workspace,'copies'));assert.equal(opened.backupParent,join(workspace,'backups'));
  assert.equal(JSON.parse(await readFile(join(workspace,'lmti-workspace.json'),'utf8')).libraryManagement.folders.length,1,
    'The existing single-folder profile shape remains valid and is not expanded.');
  const native=spawnSync(join(packageRoot,'bin/lmti-project.exe'),['library-state',join(workspace,'data/project-library.sqlite')],
    {input:'{}',encoding:'utf8',windowsHide:true,timeout:10000});
  assert.equal(native.status,0);assert.equal(JSON.parse(native.stdout).format,1,'Setup must never silently upgrade schema.');
});

test('profile rejects unknown fields, wider grants, altered package provenance and mismatched grant files',{timeout:120000},async t=>{
  const root=await fixture(t),workspace=join(root,'scoped');await createWorkspace(request(workspace));
  const file=join(workspace,'lmti-workspace.json'),original=await readFile(file,'utf8'),profile=JSON.parse(original);
  const mutations=[p=>p.token='synthetic',p=>p.projectContent=false,p=>p.projectId='bad id',p=>p.libraryManagement.candidates.push({key:'other'}),
    p=>p.libraryManagement.folders[0].path=join(root,'outside'),p=>p.dataDirectory=join(root,'elsewhere'),p=>p.maintenance.enabled='yes'];
  for(const mutate of mutations){const value=structuredClone(profile);mutate(value);assert.throws(()=>checkedProfile(value,file));}
  await writeFile(file,JSON.stringify({...profile,package:{...profile.package,manifestSha256:'0'.repeat(64)}}));
  await assert.rejects(openWorkspace({action:'open',profilePath:file}),{code:'CONFIG_CHANGED'});await writeFile(file,original);
  const grantFile=join(workspace,'library-grants.json'),saved=await readFile(grantFile);await writeFile(grantFile,'{"parent":"synthetic"}');
  await assert.rejects(openWorkspace({action:'open',profilePath:file}),{code:'CONFIG_CHANGED'});await writeFile(grantFile,saved);
  const doubled=original.replace('"projectContent": true','"projectContent": true,"projectContent": true');await writeFile(file,doubled);
  await assert.rejects(openWorkspace({action:'open',profilePath:file}),{code:'INVALID_INPUT'});
});

test('workspace CLI rejects duplicate keys and oversized requests without disclosing raw input',async()=>{
  for(const input of ['{"action":"open","action":"create","profilePath":"sensitive-synthetic-marker"}',
    JSON.stringify({action:'open',profilePath:'sensitive-synthetic-marker',unexpected:true}),'x'.repeat(16385)]) {
    const result=cli(input);assert.equal(result.status,1);assert.equal(result.stdout,'');
    assert.doesNotMatch(result.stderr,/sensitive-synthetic-marker|Error:|\\Users\\/);assert.equal(JSON.parse(result.stderr).kind,'lmti-workspace-error');
  }
});

test('workspace opener gives actionable missing-Node guidance before reading a profile',()=>{
  const script="$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$env:PATH='';try{& "+quote(join(repo,'scripts/open-local-workspace.ps1'))+
    " -WorkspaceFile 'C:\\missing-workspace-must-not-be-read\\lmti-workspace.json'}catch{[Console]::Error.Write($_.Exception.Message);exit 7};exit 9";
  const result=spawnSync(powershell,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],
    {encoding:'utf8',windowsHide:true,timeout:10000,maxBuffer:8192});
  assert.equal(result.status,7);assert.equal(result.stdout,'');
  assert.equal(result.stderr,'Node.js is missing. Install trusted Node.js 24+ x64 from nodejs.org, then reopen this console.');
});

test('workspace refuses linked parents and hardlinked profiles without touching targets',{timeout:120000},async t=>{
  const root=await fixture(t),target=join(root,'actual');await mkdir(target);const junction=join(root,'redirect');await symlink(target,junction,'junction');
  await assert.rejects(createWorkspace(request(join(junction,'workspace'))));assert.deepEqual(await readdir(target),[]);
  const workspace=join(root,'safe');await createWorkspace(request(workspace));
  const file=join(workspace,'lmti-workspace.json'),alias=join(root,'profile-copy.json');await link(file,alias);
  const before=sha(await readFile(file));await assert.rejects(openWorkspace({action:'open',profilePath:file}));assert.equal(sha(await readFile(file)),before);
});

test('PowerShell 5 setup and validation keep Vietnamese names and paths intact',{timeout:120000},async t=>{
  const root=await fixture(t),workspace=join(root,'nghiệm thu PS5');
  const setup=join(repo,'scripts/setup-local-web.ps1'),open=join(repo,'scripts/open-local-workspace.ps1');
  // Unicode source travels over UTF-16 EncodedCommand; production owner JSON uses UTF-8.
  const script="$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';& "+quote(setup)+' -PackageDirectory '+quote(packageRoot)+
    ' -WorkspaceDirectory '+quote(workspace)+" -Mode empty -ProjectId ps5-project -ProjectName 'Dự án Windows' -NonInteractive -NoLaunch | Out-Null;& "+
    quote(open)+' -WorkspaceFile '+quote(join(workspace,'lmti-workspace.json'))+' -ValidateOnly | ConvertTo-Json -Compress';
  const run=spawnSync(powershell,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],
    {encoding:'utf8',windowsHide:true,timeout:110000,maxBuffer:32768});
  assert.equal(run.status,0,'The real PowerShell setup must complete with exact UTF-8 data.');
  const native=spawnSync(join(packageRoot,'bin/lmti-project.exe'),['library-state',join(workspace,'data/project-library.sqlite')],
    {input:'{}',encoding:'utf8',windowsHide:true,timeout:10000});
  assert.equal(native.status,0);assert.equal(JSON.parse(native.stdout).entries[0].label,'Dự án Windows');
});
