import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();

describe("neural architecture boundaries", () => {
  it("keeps runtime as orchestration over kernel, cognition, memory, privacy, and security", () => {
    const source = readText("packages/runtime/src/demo-runtime.ts");
    const agentSource = readText("packages/runtime/src/agent.ts");
    const compatibilitySource = readText("packages/runtime/src/index.ts");
    const manifest = readJson("packages/runtime/package.json");

    expect(agentSource).toContain('export { buildContextPack, formatInspection, inspectAmf } from "@atlas/kernel";');
    expect(agentSource).not.toMatch(/@atlas\/(agents|tools|context|security)|demo-runtime/);
    expect(compatibilitySource).toContain('export * from "./demo-runtime";');
    expect(source).toContain('import { inferIntent } from "@atlas/kernel";');
    expect(source).toContain('import { memorySearchResultsToCognitiveItems, runCognitiveCycle } from "@atlas/cognition";');
    expect(source).toContain('import { redactText } from "@atlas/privacy";');
    expect(source).not.toMatch(/export function buildContextPack|function scoreText|function tokenize/);
    expect(Object.keys(manifest.dependencies)).toEqual(
      expect.arrayContaining(["@atlas/kernel", "@atlas/cognition", "@atlas/memory", "@atlas/privacy", "@atlas/security"])
    );
  });

  it("keeps CLI cognition and world-model conversion in domain packages", () => {
    const source = readTypeScriptTree("packages/cli/src");
    const cognition = readText("packages/cli/src/commands/cognition.ts");
    const world = readText("packages/cli/src/commands/world.ts");

    expect(source).toContain('from "@atlas/runtime/agent";');
    expect(source).not.toContain('from "@atlas/runtime";');

    expect(cognition).toContain('import { contextPackToCognitiveItems, runCognitiveCycle } from "@atlas/cognition";');
    expect(world).toContain('from "@atlas/world-model";');
    for (const conversion of ["contextPackToBeliefs", "contextPackToSensoryInputs", "estimateComputeCost", "runWorldModelCycle"]) {
      expect(world).toMatch(new RegExp(`import \\{[^}]*\\b${conversion}\\b[^}]*\\} from "@atlas/world-model";`));
    }
    expect(source).not.toMatch(/function contextPackToCognitiveItems|function contextPackToSensoryInputs|function confidenceWeight/);
  });

  it("keeps workspace package dependencies acyclic", () => {
    const graph = loadWorkspaceDependencyGraph();
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const stack: string[] = [];

    function visit(node: string): void {
      if (visited.has(node)) {
        return;
      }
      if (visiting.has(node)) {
        const cycleStart = stack.indexOf(node);
        throw new Error(`Workspace dependency cycle: ${[...stack.slice(cycleStart), node].join(" -> ")}`);
      }
      visiting.add(node);
      stack.push(node);
      for (const dependency of graph.get(node) ?? []) {
        visit(dependency);
      }
      stack.pop();
      visiting.delete(node);
      visited.add(node);
    }

    for (const node of graph.keys()) {
      visit(node);
    }

    expect(visited.size).toBe(graph.size);
  });
});

function readText(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function readTypeScriptTree(relativeDirectory: string): string {
  return readdirSync(path.join(repoRoot, relativeDirectory), { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap(entry => {
      const relative = path.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) return [readTypeScriptTree(relative)];
      return entry.isFile() && entry.name.endsWith(".ts") ? [readText(relative)] : [];
    }).join("\n");
}

function readJson(relativePath: string): { name: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> } {
  return JSON.parse(readText(relativePath));
}

function loadWorkspaceDependencyGraph(): Map<string, string[]> {
  const packagesDir = path.join(repoRoot, "packages");
  const manifests = readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join("packages", entry.name, "package.json"))
    .filter((relativePath) => existsSync(path.join(repoRoot, relativePath)))
    .map((relativePath) => readJson(relativePath));
  const packageNames = new Set(manifests.map((manifest) => manifest.name));
  const graph = new Map<string, string[]>();

  for (const manifest of manifests) {
    const dependencies = Object.keys({ ...(manifest.dependencies ?? {}), ...(manifest.devDependencies ?? {}) }).filter((dependency) => packageNames.has(dependency));
    graph.set(manifest.name, dependencies);
  }

  return graph;
}
