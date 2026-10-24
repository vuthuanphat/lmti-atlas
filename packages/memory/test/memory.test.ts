import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readAuditEvents } from "@atlas/privacy";
import {
  addProjectMemory,
  approveLessonCandidate,
  checkProjectMemoryPrivacy,
  classifyLibraryMemory,
  cleanupShortMemoryNotes,
  consolidateMemory,
  createMemory,
  createShortMemoryNote,
  decayMemory,
  decayMemoryLifecycle,
  deleteProjectMemory,
  encodeMemory,
  evaluateShortMemoryForPromotion,
  explainMemory,
  expireShortMemoryNotes,
  getLessonCandidateReviewSummary,
  getMemoryAssociations,
  getProjectMemoryStats,
  InMemoryStore,
  initProjectMemoryStorage,
  listLessonCandidates,
  listMemory,
  migrateJsonMemoryToProjectMemory,
  LongTermMemory,
  promoteMemory,
  recordTaskDone,
  promoteShortMemoryToLongMemory,
  proposeLessonCandidate,
  retrieveMemoryContextForTask,
  reinforceMemory,
  retrieveMemoryForTask,
  retrieveShortMemoryForTask,
  searchMemory,
  searchMemoryForContext,
  searchProjectMemory,
  rejectLessonCandidate,
  ShortTermMemory,
  updateProjectMemory
} from "../src/index";
import type { InferredIntent } from "@atlas/types";

async function createWorkspace(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "atlas-memory-"));
}

const permissionIntent: InferredIntent = {
  primaryIntent: "permission",
  secondaryIntents: ["partner", "dashboard", "api"],
  keywords: ["partner", "403", "dashboard", "summary", "least privilege", "route"],
  negativeKeywords: ["logo", "ui asset"],
  confidence: 0.9
};

