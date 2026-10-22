import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { readProjectMemorySnapshot, reviewDesktopLesson } from "@atlas/memory";
import { redactText, runEgressSecretScan } from "@atlas/privacy";

const schema = "lmti.desktop.knowledge.v1";
const operations = ["snapshot", "context", "approve", "reject"];
const categories = ["modules", "files", "architecture", "rules", "summaries"];
const limit = 200;
type JsonObject = Record<string, unknown>;
function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_REQUEST");
  return value as JsonObject;
}
function string(value: unknown, max = 512): string {
  if (typeof value !== "string" || value.length > max || /[\x00-\x1f]/u.test(value)) throw new Error("INVALID_REQUEST");
  return value;
}
function canonical(value: string): string { return process.platform === "win32" ? value.toLowerCase() : value; }
function safe(value: unknown, max = 2000): string { return redactText(typeof value === "string" ? value : "").slice(0, max); }
async function checkedFile(root: string, relative: string, maxBytes: number, optional = false) {
  const filename = path.join(root, relative);
  let resolved: string;
  try { resolved = await fs.realpath(filename); } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("SOURCE_UNAVAILABLE");
  }
  const rel = path.relative(root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("SOURCE_BOUNDARY_DENIED");
  const stat = await fs.stat(resolved);
  if (!stat.isFile() || stat.size > maxBytes) throw new Error("SOURCE_SIZE_DENIED");
  return resolved;
}

// Fixed operation boundary for a trusted local desktop. This does not replace
// Agent grants or native project identity with an AMF name or a library folder.
export async function desktopBridgeCommand(input: unknown, options: {
  allowLessonReview?: boolean;
  route?: (root: string, task: string) => Promise<unknown>;
} = {}) {
  const request = object(input);
  if (Object.keys(request).some(key => !["schema", "operation", "projectId", "sourceRoot", "sourceId", "target", "task", "lessonId", "fingerprint", "reviewed"].includes(key))) throw new Error("INVALID_REQUEST");
  if (request.schema !== schema || !operations.includes(string(request.operation, 16)) || request.target !== "external") throw new Error("GRANT_DENIED");
  const projectId = string(request.projectId, 120);
  if (!/^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/u.test(projectId)) throw new Error("INVALID_PROJECT_ID");
  const selectedRoot = string(request.sourceRoot, 4096);
  if (!path.isAbsolute(selectedRoot)) throw new Error("SOURCE_BOUNDARY_DENIED");
  const root = await fs.realpath(selectedRoot);
  const amfFile = await checkedFile(root, ".lmti/project.amf.json", 2 * 1024 * 1024);
  const amf = object(JSON.parse(await fs.readFile(amfFile!, "utf8")));
  const project = object(amf.project);
  if (amf.version !== "0.1.0" || typeof project.name !== "string" || !project.name || typeof project.root !== "string" || canonical(await fs.realpath(project.root)) !== canonical(root)) throw new Error("SOURCE_IDENTITY_DENIED");
  const sourceId = createHash("sha256").update(canonical(root) + "\0" + project.name).digest("hex");
  if (request.sourceId !== "" && request.sourceId !== sourceId) throw new Error("SOURCE_IDENTITY_DENIED");
  if (request.operation !== "snapshot" && request.sourceId !== sourceId) throw new Error("SOURCE_IDENTITY_DENIED");
  const task = request.operation === "context" ? string(request.task, 1000).trim() : "";
  if (request.operation === "context" && (!task || runEgressSecretScan(task).blocked || redactText(task) !== task)) throw new Error("TASK_PRIVACY_DENIED");
  // Only the memory owner opens SQLite. The path must resolve inside the source.
  await checkedFile(root, ".lmti/memory/project-memory.sqlite", 128 * 1024 * 1024, true);
  await checkedFile(root, ".lmti/memory/project-memory.sqlite-wal", 128 * 1024 * 1024, true);
  await checkedFile(root, ".lmti/memory/project-memory.sqlite-shm", 16 * 1024 * 1024, true);
  if (request.operation === "approve" || request.operation === "reject") {
    if (!options.allowLessonReview || request.reviewed !== true) throw new Error("REVIEW_GRANT_DENIED");
    const lessonId = string(request.lessonId, 120), fingerprint = string(request.fingerprint, 64);
    if (!/^[a-zA-Z0-9._-]+$/u.test(lessonId) || !/^[a-f0-9]{64}$/u.test(fingerprint)) throw new Error("INVALID_REQUEST");
    await reviewDesktopLesson(root, lessonId, fingerprint, request.operation);
  }
  const memory = await readProjectMemorySnapshot(root, task);
  const query = task.toLowerCase().split(/\s+/u).filter(Boolean);
  let truncated = memory.truncated;
  const projectMap: Array<{ kind: string; title: string; summary: string }> = [];
  for (const category of categories) {
    if (!Array.isArray(amf[category])) throw new Error("SOURCE_SCHEMA_DENIED");
    for (const raw of amf[category] as unknown[]) {
      const item = object(raw);
      // Fail closed for AMF entries without an explicit public classification.
      if (item.privacy !== "public") continue;
      const title = safe(item.name ?? item.target ?? item.id, 240), summary = safe(item.summary ?? item.description);
      if (!summary || (query.length && !query.some(word => `${title} ${summary}`.toLowerCase().includes(word)))) continue;
      if (projectMap.length >= limit) { truncated = true; break; }
      projectMap.push({ kind: category, title, summary });
    }
  }
  let skill: unknown = { decision: task ? "not_connected" : "not_requested" };
  if (task && options.route && await checkedFile(root, "skills/registry.toml", 256 * 1024, true)) {
    const routed = object(await options.route(root, task)), result = object(routed.result);
    const selected = result.selectedSkill ? object(result.selectedSkill) : undefined;
    skill = { decision: safe(result.decision, 80), selected: selected ? safe(selected.name, 120) : "", requiresPolicy: result.requiresPolicy === true, executed: false };
  }
  const context = task ? JSON.stringify({ schema, projectId, sourceId, target: "external", task, projectMap, memories: memory.memories, skill, truncated }, null, 2) : "";
  const response = { schema, projectId, sourceId, target: "external", sourceName: safe(project.name, 240), compiledAt: safe(project.compiledAt, 80),
    memoryConnected: memory.connected, projectMap, memories: memory.memories, lessons: memory.lessons,
    canReview: options.allowLessonReview === true, truncated, skill, context, fetchedAt: new Date().toISOString() };
  const encoded = JSON.stringify(response);
  if (Buffer.byteLength(encoded) > 2 * 1024 * 1024 || runEgressSecretScan(encoded).blocked) throw new Error("OUTPUT_POLICY_DENIED");
  return response;
}

export async function readDesktopRequest(): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += Buffer.byteLength(chunk);
    if (length > 16 * 1024) throw new Error("REQUEST_SIZE_DENIED");
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
