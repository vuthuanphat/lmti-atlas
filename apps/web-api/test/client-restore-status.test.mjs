import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLocalApi } from '../dist/server.js';

const repo = fileURLToPath(new URL('../../../',import.meta.url));
const pkg = resolve(process.env.LMTI_WEB_TEST_PACKAGE ?? join(repo,'build/studio-web01-20261013'));
const producer = resolve(process.env.LMTI_WEB_TEST_PRODUCER ?? join(repo,'build/native-web01-20261013/bin/Release/lmti-mcp-profile-tests.exe'));
const python = process.env.LMTI_WEB_TEST_PYTHON;
const route = '/api/v1/projects/factory-monitor';
const client = route+'/clients/cursor';

async function fixture(t) {
  assert.ok(python,'Set LMTI_WEB_TEST_PYTHON to the trusted Python executable.');
  const root = await mkdtemp(join(repo,'build/web-restore-status-'));
  let api;
  t.after(async () => {
    if (api) await api.close();
    assert.ok(resolve(root).startsWith(resolve(repo,'build')+sep));
    await rm(root,{recursive:true,force:true});
  });
  const integration = join(root,'integration.json');
  await writeFile(integration,JSON.stringify({schema:'lmti.agent.integration.v1',projectId:'factory-monitor',site:'factory-demo',
    target:'external',knowledge:null,observations:null}));
  const cfg = {
    adminBinary:process.env.LMTI_WEB_TEST_ADMIN ?? join(pkg,'bin/lmti-mcp-admin.exe'),projectBinary:process.env.LMTI_WEB_TEST_PROJECT_BINARY ?? join(pkg,'bin/lmti-project.exe'),
    library:join(root,'project-library.sqlite'),profiles:join(root,'mcp-profiles.sqlite'),python,
    agentEntry:join(dirname(process.env.LMTI_WEB_TEST_CONFIG_OWNER),'lmti-agent-mcp.py'),configOwner:process.env.LMTI_WEB_TEST_CONFIG_OWNER,
    allowedProjects:['factory-monitor'],port:0,openBrowser:false,
    agentRead:{entry:process.env.LMTI_WEB_TEST_AGENT_OWNER ?? join(repo,'scripts/agent-read-owner.py'),
      projects:[{projectId:'factory-monitor',site:'factory-demo',target:'external',integrationConfig:integration}]}
  };
  const produced = spawnSync(producer,[root],{encoding:'utf8',windowsHide:true,timeout:15000,maxBuffer:1024*1024,
    env:{...process.env,LMTI_PYTHON_BINARY:python,LMTI_AGENT_ENTRY:cfg.agentEntry,LMTI_PROJECT_BINARY:cfg.projectBinary}});
  assert.equal(produced.status,0,'The real native fixture producer must succeed.');
  api = await createLocalApi(cfg);
  let token;
  async function send(path,method = 'GET',body) {
    const headers = {'X-LMTI-UI':'1',Origin:api.origin};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(api.origin+path,{method,headers,body:body === undefined ? undefined : JSON.stringify(body)});
    return {http:response.status,...await response.json()};
  }
  const nonce = new URL(api.issueLaunch()).hash.slice('#bootstrap='.length);
  const boot = await send('/api/v1/session/bootstrap','POST',{nonce});
  assert.equal(boot.http,200); token = boot.data.token;
  return {root,cfg,integration,send,async restartWithLocalGrant() {
    // A new trusted launch is the only way to change a fixed runtime grant.
    await api.close(); token = undefined;
    cfg.agentRead.projects[0].target = 'local';
    api = await createLocalApi(cfg);
    const nonce = new URL(api.issueLaunch()).hash.slice('#bootstrap='.length);
    const boot = await send('/api/v1/session/bootstrap','POST',{nonce});
    assert.equal(boot.http,200); token = boot.data.token;
  }};
}

