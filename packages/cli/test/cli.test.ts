import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createMemory } from "@atlas/memory";
import { attachCodex, benchmarkPreflightCommand, compileCommand, contextCommand, doctorSecurityCommand, initCommand, main, preflightCommand, publishPreflightCommand, rememberCommand, taskDoneCommand, thinkingExperimentCommand } from "../src/index";

const githubTokenFixture = ["ghp", "abcdefghijklmnopqrstuvwxyz123456"].join("_");

async function createFixtureProject(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "lmti-cli-"));
  await mkdir(path.join(root, "src", "orders"), { recursive: true });
  await mkdir(path.join(root, "database"), { recursive: true });
  await mkdir(path.join(root, "docs"), { recursive: true });

  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "lmti-fixture", private: true }, null, 2),
    "utf8"
  );
  await writeFile(
    path.join(root, "README.md"),
    "# Fixture\n\nBusiness rule: packing labels must include destination.\n",
    "utf8"
  );
  await writeFile(
    path.join(root, "src", "orders", "packing.ts"),
    [
      "export function printPackingLabel(destination: string): string {",
      "  if (!destination) throw new Error('Destination required');",
      "  return `DEST=${destination}`;",
      "}"
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    path.join(root, "database", "schema.sql"),
    ["CREATE TABLE packing_labels (", "  id INTEGER PRIMARY KEY,", "  destination TEXT NOT NULL", ");"].join("\n"),
    "utf8"
  );
  for (let index = 0; index < 16; index += 1) {
    await writeFile(path.join(root, "docs", `packing-note-${index}.md`), `# Packing note ${index}\n`, "utf8");
  }

  return root;
}

async function writeLegacyAmf(filePath: string, name: string): Promise<void> {
  await writeFile(
    filePath,
    JSON.stringify(
      {
        version: "0.1.0",
        generatedAt: "2026-06-28T00:00:00.000Z",
        project: {
          name,
          root: "/legacy",
          compiledAt: "2026-06-28T00:00:00.000Z",
          atlasVersion: "0.0.0",
          amfVersion: "0.1.0",
          compiler: {
            name: "Legacy Atlas compiler",
            version: "0.0.1"
          },
          sourceBoundary: {
            root: "/legacy",
            ignoredDirectories: [],
            ignoredFiles: [],
            maxFileBytes: 1024
          },
          checksum: "legacy"
        },
        modules: [],
        files: [],
        symbols: [],
        dependencies: [],
        api: [],
        database: [],
        rules: [],
        risks: [],
        history: [],
        architecture: [],
        summaries: [],
        unresolvedQuestions: []
      },
      null,
      2
    ),
    "utf8"
  );
}

async function runCliInFixture(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const originalCwd = process.cwd();
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalExitCode = process.exitCode;
  const stdout: string[] = [];
  const stderr: string[] = [];
  process.exitCode = undefined;

  console.log = (...values: unknown[]) => {
    stdout.push(values.map(String).join(" "));
  };
  console.warn = (...values: unknown[]) => {
    stderr.push(values.map(String).join(" "));
  };

  let exitCode = 0;
  try {
    if (args[0] === "actions") {
      await main(args, { cwd });
    } else {
      process.chdir(cwd);
      await main(args);
    }
  } finally {
    exitCode = typeof process.exitCode === "number" ? process.exitCode : 0;
    process.chdir(originalCwd);
    console.log = originalLog;
    console.warn = originalWarn;
    process.exitCode = originalExitCode;
  }

  return { stdout: stdout.join("\n"), stderr: stderr.join("\n"), exitCode };
}

async function createSkillFixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "lmti-skill-"));
  await mkdir(path.join(root, "skills", "publish-preflight"), { recursive: true });
  await mkdir(path.join(root, "skills", "repo-cleanup"), { recursive: true });
  await writeFile(
    path.join(root, "skills", "registry.toml"),
    [
      "[[skills]]",
      'id = "publish-preflight"',
      'name = "Publish Preflight"',
      'description = "Check Git, branch, remote, protected files, and repository identity before publishing."',
      'file = "skills/publish-preflight/skill.md"',
      'intents = ["publish", "push", "pull_request", "open_source", "release"]',
      "requires_policy = true",
      "requires_memory = false",
      'risk_level = "high"',
      "",
      "[[skills]]",
      'id = "repo-cleanup"',
      'name = "Repo Cleanup"',
      'description = "Plan and apply safe repository cleanup without deleting protected knowledge."',
      'file = "skills/repo-cleanup/skill.md"',
      'intents = ["cleanup", "refactor", "remove_unused", "organize_repo"]',
      "requires_policy = true",
      "requires_memory = true",
      'risk_level = "medium"',
      ""
    ].join("\n"),
    "utf8"
  );
  const skillBody = (name: string) => [
    `# Skill: ${name}`,
    "",
    "## Purpose",
    `Use ${name}.`,
    "",
    "## When to use",
    "Use when the task matches the skill.",
    "",
    "## Inputs needed",
    "Task request.",
    "",
    "## Required commands",
    "Run safe checks only.",
    "",
    "## Safety rules",
    "Do not print secrets.",
    "",
    "## Block conditions",
    "Stop on protected data.",
    "",
    "## Output expected",
    "Return a concise summary.",
    "",
    "## Notes",
    "Fixture skill."
  ].join("\n");
  await writeFile(path.join(root, "skills", "publish-preflight", "skill.md"), skillBody("Publish Preflight"), "utf8");
  await writeFile(path.join(root, "skills", "repo-cleanup", "skill.md"), skillBody("Repo Cleanup"), "utf8");
  return root;
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

