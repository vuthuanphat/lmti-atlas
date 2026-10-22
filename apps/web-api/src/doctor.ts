import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { exact, requireThat, strictJson, trustedPath } from './security.js';

const required = [
  'bin/lmti-mcp-admin.exe', 'bin/lmti-project.exe', 'bin/lmti-desktop.exe',
  'bin/Qt6Core.dll', 'bin/Qt6Gui.dll', 'bin/Qt6Widgets.dll', 'bin/Qt6Sql.dll',
  'plugins/platforms/qwindows.dll', 'plugins/sqldrivers/qsqlite.dll',
  'share/lmti/scripts/lmti-agent-mcp.py', 'share/lmti/scripts/mcp-config-owner.py',
  'share/lmti/scripts/agent-read-owner.py', 'share/lmti/knowledge-owner/index.js', 'share/lmti/knowledge-owner/package.json',
  ...['client','source','knowledge','observations','integrated','integration_config','integrated_mcp','operator_read'].map(n => `share/lmti/python/src/lmti_agent/${n}.py`),
  'apps/web-api/package.json', 'apps/web-ui/dist/index.html',
  ...['main','server','owners','security','process','assets','contracts','doctor'].map(n => `apps/web-api/dist/${n}.js`),
  'scripts/start-local-web.ps1', 'scripts/test-local-web-package.ps1', 'scripts/start-local-studio-fallback.ps1'
];

// Existing packages may omit this capability. A present capability must be complete.
const reviewedMappingFiles = [
  'share/lmti/mapping-owner/index.js', 'share/lmti/mapping-owner/package.json',
  'share/lmti/python/src/lmti_agent/mappings.py',
  'share/lmti/python/src/lmti_agent/reviewed_knowledge.py',
];

/** Read only publisher files. No operator library/config or network inspection. */
export async function verifyPackage(root: string) {
  await trustedPath(root, 'directory');
  const manifestPath = join(root, 'manifest.json'); await trustedPath(manifestPath, 'file');
  requireThat((await stat(manifestPath)).size <= 2*1024*1024, 'LIMIT_EXCEEDED');
  const manifest = exact(strictJson(await readFile(manifestPath)), ['schema','requires','files']);
  requireThat(manifest.schema === 'lmti.local-web.package.v1' && Array.isArray(manifest.requires) &&
    manifest.requires.length <= 16 && manifest.requires.every(v => typeof v === 'string' && v.length <= 128));
  requireThat(Array.isArray(manifest.files) && manifest.files.length <= 2000, 'LIMIT_EXCEEDED');
  const names = new Set<string>(); let bytes = 0;
  for (const entry of manifest.files) {
    const file = exact(entry, ['file','sha256']);
    requireThat(typeof file.file === 'string' && file.file.length <= 512 &&
      /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(file.file) &&
      !file.file.split('/').some(p => p === '.' || p === '..') && file.file !== 'manifest.json');
    const key = file.file.toLowerCase(); requireThat(!names.has(key)); names.add(key);
    requireThat(typeof file.sha256 === 'string' && /^[A-Fa-f0-9]{64}$/.test(file.sha256));
    const location = join(root, ...file.file.split('/')); await trustedPath(location, 'file');
    const size = (await stat(location)).size; bytes += size;
    requireThat(size <= 128*1024*1024 && bytes <= 512*1024*1024, 'LIMIT_EXCEEDED');
    const digest = createHash('sha256'); let read = 0;
    for await (const chunk of createReadStream(location)) {
      read += chunk.length; requireThat(read <= size, 'LIMIT_EXCEEDED'); digest.update(chunk);
    }
    requireThat(read === size && digest.digest('hex').toLowerCase() === file.sha256.toLowerCase(), 'OWNER_UNAVAILABLE');
  }
  requireThat(required.every(p => names.has(p.toLowerCase())), 'OWNER_UNAVAILABLE');
  requireThat(!reviewedMappingFiles.some(p => names.has(p.toLowerCase())) ||
    reviewedMappingFiles.every(p => names.has(p.toLowerCase())), 'OWNER_UNAVAILABLE');
  // Reject extra executable/assets/SDK files as well as missing listed files.
  // Python creates caches during normal runs; only .pyc files in SDK cache
  // directories may be unlisted. They are not publisher-authenticated artifacts.
  let entries = 0;
  async function tree(relative = '') {
    const folder = join(root,relative); await trustedPath(folder,'directory');
    const children = await readdir(folder,{withFileTypes:true});
    entries += children.length; requireThat(entries <= 3000,'LIMIT_EXCEEDED');
    for (const child of children) {
      const file = relative ? relative+'/'+child.name : child.name;
      if (child.isDirectory()) { await tree(file); continue; }
      requireThat(child.isFile(),'OWNER_UNAVAILABLE'); await trustedPath(join(root,file),'file');
      const cache = /^share\/lmti\/python\/src\/(?:[A-Za-z0-9_-]+\/)+__pycache__\/[A-Za-z0-9_.-]+\.pyc$/.test(file);
      requireThat(file === 'manifest.json' || names.has(file.toLowerCase()) || cache,'OWNER_UNAVAILABLE');
    }
  }
  await tree();
  const htmlPath=join(root,'apps/web-ui/dist/index.html');
  requireThat((await stat(htmlPath)).size <= 2*1024*1024,'LIMIT_EXCEEDED');
  const html=await readFile(htmlPath,'utf8');
  const assets=[...html.matchAll(/(?:src|href)="(\/assets\/[A-Za-z0-9_-]+\.(?:js|css))"/g)].map(m=>m[1]);
  requireThat(assets.some(p=>p.endsWith('.js')) && assets.some(p=>p.endsWith('.css')) &&
    assets.every(p=>names.has(('apps/web-ui/dist'+p).toLowerCase())),'OWNER_UNAVAILABLE');
  return {files: names.size, bytes};
}

