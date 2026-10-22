import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Owners } from '../dist/owners.js';
import { createLocalApi } from '../dist/server.js';

const repo = fileURLToPath(new URL('../../../',import.meta.url));
const pkg = resolve(process.env.LMTI_WEB_TEST_PACKAGE ?? join(repo,'build/studio-web01-20261013'));
const producer = process.env.LMTI_WEB_TEST_BINDING_PRODUCER;
const python = process.env.LMTI_WEB_TEST_PYTHON;
const project = 'factory-monitor', route = '/api/v1/projects/'+project;

function produce(args) {
  assert.ok(producer,'Set LMTI_WEB_TEST_BINDING_PRODUCER to the current test-only native executable.');
  const result = spawnSync(producer,args,{encoding:'utf8',windowsHide:true,timeout:15000,maxBuffer:256*1024});
  assert.equal(result.status,0,'The bounded native fixture operation must succeed.');
}
async function fixture(t,librarySchema = 3,projectSchema = 2,unicodePath = false) {
  assert.ok(python,'Set LMTI_WEB_TEST_PYTHON to a trusted Python executable.');
  await mkdir(join(repo,'build'),{recursive:true});
  const root = await mkdtemp(join(repo,unicodePath ? 'build/web-binding-Straße-' : 'build/web-binding-'));
  let api;
  t.after(async () => {
    if (api) await api.close();
    assert.ok(resolve(root).startsWith(resolve(repo,'build')+sep));
    await rm(root,{recursive:true,force:true});
  });
  produce(['--fixture',root,String(librarySchema),String(projectSchema)]);
  const configOwner = process.env.LMTI_WEB_TEST_CONFIG_OWNER ?? join(repo,'scripts/mcp-config-owner.py');
  const cfg = {
    adminBinary:process.env.LMTI_WEB_TEST_ADMIN ?? join(pkg,'bin/lmti-mcp-admin.exe'),
    projectBinary:process.env.LMTI_WEB_TEST_PROJECT_BINARY ?? join(pkg,'bin/lmti-project.exe'),
    library:join(root,'library.sqlite'),profiles:join(root,'profiles.sqlite'),python,
    // The real config owner accepts only its sibling fixed launcher. Keep the
    // fixture's trusted runtime pair together when overriding the script path.
    agentEntry:join(dirname(configOwner),'lmti-agent-mcp.py'),configOwner,
    allowedProjects:[project],port:0,openBrowser:false
  };
  const owners = new Owners(cfg); await owners.validateLaunch();
  return {root,cfg,owners,mutate(action) { produce(['--mutate',root,action]); },
    async start() {
      api = await createLocalApi(cfg);
      let token;
      async function send(path,method = 'GET',body) {
        const headers = {'X-LMTI-UI':'1',Origin:api.origin};
        if (token) headers.Authorization = `Bearer ${token}`;
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        const response = await fetch(api.origin+path,{method,headers,
          body:body === undefined ? undefined : JSON.stringify(body),signal:AbortSignal.timeout(10000)});
        return {http:response.status,...await response.json()};
      }
      const nonce = new URL(api.issueLaunch()).hash.slice('#bootstrap='.length);
      const boot = await send('/api/v1/session/bootstrap','POST',{nonce});
      assert.equal(boot.http,200); token=boot.data.token;
      return send;
    }};
}

for (const schema of [2,3]) test(`Library v${schema} cosmetics preserve both opaque identities without opening an offline sibling`,async (t) => {
  const f = await fixture(t,schema), before = await f.owners.read(project);
  const inventory = await f.owners.inventory();
  assert.deepEqual(inventory.map(v => v.id),[project]);
  f.mutate('cosmetics');
  const after = await f.owners.read(project), refreshed = await f.owners.inventory();
  assert.notEqual(refreshed[0].name,inventory[0].name);
  assert.equal(f.owners.bindingId(after),f.owners.bindingId(before));
  assert.equal(refreshed[0].bindingKey,inventory[0].bindingKey);
  assert.deepEqual(after.binding.libraryIdentity,before.binding.libraryIdentity);
});

