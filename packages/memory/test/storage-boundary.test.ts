import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { addProjectMemory, createMemory, initAtlasStorage, initProjectMemoryStorage, readProjectMemorySnapshot } from "../src/index";
import { checkedStoragePath, writeMemoryFile } from "../src/storage-boundary";
import { readProjectMemoryRecords } from "../src/sqlite-store";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "lmti-storage-boundary-"));
  const project = path.join(root, "project"), outside = path.join(root, "outside");
  await mkdir(project, { mode: 0o700 }); await mkdir(outside, { mode: 0o700 });
  return { root, project, outside };
}
const directoryLink = (target: string, filename: string) => symlink(target, filename, process.platform === "win32" ? "junction" : "dir");
const sample = { title: "Boundary fixture", content: "Synthetic local memory fixture", privacyLevel: "internal" as const };
const legacy = { scope: "long_term" as const, kind: "rule" as const, title: "Boundary fixture", content: "Synthetic local memory fixture", projectId: "fixture", sourceRefs: [], tags: [], importance: 1, confidence: "high" as const, sensitivity: "internal" as const };

describe("memory owner filesystem boundary", () => {
  for (const location of [".lmti", ".lmti/memory"]) {
    it(`refuses an escaped ${location} directory before either writer touches the target`, async () => {
      const { project, outside } = await fixture();
      if (location.includes("/")) await mkdir(path.join(project, ".lmti"), { mode: 0o700 });
      await directoryLink(outside, path.join(project, location));
      await expect(initProjectMemoryStorage(project)).rejects.toThrow("MEMORY_SOURCE_BOUNDARY_DENIED");
      await expect(createMemory(legacy, { cwd: project })).rejects.toThrow("MEMORY_SOURCE_BOUNDARY_DENIED");
      await expect(readProjectMemoryRecords(project, "fixture")).rejects.toThrow("MEMORY_SOURCE_BOUNDARY_DENIED");
      expect(await readdir(outside)).toEqual([]);
    });
  }

  it("refuses a linked SQLite file and leaves the outside bytes intact", async context => {
    const { project, outside } = await fixture();
    await mkdir(path.join(project, ".lmti/memory"), { recursive: true, mode: 0o700 });
    const target = path.join(outside, "store.sqlite");
    await writeFile(target, "synthetic sentinel", { mode: 0o600 });
    try { await symlink(target, path.join(project, ".lmti/memory/project-memory.sqlite"), "file"); }
    catch (error) { if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) { context.skip(); return; } throw error; }
    await expect(addProjectMemory(sample, { cwd: project })).rejects.toThrow("MEMORY_SOURCE_BOUNDARY_DENIED");
    await expect(readProjectMemorySnapshot(project)).rejects.toThrow("MEMORY_SOURCE_BOUNDARY_DENIED");
    expect(await readFile(target, "utf8")).toBe("synthetic sentinel");
  });

  it("refuses hardlinked database files before modifying them", async () => {
    const { project, outside } = await fixture();
    await mkdir(path.join(project, ".lmti/memory"), { recursive: true, mode: 0o700 });
    const target = path.join(outside, "store.sqlite");
    await writeFile(target, "synthetic sentinel", { mode: 0o600 });
    await link(target, path.join(project, ".lmti/memory/project-memory.sqlite"));
    await expect(initProjectMemoryStorage(project)).rejects.toThrow("MEMORY_SOURCE_BOUNDARY_DENIED");
    expect(await readFile(target, "utf8")).toBe("synthetic sentinel");
  });

  it("checks SQLite sidecars before creating the main database", async () => {
    const { project, outside } = await fixture();
    await mkdir(path.join(project, ".lmti/memory"), { recursive: true, mode: 0o700 });
    await directoryLink(outside, path.join(project, ".lmti/memory/project-memory.sqlite-wal"));
    await expect(initProjectMemoryStorage(project)).rejects.toThrow("MEMORY_SOURCE_BOUNDARY_DENIED");
    await expect(lstat(path.join(project, ".lmti/memory/project-memory.sqlite"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(outside)).toEqual([]);
  });

  it("checks legacy JSON and event paths again immediately before a write", async () => {
    const { project, outside } = await fixture();
    await initAtlasStorage(project);
    await rename(path.join(project, ".lmti/logs"), path.join(project, ".lmti/previous-logs"));
    await directoryLink(outside, path.join(project, ".lmti/logs"));
    await expect(writeMemoryFile(project, ".lmti/logs/events.log", "synthetic event", "append")).rejects.toThrow("MEMORY_SOURCE_BOUNDARY_DENIED");
    expect(await readdir(outside)).toEqual([]);
  });

  it("preserves a project-root alias and creates new private stores normally", async () => {
    const { root, project } = await fixture();
    const alias = path.join(root, "project-alias");
    await directoryLink(project, alias);
    const item = await addProjectMemory(sample, { cwd: alias });
    expect((await readProjectMemoryRecords(project, "fixture"))?.records.map(row => row.id)).toContain(item.id);
    await createMemory(legacy, { cwd: alias });
    expect(JSON.parse(await readFile(path.join(project, ".lmti/memory/long-term.json"), "utf8"))).toHaveLength(1);
  });

  it("detects an ancestor replacement between validation and use", async () => {
    const { project } = await fixture();
    await initProjectMemoryStorage(project);
    const prepared = await checkedStoragePath(project, ".lmti/memory/project-memory.sqlite", { kind: "file", private: true });
    await rename(path.join(project, ".lmti/memory"), path.join(project, ".lmti/previous-memory"));
    await mkdir(path.join(project, ".lmti/memory"), { mode: 0o700 });
    await expect(prepared.recheck()).rejects.toThrow("MEMORY_SOURCE_CHANGED_DURING_ACCESS");
    expect(await readdir(path.join(project, ".lmti/memory"))).toEqual([]);
  });
});

describe.skipIf(process.platform === "win32")("POSIX private memory modes", () => {
  it("creates owner-only SQLite, JSON, logs and SQLite sidecars", async () => {
    const { project } = await fixture();
    await createMemory(legacy, { cwd: project });
    await addProjectMemory(sample, { cwd: project });
    for (const relative of [".lmti", ".lmti/memory", ".lmti/logs", ".lmti/events"]) {
      expect((await stat(path.join(project, relative))).mode & 0o777).toBe(0o700);
    }
    for (const relative of [".lmti/memory/project-memory.sqlite", ".lmti/memory/long-term.json", ".lmti/memory/events.jsonl"]) {
      expect((await stat(path.join(project, relative))).mode & 0o777).toBe(0o600);
    }
    const database = path.join(project, ".lmti/memory/project-memory.sqlite");
    const held = new DatabaseSync(database);
    try {
      held.prepare("SELECT COUNT(*) FROM memory_items").get();
      await addProjectMemory(sample, { cwd: project });
      for (const suffix of ["-wal", "-shm"]) expect((await stat(database + suffix)).mode & 0o777).toBe(0o600);
    } finally { held.close(); }
  });

  it("refuses broad existing modes without chmod or content changes", async () => {
    const { project } = await fixture();
    await initProjectMemoryStorage(project);
    const database = path.join(project, ".lmti/memory/project-memory.sqlite");
    const bytes = await readFile(database);
    await chmod(database, 0o644);
    await expect(addProjectMemory(sample, { cwd: project })).rejects.toThrow("MEMORY_STORAGE_PERMISSIONS_UNSAFE");
    expect(await readFile(database)).toEqual(bytes);
    expect((await stat(database)).mode & 0o777).toBe(0o644);
    await chmod(database, 0o600);
    await chmod(path.join(project, ".lmti"), 0o755);
    await expect(createMemory(legacy, { cwd: project })).rejects.toThrow("MEMORY_STORAGE_PERMISSIONS_UNSAFE");
    expect((await stat(path.join(project, ".lmti"))).mode & 0o777).toBe(0o755);
  });
});
