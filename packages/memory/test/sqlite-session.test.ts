import { chmod, copyFile, link, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addProjectMemory, createShortMemoryNote, deleteProjectMemory, initProjectMemoryStorage, readProjectMemorySnapshot } from "../src/index";
import { checkedSqliteTarget } from "../src/storage-boundary";

const probe = vi.hoisted(() => ({ opens: 0, closes: 0, sql: [] as string[], failMigration: false }));
vi.mock("node:sqlite", async () => {
  const actual = await vi.importActual<typeof import("node:sqlite")>("node:sqlite");
  return {
    ...actual,
    DatabaseSync: class extends actual.DatabaseSync {
      constructor(...args: ConstructorParameters<typeof actual.DatabaseSync>) { super(...args); probe.opens++; }
      override exec(sql: string) {
        probe.sql.push(sql);
        const result = super.exec(sql);
        if (probe.failMigration && sql.includes("CREATE TABLE IF NOT EXISTS memory_migrations")) throw new Error("synthetic migration failure");
        return result;
      }
      override prepare(sql: string) { probe.sql.push(sql); return super.prepare(sql); }
      override close() { probe.closes++; return super.close(); }
    }
  };
});

const sample = { title: "Session fixture", content: "Synthetic memory session validation", privacyLevel: "internal" as const };
const dbName = "project-memory.sqlite";
const fixtures: Array<{ project: string; parent: string; dev: bigint; ino: bigint }> = [];
async function fixture() {
  const parent = await realpath(os.tmpdir());
  const project = await mkdtemp(path.join(parent, "lmti-memory-session-"));
  const info = await lstat(project, { bigint: true });
  fixtures.push({ project, parent, dev: info.dev, ino: info.ino });
  return { project, database: path.join(project, ".lmti/memory", dbName) };
}
function resetProbe() { probe.opens = 0; probe.closes = 0; probe.sql = []; probe.failMigration = false; }
afterEach(async () => {
  resetProbe();
  for (const fixture of fixtures.splice(0)) {
    const info = await lstat(fixture.project, { bigint: true });
    // Delete only this test's exact, unchanged temporary root; never a replaced link.
    if (path.dirname(fixture.project) !== fixture.parent || !path.basename(fixture.project).startsWith("lmti-memory-session-") ||
        info.isSymbolicLink() || !info.isDirectory() || info.dev !== fixture.dev || info.ino !== fixture.ino ||
        await realpath(fixture.project) !== fixture.project) throw new Error("Unsafe test fixture cleanup target");
    await rm(fixture.project, { recursive: true });
  }
});