describe("Memory Core MVP-2", () => {
  it("creates, lists and searches structured memory", async () => {
    const cwd = await createWorkspace();
    const memory = await createMemory(
      {
        scope: "long_term",
        kind: "rule",
        title: "Packing label rule",
        content: "A shipping label can only be printed when all products in the same label group are completed.",
        projectId: "Sample Project",
        sourceRefs: ["README.md:1"],
        tags: ["packing", "label"],
        importance: 0.9,
        confidence: "high",
        sensitivity: "internal"
      },
      { cwd }
    );

    expect((await listMemory("long_term", { cwd })).map((record) => record.id)).toContain(memory.id);
    const results = await searchMemory("packing label", { cwd });
    expect(results[0]?.record.id).toBe(memory.id);
  });

  it("promotes short-term memory to long-term memory", async () => {
    const cwd = await createWorkspace();
    const memory = await createMemory(
      {
        scope: "short_term",
        kind: "task",
        title: "Fix packing label bug",
        content: "Active task context for packing labels.",
        projectId: "Sample Project",
        sourceRefs: [],
        tags: ["packing"],
        importance: 0.7,
        confidence: "medium",
        sensitivity: "internal"
      },
      { cwd }
    );

    const promoted = await promoteMemory(memory.id, { cwd });

    expect(promoted.scope).toBe("long_term");
    expect(promoted.expiresAt).toBeUndefined();
    expect(await listMemory("short_term", { cwd })).toHaveLength(0);
    expect(await listMemory("long_term", { cwd })).toHaveLength(1);
  });

  it("decays expired short-term memory", async () => {
    const cwd = await createWorkspace();
    const now = new Date("2026-06-27T00:00:00.000Z");
    await createMemory(
      {
        scope: "short_term",
        kind: "task",
        title: "Temporary context",
        content: "This should expire.",
        projectId: "Sample Project",
        sourceRefs: [],
        tags: [],
        importance: 0.4,
        confidence: "low",
        sensitivity: "internal",
        expiresAt: "2026-06-27T00:00:01.000Z"
      },
      { cwd, now }
    );

    const removed = await decayMemory({ cwd, now: new Date("2026-06-27T00:00:02.000Z") });

    expect(removed).toBe(1);
    expect(await listMemory("short_term", { cwd })).toHaveLength(0);
  });

  it("applies privacy policy to search and audits sensitive access", async () => {
    const cwd = await createWorkspace();
    await createMemory(
      {
        scope: "long_term",
        kind: "risk",
        title: "Payment secret",
        content: "Stripe key: sk_test_123456789",
        projectId: "Sample Project",
        sourceRefs: [],
        tags: ["payment"],
        importance: 1,
        confidence: "high",
        sensitivity: "secret"
      },
      { cwd }
    );

    expect(await searchMemory("payment", { cwd })).toHaveLength(0);

    const ownerResults = await searchMemory("payment", {
      cwd,
      includeSecret: true,
      privacyContext: {
        role: "owner",
        projectId: "Sample Project",
        purpose: "test",
        includeSecret: true,
        includeRaw: true,
        command: "memory search",
        timestamp: "2026-06-27T00:00:00.000Z"
      }
    });

    expect(ownerResults[0]?.record.content).toContain("sk_test_123456789");
    expect((await readAuditEvents(cwd)).some((event) => event.sensitivity === "secret")).toBe(true);
  });

  it("supports runtime short-term and long-term in-memory stores", async () => {
    const store = new InMemoryStore();
    const shortTerm = new ShortTermMemory(store, { projectId: "sample-project" });
    const longTerm = new LongTermMemory(store, { projectId: "sample-project" });

    await shortTerm.add({
      title: "Active task",
      content: "Fix packing label bug",
      tags: ["packing"]
    });
    await longTerm.add({
      title: "Packing rule",
      content: "Label printing needs completed products",
      tags: ["packing"],
      importance: 0.9
    });

    expect(await shortTerm.list()).toHaveLength(1);
    expect(await longTerm.search("packing label")).toHaveLength(1);

    await shortTerm.clear();
    expect(await shortTerm.list()).toHaveLength(0);
    expect(await longTerm.list()).toHaveLength(1);
  });

  it("summarizes internal memory by default and filters unrelated logo memory", async () => {
    const cwd = await createWorkspace();
    await createMemory(
      {
        scope: "long_term",
        kind: "lesson",
        title: "Partner route rule",
        content: "Partner user must route to /partner. /dashboard/summary returning 403 is correct due to least privilege.",
        projectId: "Sample Project",
        sourceRefs: [],
        tags: ["partner", "routing", "permission", "dashboard"],
        importance: 0.9,
        confidence: "high",
        sensitivity: "internal",
        promptPolicy: "summarize_only"
      },
      { cwd }
    );
    await createMemory(
      {
        scope: "long_term",
        kind: "lesson",
        title: "Dashboard logo rule",
        content: "Dashboard logo brand image asset must stay aligned.",
        projectId: "Sample Project",
        sourceRefs: [],
        tags: ["dashboard", "logo", "brand", "asset"],
        importance: 0.9,
        confidence: "high",
        sensitivity: "internal",
        promptPolicy: "summarize_only"
      },
      { cwd }
    );

    const result = await searchMemoryForContext("partner user gets 403 dashboard summary", { cwd, taskIntent: permissionIntent });

    expect(result.results.map((entry) => entry.record.title)).toContain("Partner route rule");
    expect(result.results.map((entry) => entry.record.title)).not.toContain("Dashboard logo rule");
    expect(result.results[0]?.mode).toBe("summary");
    expect(JSON.stringify(result.results)).not.toContain("/dashboard/summary returning 403 is correct");
  });

  it("excludes secret and do_not_prompt memory from context and writes privacy audit", async () => {
    const cwd = await createWorkspace();
    await createMemory(
      {
        scope: "long_term",
        kind: "risk",
        title: "Secret dashboard token",
        content: "token=super-secret-dashboard-value",
        projectId: "Sample Project",
        sourceRefs: [],
        tags: ["dashboard", "secret"],
        importance: 1,
        confidence: "high",
        sensitivity: "secret",
        promptPolicy: "do_not_prompt"
      },
      { cwd }
    );

    const result = await searchMemoryForContext("show secrets", {
      cwd,
      taskIntent: {
        primaryIntent: "privacy",
        secondaryIntents: [],
        keywords: ["secret", "privacy"],
        negativeKeywords: [],
        confidence: 0.7
      }
    });

    expect(result.results).toHaveLength(0);
    const audit = await readFile(path.join(cwd, ".lmti", "logs", "privacy-audit.jsonl"), "utf8");
    expect(audit).toContain("do_not_prompt memory filtered");
    expect(audit).not.toContain("super-secret-dashboard-value");
  });

  it("blocks confidential raw context and records a task lesson", async () => {
    const cwd = await createWorkspace();
    await createMemory(
      {
        scope: "long_term",
        kind: "risk",
        title: "Confidential permission note",
        content: "Confidential permission incident detail.",
        projectId: "Sample Project",
        sourceRefs: [],
        tags: ["permission"],
        importance: 0.8,
        confidence: "high",
        sensitivity: "confidential",
        promptPolicy: "allow_raw"
      },
      { cwd }
    );

    const confidential = await searchMemoryForContext("permission incident", {
      cwd,
      taskIntent: permissionIntent,
      includeRaw: true,
      privacyContext: {
        role: "owner",
        projectId: "Sample Project",
        purpose: "test",
        includeSecret: false,
        includeRaw: true,
        command: "context",
        timestamp: "2026-06-28T00:00:00.000Z"
      }
    });

    expect(confidential.results[0]?.mode).toBe("summary");
    expect(JSON.stringify(confidential.results)).not.toContain("Confidential permission incident detail.");

    const task = await recordTaskDone(
      {
        title: "Partner route fix",
        summary: "Documented partner routing behavior.",
        lesson: "Partner users must route to /partner.",
        projectId: "Sample Project",
        taskIntent: permissionIntent
      },
      { cwd }
    );
    expect(task.lessonMemory?.kind).toBe("lesson");
    const taskLog = await readFile(path.join(cwd, ".lmti", "events", "tasks.jsonl"), "utf8");
    expect(taskLog).toContain("Partner route fix");
  });

  it("encodes high-priority operational memories with lifecycle defaults", () => {
    const encoded = encodeMemory(
      {
        kind: "deploy_note",
        title: "Production deploy permission rule",
        content: "Production deploy requires least-privilege permission review and rollback note.",
        tags: ["deploy", "permission"],
        importance: 0.9,
        confidence: "high",
        sensitivity: "internal",
        sourceRefs: ["docs/deploy.md:12"]
      },
      { manualRemember: true }
    );

    expect(encoded.priorityScore).toBeGreaterThan(0.7);
    expect(encoded.memoryStrength).toBeGreaterThan(80);
    expect(encoded.contextCues).toEqual(expect.arrayContaining(["deploy", "permission"]));
    expect(encoded.promptPolicy).toBe("summarize_only");
    expect(encoded.privacySafeSummary).toContain("Production deploy permission rule");
  });

  it("consolidates short-term lessons above threshold and skips secret raw content", async () => {
    const cwd = await createWorkspace();
    await createMemory(
      {
        scope: "short_term",
        kind: "task",
        title: "Partner route debugging lesson",
        content: "Task done lesson: Partner user must route to /partner after permission checks.",
        projectId: "Sample Project",
        sourceRefs: ["task-123"],
        tags: ["partner", "routing", "permission"],
        importance: 0.95,
        confidence: "high",
        sensitivity: "internal"
      },
      { cwd }
    );
    await createMemory(
      {
        scope: "short_term",
        kind: "risk",
        title: "Fake secret fixture",
        content: "token=FAKE_TEST_TOKEN_VALUE",
        projectId: "Sample Project",
        sourceRefs: [],
        tags: ["secret"],
        importance: 1,
        confidence: "high",
        sensitivity: "internal"
      },
      { cwd }
    );

    const result = await consolidateMemory({ cwd });

    expect(result.created).toHaveLength(1);
    expect(result.skipped.some((entry) => entry.reason.includes("secret"))).toBe(true);
    expect((await listMemory("long_term", { cwd })).some((record) => record.title.includes("Partner route"))).toBe(true);
    expect((await listMemory("short_term", { cwd, privacyContext: { role: "owner", projectId: "Sample Project", purpose: "test", includeSecret: true, includeRaw: true, command: "memory list", timestamp: "2026-06-29T00:00:00.000Z" } })).some((record) => record.title.includes("Fake secret"))).toBe(true);
  });

  it("decays old weak memory without over-decaying durable rules", async () => {
    const cwd = await createWorkspace();
    const old = new Date("2026-01-01T00:00:00.000Z");
    const weak = await createMemory(
      {
        scope: "long_term",
        kind: "system_note",
        title: "Temporary UI note",
        content: "A low confidence note that should fade.",
        projectId: "Sample Project",
        sourceRefs: [],
        tags: ["ui"],
        importance: 0.2,
        confidence: "low",
        sensitivity: "internal",
        memoryStrength: 2,
        baseActivation: 1,
        decayRate: 0.3
      },
      { cwd, now: old }
    );
    const durable = await createMemory(
      {
        scope: "long_term",
        kind: "permission",
        title: "Partner permission invariant",
        content: "Partner users must not gain admin dashboard access.",
        projectId: "Sample Project",
        sourceRefs: [],
        tags: ["partner", "permission"],
        importance: 1,
        confidence: "high",
        sensitivity: "internal",
        memoryStrength: 2,
        baseActivation: 1,
        decayRate: 0.3
      },
      { cwd, now: old }
    );

    const report = await decayMemoryLifecycle({ cwd, now: new Date("2026-06-01T00:00:00.000Z") });
    const records = await listMemory("long_term", { cwd, privacyContext: { role: "owner", projectId: "Sample Project", purpose: "test", includeSecret: false, includeRaw: true, command: "memory list", timestamp: "2026-06-01T00:00:00.000Z" } });
    const weakAfter = records.find((record) => record.id === weak.id);
    const durableAfter = records.find((record) => record.id === durable.id);

    expect(report.updatedLongTerm).toBeGreaterThan(0);
    expect(weakAfter?.status).toBe("archived");
    expect(durableAfter?.status).toBe("active");
    expect(durableAfter?.baseActivation).toBeGreaterThanOrEqual(0.8);
  });

  it("reinforces success and failure differently", async () => {
    const cwd = await createWorkspace();
    const memory = await createMemory(
      {
        scope: "long_term",
        kind: "lesson",
        title: "Permission debugging lesson",
        content: "Use least privilege when debugging partner permissions.",
        projectId: "Sample Project",
        sourceRefs: [],
        tags: ["permission"],
        importance: 0.8,
        confidence: "medium",
        sensitivity: "internal"
      },
      { cwd }
    );

    const success = await reinforceMemory(memory.id, { cwd, success: true, now: new Date("2026-06-28T00:00:00.000Z") });
    const failed = await reinforceMemory(memory.id, { cwd, success: false, now: new Date("2026-06-29T00:00:00.000Z") });

    expect(success.memory.retrievalCount).toBe((memory.retrievalCount ?? 0) + 1);
    expect(success.memory.memoryStrength).toBeGreaterThan(memory.memoryStrength ?? 0);
    expect(failed.memory.confidence).toBe("low");
    expect(failed.memory.status).toBe("weak");
  });

  it("marks superseded memory as history and excludes it from context", async () => {
    const cwd = await createWorkspace();
    const old = await createMemory(
      {
        scope: "long_term",
        kind: "route",
        title: "Partner route rule",
        content: "Partner user must route to /partner.",
        projectId: "Sample Project",
        sourceRefs: [],
        tags: ["partner", "routing"],
        importance: 0.9,
        confidence: "high",
        sensitivity: "internal"
      },
      { cwd }
    );
    const next = await createMemory(
      {
        scope: "long_term",
        kind: "route",
        title: "Partner route rule v2",
        content: "Partner user now routes to /partner-v2 instead of /partner.",
        projectId: "Sample Project",
        sourceRefs: [],
        tags: ["partner", "routing"],
        importance: 1,
        confidence: "high",
        sensitivity: "internal"
      },
      { cwd }
    );

    const oldAfter = await listMemory("long_term", { cwd }).then((records) => records.find((record) => record.id === old.id));
    const context = await searchMemoryForContext("partner route", { cwd, taskIntent: { primaryIntent: "routing", secondaryIntents: ["partner"], keywords: ["partner", "route"], negativeKeywords: [], confidence: 0.9 } });

    expect(oldAfter?.status).toBe("superseded");
    expect(oldAfter?.supersededBy).toBe(next.id);
    expect(context.results.map((entry) => entry.record.id)).not.toContain(old.id);
    expect(context.results.map((entry) => entry.record.id)).toContain(next.id);
  });

  it("strengthens associations when memories are co-retrieved", async () => {
    const cwd = await createWorkspace();
    const route = await createMemory(
      {
        scope: "long_term",
        kind: "route",
        title: "Partner route",
        content: "Partner traffic routes through /partner.",
        projectId: "Sample Project",
        sourceRefs: [],
        tags: ["partner", "routing", "permission"],
        importance: 0.9,
        confidence: "high",
        sensitivity: "internal"
      },
      { cwd }
    );
    const permission = await createMemory(
      {
        scope: "long_term",
        kind: "permission",
        title: "Partner permission",
        content: "Partner role has least-privilege dashboard access.",
        projectId: "Sample Project",
        sourceRefs: [],
        tags: ["partner", "permission", "routing"],
        importance: 0.9,
        confidence: "high",
        sensitivity: "internal"
      },
      { cwd }
    );

    await searchMemoryForContext("partner permission route", { cwd, taskIntent: permissionIntent, includeLowScore: true });
    const associations = await getMemoryAssociations(route.id, { cwd });

    expect(associations.some((association) => association.targetMemoryId === permission.id && association.weight > 0)).toBe(true);
  });

  it("explains selected and filtered memory without raw secret leakage", async () => {
    const cwd = await createWorkspace();
    await createMemory(
      {
        scope: "long_term",
        kind: "permission",
        title: "Partner permission rule",
        content: "Partner user must route to /partner.",
        projectId: "Sample Project",
        sourceRefs: [],
        tags: ["partner", "permission"],
        importance: 0.9,
        confidence: "high",
        sensitivity: "internal"
      },
      { cwd }
    );
    await createMemory(
      {
        scope: "long_term",
        kind: "risk",
        title: "Secret fixture",
        content: "token=FAKE_TEST_TOKEN_VALUE",
        projectId: "Sample Project",
        sourceRefs: [],
        tags: ["partner", "permission"],
        importance: 1,
        confidence: "high",
        sensitivity: "secret"
      },
      { cwd }
    );

    const explanation = await explainMemory("partner permission", { cwd, taskIntent: permissionIntent });

    expect(explanation.selected[0]?.title).toBe("Partner permission rule");
    expect(explanation.selected[0]?.activation).toBeGreaterThan(0);
    expect(explanation.filteredOut.some((entry) => entry.privacyDecision.includes("secret"))).toBe(true);
    expect(JSON.stringify(explanation)).not.toContain("FAKE_TEST_TOKEN_VALUE");
  });

  it("summarizes internal memory for external model role instead of sending raw content", async () => {
    const cwd = await createWorkspace();
    await createMemory(
      {
        scope: "long_term",
        kind: "lesson",
        title: "Internal route note",
        content: "Internal implementation detail that external models must not receive raw.",
        projectId: "Sample Project",
        sourceRefs: [],
        tags: ["routing"],
        importance: 0.8,
        confidence: "high",
        sensitivity: "internal",
        promptPolicy: "allow_raw"
      },
      { cwd }
    );

    const result = await searchMemoryForContext("route note", {
      cwd,
      taskIntent: { primaryIntent: "routing", secondaryIntents: [], keywords: ["route", "note"], negativeKeywords: [], confidence: 0.8 },
      includeRaw: true,
      privacyContext: {
        role: "external_model",
        projectId: "Sample Project",
        purpose: "test",
        includeSecret: false,
        includeRaw: true,
        command: "context",
        timestamp: "2026-06-29T00:00:00.000Z"
      }
    });

    expect(result.results[0]?.mode).toBe("summary");
    expect(JSON.stringify(result.results)).not.toContain("Internal implementation detail");
  });
});

