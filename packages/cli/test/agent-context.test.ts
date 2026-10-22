import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { mkdtemp, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { compileProject } from "@atlas/compiler";
import { addProjectMemory, initProjectMemoryStorage, proposeLessonCandidate, readProjectMemorySnapshot, reviewDesktopLesson } from "@atlas/memory";
import { agentContextCommand } from "../src/agent-context";

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "lmti-agent-knowledge-")));
  await mkdir(path.join(root, "src")); await mkdir(path.join(root, "docs")); await mkdir(path.join(root, ".lmti"));
  await writeFile(path.join(root, "src/service.ts"), "export function publicBoundary() { return true; }\n");
  await writeFile(path.join(root, "docs/design.md"), "# Public design\nThe service preserves the reviewed architecture boundary.\n");
  const amf = await compileProject(root);
  // These are the two controlled nonsecret fixture files, explicitly published
  // for the test. The production compiler's internal default is unchanged.
  for (const file of amf.files) file.privacy = "public";
  await writeFile(path.join(root, ".lmti/project.amf.json"), JSON.stringify(amf));
  await initProjectMemoryStorage(root);
  await addProjectMemory({ title: "Reviewed project memory", content: "Preserve the architecture boundary.", zone: "architecture", privacyLevel: "public" }, { cwd: root });
  const sourceId = createHash("sha256").update((process.platform === "win32" ? root.toLowerCase() : root) + "\0" + amf.project.name).digest("hex");
  const request = { schema: "lmti.agent.knowledge.request.v1", operation: "context", projectId: "demo", sourceRoot: root, sourceId,
    target: "external", task: "code document memory", limit: 200, mappings: [
      { kind: "code", referenceKind: "repository", referenceId: "repo", referenceFingerprint: "a".repeat(64), path: "src/service.ts" },
      { kind: "document", referenceKind: "knowledge", referenceId: "design", referenceFingerprint: "b".repeat(64), path: "docs/design.md" },
      { kind: "memory", referenceKind: "component", referenceId: "service", disclosure: "owner_safe_summary" }
    ] };
  return { root, amf, request };
}

