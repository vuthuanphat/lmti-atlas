import { mkdtemp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AMF_VERSION, createEmptyAmf, type AmfDocument } from "@atlas/types";
import { detectLegacyAtlasStorage, doctorLmti, migrateAtlasToLmti } from "../src/index";

async function createWorkspace(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "lmti-migration-"));
}

function legacyAmf(name: string): AmfDocument {
  return createEmptyAmf({
    name,
    root: `/legacy/${name}`,
    compiledAt: "2026-06-28T00:00:00.000Z",
    atlasVersion: "0.0.0",
    amfVersion: AMF_VERSION,
    compiler: {
      name: "Legacy Atlas compiler",
      version: "0.0.1"
    },
    sourceBoundary: {
      root: `/legacy/${name}`,
      ignoredDirectories: [".git"],
      ignoredFiles: [],
      maxFileBytes: 1024
    },
    checksum: `legacy-${name}`
  });
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
}

describe("Atlas to LMTI migration", () => {
  it("migrates old .atlas storage into .lmti when canonical storage is missing", async () => {
    const cwd = await createWorkspace();
    await mkdir(path.join(cwd, ".atlas"), { recursive: true });
    await writeJson(path.join(cwd, ".atlas", "project.amf.json"), legacyAmf("legacy-project"));

    const result = await migrateAtlasToLmti(cwd, { now: new Date("2026-06-28T12:34:56.000Z") });

    expect(result.status).toBe("migrated");
    expect(result.selectedLegacyAmf).toBe(".atlas/project.amf.json");
    const migrated = JSON.parse(await readFile(path.join(cwd, ".lmti", "project.amf.json"), "utf8")) as AmfDocument;
    expect(migrated.project.name).toBe("legacy-project");
    const config = JSON.parse(await readFile(path.join(cwd, ".lmti", "config.json"), "utf8")) as Record<string, unknown>;
    expect(config.migratedFrom).toBe("atlas");
    expect(config.legacyDetected).toBe(true);
    await expect(stat(path.join(cwd, ".lmti", "logs", "migration-20260628-123456.json"))).resolves.toBeTruthy();
  });

  it("prefers existing .lmti state when legacy and canonical storage both exist", async () => {
    const cwd = await createWorkspace();
    await mkdir(path.join(cwd, ".atlas"), { recursive: true });
    await mkdir(path.join(cwd, ".lmti"), { recursive: true, mode: 0o700 });
    await writeJson(path.join(cwd, ".atlas", "project.amf.json"), legacyAmf("legacy-project"));
    await writeJson(path.join(cwd, ".lmti", "project.amf.json"), legacyAmf("canonical-project"));

    const result = await migrateAtlasToLmti(cwd, { now: new Date("2026-06-28T12:35:56.000Z") });

    expect(result.status).toBe("already-canonical");
    expect(result.warnings.join("\n")).toContain("already exists");
    const canonical = JSON.parse(await readFile(path.join(cwd, ".lmti", "project.amf.json"), "utf8")) as AmfDocument;
    expect(canonical.project.name).toBe("canonical-project");
  });

  it("migrates legacy project.amf.json from the project root", async () => {
    const cwd = await createWorkspace();
    await writeJson(path.join(cwd, "project.amf.json"), legacyAmf("root-legacy"));

    await migrateAtlasToLmti(cwd);

    const migrated = JSON.parse(await readFile(path.join(cwd, ".lmti", "project.amf.json"), "utf8")) as AmfDocument;
    expect(migrated.project.name).toBe("root-legacy");
  });

  it("doctor detects duplicate state and conflicting AMF files", async () => {
    const cwd = await createWorkspace();
    await mkdir(path.join(cwd, ".atlas"), { recursive: true });
    await mkdir(path.join(cwd, ".lmti"), { recursive: true });
    await mkdir(path.join(cwd, ".lmti", "memory"), { recursive: true });
    await mkdir(path.join(cwd, ".lmti", "logs"), { recursive: true });
    await mkdir(path.join(cwd, ".lmti", "experiments"), { recursive: true });
    await writeJson(path.join(cwd, ".atlas", "project.amf.json"), legacyAmf("legacy-project"));
    await writeJson(path.join(cwd, ".lmti", "project.amf.json"), legacyAmf("canonical-project"));
    await writeJson(path.join(cwd, ".lmti", "config.json"), {
      version: "0.1.0",
      kernel: "atlas",
      projectName: "canonical-project"
    });

    const report = await doctorLmti(cwd);

    expect(report.status).toBe("warning");
    expect(report.problems.map((problem) => problem.id)).toContain("duplicate-atlas-lmti-state");
    expect(report.problems.map((problem) => problem.id)).toContain("conflicting-amf-files");
  });

  it("doctor --fix creates canonical storage and migrates when safe", async () => {
    const cwd = await createWorkspace();
    await mkdir(path.join(cwd, ".atlas"), { recursive: true });
    await writeJson(path.join(cwd, ".atlas", "project.amf.json"), legacyAmf("safe-legacy"));

    const report = await doctorLmti(cwd, { fix: true, now: new Date("2026-06-28T12:36:56.000Z") });

    expect(report.changes.some((change) => change.includes("project.amf.json"))).toBe(true);
    const migrated = JSON.parse(await readFile(path.join(cwd, ".lmti", "project.amf.json"), "utf8")) as AmfDocument;
    expect(migrated.project.name).toBe("safe-legacy");
    await expect(readFile(path.join(cwd, ".lmti", "config.json"), "utf8")).resolves.toContain("\"migratedFrom\": \"atlas\"");
  });

  it("migration never deletes legacy files", async () => {
    const cwd = await createWorkspace();
    await mkdir(path.join(cwd, ".atlas"), { recursive: true });
    await writeJson(path.join(cwd, ".atlas", "project.amf.json"), legacyAmf("kept-legacy"));

    await migrateAtlasToLmti(cwd);

    await expect(stat(path.join(cwd, ".atlas", "project.amf.json"))).resolves.toBeTruthy();
    expect(await readdir(path.join(cwd, ".atlas"))).toContain("project.amf.json");
    const scan = await detectLegacyAtlasStorage(cwd);
    expect(scan.hasLegacy).toBe(true);
  });
});
