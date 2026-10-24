import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  MappingError, canonicalMappingJson, type MappingCode, type MappingSourceAuthority,
  type MappingReadObservationContext
} from "@atlas/impact";

export function fail(code: MappingCode = "INVALID_INPUT"): never { throw new MappingError(code); }
export function requireValue(value: unknown, code: MappingCode = "INVALID_INPUT"): asserts value {
  if (!value) fail(code);
}
export function copyData<T>(value: T, cap: number): T {
  const encoded = canonicalMappingJson(value);
  requireValue(Buffer.byteLength(encoded) <= cap, "BUDGET_EXCEEDED");
  return JSON.parse(encoded) as T;
}
export function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
}
export function object(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  requireValue(value !== null && typeof value === "object" && !Array.isArray(value));
  const o = value as Record<string, unknown>;
  requireValue(required.every(k => Object.hasOwn(o, k)) &&
    Object.keys(o).every(k => required.includes(k) || optional.includes(k)));
  return o;
}
export function scalar(s: string): void {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(++i);
      requireValue(next >= 0xdc00 && next <= 0xdfff);
    } else requireValue(c < 0xdc00 || c > 0xdfff);
  }
}
export function text(value: unknown, max: number): string {
  requireValue(typeof value === "string" && value.length > 0 && value.trim().length > 0 &&
    Buffer.byteLength(value) <= max && !/[\x00-\x1f\x7f]/u.test(value));
  scalar(value); return value;
}
export function legacyText(value: unknown, max: number): string {
  const s = text(value, max * 4); requireValue(s.length <= max); return s;
}
export function hash(value: unknown): string {
  const s = text(value, 64); requireValue(s.length === 64 && /^[a-f0-9]{64}$/u.test(s)); return s;
}
export function uuid(value: unknown): string {
  const s = text(value, 36);
  requireValue(s.length === 36 && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(s) &&
    s !== "00000000-0000-0000-0000-000000000000");
  return s;
}
export function id(value: unknown, native = false): string {
  const s = text(value, native ? 64 : 100);
  requireValue((native ? /^[A-Za-z][A-Za-z0-9._-]*$/u : /^[A-Za-z][A-Za-z0-9._:-]*$/u).test(s));
  requireValue(!/\b(?:(?:sk-(?:proj-|ant-)?|gh[pousr]_)[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})/iu.test(s));
  return s;
}
export function timestamp(value: unknown): string {
  const s = text(value, 40);
  requireValue(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(s) &&
    Number.isFinite(Date.parse(s)) &&
    new Date(s).toISOString().replace(".000Z", "Z") === s.replace(".000Z", "Z"));
  return s;
}
export function authority(value: unknown): MappingSourceAuthority {
  const o = object(value, ["sourceId", "projectId", "siteId", "environmentId", "kind",
    "minimumClassification", "sourceAuthorityFingerprint", "nativeProjectId", "nativeStoreUuid",
    "nativeAuthorityFingerprint", "policyVersion"]);
  requireValue(o.kind === "manifest" || o.kind === "code" || o.kind === "native");
  requireValue(o.minimumClassification === "public" || o.minimumClassification === "internal");
  const result: MappingSourceAuthority = {
    sourceId: id(o.sourceId), projectId: id(o.projectId, true), siteId: id(o.siteId, true),
    environmentId: id(o.environmentId, true), kind: o.kind,
    minimumClassification: o.minimumClassification, sourceAuthorityFingerprint: hash(o.sourceAuthorityFingerprint),
    nativeProjectId: id(o.nativeProjectId, true), nativeStoreUuid: uuid(o.nativeStoreUuid),
    nativeAuthorityFingerprint: hash(o.nativeAuthorityFingerprint), policyVersion: legacyText(o.policyVersion, 160)
  };
  requireValue(result.projectId === result.nativeProjectId, "SCOPE_DENIED");
  return result;
}
export function context(value: MappingReadObservationContext): void {
  // Signals are control objects, and deliberately do not pass through the data copier.
  requireValue(value !== null && typeof value === "object" &&
    Object.keys(value).every(k => k === "signal" || k === "timeoutMilliseconds") &&
    value.timeoutMilliseconds === 40000 && value.signal instanceof AbortSignal);
}
export function tagged(domain: string, value: unknown): string {
  return createHash("sha256").update(domain + "\n" + canonicalMappingJson(value), "utf8").digest("hex");
}

