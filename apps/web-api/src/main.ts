import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { createLocalApi } from './server.js';
import { record, strictJson } from './security.js';
import type { LaunchConfig } from './owners.js';
import { startApiLifecycle } from './lifecycle.js';
import {OperatorInputError,runOperatorSession,startupCode} from './operator-control.js';

function openBrowser(executable: string, url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Fixed OS URL opener. The private launch fragment is never printed/persisted.
    const child = spawn(executable, ['url.dll,FileProtocolHandler', url],
      {shell:false, windowsHide:true, stdio:'ignore'});
    child.once('error', () => reject(Object.assign(new Error('Browser could not open.'),{code:'BROWSER_UNAVAILABLE'})));
    child.once('spawn', resolve);
  });
}

// Launch configuration arrives over stdin, never from a browser/Agent request.
async function main() {
  const args=process.argv.slice(2);
  const operator=args.length===1&&args[0]==='--operator-control';
  if(args.length&&!operator)throw new OperatorInputError();
  const start=async(config:LaunchConfig)=>{
    if(config.openBrowser&&(process.platform!=='win32'||!process.env.SystemRoot))throw new Error();
    return createLocalApi(config);
  };
  if(operator){
    await runOperatorSession(process.stdin,{start,open:url=>openBrowser(join(process.env.SystemRoot!,'System32','rundll32.exe'),url),report:value=>process.stdout.write(JSON.stringify(value)+'\n')});
    return;
  }
  const chunks: Buffer[] = []; let size = 0;
  for await (const b of process.stdin) { size += b.length; if (size > 16384) throw new Error(); chunks.push(b); }
  const config = record(strictJson(Buffer.concat(chunks))) as unknown as LaunchConfig;
  // Validate platform prerequisites before acquiring the listening socket.
  if (config.openBrowser && (process.platform !== 'win32' || !process.env.SystemRoot)) throw new Error();
  const api = await start(config);
  await startApiLifecycle(api, async () => {
    if (config.openBrowser) {
      await openBrowser(join(process.env.SystemRoot!, 'System32', 'rundll32.exe'), api.issueLaunch());
    }
  });
  process.stdout.write(JSON.stringify({kind:'lmti-local-api',version:1,url:api.origin+'/',pid:process.pid})+'\n');
}
main().catch(error => { process.stderr.write(`LMTI_STARTUP ${startupCode(error)}. Check the trusted local launcher and workspace.\n`); process.exitCode = 1; });
