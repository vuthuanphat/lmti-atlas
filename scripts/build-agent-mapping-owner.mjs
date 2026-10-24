/** Build only the fixed accepted-mapping reader with the installed Vite/esbuild. */
import { createRequire } from 'node:module';
import { mkdir, lstat, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const buildRoot = join(repo, 'build');
const raw = process.argv[2];
if (process.argv.length !== 3 || !raw || /[\x00-\x1f]/.test(raw) || raw.replaceAll('\\', '/').startsWith('//')) throw new Error('Invalid package output');
if (raw.replace(/^[A-Za-z]:[\\/]/, '').includes(':')) throw new Error('Alternate data streams refused');
const output = resolve(repo, raw);
const fromBuild = relative(buildRoot, output);
if (!fromBuild || fromBuild.startsWith('..') || isAbsolute(fromBuild)) throw new Error('Output must be inside build/');
// Validate existing ancestors top-down before touching their children.
const ancestors = [];
for (let item = output; ; item = dirname(item)) {
  ancestors.unshift(item);
  if (item === dirname(item)) break;
}
for (const item of ancestors) {
  try {
    const info = await lstat(item);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Linked or non-directory output refused');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
// No overwrite of an existing bundle, including an earlier failed attempt.
await mkdir(output);
const require = createRequire(await realpath(join(repo, 'apps/web-ui/node_modules/vite/package.json')));
const { build } = require('esbuild');
const result = await build({entryPoints:[join(repo, 'scripts/agent-mapping-owner.ts')],
  absWorkingDir:repo, bundle:true, platform:'node', target:'node24', format:'esm',
  outfile:join(output, 'index.js'), write:false, metafile:true, sourcemap:false, minify:false,
  banner:{js:"import { createRequire as ownerCreateRequire } from 'node:module'; const require = ownerCreateRequire(import.meta.url);"},
  legalComments:'inline', logLevel:'warning'});
for (const part of Object.values(result.metafile.outputs)) {
  if (part.imports.some(item => item.external && !item.path.startsWith('node:'))) throw new Error('Unbundled runtime dependency');
}
for (const file of result.outputFiles) {
  if (relative(output, file.path).includes(sep) || dirname(file.path) !== output) throw new Error('Unexpected bundle output');
  await writeFile(file.path, file.contents, {flag:'wx'});
}
await writeFile(join(output, 'package.json'), JSON.stringify({private:true, type:'module', engines:{node:'>=24'}}) + '\n', {flag:'wx'});
process.stdout.write(JSON.stringify({kind:'lmti-agent-mapping-bundle', files:result.outputFiles.length + 1}) + '\n');
