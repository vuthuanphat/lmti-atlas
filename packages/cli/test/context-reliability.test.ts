import { mkdtemp, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { addProjectMemory, createMemory } from "@atlas/memory";
import { compileCommand, contextCommand, preflightCommand } from "../src/index";

async function fixture() {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "lmti-context-reliability-"));
  await mkdir(path.join(cwd, "src"));
  await writeFile(path.join(cwd, "package.json"), JSON.stringify({ name: "impact-fixture" }));
  await writeFile(path.join(cwd, "src", "packing.ts"), 'export const label = "A";\n');
  await compileCommand(cwd);
  return cwd;
}

describe("context reliability regressions", () => {
  it("does not migrate legacy storage implicitly when context or preflight is requested", async () => {
    const cwd = await fixture();
    await rename(path.join(cwd, ".lmti"), path.join(cwd, ".atlas"));
    const legacy = await readFile(path.join(cwd, ".atlas", "project.amf.json"));
    await expect(contextCommand(cwd, "packing label")).rejects.toThrow("Run `lmti compile` first");
    await expect(preflightCommand(cwd, "packing label")).rejects.toThrow("Run `lmti compile` first");
    await expect(stat(path.join(cwd, ".lmti"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(cwd, ".atlas", "project.amf.json"))).toEqual(legacy);
  });

  it("warns about source changes in context AND the actual preflight payload without rewriting AMF", async () => {
    const cwd = await fixture();
    const amfPath = path.join(cwd, ".lmti", "project.amf.json");
    const before = await readFile(amfPath);
    await writeFile(path.join(cwd, "src", "packing.ts"), 'export const label = "B";\n');
    const context = await contextCommand(cwd, "change packing label");
    expect(context.source).toMatchObject({ freshness: { status: "stale" } });
    expect(context.recommendedSteps.join(" ")).toMatch(/recompile|compile/i);
    const preflight = await preflightCommand(cwd, "change packing label");
    expect(preflight).toMatchObject({ sourceFreshness: { status: "stale" } });
    expect(preflight.finalContextPackage.messages.map((message) => message.content).join(" ")).toContain('"status": "stale"');
    expect(await readFile(amfPath)).toEqual(before);
  });

  it("uses SQLite memory consistently in context and preflight", async () => {
    const cwd = await fixture();
    const memory = await addProjectMemory({
      title: "Packing label destination rule", content: "Packing label destination must be verified before warehouse dispatch.",
      source: "synthetic-manifest", privacyLevel: "public", importance: 0.9
    }, { cwd });
    const context = await contextCommand(cwd, "packing label destination");
    expect(context.relatedLongTermMemories.map((entry) => entry.id)).toContain(memory.id);
    const preflight = await preflightCommand(cwd, "packing label destination");
    expect(preflight.selectedMemories.map((entry) => entry.metadata.id)).toContain(memory.id);
  });

  it("ranks the relevant seventeenth candidate before taking the preflight limit", async () => {
    const cwd = await fixture();
    for (let index = 0; index < 17; index++) {
      await createMemory({
        scope: "long_term", kind: "rule", title: `Unrelated typography ${index}`,
        content: "Typography spacing note.", projectId: "impact-fixture", sourceRefs: [],
        tags: ["typography"], importance: 0.5, confidence: "high", sensitivity: "public", promptPolicy: "allow_raw"
      }, { cwd });
    }
    const target = await createMemory({
      scope: "long_term", kind: "rule", title: "Packing label destination validation",
      content: "Packing label destination validation requires warehouse dispatch verification.",
      projectId: "impact-fixture", sourceRefs: ["src/packing.ts"], tags: ["packing", "label", "destination"],
      importance: 0.9, confidence: "high", sensitivity: "public", promptPolicy: "allow_raw"
    }, { cwd });
    const result = await preflightCommand(cwd, "packing label destination validation");
    expect(result.selectedMemories.map((entry) => entry.metadata.id)).toContain(target.id);
    expect(result.selectedMemories.length).toBeLessThanOrEqual(16);
  });
});