/** New byte boundary only. Decode strings before checking duplicate keys, including
 * escaped spellings; reject invalid UTF-8, BOMs and lone UTF-16 surrogates. */
export function strictJson(bytes: Buffer, maximum: number, framed = false): unknown {
  requireValue(bytes.length <= maximum, "BUDGET_EXCEEDED");
  requireValue(bytes.length > 0 && !(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf));
  if (framed) requireValue(bytes[0] === 0x7b && bytes.at(-1) === 10 && bytes.at(-2) === 0x7d);
  let input: string;
  try { input = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(framed ? bytes.subarray(0, -1) : bytes); }
  catch { fail(); }
  let pos = 0, nodes = 0;
  const space = () => { while (pos < input.length && /[ \t\r\n]/u.test(input[pos])) pos++; };
  function string(): string {
    const start = pos++; let escaped = false;
    while (pos < input.length) {
      const c = input[pos++];
      if (!escaped && c === '"') {
        let decoded: unknown;
        try { decoded = JSON.parse(input.slice(start, pos)); } catch { fail(); }
        requireValue(typeof decoded === "string"); scalar(decoded); return decoded;
      }
      if (!escaped && c === "\\") escaped = true; else escaped = false;
    }
    fail();
  }
  function value(depth: number): unknown {
    requireValue(depth <= 32 && ++nodes <= 1_000_000, "BUDGET_EXCEEDED"); space();
    const c = input[pos];
    if (c === '"') return string();
    if (c === "{") {
      pos++; space(); const out: Record<string, unknown> = Object.create(null), seen = new Set<string>();
      if (input[pos] === "}") { pos++; return out; }
      for (;;) {
        requireValue(input[pos] === '"'); const key = string();
        requireValue(!seen.has(key)); seen.add(key); space(); requireValue(input[pos++] === ":");
        out[key] = value(depth + 1); space();
        const end = input[pos++]; if (end === "}") return out;
        requireValue(end === ","); space();
      }
    }
    if (c === "[") {
      pos++; space(); const out: unknown[] = [];
      if (input[pos] === "]") { pos++; return out; }
      for (;;) {
        out.push(value(depth + 1)); requireValue(out.length <= 100_000, "BUDGET_EXCEEDED"); space();
        const end = input[pos++]; if (end === "]") return out;
        requireValue(end === ",");
      }
    }
    for (const [word, result] of [["true", true], ["false", false], ["null", null]] as const) {
      if (input.startsWith(word, pos)) { pos += word.length; return result; }
    }
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(input.slice(pos));
    requireValue(match); pos += match[0].length;
    const number = Number(match[0]); requireValue(Number.isFinite(number)); return number;
  }
  const result = value(0); space(); requireValue(pos === input.length); return result;
}

