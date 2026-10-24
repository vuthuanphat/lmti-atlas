import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';

const uiRoot=process.env.LMTI_OPERATIONS_TEST_UI_ROOT??fileURLToPath(new URL('../',import.meta.url));
const app=createRequire(join(uiRoot,'package.json'));
const {build}=createRequire(app.resolve('vite'))('esbuild');
const bundle=await build({entryPoints:[fileURLToPath(new URL('../src/SessionGuidance.tsx',import.meta.url))],
  bundle:true,write:false,format:'cjs',platform:'node',jsx:'automatic',external:['react','react/*']});
const module={exports:{}};
new Function('require','module','exports',bundle.outputFiles[0].text)(app,module,module.exports);
const {SessionGuidance,ServiceConnectionBanner}=module.exports;
const React=app('react'),{renderToStaticMarkup}=app('react-dom/server');

test('EN/VI stopped-session guidance separates network, expiry, authentication and explicit ending',()=>{
  const titles={
    en:{startup_network:'Local service could not be reached',startup_refused:'Private session could not start',expired:'Private session expired',unauthenticated:'A fresh private session is required',signed_out:'Private session ended'},
    vi:{startup_network:'Không kết nối được dịch vụ cục bộ',startup_refused:'Chưa khởi tạo được phiên riêng tư',expired:'Phiên riêng tư đã hết hạn',unauthenticated:'Cần mở phiên riêng tư mới',signed_out:'Phiên riêng tư đã kết thúc'},
  };
  for(const language of ['en','vi'])for(const [reason,title] of Object.entries(titles[language])){
    const html=renderToStaticMarkup(React.createElement(SessionGuidance,{language,reason}));
    assert.ok(html.includes(`<h1 id="session-guidance-title">${title}</h1>`));
    assert.ok(html.includes('Open-LMTI.cmd'));
    assert.ok(html.includes(language==='vi'?'nhấn O':'press O'));
    assert.ok(html.includes(language==='vi'?'Không gửi lại thao tác đã nộp.':'Do not repeat the submitted operation.'));
    assert.doesNotMatch(html,/<button|<a |bootstrap=|http:\/\//);
    if(reason==='startup_network')assert.ok(html.includes(language==='vi'?'không có nghĩa dữ liệu dự án đã mất':'does not mean your project data was lost'));
  }
});

test('connection banner has one explicit read-check action and never relaunches or retries on render',()=>{
  for(const language of ['en','vi'])for(const checking of [false,true]){
    let checked=0;
    const element=ServiceConnectionBanner({language,checking,onCheck:()=>{checked++;}});
    const html=renderToStaticMarkup(element);
    assert.equal(checked,0);
    assert.equal((html.match(/<button/g)??[]).length,1);
    assert.equal(html.includes('disabled=""'),checking);
    assert.ok(html.includes(language==='vi'?'Không gửi lại thao tác ghi hoặc xóa yêu cầu phục hồi.':'It does not repeat a write or clear a recovery requirement.'));
    const button=React.Children.toArray(element.props.children).find(child=>React.isValidElement(child)&&child.type==='button');
    assert.ok(button);button.props.onClick();assert.equal(checked,1);
    assert.doesNotMatch(html,/<a |bootstrap=|session\/bootstrap/);
  }
});
