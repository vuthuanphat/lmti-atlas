import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import test from 'node:test';
const app=createRequire(join(fileURLToPath(new URL('../',import.meta.url)),'package.json'));
const {build}=createRequire(app.resolve('vite'))('esbuild');
const bundle=await build({entryPoints:[fileURLToPath(new URL('../src/ProjectOnboarding.tsx',import.meta.url))],bundle:true,write:false,format:'cjs',platform:'node',jsx:'automatic',external:['react','react/*']});
const module={exports:{}};new Function('require','module','exports',bundle.outputFiles[0].text)(app,module,module.exports);
const React=app('react'),{renderToStaticMarkup}=app('react-dom/server'),{ProjectOnboarding}=module.exports;
for(const language of ['en','vi']){
  test(`empty library gives actionable CLI setup and grant refresh in ${language}`,()=>{
    const html=renderToStaticMarkup(React.createElement(ProjectOnboarding,{language,loaded:true,disabled:false,onRefresh(){}}));
    assert.match(html,/init-project/);assert.match(html,/library-register/);
    assert.doesNotMatch(html,/Qt|fallback|lmti-desktop/);
    assert.match(html,language==='en'?/No projects in this session/:/Phiên này chưa có dự án/);
    assert.match(html,language==='en'?/only the scope granted/:/phạm vi được cấp/);
    assert.match(html,language==='en'?/Restart the local launcher/:/Khởi động lại launcher/);
  });
  test(`failed read never claims the existing library is empty in ${language}`,()=>{
    const html=renderToStaticMarkup(React.createElement(ProjectOnboarding,{language,loaded:false,disabled:true,onRefresh(){}}));
    assert.doesNotMatch(html,/init-project|library-register|Qt/);assert.match(html,/disabled/);
    assert.match(html,language==='en'?/Existing data has not been replaced/:/Dữ liệu hiện có không bị thay thế/);
  });
}