async function createPublishGitFixture(publicRepo?: string): Promise<{ worktree: string; remote: string; publicRepo: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "lmti-publish-"));
  const worktree = path.join(root, "worktree");
  const remote = publicRepo ?? "https://github.com/vuthuanphat/lmti-atlas.git";

  runGit(root, ["init", worktree]);
  runGit(worktree, ["config", "user.email", "lmti-test@example.com"]);
  runGit(worktree, ["config", "user.name", "LMTI Test"]);
  const targetRepo = remote;

  await mkdir(path.join(worktree, ".lmti"), { recursive: true });
  await writeFile(
    path.join(worktree, "package.json"),
    JSON.stringify(
      {
        name: "lmti-publish-fixture",
        description: "LMTI publish fixture.",
        author: "Edgar Vu - Cyno Software",
        license: "MIT",
        repository: { type: "git", url: targetRepo }
      },
      null,
      2
    ),
    "utf8"
  );
  await writeFile(
    path.join(worktree, ".lmti", "layer.json"),
    JSON.stringify(
      {
        name: "LMTI",
        type: "independent_agent_layer",
        publish_repository: targetRepo
      },
      null,
      2
    ),
    "utf8"
  );
  await writeFile(path.join(worktree, "README.md"), "# LMTI publish fixture\n", "utf8");
  await writeFile(path.join(worktree, "LICENSE"), "MIT\n", "utf8");
  await writeFile(path.join(worktree, "SECURITY.md"), "# Security\n\nReport privately.\n", "utf8");
  runGit(worktree, ["add", "."]);
  runGit(worktree, ["commit", "-m", "init fixture"]);
  runGit(worktree, ["branch", "-M", "main"]);
  runGit(worktree, ["remote", "add", "origin", targetRepo]);
  runGit(worktree, ["update-ref", "refs/remotes/origin/main", "HEAD"]);

  return { worktree, remote, publicRepo: targetRepo };
}

