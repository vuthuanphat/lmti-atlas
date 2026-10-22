import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { runEgressSecretScan } from "@atlas/privacy";
import {
  type ImpactImport, type SourceDescriptor, digest, fail, identifier, textValue,
  validateImport
} from "./model.js";

export const MAPPED_CODE_ADAPTER_VERSION = "mapped-named-function-1";
export interface CodeSourceMapping {
  entityId: string; sourceKey: string; file: string; exportName: string;
  label: string; ownerRole: string; privacy: "public"; version?: string;
}
export interface MappedCodeOptions {
  root: string;
  source: Omit<SourceDescriptor, "digest" | "kind">;
  mappings: CodeSourceMapping[];
}
export interface CodeSourceInput { file: string; digest: string; }

const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024;
function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function relativeFile(value: unknown): string {
  const name = textValue(value, 512).replaceAll("\\", "/");
  if (path.isAbsolute(name) || name.includes(":") || name.split("/").some(part => !part || [".", "..", ".git", ".lmti", ".ssh", ".aws"].includes(part.toLowerCase())) || !/\.(?:ts|js)$/iu.test(name)) fail("CODE_PATH_DENIED");
  return name;
}
function readMappedFile(root: string, relative: string): Buffer {
  const candidate = path.join(root, relative);
  let current = root;
  for (const part of relative.split("/")) {
    current = path.join(current, part);
    if (lstatSync(current).isSymbolicLink()) fail("CODE_PATH_DENIED");
  }
  const canonical = realpathSync(candidate), original = lstatSync(candidate);
  if (!inside(root, canonical) || !original.isFile() || original.nlink > 1) fail("CODE_PATH_DENIED");
  const handle = openSync(candidate, "r");
  try {
    const before = fstatSync(handle);
    if (!before.isFile() || before.size > MAX_FILE_BYTES || before.ino !== original.ino || before.dev !== original.dev) fail("CODE_FILE_DENIED");
    const bytes = Buffer.alloc(MAX_FILE_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(handle, bytes, length, bytes.length - length, length);
      if (!count) break;
      length += count;
    }
    const after = fstatSync(handle);
    if (length > MAX_FILE_BYTES) fail("CODE_FILE_TOO_LARGE");
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || length !== after.size || realpathSync(candidate) !== canonical || lstatSync(candidate).isSymbolicLink()) fail("CODE_CHANGED_DURING_READ");
    return bytes.subarray(0, length);
  } finally { closeSync(handle); }
}
/** A deliberately narrow declaration recognizer, not a TS parser or an LSP. */
function exportedFunctions(source: string): Set<string> {
  let clean = "", state: "code" | "line" | "block" | "single" | "double" = "code";
  for (let i = 0; i < source.length; i++) {
    const char = source[i], next = source[i + 1];
    if (state === "line") { clean += char === "\n" ? "\n" : " "; if (char === "\n") state = "code"; continue; }
    if (state === "block") {
      if (char === "*" && next === "/") { clean += "  "; i++; state = "code"; }
      else clean += char === "\n" ? "\n" : " ";
      continue;
    }
    if (state === "single" || state === "double") {
      if (char === "\\") { clean += "  "; i++; continue; }
      if (char === "\n" || char === "\r") fail("UNSUPPORTED_CODE_SYNTAX");
      if ((state === "single" && char === "'") || (state === "double" && char === '"')) state = "code";
      clean += " "; continue;
    }
    if (char === "/" && next === "/") { state = "line"; clean += "  "; i++; }
    else if (char === "/" && next === "*") { state = "block"; clean += "  "; i++; }
    else if (char === "'") { state = "single"; clean += " "; }
    else if (char === '"') { state = "double"; clean += " "; }
    else if (char === "`" || char === "/") fail("UNSUPPORTED_CODE_SYNTAX");
    else clean += char;
  }
  if (!["code", "line"].includes(state)) fail("UNSUPPORTED_CODE_SYNTAX");
  const found = new Set<string>();
  let braces = 0, lineStart = 0;
  for (let i = 0; i < clean.length; i++) {
    if (clean[i] === "\n") { lineStart = i + 1; continue; }
    if (clean[i] === "{") { braces++; continue; }
    if (clean[i] === "}") { if (--braces < 0) fail("UNSUPPORTED_CODE_SYNTAX"); continue; }
    if (braces !== 0 || !clean.startsWith("export", i) || (i && /[\w$]/u.test(clean[i - 1]))) continue;
    if (!/^[\t ]*$/u.test(clean.slice(lineStart, i))) continue;
    const match = /^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/u.exec(clean.slice(i));
    if (!match) continue;
    let cursor = i + match[0].length, parens = 1;
    while (cursor < clean.length && parens) {
      if (clean[cursor] === "(") parens++;
      else if (clean[cursor] === ")") parens--;
      cursor++;
    }
    // Require a body, so ambient declarations and overload signatures do not
    // count. Complex generic/union/object return types are outside this adapter.
    if (parens || !/^\s*(?::\s*[A-Za-z_$][\w$]*(?:\[\])?)?\s*\{/u.test(clean.slice(cursor))) fail("UNSUPPORTED_CODE_SYNTAX");
    if (found.has(match[1])) fail("AMBIGUOUS_EXPORT");
    found.add(match[1]);
  }
  if (braces !== 0) fail("UNSUPPORTED_CODE_SYNTAX");
  return found;
}

/**
 * Compile only explicit public/nonsecret mappings from an allowed local root.
 * Produces no inferred dependencies and never returns/stores source text.
 */
export function compileMappedCodeSource(options: MappedCodeOptions): { snapshot: ImpactImport; inputs: CodeSourceInput[] } {
  if (!options || !path.isAbsolute(options.root) || lstatSync(options.root).isSymbolicLink()) fail("CODE_ROOT_DENIED");
  const root = realpathSync(options.root);
  if (!statSync(root).isDirectory() || root.split(/[\\/]/u).some(p => [".lmti", ".git"].includes(p.toLowerCase()))) fail("CODE_ROOT_DENIED");
  if (!Array.isArray(options.mappings) || options.mappings.length < 1 || options.mappings.length > 100) fail("CODE_MAPPING_LIMIT");
  if (options.source?.privacy !== "public") fail("CODE_SOURCE_PRIVACY_DENIED");
  const mappings = options.mappings.map(mapping => {
    if (!mapping || Object.keys(mapping).some(k => !["entityId", "sourceKey", "file", "exportName", "label", "ownerRole", "privacy", "version"].includes(k)) || mapping.privacy !== "public") fail("CODE_SOURCE_PRIVACY_DENIED");
    const name = textValue(mapping.exportName, 100);
    if (!/^[A-Za-z_$][\w$]*$/u.test(name)) fail("INVALID_EXPORT_NAME");
    return { ...mapping, entityId: identifier(mapping.entityId), sourceKey: textValue(mapping.sourceKey, 240), file: relativeFile(mapping.file), exportName: name, label: textValue(mapping.label, 240), ownerRole: textValue(mapping.ownerRole, 100), ...(mapping.version !== undefined ? { version: textValue(mapping.version, 160) } : {}) };
  }).sort((a, b) => a.entityId.localeCompare(b.entityId));
  if (new Set(mappings.map(m => `${m.file}\0${m.exportName}`)).size !== mappings.length) fail("AMBIGUOUS_CODE_MAPPING");
  const files = [...new Set(mappings.map(m => m.file))].sort(), inputs: CodeSourceInput[] = [];
  const exported = new Map<string, Set<string>>();
  let totalBytes = 0;
  for (const file of files) {
    const bytes = readMappedFile(root, file); totalBytes += bytes.length;
    if (totalBytes > MAX_TOTAL_BYTES) fail("CODE_SOURCE_TOO_LARGE");
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { fail("CODE_ENCODING_DENIED"); }
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(text!)) fail("CODE_ENCODING_DENIED");
    if (runEgressSecretScan(text!).blocked || /(?:@(?:lmti-)?(?:private|confidential|secret)|lmti\s*:\s*(?:private|confidential|secret)|do_not_prompt)/iu.test(text!)) fail("CODE_SOURCE_PRIVACY_DENIED");
    exported.set(file, exportedFunctions(text!));
    inputs.push({ file, digest: createHash("sha256").update(bytes).digest("hex") });
  }
  const snapshot: ImpactImport = {
    schema: "lmti.impact.import.v1",
    source: { ...options.source, kind: "code", parserVersion: MAPPED_CODE_ADAPTER_VERSION, digest: "0".repeat(64) },
    entities: [], evidence: [], assertions: []
  };
  for (const mapping of mappings) {
    if (!exported.get(mapping.file)?.has(mapping.exportName)) fail("MAPPED_EXPORT_NOT_FOUND");
    snapshot.entities.push({ id: mapping.entityId, sourceKey: mapping.sourceKey, kind: "code_unit", label: mapping.label, ownerRole: mapping.ownerRole, privacy: "public", ...(mapping.version ? { version: mapping.version } : {}) });
    snapshot.evidence.push({ id: `evidence-code-${digest([snapshot.source.id, mapping.entityId]).slice(0, 24)}`, entityId: mapping.entityId, locator: `${mapping.file}#export:${mapping.exportName}`, summary: `Explicit mapping identifies the named exported function ${mapping.exportName}. Declaration presence does not verify behavior or deployed state.`, capturedAt: snapshot.source.capturedAt, privacy: "public" });
  }
  snapshot.source.digest = digest({ snapshot: { ...snapshot, source: { ...snapshot.source, digest: undefined } }, inputs });
  return { snapshot: validateImport(snapshot), inputs };
}
