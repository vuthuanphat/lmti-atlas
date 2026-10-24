// Development-only synthetic fixture. Never packaged or used with an operator library.
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const repo = fileURLToPath(new URL('../', import.meta.url));
const root = await mkdtemp(join(repo, 'build/web02-browser-'));
const pkg = resolve(repo, 'build/studio-web-20261013');
const { createLocalApi } = await import(pathToFileURL(join(pkg, 'apps/web-api/dist/server.js')).href);
const python = process.env.LMTI_WEB_TEST_PYTHON;
if (!python) throw new Error('Set the trusted test Python executable.');
const config = {
  adminBinary: join(pkg, 'bin/lmti-mcp-admin.exe'), projectBinary: join(pkg, 'bin/lmti-project.exe'),
  library: join(root, 'project-library.sqlite'), profiles: join(root, 'mcp-profiles.sqlite'), python,
  agentEntry: join(pkg, 'share/lmti/scripts/lmti-agent-mcp.py'), configOwner: join(pkg, 'share/lmti/scripts/mcp-config-owner.py'),
  allowedProjects: ['factory-monitor', 'edge-gateway'], port: 0, openBrowser: false
};
const producer = spawnSync(resolve(repo, 'build/native-web01-20261013/bin/Release/lmti-mcp-profile-tests.exe'), [root], {
  encoding: 'utf8', windowsHide: true, env: { ...process.env, LMTI_PYTHON_BINARY: python, LMTI_AGENT_ENTRY: config.agentEntry, LMTI_PROJECT_BINARY: config.projectBinary }
});
if (producer.status !== 0) throw new Error('Synthetic producer failed.');
let offset = 0;
const api = await createLocalApi(config, () => Date.now() + offset);
// One-use, in-memory bridge only for the isolated CLI browser. Its scope contains
// synthetic files only. No capability is written to disk/CLI output/trace.
const bridge = createServer((req, res) => {
  const host = `127.0.0.1:${bridge.address().port}`;
  if (req.method !== 'GET' || req.url !== '/' || req.headers.host !== host || req.headers.origin) { res.writeHead(403); res.end(); return; }
  res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
  res.end(api.issueLaunch()); bridge.close();
});
await new Promise(resolve => bridge.listen(0, '127.0.0.1', resolve));
const info = { root, origin: api.origin, handoff: `http://127.0.0.1:${bridge.address().port}/`, pid: process.pid };
await writeFile(join(repo, 'build/web02-browser-info.json'), JSON.stringify(info, null, 2));
console.log(JSON.stringify(info));
// Controlled fixture clock, never an HTTP or production endpoint.
process.stdin.setEncoding('utf8');
process.stdin.on('data', line => { if (line.trim() === 'expire-previews') offset += 120001; if (line.trim() === 'expire-session') offset += 1200001; });
