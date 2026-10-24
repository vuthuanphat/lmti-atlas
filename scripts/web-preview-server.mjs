// Static WEB-00 study, not the WEB-01 administration API.
// Only allowlisted synthetic assets are read; no project/config/storage access.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../docs/design/2026-10-13-web-mcp/', import.meta.url);
const assets = new Map();
for (const [route,file,type] of [
  ['/','index.html','text/html; charset=utf-8'],
  ['/index.html','index.html','text/html; charset=utf-8'],
  ['/prototype.css','prototype.css','text/css; charset=utf-8'],
  ['/prototype.js','prototype.js','text/javascript; charset=utf-8']
]) assets.set(route,{body:await readFile(new URL(file,root)),type});
assets.set('/preview-info',{body:Buffer.from(JSON.stringify({kind:'lmti-web00-preview',version:1,synthetic:true})),type:'application/json; charset=utf-8'});

const port = Number(process.argv[2] ?? 8781);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid preview port.');
const server = createServer({maxHeaderSize:8192},(req,res) => {
  const origin = `http://127.0.0.1:${server.address().port}`;
  res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Cache-Control','no-store');
  res.setHeader('Cross-Origin-Resource-Policy','same-origin');
  res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
  if (req.headers.host !== `127.0.0.1:${server.address().port}` ||
      (req.headers.origin && req.headers.origin !== origin) ||
      req.headers['sec-fetch-site'] === 'cross-site') {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  if (!['GET','HEAD'].includes(req.method)) { res.setHeader('Allow','GET, HEAD'); res.writeHead(405); res.end('Method not allowed'); return; }
  // Exact lookup; queries, traversal, percent escapes and arbitrary files fail closed.
  const asset = assets.get(req.url);
  if (!asset) { res.writeHead(404); res.end('Not found'); return; }
  res.setHeader('Content-Type',asset.type); res.setHeader('Content-Length',asset.body.length);
  res.writeHead(200); res.end(req.method === 'HEAD' ? undefined : asset.body);
});
server.requestTimeout = 5000; server.headersTimeout = 5000; server.keepAliveTimeout = 2000;
server.maxConnections = 16;
server.on('clientError',(_error,socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'));
server.on('error',() => { process.stderr.write('Preview listener unavailable; existing services were not changed.\n'); process.exitCode = 1; });
server.listen(port,'127.0.0.1',() => {
  process.stdout.write(JSON.stringify({kind:'lmti-web00-preview',url:`http://127.0.0.1:${server.address().port}/`,pid:process.pid,source:fileURLToPath(root)}) + '\n');
});