describe("SQLite operation initialization", () => {
  it("creates a current schema and performs a write with exactly one connection", async () => {
    const { project, database } = await fixture();
    resetProbe();
    const item = await addProjectMemory(sample, { cwd: project });
    expect(probe.opens).toBe(1);
    expect(probe.closes).toBe(1);
    const db = new DatabaseSync(database, { readOnly: true });
    try {
      expect(db.prepare("SELECT version FROM memory_migrations ORDER BY version").all().map(row => row.version)).toEqual([1, 2, 3, 4]);
      expect(db.prepare("SELECT id, length(content_hash) AS hashLength FROM memory_items").get()).toMatchObject({ id: item.id, hashLength: 64 });
      expect(db.prepare("PRAGMA integrity_check").get()).toMatchObject({ integrity_check: "ok" });
    } finally { db.close(); }
  });

  it("does not rescan data or repeat schema DDL when version 4 is already installed", async () => {
    const { project } = await fixture();
    await addProjectMemory(sample, { cwd: project });
    resetProbe();
    await addProjectMemory({ ...sample, title: "Second fixture" }, { cwd: project });
    expect(probe.opens).toBe(1);
    expect(probe.closes).toBe(1);
    expect(probe.sql.join("\n")).not.toMatch(/CREATE (TABLE|INDEX|TRIGGER|VIRTUAL)|ALTER TABLE|PRAGMA table_info|WHERE content_hash = ''/i);
    expect((await readProjectMemorySnapshot(project)).memories).toHaveLength(2);
  });

  it("backfills old version 2 rows once and preserves the existing memory and short note", async () => {
    const { project, database } = await fixture();
    const item = await addProjectMemory(sample, { cwd: project });
    const short = await createShortMemoryNote({ title: "Short fixture", content: "Synthetic short memory" }, { cwd: project });
    const old = new DatabaseSync(database);
    try {
      old.exec("DELETE FROM memory_migrations WHERE version >= 3; ALTER TABLE memory_items DROP COLUMN content_hash; ALTER TABLE short_memory_notes DROP COLUMN content_hash;");
    } finally { old.close(); }
    resetProbe();
    await initProjectMemoryStorage(project);
    expect(probe.opens).toBe(1);
    expect(probe.closes).toBe(1);
    const migrated = new DatabaseSync(database, { readOnly: true });
    try {
      expect(migrated.prepare("SELECT id, length(content_hash) AS hashLength FROM memory_items").get()).toMatchObject({ id: item.id, hashLength: 64 });
      expect(migrated.prepare("SELECT id, length(content_hash) AS hashLength FROM short_memory_notes").get()).toMatchObject({ id: short.id, hashLength: 64 });
      expect(migrated.prepare("SELECT MAX(version) AS version FROM memory_migrations").get()).toMatchObject({ version: 4 });
    } finally { migrated.close(); }
    resetProbe();
    await initProjectMemoryStorage(project);
    expect(probe.sql.join("\n")).not.toContain("WHERE content_hash = ''");
  });

  it("upgrades version 3 lesson tables without running the completed hash backfill", async () => {
    const { project, database } = await fixture();
    await initProjectMemoryStorage(project);
    const old = new DatabaseSync(database);
    try { old.exec("DELETE FROM memory_migrations WHERE version = 4; DROP TABLE lesson_candidates; DROP TABLE task_observations;"); }
    finally { old.close(); }
    resetProbe();
    await initProjectMemoryStorage(project);
    expect(probe.sql.join("\n")).not.toContain("WHERE content_hash = ''");
    const db = new DatabaseSync(database, { readOnly: true });
    try {
      expect(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('lesson_candidates', 'task_observations') ORDER BY name").all().map(row => row.name)).toEqual(["lesson_candidates", "task_observations"]);
    } finally { db.close(); }
  });

  it("refuses future schema versions before persistent SQL or row changes", async () => {
    const { project, database } = await fixture();
    await initProjectMemoryStorage(project);
    const future = new DatabaseSync(database);
    try { future.exec("INSERT INTO memory_migrations VALUES (999, 'synthetic future', '2026-10-22')"); }
    finally { future.close(); }
    const before = await readFile(database);
    resetProbe();
    await expect(addProjectMemory(sample, { cwd: project })).rejects.toThrow("MEMORY_SCHEMA_UNSUPPORTED");
    expect(probe.opens).toBe(1);
    expect(probe.closes).toBe(1);
    expect(probe.sql.join("\n")).not.toMatch(/journal_mode|CREATE |INSERT |UPDATE /);
    expect(await readFile(database)).toEqual(before);
  });

  it("rolls back failed initialization, closes its connection, and can retry", async () => {
    const { project, database } = await fixture();
    resetProbe(); probe.failMigration = true;
    await expect(initProjectMemoryStorage(project)).rejects.toThrow("synthetic migration failure");
    expect(probe.opens).toBe(1);
    expect(probe.closes).toBe(1);
    const db = new DatabaseSync(database, { readOnly: true });
    try { expect(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all()).toEqual([]); }
    finally { db.close(); }
    resetProbe();
    await initProjectMemoryStorage(project);
    expect((await readProjectMemorySnapshot(project)).memories).toEqual([]);
  });

  it("retains foreign-key cleanup on the connection used for deletion", async () => {
    const { project, database } = await fixture();
    const item = await addProjectMemory(sample, { cwd: project });
    expect(await deleteProjectMemory(item.id, { cwd: project })).toBe(true);
    const db = new DatabaseSync(database, { readOnly: true });
    try {
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(db.prepare("SELECT memory_id FROM memory_events").all().every(row => row.memory_id === null)).toBe(true);
    } finally { db.close(); }
  });
});

describe("operation-local SQLite path checks", () => {
  for (const target of ["database", "parent"] as const) {
    it(`refuses a replaced ${target} after context preparation`, async () => {
      const { project, database } = await fixture();
      await initProjectMemoryStorage(project);
      const prepared = await checkedSqliteTarget(project, dbName, false);
      if (target === "database") {
        await rename(database, database + ".original");
        await copyFile(database + ".original", database);
      } else {
        await rename(path.dirname(database), path.dirname(database) + "-original");
        await mkdir(path.dirname(database), { mode: 0o700 });
        await writeFile(database, "replacement fixture", { mode: 0o600 });
      }
      await expect(prepared.recheck()).rejects.toThrow("MEMORY_SOURCE_CHANGED_DURING_ACCESS");
    });
  }

  for (const suffix of ["-wal", "-shm", "-journal"]) {
    it(`refuses a new hardlinked ${suffix} sidecar after context preparation`, async () => {
      const { project, database } = await fixture();
      await initProjectMemoryStorage(project);
      const prepared = await checkedSqliteTarget(project, dbName, false);
      const outside = path.join(project, "sentinel");
      await writeFile(outside, "synthetic sentinel", { mode: 0o600 });
      await link(outside, database + suffix);
      await expect(prepared.recheck()).rejects.toThrow("MEMORY_SOURCE_BOUNDARY_DENIED");
      expect(await readFile(outside, "utf8")).toBe("synthetic sentinel");
    });
  }

  it("accepts legitimate private sidecar recreation without trusting stale sidecar identities", async () => {
    const { project, database } = await fixture();
    await initProjectMemoryStorage(project);
    const prepared = await checkedSqliteTarget(project, dbName, false);
    await writeFile(database + "-wal", "first synthetic sidecar", { mode: 0o600 });
    await prepared.recheck();
    await unlink(database + "-wal");
    await writeFile(database + "-wal", "replacement synthetic sidecar", { mode: 0o600 });
    await prepared.recheck();
  });

  it.skipIf(process.platform === "win32")("rechecks main and sidecar private modes on every use", async () => {
    const { project, database } = await fixture();
    await initProjectMemoryStorage(project);
    const prepared = await checkedSqliteTarget(project, dbName, false);
    await chmod(database, 0o644);
    await expect(prepared.recheck()).rejects.toThrow("MEMORY_STORAGE_PERMISSIONS_UNSAFE");
    expect((await stat(database)).mode & 0o777).toBe(0o644);
    await chmod(database, 0o600);
    await writeFile(database + "-shm", "synthetic sidecar", { mode: 0o644 });
    await chmod(database + "-shm", 0o644);
    await expect(prepared.recheck()).rejects.toThrow("MEMORY_STORAGE_PERMISSIONS_UNSAFE");
  });
});
