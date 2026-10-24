import {createHash} from 'node:crypto';
import {lstat,mkdir,readFile,realpath,writeFile} from 'node:fs/promises';
import {dirname,isAbsolute,join,parse,resolve,sep} from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {exact,requireThat,strictJson} from '../apps/web-api/dist/security.js';
import {verifyPackage} from '../apps/web-api/dist/doctor.js';

const schema='lmti.local-web.workspace.v1';
const idPattern=/^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const validId=value=>typeof value==='string'&&idPattern.test(value)&&!value.endsWith('.')&&
  !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value);
const key=path=>process.platform==='win32'?path.toLowerCase():path;
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const outside=(path,parent)=>key(path)!==key(parent)&&!key(path).startsWith(key(parent)+sep);

/** Reject spelling before resolving or following any filesystem component. */
export function localPath(value) {
  requireThat(typeof value==='string'&&value.isWellFormed()&&value.length>0&&value.length<=1024&&isAbsolute(value)&&
    !/[\x00-\x1f\x7f<>"|?*]/.test(value),'INVALID_INPUT');
  const spelling=value.replaceAll('\\','/'),volume=parse(value).root.replaceAll('\\','/');
  requireThat(!spelling.startsWith('//')&&!spelling.replace(/^[A-Za-z]:/,'').includes(':'),'INVALID_INPUT');
  const parts=spelling.slice(volume.length).split('/');
  requireThat(parts.every(part=>part&&part!=='.'&&part!=='..'&&!/[. ]$/.test(part)&&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)&&part.toLowerCase()!=='.lmti'),'INVALID_INPUT');
  return resolve(value);
}

async function checkedPath(value,type,{missingLeaf=false}={}) {
  const path=localPath(value),volume=parse(path).root;
  const parts=path.slice(volume.length).split(/[\\/]/);let cursor=volume;
  for(let index=-1;index<parts.length;index++) {
    if(index>=0)cursor=join(cursor,parts[index]);
    const leaf=index===parts.length-1;let info;
    try{info=await lstat(cursor);}catch(error){
      if(leaf&&missingLeaf&&error.code==='ENOENT')return path;
      throw error;
    }
    requireThat(!info.isSymbolicLink()&&(leaf&&type==='file'?info.isFile()&&info.nlink===1:info.isDirectory()),'OWNER_UNAVAILABLE');
    requireThat(key(await realpath(cursor))===key(cursor),'OWNER_UNAVAILABLE');
  }
  return path;
}

function derived(root,projectId,maintenance,folderCount=1) {
  const folders=Array.from({length:folderCount},(_,index)=>({key:index?'workspace-source-'+(index+1):'workspace-source',
    label:index?'Additional source '+(index+1):'Workspace source',path:join(root,index?'source-'+(index+1):'source')}));
  return {dataDirectory:join(root,'data'),projectId,projectContent:true,
    libraryManagement:{parent:join(root,'projects'),folders,candidates:[]},
    maintenance:{enabled:maintenance,copyParent:maintenance?join(root,'copies'):null,backupParent:maintenance?join(root,'backups'):null}};
}

export function checkedProfile(value,profilePath) {
  const p=exact(value,['schema','package','dataDirectory','projectId','projectContent','libraryManagement','maintenance']);
  const pkg=exact(p.package,['root','manifestSha256','sourceCommit']);
  requireThat(p.schema===schema&&validId(p.projectId)&&p.projectContent===true);
  const root=dirname(localPath(profilePath));
  requireThat(join(root,'lmti-workspace.json')===profilePath);
  const packageRoot=localPath(pkg.root);
  requireThat(outside(root,packageRoot)&&outside(packageRoot,root));
  requireThat(typeof pkg.manifestSha256==='string'&&/^[a-f0-9]{64}$/.test(pkg.manifestSha256)&&
    typeof pkg.sourceCommit==='string'&&/^[a-f0-9]{40}$/.test(pkg.sourceCommit));
  const maintenance=exact(p.maintenance,['enabled','copyParent','backupParent']);
  requireThat(typeof maintenance.enabled==='boolean');
  exact(p.libraryManagement,['parent','folders','candidates']);
  requireThat(Array.isArray(p.libraryManagement.folders)&&p.libraryManagement.folders.length>=1&&p.libraryManagement.folders.length<=8&&
    Array.isArray(p.libraryManagement.candidates)&&p.libraryManagement.candidates.length===0);
  for(const folder of p.libraryManagement.folders)exact(folder,['key','label','path']);
  const expected=derived(root,p.projectId,maintenance.enabled,p.libraryManagement.folders.length);
  requireThat(p.dataDirectory===expected.dataDirectory&&
    p.libraryManagement.parent===expected.libraryManagement.parent&&
    p.libraryManagement.folders.every((folder,index)=>folder.key===expected.libraryManagement.folders[index].key&&
      folder.label===expected.libraryManagement.folders[index].label&&folder.path===expected.libraryManagement.folders[index].path)&&
    maintenance.copyParent===expected.maintenance.copyParent&&maintenance.backupParent===expected.maintenance.backupParent);
  return {schema,package:{root:packageRoot,manifestSha256:pkg.manifestSha256,sourceCommit:pkg.sourceCommit},...expected};
}

async function inspectTrustedPackage(root) {
  root=await checkedPath(root,'directory');
  await verifyPackage(root);
  const manifestBytes=await readFile(join(root,'manifest.json'));
  const manifest=strictJson(manifestBytes);
  for(const file of manifest.files)requireThat((await lstat(join(root,file.file))).nlink===1,'OWNER_UNAVAILABLE');
  for(const name of ['scripts/workspace-profile.mjs','scripts/open-local-workspace.ps1','scripts/setup-local-web.ps1'])await checkedPath(join(root,name),'file');
  const release=exact(strictJson(await readFile(join(root,'release.json'))),
    ['schema','version','sourceCommit','pythonVersion','nativeVersion','platform','publication']);
  requireThat(release.schema==='lmti.release.v1'&&release.version==='0.2.0-alpha.1'&&
    typeof release.sourceCommit==='string'&&/^[a-f0-9]{40}$/.test(release.sourceCommit),'OWNER_UNAVAILABLE');
  return {root,manifestSha256:sha(manifestBytes),sourceCommit:release.sourceCommit};
}

function native(binary,args,input='',maxBuffer=16384) {
  const env={};for(const name of ['SystemRoot','WINDIR'])if(process.env[name])env[name]=process.env[name];
  const result=spawnSync(binary,args,{shell:false,windowsHide:true,env,input,timeout:30000,maxBuffer});
  requireThat(!result.error&&result.status===0,'OWNER_UNAVAILABLE');
  return result.stdout;
}

function launchScript(packageRoot) {
  // Only one PowerShell single-quoted literal is generated. cmd content is fixed.
  const wrapper=join(packageRoot,'scripts','open-local-workspace.ps1').replaceAll("'","''");
  return "$ErrorActionPreference='Stop'\r\n& '"+wrapper+"' -WorkspaceFile (Join-Path $PSScriptRoot 'lmti-workspace.json')\r\n";
}

export async function createWorkspace(value) {
  const hasFolderCount=Object.hasOwn(value??{},'projectFolderCount');
  const r=exact(value,['action','packageDirectory','workspaceDirectory','mode','projectId','projectName','enableMaintenance',...(hasFolderCount?['projectFolderCount']:[])]);
  const folderCount=hasFolderCount?r.projectFolderCount:4;
  requireThat(r.action==='create'&&['demo','empty'].includes(r.mode)&&typeof r.enableMaintenance==='boolean');
  requireThat(Number.isInteger(folderCount)&&folderCount>=1&&folderCount<=8);
  requireThat(validId(r.projectId)&&typeof r.projectName==='string'&&r.projectName.isWellFormed()&&
    r.projectName.length>0&&Buffer.byteLength(r.projectName,'utf8')<=120&&!/[\x00-\x1f\x7f]/.test(r.projectName));
  if(r.mode==='demo')requireThat(r.projectId==='factory-monitor'&&r.projectName==='Factory Monitor');
  const workspace=localPath(r.workspaceDirectory),pkg=await inspectTrustedPackage(r.packageDirectory);
  requireThat(outside(workspace,pkg.root)&&outside(pkg.root,workspace),'SCOPE_DENIED');
  await checkedPath(dirname(workspace),'directory');
  // Exclusive admission: existing folders, including partial previous attempts,
  // are preserved. No automatic rollback deletes operator-owned state.
  await mkdir(workspace);
  const profile={schema,package:pkg,...derived(workspace,r.projectId,r.enableMaintenance,folderCount)};
  const folders=[profile.dataDirectory,profile.libraryManagement.parent,...profile.libraryManagement.folders.map(folder=>folder.path)];
  if(r.enableMaintenance)folders.push(profile.maintenance.copyParent,profile.maintenance.backupParent);
  for(const folder of folders)await mkdir(folder);
  const binary=join(pkg.root,'bin','lmti-project.exe'),database=join(profile.libraryManagement.parent,r.projectId+'.sqlite');
  native(binary,r.mode==='demo'?['init-demo',database]:['init-project',database,r.projectId,r.projectName]);
  await checkedPath(database,'file');
  native(binary,['library-register',join(profile.dataDirectory,'project-library.sqlite'),database,profile.libraryManagement.folders[0].path]);
  await checkedPath(join(profile.dataDirectory,'project-library.sqlite'),'file');
  await writeFile(join(workspace,'library-grants.json'),JSON.stringify(profile.libraryManagement,null,2)+'\n',{encoding:'utf8',flag:'wx'});
  // Windows PowerShell 5 decodes a script with non-ASCII paths as ANSI unless
  // the file has a BOM. JSON stays plain UTF-8; this fixed launcher gets a BOM.
  await writeFile(join(workspace,'Open-LMTI.ps1'),'\ufeff'+launchScript(pkg.root),{encoding:'utf8',flag:'wx'});
  await writeFile(join(workspace,'Open-LMTI.cmd'),'@echo off\r\n"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoLogo -NoProfile -File "%~dp0Open-LMTI.ps1"\r\nif errorlevel 1 (\r\n  echo LMTI could not open. Check the trusted package and runtime prerequisites. No policy bypass was used.\r\n  pause\r\n)\r\n',{encoding:'utf8',flag:'wx'});
  const profilePath=join(workspace,'lmti-workspace.json');
  await writeFile(profilePath,JSON.stringify(profile,null,2)+'\n',{encoding:'utf8',flag:'wx'});
  return {kind:'lmti-local-workspace',version:1,profilePath,workspaceDirectory:workspace,projectId:r.projectId,mode:r.mode,maintenance:r.enableMaintenance,projectFolderCount:folderCount};
}

export async function openWorkspace(value) {
  const selected=Object.hasOwn(value??{},'projectIds'),content=Object.hasOwn(value??{},'grantProjectContent');
  const r=exact(value,['action','profilePath',...(selected?['projectIds']:[]),...(content?['grantProjectContent']:[])]);requireThat(r.action==='open');
  if(selected)requireThat(Array.isArray(r.projectIds)&&r.projectIds.length>0&&r.projectIds.length<=500&&
    r.projectIds.every(validId)&&new Set(r.projectIds).size===r.projectIds.length);
  if(content)requireThat(selected&&typeof r.grantProjectContent==='boolean');
  const profilePath=await checkedPath(r.profilePath,'file');
  requireThat((await lstat(profilePath)).size<=16384,'LIMIT_EXCEEDED');
  const profile=checkedProfile(strictJson(await readFile(profilePath)),profilePath);
  const pkg=await inspectTrustedPackage(profile.package.root);
  requireThat(pkg.manifestSha256===profile.package.manifestSha256&&pkg.sourceCommit===profile.package.sourceCommit,'CONFIG_CHANGED');
  for(const folder of [profile.dataDirectory,profile.libraryManagement.parent,...profile.libraryManagement.folders.map(folder=>folder.path)])await checkedPath(folder,'directory');
  for(const name of ['project-library.sqlite','mcp-profiles.sqlite'])await checkedPath(join(profile.dataDirectory,name),'file',{missingLeaf:true});
  const libraryFile=join(dirname(profilePath),'library-grants.json');await checkedPath(libraryFile,'file');
  requireThat((await lstat(libraryFile)).size<=12288,'LIMIT_EXCEEDED');
  const savedGrant=strictJson(await readFile(libraryFile));
  requireThat(JSON.stringify(savedGrant)===JSON.stringify(profile.libraryManagement),'CONFIG_CHANGED');
  if(profile.maintenance.enabled)for(const folder of [profile.maintenance.copyParent,profile.maintenance.backupParent])await checkedPath(folder,'directory');
  // Selection is a fresh local-operator grant for this launch only. Inventory
  // never expands saved authority, and read selection alone grants no new edit.
  if(selected){
    const catalog=exact(strictJson(native(join(pkg.root,'bin/lmti-project.exe'),
      ['library-state',join(profile.dataDirectory,'project-library.sqlite')],'{}',256*1024)),
      ['ok','schema','signature','format','uuid','entries']);
    requireThat(catalog.ok===true&&catalog.schema==='lmti.library.management.v1'&&
      Array.isArray(catalog.entries)&&catalog.entries.length<=500,'OWNER_UNAVAILABLE');
    const ids=new Set();
    for(const value of catalog.entries){const row=exact(value,['id','label','pinned','folderLinked']);
      requireThat(validId(row.id)&&!ids.has(row.id),'OWNER_UNAVAILABLE');ids.add(row.id);}
    requireThat(r.projectIds.every(id=>ids.has(id)),'SCOPE_DENIED');
  }
  const selectedProjectIds=selected?[...r.projectIds]:[profile.projectId];
  const contentProjectIds=r.grantProjectContent===true?[...selectedProjectIds]:selectedProjectIds.filter(id=>id===profile.projectId);
  return {kind:'lmti-local-workspace-open',version:1,profilePath,launcher:join(pkg.root,'scripts','start-local-web.ps1'),
    packageDirectory:pkg.root,dataDirectory:profile.dataDirectory,projectId:profile.projectId,selectedProjectIds,contentProjectIds,libraryManagementFile:libraryFile,
    enableMaintenance:profile.maintenance.enabled,copyParent:profile.maintenance.copyParent,backupParent:profile.maintenance.backupParent};
}

async function main() {
  let size=0;const chunks=[];
  for await(const chunk of process.stdin){size+=chunk.length;requireThat(size<=16384,'LIMIT_EXCEEDED');chunks.push(chunk);}
  const value=strictJson(Buffer.concat(chunks));
  const result=value?.action==='create'?await createWorkspace(value):await openWorkspace(value);
  process.stdout.write(JSON.stringify(result)+'\n');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{
  const code=['INVALID_INPUT','SCOPE_DENIED','OWNER_UNAVAILABLE','LIMIT_EXCEEDED','CONFIG_CHANGED'].includes(error?.code)?error.code:
    error?.code==='EEXIST'?'WORKSPACE_EXISTS':'WORKSPACE_UNAVAILABLE';
  process.stderr.write(JSON.stringify({kind:'lmti-workspace-error',version:1,code})+'\n');process.exitCode=1;
});
