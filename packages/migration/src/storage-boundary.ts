import { constants, promises as fs, type BigIntStats } from "node:fs";
import path from "node:path";

const denied = () => new Error("MIGRATION_STORAGE_BOUNDARY_DENIED");
const same = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino;

function privateOwner(info: BigIntStats, directory: boolean) {
  if (process.platform === "win32") return;
  if (info.uid !== BigInt(process.getuid!()) || (info.mode & 0o077n) !== 0n ||
      (info.mode & (directory ? 0o700n : 0o600n)) !== (directory ? 0o700n : 0o600n)) {
    throw new Error("MIGRATION_STORAGE_PERMISSIONS_UNSAFE");
  }
}

// Migration owns bootstrap/config/report writes. Do not enter memory's DB owner
// merely to copy legacy JSON. A project-root alias is supported, inner links are not.
export async function checkedCanonicalPath(cwd: string, target: string, kind: "file" | "directory") {
  const relative = path.relative(path.resolve(cwd), path.resolve(target));
  const parts = relative.split(path.sep);
  if (parts[0] !== ".lmti" || parts.some(part => !part || part === "." || part === "..") || path.isAbsolute(relative)) throw denied();
  const root = await fs.realpath(cwd);
  const rootInfo = await fs.stat(root, { bigint: true });
  if (!rootInfo.isDirectory()) throw denied();
  const ancestors = [{ filename: root, info: rootInfo }];
  const recheck = async () => {
    for (const item of ancestors) {
      const current = await fs.lstat(item.filename, { bigint: true });
      if (current.isSymbolicLink() || !same(current, item.info)) throw denied();
      if (item.filename !== root) privateOwner(current, current.isDirectory());
    }
  };
  let filename = root, exists = true;
  for (let i = 0; i < parts.length; i++) {
    filename = path.join(filename, parts[i]!);
    const directory = i < parts.length - 1 || kind === "directory";
    let info: BigIntStats;
    try { info = await fs.lstat(filename, { bigint: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (!directory) { exists = false; break; }
      await recheck();
      try { await fs.mkdir(filename, { mode: 0o700 }); }
      catch (createError) { if ((createError as NodeJS.ErrnoException).code !== "EEXIST") throw createError; }
      info = await fs.lstat(filename, { bigint: true });
    }
    if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1n) ||
        path.relative(filename, await fs.realpath(filename)) !== "") throw denied();
    privateOwner(info, directory);
    ancestors.push({ filename, info });
  }
  await recheck();
  return { filename: path.join(root, ...parts), exists, recheck };
}

export async function writeCanonicalFile(cwd: string, target: string, content: string, exclusive = false) {
  const checked = await checkedCanonicalPath(cwd, target, "file");
  if (exclusive && checked.exists) return;
  await checked.recheck();
  const flags = constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0) |
    (checked.exists ? 0 : constants.O_CREAT | constants.O_EXCL);
  const handle = await fs.open(checked.filename, flags, 0o600);
  try {
    await checked.recheck();
    const info = await handle.stat({ bigint: true }), current = await fs.lstat(checked.filename, { bigint: true });
    if (!info.isFile() || info.nlink !== 1n || current.isSymbolicLink() || !same(info, current)) throw denied();
    privateOwner(info, false);
    await handle.truncate(0);
    await handle.writeFile(content, "utf8");
  } finally { await handle.close(); }
}
