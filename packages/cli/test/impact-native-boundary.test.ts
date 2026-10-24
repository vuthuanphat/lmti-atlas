import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, expect, it } from "vitest";
import { pinNativeSource, readNativeOwner, validateNativeSourceConfig } from "../src/impact-native";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "lmti-native-process-boundary-"));
  const executable = path.join(root, process.platform === "win32" ? "lmti-project.exe" : "lmti-project"), database = path.join(root, "project.sqlite");
  await writeFile(executable, "synthetic non-executable bytes"); await writeFile(database, "synthetic database placeholder");
  return { root, source: { executable, database, projectId: "project-one", site: "site-one", target: "external" as const, environmentId: "development" } };
}
describe("fixed native owner process capability", () => {
  it("requires canonical absolute paths and the fixed native executable basename", async () => {
    const { source } = await fixture();
    expect(() => validateNativeSourceConfig({ ...source, executableDigest: "a".repeat(64), executable: process.execPath })).toThrow("NATIVE_CONFIG_INVALID");
    await expect(pinNativeSource({ ...source, database: "relative.sqlite" })).rejects.toThrow("NATIVE_PATH_DENIED");
    expect(() => validateNativeSourceConfig({ ...source, executableDigest: "a".repeat(64), shell: true })).toThrow("NATIVE_CONFIG_INVALID");
  });
  it("pins executable bytes and rejects tampering before attempting a native process", async () => {
    const { source } = await fixture();
    const config = await pinNativeSource(source);
    expect(config.executableDigest).toMatch(/^[a-f0-9]{64}$/);
    await writeFile(source.executable, "replacement non-executable bytes");
    await expect(readNativeOwner(config)).rejects.toThrow("NATIVE_BINARY_CHANGED");
  });
  it("rejects native paths reached through junctions and protected trees", async () => {
    const { root, source } = await fixture(), outside = await mkdtemp(path.join(os.tmpdir(), "lmti-native-target-"));
    await writeFile(path.join(outside, "project.sqlite"), "fixture");
    const junction = path.join(root, "linked"); await symlink(outside, junction, process.platform === "win32" ? "junction" : "dir");
    await expect(pinNativeSource({ ...source, database: path.join(junction, "project.sqlite") })).rejects.toThrow("NATIVE_PATH_DENIED");
    const protectedRoot = path.join(root, ".lmti"); await mkdir(protectedRoot); await writeFile(path.join(protectedRoot, "project.sqlite"), "fixture");
    await expect(pinNativeSource({ ...source, database: path.join(protectedRoot, "project.sqlite") })).rejects.toThrow("NATIVE_PATH_DENIED");
  });
});
