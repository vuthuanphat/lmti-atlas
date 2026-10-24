// Test process only. Fault scheduling lives here, never in the shipped owner.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const [source, cwd, mode, countText = '1', prefix = 'worker'] = process.argv.slice(2);
const api = await import(pathToFileURL(source).href);
const count = Number(countText);
const input = index => ({ action: 'test.audit', recordId: `${prefix}-${index}`, sensitivity: 'public',
  role: 'developer', decision: 'allow', command: 'audit-test', reason: 'synthetic' });
const send = value => new Promise(resolve => process.send(value, resolve));
const hold = async phase => {
  await send({ kind: 'phase', phase });
  // An unresolved Promise alone does not keep Node alive. Retain the IPC channel
  // so the parent can verify a live lock holder and terminate this exact child.
  await new Promise(resolve => process.once('message', resolve));
};

process.once('message', async () => {
  try {
    if (mode === 'hold-lock') {
      const lock = new DatabaseSync(path.join(cwd, '.lmti', 'privacy', '.audit-lock.sqlite'));
      lock.exec('BEGIN IMMEDIATE');
      await hold('locked');
      lock.close();
    }
    if (mode === 'before-publish' || mode === 'after-publish' || mode === 'retention-before-publish') {
      const rename = fs.rename;
      fs.rename = async (from, to) => {
        if (path.basename(to) !== 'audit.jsonl') return rename(from, to);
        if (mode !== 'after-publish') await hold('before-publish');
        await rename(from, to);
        await hold('after-publish');
      };
    }
    if (mode === 'retain' || mode === 'retention-before-publish') {
      for (let index = 0; index < count; index++) await api.retainAuditEvents(cwd, 3);
    } else {
      for (let index = 0; index < count; index++) await api.appendAuditEvent(cwd, input(index));
    }
    await send({ kind: 'done', ok: true });
  } catch (error) {
    await send({ kind: 'done', ok: false, code: error instanceof Error ? error.message : 'UNEXPECTED' });
  } finally { process.disconnect(); }
});
await send({ kind: 'ready' });
