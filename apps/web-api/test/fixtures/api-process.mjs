// Test-only standalone API host for process-loss trials. Never packaged.
// Private bootstrap is returned only on the parent process pipe, never a log/file.
import { join, dirname, resolve, basename, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createLocalApi } from '../../dist/server.js';
const repo=fileURLToPath(new URL('../../../../',import.meta.url));
try {
  let input='';for await(const b of process.stdin){input+=b;if(input.length>16384)throw new Error();}
  const cfg=JSON.parse(input),root=resolve(dirname(cfg.library));
  const benchmark=/^web03-bench-[A-Za-z0-9_-]+$/.test(basename(root));
  if(!root.startsWith(resolve(repo,'build')+sep) || (!benchmark && !/^web01-test-[A-Za-z0-9_-]+$/.test(basename(root))) ||
    cfg.library!==join(root,'project-library.sqlite') || cfg.profiles!==join(root,'mcp-profiles.sqlite') || cfg.openBrowser!==false) throw new Error();
  const create=benchmark?(await import(pathToFileURL(join(dirname(dirname(cfg.adminBinary)),'apps/web-api/dist/server.js')))).createLocalApi:createLocalApi;
  const api=await create(cfg);
  const nonce=new URL(api.issueLaunch()).hash.slice('#bootstrap='.length);
  process.stdout.write(JSON.stringify({origin:api.origin,nonce})+'\n');
  if(benchmark) process.on('message',async message=>{
    if(message?.kind==='memory')process.send?.({kind:'memory',usage:process.memoryUsage()});
    if(message?.kind==='close'){await api.close();process.disconnect();}
  });
  setTimeout(()=>{void api.close();if(benchmark&&process.connected)process.disconnect();},benchmark?600000:60000).unref();
} catch {process.stderr.write('Synthetic API process rejected.\n');process.exitCode=1;}
