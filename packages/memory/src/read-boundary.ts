import { promises as fs } from "node:fs";
import path from "node:path";
import { checkedStoragePath } from "./storage-boundary";

export const MAX_CONTEXT_MEMORY_RECORDS = 10_000;
export const MAX_CONTEXT_MEMORY_BYTES = 16 * 1024 * 1024;

// A missing store is distinct from an unreadable, malformed or escaped store.
// This reader never creates directories, follows an out-of-project link or
// silently falls back from an existing but unusable authoritative source.
export async function checkedMemoryFile(cwd: string, name: string, maxBytes: number): Promise<string | undefined> {
  const checked = await checkedStoragePath(cwd, path.join(".lmti", "memory", name), { kind: "file" });
  if (!checked.exists) return undefined;
  const stat = await fs.stat(checked.filename);
  if (!stat.isFile()) throw new Error("MEMORY_SOURCE_INVALID");
  if (stat.size > maxBytes) throw new Error("MEMORY_READ_BUDGET_EXCEEDED");
  await checked.recheck();
  return checked.filename;
}

export function requireCompleteMemoryScan(rows: unknown[]): void {
  if (rows.length > MAX_CONTEXT_MEMORY_RECORDS) throw new Error("MEMORY_READ_BUDGET_EXCEEDED");
}

export async function readBoundedMemoryText(filename: string, maxBytes: number): Promise<string> {
  const handle = await fs.open(filename, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > maxBytes) throw new Error("MEMORY_READ_BUDGET_EXCEEDED");
    const bytes = Buffer.alloc(Math.min(before.size + 1, maxBytes + 1));
    let length = 0;
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    const after = await handle.stat();
    if (after.size > maxBytes) throw new Error("MEMORY_READ_BUDGET_EXCEEDED");
    if (length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error("MEMORY_SOURCE_CHANGED_DURING_READ");
    return bytes.subarray(0, length).toString("utf8");
  } finally { await handle.close(); }
}
