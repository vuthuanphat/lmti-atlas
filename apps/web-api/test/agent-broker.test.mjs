import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Owners, agentArguments } from '../dist/owners.js';
import { ApiError } from '../dist/security.js';

const repo = fileURLToPath(new URL('../../../',import.meta.url));
const kinds = ['component','asset','release','repository','knowledge','subsystem','site','area','environment'];
const relations = ['declared_dependency','deployed_to_desired','has_release','declared_connection','implemented_in','documented_by',
  'contains_subsystem','contains_component','contains_area','contains_asset','in_environment'];
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('Agent query vocabulary includes declared structure without an authority flag',() => {
  for (const kind of kinds) {
    for (const operation of ['entity','related','task_context']) {
      const argumentsValue = {kind,entityId:'selected',...(operation === 'task_context' ? {task:'Review declared context'} : {})};
      assert.deepEqual(agentArguments(operation,argumentsValue),{operation,arguments:argumentsValue});
    }
  }
  const args = {kind:'asset',entityId:'selected',relationTypes:relations,direction:'inbound',depth:8,limit:200};
  assert.deepEqual(agentArguments('related',args).arguments,args);
});

test('Agent filters reject coercible kinds, malformed relations and capability/pin injection',() => {
  for (const kind of ['project','device','Site','',true,0,{},['site'],null])
    assert.throws(() => agentArguments('entity',{kind,entityId:'selected'}),{code:'INVALID_INPUT'});
  for (const relationTypes of [[],['contains_asset','contains_asset'],['unknown'],['CONTAINS_ASSET'],
    [['contains_asset']],[null],[true],{},'contains_asset',[...relations,'additional']])
    assert.throws(() => agentArguments('related',{kind:'site',entityId:'selected',relationTypes}),{code:'INVALID_INPUT'});
  for (const direction of [['both'],true,{},''])
    assert.throws(() => agentArguments('related',{kind:'site',entityId:'selected',direction}),{code:'INVALID_INPUT'});
  for (const extra of [{structure:true},{include_structure:true},{integrationSha256:'0'.repeat(64)},
    {integrationConfig:'untrusted.json'},{projectId:'different'},{site:'different'},{target:'local'}])
    assert.throws(() => agentArguments('entity',{kind:'site',entityId:'selected',...extra}),{code:'INVALID_INPUT'});
});

async function fixture(t, schema = null, python = null) {
  await mkdir(join(repo,'build'),{recursive:true});
  const root = await mkdtemp(join(repo,'build/agent-broker-'));
  t.after(async () => {
    assert.ok(resolve(root).startsWith(resolve(repo,'build')+sep));
    await rm(root,{recursive:true,force:true});
  });
  // These are inert test-owned files. The pool below captures the internal
  // request; it never executes placeholders or writes personal client settings.
  const files = ['lmti-mcp-admin.exe','lmti-project.exe','python.exe','lmti-agent-mcp.py','mcp-config-owner.py',
    'agent-read-owner.py','web-broker-guard.py','project.sqlite'];
  for (const name of files) await writeFile(join(root,name),'synthetic fixture');
  const integrationConfig = schema === null ? null : join(root,'integration.json');
  if (integrationConfig !== null) await writeFile(integrationConfig,JSON.stringify({
    schema,projectId:'project',site:'site',target:'external',knowledge:null,observations:null,
    ...(schema === 'lmti.agent.integration.v2' ? {structure:true} : {})
  }));
  const grant = {projectId:'project',site:'site',target:'external',integrationConfig};
  const config = {adminBinary:join(root,'lmti-mcp-admin.exe'),projectBinary:join(root,'lmti-project.exe'),
    python:python??join(root,'python.exe'),agentEntry:join(root,'lmti-agent-mcp.py'),configOwner:join(root,'mcp-config-owner.py'),
    library:join(root,'library.sqlite'),profiles:join(root,'profiles.sqlite'),allowedProjects:['project'],port:0,openBrowser:false,
    agentRead:{entry:join(root,'agent-read-owner.py'),projects:[grant]}};
  const owners = new Owners(config);
  await owners.validateLaunch();
  const canonicalLibrary = resolve(config.library).replaceAll('\\','/');
  const read = {binding:{id:'project',name:'Synthetic',database:join(root,'project.sqlite'),root,projectRevision:1,
    libraryIdentity:{schema:1,canonicalPath:process.platform === 'win32' ? canonicalLibrary.toLowerCase() : canonicalLibrary,
      uuid:null,generation:null,digest:'b'.repeat(64)},
    projectIdentity:{schema:1,storeUuid:null,revision:1}},
    profile:{projectId:'project',revision:1,servers:[]}};
  // Native binding verification stays exercised against one fixed receipt.
  owners.native = async (request) => { assert.deepEqual(request,{action:'read',projectId:'project'}); return {ok:true,...read}; };
  const response = {schema:'lmti.agent.response.v1',operation:'project.context',status:'ok',
    scope:{projectId:'project',site:'site',modelTarget:'external'},sources:[],evidence:[],
    completeness:{},data:{entities:[]},unknowns:[],conflicts:[],error:null};
  return {root,owners,config,grant,read,response,integrationConfig};
}

