// Synthetic web-export/actual-client evidence; never changes personal configuration.
// Optional integrated fixture: LMTI_WEB_TEST_INTEGRATION=1 and trusted LMTI_WEB_TEST_NODE.
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { trustedPath } from '../apps/web-api/dist/security.js';
import { inspectPackage } from '../apps/web-api/dist/doctor.js';
const repo = fileURLToPath(new URL('../', import.meta.url));
const pkg = resolve(process.env.LMTI_WEB_TEST_PACKAGE ?? join(repo, 'build/studio-web03-projection-20261014'));
const producer = resolve(process.env.LMTI_WEB_TEST_PRODUCER ?? join(repo, 'build/native-mcp-20261013/bin/Release/lmti-mcp-profile-tests.exe'));
const python = process.env.LMTI_WEB_TEST_PYTHON, codex = process.env.LMTI_WEB_TEST_CODEX;
const integrated = process.env.LMTI_WEB_TEST_INTEGRATION === '1';
if (process.env.LMTI_WEB_TEST_INTEGRATION && !integrated) throw new Error('Integration mode must be explicitly 1 or unset.');
const node = process.env.LMTI_WEB_TEST_NODE;
if (!python || !codex || (integrated && !node)) throw new Error('Set trusted test runtime and installed Codex paths.');
await trustedPath(pkg, 'directory');
for (const file of [producer, python, codex, ...(integrated ? [node] : [])]) await trustedPath(file, 'file');
await inspectPackage(pkg, python);
const { createLocalApi } = await import(pathToFileURL(join(pkg, 'apps/web-api/dist/server.js')));
const root = await mkdtemp(join(repo, 'build/web02-client-'));
const cfg = { adminBinary:join(pkg,'bin/lmti-mcp-admin.exe'), projectBinary:join(pkg,'bin/lmti-project.exe'),
  library:join(root,'project-library.sqlite'), profiles:join(root,'mcp-profiles.sqlite'), python,
  agentEntry:join(pkg,'share/lmti/scripts/lmti-agent-mcp.py'), configOwner:join(pkg,'share/lmti/scripts/mcp-config-owner.py'),
  allowedProjects:['factory-monitor'],port:0,openBrowser:false };
const testEnvironment = Object.fromEntries(['SystemRoot','WINDIR','TEMP','TMP'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
const produced = spawnSync(producer,[root],{
  encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:1024*1024,
  env:{...testEnvironment,LMTI_PYTHON_BINARY:python,LMTI_AGENT_ENTRY:cfg.agentEntry,LMTI_PROJECT_BINARY:cfg.projectBinary}
});
if (produced.status !== 0) throw new Error('Fixture failed.');
const clientArgs = ['-I',join(repo,'scripts/cp01-client-smoke.py'),'--evidence',root,'--codex',codex,'--package',pkg];
if (integrated) {
  const built = spawnSync(python,['-I',join(repo,'scripts/create-agent-integration-fixture.py'),
    '--directory',root,'--package',pkg,'--node',node],{
    encoding:'utf8',windowsHide:true,timeout:60000,maxBuffer:1024*1024,
    env:{...testEnvironment,PYTHONIOENCODING:'utf-8'}
  });
  if (built.status !== 0) throw new Error('Integrated fixture failed.');
  const integrationConfig = join(root,'integration.json');
  cfg.agentRead = {entry:join(pkg,'share/lmti/scripts/agent-read-owner.py'),projects:[{
    projectId:'factory-monitor',site:'factory-demo',target:'external',integrationConfig
  }]};
  clientArgs.push('--integration-config',integrationConfig);
}
const api = await createLocalApi(cfg);
try {
  const nonce = new URL(api.issueLaunch()).hash.slice('#bootstrap='.length);
  const headers = {'X-LMTI-UI':'1',Origin:api.origin,'Content-Type':'application/json'};
  async function request(path, body) {
    const response = await fetch(api.origin+path,{method:'POST',headers,body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
    const result = await response.json();
    if (!response.ok || result.ok !== true) throw new Error('Authenticated fixture request refused.');
    return result.data;
  }
  const boot = await request('/api/v1/session/bootstrap',{nonce});
  headers.Authorization = `Bearer ${boot.token}`;
  for (const client of ['codex','cursor']) {
    const result = await request(`/api/v1/projects/factory-monitor/clients/${client}/export`,{expectedProfileRevision:1});
    await writeFile(join(root,client==='codex'?'codex.toml':'cursor.json'),result.content);
  }
  // The inner bounded RPC has time to clean up its client after a refusal/timeout.
  const smoke = spawnSync(python,clientArgs,{encoding:'utf8',windowsHide:true,timeout:240000,maxBuffer:1024*1024,
    env:{...testEnvironment,PYTHONIOENCODING:'utf-8'}});
  if (smoke.status !== 0) {
    let phase = 'process';
    try {
      const report = JSON.parse(smoke.stdout);
      if (['configuration','initialize','discovery','context','task_context','observations','integrated_evidence','read_only'].includes(report.phase)) phase = report.phase;
    } catch { /* Do not expose process logs or generated configuration. */ }
    throw new Error(`Actual-client smoke failed at ${phase}.`);
  }
  const evidence = JSON.parse(smoke.stdout);
  assert.equal(evidence.codex?.status, 'passed');
  assert.equal(evidence.profile, integrated ? 'integrated' : 'legacy');
  await writeFile(join(root,'web-export-report.json'),JSON.stringify({...evidence,schema:'lmti.web-client.smoke.v1',source:'authenticated packaged web export',packageDirectory:pkg},null,2));
  console.log(JSON.stringify({root,profile:evidence.profile,codex:evidence.codex,cursor:evidence.cursor,
    integrated:evidence.integrated,launcher:evidence.launcher,sourceBytesUnchanged:evidence.sourceBytesUnchanged}));
} finally { await api.close(); }
