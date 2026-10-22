import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { createLocalApi } from './server.js';
import { record, strictJson } from './security.js';
import type { LaunchConfig } from './owners.js';
import { startApiLifecycle } from './lifecycle.js';

function openBrowser(executable: string, url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Fixed OS URL opener. The private launch fragment is never printed/persisted.
    const child = spawn(executable, ['url.dll,FileProtocolHandler', url],
      {shell:false, windowsHide:true, stdio:'ignore'});
    child.once('error', reject);
    child.once('spawn', resolve);
  });
}

// Launch configuration arrives over stdin, never from a browser/Agent request.
async function main() {
  const chunks: Buffer[] = []; let size = 0;
  for await (const b of process.stdin) { size += b.length; if (size > 16384) throw new Error(); chunks.push(b); }
  const config = record(strictJson(Buffer.concat(chunks))) as unknown as LaunchConfig;
  // Validate platform prerequisites before acquiring the listening socket.
  if (config.openBrowser && (process.platform !== 'win32' || !process.env.SystemRoot)) throw new Error();
  const api = await createLocalApi(config);
  await startApiLifecycle(api, async () => {
    if (config.openBrowser) {
      await openBrowser(join(process.env.SystemRoot!, 'System32', 'rundll32.exe'), api.issueLaunch());
    }
    process.stdout.write(JSON.stringify({kind:'lmti-local-api',version:1,url:api.origin+'/',pid:process.pid})+'\n');
  });
}
main().catch(() => { process.stderr.write('Local API could not start. Check trusted launcher locations and port.\n'); process.exitCode = 1; });
