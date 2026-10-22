import { mkdtemp, mkdir, readFile, writeFile, realpath, stat, symlink, rename } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { addProjectMemory, getLessonCandidate, initProjectMemoryStorage, proposeLessonCandidate } from "@atlas/memory";
import { desktopBridgeCommand } from "../src/desktop-bridge";

async function fixture(withMemory = true) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "lmti-knowledge-")));
  await mkdir(path.join(root, ".lmti"));
  const amf = { version: "0.1.0", project: { name: "Synthetic source", root, compiledAt: "2026-10-12T00:00:00Z" },
    modules: [{ name: "Public module", summary: "Public architecture", privacy: "public" }, { name: "Private map", summary: "Withheld architecture", privacy: "internal" }],
    files: [], architecture: [], rules: [], summaries: [] };
  await writeFile(path.join(root, ".lmti/project.amf.json"), JSON.stringify(amf));
  if (withMemory) await initProjectMemoryStorage(root);
  const request = { schema: "lmti.desktop.knowledge.v1", operation: "snapshot", projectId: "native-project", sourceRoot: root, sourceId: "", target: "external" };
  return { root, request, amf, dbPath: path.join(root, ".lmti/memory/project-memory.sqlite") };
}
async function propose(root: string) {
  return proposeLessonCandidate({ observation: {
    taskId: "synthetic-task", taskTitle: "Verified architecture change", taskSummary: "Preserve project boundaries.",
    filesTouched: [{ path: "src/model.ts", changeType: "modified", changeSummary: "Preserved boundary." }],
    commandsRun: [{ command: "synthetic-test", exitCode: 0, status: "pass", outputRedacted: true }],
    tests: [{ name: "synthetic boundary", status: "pass" }], decisions: [], outcome: "pass"
  }, agentProposedLesson: "Keep reviewed architecture knowledge within its source boundary." }, { cwd: root });
}
describe("desktop knowledge boundary", () => {
  it("reads summaries without changing the database; denies secret and pending content", async () => {
    const { root, request, dbPath } = await fixture();
    await addProjectMemory({ title: "Public architecture", content: "Typed core stays independent.", privacyLevel: "public", zone: "architecture" }, { cwd: root });
    await addProjectMemory({ title: "Hidden marker", content: "Should never be exposed", privacyLevel: "do_not_prompt" }, { cwd: root });
    await addProjectMemory({ title: "Legacy unreviewed lesson", content: "Not approved", zone: "lesson" }, { cwd: root });
    const proposed = await propose(root);
    const before = await readFile(dbPath);
    const response = await desktopBridgeCommand(request);
    expect(response.memories.map(m => m.title)).toEqual(["Public architecture"]);
    expect(response.projectMap.map(m => m.title)).toEqual(["Public module"]);
    expect(response.lessons[0].status).toBe("pending");
    expect(await readFile(dbPath)).toEqual(before);
    const context = await desktopBridgeCommand({ ...request, sourceId: response.sourceId, operation: "context", task: "architecture" });
    expect(context.context).not.toContain(proposed.candidate.lesson);
    expect(context.context).not.toContain("Hidden marker");
    expect(await readFile(dbPath)).toEqual(before);
  });
  it("distinguishes missing storage and validates source/operation/target/task", async () => {
    const { root, request, amf } = await fixture(false);
    expect((await desktopBridgeCommand(request)).memoryConnected).toBe(false);
    expect(await stat(path.join(root, ".lmti/memory")).catch(() => undefined)).toBeUndefined();
    for (const change of [{ operation: "shell" }, { target: "internal" }, { sourceId: "wrong" }, { projectId: "../bad" }, { extra: "no" }])
      await expect(desktopBridgeCommand({ ...request, ...change })).rejects.toThrow();
    const response = await desktopBridgeCommand(request);
    await expect(desktopBridgeCommand({ ...request, sourceId: response.sourceId, operation: "context", task: "token=" + "ghp_" + "a".repeat(36) })).rejects.toThrow();
    await writeFile(path.join(root, ".lmti/project.amf.json"), JSON.stringify({ ...amf, project: { ...amf.project, root: os.tmpdir() } }));
    await expect(desktopBridgeCommand(request)).rejects.toThrow("SOURCE_IDENTITY_DENIED");
  });
  it("requires explicit review grant and fingerprint; approval is atomic and reusable", async () => {
    const { root, request, dbPath } = await fixture();
    const proposed = await propose(root);
    const snapshot = await desktopBridgeCommand(request);
    const lesson = snapshot.lessons[0];
    const review = { ...request, sourceId: snapshot.sourceId, operation: "approve", lessonId: lesson.id, fingerprint: lesson.fingerprint, reviewed: true };
    await expect(desktopBridgeCommand(review)).rejects.toThrow("REVIEW_GRANT_DENIED");
    await expect(desktopBridgeCommand({ ...review, reviewed: false }, { allowLessonReview: true })).rejects.toThrow();
    const before = await readFile(dbPath);
    await expect(desktopBridgeCommand({ ...review, fingerprint: "0".repeat(64) }, { allowLessonReview: true })).rejects.toThrow("LESSON_STALE_OR_DENIED");
    expect(await readFile(dbPath)).toEqual(before);
    const approved = await desktopBridgeCommand(review, { allowLessonReview: true });
    expect((await getLessonCandidate(proposed.candidate.id, { cwd: root }))?.approvalStatus).toBe("approved");
    expect(approved.memories.some(m => m.zone === "lesson")).toBe(true);
    await expect(desktopBridgeCommand(review, { allowLessonReview: true })).rejects.toThrow("LESSON_STALE_OR_DENIED");
  });
  it("rejects unsupported schema and oversized/malformed AMF before output", async () => {
    const { root, request, dbPath } = await fixture();
    const db = new DatabaseSync(dbPath); db.prepare("INSERT INTO memory_migrations VALUES (?,?,?)").run(99, "future", "2026-10-12"); db.close();
    await expect(desktopBridgeCommand(request)).rejects.toThrow("MEMORY_SCHEMA_UNSUPPORTED");
    await writeFile(path.join(root, ".lmti/project.amf.json"), "{");
    await expect(desktopBridgeCommand(request)).rejects.toThrow();
    await writeFile(path.join(root, ".lmti/project.amf.json"), " ".repeat(2 * 1024 * 1024 + 1));
    await expect(desktopBridgeCommand(request)).rejects.toThrow("SOURCE_SIZE_DENIED");
  });
  it("denies a source escaping through a junction and retains rejected lessons outside context", async () => {
    const first = await fixture(), second = await fixture();
    await rename(path.join(first.root, ".lmti"), path.join(first.root, "original-lmti"));
    await symlink(path.join(second.root, ".lmti"), path.join(first.root, ".lmti"), process.platform === "win32" ? "junction" : "dir");
    await expect(desktopBridgeCommand(first.request)).rejects.toThrow("SOURCE_BOUNDARY_DENIED");
    const proposed = await propose(second.root);
    const response = await desktopBridgeCommand(second.request);
    const lesson = response.lessons.find(l => l.id === proposed.candidate.id)!;
    const rejected = await desktopBridgeCommand({ ...second.request, sourceId: response.sourceId, operation: "reject", lessonId: lesson.id, fingerprint: lesson.fingerprint, reviewed: true }, { allowLessonReview: true });
    expect(rejected.lessons.find(l => l.id === lesson.id)?.status).toBe("rejected");
    expect(rejected.memories.some(m => m.zone === "lesson")).toBe(false);
  });
  it("routes through the process contract without returning raw failure details", async () => {
    const { request } = await fixture(false);
    const cli = path.resolve("packages/cli/dist/index.js");
    const output = execFileSync(process.execPath, [cli, "desktop-bridge"], { input: JSON.stringify(request), encoding: "utf8" });
    expect(JSON.parse(output).projectId).toBe("native-project");
    try {
      execFileSync(process.execPath, [cli, "desktop-bridge"], { input: JSON.stringify({ ...request, target: "owner" }), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
      throw new Error("Expected rejection");
    } catch (error) {
      const failure = error as { stdout: string; stderr: string; status: number };
      expect(failure.status).toBe(3); expect(JSON.parse(failure.stdout).error).toBe("KNOWLEDGE_REQUEST_DENIED");
      expect(failure.stderr).not.toContain(request.sourceRoot);
    }
  });
});
