import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, dirname, parse, resolve } from 'node:path';

export const codes = ['UNAUTHENTICATED','SESSION_EXPIRED','ORIGIN_REJECTED','SCOPE_DENIED','INVALID_INPUT','REVISION_CONFLICT','PREVIEW_EXPIRED','CONFIG_CHANGED','RECOVERY_REQUIRED','UNMANAGED_COLLISION','OWNED_CONFIG_DRIFT','NOT_SUPPORTED','OWNER_UNAVAILABLE','LIMIT_EXCEEDED','BUSY'] as const;
export type Code = typeof codes[number];
const messages: Record<Code,string> = {
  UNAUTHENTICATED:'Open LMTI through its local launcher.', SESSION_EXPIRED:'This session expired. Launch LMTI again.',
  ORIGIN_REJECTED:'This request origin is not allowed.', SCOPE_DENIED:'Project or operation is unavailable.',
  INVALID_INPUT:'The request contains unsupported or invalid fields.', REVISION_CONFLICT:'The profile changed. Reload before saving.',
  PREVIEW_EXPIRED:'Create a fresh preview before applying.', CONFIG_CHANGED:'Configuration changed after preview. Inspect current state before a fresh review.',
  RECOVERY_REQUIRED:'Inspect the interrupted operation and its recovery state before another write.', UNMANAGED_COLLISION:'An unmanaged server uses this key. Choose another key.',
  OWNED_CONFIG_DRIFT:'A managed configuration was edited elsewhere. Review it first.', NOT_SUPPORTED:'This operation is not supported here.',
  OWNER_UNAVAILABLE:'The owner operation is unavailable. Inspect status or recovery before retrying a write.',
  LIMIT_EXCEEDED:'The request exceeds local limits.', BUSY:'A local operation is in progress. Try again later.'
};
export class ApiError extends Error {
  constructor(public code: Code) { super(messages[code]); }
}
export const requireThat: (condition: unknown, code?: Code) => asserts condition = (condition, code = 'INVALID_INPUT') => {
  if (!condition) throw new ApiError(code);
};
export const opaque = () => randomBytes(32).toString('base64url');
export const hash = (v: string) => createHash('sha256').update(v).digest('hex');
export function secureEqual(a: string, b: string) {
  return a.length === b.length && timingSafeEqual(Buffer.from(a),Buffer.from(b));
}
export function record(v: unknown): Record<string,unknown> {
  requireThat(v !== null && typeof v === 'object' && !Array.isArray(v)); return v as Record<string,unknown>;
}
export function exact(v: unknown, names: string[]) {
  const o = record(v); requireThat(Object.keys(o).length === names.length && names.every((n) => Object.hasOwn(o,n))); return o;
}
export function safeRevision(v: unknown): number {
  requireThat(typeof v === 'number' && Number.isSafeInteger(v) && v >= 0); return v;
}
// JSON.parse alone silently accepts duplicate keys. Decode before owner calls.
export function strictJson(bytes: Uint8Array, rejectReserved = true, maxArrayLength: 2000|4000|16000 = 2000): unknown {
  requireThat(maxArrayLength === 2000 || maxArrayLength === 4000 || maxArrayLength === 16000);
  let source: string;
  try { source = new TextDecoder('utf-8',{fatal:true}).decode(bytes); } catch { throw new ApiError('INVALID_INPUT'); }
  let i = 0;
  const ws = () => { while (/[\t\r\n ]/.test(source[i] ?? '\0')) i++; };
  const string = (): string => {
    const start = i++; let escaped = false;
    while (i < source.length) {
      const c = source[i++];
      if (!escaped && c === '"') { try { return JSON.parse(source.slice(start,i)); } catch { throw new ApiError('INVALID_INPUT'); } }
      if (!escaped && c === '\\') escaped = true; else escaped = false;
    }
    throw new ApiError('INVALID_INPUT');
  };
  const value = (depth: number): unknown => {
    requireThat(depth <= 24); ws(); const c = source[i];
    if (c === '"') return string();
    if (c === '{') {
      i++; ws(); const o: Record<string,unknown> = Object.create(null);
      if (source[i] === '}') { i++; return o; }
      while (true) {
        ws(); requireThat(source[i] === '"'); const key = string();
        requireThat(!Object.hasOwn(o,key) && (!rejectReserved || !['__proto__','prototype','constructor'].includes(key)));
        ws(); requireThat(source[i++] === ':'); o[key] = value(depth+1); ws();
        if (source[i] === '}') { i++; return o; }
        requireThat(source[i++] === ',');
      }
    }
    if (c === '[') {
      i++; ws(); const a: unknown[] = []; if (source[i] === ']') { i++; return a; }
      while (true) { a.push(value(depth+1)); requireThat(a.length <= maxArrayLength); ws(); if (source[i] === ']') { i++; return a; } requireThat(source[i++] === ','); }
    }
    const match = /^(true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(source.slice(i));
    requireThat(match); i += match[0].length; const v = JSON.parse(match[0]); requireThat(typeof v !== 'number' || Number.isFinite(v)); return v;
  };
  const result = value(0); ws(); requireThat(i === source.length); return result;
}
export async function trustedPath(location: string, kind: 'file' | 'directory', optional = false) {
  requireThat(typeof location === 'string' && isAbsolute(location) && location.length <= 1024 && !/[\x00-\x1f]/.test(location) && !location.replaceAll('\\','/').startsWith('//'),'OWNER_UNAVAILABLE');
  location = resolve(location);
  let exists = true;
  for (let p = location;;p = dirname(p)) {
    try {
      const info = await lstat(p); requireThat(!info.isSymbolicLink(),'OWNER_UNAVAILABLE');
      const resolved = await realpath(p); requireThat(resolved.toLowerCase() === p.replace(/[\\/]+$/,'').toLowerCase() || p === parse(p).root,'OWNER_UNAVAILABLE');
      if (p === location) requireThat(kind === 'file' ? info.isFile() : info.isDirectory(),'OWNER_UNAVAILABLE');
    } catch (e) {
      if (e instanceof ApiError) throw e;
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT' || p !== location || !optional) throw new ApiError('OWNER_UNAVAILABLE');
      exists = false;
    }
    if (dirname(p) === p) break;
  }
  return exists;
}