export async function inspectPackage(root: string, python: string) {
  requireThat(process.platform === 'win32' && process.arch === 'x64', 'NOT_SUPPORTED');
  requireThat(Number(process.versions.node.split('.')[0]) >= 24, 'NOT_SUPPORTED');
  await trustedPath(process.execPath, 'file'); await trustedPath(python, 'file');
  const integrity = await verifyPackage(root);
  const env: Record<string,string> = {PYTHONIOENCODING:'utf-8'};
  for (const k of ['SystemRoot','WINDIR']) if (process.env[k]) env[k] = process.env[k]!;
  const run = (binary: string, args: string[], expectedExit = 0) => {
    const result = spawnSync(binary,args,{shell:false,windowsHide:true,env,input:'',encoding:'utf8',timeout:10000,maxBuffer:16384});
    requireThat(!result.error && result.status === expectedExit, 'OWNER_UNAVAILABLE'); return result.stdout;
  };
  const version = exact(strictJson(Buffer.from(run(python,['-I','-S','-c',
    'import json,sys,struct;print(json.dumps({"version":list(sys.version_info[:3]),"bits":struct.calcsize("P")*8}))']))), ['version','bits']);
  requireThat(Array.isArray(version.version) && version.version.length === 3 &&
    version.version.every(v => Number.isInteger(v) && v >= 0) && version.version[0] === 3 && version.version[1] >= 11 && version.bits === 64, 'NOT_SUPPORTED');
  // No arguments: refuses before opening a database. Proves native/Qt Core
  // can load; does not claim full desktop parity or operator acceptance.
  const native = exact(strictJson(Buffer.from(run(join(root,'bin/lmti-mcp-admin.exe'),[]))), ['ok','code']);
  requireThat(native.ok === false && native.code === 'INVALID_INPUT', 'OWNER_UNAVAILABLE');
  // Empty input must reach the fixed denial boundary without opening any source.
  // This also verifies bundled CommonJS dependencies can load from the ESM entry.
  const knowledge = exact(strictJson(Buffer.from(run(process.execPath,[join(root,'share/lmti/knowledge-owner/index.js'),'agent-context'],3))),['schema','error']);
  requireThat(knowledge.schema === 'lmti.agent.knowledge.v1' && knowledge.error === 'KNOWLEDGE_REQUEST_DENIED','OWNER_UNAVAILABLE');
  const mappingEntry = join(root,'share/lmti/mapping-owner/index.js');
  const mappingPresent = await stat(mappingEntry).then(() => true, error => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
  if (mappingPresent) {
    // Missing fixed config arguments refuse before opening a source or store.
    const mapping = exact(strictJson(Buffer.from(run(process.execPath,[mappingEntry,'accepted-mappings'],3))),['schema','error']);
    requireThat(mapping.schema === 'lmti.impact.mapping-current.v1' &&
      mapping.error === 'INVALID_INPUT','OWNER_UNAVAILABLE');
  }
  return {kind:'lmti-local-web-doctor',version:1,ok:true,node:process.versions.node,
    python:version.version.join('.'),integrity,nativeRuntime:'loaded',knowledgeRuntime:'loaded',
    ...(mappingPresent ? {mappingRuntime:'loaded'} : {}),
    limits:['Manifest hashes are integrity evidence, not a publisher signature.',
      'Unlisted package files refused except SDK Python caches; cache files are not publisher authenticated.',
      'Clean Windows, browser controls, actual clients and provider authentication still require acceptance.']};
}
