import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { ImpactError, identifier, validateNativeProjectSnapshot, type NativeProjectSnapshot } from "@atlas/impact";

export interface NativeSourceConfig {
  executable: string; executableDigest: string; database: string;
  projectId: string; site: string; target: "local" | "external"; environmentId: string;
}
function fail(code: string): never { throw new ImpactError(code); }
function canonical(value: string): string { return process.platform === "win32" ? value.toLowerCase() : value; }
async function trustedFile(value: string, maxBytes: number): Promise<string> {
  if (typeof value !== "string" || !path.isAbsolute(value) || /[\x00-\x1f\x7f]/u.test(value) || value.length > 4096) fail("NATIVE_PATH_DENIED");
  const full = path.resolve(value);
  if (full.split(/[\\/]/u).some(part => [".lmti", ".git"].includes(part.toLowerCase()))) fail("NATIVE_PATH_DENIED");
  try {
    const real = await fs.realpath(full), stat = await fs.lstat(full);
    if (canonical(full) !== canonical(real) || stat.isSymbolicLink() || !stat.isFile() || stat.size > maxBytes) fail("NATIVE_PATH_DENIED");
    return real;
  } catch (error) { if (error instanceof ImpactError) throw error; fail("NATIVE_SOURCE_UNAVAILABLE"); }
}
async function binaryDigest(filename: string): Promise<string> {
  const handle = await fs.open(filename, "r");
  try {
    const before = await handle.stat();
    if (before.size > 64 * 1024 * 1024) fail("NATIVE_BINARY_DENIED");
    const hash = createHash("sha256"), buffer = Buffer.alloc(64 * 1024); let length = 0;
    for (;;) {
      const read = await handle.read(buffer, 0, buffer.length, null);
      if (!read.bytesRead) break;
      length += read.bytesRead; if (length > 64 * 1024 * 1024) fail("NATIVE_BINARY_DENIED");
      hash.update(buffer.subarray(0, read.bytesRead));
    }
    const after = await handle.stat();
    if (length !== before.size || after.size !== before.size || before.mtimeMs !== after.mtimeMs) fail("NATIVE_BINARY_CHANGED");
    return hash.digest("hex");
  } finally { await handle.close(); }
}
export function validateNativeSourceConfig(value: unknown): NativeSourceConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("NATIVE_CONFIG_INVALID");
  const raw = value as Record<string, unknown>, allowed = ["executable", "executableDigest", "database", "projectId", "site", "target", "environmentId"];
  if (Object.keys(raw).some(key => !allowed.includes(key)) || allowed.some(key => !(key in raw))) fail("NATIVE_CONFIG_INVALID");
  if (typeof raw.executable !== "string" || typeof raw.database !== "string" || !path.isAbsolute(raw.executable) || !path.isAbsolute(raw.database) || !["lmti-project", "lmti-project.exe"].includes(path.basename(raw.executable).toLowerCase()) || typeof raw.executableDigest !== "string" || !/^[a-f0-9]{64}$/u.test(raw.executableDigest) || !["local", "external"].includes(String(raw.target))) fail("NATIVE_CONFIG_INVALID");
  return { executable: raw.executable, executableDigest: raw.executableDigest, database: raw.database, projectId: identifier(raw.projectId), site: identifier(raw.site), target: raw.target as "local" | "external", environmentId: identifier(raw.environmentId) };
}
export async function pinNativeSource(value: Omit<NativeSourceConfig, "executableDigest">): Promise<NativeSourceConfig> {
  const executable = await trustedFile(value.executable, 64 * 1024 * 1024), database = await trustedFile(value.database, 64 * 1024 * 1024);
  return validateNativeSourceConfig({ ...value, executable, database, executableDigest: await binaryDigest(executable) });
}
/** Fixed native owner operation and launcher-owned arguments; never use a shell. */
export async function readNativeOwner(value: NativeSourceConfig): Promise<NativeProjectSnapshot> {
  const config = validateNativeSourceConfig(value);
  const executable = await trustedFile(config.executable, 64 * 1024 * 1024), database = await trustedFile(config.database, 64 * 1024 * 1024);
  if (await binaryDigest(executable) !== config.executableDigest) fail("NATIVE_BINARY_CHANGED");
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP", "LANG"]) if (process.env[key]) env[key] = process.env[key];
  env.PATH = path.dirname(executable) + (process.platform === "win32" && process.env.SystemRoot ? path.delimiter + path.join(process.env.SystemRoot, "System32") : "");
  env.QT_PLUGIN_PATH = path.dirname(executable);
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    const child = spawn(executable, ["snapshot", database, config.projectId, config.site, config.target], { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env, cwd: path.dirname(executable) });
    const chunks: Buffer[] = []; let length = 0, errors = 0, completed = false;
    const stop = (code: string) => { if (completed) return; completed = true; clearTimeout(timer); child.kill(); reject(new ImpactError(code)); };
    const timer = setTimeout(() => stop("NATIVE_SOURCE_TIMEOUT"), 6000);
    child.stdout.on("data", (chunk: Buffer) => { length += chunk.length; if (length > 4 * 1024 * 1024) stop("NATIVE_OUTPUT_SIZE_DENIED"); else chunks.push(chunk); });
    child.stderr.on("data", (chunk: Buffer) => { errors += chunk.length; if (errors > 64 * 1024) stop("NATIVE_OUTPUT_SIZE_DENIED"); });
    child.once("error", () => stop("NATIVE_SOURCE_UNAVAILABLE"));
    child.once("close", code => { if (completed) return; completed = true; clearTimeout(timer); if (code !== 0) reject(new ImpactError("NATIVE_SOURCE_UNAVAILABLE")); else resolve(Buffer.concat(chunks)); });
  });
  let payload: unknown;
  try { payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { fail("NATIVE_OUTPUT_INVALID"); }
  const snapshot = validateNativeProjectSnapshot(payload);
  if (snapshot.projectId !== config.projectId || snapshot.site !== config.site || snapshot.external !== (config.target === "external")) fail("NATIVE_SCOPE_DENIED");
  return snapshot;
}
