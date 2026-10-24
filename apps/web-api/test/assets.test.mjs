import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, rm, rmdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

// All inputs are publisher-bundle fixtures. Each import has its own web-ui/dist;
// these tests never replace the application's real dist directory.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6Z7sAAAAASUVORK5CYII=', 'base64');
const MiB = 1024 * 1024;

async function fixture(t) {
  const parent = resolve(tmpdir());
  const root = await mkdtemp(join(parent, 'lmti-assets-'));
  // Validate the precise cleanup target before allowing recursive removal.
  assert.equal(dirname(resolve(root)), parent);
  assert.ok(resolve(root).startsWith(join(parent, 'lmti-assets-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const api = join(root, 'apps', 'web-api', 'dist');
  const ui = join(root, 'apps', 'web-ui', 'dist');
  const assets = join(ui, 'assets');
  await mkdir(api, { recursive: true });
  await mkdir(assets, { recursive: true });
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  await copyFile(new URL('../dist/assets.js', import.meta.url), join(api, 'assets.js'));
  await copyFile(new URL('../dist/security.js', import.meta.url), join(api, 'security.js'));
  await writeFile(join(ui, 'index.html'), '<!doctype html><title>Fixture</title>');
  const { loadAssets } = await import(pathToFileURL(join(api, 'assets.js')).href);
  // Prove this fixture's trusted parent paths are accessible before negative tests.
  // A sandbox denial must not masquerade as successful bad-asset rejection.
  assert.equal((await loadAssets()).size, 1);
  return { root, ui, assets, loadAssets };
}

test('compiled asset loader accepts publisher PNG, JS and CSS with exact URLs and MIME types', async t => {
  const f = await fixture(t);
  await writeFile(join(f.assets, 'icon-a1.png'), png);
  await writeFile(join(f.assets, 'index-ab12.js'), 'export const fixture = true;');
  await writeFile(join(f.assets, 'index-ab12.css'), ':root { color-scheme: dark; }');
  const assets = await f.loadAssets();
  assert.deepEqual([...assets.keys()].sort(), ['/', '/assets/icon-a1.png', '/assets/index-ab12.css', '/assets/index-ab12.js']);
  assert.equal(assets.get('/').type, 'text/html; charset=utf-8');
  assert.equal(assets.get('/assets/index-ab12.js').type, 'text/javascript; charset=utf-8');
  assert.equal(assets.get('/assets/index-ab12.css').type, 'text/css; charset=utf-8');
  assert.equal(assets.get('/assets/icon-a1.png').type, 'image/png');
  assert.deepEqual(assets.get('/assets/icon-a1.png').body, png);
  assert.equal(assets.has('/assets/../index.html'), false);
  assert.equal(assets.has('/assets/missing.png'), false);
});

test('PNG admission rejects short content, wrong magic and a missing IHDR marker', async t => {
  const f = await fixture(t);
  const wrongMagic = Buffer.from(png); wrongMagic[0] = 0;
  const wrongHeader = Buffer.from(png); wrongHeader.write('IDAT', 12, 'ascii');
  for (const body of [png.subarray(0, 23), wrongMagic, wrongHeader]) {
    await writeFile(join(f.assets, 'invalid.png'), body);
    await assert.rejects(f.loadAssets(), { code: 'OWNER_UNAVAILABLE' });
  }
});

test('asset folder rejects disallowed extensions, invalid filenames and nested directories', async t => {
  const f = await fixture(t);
  for (const name of ['image.svg', 'source.js.map', 'image.PNG', 'has space.png']) {
    const file = join(f.assets, name);
    await writeFile(file, png);
    await assert.rejects(f.loadAssets(), { code: 'OWNER_UNAVAILABLE' });
    await rm(file);
  }
  const nested = join(f.assets, 'nested');
  await mkdir(nested);
  await assert.rejects(f.loadAssets(), { code: 'OWNER_UNAVAILABLE' });
});

test('asset loader enforces the per-file and cumulative publisher bundle size caps', async t => {
  const f = await fixture(t);
  const large = join(f.assets, 'large.js');
  await writeFile(large, Buffer.alloc(2 * MiB + 1, 32));
  await assert.rejects(f.loadAssets(), { code: 'LIMIT_EXCEEDED' });
  await rm(large);
  // Individual files are at the permitted cap; their sum plus index exceeds 8 MiB.
  for (let index = 0; index < 4; index++) {
    await writeFile(join(f.assets, 'part-' + index + '.js'), Buffer.alloc(2 * MiB, 32));
  }
  await assert.rejects(f.loadAssets(), { code: 'LIMIT_EXCEEDED' });
});

test('asset loader rejects more than 63 files beside the index', async t => {
  const f = await fixture(t);
  await Promise.all(Array.from({ length: 64 }, (_, index) => writeFile(join(f.assets, 'part-' + index + '.js'), '')));
  await assert.rejects(f.loadAssets(), { code: 'LIMIT_EXCEEDED' });
});

test('asset loader refuses a symlink even when its target is an otherwise valid PNG', async t => {
  const f = await fixture(t);
  const target = join(f.root, 'target.png');
  await writeFile(target, png);
  try {
    await symlink(target, join(f.assets, 'linked.png'), 'file');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.skip('This host does not grant file-symlink creation.');
      return;
    }
    throw error;
  }
  await assert.rejects(f.loadAssets(), { code: 'OWNER_UNAVAILABLE' });
});

test('asset loader rejects a redirected assets directory or Windows junction', async t => {
  const f = await fixture(t);
  const target = join(f.root, 'redirected-assets');
  await mkdir(target);
  await writeFile(join(target, 'icon.png'), png);
  await rmdir(f.assets); // Empty fixture directory only; never remove real build output.
  try {
    await symlink(target, f.assets, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.skip('This host does not grant directory-link creation.');
      return;
    }
    throw error;
  }
  await assert.rejects(f.loadAssets(), { code: 'OWNER_UNAVAILABLE' });
});
