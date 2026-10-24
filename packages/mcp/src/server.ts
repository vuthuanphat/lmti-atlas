import { buildContextPack, inferIntent } from "@atlas/kernel";
import { checkCompiledAmfFreshness } from "@atlas/compiler";
import { createMemory, readAmfDocument, readContextMemory } from "@atlas/memory";
import type { MemorySensitivity } from "@atlas/types";

export const LMTI_MCP_TOOL_NAMES = [
  "lmti_get_project_context",
  "lmti_get_related_files",
  "lmti_get_memory",
  "lmti_record_task_result"
] as const;

export type LmtiMcpToolName = (typeof LMTI_MCP_TOOL_NAMES)[number];

export interface LmtiMcpServerOptions {
  cwd?: string;
}

export interface ProjectContextInput {
  task: string;
}

export interface RelatedFilesInput {
  task: string;
}

export interface MemoryInput {
  query: string;
}

export interface TaskResultInput {
  task: string;
  summary: string;
  sensitivity?: MemorySensitivity;
}

export function createLmtiMcpStub(options: LmtiMcpServerOptions = {}) {
  const cwd = options.cwd ?? process.cwd();

  return {
    tools: LMTI_MCP_TOOL_NAMES,
    async lmti_get_project_context(input: ProjectContextInput) {
      const amf = await readAmfDocument(undefined, cwd);
      const sourceFreshness = await checkCompiledAmfFreshness(amf, { cwd });
      const inferredIntent = inferIntent(input.task);
      const memorySelection = await readContextMemory(input.task, { cwd, limit: 16, taskIntent: inferredIntent,
        privacyContext: { role: "external_model", projectId: amf.project.name, purpose: "MCP context", command: "context", includeSecret: false, includeRaw: false, timestamp: new Date().toISOString() } });
      return buildContextPack(amf, input.task, {
        memories: memorySelection.results,
        memoriesFilteredOut: memorySelection.filteredOut,
        inferredIntent,
        sourceFreshness,
        memorySource: { source: memorySelection.source, completeness: memorySelection.completeness }
      });
    },
    async lmti_get_related_files(input: RelatedFilesInput) {
      const amf = await readAmfDocument(undefined, cwd);
      const freshness = await checkCompiledAmfFreshness(amf, { cwd });
      // This legacy list-only method cannot carry a freshness warning.
      if (freshness.status !== "fresh") throw new Error("COMPILED_CONTEXT_UNVERIFIED: recompile and use lmti_get_project_context for freshness details.");
      const context = buildContextPack(amf, input.task, { inferredIntent: inferIntent(input.task) });
      return context.relatedFiles;
    },
    async lmti_get_memory(input: MemoryInput) {
      const amf = await readAmfDocument(undefined, cwd);
      return (await readContextMemory(input.query, { cwd, limit: 16,
        privacyContext: { role: "external_model", projectId: amf.project.name, purpose: "MCP memory", command: "context", includeSecret: false, includeRaw: false, timestamp: new Date().toISOString() } })).results;
    },
    async lmti_record_task_result(input: TaskResultInput) {
      return createMemory(
        {
          scope: "long_term",
          kind: "experience",
          title: `Task result: ${input.task.slice(0, 80)}`,
          content: input.summary,
          projectId: "local",
          sourceRefs: [],
          tags: ["task-result"],
          importance: 0.6,
          confidence: "medium",
          sensitivity: input.sensitivity ?? "internal"
        },
        { cwd }
      );
    }
  };
}
