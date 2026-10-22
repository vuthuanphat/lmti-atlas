import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, symlink, writeFile } from "node:fs/promises";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { doctorLmti, migrateAtlasToLmti, normalizeLmtiConfig } from "../src/index.js";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "lmti-migration-boundary-"));
  const project = path.join(root, "project"), outside = path.join(root, "outside");
  await mkdir(project, { mode: 0o700 }); await mkdir(outside, { mode: 0o700 });
  return { root, project, outside };
}

describe("canonical migration write boundary", () => {
  for (const relative of [".lmti", ".lmti/memory", ".lmti/logs"]) {
    it(`refuses doctor and migration through a linked ${relative}`, async () => {
      const {project, outside} = await fixture();
      await mkdir(path.dirname(path.join(project, relative)), { recursive: true, mode: 0o700 });
      await symlink(outside, path.join(project, relative), process.platform === "win32" ? "junction" : "dir");
      await expect(doctorLmti(project, { fix: true })).rejects.toThrow("MIGRATION_STORAGE_BOUNDARY_DENIED");
      await mkdir(path.join(project, ".atlas"), { mode: 0o700 });
      await writeFile(path.join(project, ".atlas/config.json"), "{}", { mode: 0o600 });
      await expect(migrateAtlasToLmti(project)).rejects.toThrow("MIGRATION_STORAGE_BOUNDARY_DENIED");
      expect(await readdir(outside)).toEqual([]);
    });
  }

  it("refuses hardlinked config and memory files without modifying the other name", async () => {
    for (const relative of [".lmti/config.json", ".lmti/memory/long-term.json"]) {
      const {project, outside} = await fixture();
      await mkdir(path.dirname(path.join(project, relative)), { recursive: true, mode: 0o700 });
      const target = path.join(outside, "sentinel.json");
      await writeFile(target, "{\"fixture\":true}", { mode: 0o600 });
      await link(target, path.join(project, relative));
      await expect(doctorLmti(project, { fix: true })).rejects.toThrow("MIGRATION_STORAGE_BOUNDARY_DENIED");
      expect(await readFile(target, "utf8")).toBe("{\"fixture\":true}");
    }
  });

  it("supports a project-root alias without following inner links", async () => {
    const {root, project} = await fixture();
    const alias = path.join(root, "alias");
    await symlink(project, alias, process.platform === "win32" ? "junction" : "dir");
    await doctorLmti(alias, { fix: true });
    expect(JSON.parse(await readFile(path.join(project, ".lmti/memory/long-term.json"), "utf8"))).toEqual([]);
  });

  it("does not normalize a config after an I/O failure or identity replacement", async () => {
    for (const replace of [false, true]) {
      const {project} = await fixture();
      await normalizeLmtiConfig(project);
      const config = path.join(project, ".lmti/config.json"), before = await readFile(config, "utf8");
      const read = vi.spyOn(fs, "readFile").mockImplementationOnce(async () => {
        if (!replace) throw Object.assign(new Error("controlled I/O failure"), {code: "EIO"});
        await rename(config, config + ".old");
        await writeFile(config, "{\"sentinel\":true}", {mode: 0o600});
        return before;
      });
      try {
        await expect(normalizeLmtiConfig(project)).rejects.toThrow(replace ? "MIGRATION_STORAGE_BOUNDARY_DENIED" : "controlled I/O failure");
      } finally { read.mockRestore(); }
      expect(await readFile(config, "utf8")).toBe(replace ? "{\"sentinel\":true}" : before);
    }
  });

  it.skipIf(process.platform === "win32")("creates private stores and refuses existing broad modes without chmod", async () => {
    const {project} = await fixture();
    await doctorLmti(project, { fix: true });
    for (const relative of [".lmti", ".lmti/memory", ".lmti/logs", ".lmti/experiments"]) {
      expect((await lstat(path.join(project, relative))).mode & 0o777).toBe(0o700);
    }
    for (const relative of [".lmti/config.json", ".lmti/project.amf.json", ".lmti/memory/long-term.json"]) {
      expect((await lstat(path.join(project, relative))).mode & 0o777).toBe(0o600);
    }
    const config = path.join(project, ".lmti/config.json"), before = await readFile(config);
    await chmod(config, 0o644);
    await expect(normalizeLmtiConfig(project)).rejects.toThrow("MIGRATION_STORAGE_PERMISSIONS_UNSAFE");
    expect(await readFile(config)).toEqual(before);
    expect((await lstat(config)).mode & 0o777).toBe(0o644);
  });
});
