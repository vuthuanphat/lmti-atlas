import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, cp, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyPackage, inspectPackage } from '../dist/doctor.js';
const repo=fileURLToPath(new URL('../../../',import.meta.url));

test('packaged doctor loads native runtime and checks every listed file without opening operator data',async()=>{
  const pkg=process.env.LMTI_WEB_TEST_PACKAGE ?? join(repo,'build/lmti-v0.2.0-alpha.1-windows-x64');
  assert.ok(process.env.LMTI_WEB_TEST_PYTHON);
  const result=await inspectPackage(pkg,process.env.LMTI_WEB_TEST_PYTHON);
  const manifest=JSON.parse(await readFile(join(pkg,'manifest.json'),'utf8'));
  assert.equal(result.ok,true); assert.equal(result.nativeRuntime,'loaded'); assert.equal(result.integrity.files,manifest.files.length);
  if (manifest.files.some(row => row.file === 'share/lmti/mapping-owner/index.js')) {
    assert.equal(result.mappingRuntime,'loaded');
  } else {
    assert.equal(Object.hasOwn(result,'mappingRuntime'),false);
  }
});

test('package verification rejects tampering, duplicate keys/files, traversal, absent components and links',async(t)=>{
  const root=await mkdtemp(join(repo,'build/web03-doctor-'));
  t.after(()=>{assert.ok(resolve(root).startsWith(resolve(repo,'build')+sep));return rm(root,{recursive:true,force:true});});
  const data='synthetic'; await writeFile(join(root,'sample.js'),data);
  const good={file:'sample.js',sha256:createHash('sha256').update(data).digest('hex')};
  const manifest=files=>JSON.stringify({schema:'lmti.local-web.package.v1',requires:[],files});
  const refused=async text=>{await writeFile(join(root,'manifest.json'),text);await assert.rejects(verifyPackage(root));};
  await refused(manifest([{...good,sha256:'0'.repeat(64)}]));
  await refused(manifest([good,{...good,file:'SAMPLE.js'}]));
  await refused(manifest([{...good,file:'../sample.js'}]));
  await refused(manifest([{...good,file:'C:/sample.js'}]));
  await refused(manifest([{...good,file:'//remote/share'}]));
  await refused(manifest([good])); // Missing runtime is not a complete package.
  await refused('{"schema":"lmti.local-web.package.v1","schema":"duplicate","requires":[],"files":[]}');
  const target=join(root,'target'); await mkdir(target); await writeFile(join(target,'sample.js'),data);
  // Directory junctions on Windows require no symlink privilege. Local synthetic target only.
  await symlink(target,join(root,'linked'),'junction');
  await refused(manifest([{...good,file:'linked/sample.js'}]));
});

test('reviewed mapping package components are optional together and refused when incomplete',async(t)=>{
  const root=await mkdtemp(join(repo,'build/web03-mapping-doctor-'));
  t.after(()=>{assert.ok(resolve(root).startsWith(resolve(repo,'build')+sep));return rm(root,{recursive:true,force:true});});
  const pkg=join(root,'package');
  await cp(process.env.LMTI_WEB_TEST_PACKAGE ?? join(repo,'build/lmti-v0.2.0-alpha.1-windows-x64'),pkg,{recursive:true});
  const manifestPath=join(pkg,'manifest.json');
  const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
  const capability=['share/lmti/mapping-owner/index.js','share/lmti/mapping-owner/package.json',
    'share/lmti/python/src/lmti_agent/mappings.py','share/lmti/python/src/lmti_agent/reviewed_knowledge.py'];
  for (const file of capability) {
    const path=join(pkg,file);
    let bytes;
    try { bytes=await readFile(path); } catch(error) { if(error.code!=='ENOENT') throw error; }
    await mkdir(join(path,'..'),{recursive:true});
    const payload=bytes ?? Buffer.from('synthetic doctor capability fixture');
    await writeFile(path,payload);
    if (!manifest.files.some(row=>row.file===file)) {
      manifest.files.push({file,sha256:createHash('sha256').update(payload).digest('hex')});
    }
  }
  await writeFile(manifestPath,JSON.stringify(manifest));
  await verifyPackage(pkg); // Integrity only; the synthetic additions are never executed.
  for(const missing of capability) {
    const path=join(pkg,missing), payload=await readFile(path);
    await rm(path);
    await writeFile(manifestPath,JSON.stringify({...manifest,files:manifest.files.filter(row=>row.file!==missing)}));
    await assert.rejects(verifyPackage(pkg));
    await writeFile(path,payload);
  }
  // A historical package with no reviewed capability keeps the old integrity contract.
  for(const file of capability) await rm(join(pkg,file));
  await writeFile(manifestPath,JSON.stringify({...manifest,files:manifest.files.filter(row=>!capability.includes(row.file))}));
  await verifyPackage(pkg);
});

test('a complete package refuses extra executable files but permits normal SDK bytecode caches',async(t)=>{
  const root=await mkdtemp(join(repo,'build/web03-extra-'));
  t.after(()=>{assert.ok(resolve(root).startsWith(resolve(repo,'build')+sep));return rm(root,{recursive:true,force:true});});
  const pkg=join(root,'package');
  await cp(process.env.LMTI_WEB_TEST_PACKAGE ?? join(repo,'build/lmti-v0.2.0-alpha.1-windows-x64'),pkg,{recursive:true});
  const extra=join(pkg,'bin/unlisted.dll'); await writeFile(extra,'synthetic unlisted runtime');
  await assert.rejects(verifyPackage(pkg)); await rm(extra);
  const cache=join(pkg,'share/lmti/python/src/lmti_agent/__pycache__'); await mkdir(cache,{recursive:true});
  await writeFile(join(cache,'synthetic.cpython-314.pyc'),'synthetic cache');
  const result=await verifyPackage(pkg); const manifest=JSON.parse(await readFile(join(pkg,'manifest.json'),'utf8'));
  assert.equal(result.files,manifest.files.length);
});

test('browser package needs no desktop runtime and rejects a rehashed retired GUI',async(t)=>{
  const root=await mkdtemp(join(repo,'build/web-only-doctor-'));
  t.after(()=>{assert.ok(resolve(root).startsWith(resolve(repo,'build')+sep));return rm(root,{recursive:true,force:true});});
  const pkg=join(root,'package');
  await cp(process.env.LMTI_WEB_TEST_PACKAGE ?? join(repo,'build/lmti-v0.2.0-alpha.1-windows-x64'),pkg,{recursive:true});
  const path=join(pkg,'manifest.json');
  const manifest=JSON.parse(await readFile(path,'utf8'));
  assert.equal(manifest.files.some(row=>/lmti-desktop|Qt6Gui|Qt6Widgets|plugins\/platforms|start-local-studio-fallback/i.test(row.file)),false);
  await verifyPackage(pkg);
  for(const file of ['bin/lmti-desktop.exe','bin/Qt6Widgets.dll','bin/Qt6Gui.dll',
    'plugins/platforms/qwindows.dll','scripts/start-local-studio-fallback.ps1']) {
    const payload=Buffer.from('synthetic retired component, never executed');
    await mkdir(join(pkg,file,'..'),{recursive:true});
    await writeFile(join(pkg,file),payload);
    await writeFile(path,JSON.stringify({...manifest,files:[...manifest.files,
      {file,sha256:createHash('sha256').update(payload).digest('hex')}]}));
    await assert.rejects(verifyPackage(pkg));
    await rm(join(pkg,file));
  }
});