const forbidden = new Set([".git", ".lmti", ".ssh", ".aws"]);
function component(s: string): boolean {
  return s.length > 0 && s !== "." && s !== ".." && !forbidden.has(s.toLowerCase()) &&
    !/[<>:"|?*\x00-\x1f\x7f]/u.test(s) && !/[. ]$/u.test(s) &&
    !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(s);
}
export function absolute(value: unknown): string {
  const s = text(value, 4096);
  requireValue(path.isAbsolute(s) && !s.startsWith("\\\\") && !s.startsWith("//"));
  const root = path.parse(s).root;
  requireValue(root.length > 0 && s.slice(root.length).split(/[\\/]/u).every(component));
  if (process.platform === "win32") requireValue(/^[A-Za-z]:[\\/]/u.test(s));
  return s; // Hash and open this checked spelling, never a case-folded identity key.
}
export function relative(value: unknown): string {
  const s = text(value, 512);
  requireValue(!path.isAbsolute(s) && s.split(/[\\/]/u).every(component));
  return s;
}
const pathKey = (s: string) => process.platform === "win32" ? path.resolve(s).toLowerCase() : path.resolve(s);
function identity(s: { dev: bigint; ino: bigint; birthtimeNs: bigint }): string {
  return `${s.dev}/${s.ino}/${s.birthtimeNs}`;
}
export interface FileRead { readonly bytes: Buffer; readonly identity: string; }
/** Check every ancestor top-down before realpath/open. These Node checks detect
 * replacement around a read; they are not a retained Windows namespace lease. */
export async function ordinary(filename: string, directory: boolean, check: () => void): Promise<string> {
  check(); absolute(filename);
  const parsed = path.parse(filename), parts = filename.slice(parsed.root.length).split(/[\\/]/u);
  let current = parsed.root;
  for (let i = -1; i < parts.length; i++) {
    if (i >= 0) current = path.join(current, parts[i]);
    check(); const stat = await fs.lstat(current, { bigint: true }); check();
    requireValue(!stat.isSymbolicLink() &&
      (i < parts.length - 1 || directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1n), "SOURCE_UNAVAILABLE");
  }
  check(); const real = await fs.realpath(filename); check();
  requireValue(pathKey(real) === pathKey(filename), "SOURCE_UNAVAILABLE");
  return filename;
}
export async function readFile(filename: string, cap: number, check: () => void): Promise<FileRead> {
  await ordinary(filename, false, check);
  check(); const original = await fs.lstat(filename, { bigint: true }); check();
  const handle = await fs.open(filename, "r");
  try {
    check();
    const before = await handle.stat({ bigint: true }); check();
    requireValue(before.isFile() && before.nlink === 1n && identity(before) === identity(original), "SOURCE_CHANGED");
    requireValue(before.size <= BigInt(cap), "BUDGET_EXCEEDED");
    const bytes = Buffer.alloc(Number(before.size) + 1); let length = 0;
    while (length < bytes.length) {
      check(); const part = await handle.read(bytes, length, bytes.length - length, length); check();
      if (!part.bytesRead) break; length += part.bytesRead;
    }
    const after = await handle.stat({ bigint: true }); check();
    const current = await fs.lstat(filename, { bigint: true }); check();
    requireValue(length <= cap, "BUDGET_EXCEEDED");
    requireValue(!current.isSymbolicLink() && current.nlink === 1n && identity(before) === identity(after) &&
      identity(before) === identity(current) && before.size === after.size && after.size === BigInt(length) &&
      before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs, "SOURCE_CHANGED");
    await ordinary(filename, false, check);
    return { bytes: bytes.subarray(0, length), identity: identity(before) };
  } finally { await handle.close(); }
}
export async function executableHash(filename: string, check: () => void): Promise<string> {
  await ordinary(filename, false, check);
  check(); const original = await fs.lstat(filename, { bigint: true }); check();
  const handle = await fs.open(filename, "r");
  try {
    check();
    const before = await handle.stat({ bigint: true }); check();
    requireValue(before.isFile() && before.nlink === 1n && identity(before) === identity(original), "CONFIG_CHANGED");
    requireValue(before.size <= 256n * 1024n * 1024n, "BUDGET_EXCEEDED");
    const digest = createHash("sha256"), buffer = Buffer.alloc(64 * 1024); let length = 0;
    for (;;) {
      check(); const part = await handle.read(buffer, 0, buffer.length, null); check();
      if (!part.bytesRead) break;
      length += part.bytesRead; requireValue(length <= 256 * 1024 * 1024, "BUDGET_EXCEEDED");
      digest.update(buffer.subarray(0, part.bytesRead));
    }
    const after = await handle.stat({ bigint: true }); check();
    const current = await fs.lstat(filename, { bigint: true }); check();
    requireValue(!current.isSymbolicLink() && current.nlink === 1n && identity(before) === identity(current) &&
      before.size === after.size && after.size === BigInt(length) &&
      before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs, "CONFIG_CHANGED");
    await ordinary(filename, false, check); return digest.digest("hex");
  } finally { await handle.close(); }
}

export class Admission {
  private busy = false;
  private revoked = false;
  private idle: Array<() => void> = [];
  constructor(private readonly authorize: () => void) { requireValue(typeof authorize === "function"); }
  check(): void {
    if (this.revoked) fail("CONFIG_CHANGED");
    try { requireValue(this.authorize() === undefined); } catch { this.revoked = true; fail("CONFIG_CHANGED"); }
  }
  begin(): void {
    this.check(); requireValue(!this.busy, "BUSY"); this.busy = true;
  }
  end(): void { this.busy = false; this.idle.splice(0).forEach(done => done()); }
  isIdle(): boolean { return !this.busy; }
  waitForIdle(): Promise<void> { return this.busy ? new Promise(done => this.idle.push(done)) : Promise.resolve(); }
}
