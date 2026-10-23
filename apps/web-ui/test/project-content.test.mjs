import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import test from 'node:test';
const app=createRequire(join(fileURLToPath(new URL('../',import.meta.url)),'package.json'));
const {build}=createRequire(app.resolve('vite'))('esbuild');
const bundle=await build({entryPoints:[fileURLToPath(new URL('../src/ProjectContentPanel.tsx',import.meta.url))],bundle:true,write:false,format:'cjs',platform:'node',jsx:'automatic',external:['react','react/*']});
const module={exports:{}};new Function('require','module','exports',bundle.outputFiles[0].text)(app,module,module.exports);
const React=app('react'),{renderToStaticMarkup}=app('react-dom/server'),{ProjectContentPanel,blankContentRecord}=module.exports;
test('new records default to internal nonsecret declarations and canonical enum spelling',()=>{
  for(const category of ['project','repositories','components','targets','releases','bindings','dependencies','verification','milestones','work','knowledge','assets']){
    const row=blankContentRecord(category);assert.equal(row.id,'');assert.equal(row.privacy,'internal');
  }
  assert.equal(blankContentRecord('work').state,'todo');assert.equal(blankContentRecord('work').kind,'task');
  assert.equal(blankContentRecord('milestones').accepted,false);
  assert.equal(blankContentRecord('verification').result,'operator-declared');
  assert.equal(blankContentRecord('assets').enabled,false);assert.equal(blankContentRecord('assets').pollMs,1000);
  assert.equal(blankContentRecord('connections').protocol,'dependency');
});
for(const language of ['en','vi'])test(`content UI offers bounded categories and truthful non-device wording in ${language}`,()=>{
  const html=renderToStaticMarkup(React.createElement(ProjectContentPanel,{project:'demo',language,request(){throw Error('SSR performs no owner calls');},disabled:false,onLockChange(){},onChanged(){},onRecovery(){}}));
  assert.equal((html.match(/<option/g)||[]).length,13);
  assert.match(html,language==='en'?/do not deploy software or control devices/:/không triển khai phần mềm hay điều khiển thiết bị/);
  assert.doesNotMatch(html,/<script|lmti-desktop|Qt fallback/);
});
