/** Build the narrow read owner using the already-installed Vite/esbuild toolchain. */
import { createRequire } from 'node:module';
import { mkdir, lstat, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const buildRoot = join(repo, 'build');
const raw = process.argv[2];
if (process.argv.length !== 3 || !raw || /[\x00-\x1f]/.test(raw) || raw.replaceAll('\\', '/').startsWith('//')) throw new Error('Invalid package output');
if (raw.replace(/^[A-Za-z]:[\\/]/,'').includes(':')) throw new Error('Alternate data streams refused');
const output = resolve(repo, raw);
const fromBuild = relative(buildRoot, output);
if (!fromBuild || fromBuild.startsWith('..') || isAbsolute(fromBuild)) throw new Error('Output must be inside build/');
for (let item = output; item !== dirname(item); item = dirname(item)) {
  try { if ((await lstat(item)).isSymbolicLink()) throw new Error('Linked output refused'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
// A fresh bundle directory avoids overwriting an earlier release artifact.
await mkdir(output);
const require = createRequire(await realpath(join(repo, 'apps/web-ui/node_modules/vite/package.json')));
const { build } = require('esbuild');
const result = await build({entryPoints:[join(repo,'scripts/agent-knowledge-owner.ts')],
  absWorkingDir:repo, bundle:true, platform:'node', target:'node24', format:'esm',
  outfile:join(output,'index.js'), write:false, metafile:true, sourcemap:false, minify:false,
  banner:{js:"import { createRequire as ownerCreateRequire } from 'node:module'; const require = ownerCreateRequire(import.meta.url);"},
  legalComments:'inline', logLevel:'warning'});
// Every runtime dependency must be a Node builtin; no workspace links survive.
for (const part of Object.values(result.metafile.outputs)) {
  if (part.imports.some(item => item.external && !item.path.startsWith('node:'))) throw new Error('Unbundled runtime dependency');
}
for (const file of result.outputFiles) {
  if (relative(output,file.path).includes(sep) || dirname(file.path) !== output) throw new Error('Unexpected bundle output');
  await writeFile(file.path,file.contents,{flag:'wx'});
}
await writeFile(join(output,'package.json'),JSON.stringify({private:true,type:'module',engines:{node:'>=24'}})+'\n',{flag:'wx'});
process.stdout.write(JSON.stringify({kind:'lmti-agent-knowledge-bundle',files:result.outputFiles.length+1})+'\n');