describe("Legacy JSON migration safety", () => {
  it("inventories every legacy scope without exposing records or changing either store", async () => {
    const cwd = await createWorkspace();
    const existing = await addProjectMemory({ content: "Existing local workflow" }, { cwd });
    const dbPath = path.join(cwd, ".lmti", "memory", "project-memory.sqlite");
    const before = await readFile(dbPath);
    const record = {
      id: "legacy-test", title: "Ordinary fixture", content: "Ordinary fixture content",
      sensitivity: "secret", promptPolicy: "do_not_prompt", projectId: "fixture",
      sourceRefs: ["docs/fixture.md:1"], status: "active", kind: "lesson"
    };
    const sources = ["long-term.json", "lessons.json", "short-term.json"];
    for (const source of sources) {
      await writeFile(path.join(cwd, ".lmti", "memory", source), JSON.stringify([record]));
    }
    const inventory = await migrateJsonMemoryToProjectMemory({ cwd, dryRun: true });
    expect(inventory).toMatchObject({ imported: 0, skipped: 0, blocked: 3, dryRun: true });
    expect(JSON.stringify(inventory)).not.toContain(record.content);
    expect(JSON.stringify(inventory)).not.toContain(record.sourceRefs[0]);
    await expect(migrateJsonMemoryToProjectMemory({ cwd })).rejects.toThrow("LEGACY_MEMORY_MIGRATION_BLOCKED");
    expect(await readFile(dbPath)).toEqual(before);
    for (const source of sources) {
      expect(JSON.parse(await readFile(path.join(cwd, ".lmti", "memory", source), "utf8"))).toEqual([record]);
    }
    expect((await getProjectMemoryStats({ cwd })).total).toBe(1);
    expect((await searchProjectMemory("Existing local workflow", { cwd }))[0]?.item.id).toBe(existing.id);
  });

  it("rejects malformed legacy input rather than silently treating it as an empty successful import", async () => {
    const cwd = await createWorkspace();
    await initProjectMemoryStorage(cwd);
    const file = path.join(cwd, ".lmti", "memory", "long-term.json");
    for (const value of ["{", "{}", "[null]", "[[]]", JSON.stringify(Array.from({ length: 10_001 }, () => ({}))), " ".repeat(16 * 1024 * 1024 + 1)]) {
      await writeFile(file, value);
      await expect(migrateJsonMemoryToProjectMemory({ cwd, dryRun: true })).rejects.toThrow("LEGACY_MEMORY_INVALID");
    }
    expect((await getProjectMemoryStats({ cwd })).total).toBe(0);
  });

  it("leaves an empty workspace untouched when no legacy data exists", async () => {
    const cwd = await createWorkspace();
    expect(await migrateJsonMemoryToProjectMemory({ cwd })).toMatchObject({ imported: 0, blocked: 0 });
    await expect(readFile(path.join(cwd, ".lmti", "memory", "project-memory.sqlite"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("Project Operating Memory SQLite Library Layer", () => {
  it("initializes SQLite storage and stores normal memory", async () => {
    const cwd = await createWorkspace();
    const storage = await initProjectMemoryStorage(cwd);
    const memory = await addProjectMemory(
      {
        title: "Packing workflow rule",
        content: "ERP order packing workflow must verify destination before shipping.",
        source: "test",
        sourceType: "manual"
      },
      { cwd }
    );
    const stats = await getProjectMemoryStats({ cwd });
    const updated = await updateProjectMemory(memory.id, { content: "ERP order packing workflow must verify destination and carrier before shipping." }, { cwd });
    const sqlite = await import("node:sqlite");
    const db = new sqlite.DatabaseSync(storage.dbPath);
    const migrations = db.prepare("SELECT version, name FROM memory_migrations ORDER BY version").all() as Array<{ version: number; name: string }>;
    const storedHash = db.prepare("SELECT content_hash FROM memory_items WHERE id = ?").get(memory.id) as { content_hash: string };
    db.close();

    expect(storage.dbPath.endsWith("project-memory.sqlite")).toBe(true);
    expect(storage.schemaVersion).toBe(4);
    expect(memory.zone).toBe("workflow");
    expect(memory.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(updated.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(updated.contentHash).not.toBe(memory.contentHash);
    expect(storedHash.content_hash).toBe(updated.contentHash);
    expect(migrations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ version: 3, name: "memory_content_hashes" }),
        expect.objectContaining({ version: 4, name: "lesson_proposal_pipeline" })
      ])
    );
    expect(stats.total).toBe(1);
    expect(stats.byZone.workflow).toBe(1);
  });

  it("uses FTS5 search and BM25-backed ranking", async () => {
    const cwd = await createWorkspace();
    const target = await addProjectMemory(
      {
        title: "Production deploy rollback",
        content: "Deploy production with healthcheck and rollback note.",
        source: "deploy-doc"
      },
      { cwd }
    );
    await addProjectMemory(
      {
        title: "Logo color note",
        content: "Dashboard logo brand color should stay aligned.",
        source: "design-doc"
      },
      { cwd }
    );

    const results = await searchProjectMemory("production healthcheck rollback", { cwd, limit: 3 });

    expect(results[0]?.item.id).toBe(target.id);
    expect(results[0]?.score).toBeGreaterThan(0);
  });

  it("classifies required library zones", () => {
    expect(classifyLibraryMemory({ content: "PM2 deploy release healthcheck rollback" }).zone).toBe("deployment");
    expect(classifyLibraryMemory({ content: "ERP order credit pricing business rule" }).zone).toBe("business");
    expect(classifyLibraryMemory({ content: "Module service API worker database boundary" }).zone).toBe("architecture");
    expect(classifyLibraryMemory({ content: "small note without durable meaning" }).zone).toBe("unknown");
  });

  it("redacts secret-like content before storing and blocks it from retrieval", async () => {
    const cwd = await createWorkspace();
    const rawSecret = "OPENAI_API_KEY=sk-proj-FAKE_TEST_VALUE_12345678901234567890";
    const memory = await addProjectMemory(
      {
        title: "Deployment env secret",
        content: `Do not store raw .env values. ${rawSecret}`,
        source: "test"
      },
      { cwd }
    );

    expect(["secret", "do_not_prompt"]).toContain(memory.privacyLevel);
    expect(memory.content).not.toContain(rawSecret);
    expect(await searchProjectMemory("Deployment env secret", { cwd })).toHaveLength(0);
    expect(await checkProjectMemoryPrivacy({ cwd })).toHaveLength(0);
  });

  it("does not retrieve secret or do_not_prompt memories for task context", async () => {
    const cwd = await createWorkspace();
    await addProjectMemory(
      {
        title: "Secret dashboard token",
        content: "access_token=FAKE_TEST_TOKEN_VALUE_123456789012345678901234",
        zone: "security",
        privacyLevel: "secret"
      },
      { cwd }
    );
    await addProjectMemory(
      {
        title: "Private key fixture",
        content: ["PRIVATE_KEY=", "-----BEGIN RSA ", "PRIVATE KEY-----", "FAKE", "-----END RSA ", "PRIVATE KEY-----"].join(""),
        zone: "security",
        privacyLevel: "do_not_prompt"
      },
      { cwd }
    );

    const results = await retrieveMemoryForTask("fix dashboard token permission", { cwd, privacyMode: "internal" });

    expect(results).toHaveLength(0);
    expect(JSON.stringify(results)).not.toContain("FAKE_TEST_TOKEN");
  });

  it("retrieves dashboard 403 lessons without unrelated logo memory", async () => {
    const cwd = await createWorkspace();
    await addProjectMemory(
      {
        title: "Partner dashboard 403 lesson",
        content: "Partner user must route to /partner. Dashboard 403 is correct under least privilege.",
        zone: "lesson",
        tags: ["partner", "dashboard", "403", "permission"],
        importance: 0.95
      },
      { cwd }
    );
    await addProjectMemory(
      {
        title: "Dashboard logo rule",
        content: "Dashboard logo brand asset alignment note.",
        zone: "codebase",
        tags: ["dashboard", "logo", "brand"],
        importance: 0.95
      },
      { cwd }
    );

    const results = await retrieveMemoryForTask("fix partner dashboard 403 permission", { cwd, limit: 5 });

    expect(results.map((result) => result.item.title)).toContain("Partner dashboard 403 lesson");
    expect(results.map((result) => result.item.title)).not.toContain("Dashboard logo rule");
  });

  it("proposes evidence-backed lesson candidates and only retrieves them after approval", async () => {
    const cwd = await createWorkspace();
    const proposal = await proposeLessonCandidate(
      {
        observation: {
          taskId: "task-level-2",
          taskTitle: "Level 2 lesson proposal pipeline",
          taskSummary: "Added privacy, evidence, confidence and approval gates for lesson candidates.",
          agent: "codex",
          filesTouched: [
            {
              path: "packages/memory/src/sqlite-store.ts",
              changeType: "modified",
              changeSummary: "Added candidate storage and approval lifecycle."
            }
          ],
          commandsRun: [
            {
              command: "npm test packages/memory/test/memory.test.ts",
              exitCode: 0,
              status: "pass",
              outputSummary: "targeted memory tests passed",
              outputRedacted: true
            }
          ],
          tests: [
            {
              name: "memory lesson proposal tests",
              status: "pass",
              command: "npm test packages/memory/test/memory.test.ts"
            }
          ],
          decisions: [
            {
              decision: "Pending candidates must not be injected into context.",
              source: "user"
            }
          ],
          outcome: "pass",
          sourceRefs: [{ ref: "packages/memory/src/sqlite-store.ts", kind: "file" }]
        },
        agentProposedLesson: "Lesson candidates should remain pending until a reviewer approves evidence-backed, privacy-safe content.",
        lessonType: "workflow"
      },
      { cwd }
    );

    const candidates = await listLessonCandidates({ cwd });
    const beforeApproval = await retrieveMemoryForTask("Level 2 lesson proposal approval workflow", { cwd });
    const approved = await approveLessonCandidate(proposal.candidate.id, { cwd });
    const afterApproval = await retrieveMemoryForTask("Level 2 lesson proposal approval workflow", { cwd });

    expect(proposal.candidate.privacyStatus).toBe("pass");
    expect(proposal.candidate.approvalStatus).toBe("pending");
    expect(proposal.candidate.confidence).toBe(0.9);
    expect(proposal.candidate.evidence.map((entry) => entry.type)).toEqual(
      expect.arrayContaining(["file_changed", "command_exit_code", "test_passed", "user_instruction", "privacy_check"])
    );
    expect(candidates.map((candidate) => candidate.id)).toContain(proposal.candidate.id);
    expect(beforeApproval.map((result) => result.item.source)).not.toContain(`lesson_candidate:${proposal.candidate.id}`);
    expect(approved.candidate.approvalStatus).toBe("approved");
    expect(approved.memory.sourceType).toBe("lesson_candidate");
    expect(afterApproval.map((result) => result.item.id)).toContain(approved.memory.id);
  });

  it("blocks secret-like lesson candidates from approval and review summaries flag them", async () => {
    const cwd = await createWorkspace();
    const rawSecret = "OPENAI_API_KEY=sk-proj-FAKE_TEST_VALUE_12345678901234567890";
    const proposal = await proposeLessonCandidate(
      {
        observation: {
          taskTitle: "Investigate leaked env output",
          taskSummary: "Command output contained a secret-like fixture.",
          commandsRun: [
            {
              command: "npm test",
              exitCode: 1,
              status: "fail",
              outputSummary: `test output included ${rawSecret}`,
              outputRedacted: true
            }
          ],
          errors: [{ message: `redacted secret fixture ${rawSecret}`, severity: "high" }],
          outcome: "fail"
        },
        agentProposedLesson: `Never store raw secret output such as ${rawSecret}.`,
        lessonType: "security"
      },
      { cwd }
    );

    const summary = await getLessonCandidateReviewSummary({ cwd });

    expect(proposal.candidate.privacyStatus).toBe("blocked");
    expect(proposal.candidate.approvalStatus).toBe("needs_review");
    expect(JSON.stringify(proposal)).not.toContain(rawSecret);
    await expect(approveLessonCandidate(proposal.candidate.id, { cwd })).rejects.toThrow("Privacy-blocked");
    expect(summary.needsReview).toBe(1);
    expect(summary.privacyWarnings).toBe(1);
    const rejected = await rejectLessonCandidate(proposal.candidate.id, { cwd });
    expect(rejected.approvalStatus).toBe("rejected");
  });

  it("keeps FTS triggers in sync on update and delete", async () => {
    const cwd = await createWorkspace();
    const memory = await addProjectMemory(
      {
        title: "Deploy alpha note",
        content: "Rollback alpha release plan.",
        zone: "deployment"
      },
      { cwd }
    );

    expect(await searchProjectMemory("alpha", { cwd })).toHaveLength(1);
    await updateProjectMemory(memory.id, { title: "Deploy beta note", content: "Rollback beta release plan.", tags: ["deploy", "beta"] }, { cwd });
    expect(await searchProjectMemory("beta", { cwd })).toHaveLength(1);
    expect(await searchProjectMemory("alpha", { cwd })).toHaveLength(0);
    expect(await deleteProjectMemory(memory.id, { cwd })).toBe(true);
    expect(await searchProjectMemory("beta", { cwd })).toHaveLength(0);
  });

  it("stores short memory as expiring task notes and retrieves by current task", async () => {
    const cwd = await createWorkspace();
    const now = new Date("2026-06-30T00:00:00.000Z");
    const note = await createShortMemoryNote(
      {
        title: "Current debug checkpoint",
        content: "Temporary note: inspect SQLite short memory retrieval and build output next.",
        tags: ["debug", "sqlite"],
        priority: "low"
      },
      { cwd, now }
    );

    const ttlMs = new Date(note.expiresAt).getTime() - now.getTime();
    const retrieved = await retrieveShortMemoryForTask("inspect sqlite short memory build output", { cwd, now, limit: 3 });

    expect(ttlMs).toBe(6 * 3_600_000);
    expect(retrieved.notes.map((entry) => entry.id)).toContain(note.id);
    expect(retrieved.notes[0]?.reason).toContain("priority=low");
  });

  it("expires and cleans up weak short memory without promoting scratch notes", async () => {
    const cwd = await createWorkspace();
    const now = new Date("2026-06-30T00:00:00.000Z");
    const note = await createShortMemoryNote(
      {
        title: "Scratch output",
        content: "Temporary one-time build output scratch note.",
        priority: "low",
        ttl: { minutes: 1 }
      },
      { cwd, now }
    );

    const expired = await expireShortMemoryNotes({ cwd, now: new Date("2026-06-30T00:02:00.000Z") });
    const activeResults = await retrieveShortMemoryForTask("scratch build output", { cwd, now: new Date("2026-06-30T00:02:00.000Z") });
    const cleanup = await cleanupShortMemoryNotes({
      cwd,
      now: new Date("2026-07-01T01:02:00.000Z"),
      deleteExpiredOlderThanHours: 24
    });
    const afterCleanup = await retrieveShortMemoryForTask("scratch build output", {
      cwd,
      now: new Date("2026-07-01T01:02:00.000Z"),
      includeExpired: true
    });

    expect(expired.expired).toBe(1);
    expect(activeResults.notes).toHaveLength(0);
    expect(cleanup.deleted).toBe(1);
    expect(cleanup.candidateIds).toContain(note.id);
    expect(afterCleanup.notes.map((entry) => entry.id)).not.toContain(note.id);
  });

  it("blocks secret-like short notes from retrieval and promotion", async () => {
    const cwd = await createWorkspace();
    const rawSecret = "access_token=FAKE_TEST_TOKEN_VALUE_123456789012345678901234";
    const note = await createShortMemoryNote(
      {
        title: "Secret dashboard token",
        content: `Do not leak this credential. ${rawSecret}`,
        tags: ["dashboard", "token"],
        priority: "critical"
      },
      { cwd }
    );

    const retrieved = await retrieveShortMemoryForTask("dashboard token", { cwd, privacyMode: "internal" });
    const evaluation = await evaluateShortMemoryForPromotion(note.id, { cwd });
    const promoted = await promoteShortMemoryToLongMemory({ noteId: note.id, force: true }, { cwd });

    expect(note.content).not.toContain(rawSecret);
    expect(note.privacyLevel).toBe("secret");
    expect(retrieved.notes).toHaveLength(0);
    expect(retrieved.filteredOut).toBeGreaterThan(0);
    expect(evaluation.blocked).toBe(true);
    expect(promoted.promoted).toBe(false);
    expect(await searchProjectMemory("Secret dashboard token", { cwd, privacyMode: "internal" })).toHaveLength(0);
  });

  it("promotes durable short notes into long memory and returns combined task context", async () => {
    const cwd = await createWorkspace();
    const note = await createShortMemoryNote(
      {
        title: "Partner dashboard 403 lesson candidate",
        content: "Remember important long-term lesson: partner dashboard 403 is a least privilege permission rule and should be documented after debugging.",
        tags: ["partner", "dashboard", "permission", "lesson"],
        priority: "critical"
      },
      { cwd }
    );
    await createShortMemoryNote(
      {
        title: "Current work checkpoint",
        content: "Current task is checking short memory context retrieval before build.",
        tags: ["memory", "context"],
        priority: "medium"
      },
      { cwd }
    );

    const evaluation = await evaluateShortMemoryForPromotion(note.id, { cwd });
    const promoted = await promoteShortMemoryToLongMemory({ noteId: note.id, reason: "Durable permission lesson" }, { cwd });
    const longResults = await searchProjectMemory("partner dashboard 403 permission", { cwd, privacyMode: "internal" });
    const context = await retrieveMemoryContextForTask("checking memory context retrieval partner dashboard permission", {
      cwd,
      shortLimit: 3,
      longLimit: 3,
      privacyMode: "internal"
    });

    expect(evaluation.shouldSuggest).toBe(true);
    expect(promoted.promoted).toBe(true);
    expect(promoted.note.status).toBe("promoted");
    expect(promoted.longMemory?.source).toBe(`short-memory:${note.id}`);
    expect(longResults.map((result) => result.item.id)).toContain(promoted.longMemory?.id);
    expect(context.shortMemory.some((entry) => entry.title === "Current work checkpoint")).toBe(true);
    expect(context.longMemory.some((entry) => entry.item.id === promoted.longMemory?.id)).toBe(true);
  });
});