for (const schema of [null,'lmti.agent.integration.v1','lmti.agent.integration.v2']) {
  test(`Agent broker hands off the exact launch pin for ${schema ?? 'no integration'}`,async (t) => {
    const f = await fixture(t,schema), oldGrantId = f.owners.grantId(f.grant);
    const pinned = f.integrationConfig === null ? null : digest(await readFile(f.integrationConfig));
    const original = f.integrationConfig === null ? null : await readFile(f.integrationConfig);
    let calls = 0;
    f.owners.pool.run = async (binary,args,input,options) => {
      calls++;
      await options.guard();
      assert.equal(binary,f.config.python);
      assert.deepEqual(args,['-I','-X','utf8',f.config.agentRead.entry]);
      const payload = JSON.parse(input);
      assert.deepEqual(Object.keys(payload).sort(),['binary','database','projectId','site','target','integrationConfig',
        'integrationSha256','operation','arguments','cursorKey'].sort());
      assert.deepEqual(payload,{binary:f.config.projectBinary,database:f.read.binding.database,projectId:'project',site:'site',
        target:'external',integrationConfig:f.integrationConfig,integrationSha256:pinned,operation:'context',arguments:{limit:1},cursorKey:'a'.repeat(64)});
      return {ok:true,response:f.response};
    };
    assert.deepEqual(await f.owners.agent(f.read,f.grant,'context',{limit:1},'a'.repeat(64)),f.response);
    assert.equal(calls,1);
    assert.equal(f.owners.grantId(f.grant),oldGrantId);
    if (original !== null) assert.deepEqual(await readFile(f.integrationConfig),original);
  });
}

test('Isolated Windows Python returns Vietnamese metadata through the real broker pipe',
  {skip:process.platform!=='win32'||!process.env.LMTI_WEB_TEST_PYTHON},async t=>{
    const f=await fixture(t,null,process.env.LMTI_WEB_TEST_PYTHON), label='Phân hệ kiểm thử giao diện – tiếng Việt';
    // Keep the existing native receipt verification fixture, but execute the
    // real isolated Python process and its UTF-8 stdin/stdout transport.
    const expected={...f.response,operation:'project.task_context',data:{entities:[{label}]}};
    await writeFile(f.config.agentRead.entry,`import json,sys
assert sys.flags.isolated == 1
request=json.load(sys.stdin.buffer)
response=json.loads(${JSON.stringify(JSON.stringify(expected))})
response['data']['entities'][0]['label']=request['arguments']['task']
sys.stdout.write(json.dumps({'ok':True,'response':response},ensure_ascii=False))
`,'utf8');
    const result=await f.owners.agent(f.read,f.grant,'task_context',
      {kind:'component',entityId:'selected',task:label},'a'.repeat(64));
    assert.equal(Object.getPrototypeOf(result),null,'Strict owner JSON remains prototype-free.');
    assert.deepEqual(JSON.parse(JSON.stringify(result)),expected);
    assert.equal(result.data.entities[0].label,label);
  });

