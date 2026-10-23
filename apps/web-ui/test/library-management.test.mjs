import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import test from 'node:test';
const app=createRequire(join(fileURLToPath(new URL('../',import.meta.url)),'package.json'));
const {build}=createRequire(app.resolve('vite'))('esbuild');
const bundle=await build({entryPoints:[fileURLToPath(new URL('../src/LibraryManagementPanel.tsx',import.meta.url))],bundle:true,write:false,format:'cjs',platform:'node',jsx:'automatic',external:['react','react/*']});
const module={exports:{}};new Function('require','module','exports',bundle.outputFiles[0].text)(app,module,module.exports);
const React=app('react'),{renderToStaticMarkup}=app('react-dom/server'),{LibraryManagementPanel,libraryProjectIdPattern}=module.exports;
test('HTML project identifier pattern compiles with Unicode sets and rejects path and control inputs',()=>{
  const pattern=new RegExp(`^(?:${libraryProjectIdPattern})$`,'v');
  for(const id of ['project','project-1','App.API_v2'])assert.equal(pattern.test(id),true,id);
  for(const id of ['../outside','project/path','C:\\file','project:stream','1invalid','project\nnext','<script>'])assert.equal(pattern.test(id),false,id);
});
for(const language of ['en','vi'])test(`library UI describes source preservation without exposing local paths in ${language}`,()=>{
  const html=renderToStaticMarkup(React.createElement(LibraryManagementPanel,{language,request(){throw Error('No SSR owner call');},disabled:false,visible:true,onLockChange(){},onChanged(){}}));
  assert.match(html,language==='en'?/Source files are preserved/:/File nguồn được giữ nguyên/);
  assert.doesNotMatch(html,/C:\\|\.sqlite|Qt|lmti-desktop/);
});