for (const mode of ['changed integration pin','local-only integration grant']) {
  test(`client inspection and protected Restore survive ${mode} while export, apply and Check remain denied`,async (t) => {
    const f = await fixture(t);
    const profile = await f.send(route+'/mcp-profile'); assert.equal(profile.http,200);
    const revision = profile.data.revision;
    const local = profile.data.servers.find(s => s.enabled && s.transport === 'lmti_local');
    assert.ok(local,'A real native local MCP definition is required.');
    const database = join(f.root,'synthetic-project.sqlite');
    const databaseBefore = await readFile(database);
    const profilesBefore = await readFile(f.cfg.profiles);
    const dest = join(f.root,'.cursor/mcp.json');
    await mkdir(join(f.root,'.cursor'),{recursive:true});
    const original = '{"private_setting":"synthetic-only-restore-value","mcpServers":{"unmanaged":{"url":"https://example.invalid/mcp"}}}\n';
    await writeFile(dest,original);
    const apply = await f.send(client+'/previews','POST',{expectedProfileRevision:revision,operation:'apply'});
    assert.equal(apply.http,200);
    const applied = await f.send(client+'/commit','POST',{previewId:apply.data.id});
    assert.equal(applied.http,200); assert.equal(applied.data.outcome,'applied');
    assert.equal(applied.data.status.canRestore,true);
    const appliedBytes = await readFile(dest);
    assert.notEqual(appliedBytes.toString(),original);
    const oldPreview = await f.send(client+'/previews','POST',{expectedProfileRevision:revision,operation:'apply'});
    assert.equal(oldPreview.http,200);

    const integrationBytes = await readFile(f.integration);
    if (mode === 'changed integration pin') await writeFile(f.integration,Buffer.concat([integrationBytes,Buffer.from('\n')]));
    else await f.restartWithLocalGrant();

    // The first pin check detects CONFIG_CHANGED. A later call observes the
    // permanent SCOPE_DENIED state, even after the original bytes are restored.
    for (let attempt = 0; attempt < 2; attempt++) {
      const status = await f.send(client);
      assert.equal(status.http,200);
      assert.equal(status.data.configuration,'review_required');
      assert.equal(status.data.canRestore,true);
      assert.equal(status.data.appliedRevision,revision);
      assert.equal(status.data.clientUse,'not_verified');
      assert.equal(status.data.evidenceId,null);
      assert.equal(JSON.stringify(status).includes('synthetic-only-restore-value'),false);
      assert.equal(JSON.stringify(status).includes(f.root),false);
      if (mode === 'changed integration pin') await writeFile(f.integration,integrationBytes);
    }
    for (const [path,body] of [
      [client+'/export',{expectedProfileRevision:revision}],
      [client+'/previews',{expectedProfileRevision:revision,operation:'apply'}],
      [route+`/connections/${local.id}/check`,{}]
    ]) {
      const refused = await f.send(path,'POST',body);
      assert.equal(refused.http,403); assert.equal(refused.error.code,'SCOPE_DENIED');
      assert.equal(Object.hasOwn(refused,'data'),false);
    }
    const oldCommit = await f.send(client+'/commit','POST',{previewId:oldPreview.data.id});
    assert.equal(oldCommit.error.code,mode === 'changed integration pin' ? 'SCOPE_DENIED' : 'PREVIEW_EXPIRED',
      'A new launch cannot adopt an old session preview; in-session revocation remains permanent.');
    assert.deepEqual(await readFile(dest),appliedBytes,'Denied actions must preserve the applied client file.');
    const restore = await f.send(client+'/previews','POST',{expectedProfileRevision:revision,operation:'restore'});
    assert.equal(restore.http,200); assert.equal(restore.data.generatedConfig,null);
    assert.equal(restore.data.protectedRecovery,true);
    assert.equal(JSON.stringify(restore).includes('synthetic-only-restore-value'),false);
    const restored = await f.send(client+'/commit','POST',{previewId:restore.data.id});
    assert.equal(restored.http,200); assert.equal(restored.data.outcome,'restored');
    assert.equal(restored.data.status.canRestore,false);
    assert.equal(restored.data.status.configuration,'review_required');
    assert.equal(restored.data.status.appliedRevision,null);
    assert.equal(await readFile(dest,'utf8'),original,'Protected Restore must restore the exact original bytes.');
    assert.deepEqual(await readFile(database),databaseBefore);
    assert.deepEqual(await readFile(f.cfg.profiles),profilesBefore);
    const stillDenied = await f.send(client+'/export','POST',{expectedProfileRevision:revision});
    assert.equal(stillDenied.error.code,'SCOPE_DENIED','Restore must never revive integration authority.');
  });
}