for (const action of ['replace-library','root-aba','replace-project']) test(`${action} invalidates a real binding at unchanged project path and revision`,async (t) => {
  const f = await fixture(t), before = await f.owners.read(project), inventory = await f.owners.inventory();
  f.mutate(action);
  const after = await f.owners.read(project), refreshed = await f.owners.inventory();
  for (const field of ['id','database','root','projectRevision']) assert.equal(after.binding[field],before.binding[field]);
  assert.notEqual(f.owners.bindingId(after),f.owners.bindingId(before));
  if (action === 'replace-project') {
    assert.notEqual(after.binding.projectIdentity.storeUuid,before.binding.projectIdentity.storeUuid);
    // Inventory deliberately does not open each project database.
    assert.equal(refreshed[0].bindingKey,inventory[0].bindingKey);
  } else {
    assert.notEqual(refreshed[0].bindingKey,inventory[0].bindingKey);
    assert.equal(after.binding.libraryIdentity.digest,before.binding.libraryIdentity.digest);
    if (action === 'root-aba') {
      assert.equal(after.binding.libraryIdentity.uuid,before.binding.libraryIdentity.uuid);
      assert.equal(after.binding.libraryIdentity.generation,before.binding.libraryIdentity.generation+2);
    } else {
      assert.notEqual(after.binding.libraryIdentity.uuid,before.binding.libraryIdentity.uuid);
      assert.equal(after.binding.libraryIdentity.generation,before.binding.libraryIdentity.generation);
    }
  }
});

test('Legacy and absent libraries keep explicit unavailable identity without upgrading or creating files',async (t) => {
  const f = await fixture(t,1,1), bytes = await readFile(f.cfg.library), read = await f.owners.read(project);
  assert.equal(read.binding.libraryIdentity.schema,1);
  assert.equal(read.binding.libraryIdentity.uuid,null); assert.equal(read.binding.libraryIdentity.generation,null);
  assert.deepEqual(read.binding.projectIdentity,{schema:1,storeUuid:null,revision:1});
  assert.deepEqual(await readFile(f.cfg.library),bytes);
  const absent = new Owners({...f.cfg,library:join(f.root,'absent.sqlite')}); await absent.validateLaunch();
  assert.deepEqual(await absent.inventory(),[]); assert.deepEqual(await absent.summaries([]),[]);
  await assert.rejects(readFile(absent.config.library),{code:'ENOENT'});
});

test('Private identity parser rejects malformed evidence instead of accepting paths, guessed UUIDs or coercions',async (t) => {
  const f = await fixture(t), actual = await f.owners.native({action:'read',projectId:project});
  const changes = [
    v => { delete v.ok; }, v => { v.extra=true; }, v => { delete v.binding.libraryIdentity; },
    v => { v.binding.libraryIdentity=null; }, v => { v.binding.projectIdentity=null; },
    v => { v.binding.libraryIdentity.extra=true; }, v => { v.binding.projectIdentity.extra=true; },
    v => { v.binding.libraryIdentity.schema=4; }, v => { v.binding.libraryIdentity.schema='3'; },
    v => { v.binding.libraryIdentity.uuid=null; }, v => { v.binding.libraryIdentity.uuid='00000000-0000-0000-0000-000000000000'; },
    v => { v.binding.libraryIdentity.uuid='not-a-uuid'; }, v => { v.binding.libraryIdentity.generation=0; },
    v => { v.binding.libraryIdentity.generation='1'; }, v => { v.binding.libraryIdentity.generation=Number.MAX_SAFE_INTEGER+1; },
    v => { v.binding.libraryIdentity.digest='A'.repeat(64); }, v => { v.binding.libraryIdentity.digest='0'.repeat(63); },
    v => { v.binding.libraryIdentity.canonicalPath='//invalid-host/fixture.sqlite'; },
    v => { v.binding.libraryIdentity.canonicalPath='relative.sqlite'; },
    v => { v.binding.libraryIdentity.canonicalPath=f.root.replaceAll('\\','/')+'/child/../library.sqlite'; },
    v => { v.binding.libraryIdentity.schema=1; },
    v => { v.binding.projectIdentity.schema=1; }, v => { v.binding.projectIdentity.schema=3; },
    v => { v.binding.projectIdentity.storeUuid=null; }, v => { v.binding.projectIdentity.storeUuid='invalid'; },
    v => { v.binding.projectIdentity.revision=2; }, v => { v.binding.projectIdentity.revision='1'; },
    v => { v.binding.projectRevision=Number.MAX_SAFE_INTEGER; v.binding.projectIdentity.revision=v.binding.projectRevision; }
  ];
  for (const change of changes) {
    const invalid = structuredClone(actual); change(invalid);
    f.owners.native=async () => invalid;
    await assert.rejects(f.owners.read(project),{code:'OWNER_UNAVAILABLE'});
  }
  const malformedLegacy = structuredClone(actual);
  malformedLegacy.binding.libraryIdentity={...actual.binding.libraryIdentity,schema:1,uuid:null,generation:1};
  f.owners.native=async () => malformedLegacy;
  await assert.rejects(f.owners.read(project),{code:'OWNER_UNAVAILABLE'});
});