describe("LMTI CLI commands", () => {
  it("init creates .lmti structure", async () => {
    const cwd = await createFixtureProject();
    const storage = await initCommand(cwd);

    expect(storage.atlasDir.endsWith(".lmti")).toBe(true);
    await expect(readFile(path.join(cwd, ".lmti", "config.json"), "utf8")).resolves.toContain("\"kernel\": \"atlas\"");
    await expect(readFile(path.join(cwd, ".lmti", "project.amf.json"), "utf8")).resolves.toContain("\"version\": \"0.1.0\"");
    await expect(readFile(path.join(cwd, ".lmti", "memory", "long-term.json"), "utf8")).resolves.toBe("[]");
    expect((await stat(path.join(cwd, ".lmti", "experiments"))).isDirectory()).toBe(true);
  });

  it("compile creates project.amf.json", async () => {
    const cwd = await createFixtureProject();
    await initCommand(cwd);
    const { amf } = await compileCommand(cwd);

    expect(amf.project.name).toBe("lmti-fixture");
    await expect(readFile(path.join(cwd, ".lmti", "project.amf.json"), "utf8")).resolves.toContain("packing_labels");
  });

  it("compile migrates legacy Atlas storage before writing canonical AMF", async () => {
    const cwd = await createFixtureProject();
    await mkdir(path.join(cwd, ".atlas"), { recursive: true });
    await writeLegacyAmf(path.join(cwd, ".atlas", "project.amf.json"), "legacy-fixture");

    const { warnings } = await compileCommand(cwd);

    expect(warnings.join("\n")).toContain("migrated to .lmti before compile");
    await expect(stat(path.join(cwd, ".atlas", "project.amf.json"))).resolves.toBeTruthy();
    const logs = await readdir(path.join(cwd, ".lmti", "logs"));
    expect(logs.some((file) => file.startsWith("migration-") && file.endsWith(".json"))).toBe(true);
  });

  it("compile warns and keeps .lmti canonical when legacy storage also exists", async () => {
    const cwd = await createFixtureProject();
    await initCommand(cwd);
    await mkdir(path.join(cwd, ".atlas"), { recursive: true });
    await writeLegacyAmf(path.join(cwd, ".atlas", "project.amf.json"), "legacy-fixture");

    const { warnings } = await compileCommand(cwd);

    expect(warnings.join("\n")).toContain("using .lmti/project.amf.json as canonical");
  });

  it("attach codex creates AGENTS.md and is idempotent", async () => {
    const cwd = await createFixtureProject();

    await attachCodex(cwd);
    await attachCodex(cwd);

    const agents = await readFile(path.join(cwd, "AGENTS.md"), "utf8");
    expect(agents).toContain("## LMTI - Atlas Integration");
    expect(agents.match(/## LMTI - Atlas Integration/g)).toHaveLength(1);
    expect(agents).toContain("lmti publish preflight");
    expect(agents).toContain("Never move/import .lmti into host application runtime");
    expect(agents).toContain("When developing LMTI itself");
  });

  it("attach codex preserves existing AGENTS.md content", async () => {
    const cwd = await createFixtureProject();
    await writeFile(path.join(cwd, "AGENTS.md"), "# Existing Guidance\n\nDo not remove this.\n", "utf8");

    await attachCodex(cwd);

    const agents = await readFile(path.join(cwd, "AGENTS.md"), "utf8");
    expect(agents).toContain("# Existing Guidance");
    expect(agents).toContain("Do not remove this.");
    expect(agents).toContain("lmti context \"<task>\"");
  });

  it("context command reads AMF and memory", async () => {
    const cwd = await createFixtureProject();
    await compileCommand(cwd);
    await createMemory(
      {
        scope: "long_term",
        kind: "rule",
        title: "Packing label rule",
        content: "Packing labels must include destination.",
        projectId: "lmti-fixture",
        sourceRefs: ["README.md:3"],
        tags: ["packing"],
        importance: 0.8,
        confidence: "high",
        sensitivity: "internal"
      },
      { cwd }
    );

    const context = await contextCommand(cwd, "fix packing label bug");

    expect(context.project).toBe("lmti-fixture");
    expect(context.relatedDatabase.some((entry) => entry.name === "packing_labels")).toBe(true);
    expect(context.relatedLongTermMemories.some((memory) => memory.title === "Packing label rule")).toBe(true);
  });

  it("context command uses intent to return partner permission lessons and filter logo memory", async () => {
    const cwd = await createFixtureProject();
    await compileCommand(cwd);
    await createMemory(
      {
        scope: "long_term",
        kind: "lesson",
        title: "Partner route rule",
        content: "Partner user must route to /partner. /dashboard/summary returning 403 is correct due to least privilege.",
        projectId: "lmti-fixture",
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
        projectId: "lmti-fixture",
        sourceRefs: [],
        tags: ["dashboard", "logo", "brand", "asset"],
        importance: 0.9,
        confidence: "high",
        sensitivity: "internal",
        promptPolicy: "summarize_only"
      },
      { cwd }
    );

    const context = await contextCommand(cwd, "partner user gets 403 dashboard summary");

    expect(context.inferredIntent.primaryIntent).toBe("permission");
    expect(context.inferredIntent.secondaryIntents).toContain("partner");
    expect(context.inferredIntent.secondaryIntents).toContain("dashboard");
    expect(context.relatedLongTermMemories.some((memory) => memory.title === "Partner route rule" && memory.mode === "summary")).toBe(true);
    expect(context.relatedLongTermMemories.some((memory) => memory.title === "Dashboard logo rule")).toBe(false);
    expect(JSON.stringify(context)).not.toContain("/dashboard/summary returning 403 is correct");
  });

  it("context command fails gracefully before compile", async () => {
    const cwd = await createFixtureProject();
    await initCommand(cwd);

    await expect(contextCommand(cwd, "fix packing label bug")).rejects.toThrow("Run `lmti compile` first");
  });

  it("context command does not expose secret memory", async () => {
    const cwd = await createFixtureProject();
    await compileCommand(cwd);
    await createMemory(
      {
        scope: "long_term",
        kind: "risk",
        title: "Secret deployment token",
        content: "super-secret-token-value",
        projectId: "lmti-fixture",
        sourceRefs: [],
        tags: ["secret"],
        importance: 1,
        confidence: "high",
        sensitivity: "secret"
      },
      { cwd }
    );

    const context = await contextCommand(cwd, "secret deployment token");

    expect(JSON.stringify(context)).not.toContain("super-secret-token-value");
    expect(context.relatedLongTermMemories).toHaveLength(0);
  });

  it("preflight hard gates blocked memory before policy-safe ranking", async () => {
    const cwd = await createFixtureProject();
    await compileCommand(cwd);
    await createMemory(
      {
        scope: "long_term",
        kind: "route",
        title: "Dashboard Agent public route",
        content: "Dashboard Agent summary route is /dashboard/summary.",
        projectId: "lmti-fixture",
        sourceRefs: ["README.md:3"],
        tags: ["dashboard", "agent", "route"],
        importance: 0.9,
        confidence: "high",
        sensitivity: "public",
        promptPolicy: "allow_raw"
      },
      { cwd }
    );
    await createMemory(
      {
        scope: "long_term",
        kind: "risk",
        title: "Secret dashboard token",
        content: "token=super-secret-dashboard-value",
        projectId: "lmti-fixture",
        sourceRefs: ["README.md:3"],
        tags: ["dashboard", "agent", "secret"],
        importance: 1,
        confidence: "high",
        sensitivity: "secret",
        promptPolicy: "allow_raw"
      },
      { cwd }
    );
    await createMemory(
      {
        scope: "long_term",
        kind: "route",
        title: "Deprecated dashboard route",
        content: "Deprecated route says Agent dashboard must use /old-dashboard.",
        projectId: "lmti-fixture",
        sourceRefs: ["README.md:3"],
        tags: ["dashboard", "agent", "deprecated"],
        importance: 1,
        confidence: "high",
        sensitivity: "public",
        promptPolicy: "allow_raw"
      },
      { cwd }
    );
    await createMemory(
      {
        scope: "long_term",
        kind: "permission",
        title: "Internal dashboard permission note",
        content: "Internal permission note for permission routing.",
        projectId: "lmti-fixture",
        sourceRefs: ["README.md:3"],
        tags: ["dashboard", "agent", "permission"],
        importance: 1,
        confidence: "high",
        sensitivity: "internal",
        promptPolicy: "summarize_only"
      },
      { cwd }
    );

    const result = await preflightCommand(cwd, "permission routing issue", {
      role: "developer",
      modelTarget: "external_model",
      now: new Date("2026-06-28T00:00:00.000Z")
    });

    expect(result.observerFrame.effectiveContextRole).toBe("external_model");
    expect(result.selectedMemories.map((memory) => memory.metadata.title)).toContain("Dashboard Agent public route");
    expect(result.selectedMemories.some((memory) => memory.metadata.title === "Internal dashboard permission note" && memory.mode === "summary")).toBe(true);
    expect(result.blockedMemories.map((memory) => memory.reason)).toEqual(
      expect.arrayContaining(["secret", "deprecated_as_truth"])
    );
    expect(result.finalContextPackage.policyDecisionIds).toEqual(result.selectedMemories.map((memory) => memory.policyDecisionId));
    expect(result.egress.blocked).toBe(false);
    expect(result.adapterSandbox.allowed).toBe(true);
    expect(result.adapterSandbox.deliveredContextPackageId).toBe(result.finalContextPackage.id);
    expect(JSON.stringify(result)).not.toContain("super-secret-dashboard-value");
    expect(JSON.stringify(result)).not.toContain("/old-dashboard");
    expect(result.explanation.blockedMemories.every((memory) => !memory.safeSummary.includes("super-secret-dashboard-value"))).toBe(true);
  });

  it("preflight blocks adapter manifests that request memory store scope", async () => {
    const cwd = await createFixtureProject();
    await compileCommand(cwd);
    await writeFile(
      path.join(cwd, "bad-adapter.json"),
      JSON.stringify(
        {
          id: "bad-plugin",
          name: "Bad Plugin",
          version: "0.1.0",
          kind: "plugin",
          scopes: ["context:read", "memory:read"],
          sandbox: {
            network: false,
            filesystem: "none",
            allowMemoryStore: true,
            timeoutMs: 1000
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const result = await preflightCommand(cwd, "fix packing label bug", {
      flags: { "adapter-manifest": "bad-adapter.json" },
      now: new Date("2026-06-28T00:00:00.000Z")
    });

    expect(result.adapterSandbox.allowed).toBe(false);
    expect(result.adapterSandbox.deniedReasons).toEqual(
      expect.arrayContaining(["forbidden_scope_memory:read", "direct_memory_store_access_forbidden"])
    );
    expect(result.adapterSandbox.deliveredContextPackageId).toBeUndefined();
    expect(result.predictedFailures.some((failure) => failure.includes("adapter sandbox blocked"))).toBe(true);
  });

  it("preflight applies adapter privacy profiles and denies raw sensitive adapter output", async () => {
    const cwd = await createFixtureProject();
    await compileCommand(cwd);
    await writeFile(
      path.join(cwd, "unsafe-adapter.json"),
      JSON.stringify(
        {
          id: "unsafe-model",
          name: "Unsafe Model",
          version: "0.1.0",
          kind: "model",
          scopes: ["context:read"],
          privacy: {
            allowRawSecret: true,
            allowRawConfidential: true,
            requiresEgressScan: false,
            defaultModelTarget: "external_model"
          },
          sandbox: {
            network: false,
            filesystem: "none",
            allowMemoryStore: false,
            timeoutMs: 1000
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const result = await preflightCommand(cwd, "fix packing label bug", {
      flags: { "adapter-manifest": "unsafe-adapter.json" },
      now: new Date("2026-06-28T00:00:00.000Z")
    });

    expect(result.adapterSandbox.allowed).toBe(false);
    expect(result.adapterSandbox.manifest.privacy).toMatchObject({
      allowRawSecret: true,
      allowRawConfidential: true,
      requiresEgressScan: false,
      defaultModelTarget: "external_model"
    });
    expect(result.adapterSandbox.deniedReasons).toEqual(
      expect.arrayContaining(["egress_scan_required", "raw_secret_adapter_output_forbidden", "raw_confidential_adapter_output_forbidden"])
    );
  });

  it("known adapters default to external policy-safe output", async () => {
    const cwd = await createFixtureProject();
    await compileCommand(cwd);
    const result = await preflightCommand(cwd, "fix packing label bug", {
      flags: { adapter: "codex" },
      now: new Date("2026-06-28T00:00:00.000Z")
    });

    expect(result.request.modelTarget).toBe("external_model");
    expect(result.adapterSandbox.manifest.privacy).toMatchObject({
      allowRawSecret: false,
      allowRawConfidential: false,
      requiresEgressScan: true,
      defaultModelTarget: "external_model"
    });
  });

  it("publish preflight passes for a clean branch on the configured repo", async () => {
    const { worktree, publicRepo } = await createPublishGitFixture();

    const result = await publishPreflightCommand(worktree, { publicRepo });

    expect(result.result).toBe("pass");
    expect(result.exitCode).toBe(0);
    expect(result.checks.find((check) => check.name === "remote_origin")?.status).toBe("pass");
    expect(result.checks.find((check) => check.name === "git_history")?.status).toBe("pass");
    expect(result.checks.find((check) => check.name === "protected_files")?.status).toBe("pass");
  }, 15_000);

  it("publish preflight exposes JSON output for automation", async () => {
    const { worktree } = await createPublishGitFixture();

    const { stdout } = await runCliInFixture(worktree, ["publish", "preflight", "--json"]);
    const parsed = JSON.parse(stdout) as { schemaVersion: string; command: string; status: string; data: { exitCode: number } };

    expect(parsed.schemaVersion).toBe("lmti.cli.v1");
    expect(parsed.command).toBe("lmti.publish.preflight");
    expect(parsed.status).toBe("pass");
    expect(parsed.data.exitCode).toBe(0);
  }, 15_000);

  it("publish check is a safe alias for publish preflight", async () => {
    const { worktree } = await createPublishGitFixture();

    const preflight = await runCliInFixture(worktree, ["publish", "preflight", "--json"]);
    const check = await runCliInFixture(worktree, ["publish", "check", "--json"]);
    const parsedPreflight = JSON.parse(preflight.stdout) as { command: string; status: string; data: { result: string } };
    const parsedCheck = JSON.parse(check.stdout) as { command: string; status: string; data: { result: string } };

    expect(check.exitCode).toBe(preflight.exitCode);
    expect(parsedCheck.command).toBe("lmti.publish.preflight");
    expect(parsedCheck.status).toBe(parsedPreflight.status);
    expect(parsedCheck.data.result).toBe(parsedPreflight.data.result);
  }, 15_000);

  it("publish preflight blocks a wrong origin remote", async () => {
    const publicRepo = "https://github.com/vuthuanphat/lmti-atlas.git";
    const { worktree } = await createPublishGitFixture(publicRepo);
    runGit(worktree, ["remote", "set-url", "origin", "https://github.com/vuthuanphat6-byte/atlas.git"]);

    const result = await publishPreflightCommand(worktree, { publicRepo });

    expect(result.result).toBe("blocked");
    expect(result.exitCode).toBe(2);
    expect(result.checks.find((check) => check.name === "remote_origin")?.status).toBe("error");
  }, 15_000);

  it("publish preflight JSON errors include stable error codes", async () => {
    const publicRepo = "https://github.com/vuthuanphat/lmti-atlas.git";
    const { worktree } = await createPublishGitFixture(publicRepo);
    runGit(worktree, ["remote", "set-url", "origin", "https://github.com/vuthuanphat6-byte/atlas.git"]);

    const { stdout } = await runCliInFixture(worktree, ["publish", "preflight", "--json"]);
    const parsed = JSON.parse(stdout) as { status: string; errors: Array<{ code: string; message: string }> };

    expect(parsed.status).toBe("blocked");
    expect(parsed.errors.map((error) => error.code)).toContain("REMOTE_ORIGIN_MISMATCH");
  }, 15_000);

  it("publish check blocked results return exit code 2", async () => {
    const publicRepo = "https://github.com/vuthuanphat/lmti-atlas.git";
    const { worktree } = await createPublishGitFixture(publicRepo);
    runGit(worktree, ["remote", "set-url", "origin", "https://github.com/vuthuanphat6-byte/atlas.git"]);

    const result = await runCliInFixture(worktree, ["publish", "check", "--json"]);
    const parsed = JSON.parse(result.stdout) as { status: string; errors: Array<{ code: string }> };

    expect(result.exitCode).toBe(2);
    expect(parsed.status).toBe("blocked");
    expect(parsed.errors.map((error) => error.code)).toContain("REMOTE_ORIGIN_MISMATCH");
  }, 15_000);

  it("publish preflight blocks branches with no common history", async () => {
    const { worktree, publicRepo } = await createPublishGitFixture();
    runGit(worktree, ["checkout", "--orphan", "publish/wrong-history"]);
    runGit(worktree, ["rm", "-r", "--cached", "."]);
    await writeFile(path.join(worktree, "orphan.txt"), "independent history\n", "utf8");
    runGit(worktree, ["add", "."]);
    runGit(worktree, ["commit", "-m", "orphan publish branch"]);

    const result = await publishPreflightCommand(worktree, { publicRepo });

    expect(result.result).toBe("blocked");
    expect(result.checks.find((check) => check.name === "git_history")?.status).toBe("error");
    expect(result.checks.find((check) => check.name === "git_history")?.message).toContain("entirely different commit histories");
  }, 15_000);

  it("publish preflight warns when the branch is ahead of target", async () => {
    const { worktree, publicRepo } = await createPublishGitFixture();
    await writeFile(path.join(worktree, "README.md"), "# LMTI publish fixture\n\nUpdated.\n", "utf8");
    runGit(worktree, ["add", "README.md"]);
    runGit(worktree, ["commit", "-m", "docs update"]);

    const result = await publishPreflightCommand(worktree, { publicRepo });

    expect(result.result).toBe("warning");
    expect(result.exitCode).toBe(1);
    expect(result.checks.find((check) => check.name === "commit_divergence")?.status).toBe("warn");
    expect(result.checks.find((check) => check.name === "commit_divergence")?.message).toContain("Ahead 1 commits");
  }, 15_000);

  it("publish warning JSON uses warn status and exit code 1", async () => {
    const { worktree } = await createPublishGitFixture();
    await writeFile(path.join(worktree, "README.md"), "# LMTI publish fixture\n\nUpdated.\n", "utf8");
    runGit(worktree, ["add", "README.md"]);
    runGit(worktree, ["commit", "-m", "docs update"]);

    const result = await runCliInFixture(worktree, ["publish", "check", "--json"]);
    const parsed = JSON.parse(result.stdout) as { status: string; warnings: Array<{ code: string }> };

    expect(result.exitCode).toBe(1);
    expect(parsed.status).toBe("warn");
    expect(parsed.warnings.map((warning) => warning.code)).toContain("CONFIG_INVALID");
  }, 15_000);

  it("skill route and route aliases return stable JSON envelopes", async () => {
    const cwd = await createSkillFixture();

    const skillRoute = await runCliInFixture(cwd, ["skill", "route", "publish repo to open source", "--json"]);
    const topLevelRoute = await runCliInFixture(cwd, ["route", "publish repo to open source", "--json"]);
    const parsedSkill = JSON.parse(skillRoute.stdout) as { schemaVersion: string; command: string; status: string; data: { selectedSkill: { id: string } } };
    const parsedAlias = JSON.parse(topLevelRoute.stdout) as { command: string; data: { selectedSkill: { id: string } } };

    expect(parsedSkill.schemaVersion).toBe("lmti.cli.v1");
    expect(parsedSkill.command).toBe("lmti.skill.route");
    expect(parsedSkill.status).toMatch(/^(pass|warn)$/u);
    expect(parsedSkill.data.selectedSkill.id).toBe("publish-preflight");
    expect(parsedAlias.command).toBe("lmti.skill.route");
    expect(parsedAlias.data.selectedSkill.id).toBe(parsedSkill.data.selectedSkill.id);
  });

  it("skill show loads only the selected skill", async () => {
    const cwd = await createSkillFixture();

    const result = await runCliInFixture(cwd, ["skill", "show", "publish-preflight", "--json"]);
    const parsed = JSON.parse(result.stdout) as { status: string; data: { skill: { id: string }; content: string } };

    expect(result.exitCode).toBe(0);
    expect(parsed.status).toBe("pass");
    expect(parsed.data.skill.id).toBe("publish-preflight");
    expect(parsed.data.content).toContain("Publish Preflight");
    expect(parsed.data.content).not.toContain("Repo Cleanup");
  });

  it("skill route warning returns exit code 1", async () => {
    const cwd = await createSkillFixture();

    const result = await runCliInFixture(cwd, ["skill", "route", "unmatched specialized request", "--json"]);
    const parsed = JSON.parse(result.stdout) as { status: string; warnings: Array<{ code: string }> };

    expect(result.exitCode).toBe(1);
    expect(parsed.status).toBe("warn");
    expect(parsed.warnings.map((warning) => warning.code)).toContain("THOTH_NO_SKILL_FOUND");
  });

  it("policy check reports approval requirements without executing actions", async () => {
    const cwd = await createFixtureProject();

    const result = await runCliInFixture(cwd, ["policy", "check", "--action", "publish", "--json"]);
    const parsed = JSON.parse(result.stdout) as { status: string; data: { decision: string } };

    expect(result.exitCode).toBe(1);
    expect(parsed.status).toBe("warn");
    expect(parsed.data.decision).toBe("require_user_approval");
  });

  it("config inspect returns shape only in the CLI envelope", async () => {
    const cwd = await createFixtureProject();
    await initCommand(cwd);

    const result = await runCliInFixture(cwd, ["config", "inspect", "--json"]);
    const parsed = JSON.parse(result.stdout) as { schemaVersion: string; status: string; data: { exists: boolean; keys: string[] } };

    expect(parsed.schemaVersion).toBe("lmti.cli.v1");
    expect(parsed.status).toBe("warn");
    expect(parsed.data.exists).toBe(true);
    expect(parsed.data.keys).toContain("privacy");
    expect(result.stdout).not.toContain("allowExternalModelRawMemory");
  });

  it("memory retrieve supports --intent and keeps secret or do_not_prompt records out of JSON context", async () => {
    const cwd = await createFixtureProject();
    await runCliInFixture(cwd, ["memory", "init"]);
    await runCliInFixture(cwd, ["memory", "add", "--title", "Safe route", "--content", "Use the public route check.", "--privacy-level", "internal"]);
    await runCliInFixture(cwd, ["memory", "add", "--title", "Secret route", "--content", "OPENAI_API_KEY=sk-proj-FAKE_TEST_VALUE_12345678901234567890", "--privacy-level", "secret"]);
    await runCliInFixture(cwd, ["memory", "add", "--title", "Do not prompt route", "--content", "Private key handling rule.", "--privacy-level", "do_not_prompt"]);

    const result = await runCliInFixture(cwd, ["memory", "retrieve", "--intent", "Safe route", "--json"]);
    const parsed = JSON.parse(result.stdout) as { schemaVersion: string; command: string; data: { results: Array<{ item: { title: string; privacyLevel: string } }> } };
    const titles = parsed.data.results.map((entry) => entry.item.title).join("\n");
    const privacyLevels = parsed.data.results.map((entry) => entry.item.privacyLevel);

    expect(parsed.schemaVersion).toBe("lmti.cli.v1");
    expect(parsed.command).toBe("lmti.memory.retrieve");
    expect(titles).not.toContain("Secret route");
    expect(titles).not.toContain("Do not prompt route");
    expect(Array.isArray(parsed.data.results)).toBe(true);
    expect(privacyLevels).not.toContain("secret");
    expect(privacyLevels).not.toContain("do_not_prompt");
    expect(result.stdout).not.toContain("sk-proj-FAKE_TEST_VALUE");
  });

  it("publish preflight warns on a dirty working tree", async () => {
    const { worktree, publicRepo } = await createPublishGitFixture();
    await writeFile(path.join(worktree, "README.md"), "# Dirty fixture\n", "utf8");

    const result = await publishPreflightCommand(worktree, { publicRepo });

    expect(result.result).toBe("warning");
    expect(result.checks.find((check) => check.name === "dirty_working_tree")?.status).toBe("warn");
  }, 15_000);

  it("publish preflight blocks staged protected files", async () => {
    const { worktree, publicRepo } = await createPublishGitFixture();
    await writeFile(path.join(worktree, ".env"), "TOKEN=redacted-fixture\n", "utf8");
    runGit(worktree, ["add", ".env"]);

    const result = await publishPreflightCommand(worktree, { publicRepo });

    expect(result.result).toBe("blocked");
    expect(result.exitCode).toBe(2);
    expect(result.checks.find((check) => check.name === "protected_files")?.status).toBe("error");
    expect(JSON.stringify(result)).not.toContain("redacted-fixture");
  }, 15_000);

  it("security doctor reports config secret findings without raw leakage", async () => {
    const cwd = await createFixtureProject();
    await initCommand(cwd);
    await writeFile(path.join(cwd, ".lmti", "config.json"), JSON.stringify({ token: githubTokenFixture, privacy: { allowSecretExport: true, allowExternalModelRawMemory: true } }, null, 2), "utf8");

    const report = await doctorSecurityCommand(cwd);

    expect(report.status).toBe("fail");
    expect(report.checks.some((check) => check.id === "config-secret-scan" && check.status === "fail")).toBe(true);
    expect(report.checks.some((check) => check.id === "privacy-config" && check.status === "fail")).toBe(true);
    expect(JSON.stringify(report)).not.toContain(githubTokenFixture);
  });

  it("benchmarks preflight latency using the real preflight path", async () => {
    const cwd = await createFixtureProject();
    await compileCommand(cwd);

    const result = await benchmarkPreflightCommand(cwd, ["fix packing label bug", "--runs", "2"]);

    expect(result.runs).toBe(2);
    expect(result.samples).toHaveLength(2);
    expect(result.p95LatencyMs).toBeGreaterThanOrEqual(result.p50LatencyMs);
    expect(result.samples.every((sample) => sample.adapterAllowed)).toBe(true);
  });

  it("remember stores non-lesson memory and sends lessons to the proposal workflow", async () => {
    const cwd = await createFixtureProject();
    await compileCommand(cwd);

    const rule = await rememberCommand(cwd, [
      "--kind",
      "rule",
      "--title",
      "Partner route rule",
      "--content",
      "Partner user must route to /partner.",
      "--tags",
      "partner,routing,permission",
      "--sensitivity",
      "internal",
      "--prompt-policy",
      "summarize_only"
    ]);
    expect("kind" in rule ? rule.kind : undefined).toBe("rule");
    await expect(readFile(path.join(cwd, ".lmti", "memory", "long-term.json"), "utf8")).resolves.toContain("Partner route rule");

    await expect(rememberCommand(cwd, [
      "--kind",
      "lesson",
      "--title",
      "Partner route lesson",
      "--content",
      "Partner user must route to /partner.",
      "--tags",
      "partner,routing,permission",
      "--sensitivity",
      "internal",
      "--prompt-policy",
      "summarize_only"
    ])).rejects.toThrow("memory lesson propose");
    await expect(readFile(path.join(cwd, ".lmti", "memory", "lessons.json"), "utf8")).resolves.not.toContain("Partner route lesson");

    const done = await taskDoneCommand(cwd, [
      "--title",
      "Partner 403 route task",
      "--summary",
      "Confirmed partner route behavior.",
      "--lesson",
      "Partner user must route to /partner."
    ]);

    expect(done.lessonMemory).toBeUndefined();
    expect(done.lessonCandidate?.approvalStatus).toBe("needs_review");
    expect(done.lessonCandidate?.privacyStatus).toBe("pass");
    await expect(readFile(path.join(cwd, ".lmti", "events", "tasks.jsonl"), "utf8")).resolves.toContain("Partner 403 route task");
  });

  it("CLI proposes lesson candidates and requires approval before retrieval", async () => {
    const cwd = await createFixtureProject();
    await initCommand(cwd);

    const proposal = JSON.parse(
      (
        await runCliInFixture(cwd, [
          "memory",
          "lesson",
          "propose",
          "--task",
          "Packing lesson approval workflow",
          "--summary",
          "Verified packing label behavior with a passing test.",
          "--lesson",
          "When changing packing label behavior, keep the lesson pending until evidence is reviewed.",
          "--files-touched",
          "src/orders/packing.ts:modified",
          "--commands",
          "npm test:0",
          "--tests",
          "npm test:pass",
          "--outcome",
          "pass",
          "--source-refs",
          "src/orders/packing.ts:file"
        ])
      ).stdout
    ) as { candidate: { id: string; approvalStatus: string; privacyStatus: string; confidence: number } };

    const candidates = JSON.parse((await runCliInFixture(cwd, ["memory", "lesson", "candidates"])).stdout) as Array<{ id: string }>;
    const beforeApproval = JSON.parse((await runCliInFixture(cwd, ["memory", "retrieve", "packing lesson approval workflow"])).stdout) as Array<{ item: { source?: string } }>;
    const doctor = await doctorSecurityCommand(cwd);
    const approved = JSON.parse((await runCliInFixture(cwd, ["memory", "lesson", "approve", proposal.candidate.id])).stdout) as {
      candidate: { approvalStatus: string };
      memory: { id: string; source?: string; sourceType?: string };
    };
    const afterApproval = JSON.parse((await runCliInFixture(cwd, ["memory", "retrieve", "packing lesson approval workflow"])).stdout) as Array<{ item: { id: string; source?: string } }>;

    expect(proposal.candidate.approvalStatus).toBe("pending");
    expect(proposal.candidate.privacyStatus).toBe("pass");
    expect(proposal.candidate.confidence).toBeGreaterThanOrEqual(0.7);
    expect(candidates.map((candidate) => candidate.id)).toContain(proposal.candidate.id);
    expect(beforeApproval.map((result) => result.item.source)).not.toContain(`lesson_candidate:${proposal.candidate.id}`);
    expect(doctor.status).toBe("warn");
    expect(doctor.checks.some((check) => check.id === "lesson-candidates" && check.status === "warn")).toBe(true);
    expect(approved.candidate.approvalStatus).toBe("approved");
    expect(approved.memory.sourceType).toBe("lesson_candidate");
    expect(afterApproval.map((result) => result.item.id)).toContain(approved.memory.id);
  });

  it("experiment thinking saves a local reduction report", async () => {
    const cwd = await createFixtureProject();
    await compileCommand(cwd);

    const result = await thinkingExperimentCommand(cwd, "fix packing label bug");

    expect(result.baseline.estimatedFilesToInspect).toBeGreaterThan(result.lmti.estimatedFilesToInspect);
    expect(result.reduction.filesReduced).toBeGreaterThan(0);
    await expect(readFile(path.join(cwd, ".lmti", "experiments", "EXP-0001-thinking.json"), "utf8")).resolves.toContain(
      "\"filesReduced\""
    );
  });

  it("experiment thinking fails gracefully before compile", async () => {
    const cwd = await createFixtureProject();
    await initCommand(cwd);

    await expect(thinkingExperimentCommand(cwd, "fix packing label bug")).rejects.toThrow("Run `lmti compile` first");
  });

  it("actions CLI records a session lifecycle and returns detail", async () => {
    const cwd = await createFixtureProject();
    const start = JSON.parse(
      (await runCliInFixture(cwd, ["actions", "start", "--task", "Fix permission routing", "--branch", "feature/actions"])).stdout
    ) as { id: string; status: string; task: string };

    expect(start.status).toBe("running");
    expect(start.task).toBe("Fix permission routing");

    await runCliInFixture(cwd, [
      "actions",
      "log",
      "--session-id",
      start.id,
      "--type",
      "file_modified",
      "--file",
      "src/auth/middleware.ts",
      "--diff-summary",
      "Adjusted role guard after source review",
      "--lines-added",
      "2",
      "--lines-removed",
      "1"
    ]);
    await runCliInFixture(cwd, [
      "actions",
      "command",
      "--session-id",
      start.id,
      "--command",
      "npm test",
      "--exit-code",
      "0",
      "--duration-ms",
      "1200",
      "--output-summary",
      "tests passed"
    ]);
    await runCliInFixture(cwd, [
      "actions",
      "decision",
      "--session-id",
      start.id,
      "--decision",
      "Keep least privilege",
      "--reason",
      "403 remains valid for users outside the allowed role",
      "--related-files",
      "src/auth/middleware.ts",
      "--related-memory-ids",
      "mem-1"
    ]);
    await runCliInFixture(cwd, [
      "actions",
      "memory",
      "--session-id",
      start.id,
      "--memory-id",
      "mem-1",
      "--memory-type",
      "long",
      "--used-in-decision"
    ]);
    await runCliInFixture(cwd, [
      "actions",
      "reflection",
      "--session-id",
      start.id,
      "--summary",
      "Fixed permission route safely",
      "--tests-run",
      "npm test"
    ]);
    await runCliInFixture(cwd, ["actions", "end", "--session-id", start.id, "--status", "completed"]);

    const detail = JSON.parse((await runCliInFixture(cwd, ["actions", "show", start.id])).stdout) as {
      session: { status: string };
      fileEvents: Array<{ filePath: string; linesAdded: number }>;
      commandEvents: Array<{ command: string; exitCode: number }>;
      decisions: Array<{ relatedMemoryIds: string[] }>;
      memoryUsage: Array<{ memoryId: string; usedInDecision: boolean }>;
      reflections: Array<{ testsRun: string[] }>;
    };

    expect(detail.session.status).toBe("completed");
    expect(detail.fileEvents[0]?.filePath).toBe("src/auth/middleware.ts");
    expect(detail.fileEvents[0]?.linesAdded).toBe(2);
    expect(detail.commandEvents[0]).toMatchObject({ command: "npm test", exitCode: 0 });
    expect(detail.decisions[0]?.relatedMemoryIds).toContain("mem-1");
    expect(detail.memoryUsage[0]).toMatchObject({ memoryId: "mem-1", usedInDecision: true });
    expect(detail.reflections[0]?.testsRun).toContain("npm test");

    const sqlite = await import("node:sqlite");
    const db = new sqlite.DatabaseSync(path.join(cwd, ".lmti", "actions", "codex-actions.sqlite"));
    try {
      const foreignKeys = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
      const violations = db.prepare("PRAGMA foreign_key_check").all();
      const storedSession = db.prepare("SELECT id FROM codex_sessions WHERE id = ?").get(start.id) as { id: string } | undefined;
      const fileEventSessions = db.prepare("SELECT DISTINCT session_id AS sessionId FROM codex_file_events").all() as Array<{ sessionId: string }>;

      expect(foreignKeys.foreign_keys).toBe(1);
      expect(violations).toEqual([]);
      expect(storedSession).toEqual({ id: start.id });
      expect(fileEventSessions).toEqual([{ sessionId: start.id }]);
    } finally {
      db.close();
    }
  });

  it("framework CLI detects project framework and writes default config", async () => {
    const cwd = await createFixtureProject();
    await writeFile(path.join(cwd, "next.config.ts"), "export default {};", "utf8");
    await writeFile(
      path.join(cwd, "package.json"),
      JSON.stringify({ name: "lmti-fixture", private: true, dependencies: { next: "latest", react: "latest" } }, null, 2),
      "utf8"
    );

    const result = JSON.parse((await runCliInFixture(cwd, ["framework", "detect", "--json"])).stdout) as {
      primaryFramework: string;
      packageManager?: string;
      evidence: string[];
    };

    expect(result.primaryFramework).toBe("nextjs");
    expect(result.evidence.join("\n")).toContain("next");
    await expect(readFile(path.join(cwd, ".lmti", "frameworks.yml"), "utf8")).resolves.toContain("confidence_threshold");
  });

  it("actions CLI redacts secret-like summaries and can render replay HTML", async () => {
    const cwd = await createFixtureProject();
    const rawSecret = "OPENAI_API_KEY=sk-proj-FAKE_TEST_VALUE_12345678901234567890";
    const startResult = await runCliInFixture(cwd, ["actions", "start", "--task", "Investigate leaked env"]);
    const start = JSON.parse(startResult.stdout) as { id: string };

    expect(start.id).toBeTruthy();

    const sqlite = await import("node:sqlite");
    const db = new sqlite.DatabaseSync(path.join(cwd, ".lmti", "actions", "codex-actions.sqlite"));
    try {
      const storedSession = db.prepare("SELECT id, task FROM codex_sessions WHERE id = ?").get(start.id);
      expect(storedSession).toEqual({ id: start.id, task: "Investigate leaked env" });
    } finally {
      db.close();
    }

    const commandResult = await runCliInFixture(cwd, [
      "actions",
      "command",
      "--session-id",
      start.id,
      "--command",
      "npm test",
      "--exit-code",
      "0",
      "--output-summary",
      `test output contained ${rawSecret}`
    ]);
    const command = JSON.parse(commandResult.stdout) as { outputSummary?: string };

    expect(JSON.stringify(command)).not.toContain(rawSecret);
    expect(JSON.stringify(command)).toContain("REDACTED");

    const detailHtml = (await runCliInFixture(cwd, ["actions", "show", start.id, "--html"])).stdout;
    const replayHtml = (await runCliInFixture(cwd, ["actions", "replay", start.id, "--html"])).stdout;

    expect(detailHtml).toContain("<!doctype html>");
    expect(detailHtml).toContain("REDACTED");
    expect(detailHtml).not.toContain(rawSecret);
    expect(replayHtml).toContain("LMTI Codex Replay");
    expect(replayHtml).not.toContain(rawSecret);
  });
});
