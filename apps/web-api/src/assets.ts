import { readdir, readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { requireThat, trustedPath } from './security.js';

/** Only publisher-built assets enter the exact URL map. Never map request paths to disk. */
export async function loadAssets() {
  const root = fileURLToPath(new URL('../../web-ui/dist/', import.meta.url));
  await trustedPath(root, 'directory');
  const assets = new Map<string, { body: Buffer; type: string }>();
  let total = 0;
  async function add(url: string, file: string, type: string) {
    await trustedPath(file, 'file');
    const info = await stat(file); requireThat(info.size <= 2*1024*1024, 'LIMIT_EXCEEDED');
    const body = await readFile(file); total += body.length;
    requireThat(total <= 8*1024*1024 && assets.size < 64, 'LIMIT_EXCEEDED');
    // Image AI artwork is shipped by the publisher, never supplied by an API request.
    if (type === 'image/png') requireThat(body.length >= 24 && body.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && body.toString('ascii',12,16) === 'IHDR', 'OWNER_UNAVAILABLE');
    assets.set(url, { body, type: type === 'image/png' ? type : `${type}; charset=utf-8` });
  }
  await add('/', join(root, 'index.html'), 'text/html');
  const folder = join(root, 'assets'); await trustedPath(folder, 'directory');
  const files = await readdir(folder, { withFileTypes: true }); requireThat(files.length <= 63, 'LIMIT_EXCEEDED');
  for (const entry of files) {
    requireThat(entry.isFile() && /^[A-Za-z0-9_-]+\.(?:js|css|png)$/.test(entry.name), 'OWNER_UNAVAILABLE');
    await add(`/assets/${entry.name}`, join(folder, entry.name), entry.name.endsWith('.js') ? 'text/javascript' : entry.name.endsWith('.png') ? 'image/png' : 'text/css');
  }
  return assets;
}