test('Native Unicode library keys are accepted as private opaque evidence and never used as an I/O path',async (t) => {
  const f = await fixture(t,3,2,true), actual = await f.owners.native({action:'read',projectId:project});
  const read = await f.owners.read(project), originalId=f.owners.bindingId(read);
  assert.ok(f.cfg.library.includes('Straße'));
  // Qt owns the spelling; do not assume full Unicode expansion or reproduce
  // its folding in JavaScript. The actual native key must remain stable.
  assert.equal(read.binding.libraryIdentity.canonicalPath,actual.binding.libraryIdentity.canonicalPath);
  assert.equal(f.owners.bindingId(await f.owners.read(project)),originalId);
  const altered=structuredClone(actual);
  altered.binding.libraryIdentity.canonicalPath=join(f.root,'distinct-native-key.sqlite').replaceAll('\\','/');
  f.owners.native=async () => altered;
  const accepted=await f.owners.read(project);
  assert.notEqual(f.owners.bindingId(accepted),originalId);
  assert.equal(accepted.binding.libraryIdentity.canonicalPath,altered.binding.libraryIdentity.canonicalPath);
  await assert.rejects(readFile(altered.binding.libraryIdentity.canonicalPath),{code:'ENOENT'});
  // This HTTP server owns a separate real native façade, so its responses prove
  // stripping with the actual Qt casefold key, not an injected HTTP response.
  const send=await f.start();
  const response=await send(route); assert.equal(response.http,200);
  publicOnly(response,[f.root,read.binding.libraryIdentity.canonicalPath,read.binding.libraryIdentity.uuid,
    read.binding.libraryIdentity.digest,read.binding.projectIdentity.storeUuid]);
});

test('Inventory and summary parsers enforce private envelope identity and exact public projection',async (t) => {
  const f = await fixture(t), inventory = await f.owners.native({action:'library'});
  const summary = await f.owners.native({action:'summaries',ids:[project]});
  for (const change of [v => { delete v.libraryIdentity; },v => { v.libraryIdentity=null; },
    v => { v.libraryIdentity.generation=0; },v => { v.privatePath=f.root; }]) {
    const invalid = structuredClone(inventory); change(invalid); f.owners.native=async () => invalid;
    await assert.rejects(f.owners.inventory(),{code:'OWNER_UNAVAILABLE'});
  }
  const invalid = structuredClone(summary); invalid.items[0].libraryIdentity=summary.libraryIdentity;
  f.owners.native=async () => invalid;
  await assert.rejects(f.owners.summaries([project]),{code:'OWNER_UNAVAILABLE'});
});

