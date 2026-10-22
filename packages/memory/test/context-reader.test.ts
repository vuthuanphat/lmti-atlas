import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createPrivacyContext } from "@atlas/privacy";
import type { InferredIntent } from "@atlas/types";
import * as memory from "../src/index";

const intent: InferredIntent = { primaryIntent: "deploy", secondaryIntents: [], keywords: ["packing", "rollback"], negativeKeywords: [], confidence: 1 };
const contextOptions = (cwd: string) => ({ cwd, taskIntent: intent, includeLowScore: true, privacyContext: createPrivacyContext({ role: "external_model", projectId: "fixture", command: "context" }) });
const readContext = memory.readContextMemory;

async function workspace() { return mkdtemp(path.join(os.tmpdir(), "lmti-context-reader-")); }
async function digestTree(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function visit(dir: string) {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, item.name);
      if (item.isDirectory()) await visit(file);
      // SQLite's read-only WAL connections may maintain concurrency sidecars.
      // The database and every application-owned file must remain unchanged.
      else if (!/^project-memory\.sqlite-(wal|shm)$/.test(item.name)) result[path.relative(root, file)] = createHash("sha256").update(await readFile(file)).digest("hex");
    }
  }
  await visit(root);
  return result;
}

describe("read-only context memory owner", () => {
  it("reads SQLite by default without merging the legacy store or changing either source", async () => {
    const cwd = await workspace();
    const legacy = await memory.createMemory({ scope: "long_term", kind: "rule", title: "Legacy packing rollback", content: "Legacy packing rollback rule", projectId: "fixture", sourceRefs: ["legacy.md:1"], tags: ["packing", "rollback"], importance: 1, confidence: "high", sensitivity: "public" }, { cwd });
    const current = await memory.addProjectMemory({ title: "Packing rollback", content: "Packing rollback requires a verified shipment plan.", source: "approved-manifest:revision-a", zone: "deployment", privacyLevel: "public", importance: 1, confidence: 1 }, { cwd });
    const before = await digestTree(cwd);
    const result = await readContext("packing rollback", contextOptions(cwd));
    expect(result.results.map(row => row.record.id)).toContain(current.id);
    expect(result.results.map(row => row.record.id)).not.toContain(legacy.id);
    expect(result.results.find(row => row.record.id === current.id)?.record.sourceRefs).toContain("approved-manifest:revision-a");
    expect(result).toMatchObject({ source: "sqlite", completeness: "complete" });
    const compatibility = await readContext("packing rollback", { ...contextOptions(cwd), source: "legacy_json" });
    expect(compatibility.results.map(row => row.record.id)).toContain(legacy.id);
    expect(compatibility.results.map(row => row.record.id)).not.toContain(current.id);
    expect(await digestTree(cwd)).toEqual(before);
  });

  it("does not initialize an empty workspace", async () => {
    const cwd = await workspace();
    const result = await readContext("packing rollback", contextOptions(cwd));
    expect(result.results).toEqual([]);
    expect(await readdir(cwd)).toEqual([]);
  });

  it("reads legacy compatibility without updating associations, timestamps or audit files", async () => {
    const cwd = await workspace();
    await memory.createMemory({ scope: "long_term", kind: "rule", title: "Packing rollback", content: "Packing rollback needs verification", projectId: "fixture", sourceRefs: [], tags: ["packing"], importance: 1, confidence: "high", sensitivity: "internal" }, { cwd });
    const before = await digestTree(cwd);
    const result = await readContext("packing rollback", contextOptions(cwd));
    expect(result.results.length).toBeGreaterThan(0);
    expect(await digestTree(cwd)).toEqual(before);
    expect(result).toMatchObject({ source: "legacy_json", completeness: "complete" });
  });

  it("does not fall back to JSON when the selected SQLite store is corrupt", async () => {
    const cwd = await workspace();
    await memory.createMemory({ scope: "long_term", kind: "rule", title: "Packing rollback", content: "Packing rollback rule", projectId: "fixture", sourceRefs: [], tags: ["packing"], importance: 1, confidence: "high", sensitivity: "public" }, { cwd });
    await writeFile(path.join(cwd, ".lmti/memory/project-memory.sqlite"), "invalid synthetic database");
    const before = await digestTree(cwd);
    await expect(readContext("packing rollback", contextOptions(cwd))).rejects.toThrow();
    expect(await digestTree(cwd)).toEqual(before);
  });

  it("offers every allowed candidate for final preflight ranking, including the seventeenth", async () => {
    const cwd = await workspace();
    for (let i = 0; i < 17; i++) await memory.createMemory({ scope: "long_term", kind: "rule", title: `Fixture ${i}`, content: i === 16 ? "Packing rollback verified shipment" : `Ordinary unrelated fixture ${i}`, projectId: "fixture", sourceRefs: [], tags: [], importance: 0.8, confidence: "high", sensitivity: "public" }, { cwd });
    const result = await readContext("packing rollback", contextOptions(cwd));
    expect(result.policySafeCandidates).toHaveLength(17);
    const before = await digestTree(cwd);
    await expect(readContext("packing rollback", { ...contextOptions(cwd), maxCandidates: 16 })).rejects.toThrow("MEMORY_READ_BUDGET_EXCEEDED");
    expect(await digestTree(cwd)).toEqual(before);
  });

  it("reads committed live WAL content through one transaction without application writes", async () => {
    const cwd = await workspace();
    const record = await memory.addProjectMemory({ title: "Packing rollback before", content: "Packing rollback baseline", importance: 1 }, { cwd });
    const dbPath = path.join(cwd, ".lmti/memory/project-memory.sqlite");
    const writer = new DatabaseSync(dbPath);
    try {
      writer.exec("PRAGMA wal_autocheckpoint=0");
      writer.prepare("SELECT COUNT(*) FROM memory_items").get();
      await memory.updateProjectMemory(record.id, { title: "Packing rollback committed WAL", content: "Packing rollback committed revision" }, { cwd });
      const walBefore = await readFile(`${dbPath}-wal`);
      expect(walBefore.byteLength).toBeGreaterThan(32);
      const before = await digestTree(cwd);
      const result = await readContext("packing rollback", contextOptions(cwd));
      expect(result.results.find(row => row.record.id === record.id)?.record.title).toBe("Packing rollback committed WAL");
      expect(await digestTree(cwd)).toEqual(before);
      expect(await readFile(`${dbPath}-wal`)).toEqual(walBefore);
    } finally { writer.close(); }
  });

  it("preserves SQLite lesson approval, expiry and privacy in context and all preflight candidates", async () => {
    const cwd = await workspace();
    const proposal = await memory.proposeLessonCandidate({ observation: { taskTitle: "Packing rollback verification", taskSummary: "Confirmed packing rollback checks", filesTouched: [{ path: "fixture.ts", changeType: "modified" }], tests: [{ name: "Packing rollback", status: "pass" }], outcome: "pass", sourceRefs: [{ ref: "fixture.ts:1", kind: "file" }] }, agentProposedLesson: "Packing rollback needs a verified shipment before release.", lessonType: "deployment" }, { cwd });
    const forged = await memory.addProjectMemory({ title: "Packing rollback unapproved", content: "Packing rollback unapproved lesson", zone: "lesson", sourceType: "manual" }, { cwd });
    const denied = await memory.addProjectMemory({ title: "Packing rollback restricted", content: "Synthetic restricted phrase", privacyLevel: "do_not_prompt" }, { cwd });
    const expired = await memory.addProjectMemory({ title: "Packing rollback expired", content: "Packing rollback expired record", expiresAt: "2000-01-01T00:00:00.000Z" }, { cwd });
    const archived = await memory.addProjectMemory({ title: "Packing rollback archived", content: "Packing rollback archived record", status: "archived" }, { cwd });
    const transient = await memory.createShortMemoryNote({ title: "Packing rollback current task", content: "Packing rollback current task information" }, { cwd });
    const beforeApproval = await readContext("packing rollback", contextOptions(cwd));
    expect(JSON.stringify(beforeApproval)).not.toContain(proposal.candidate.lesson);
    const approved = await memory.approveLessonCandidate(proposal.candidate.id, { cwd });
    const before = await digestTree(cwd);
    const result = await readContext("packing rollback", contextOptions(cwd));
    const candidateIds = result.policySafeCandidates.map(row => row.metadata.id);
    expect(candidateIds).toContain(approved.memory.id);
    expect(candidateIds).toContain(transient.id);
    expect(candidateIds).not.toContain(forged.id);
    expect(candidateIds).not.toContain(denied.id);
    expect(candidateIds).not.toContain(expired.id);
    expect(candidateIds).not.toContain(archived.id);
    expect(result.policySafeCandidates.find(row => row.metadata.id === approved.memory.id)?.metadata.sourceRefs).toContain("fixture.ts:1");
    expect(JSON.stringify(result)).not.toContain("Synthetic restricted phrase");
    expect(await digestTree(cwd)).toEqual(before);
    await memory.rejectLessonCandidate(proposal.candidate.id, { cwd });
    expect((await readContext("packing rollback", contextOptions(cwd))).policySafeCandidates.map(row => row.metadata.id)).not.toContain(approved.memory.id);
    expect((await memory.searchProjectMemory("packing rollback", { cwd })).map(row => row.item.id)).not.toContain(approved.memory.id);
  });

  it("redacts metadata as well as selected content and does not trust unknown privacy or schema", async () => {
    const cwd = await workspace();
    const record = await memory.addProjectMemory({ title: "Packing rollback", content: "Packing rollback permitted summary", source: "fixture.md:1", importance: 1 }, { cwd });
    const file = path.join(cwd, ".lmti/memory/project-memory.sqlite");
    const edit = (sql: string, ...args: Array<string | number>) => { const db = new DatabaseSync(file); try { db.exec("PRAGMA ignore_check_constraints=ON"); db.prepare(sql).run(...args); } finally { db.close(); } };
    edit("UPDATE memory_items SET source = ?, tags = ? WHERE id = ?", "password=FAKE_METADATA_ONLY", JSON.stringify(["packing", "token=FAKE_TAG_ONLY"]), record.id);
    const result = await readContext("packing rollback", contextOptions(cwd));
    expect(result.policySafeCandidates).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("FAKE_METADATA_ONLY");
    expect(JSON.stringify(result)).not.toContain("FAKE_TAG_ONLY");
    edit("UPDATE memory_items SET privacy_level = ? WHERE id = ?", "invalid_privacy", record.id);
    await expect(readContext("packing rollback", contextOptions(cwd))).rejects.toThrow("MEMORY_SOURCE_INVALID");
    edit("UPDATE memory_migrations SET version = ? WHERE version = ?", 999, 4);
    await expect(readContext("packing rollback", contextOptions(cwd))).rejects.toThrow("MEMORY_SCHEMA_UNSUPPORTED");
  });

  it("rejects malformed legacy metadata without writing or treating it as empty", async () => {
    const cwd = await workspace();
    await memory.createMemory({ scope: "long_term", kind: "rule", title: "Packing rollback", content: "Packing rollback rule", projectId: "fixture", sourceRefs: [], tags: [], importance: 1, confidence: "high", sensitivity: "public" }, { cwd });
    const file = path.join(cwd, ".lmti/memory/long-term.json");
    const records = JSON.parse(await readFile(file, "utf8"));
    records[0].untrustedExtra = "password=FAKE_UNKNOWN_FIELD";
    await writeFile(file, JSON.stringify(records));
    expect(JSON.stringify(await readContext("packing rollback", contextOptions(cwd)))).not.toContain("FAKE_UNKNOWN_FIELD");
    for (const content of ["{", "{}", "[null]"]) {
      await writeFile(file, content);
      const before = await digestTree(cwd);
      await expect(readContext("packing rollback", contextOptions(cwd))).rejects.toThrow("MEMORY_SOURCE_INVALID");
      expect(await digestTree(cwd)).toEqual(before);
    }
    await writeFile(file, " ".repeat(16 * 1024 * 1024 + 1));
    await expect(readContext("packing rollback", contextOptions(cwd))).rejects.toThrow("MEMORY_READ_BUDGET_EXCEEDED");
  });
});

