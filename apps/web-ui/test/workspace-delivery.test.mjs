import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const uiRoot=process.env.LMTI_OPERATIONS_TEST_UI_ROOT??fileURLToPath(new URL('../',import.meta.url));
const app=createRequire(join(uiRoot,'package.json'));
const {build}=createRequire(app.resolve('vite'))('esbuild');

test('initial HTML keeps bilingual recovery guidance visible before the main module is available',async()=>{
  const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
  const fallback=/<div id="root">([\s\S]*?)<\/div>/.exec(html)?.[1];
  assert.ok(fallback,'The initial root must not be empty');
  assert.match(fallback,/<main[^>]*role="status"/);
  assert.match(fallback,/lang="en"/);assert.match(fallback,/lang="vi"/);
  assert.match(fallback,/Open-LMTI\.cmd/);
  assert.match(fallback,/press O there to open a fresh private session/);
  assert.match(fallback,/nhấn O tại đó để mở phiên riêng tư mới/);
  assert.match(fallback,/Do not repeat an interrupted write/);
  assert.match(fallback,/Không gửi lại thao tác ghi bị gián đoạn/);
  assert.match(html,/<noscript>[\s\S]*JavaScript is required[\s\S]*Workspace cục bộ cần JavaScript/);
  assert.doesNotMatch(html,/http-equiv\s*=\s*["']refresh|location\.(?:reload|replace)|bootstrap=/i);
});

test('core Work and recovery code ships in the initial app without a later dynamic module fetch',async()=>{
  // Regression for entering Work while the operator shuts down the server:
  // lazy chunk rejection previously escaped Suspense and blanked the React root.
  // Bundle the real application graph with splitting enabled, in memory only.
  const source=fileURLToPath(new URL('../src/App.tsx',import.meta.url));
  const result=await build({entryPoints:[source],bundle:true,write:false,metafile:true,
    format:'esm',platform:'browser',splitting:true,jsx:'automatic',
    outdir:join(uiRoot,'build-not-written'),loader:{'.css':'empty','.png':'dataurl'}});
  const portable=path=>'/'+path.replaceAll('\\','/');
  const outputs=Object.values(result.metafile.outputs),entry=outputs.find(output=>output.entryPoint&&portable(output.entryPoint).endsWith('/src/App.tsx'));
  assert.ok(entry,'The app entry must exist in the delivery graph');
  for(const panel of ['LibraryManagementPanel.tsx','ProjectContentPanel.tsx','ProjectOperationsPanel.tsx','SessionGuidance.tsx']){
    const module=Object.entries(entry.inputs).find(([path])=>portable(path).endsWith(`/src/${panel}`));
    assert.ok(module,`${panel} must be in the initial application bundle`);
    assert.ok(module[1].bytesInOutput>0,`${panel} cannot be erased from the bundle`);
  }
  for(const output of outputs)assert.deepEqual(output.imports.filter(reference=>reference.kind==='dynamic-import'),[],
    'Core navigation must not depend on a server asset fetch after startup');
  assert.equal(outputs.filter(output=>output.entryPoint).length,1,'No separate lazy entry may be emitted');
});