function publicOnly(value,privateValues) {
  const text = JSON.stringify(value).replaceAll('\\\\','/').toLowerCase();
  for (const item of privateValues.filter(Boolean)) assert.equal(text.includes(item.replaceAll('\\','/').toLowerCase()),false);
  const forbidden = new Set(['libraryIdentity','projectIdentity','database','root','canonicalPath','storeUuid','uuid','digest','generation','bindingKey']);
  function visit(v) {
    if (!v || typeof v !== 'object') return;
    for (const [key,child] of Object.entries(v)) { assert.equal(forbidden.has(key),false); visit(child); }
  }
  visit(value);
}
test('Real HTTP inventory, summaries, profile and corrupt-owner errors never disclose private identity',async (t) => {
  const f = await fixture(t), read = await f.owners.read(project), send = await f.start();
  const privateValues = [f.root,read.binding.libraryIdentity.canonicalPath,read.binding.libraryIdentity.uuid,
    read.binding.libraryIdentity.digest,read.binding.projectIdentity.storeUuid];
  for (const path of ['/api/v1/projects',route,route+'/mcp-profile']) {
    const response = await send(path); assert.equal(response.http,200); publicOnly(response,privateValues);
  }
  f.mutate('corrupt-library');
  const response = await send(route); assert.equal(response.http,503); assert.equal(response.error.code,'OWNER_UNAVAILABLE');
  assert.equal(Object.hasOwn(response,'data'),false); publicOnly(response,privateValues);
});

async function waitForFile(path) {
  for (let i=0;i<150;i++) {
    try { if (await readFile(path,'utf8')) return; } catch {}
    await new Promise(resolve => setTimeout(resolve,25));
  }
  assert.fail('Controlled queue holder did not start.');
}
async function waitForQueue(pool) {
  for (let i=0;i<150;i++) {
    // Observe the real bounded queue only; do not replace its guard or process.
    if (pool.waiting.length === 1) return;
    await new Promise(resolve => setTimeout(resolve,25));
  }
  assert.fail('The client request did not enter the occupied process queue.');
}
for (const action of ['replace-library','root-aba','replace-project']) test(`Queued client apply refuses ${action} before starting the config writer`,{timeout:30000},async (t) => {
  const f = await fixture(t), generated = await f.owners.generate(project,'cursor',1);
  const preview = await f.owners.client('preview',generated,'cursor');
  assert.equal(typeof preview.expected,'string');
  const holder=join(f.root,'queue-holder.cjs'), release=join(f.root,'release');
  await writeFile(holder,`const fs=require('node:fs');
fs.writeFileSync(process.argv[2]+'.started','started');
const timer=setInterval(()=>{if(fs.existsSync(process.argv[3])){clearInterval(timer);process.stdout.write('{}');}},10);
setTimeout(()=>{clearInterval(timer);process.exit(1);},12000).unref();
`);
  const held=[0,1].map(i => f.owners.pool.run(process.execPath,[holder,join(f.root,'slot'+i),release],'',{write:true}));
  // Install rejection handlers immediately, including on the queued mutation.
  const holders = Promise.allSettled(held);
  let attempted;
  try {
    await Promise.all([0,1].map(i => waitForFile(join(f.root,'slot'+i+'.started'))));
    attempted=f.owners.client('apply',generated,'cursor',preview.expected)
      .then(value => ({value}),error => ({error}));
    await waitForQueue(f.owners.pool);
    f.mutate(action);
    const projectBytes=await readFile(join(f.root,'project.sqlite')), profileBytes=await readFile(f.cfg.profiles);
    await writeFile(release,'release');
    const refused=await attempted;
    assert.equal(refused.error?.code,'CONFIG_CHANGED'); assert.equal(Object.hasOwn(refused,'value'),false);
    assert.deepEqual(await readFile(join(f.root,'project.sqlite')),projectBytes);
    assert.deepEqual(await readFile(f.cfg.profiles),profileBytes);
    assert.deepEqual(await readdir(join(f.root,'project-root')),[],'No client file, backup or journal may be written.');
  } finally {
    await writeFile(release,'release');
    const results=await holders;
    if (attempted) await attempted;
    for (const result of results) assert.equal(result.status,'fulfilled');
  }
});
