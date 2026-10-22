/** Fixed owner read boundary for compiled code/documents and deliberate memory. */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { readProjectMemorySnapshot } from "@atlas/memory";
import { redactText, runEgressSecretScan } from "@atlas/privacy";

const MAX_AMF = 2 * 1024 * 1024;
const MAX_FILE = 256 * 1024;
const MAX_OUTPUT = 512 * 1024;
type ObjectValue = Record<string, unknown>;
export type AgentKnowledgeMapping = {
  kind: "code" | "document"; referenceKind: "repository" | "knowledge";
  referenceId: string; referenceFingerprint: string; path: string;
} | { kind: "memory"; referenceKind: "component"; referenceId: string; disclosure: "owner_safe_summary" };
type Item = {
  id: string; kind: "code" | "document" | "memory"; referenceKind: string;
  referenceId: string; referenceFingerprint: string; title: string; summary: string;
  classification: "public" | "internal"; disclosure: "owner_safe_summary" | "public_compiled_summary";
  evidenceId: string; contentFingerprint: string;
  sourcePart: "compiled" | "memory"; semantics: "compiled" | "reviewed_memory" | "deliberate_memory";
};
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const canonical = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
const reservedPart = (value: string) => /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(value) || /[. ]$/u.test(value);
function fail(code = "KNOWLEDGE_REQUEST_DENIED"): never { throw new Error(code); }
// JSON.parse alone silently accepts duplicate keys. This boundary rejects them,
// nonfinite numbers and excessive nesting before normal typed validation.
function strictJson(text: string): unknown {
  let offset = 0;
  const whitespace = () => { while (offset < text.length && /[\t\n\r ]/u.test(text[offset])) offset++; };
  function parse(depth: number): unknown {
    if (depth > 32) fail("SOURCE_SCHEMA_DENIED");
    whitespace();
    const first = text[offset];
    if (first === '"') {
      const start = offset++;
      while (offset < text.length) {
        const char = text[offset++];
        if (char === "\\") offset++;
        else if (char === '"') return JSON.parse(text.slice(start, offset));
      }
      fail("SOURCE_SCHEMA_DENIED");
    }
    if (first === "{" || first === "[") {
      offset++;
      const result: ObjectValue | unknown[] = first === "{" ? Object.create(null) as ObjectValue : [];
      const end = first === "{" ? "}" : "]";
      whitespace();
      if (text[offset] === end) { offset++; return result; }
      while (true) {
        if (Array.isArray(result)) result.push(parse(depth + 1));
        else {
          const key = parse(depth + 1);
          if (typeof key !== "string" || Object.hasOwn(result, key)) fail("SOURCE_SCHEMA_DENIED");
          whitespace();
          if (text[offset++] !== ":") fail("SOURCE_SCHEMA_DENIED");
          result[key] = parse(depth + 1);
        }
        whitespace();
        const separator = text[offset++];
        if (separator === end) return result;
        if (separator !== ",") fail("SOURCE_SCHEMA_DENIED");
      }
    }
    const match = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/u.exec(text.slice(offset));
    if (!match) fail("SOURCE_SCHEMA_DENIED");
    offset += match[0].length;
    const result: unknown = JSON.parse(match[0]);
    if (typeof result === "number" && !Number.isFinite(result)) fail("SOURCE_SCHEMA_DENIED");
    return result;
  }
  const result = parse(0);
  whitespace();
  if (offset !== text.length) fail("SOURCE_SCHEMA_DENIED");
  return result;
}
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  return value as ObjectValue;
}
function exact(value: ObjectValue, keys: string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some(key => !(key in value))) fail();
}
function string(value: unknown, max: number, required = true): string {
  if (typeof value !== "string" || Buffer.byteLength(value) > max || /[\x00-\x1f\x7f]/u.test(value) || (required && !value.trim())) fail();
  return value;
}
function id(value: unknown): string {
  const result = string(value, 64);
  if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(result)) fail();
  return result;
}
function fingerprint(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) fail();
  return value;
}
function relative(value: unknown): string {
  const result = string(value, 512).replaceAll("\\", "/");
  if (path.isAbsolute(result) || result.includes(":") || result.split("/").some(part =>
    !part || part === "." || part === ".." || reservedPart(part) || /^(?:\.git|\.lmti|\.ssh|\.aws|\.azure|\.env(?:\..*)?|node_modules)$/iu.test(part))) fail("SOURCE_BOUNDARY_DENIED");
  return result;
}
async function localRoot(value: string): Promise<string> {
  // Lexical denial precedes lstat/realpath: never touch a UNC/device/ADS target.
  if (/^[\\/]{2}/u.test(value) || !path.isAbsolute(value) ||
      value.replace(/^[A-Za-z]:[\\/]/u, "").includes(":")) fail("SOURCE_BOUNDARY_DENIED");
  const parsed = path.parse(value), parts = value.slice(parsed.root.length).split(/[\\/]/u);
  if (parts.some(part => !part || part === "." || part === ".." || reservedPart(part))) fail("SOURCE_BOUNDARY_DENIED");
  let current = parsed.root;
  for (const part of parts) {
    current = path.join(current, part);
    if ((await fs.lstat(current)).isSymbolicLink()) fail("SOURCE_BOUNDARY_DENIED");
  }
  const root = await fs.realpath(value);
  if (!(await fs.stat(root)).isDirectory()) fail("SOURCE_BOUNDARY_DENIED");
  return root;
}
function declaredRootMatches(value: unknown, root: string): boolean {
  // AMF metadata is untrusted: do not resolve its root through the filesystem.
  // Only the separately authorized root may cause filesystem access.
  return typeof value === "string" && value.length <= 4096 && !/[\x00-\x1f\x7f]/u.test(value) &&
    !/^[\\/]{2}/u.test(value) && path.isAbsolute(value) &&
    !value.replace(/^[A-Za-z]:[\\/]/u, "").includes(":") && canonical(path.resolve(value)) === canonical(root);
}
function safeText(value: unknown, max: number): string {
  if (typeof value !== "string" || runEgressSecretScan(value).blocked) fail("OUTPUT_POLICY_DENIED");
  return redactText(value).replace(/[\x00-\x1f\x7f]/gu, " ").slice(0, max);
}
async function checkedPath(root: string, name: string, max: number, optional = false): Promise<string | undefined> {
  let current = root;
  for (const part of name.split("/")) {
    current = path.join(current, part);
    let info;
    try { info = await fs.lstat(current); }
    catch (error) { if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined; fail("SOURCE_UNAVAILABLE"); }
    if (info.isSymbolicLink()) fail("SOURCE_BOUNDARY_DENIED");
  }
  const resolved = await fs.realpath(current), rel = path.relative(root, resolved), info = await fs.stat(resolved);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel) || !info.isFile() || info.nlink > 1 || info.size > max) fail("SOURCE_BOUNDARY_DENIED");
  return resolved;
}
async function readFile(root: string, name: string, max: number): Promise<Buffer> {
  const filename = (await checkedPath(root, name, max))!;
  const handle = await fs.open(filename, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > max) fail("SOURCE_SIZE_DENIED");
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    const after = await handle.stat();
    if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs ||
        await checkedPath(root, name, max) !== filename || (await fs.stat(filename)).ino !== after.ino) fail("SOURCE_CHANGED");
    return bytes.subarray(0, length);
  } finally { await handle.close(); }
}
function mapping(value: unknown): AgentKnowledgeMapping {
  const row = object(value);
  if (row.kind === "memory") {
    exact(row, ["kind", "referenceKind", "referenceId", "disclosure"]);
    if (row.referenceKind !== "component" || row.disclosure !== "owner_safe_summary") fail();
    return { kind: "memory", referenceKind: "component", referenceId: id(row.referenceId), disclosure: "owner_safe_summary" };
  }
  exact(row, ["kind", "referenceKind", "referenceId", "referenceFingerprint", "path"]);
  if ((row.kind !== "code" && row.kind !== "document") || row.referenceKind !== (row.kind === "code" ? "repository" : "knowledge")) fail();
  return { kind: row.kind, referenceKind: row.referenceKind as "repository" | "knowledge",
    referenceId: id(row.referenceId), referenceFingerprint: fingerprint(row.referenceFingerprint), path: relative(row.path) };
}

