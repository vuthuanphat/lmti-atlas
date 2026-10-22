import { constants, promises as fs, type BigIntStats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

const denied = () => new Error("MEMORY_SOURCE_BOUNDARY_DENIED");
const unavailable = () => new Error("MEMORY_SOURCE_UNAVAILABLE");
const changed = () => new Error("MEMORY_SOURCE_CHANGED_DURING_ACCESS");
const privateModes = (info: BigIntStats, directory: boolean) => {
  if (process.platform === "win32") return; // Windows ACLs are retained, not approximated with chmod.
  if (info.uid !== BigInt(process.getuid?.() ?? -1) || (info.mode & 0o077n) !== 0n ||
      (info.mode & (directory ? 0o700n : 0o600n)) !== (directory ? 0o700n : 0o600n)) {
    throw new Error("MEMORY_STORAGE_PERMISSIONS_UNSAFE: require owner-only directories (0700) and files (0600); review existing permissions explicitly.");
  }
};
const sameFile = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino;

export interface CheckedMemoryPath {
  readonly root: string;
  readonly filename: string;
  readonly exists: boolean;
  /** Rechecks identities immediately before use. This is not an OS sandbox:
   * Node/SQLite path APIs cannot prevent a hostile same-user ancestor rename
   * between the last check and open. Private owned parents are required. */
  recheck(): Promise<void>;
}

/** Project-root aliases are allowed. Writes never follow links below that root.
 * Existing permissions are checked, never silently repaired or widened. */
export async function checkedStoragePath(cwd: string, relative: string,
  options: { kind: "file" | "directory"; createParents?: boolean; private?: boolean }): Promise<CheckedMemoryPath> {
  const parts = relative.replaceAll("\\", "/").split("/");
  if (parts[0] !== ".lmti" || parts.some(part => !part || part === "." || part === ".." || /[\x00-\x1f:]/.test(part)) || path.isAbsolute(relative)) throw denied();
  const root = await fs.realpath(cwd);
  const rootInfo = await fs.stat(root, { bigint: true });
  if (!rootInfo.isDirectory()) throw unavailable();
  const identities: Array<{ filename: string; info: BigIntStats }> = [{ filename: root, info: rootInfo }];
  let filename = root;
  let exists = true;
  for (let i = 0; i < parts.length; i++) {
    filename = path.join(filename, parts[i]);
    const directory = i < parts.length - 1 || options.kind === "directory";
    let info: BigIntStats;
    try { info = await fs.lstat(filename, { bigint: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw unavailable();
      if (!directory || !options.createParents) { exists = false; break; }
      await recheck();
      try { await fs.mkdir(filename, { mode: 0o700 }); }
      catch (createError) { if ((createError as NodeJS.ErrnoException).code !== "EEXIST") throw unavailable(); }
      info = await fs.lstat(filename, { bigint: true });
    }
    if (info.isSymbolicLink()) throw denied();
    const resolved = await fs.realpath(filename);
    if (path.relative(root, resolved).startsWith(`..${path.sep}`) || path.relative(root, resolved) === ".." ||
        path.isAbsolute(path.relative(root, resolved))) throw denied();
    // Junctions and path replacement must not silently select another target.
    if (path.relative(filename, resolved) !== "") throw denied();
    if (directory ? !info.isDirectory() : !info.isFile()) throw new Error("MEMORY_SOURCE_INVALID");
    if (!directory && info.nlink !== 1n) throw denied();
    if (options.private) privateModes(info, directory);
    identities.push({ filename, info });
  }
  const target = path.join(root, ...parts);
  async function recheck() {
    for (const entry of identities) {
      let current: BigIntStats;
      try { current = await fs.lstat(entry.filename, { bigint: true }); } catch { throw changed(); }
      if (current.isSymbolicLink() || !sameFile(entry.info, current) ||
          current.isDirectory() !== entry.info.isDirectory() || (!current.isDirectory() && current.nlink !== 1n)) throw changed();
      if (entry.filename !== root && options.private) privateModes(current, current.isDirectory());
    }
  }
  await recheck();
  return { root, filename: target, exists, recheck };
}

export async function ensureMemoryDirectory(cwd: string, relative: string): Promise<string> {
  return (await checkedStoragePath(cwd, relative, { kind: "directory", createParents: true, private: true })).filename;
}

export async function openPrivateMemoryFile(cwd: string, relative: string, append = false): Promise<FileHandle> {
  let checked = await checkedStoragePath(cwd, relative, { kind: "file", createParents: true, private: true });
  const flags = constants.O_WRONLY | (append ? constants.O_APPEND : 0) | (constants.O_NOFOLLOW ?? 0);
  await checked.recheck();
  let handle: FileHandle;
  try {
    handle = await fs.open(checked.filename, flags | (checked.exists ? 0 : constants.O_CREAT | constants.O_EXCL), 0o600);
  } catch (error) {
    if (checked.exists || (error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    checked = await checkedStoragePath(cwd, relative, { kind: "file", private: true });
    await checked.recheck();
    handle = await fs.open(checked.filename, flags);
  }
  try {
    await checked.recheck();
    const opened = await handle.stat({ bigint: true });
    const current = await fs.lstat(checked.filename, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || current.isSymbolicLink() || !sameFile(opened, current)) throw changed();
    privateModes(opened, false);
    return handle;
  } catch (error) { await handle.close(); throw error; }
}

export async function writeMemoryFile(cwd: string, relative: string, content: string, mode: "replace" | "append" | "ensure" = "replace"): Promise<void> {
  if (mode === "ensure") {
    const checked = await checkedStoragePath(cwd, relative, { kind: "file", createParents: true, private: true });
    if (checked.exists) return;
    await checked.recheck();
    try {
      const file = await fs.open(checked.filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
      try {
        await checked.recheck();
        const opened = await file.stat({ bigint: true }), current = await fs.lstat(checked.filename, { bigint: true });
        if (!opened.isFile() || opened.nlink !== 1n || current.isSymbolicLink() || !sameFile(opened, current)) throw changed();
        privateModes(opened, false);
        await file.writeFile(content, "utf8");
      } finally { await file.close(); }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await checkedStoragePath(cwd, relative, { kind: "file", private: true });
      return;
    }
  }
  const file = await openPrivateMemoryFile(cwd, relative, mode === "append");
  try {
    if (mode === "replace") await file.truncate(0);
    await file.writeFile(content, "utf8");
  } finally { await file.close(); }
}

export async function checkedSqliteTarget(cwd: string, name: string, create: boolean): Promise<CheckedMemoryPath> {
  if (!name || name === "." || name === ".." || /[\\/\x00-\x1f:]/.test(name)) throw denied();
  // One operation owns these parent/database identities. Sidecars can be
  // recreated by SQLite, so their safety is checked afresh on every use.
  const parent = await checkedStoragePath(cwd, ".lmti/memory", {
    kind: "directory", createParents: create, private: true
  });
  if (!parent.exists) throw unavailable();
  const filename = path.join(parent.filename, name);
  async function fileInfo(target: string): Promise<BigIntStats | undefined> {
    let info: BigIntStats;
    try { info = await fs.lstat(target, { bigint: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw unavailable();
    }
    if (info.isSymbolicLink() || info.nlink !== 1n) throw denied();
    if (!info.isFile()) throw new Error("MEMORY_SOURCE_INVALID");
    if (path.relative(target, await fs.realpath(target)) !== "") throw denied();
    privateModes(info, false);
    return info;
  }
  async function checkSidecars(): Promise<void> {
    for (const suffix of ["-wal", "-shm", "-journal"]) await fileInfo(filename + suffix);
  }
  let identity = await fileInfo(filename);
  // Refuse unsafe sidecars before even creating an empty main database.
  await checkSidecars();
  await parent.recheck();
  if (!identity) {
    if (!create) throw unavailable();
    try {
      const file = await fs.open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
      try {
        const held = await file.stat({ bigint: true });
        identity = await fileInfo(filename);
        if (!identity || !sameFile(held, identity)) throw changed();
      } finally { await file.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      identity = await fileInfo(filename);
    }
  }
  if (!identity) throw changed();
  const expected = identity;
  async function recheck(): Promise<void> {
    await parent.recheck();
    await checkSidecars();
    const current = await fileInfo(filename);
    if (!current || !sameFile(expected, current)) throw changed();
    await parent.recheck();
  }
  await recheck();
  return { root: parent.root, filename, exists: true, recheck };
}
