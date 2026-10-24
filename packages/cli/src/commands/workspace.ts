import { type InitResult, initAtlasStorage, writeAmfDocument, createDefaultLmtiConfig, type LmtiConfig } from "@atlas/memory";
import { type MigrationResult, detectLegacyAtlasStorage, canonicalStoragePaths, migrateAtlasToLmti, doctorLmti, formatDoctorReport, formatMigrationResult } from "@atlas/migration";
import path from "node:path";
import { compileProject } from "@atlas/compiler";
import { promises as fs } from "node:fs";
import { CliUsageError, parseArgs } from "../arguments.js";
import { printWarnings } from "../output.js";
import { escapeRegExp, readTextIfExists } from "../files.js";

export async function runInit(args: string[]): Promise<void> {
  const { flags } = parseArgs(args, { yes: "boolean" }, 0);
  const storage = await initCommand(process.cwd(), { yes: Boolean(flags.yes) });
  printWarnings(storage.warnings);

  if (storage.skippedDueToLegacy) {
    console.log("Legacy Atlas storage detected.");
    console.log("No .lmti directory was created to avoid duplicate active mind files.");
    console.log("Run `lmti migrate --yes` or `lmti init --yes` to copy legacy state into .lmti.");
    return;
  }

  console.log("LMTI initialized.");
  console.log(`Storage: ${storage.atlasDir}`);
  console.log(`Config: ${storage.configPath}`);
  console.log(`AMF: ${storage.amfPath}`);
  console.log(`Index: ${storage.indexPath}`);
  if (storage.migration?.reportPath) {
    console.log(`Migration report: ${storage.migration.reportPath}`);
  }
}

export interface InitCommandOptions {
  yes?: boolean;
}

export type InitCommandResult = InitResult & {
  warnings: string[];
  skippedDueToLegacy?: boolean;
  migration?: MigrationResult;
};

export async function initCommand(cwd: string, options: InitCommandOptions = {}): Promise<InitCommandResult> {
  const scan = await detectLegacyAtlasStorage(cwd);
  const warnings: string[] = [];

  if (scan.hasLegacy && !scan.canonical.dirExists) {
    if (!options.yes) {
      warnings.push("Legacy Atlas storage exists. Use `lmti init --yes` or `lmti migrate --yes` to migrate it into .lmti.");
      const paths = canonicalStoragePaths(cwd);
      return {
        ...paths,
        eventsDir: path.join(paths.atlasDir, "events"),
        warnings,
        skippedDueToLegacy: true
      };
    }

    const migration = await migrateAtlasToLmti(cwd);
    const storage = await initAtlasStorage(cwd);
    return {
      ...storage,
      warnings: migration.warnings,
      migration
    };
  }

  if (scan.hasLegacy && scan.canonical.dirExists) {
    warnings.push("Legacy Atlas storage detected; .lmti remains the canonical active storage. Legacy files were not deleted.");
  }

  const storage = await initAtlasStorage(cwd);
  return { ...storage, warnings };
}

export async function runCompile(args: string[]): Promise<void> {
  const { positional } = parseArgs(args, {  }, 1);
  const projectPath = positional[0] ?? ".";

  console.log("Generating Mind...");
  console.log("");
  console.log("Modules...");
  console.log("Rules...");
  console.log("Dependencies...");
  console.log("Architecture...");
  console.log("");

  const { amf, storage, warnings } = await compileCommand(process.cwd(), projectPath);
  printWarnings(warnings);

  console.log("Done.");
  console.log("");
  console.log(`${amf.project.name} compiled.`);
  console.log(`${storage.amfPath} generated.`);
}

export async function compileCommand(cwd: string, projectPath = ".") {
  const warnings: string[] = [];
  let migration: MigrationResult | undefined;
  const scan = await detectLegacyAtlasStorage(cwd);
  if (scan.hasLegacy && !scan.canonical.dirExists) {
    migration = await migrateAtlasToLmti(cwd);
    warnings.push("Legacy Atlas storage detected and migrated to .lmti before compile.");
    warnings.push(...migration.warnings);
  } else if (scan.hasLegacy && scan.canonical.dirExists) {
    warnings.push("Legacy Atlas storage detected; using .lmti/project.amf.json as canonical. Legacy files were not deleted.");
  }

  const amf = await compileProject(projectPath, { cwd });
  const storage = await writeAmfDocument(amf, cwd);
  return { amf, storage, warnings, migration };
}

export async function runMigrate(args: string[]): Promise<void> {
  const { flags } = parseArgs(args, { yes: "boolean" }, 0);
  if (!flags.yes) {
    const report = await doctorLmti(process.cwd());
    console.log(formatDoctorReport(report));
    console.log("");
    console.log("No files were changed. Run `lmti migrate --yes` to copy legacy Atlas state into .lmti.");
    return;
  }

  const result = await migrateCommand(process.cwd(), { yes: true });
  console.log(formatMigrationResult(result));
}

export async function migrateCommand(cwd: string, options: { yes?: boolean } = {}): Promise<MigrationResult> {
  if (!options.yes) {
    return {
      status: "skipped",
      legacyDetected: false,
      canonicalAmfPath: canonicalStoragePaths(cwd).amfPath,
      configPath: canonicalStoragePaths(cwd).configPath,
      changes: [],
      warnings: ["Migration not run. Pass yes: true or use `lmti migrate --yes`."],
      legacyEntries: []
    };
  }
  return migrateAtlasToLmti(cwd);
}