/** Caller is a trusted launcher. Agent arguments never select roots or mappings. */
export async function agentContextCommand(input: unknown) {
  const request = object(input);
  exact(request, ["schema", "operation", "projectId", "sourceRoot", "sourceId", "target", "task", "limit", "mappings"]);
  if (request.schema !== "lmti.agent.knowledge.request.v1" || request.operation !== "context" || typeof request.target !== "string" || !["external", "local"].includes(request.target)) fail();
  const projectId = id(request.projectId), expectedSourceId = fingerprint(request.sourceId);
  const selectedRoot = string(request.sourceRoot, 4096), task = string(request.task, 1000).trim();
  const root = await localRoot(selectedRoot);
  if (runEgressSecretScan(task).blocked || redactText(task) !== task) fail("TASK_PRIVACY_DENIED");
  if (!Number.isSafeInteger(request.limit) || (request.limit as number) < 1 || (request.limit as number) > 200 || !Array.isArray(request.mappings) || request.mappings.length > 100) fail();
  const mappings = request.mappings.map(mapping);
  if (new Set(mappings.map(row => JSON.stringify(row))).size !== mappings.length || mappings.filter(row => row.kind === "memory").length > 1) fail();
  const bytes = await readFile(root, ".lmti/project.amf.json", MAX_AMF);
  const amf = object(strictJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes))), project = object(amf.project);
  if (amf.version !== "0.1.0" || !declaredRootMatches(project.root, root) || !Array.isArray(amf.files) || amf.files.length > 10000) fail("SOURCE_IDENTITY_DENIED");
  const sourceId = hash(canonical(root) + "\0" + string(project.name, 512));
  if (sourceId !== expectedSourceId) fail("SOURCE_IDENTITY_DENIED");
  const compiledAt = string(project.compiledAt, 64);
  if (!compiledAt.endsWith("Z") || !Number.isFinite(Date.parse(compiledAt))) fail("SOURCE_SCHEMA_DENIED");
  const boundary = object(project.sourceBoundary), compiler = object(project.compiler);
  if (compiler.name !== "Knowledge Compiler v0" || compiler.version !== "0.1.0" ||
      !declaredRootMatches(boundary.root, root) ||
      !Array.isArray(boundary.ignoredFiles) || boundary.ignoredFiles.some(value => typeof value !== "string")) fail("SOURCE_SCHEMA_DENIED");
  const ignorePath = await checkedPath(root, ".lmtiignore", 64 * 1024, true);
  const ignoreBytes = ignorePath ? await readFile(root, ".lmtiignore", 64 * 1024) : Buffer.alloc(0);
  const ignoreRules = new TextDecoder("utf-8", { fatal: true }).decode(ignoreBytes).split(/\r?\n/u)
    .map(line => line.trim()).filter(line => line && !line.startsWith("#")).map(line => `.lmtiignore:${line}`);
  // A changed ignore policy is a revocation. Do not open previously compiled
  // files until the owner has recompiled with the current source boundary.
  if (JSON.stringify(ignoreRules) !== JSON.stringify(boundary.ignoredFiles.filter(value => (value as string).startsWith(".lmtiignore:")))) fail("SOURCE_POLICY_DENIED");
  const items: Item[] = [], reasons = new Set<string>(), compiledProjection: unknown[] = [];
  const rawFiles = amf.files.map(object);
  if (new Set(rawFiles.map(row => row.path)).size !== rawFiles.length) fail("SOURCE_SCHEMA_DENIED");
  let mappedBytes = 0;
  for (const map of mappings) {
    if (map.kind === "memory") continue;
    const row = rawFiles.find(file => file.path === map.path);
    // Classification is checked before opening any mapped source text.
    if (!row || row.privacy !== "public" || row.kind !== (map.kind === "code" ? "source" : "documentation")) {
      reasons.add("MAPPED_CONTENT_UNAVAILABLE"); continue;
    }
    const summary = safeText(row.summary, 2000), title = safeText(path.posix.basename(map.path), 240);
    if (!summary.trim()) { reasons.add("MAPPED_CONTENT_UNAVAILABLE"); continue; }
    const content = await readFile(root, map.path, MAX_FILE);
    mappedBytes += content.length;
    if (mappedBytes > 4 * 1024 * 1024) fail("SOURCE_SIZE_DENIED");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(content);
    if (runEgressSecretScan(text).blocked || /(?:@(?:lmti-)?(?:private|confidential|secret)|lmti\s*:\s*(?:private|confidential|secret)|do_not_prompt)/iu.test(text)) fail("SOURCE_POLICY_DENIED");
    const contentFingerprint = hash(text);
    if (contentFingerprint !== fingerprint(row.hash)) { reasons.add("COMPILED_CONTENT_STALE"); continue; }
    const key = hash(JSON.stringify([map.kind, map.path, map.referenceKind, map.referenceId]));
    const item: Item = { id: `item-${key.slice(0, 32)}`, kind: map.kind, referenceKind: map.referenceKind,
      referenceId: map.referenceId, referenceFingerprint: map.referenceFingerprint, title, summary,
      classification: "public", disclosure: "public_compiled_summary", evidenceId: `evidence-${key.slice(0, 32)}`, contentFingerprint,
      sourcePart: "compiled", semantics: "compiled" };
    items.push(item); compiledProjection.push(item);
  }
  const memoryMap = mappings.find(row => row.kind === "memory");
  const allowedMemories: unknown[] = [];
  let memoryConnected = false;
  if (memoryMap) {
    // Only the memory owner opens its store; check source paths before invoking it.
    await checkedPath(root, ".lmti/memory/project-memory.sqlite", 128 * 1024 * 1024, true);
    await checkedPath(root, ".lmti/memory/project-memory.sqlite-wal", 128 * 1024 * 1024, true);
    await checkedPath(root, ".lmti/memory/project-memory.sqlite-shm", 16 * 1024 * 1024, true);
    const memory = await readProjectMemorySnapshot(root);
    memoryConnected = memory.connected;
    if (!memory.connected) reasons.add("MEMORY_SOURCE_NOT_CONNECTED");
    if (memory.truncated) reasons.add("OWNER_WINDOW_LIMIT");
    for (const row of memory.memories) {
      // The trusted mapping explicitly permits the owner's safe summary mode.
      // Preserve original classification; never promote private or secret data.
      if (row.privacy !== "public" && row.privacy !== "internal") continue;
      const title = safeText(row.title, 240), summary = safeText(row.summary, 2000);
      const key = hash(JSON.stringify(["memory", row.id, memoryMap.referenceId]));
      const item: Item = { id: `item-${key.slice(0, 32)}`, kind: "memory", referenceKind: "component",
        referenceId: memoryMap.referenceId, referenceFingerprint: "", title, summary,
        classification: row.privacy, disclosure: "owner_safe_summary", evidenceId: `evidence-${key.slice(0, 32)}`,
        contentFingerprint: hash(JSON.stringify([row.id, title, summary, row.zone, row.updatedAt])),
        sourcePart: "memory", semantics: row.zone === "lesson" ? "reviewed_memory" : "deliberate_memory" };
      items.push(item); allowedMemories.push(item);
    }
  }
  if (!bytes.equals(await readFile(root, ".lmti/project.amf.json", MAX_AMF))) fail("SOURCE_CHANGED");
  const finalIgnorePath = await checkedPath(root, ".lmtiignore", 64 * 1024, true);
  const finalIgnore = finalIgnorePath ? await readFile(root, ".lmtiignore", 64 * 1024) : Buffer.alloc(0);
  if (!ignoreBytes.equals(finalIgnore)) fail("SOURCE_CHANGED");
  const query = task.toLowerCase().split(/\s+/u).filter(Boolean);
  const matching = items.filter(item => query.some(word => `${item.kind} ${item.title} ${item.summary}`.toLowerCase().includes(word)))
    .sort((left, right) => left.id.localeCompare(right.id));
  const selected = matching.slice(0, request.limit as number);
  if (selected.length < matching.length) reasons.add("RESULT_LIMIT");
  const sources = [{ part: "compiled", version: hash(JSON.stringify(compiledProjection)), compiledAt,
    freshness: "checked", basis: "mapped_source_content_matches_compiled_hash" },
  ...(memoryMap ? [{ part: "memory", version: hash(JSON.stringify(allowedMemories)), compiledAt: null,
    freshness: memoryConnected ? "checked" : "unavailable", basis: "read_only_memory_owner_projection" }] : [])];
  const response = { schema: "lmti.agent.knowledge.v1", projectId, sourceId, target: request.target,
    classification: selected.some(item => item.classification === "internal") ? "internal" : "public",
    checkedAt: new Date().toISOString(), sources, items: selected,
    completeness: { state: reasons.size ? "partial" : "complete", reasons: [...reasons].sort(), nextCursor: null },
    fingerprint: hash(JSON.stringify({ sourceId, sources, items: selected, reasons: [...reasons].sort() })) };
  const encoded = JSON.stringify(response);
  if (Buffer.byteLength(encoded) > MAX_OUTPUT || runEgressSecretScan(encoded).blocked) fail("OUTPUT_POLICY_DENIED");
  return response;
}

export async function readAgentContextRequest(): Promise<unknown> {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 64 * 1024) fail("REQUEST_SIZE_DENIED");
    chunks.push(Buffer.from(chunk));
  }
  return strictJson(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
}