describe("agent compiled knowledge owner boundary", () => {
  it("joins public compiled code/documents and explicitly disclosed safe memory summaries without source text or store writes", async () => {
    const { root, request } = await fixture();
    const filename = path.join(root, ".lmti/memory/project-memory.sqlite"), before = await readFile(filename);
    const result = await agentContextCommand(request);
    expect(result.items.map(item => item.kind).sort()).toEqual(["code", "document", "memory"]);
    expect(result.sources.map(source => source.part)).toEqual(["compiled", "memory"]);
    expect(result.items.every(item => item.evidenceId && item.contentFingerprint.length === 64)).toBe(true);
    expect(result.completeness.state).toBe("complete");
    expect(result.classification).toBe("internal");
    expect(result.items.find(item => item.kind === "memory")).toMatchObject({ classification: "internal", disclosure: "owner_safe_summary" });
    expect(JSON.stringify(result)).not.toContain(root);
    expect(JSON.stringify(result)).not.toContain("return true");
    expect(await readFile(filename)).toEqual(before);
    expect((await agentContextCommand(request)).fingerprint).toBe(result.fingerprint);
    expect((await agentContextCommand({ ...request, target: "local" })).items).toEqual(result.items);
  });

  it("requires explicit memory summary disclosure from the trusted mapping", async () => {
    const { request } = await fixture();
    const withoutMemory = await agentContextCommand({ ...request, mappings: request.mappings.filter(row => row.kind !== "memory") });
    expect(withoutMemory.items.map(item => item.kind).sort()).toEqual(["code", "document"]);
    expect(withoutMemory.classification).toBe("public");
    for (const map of [{ kind: "memory", referenceKind: "component", referenceId: "service" },
      { kind: "memory", referenceKind: "component", referenceId: "service", disclosure: "raw" }]) {
      await expect(agentContextCommand({ ...request, mappings: [map] })).rejects.toThrow();
    }
  });

  it("requires pinned owner identity, native typed mappings and bounded task input", async () => {
    const { request } = await fixture();
    for (const change of [{ sourceId: "" }, { sourceId: "0".repeat(64) }, { target: "owner" }, { extra: true }, { limit: 1.2 },
      { task: "token=" + "ghp_" + "a".repeat(36) }, { mappings: [{ ...request.mappings[0], path: "../outside.ts" }] },
      { mappings: [{ ...request.mappings[0], referenceKind: "component" }] }]) {
      await expect(agentContextCommand({ ...request, ...change })).rejects.toThrow();
    }
    const limited = await agentContextCommand({ ...request, limit: 1 });
    expect(limited.items).toHaveLength(1);
    expect(limited.completeness.reasons).toContain("RESULT_LIMIT");
    expect(limited.completeness.nextCursor).toBeNull();
  });

  it("rejects network/device/ADS paths before filesystem lookup", async () => {
    const { request } = await fixture();
    for (const sourceRoot of ["\\\\untrusted.invalid\\share", "//untrusted.invalid/share", "\\\\?\\C:\\source", "C:\\source:stream", "C:\\NUL\\source"]) {
      const access = vi.spyOn(fs, "lstat");
      try {
        await expect(agentContextCommand({ ...request, sourceRoot })).rejects.toThrow("SOURCE_BOUNDARY_DENIED");
        expect(access).not.toHaveBeenCalled();
      } finally { access.mockRestore(); }
    }
  });

  it("never resolves an untrusted AMF declared root through the filesystem", async () => {
    const { root, request, amf } = await fixture();
    const original = fs.realpath;
    for (const field of ["project", "boundary"]) {
      for (const untrusted of ["\\\\untrusted.invalid\\share", "C:\\allowed:stream", "C:\\unrelated-local-root"]) {
        const forged = structuredClone(amf);
        if (field === "project") forged.project.root = untrusted;
        else forged.project.sourceBoundary.root = untrusted;
        await writeFile(path.join(root, ".lmti/project.amf.json"), JSON.stringify(forged));
        const access = vi.spyOn(fs, "realpath").mockImplementation(async filename => {
          if (String(filename) === untrusted) throw new Error("UNTRUSTED_LOOKUP_ATTEMPT");
          return original(filename);
        });
        try {
          await expect(agentContextCommand(request)).rejects.toThrow(field === "project" ? "SOURCE_IDENTITY_DENIED" : "SOURCE_SCHEMA_DENIED");
          expect(access.mock.calls.some(call => String(call[0]) === untrusted)).toBe(false);
        } finally { access.mockRestore(); }
      }
    }
  });

  it("checks classification before file reads and marks stale compiled content as unavailable", async () => {
    const { root, amf, request } = await fixture();
    amf.files.find(row => row.path === "src/service.ts")!.privacy = "internal";
    await writeFile(path.join(root, ".lmti/project.amf.json"), JSON.stringify(amf));
    await writeFile(path.join(root, "src/service.ts"), "token=" + "ghp_" + "a".repeat(36));
    const denied = await agentContextCommand(request);
    expect(denied.items.some(row => row.kind === "code")).toBe(false);
    expect(denied.completeness.reasons).toContain("MAPPED_CONTENT_UNAVAILABLE");
    amf.files.find(row => row.path === "src/service.ts")!.privacy = "public";
    await writeFile(path.join(root, ".lmti/project.amf.json"), JSON.stringify(amf));
    await writeFile(path.join(root, "src/service.ts"), "export function changedBoundary() { return false; }\n");
    const stale = await agentContextCommand(request);
    expect(stale.items.some(row => row.kind === "code")).toBe(false);
    expect(stale.completeness.reasons).toContain("COMPILED_CONTENT_STALE");
  });

  it("treats source ignore-policy changes as revocation before content export", async () => {
    const { root, request } = await fixture();
    await writeFile(path.join(root, ".lmtiignore"), "src/\n");
    await expect(agentContextCommand(request)).rejects.toThrow("SOURCE_POLICY_DENIED");
  });

  it("never exposes pending lessons/private memory and includes a lesson only after owner review", async () => {
    const { root, request } = await fixture();
    await addProjectMemory({ title: "HiddenMarker", content: "Private knowledge.", privacyLevel: "private" }, { cwd: root });
    const candidate = await proposeLessonCandidate({ observation: {
      taskId: "safe-task", taskTitle: "Validate boundary", taskSummary: "Retain reviewed source identity.",
      filesTouched: [{ path: "src/service.ts", changeType: "modified", changeSummary: "Validated boundary." }],
      commandsRun: [{ command: "synthetic-test", exitCode: 0, status: "pass", outputRedacted: true }],
      tests: [{ name: "boundary", status: "pass" }], decisions: [], outcome: "pass"
    }, agentProposedLesson: "Keep deliberate memory inside its authorized owner boundary." }, { cwd: root });
    const before = await agentContextCommand(request);
    expect(JSON.stringify(before)).not.toContain("HiddenMarker");
    expect(before.items.some(item => item.semantics === "reviewed_memory")).toBe(false);
    const snapshot = await readProjectMemorySnapshot(root);
    const review = snapshot.lessons.find(row => row.id === candidate.candidate.id)!;
    await reviewDesktopLesson(root, review.id, review.fingerprint, "approve");
    const after = await agentContextCommand(request);
    expect(after.items.some(item => item.semantics === "reviewed_memory")).toBe(true);
    expect(after.items.find(item => item.semantics === "reviewed_memory")).toMatchObject({ classification: "internal", disclosure: "owner_safe_summary" });
    expect(after.sources.find(source => source.part === "memory")!.version).not.toBe(before.sources.find(source => source.part === "memory")!.version);
  });

  it("rejects escaping mappings and ambiguous AMF records", async () => {
    const { root, amf, request } = await fixture(), outside = await fixture();
    await symlink(path.join(outside.root, "src"), path.join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    amf.files.push({ ...amf.files.find(row => row.path === "src/service.ts")!, path: "linked/service.ts" });
    await writeFile(path.join(root, ".lmti/project.amf.json"), JSON.stringify(amf));
    await expect(agentContextCommand({ ...request, mappings: [{ ...request.mappings[0], path: "linked/service.ts" }] })).rejects.toThrow("SOURCE_BOUNDARY_DENIED");
    amf.files.push(amf.files[0]);
    await writeFile(path.join(root, ".lmti/project.amf.json"), JSON.stringify(amf));
    await expect(agentContextCommand(request)).rejects.toThrow("SOURCE_SCHEMA_DENIED");
  });
});
