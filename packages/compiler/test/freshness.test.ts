import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkCompiledAmfFreshness, compileProject } from "../src/index";

async function fixture(): Promise<string> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lmti-freshness-")));
  await fs.writeFile(path.join(root, "source.ts"), "export const value = 1;\n");
  return root;
}

afterEach(() => vi.restoreAllMocks());

describe("compiled source freshness", () => {
  it("detects content changes even when size and mtime are unchanged without overwriting artifacts", async () => {
    const root = await fixture();
    const source = path.join(root, "source.ts");
    const amf = await compileProject(root);
    const before = JSON.stringify(amf);
    const stat = await fs.stat(source);
    await fs.mkdir(path.join(root, ".lmti"));
    await fs.writeFile(path.join(root, ".lmti", "project.amf.json"), before);
    expect((await checkCompiledAmfFreshness(amf, { cwd: root })).status).toBe("fresh");

    await fs.writeFile(source, "export const value = 2;\n");
    await fs.utimes(source, stat.atime, stat.mtime);
    const result = await checkCompiledAmfFreshness(amf, { cwd: root });
    expect(result.status).toBe("stale");
    expect(result.reasons).toContain("source_content_changed");
    expect(JSON.stringify(amf)).toBe(before);
    expect(await fs.readFile(path.join(root, ".lmti", "project.amf.json"), "utf8")).toBe(before);
  });

  it.each(["add", "delete", "rename"])("detects source inventory %s", async (operation) => {
    const root = await fixture();
    const amf = await compileProject(root);
    if (operation === "add") await fs.writeFile(path.join(root, "new.ts"), "export const extra = 1;");
    if (operation === "delete") await fs.unlink(path.join(root, "source.ts"));
    if (operation === "rename") await fs.rename(path.join(root, "source.ts"), path.join(root, "renamed.ts"));
    const result = await checkCompiledAmfFreshness(amf, { cwd: root });
    expect(result.status).toBe("stale");
    expect(result.reasons).toContain("source_inventory_changed");
  });

  it("detects changed ignore rules even when source membership is unchanged", async () => {
    const root = await fixture();
    const amf = await compileProject(root);
    await fs.writeFile(path.join(root, ".lmtiignore"), "future-directory/\n");
    const result = await checkCompiledAmfFreshness(amf, { cwd: root });
    expect(result.status).toBe("stale");
    expect(result.reasons).toContain("source_boundary_changed");
  });

  it("keeps ignored secret and generated content outside freshness scope", async () => {
    const root = await fixture();
    const amf = await compileProject(root);
    await fs.writeFile(path.join(root, ".env"), "SYNTHETIC_FIXTURE_ONLY=ignored");
    await fs.mkdir(path.join(root, "node_modules"));
    await fs.writeFile(path.join(root, "node_modules", "generated.ts"), "ignored");
    const result = await checkCompiledAmfFreshness(amf, { cwd: root, now: new Date("2026-10-12T00:00:00Z") });
    expect(result).toMatchObject({ status: "fresh", checkedAt: "2026-10-12T00:00:00.000Z", scope: "compiler-source-boundary", reasons: [], checkedFileCount: 1 });
    expect(JSON.stringify(result)).not.toContain(root);
    expect(JSON.stringify(result)).not.toContain("source.ts");
  });

  it("detects compiler or explicitly changed size boundary", async () => {
    const root = await fixture();
    const amf = await compileProject(root);
    const oldCompiler = structuredClone(amf);
    oldCompiler.project.compiler.version = "unknown-old-version";
    expect(await checkCompiledAmfFreshness(oldCompiler, { cwd: root })).toMatchObject({ status: "stale", reasons: ["compiler_changed"] });
    expect(await checkCompiledAmfFreshness(amf, { cwd: root, maxFileBytes: 4 })).toMatchObject({ status: "stale", reasons: ["source_boundary_changed"] });
  });

  it.each(["unsupported", "oversized", "binary"])("does not call %s content fresh when compiler only hashed path and size", async (kind) => {
    const root = await fixture();
    if (kind === "unsupported") await fs.writeFile(path.join(root, "data.unknown"), "AAAA");
    if (kind === "oversized") await fs.writeFile(path.join(root, "large.ts"), "a".repeat(40));
    if (kind === "binary") await fs.writeFile(path.join(root, "data.ts"), "a\u0000b");
    const amf = await compileProject(root, kind === "oversized" ? { maxFileBytes: 30 } : {});
    const result = await checkCompiledAmfFreshness(amf, { cwd: root });
    expect(result.status).toBe("unknown");
    expect(result.reasons).toContain("source_not_fully_hashed");
  });

  it.each([{ maxFiles: 1 }, { maxTotalBytes: 2 }])("returns unknown when the scan budget is exhausted: %j", async (budget) => {
    const root = await fixture();
    await fs.writeFile(path.join(root, "second.ts"), "export const another = 1;");
    const amf = await compileProject(root);
    expect(await checkCompiledAmfFreshness(amf, { cwd: root, ...budget })).toMatchObject({ status: "unknown", reasons: ["scan_budget_exceeded"] });
  });

  it("reports unreadable sources without exposing a filename or OS error", async () => {
    const root = await fixture();
    const amf = await compileProject(root);
    const readFile = fs.readFile.bind(fs);
    vi.spyOn(fs, "readFile").mockImplementation(((file: string, ...args: unknown[]) => {
      if (String(file) === path.join(root, "source.ts")) {
        return Promise.reject(Object.assign(new Error("sensitive source denied"), { code: "EACCES" }));
      }
      return (readFile as (...params: unknown[]) => Promise<unknown>)(file, ...args);
    }) as typeof fs.readFile);
    const result = await checkCompiledAmfFreshness(amf, { cwd: root });
    expect(result).toMatchObject({ status: "unknown", reasons: ["source_unreadable"] });
    expect(JSON.stringify(result)).not.toContain("sensitive");
  });

  it("checks compiled subdirectories within the authorized checkout", async () => {
    const root = await fixture();
    await fs.mkdir(path.join(root, "child"));
    await fs.writeFile(path.join(root, "child", "nested.ts"), "export const child = 1;");
    const amf = await compileProject("child", { cwd: root });
    expect((await checkCompiledAmfFreshness(amf, { cwd: root })).status).toBe("fresh");
  });

  it("does not read an artifact-selected root outside the authorized checkout", async () => {
    const root = await fixture();
    const outside = await fixture();
    const amf = await compileProject(outside);
    const readFile = vi.spyOn(fs, "readFile");
    expect(await checkCompiledAmfFreshness(amf, { cwd: root })).toMatchObject({ status: "unknown", reasons: ["source_root_not_authorized"] });
    expect(readFile).not.toHaveBeenCalled();
  });

  it("rejects an ignore-file path that escapes the authorized root without reading it", async () => {
    const root = await fixture();
    const amf = await compileProject(root);
    const readFile = vi.spyOn(fs, "readFile");
    expect(await checkCompiledAmfFreshness(amf, { cwd: root, lmtiIgnoreFile: "../outside-ignore" })).toMatchObject({
      status: "unknown", reasons: ["source_root_not_authorized"]
    });
    expect(readFile).not.toHaveBeenCalled();
  });

  it("detects files added during enumeration even when directory timestamps do not change", async () => {
    const root = await fixture();
    const amf = await compileProject(root);
    const stat = fs.stat.bind(fs);
    const directoryStat = await stat(root);
    vi.spyOn(fs, "stat").mockImplementation((async (...args: unknown[]) => {
      if (String(args[0]) === root) return directoryStat;
      return (stat as (...params: unknown[]) => Promise<unknown>)(...args);
    }) as typeof fs.stat);
    const readdir = fs.readdir.bind(fs);
    let added = false;
    vi.spyOn(fs, "readdir").mockImplementation((async (...args: unknown[]) => {
      const entries = await (readdir as (...params: unknown[]) => Promise<unknown>)(...args);
      if (!added && String(args[0]) === root) {
        added = true;
        await fs.writeFile(path.join(root, "added-during-scan.ts"), "export const later = true;");
      }
      return entries;
    }) as typeof fs.readdir);
    const result = await checkCompiledAmfFreshness(amf, { cwd: root });
    expect(added).toBe(true);
    expect(result).toMatchObject({
      status: "unknown", reasons: ["source_changed_during_check"]
    });
  });

  it("does not treat a malformed compiled marker as verified", async () => {
    const root = await fixture();
    const amf = await compileProject(root);
    amf.project.checksum = "not-a-checksum";
    expect(await checkCompiledAmfFreshness(amf, { cwd: root })).toMatchObject({ status: "unknown", reasons: ["compiled_metadata_invalid"] });
  });
});