test('Queued Agent reads recheck the original pin and cannot revive after a detected change',async (t) => {
  const f = await fixture(t,'lmti.agent.integration.v1');
  const original = await readFile(f.integrationConfig), pinned = digest(original);
  let attempted = 0, spawned = 0;
  f.owners.pool.run = async (_binary,_args,input,options) => {
    attempted++;
    assert.equal(JSON.parse(input).integrationSha256,pinned);
    // Deterministic queue boundary: the fixed launch pin must survive a source
    // capability change while waiting, and guard must refuse before spawning.
    const altered = JSON.parse(original); altered.schema='lmti.agent.integration.v2'; altered.structure=true;
    await writeFile(f.integrationConfig,JSON.stringify(altered));
    await options.guard();
    spawned++;
    return {ok:true,response:f.response};
  };
  await assert.rejects(f.owners.agent(f.read,f.grant,'context',{},'a'.repeat(64)),{code:'CONFIG_CHANGED'});
  assert.equal(attempted,1); assert.equal(spawned,0);
  await writeFile(f.integrationConfig,original);
  await assert.rejects(f.owners.agent(f.read,f.grant,'context',{},'a'.repeat(64)),{code:'SCOPE_DENIED'});
  assert.equal(attempted,1);
});

test('Agent integration path rebinding cannot choose fresh source bytes or spawn a child',async (t) => {
  const f = await fixture(t,'lmti.agent.integration.v2');
  const replacement = join(f.root,'replacement.json');
  await writeFile(replacement,await readFile(f.integrationConfig));
  let calls = 0;
  f.owners.pool.run = async () => { calls++; throw new Error('Must not spawn'); };
  await assert.rejects(f.owners.agent(f.read,{...f.grant,integrationConfig:replacement},'context',{},'a'.repeat(64)),{code:'SCOPE_DENIED'});
  await assert.rejects(f.owners.agent(f.read,f.grant,'context',{},'a'.repeat(64)),{code:'SCOPE_DENIED'});
  assert.equal(calls,0);
});

test('Child pin failure latches a persistent source change before reporting its error',async (t) => {
  const f = await fixture(t,'lmti.agent.integration.v2');
  const original = await readFile(f.integrationConfig);
  let calls = 0;
  f.owners.pool.run = async (_binary,_args,_input,options) => {
    calls++;
    await options.guard();
    await writeFile(f.integrationConfig,Buffer.concat([original,Buffer.from(' ')]));
    // The real child rejects its expected pin before returning any data.
    return {ok:false,code:'OWNER_UNAVAILABLE'};
  };
  await assert.rejects(f.owners.agent(f.read,f.grant,'context',{},'a'.repeat(64)),{code:'CONFIG_CHANGED'});
  await writeFile(f.integrationConfig,original);
  await assert.rejects(f.owners.agent(f.read,f.grant,'context',{},'a'.repeat(64)),{code:'SCOPE_DENIED'});
  assert.equal(calls,1);
});

test('An unchanged integration preserves the original safe child error and rechecks session authority',async (t) => {
  const f = await fixture(t,'lmti.agent.integration.v2');
  const original = await readFile(f.integrationConfig), unavailable = new ApiError('OWNER_UNAVAILABLE');
  let calls = 0, checks = 0;
  f.owners.pool.run = async (_binary,_args,_input,options) => {
    calls++;
    await options.guard();
    throw unavailable;
  };
  await assert.rejects(f.owners.agent(f.read,f.grant,'context',{},'a'.repeat(64),() => { checks++; }),
    (error) => error === unavailable);
  assert.equal(calls,1); assert.equal(checks,3);
  assert.deepEqual(await readFile(f.integrationConfig),original);
  await f.owners.verifyIntegration(f.grant);
});