describe("SQLite retrieval final ranking", () => {
  it("ranks all eligible rows before limiting, including a candidate outside the old 3x window", async () => {
    const cwd = await workspace();
    for (let i = 0; i < 4; i++) await memory.addProjectMemory({ title: `Decoy ${i}`, content: `Ordinary deployment fixture ${i}`, zone: "deployment", importance: 1, confidence: 0.1 }, { cwd });
    const target = await memory.addProjectMemory({ title: "Correct review target", content: "Verified deployment fixture", zone: "deployment", importance: 0.8, confidence: 1 }, { cwd });
    const db = new DatabaseSync(path.join(cwd, ".lmti/memory/project-memory.sqlite"));
    db.prepare("UPDATE memory_items SET updated_at = ? WHERE id != ?").run("2000-01-01T00:00:00.000Z", target.id);
    db.close();
    const result = await memory.searchProjectMemory("", { cwd, limit: 1 });
    expect(result[0]?.item.id).toBe(target.id);
  });

  it("does not let denied early candidates starve an allowed match", async () => {
    const cwd = await workspace();
    for (let i = 0; i < 4; i++) await memory.addProjectMemory({ title: `Denied ${i}`, content: `Ordinary denied fixture ${i}`, privacyLevel: "do_not_prompt", importance: 1 }, { cwd });
    const target = await memory.addProjectMemory({ title: "Allowed candidate", content: "Ordinary permitted fixture", importance: 0.1 }, { cwd });
    expect((await memory.searchProjectMemory("", { cwd, limit: 1 }))[0]?.item.id).toBe(target.id);
  });

  it("breaks equal final scores by stable IDs independent of insertion order", async () => {
    const cwd = await workspace();
    for (const id of ["fixture-z", "fixture-a"]) await memory.addProjectMemory({ id, title: "Same candidate", content: "Same deployment fixture", importance: 1, confidence: 1 }, { cwd });
    const db = new DatabaseSync(path.join(cwd, ".lmti/memory/project-memory.sqlite"));
    db.prepare("UPDATE memory_items SET created_at = ?, updated_at = ?").run("2026-10-12T00:00:00.000Z", "2026-10-12T00:00:00.000Z");
    db.close();
    const result = await memory.searchProjectMemory("", { cwd, limit: 1, now: new Date("2026-10-12T01:00:00.000Z") });
    expect(result[0]?.item.id).toBe("fixture-a");
  });

  it("ranks short notes beyond the old 3x window before applying the result limit", async () => {
    const cwd = await workspace();
    const now = new Date("2026-10-12T00:00:00.000Z");
    for (let i = 0; i < 4; i++) await memory.createShortMemoryNote({ title: `Old note ${i}`, content: `Temporary task detail ${i}`, priority: "critical" }, { cwd, now });
    const target = await memory.createShortMemoryNote({ title: "Useful note", content: "Useful current task detail", priority: "high" }, { cwd, now });
    const db = new DatabaseSync(path.join(cwd, ".lmti/memory/project-memory.sqlite"));
    db.prepare("UPDATE short_memory_notes SET access_count = 100, promote_score = 1 WHERE id = ?").run(target.id);
    db.prepare("UPDATE short_memory_notes SET created_at = ?, promote_score = 0 WHERE id != ?").run("2000-01-01T00:00:00.000Z", target.id);
    db.close();
    const result = await memory.retrieveShortMemoryForTask("", { cwd, limit: 1, now });
    expect(result.notes[0]?.id).toBe(target.id);
  });
});