export async function migrateLegacyIfLmtiMissing(cwd: string, warnings: string[] = []): Promise<MigrationResult | undefined> {
  const scan = await detectLegacyAtlasStorage(cwd);
  if (scan.hasLegacy && !scan.canonical.dirExists) {
    const migration = await migrateAtlasToLmti(cwd);
    warnings.push("Legacy Atlas storage detected and migrated to .lmti.");
    warnings.push(...migration.warnings);
    return migration;
  }
  return undefined;
}

export async function runAttach(args: string[]): Promise<void> {
  const { positional } = parseArgs(args, {  }, 1);
  const target = positional[0];
  if (target !== "codex") {
    throw new CliUsageError("Usage: lmti attach codex");
  }

  const agentsPath = await attachCodex(process.cwd());

  console.log("LMTI attached to Codex.");
  console.log(`Updated: ${agentsPath}`);
}

export async function attachCodex(cwd: string): Promise<string> {
  await migrateLegacyIfLmtiMissing(cwd);
  const storage = await initAtlasStorage(cwd);
  const agentsPath = path.resolve(cwd, "AGENTS.md");
  const existing = await readTextIfExists(agentsPath);
  const next = upsertLmtiAgentsSection(existing);
  await fs.writeFile(agentsPath, next, "utf8");
  await writeLmtiConfig(storage.configPath, {
    ...createDefaultLmtiConfig(),
    ...(await readLmtiConfig(storage.configPath)),
    codex: {
      attached: true,
      agentsFile: "AGENTS.md"
    }
  });
  return agentsPath;
}

const LMTI_SECTION_START = "<!-- LMTI:START -->";

const LMTI_SECTION_END = "<!-- LMTI:END -->";

const LMTI_AGENTS_SECTION = `${LMTI_SECTION_START}
## LMTI - Atlas Integration

Codex must treat LMTI as the project memory/context layer.

When this repository is installed inside another project, LMTI must be treated
as an external intelligence layer, not as a module of the host project.

Connected by context, not by runtime ownership.

Before making changes, Codex should:

1. Read .lmti/project.amf.json if available.
2. Use LMTI context when the task is unclear or touches multiple modules.
3. Prefer compiled understanding and Project Atlas metadata over repeatedly scanning the entire repository.
4. Respect .lmti privacy rules.
5. Never expose secret memory or confidential project knowledge in raw form.
6. After completing a task, summarize what changed and propose safe lesson candidates instead of storing raw chat.
7. If a task reveals a reusable rule, bug, route, deploy note, permission rule or architecture constraint, prefer \`lmti task done --lesson "..."\` or \`lmti memory lesson propose\`; approve only after privacy/evidence review.
8. Treat memory as prior belief, not reality. Source code, tests, command output and explicit user instruction remain the source of truth.
9. Use framework detection before planning build/test/risk steps on unfamiliar projects.
10. Do not bypass LMTI privacy gates, do not widen permissions to make a task pass, and never print secrets.
11. Do not store raw chat, raw secrets, raw customer data, or unverified hallucinations as memory.
12. Before publishing, pushing to a public repo, opening a PR, creating a release, or changing a Git remote, always run \`lmti publish preflight\`. If it returns ERROR/BLOCKED, stop immediately and ask the user to resolve or approve a safe recovery path.
13. Never move/import .lmti into host application runtime or delete its memory/index/lesson files during cleanup. Modify LMTI only when the task explicitly requests it.
14. When developing LMTI itself, use docs/LMTI_MASTER_PLAN.md, the accepted native topology ADR and docs/component-support.md. Architecture Studio uses a typed C++ core, Qt desktop/SQLite adapters and Python SDK/MCP; existing TS/Go memory commands remain compatible. Do not add direct Agent store access, arbitrary shell tools or device execution to the local topology MVP.

Suggested local command:

lmti context "<task>"
lmti mind context "<task>"
lmti framework detect
lmti preflight "<task>" --role developer --model-target external_model
lmti publish preflight
lmti memory lesson candidates
lmti doctor --security
${LMTI_SECTION_END}`;

function upsertLmtiAgentsSection(existing: string): string {
  const normalized = existing.replace(/\s+$/u, "");
  const markedPattern = new RegExp(`${escapeRegExp(LMTI_SECTION_START)}[\\s\\S]*?${escapeRegExp(LMTI_SECTION_END)}`, "u");

  if (markedPattern.test(normalized)) {
    return `${normalized.replace(markedPattern, LMTI_AGENTS_SECTION)}\n`;
  }

  const headingPattern = /(?:^|\n)## LMTI - Atlas Integration\n[\s\S]*?(?=\n## |\n# |\s*$)/u;
  if (headingPattern.test(normalized)) {
    return `${normalized.replace(headingPattern, `\n${LMTI_AGENTS_SECTION}`)}\n`;
  }

  return normalized ? `${normalized}\n\n${LMTI_AGENTS_SECTION}\n` : `${LMTI_AGENTS_SECTION}\n`;
}

async function readLmtiConfig(configPath: string): Promise<Partial<LmtiConfig>> {
  try {
    return JSON.parse(await fs.readFile(configPath, "utf8")) as Partial<LmtiConfig>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

async function writeLmtiConfig(configPath: string, config: LmtiConfig): Promise<void> {
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), { encoding: "utf8", mode: 0o600 });
}
