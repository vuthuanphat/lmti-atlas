import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { compileProject } from "@atlas/compiler";
import { addProjectMemory, createMemory, writeAmfDocument } from "@atlas/memory";
import { createLmtiMcpStub } from "../src/server";

async function fixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lmti-mcp-context-"));
  await fs.writeFile(path.join(root, "packing.ts"), "export function packingLabel(): string { return 'A'; }\n");
  await writeAmfDocument(await compileProject(root), root);
  return root;
}

async function storageFingerprint(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  async function walk(directory: string): Promise<void> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) {
        // SQLite may create WAL coordination files even for readOnly:true. The
        // database and all application-owned records/events must stay unchanged.
        if (entry.name === "project-memory.sqlite-wal" || entry.name === "project-memory.sqlite-shm") continue;
        const stat = await fs.stat(file);
        files[path.relative(root, file)] = `${stat.mtimeMs}:${createHash("sha256").update(await fs.readFile(file)).digest("hex")}`;
      }
    }
  }
  await walk(path.join(root, ".lmti"));
  return files;
}

async function legacyMemory(root: string): Promise<void> {
  await createMemory({
    scope: "long_term", kind: "rule", title: "Legacy packing label rule",
    content: "Packing label validation must check the legacy format.", projectId: path.basename(root),
    sourceRefs: ["packing.ts"], tags: ["packing", "label"], importance: 0.9,
    confidence: "high", sensitivity: "public"
  }, { cwd: root });
}

describe("project-memory MCP handler boundary", () => {
  it("returns source freshness and a stale warning after a same-size source change", async () => {
    const root = await fixture();
    const server = createLmtiMcpStub({ cwd: root });
    const first = await server.lmti_get_project_context({ task: "packing label" });
    expect(first.source.freshness?.status).toBe("fresh");
    const source = path.join(root, "packing.ts");
    const stats = await fs.stat(source);
    await fs.writeFile(source, "export function packingLabel(): string { return 'B'; }\n");
    await fs.utimes(source, stats.atime, stats.mtime);
    const stale = await server.lmti_get_project_context({ task: "packing label" });
    expect(stale.source.freshness?.status).toBe("stale");
    expect(stale.source.freshness?.reasons).toContain("source_content_changed");
    expect(stale.recommendedSteps.some((step) => /stale or unverified/.test(step))).toBe(true);
    // A check does not silently regenerate the compiled source artifact.
    expect(stale.source.checksum).toBe(first.source.checksum);
  });

  it("fails closed for list-only related-files responses when context is stale or unverifiable", async () => {
    const root = await fixture();
    const server = createLmtiMcpStub({ cwd: root });
    expect((await server.lmti_get_related_files({ task: "packing label" })).some((file) => file.path === "packing.ts")).toBe(true);
    await fs.writeFile(path.join(root, "packing.ts"), "export function packingLabel(): string { return 'changed'; }\n");
    await expect(server.lmti_get_related_files({ task: "packing label" })).rejects.toThrow("COMPILED_CONTEXT_UNVERIFIED");
    await fs.writeFile(path.join(root, "unparsed.unknown"), "synthetic unsupported content");
    await writeAmfDocument(await compileProject(root), root);
    const context = await server.lmti_get_project_context({ task: "packing label" });
    expect(context.source.freshness?.status).toBe("unknown");
    await expect(server.lmti_get_related_files({ task: "packing label" })).rejects.toThrow("COMPILED_CONTEXT_UNVERIFIED");
  });

  it("reads the default SQLite owner in context and memory without silently merging legacy JSON", async () => {
    const root = await fixture();
    await legacyMemory(root);
    const added = await addProjectMemory({
      title: "SQLite packing label rule", content: "Packing label validation requires destination and package identity.",
      source: "packing.ts", sourceType: "synthetic-test", tags: ["packing", "label"],
      privacyLevel: "public", importance: 0.9, confidence: 0.9
    }, { cwd: root });
    const before = await storageFingerprint(root);
    const server = createLmtiMcpStub({ cwd: root });
    const context = await server.lmti_get_project_context({ task: "packing label validation" });
    const memories = await server.lmti_get_memory({ query: "packing label validation" });
    expect(context.memorySource?.source).toBe("sqlite");
    expect(context.relatedLongTermMemories.some((item) => item.id === added.id)).toBe(true);
    expect(memories.some((item) => item.record.id === added.id)).toBe(true);
    expect(JSON.stringify(context)).not.toContain("Legacy packing label rule");
    expect(JSON.stringify(memories)).not.toContain("Legacy packing label rule");
    expect(await storageFingerprint(root)).toEqual(before);
  });

  it("keeps legacy-only reads compatible and does not create a SQLite store or access events", async () => {
    const root = await fixture();
    await legacyMemory(root);
    const before = await storageFingerprint(root);
    const server = createLmtiMcpStub({ cwd: root });
    const context = await server.lmti_get_project_context({ task: "packing label validation" });
    const memories = await server.lmti_get_memory({ query: "packing label validation" });
    expect(context.memorySource?.source).toBe("legacy_json");
    expect(memories.some((item) => item.record.title === "Legacy packing label rule")).toBe(true);
    expect(await storageFingerprint(root)).toEqual(before);
    await expect(fs.stat(path.join(root, ".lmti", "memory", "project-memory.sqlite"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
