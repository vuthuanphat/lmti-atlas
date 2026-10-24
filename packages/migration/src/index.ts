import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { AMF_VERSION, createEmptyAmf, type AmfDocument } from "@atlas/types";
import { checkedCanonicalPath, writeCanonicalFile } from "./storage-boundary.js";

export const LMTI_DIR = ".lmti";
export const LEGACY_ATLAS_SOURCE = "atlas";
export const CONFIG_FILE = "config.json";
export const AMF_FILE = "project.amf.json";
export const INDEX_FILE = "index.json";
export const MEMORY_DIR = "memory";
export const LOGS_DIR = "logs";
export const EXPERIMENTS_DIR = "experiments";
export const SHORT_TERM_MEMORY_FILE = "short-term.json";
export const LONG_TERM_MEMORY_FILE = "long-term.json";
export const MEMORY_EVENTS_FILE = "events.jsonl";

const MAX_LEGACY_FILE_BYTES = 10 * 1024 * 1024;
const LEGACY_DIR_NAMES = [".atlas", "atlas"];
const LEGACY_AMF_FILE_NAMES = ["project.amf.json", "atlas.project.amf.json", "mind.atlas"];
const LEGACY_CONFIG_FILE_NAMES = ["config.json", "atlas.config.json", ".atlas.json", ".atlasrc", "atlas.config.yaml", "atlas.config.yml"];
const AMF_ARRAY_FIELDS = [
  "modules",
  "files",
  "symbols",
  "dependencies",
  "api",
  "database",
  "rules",
  "risks",
  "history",
  "architecture",
  "summaries",
  "unresolvedQuestions"
] as const;

export type LegacyEntryKind = "directory" | "amf" | "atlas-file" | "config" | "symlink";
export type DoctorSeverity = "info" | "warning" | "error";
export type DoctorStatus = "ok" | "warning" | "error";

export interface CanonicalStoragePaths {
  atlasDir: string;
  amfPath: string;
  indexPath: string;
  configPath: string;
  memoryDir: string;
  logsDir: string;
  experimentsDir: string;
}

export interface CanonicalStorageState extends CanonicalStoragePaths {
  dirExists: boolean;
  configExists: boolean;
  projectAmfExists: boolean;
  memoryDirExists: boolean;
  logsDirExists: boolean;
  experimentsDirExists: boolean;
}

export interface LegacyEntry {
  path: string;
  absolutePath: string;
  kind: LegacyEntryKind;
  reason: string;
  sizeBytes?: number;
  safeToRead: boolean;
}

export interface LegacyAtlasScan {
  root: string;
  canonical: CanonicalStorageState;
  hasLegacy: boolean;
  legacyEntries: LegacyEntry[];
  legacyAmfCandidates: LegacyEntry[];
  legacyConfigCandidates: LegacyEntry[];
  duplicateStatePaths: string[];
  conflictingAmfFiles: string[];
}

export interface MigrationResult {
  status: "migrated" | "already-canonical" | "skipped";
  legacyDetected: boolean;
  canonicalAmfPath: string;
  configPath: string;
  reportPath?: string;
  selectedLegacyAmf?: string;
  changes: string[];
  warnings: string[];
  legacyEntries: Array<Omit<LegacyEntry, "absolutePath" | "safeToRead">>;
}

export interface DoctorProblem {
  id: string;
  severity: DoctorSeverity;
  message: string;
  paths: string[];
  recommendedFix: string;
}

export interface DoctorReport {
  status: DoctorStatus;
  problems: DoctorProblem[];
  recommendedFixes: string[];
  changes: string[];
  warnings: string[];
  environment: DoctorEnvironment;
  amf: DoctorAmfDiagnostics;
  canonical: CanonicalStorageState;
  legacyEntries: Array<Omit<LegacyEntry, "absolutePath" | "safeToRead">>;
}

export interface DoctorOptions {
  fix?: boolean;
  now?: Date;
}

export interface DoctorEnvironment {
  cli: "ok";
  nodeVersion: string;
  packageManager: string;
  lmtiVersion: string;
  repoPath: string;
}

export type NoiseRisk = "low" | "medium" | "high";
export type ProjectMemoryStatus = "ok" | "missing" | "invalid" | "uncompiled";

export interface DoctorFolderStat {
  name: string;
  files: number;
  sizeBytes: number;
}

export interface DoctorZoneStat {
  zone: "core" | "backend" | "frontend" | "docs" | "legacy" | "assets" | "secrets_blocked" | "other";
  files: number;
  sizeBytes: number;
}

export interface DoctorSensitivePathFinding {
  kind: "env" | "secret-key" | "database-dump" | "local-config";
  count: number;
  examples: string[];
}

export interface DoctorAmfDiagnostics {
  projectMemory: ProjectMemoryStatus;
  amfPath: string;
  amfSizeBytes: number;
  indexedFiles: number;
  modules: number;
  risks: number;
  topFolders: DoctorFolderStat[];
  zones: DoctorZoneStat[];
  noiseRisk: NoiseRisk;
  legacyWordPressDetected: boolean;
  assetNoiseFiles: number;
  lmtiIgnoreExists: boolean;
  ignoreRulesApplied: boolean;
  sensitivePathFindings: DoctorSensitivePathFinding[];
  suggestedActions: string[];
  verificationMode: string[];
}

export interface MigrationOptions {
  now?: Date;
}

interface PathInfo {
  kind: "file" | "directory" | "symlink";
  sizeBytes?: number;
}

interface LmtiConfigShape {
  version: "0.1.0";
  kernel: "atlas";
  projectName: string;
  privacy: {
    defaultRole: "developer";
    allowSecretExport: false;
    allowExternalModelRawMemory: false;
  };
  codex: {
    attached: boolean;
    agentsFile: string;
  };
  migratedFrom?: "atlas";
  legacyDetected: boolean;
  [key: string]: unknown;
}

type JsonRecord = Record<string, unknown>;

export function canonicalStoragePaths(cwd = process.cwd()): CanonicalStoragePaths {
  const root = path.resolve(cwd);
  const atlasDir = path.join(root, LMTI_DIR);
  return {
    atlasDir,
    amfPath: path.join(atlasDir, AMF_FILE),
    indexPath: path.join(atlasDir, INDEX_FILE),
    configPath: path.join(atlasDir, CONFIG_FILE),
    memoryDir: path.join(atlasDir, MEMORY_DIR),
    logsDir: path.join(atlasDir, LOGS_DIR),
    experimentsDir: path.join(atlasDir, EXPERIMENTS_DIR)
  };
}

export async function detectLegacyAtlasStorage(cwd = process.cwd()): Promise<LegacyAtlasScan> {
  const root = path.resolve(cwd);
  const canonical = await readCanonicalState(root);
  const legacyEntries: LegacyEntry[] = [];
  const legacyAmfCandidates: LegacyEntry[] = [];
  const legacyConfigCandidates: LegacyEntry[] = [];
  const seen = new Set<string>();

  const addEntry = async (absolutePath: string, kind: LegacyEntryKind, reason: string): Promise<LegacyEntry | undefined> => {
    const normalized = path.resolve(absolutePath);
    if (seen.has(normalized)) {
      return undefined;
    }
    seen.add(normalized);

    const info = await describePath(normalized);
    if (!info) {
      return undefined;
    }

    const entryKind = info.kind === "symlink" ? "symlink" : kind;
    const entry: LegacyEntry = {
      path: normalizePath(path.relative(root, normalized)),
      absolutePath: normalized,
      kind: entryKind,
      reason: info.kind === "symlink" ? `${reason}; symlink ignored for migration safety` : reason,
      sizeBytes: info.sizeBytes,
      safeToRead: info.kind === "file" && (info.sizeBytes ?? 0) <= MAX_LEGACY_FILE_BYTES
    };
    legacyEntries.push(entry);
    return entry;
  };

  for (const dirName of LEGACY_DIR_NAMES) {
    const dirPath = path.join(root, dirName);
    const entry = await addEntry(dirPath, "directory", "Legacy Atlas storage directory");
    const info = entry ? await describePath(dirPath) : undefined;
    if (entry && info?.kind === "directory") {
      await collectLegacyDirectory(dirPath, root, addEntry, legacyAmfCandidates, legacyConfigCandidates);
    }
  }

  for (const fileName of LEGACY_AMF_FILE_NAMES) {
    const entry = await addEntry(path.join(root, fileName), "amf", "Legacy Atlas project mind file");
    if (entry && entry.kind !== "symlink") {
      legacyAmfCandidates.push(entry);
    }
  }

  for (const fileName of LEGACY_CONFIG_FILE_NAMES.filter((name) => name !== "config.json")) {
    const entry = await addEntry(path.join(root, fileName), "config", "Legacy Atlas config file");
    if (entry && entry.kind !== "symlink") {
      legacyConfigCandidates.push(entry);
    }
  }

  await collectRootAtlasFiles(root, addEntry, legacyAmfCandidates, legacyConfigCandidates);

  const duplicateStatePaths = canonical.dirExists && legacyEntries.length > 0
    ? [normalizePath(path.relative(root, canonical.atlasDir)), ...legacyEntries.map((entry) => entry.path)]
    : [];
  const amfPaths = [
    ...(canonical.projectAmfExists ? [normalizePath(path.relative(root, canonical.amfPath))] : []),
    ...legacyAmfCandidates.map((entry) => entry.path)
  ];

  return {
    root,
    canonical,
    hasLegacy: legacyEntries.length > 0,
    legacyEntries,
    legacyAmfCandidates,
    legacyConfigCandidates,
    duplicateStatePaths,
    conflictingAmfFiles: amfPaths.length > 1 ? Array.from(new Set(amfPaths)) : []
  };
}

export async function migrateAtlasToLmti(cwd = process.cwd(), options: MigrationOptions = {}): Promise<MigrationResult> {
  const root = path.resolve(cwd);
  const scan = await detectLegacyAtlasStorage(root);
  const paths = canonicalStoragePaths(root);
  const now = options.now ?? new Date();
  const changes: string[] = [];
  const warnings: string[] = [];

  if (!scan.hasLegacy) {
    return {
      status: "skipped",
      legacyDetected: false,
      canonicalAmfPath: paths.amfPath,
      configPath: paths.configPath,
      changes,
      warnings: ["No legacy Atlas storage was detected."],
      legacyEntries: []
    };
  }

  await ensureCanonicalFolders(root, changes);
  await ensureMemoryFiles(root, changes);

  let status: MigrationResult["status"] = "migrated";
  let selectedLegacyAmf: string | undefined;
  let selectedProjectName: string | undefined;

  if (scan.canonical.projectAmfExists) {
    status = "already-canonical";
    warnings.push("Canonical .lmti/project.amf.json already exists; legacy AMF files were not copied over it.");
  } else {
    const selected = await selectLegacyMind(scan, root, warnings);
    if (selected) {
      selectedLegacyAmf = selected.entry.path;
      selectedProjectName = selected.document.project.name;
      await writeCanonicalFile(root, paths.amfPath, JSON.stringify(selected.document, null, 2), true);
      changes.push(`Copied legacy project mind from ${selected.entry.path} to .lmti/project.amf.json.`);
    } else {
      await writeCanonicalFile(root, paths.amfPath, JSON.stringify(createPlaceholderAmf(root), null, 2), true);
      warnings.push("No readable legacy AMF document was found; created an uncompiled .lmti/project.amf.json placeholder.");
      changes.push("Created .lmti/project.amf.json placeholder.");
    }
  }

  const configResult = await normalizeLmtiConfig(root, {
    legacyDetected: true,
    migratedFrom: "atlas",
    projectName: selectedProjectName
  });
  if (configResult.changed) {
    changes.push("Normalized .lmti/config.json with Atlas migration metadata.");
  }
  warnings.push(...configResult.warnings);

  const reportPath = await writeMigrationReport(root, now, {
    status,
    selectedLegacyAmf,
    changes,
    warnings,
    scan
  });
  changes.push(`Wrote migration report ${normalizePath(path.relative(root, reportPath))}.`);

  return {
    status,
    legacyDetected: true,
    canonicalAmfPath: paths.amfPath,
    configPath: paths.configPath,
    reportPath,
    selectedLegacyAmf,
    changes,
    warnings,
    legacyEntries: scan.legacyEntries.map(summarizeLegacyEntry)
  };
}

export async function doctorLmti(cwd = process.cwd(), options: DoctorOptions = {}): Promise<DoctorReport> {
  const root = path.resolve(cwd);
  let scan = await detectLegacyAtlasStorage(root);
  const changes: string[] = [];
  const warnings: string[] = [];

  if (options.fix) {
    const shouldMigrate = scan.hasLegacy && !scan.canonical.projectAmfExists && scan.legacyAmfCandidates.length <= 1;
    if (shouldMigrate) {
      const migration = await migrateAtlasToLmti(root, { now: options.now });
      changes.push(...migration.changes);
      warnings.push(...migration.warnings);
    } else {
      await ensureCanonicalFolders(root, changes);
      await ensureMemoryFiles(root, changes);

      const configResult = await normalizeLmtiConfig(root, { legacyDetected: scan.hasLegacy });
      if (configResult.changed) {
        changes.push("Normalized .lmti/config.json.");
      }
      warnings.push(...configResult.warnings);

      if (!scan.canonical.projectAmfExists && !scan.hasLegacy) {
        const paths = canonicalStoragePaths(root);
        await writeCanonicalFile(root, paths.amfPath, JSON.stringify(createPlaceholderAmf(root), null, 2), true);
        changes.push("Created .lmti/project.amf.json placeholder.");
      }

      if (scan.hasLegacy && !scan.canonical.projectAmfExists && scan.legacyAmfCandidates.length > 1) {
        warnings.push("Skipped automatic migration because multiple legacy AMF candidates were found.");
      }
    }
    scan = await detectLegacyAtlasStorage(root);
  }

  const problems = createDoctorProblems(scan);
  const environment = await readDoctorEnvironment(root);
  const amf = await diagnoseAmf(root, scan.canonical);
  return {
    status: statusForDoctor(problems, amf),
    problems,
    recommendedFixes: recommendedFixesFor(problems),
    changes,
    warnings,
    environment,
    amf,
    canonical: scan.canonical,
    legacyEntries: scan.legacyEntries.map(summarizeLegacyEntry)
  };
}

export function formatMigrationResult(result: MigrationResult): string {
  const lines = ["LMTI Migration", `Status: ${result.status}`];
  if (!result.legacyDetected) {
    lines.push("Legacy Atlas state: not detected");
    lines.push(...result.warnings.map((warning) => `Warning: ${warning}`));
    return lines.join("\n");
  }

  lines.push(`Canonical AMF: ${result.canonicalAmfPath}`);
  if (result.selectedLegacyAmf) {
    lines.push(`Migrated from: ${result.selectedLegacyAmf}`);
  }
  if (result.reportPath) {
    lines.push(`Report: ${result.reportPath}`);
  }
  appendSection(lines, "Changes", result.changes);
  appendSection(lines, "Warnings", result.warnings);
  return lines.join("\n");
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = [
    "LMTI Doctor Report",
    `Status: ${report.status}`,
    `- CLI: ${report.environment.cli.toUpperCase()}`,
    `- Version: ${report.environment.lmtiVersion}`,
    `- Node: ${report.environment.nodeVersion}`,
    `- Package manager: ${report.environment.packageManager}`,
    `- Repo: ${report.environment.repoPath}`,
    `- Project memory: ${report.amf.projectMemory.toUpperCase()}`,
    `- AMF size: ${formatBytes(report.amf.amfSizeBytes)}`,
    `- Indexed files: ${report.amf.indexedFiles}`,
    `- Modules: ${report.amf.modules}`,
    `- Noise risk: ${report.amf.noiseRisk.toUpperCase()}`,
    `- Legacy WordPress detected: ${report.amf.legacyWordPressDetected ? "YES" : "NO"}`,
    `- Asset noise files: ${report.amf.assetNoiseFiles}`,
    `- .lmtiignore: ${report.amf.lmtiIgnoreExists ? "FOUND" : "MISSING"}`,
    `- Ignore rules applied: ${report.amf.ignoreRulesApplied ? "YES" : "NO"}`
  ];

  appendFolderStats(lines, "Top folders", report.amf.topFolders);
  appendZoneStats(lines, "Context zones", report.amf.zones);

  if (report.amf.sensitivePathFindings.length > 0) {
    lines.push("Sensitive path warnings:");
    for (const finding of report.amf.sensitivePathFindings) {
      lines.push(`- ${finding.kind}: ${finding.count} matched path(s); examples: ${finding.examples.join(", ")}`);
    }
  }

  appendSection(lines, "Suggested actions", report.amf.suggestedActions);
  appendSection(lines, "Verification rules", report.amf.verificationMode);

  if (report.problems.length === 0) {
    lines.push("Problems: none");
  } else {
    lines.push("Problems:");
    for (const problem of report.problems) {
      lines.push(`- [${problem.severity}] ${problem.id}: ${problem.message}`);
      if (problem.paths.length > 0) {
        lines.push(`  Paths: ${problem.paths.join(", ")}`);
      }
    }
  }
  appendSection(lines, "Recommended fixes", report.recommendedFixes);
  appendSection(lines, "Changes", report.changes);
  appendSection(lines, "Warnings", report.warnings);
  return lines.join("\n");
}

export async function normalizeLmtiConfig(
  cwd = process.cwd(),
  options: { legacyDetected?: boolean; migratedFrom?: "atlas"; projectName?: string } = {}
): Promise<{ changed: boolean; warnings: string[] }> {
  const root = path.resolve(cwd);
  const paths = canonicalStoragePaths(root);
  const warnings: string[] = [];
  await checkedCanonicalPath(root, paths.atlasDir, "directory");
  const configPath = await checkedCanonicalPath(root, paths.configPath, "file");

  let existingText = "";
  let existing: JsonRecord = {};
  if (configPath.exists) {
    await configPath.recheck();
    existingText = await fs.readFile(configPath.filename, "utf8");
    await configPath.recheck();
    try {
      const parsed = JSON.parse(existingText) as unknown;
      if (isRecord(parsed)) existing = parsed;
      else warnings.push(".lmti/config.json did not contain a JSON object and was normalized.");
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      warnings.push(".lmti/config.json could not be parsed and was normalized.");
    }
  }

  const existingCodex = isRecord(existing.codex) ? existing.codex : {};
  const next: LmtiConfigShape = {
    ...existing,
    version: "0.1.0",
    kernel: "atlas",
    projectName: options.projectName ?? stringValue(existing.projectName) ?? "",
    privacy: {
      defaultRole: "developer",
      allowSecretExport: false,
      allowExternalModelRawMemory: false
    },
    codex: {
      attached: typeof existingCodex.attached === "boolean" ? existingCodex.attached : true,
      agentsFile: stringValue(existingCodex.agentsFile) ?? "AGENTS.md"
    },
    legacyDetected: options.legacyDetected ?? Boolean(existing.legacyDetected)
  };

  if (options.migratedFrom === "atlas" || existing.migratedFrom === "atlas") {
    next.migratedFrom = "atlas";
  }

  const nextText = `${JSON.stringify(next, null, 2)}\n`;
  if (existingText !== nextText) {
    await configPath.recheck();
    await writeCanonicalFile(root, paths.configPath, nextText, !configPath.exists);
    return { changed: true, warnings };
  }
  return { changed: false, warnings };
}

async function readCanonicalState(cwd: string): Promise<CanonicalStorageState> {
  const paths = canonicalStoragePaths(cwd);
  const [dir, config, projectAmf, memoryDir, logsDir, experimentsDir] = await Promise.all([
    describePath(paths.atlasDir),
    describePath(paths.configPath),
    describePath(paths.amfPath),
    describePath(paths.memoryDir),
    describePath(paths.logsDir),
    describePath(paths.experimentsDir)
  ]);
  return {
    ...paths,
    dirExists: dir?.kind === "directory",
    configExists: config?.kind === "file",
    projectAmfExists: projectAmf?.kind === "file",
    memoryDirExists: memoryDir?.kind === "directory",
    logsDirExists: logsDir?.kind === "directory",
    experimentsDirExists: experimentsDir?.kind === "directory"
  };
}

async function collectLegacyDirectory(
  dirPath: string,
  root: string,
  addEntry: (absolutePath: string, kind: LegacyEntryKind, reason: string) => Promise<LegacyEntry | undefined>,
  legacyAmfCandidates: LegacyEntry[],
  legacyConfigCandidates: LegacyEntry[]
): Promise<void> {
  for (const fileName of LEGACY_AMF_FILE_NAMES) {
    const entry = await addEntry(path.join(dirPath, fileName), "amf", "Legacy Atlas project mind file inside legacy storage");
    if (entry && entry.kind !== "symlink") {
      legacyAmfCandidates.push(entry);
    }
  }

  for (const fileName of LEGACY_CONFIG_FILE_NAMES) {
    const entry = await addEntry(path.join(dirPath, fileName), "config", "Legacy Atlas config file inside legacy storage");
    if (entry && entry.kind !== "symlink") {
      legacyConfigCandidates.push(entry);
    }
  }

  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(dirPath, entry.name);
      const relative = normalizePath(path.relative(root, absolutePath));
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".atlas")) {
        const legacyEntry = await addEntry(absolutePath, "atlas-file", `Legacy Atlas file ${relative}`);
        if (legacyEntry && legacyEntry.kind !== "symlink") {
          legacyAmfCandidates.push(legacyEntry);
        }
      }
    }
  } catch {
    // A legacy directory that cannot be listed is still reported as legacy state.
  }
}

async function collectRootAtlasFiles(
  root: string,
  addEntry: (absolutePath: string, kind: LegacyEntryKind, reason: string) => Promise<LegacyEntry | undefined>,
  legacyAmfCandidates: LegacyEntry[],
  legacyConfigCandidates: LegacyEntry[]
): Promise<void> {
  let entries: string[] = [];
  try {
    entries = await fs.readdir(root);
  } catch {
    return;
  }

  for (const entryName of entries) {
    const lower = entryName.toLowerCase();
    const absolutePath = path.join(root, entryName);
    if (lower.endsWith(".atlas")) {
      const entry = await addEntry(absolutePath, "atlas-file", "Legacy Atlas file in project root");
      if (entry && entry.kind !== "symlink") {
        legacyAmfCandidates.push(entry);
      }
      continue;
    }
    if ((lower.startsWith("atlas") || lower.startsWith(".atlas")) && lower.includes("config") && /\.(json|ya?ml|rc)$/i.test(lower)) {
      const entry = await addEntry(absolutePath, "config", "Legacy Atlas config file in project root");
      if (entry && entry.kind !== "symlink") {
        legacyConfigCandidates.push(entry);
      }
    }
  }
}

async function selectLegacyMind(
  scan: LegacyAtlasScan,
  root: string,
  warnings: string[]
): Promise<{ entry: LegacyEntry; document: AmfDocument } | undefined> {
  const candidates = [...scan.legacyAmfCandidates].sort((left, right) => legacyPriority(left.path) - legacyPriority(right.path));
  for (const entry of candidates) {
    if (!entry.safeToRead) {
      warnings.push(`Skipped ${entry.path} because it is too large or not a regular file.`);
      continue;
    }
    try {
      const content = await fs.readFile(entry.absolutePath, "utf8");
      const parsed = JSON.parse(content) as unknown;
      if (!looksLikeMindDocument(parsed)) {
        warnings.push(`Skipped ${entry.path} because it is not an AMF-like JSON document.`);
        continue;
      }
      return {
        entry,
        document: normalizeAmfDocument(parsed, root)
      };
    } catch {
      warnings.push(`Skipped ${entry.path} because it could not be read as JSON.`);
    }
  }
  return undefined;
}

function normalizeAmfDocument(input: JsonRecord, root: string): AmfDocument {
  const placeholder = createPlaceholderAmf(root);
  const project = isRecord(input.project) ? input.project : {};
  const compiler = isRecord(project.compiler) ? project.compiler : {};
  const sourceBoundary = isRecord(project.sourceBoundary) ? project.sourceBoundary : {};
  const compiledAt = stringValue(project.compiledAt) ?? stringValue(input.generatedAt) ?? placeholder.project.compiledAt;

  return {
    ...input,
    version: stringValue(input.version) ?? AMF_VERSION,
    generatedAt: stringValue(input.generatedAt) ?? compiledAt,
    project: {
      ...placeholder.project,
      ...project,
      name: stringValue(project.name) ?? placeholder.project.name,
      root: stringValue(project.root) ?? placeholder.project.root,
      compiledAt,
      atlasVersion: stringValue(project.atlasVersion) ?? "0.0.0",
      amfVersion: stringValue(project.amfVersion) ?? AMF_VERSION,
      compiler: {
        name: stringValue(compiler.name) ?? "Legacy Atlas migration",
        version: stringValue(compiler.version) ?? "0.1.0"
      },
      sourceBoundary: {
        root: stringValue(sourceBoundary.root) ?? normalizePath(root),
        ignoredDirectories: stringArrayValue(sourceBoundary.ignoredDirectories),
        ignoredFiles: stringArrayValue(sourceBoundary.ignoredFiles),
        maxFileBytes: numberValue(sourceBoundary.maxFileBytes) ?? 0
      },
      checksum: stringValue(project.checksum) ?? "legacy-migrated"
    },
    modules: arrayValue(input.modules) as AmfDocument["modules"],
    files: arrayValue(input.files) as AmfDocument["files"],
    symbols: arrayValue(input.symbols) as AmfDocument["symbols"],
    dependencies: arrayValue(input.dependencies) as AmfDocument["dependencies"],
    api: arrayValue(input.api) as AmfDocument["api"],
    database: arrayValue(input.database) as AmfDocument["database"],
    rules: arrayValue(input.rules) as AmfDocument["rules"],
    risks: arrayValue(input.risks) as AmfDocument["risks"],
    history: arrayValue(input.history) as AmfDocument["history"],
    architecture: arrayValue(input.architecture) as AmfDocument["architecture"],
    summaries: arrayValue(input.summaries) as AmfDocument["summaries"],
    unresolvedQuestions: arrayValue(input.unresolvedQuestions) as AmfDocument["unresolvedQuestions"]
  };
}

async function writeMigrationReport(
  root: string,
  now: Date,
  input: {
    status: MigrationResult["status"];
    selectedLegacyAmf?: string;
    changes: string[];
    warnings: string[];
    scan: LegacyAtlasScan;
  }
): Promise<string> {
  const paths = canonicalStoragePaths(root);
  await checkedCanonicalPath(root, paths.logsDir, "directory");
  const reportPath = path.join(paths.logsDir, `migration-${formatTimestamp(now)}.json`);
  const report = {
    version: "0.1.0",
    migratedAt: now.toISOString(),
    migratedFrom: LEGACY_ATLAS_SOURCE,
    legacyDetected: input.scan.hasLegacy,
    status: input.status,
    canonical: {
      directory: ".lmti",
      projectAmf: ".lmti/project.amf.json",
      config: ".lmti/config.json"
    },
    selectedLegacyAmf: input.selectedLegacyAmf,
    legacyEntries: input.scan.legacyEntries.map(summarizeLegacyEntry),
    conflictingAmfFiles: input.scan.conflictingAmfFiles,
    changes: input.changes,
    warnings: input.warnings,
    checksums: await checksumSummary(input.scan)
  };
  await writeCanonicalFile(root, reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return reportPath;
}

async function checksumSummary(scan: LegacyAtlasScan): Promise<Array<{ path: string; sha256: string }>> {
  const result: Array<{ path: string; sha256: string }> = [];
  for (const entry of scan.legacyAmfCandidates) {
    if (!entry.safeToRead) {
      continue;
    }
    try {
      const content = await fs.readFile(entry.absolutePath);
      result.push({ path: entry.path, sha256: createHash("sha256").update(content).digest("hex") });
    } catch {
      // Checksums are best-effort metadata for audit reports.
    }
  }
  return result;
}

async function ensureCanonicalFolders(root: string, changes: string[]): Promise<void> {
  const paths = canonicalStoragePaths(root);
  await ensureDirectory(root, paths.atlasDir, ".lmti", changes);
  await ensureDirectory(root, paths.memoryDir, ".lmti/memory", changes);
  await ensureDirectory(root, paths.logsDir, ".lmti/logs", changes);
  await ensureDirectory(root, paths.experimentsDir, ".lmti/experiments", changes);
}

async function ensureMemoryFiles(root: string, changes: string[]): Promise<void> {
  const paths = canonicalStoragePaths(root);
  await ensureFile(root, path.join(paths.memoryDir, SHORT_TERM_MEMORY_FILE), "[]", ".lmti/memory/short-term.json", changes);
  await ensureFile(root, path.join(paths.memoryDir, LONG_TERM_MEMORY_FILE), "[]", ".lmti/memory/long-term.json", changes);
  await ensureFile(root, path.join(paths.memoryDir, MEMORY_EVENTS_FILE), "", ".lmti/memory/events.jsonl", changes);
}

async function ensureDirectory(root: string, directoryPath: string, displayPath: string, changes: string[]): Promise<void> {
  const info = await describePath(directoryPath);
  await checkedCanonicalPath(root, directoryPath, "directory");
  if (info?.kind === "directory") {
    return;
  }
  changes.push(`Created ${displayPath}.`);
}

async function ensureFile(root: string, filePath: string, content: string, displayPath: string, changes: string[]): Promise<void> {
  const checked = await checkedCanonicalPath(root, filePath, "file");
  if (checked.exists) {
    return;
  }
  await writeCanonicalFile(root, filePath, content, true);
  changes.push(`Created ${displayPath}.`);
}

function createDoctorProblems(scan: LegacyAtlasScan): DoctorProblem[] {
  const problems: DoctorProblem[] = [];
  const rel = (absolutePath: string) => normalizePath(path.relative(scan.root, absolutePath));

  if (!scan.canonical.dirExists) {
    problems.push({
      id: "missing-lmti-directory",
      severity: scan.hasLegacy ? "error" : "warning",
      message: "Canonical .lmti directory is missing.",
      paths: [".lmti"],
      recommendedFix: scan.hasLegacy ? "Run `lmti migrate --yes` or `lmti doctor --fix`." : "Run `lmti init` or `lmti doctor --fix`."
    });
  }
  if (scan.canonical.dirExists && !scan.canonical.configExists) {
    problems.push({
      id: "missing-lmti-config",
      severity: "error",
      message: "Canonical .lmti/config.json is missing.",
      paths: [rel(scan.canonical.configPath)],
      recommendedFix: "Run `lmti doctor --fix` to recreate secure default config."
    });
  }
  if (scan.canonical.dirExists && !scan.canonical.projectAmfExists) {
    problems.push({
      id: "missing-lmti-amf",
      severity: "error",
      message: "Canonical .lmti/project.amf.json is missing.",
      paths: [rel(scan.canonical.amfPath)],
      recommendedFix: scan.hasLegacy ? "Run `lmti migrate --yes` if the legacy AMF is the source of truth." : "Run `lmti compile`."
    });
  }
  for (const [exists, display] of [
    [scan.canonical.memoryDirExists, ".lmti/memory"],
    [scan.canonical.logsDirExists, ".lmti/logs"],
    [scan.canonical.experimentsDirExists, ".lmti/experiments"]
  ] as const) {
    if (scan.canonical.dirExists && !exists) {
      problems.push({
        id: `missing-${display.replace(/[/.]/g, "-").replace(/^-/, "")}`,
        severity: "warning",
        message: `${display} is missing.`,
        paths: [display],
        recommendedFix: "Run `lmti doctor --fix` to recreate missing canonical folders."
      });
    }
  }
  if (scan.hasLegacy) {
    problems.push({
      id: "legacy-atlas-state",
      severity: scan.canonical.projectAmfExists ? "warning" : "error",
      message: "Legacy Atlas storage was detected.",
      paths: scan.legacyEntries.map((entry) => entry.path),
      recommendedFix: scan.canonical.projectAmfExists
        ? "Keep using .lmti/project.amf.json; review legacy files manually after backup."
        : "Run `lmti migrate --yes` to copy legacy state into .lmti."
    });
  }
  if (scan.duplicateStatePaths.length > 0) {
    problems.push({
      id: "duplicate-atlas-lmti-state",
      severity: "warning",
      message: "Both legacy Atlas and canonical LMTI storage exist; .lmti is treated as canonical.",
      paths: scan.duplicateStatePaths,
      recommendedFix: "Run `lmti doctor --fix` to normalize config, then archive legacy files manually if safe."
    });
  }
  if (scan.conflictingAmfFiles.length > 0) {
    problems.push({
      id: "conflicting-amf-files",
      severity: scan.canonical.projectAmfExists ? "warning" : "error",
      message: "Multiple AMF-like files were detected.",
      paths: scan.conflictingAmfFiles,
      recommendedFix: "Use .lmti/project.amf.json as the only active mind file; migrate only after confirming the correct legacy source."
    });
  }

  return problems;
}

async function readDoctorEnvironment(root: string): Promise<DoctorEnvironment> {
  return {
    cli: "ok",
    nodeVersion: process.version,
    packageManager: await detectPackageManager(root),
    lmtiVersion: await detectLmtiVersion(root),
    repoPath: normalizePath(root)
  };
}

async function detectPackageManager(root: string): Promise<string> {
  const packageJson = await readJsonIfRecord(path.join(root, "package.json"));
  const declared = stringValue(packageJson?.packageManager);
  if (declared) {
    return declared;
  }
  if (await describePath(path.join(root, "pnpm-lock.yaml"))) {
    return "pnpm";
  }
  if (await describePath(path.join(root, "yarn.lock"))) {
    return "yarn";
  }
  if (await describePath(path.join(root, "package-lock.json"))) {
    return "npm";
  }
  return "unknown";
}

async function detectLmtiVersion(root: string): Promise<string> {
  const candidates = [
    path.join(root, "packages", "cli", "package.json"),
    path.join(root, "node_modules", "lmti", "package.json")
  ];
  for (const candidate of candidates) {
    const manifest = await readJsonIfRecord(candidate);
    const version = stringValue(manifest?.version);
    if (version) {
      return version;
    }
  }
  return "unknown";
}

async function diagnoseAmf(root: string, canonical: CanonicalStorageState): Promise<DoctorAmfDiagnostics> {
  const lmtiIgnoreExists = Boolean(await describePath(path.join(root, ".lmtiignore")));
  const sensitivePathFindings = await findSensitivePathFindings(root);
  const empty = createEmptyAmfDiagnostics(canonical.amfPath, lmtiIgnoreExists, sensitivePathFindings);

  if (!canonical.projectAmfExists) {
    return {
      ...empty,
      projectMemory: "missing",
      suggestedActions: suggestedActionsFor({
        projectMemory: "missing",
        lmtiIgnoreExists,
        ignoreRulesApplied: false,
        noiseRisk: "low",
        sensitivePathFindings
      })
    };
  }

  let amf: AmfDocument;
  let amfSizeBytes = 0;
  try {
    const [text, info] = await Promise.all([
      fs.readFile(canonical.amfPath, "utf8"),
      describePath(canonical.amfPath)
    ]);
    amfSizeBytes = info?.sizeBytes ?? Buffer.byteLength(text);
    amf = JSON.parse(text) as AmfDocument;
  } catch {
    return {
      ...empty,
      projectMemory: "invalid",
      suggestedActions: suggestedActionsFor({
        projectMemory: "invalid",
        lmtiIgnoreExists,
        ignoreRulesApplied: false,
        noiseRisk: "low",
        sensitivePathFindings
      })
    };
  }

  const files = Array.isArray(amf.files) ? amf.files : [];
  const modules = Array.isArray(amf.modules) ? amf.modules : [];
  const risks = Array.isArray(amf.risks) ? amf.risks : [];
  const topFolders = topFolderStats(files);
  const zones = zoneStats(files);
  const legacyWordPressDetected = files.some((file) => isLegacyWordPressPath(file.path));
  const assetNoiseFiles = files.filter((file) => zoneForPath(file.path) === "assets").length;
  const ignoreRulesApplied = Boolean(
    amf.project?.sourceBoundary?.ignoredFiles?.some((rule) => rule.startsWith(`${LMTI_DIR}ignore:`) || rule.startsWith(".lmtiignore:"))
  );
  const noiseRisk = calculateNoiseRisk(files.length, legacyWordPressDetected, assetNoiseFiles, lmtiIgnoreExists, ignoreRulesApplied);
  const projectMemory: ProjectMemoryStatus = !amf.project?.compiledAt || amf.project.checksum === "uncompiled" ? "uncompiled" : "ok";

  return {
    projectMemory,
    amfPath: normalizePath(canonical.amfPath),
    amfSizeBytes,
    indexedFiles: files.length,
    modules: modules.length,
    risks: risks.length,
    topFolders,
    zones,
    noiseRisk,
    legacyWordPressDetected,
    assetNoiseFiles,
    lmtiIgnoreExists,
    ignoreRulesApplied,
    sensitivePathFindings,
    suggestedActions: suggestedActionsFor({
      projectMemory,
      lmtiIgnoreExists,
      ignoreRulesApplied,
      noiseRisk,
      sensitivePathFindings
    }),
    verificationMode: verificationRules()
  };
}

function createEmptyAmfDiagnostics(
  amfPath: string,
  lmtiIgnoreExists: boolean,
  sensitivePathFindings: DoctorSensitivePathFinding[]
): DoctorAmfDiagnostics {
  return {
    projectMemory: "missing",
    amfPath: normalizePath(amfPath),
    amfSizeBytes: 0,
    indexedFiles: 0,
    modules: 0,
    risks: 0,
    topFolders: [],
    zones: [],
    noiseRisk: "low",
    legacyWordPressDetected: false,
    assetNoiseFiles: 0,
    lmtiIgnoreExists,
    ignoreRulesApplied: false,
    sensitivePathFindings,
    suggestedActions: [],
    verificationMode: verificationRules()
  };
}

function topFolderStats(files: AmfDocument["files"]): DoctorFolderStat[] {
  const byFolder = new Map<string, DoctorFolderStat>();
  for (const file of files) {
    const folder = firstPathSegment(file.path);
    const current = byFolder.get(folder) ?? { name: folder, files: 0, sizeBytes: 0 };
    current.files += 1;
    current.sizeBytes += file.sizeBytes;
    byFolder.set(folder, current);
  }
  return Array.from(byFolder.values())
    .sort((left, right) => right.files - left.files || right.sizeBytes - left.sizeBytes || left.name.localeCompare(right.name))
    .slice(0, 8);
}

function zoneStats(files: AmfDocument["files"]): DoctorZoneStat[] {
  const byZone = new Map<DoctorZoneStat["zone"], DoctorZoneStat>();
  for (const file of files) {
    const zone = file.privacy === "protected" || file.riskFlags.includes("secret") ? "secrets_blocked" : zoneForPath(file.path);
    const current = byZone.get(zone) ?? { zone, files: 0, sizeBytes: 0 };
    current.files += 1;
    current.sizeBytes += file.sizeBytes;
    byZone.set(zone, current);
  }
  return Array.from(byZone.values()).sort((left, right) => right.files - left.files || left.zone.localeCompare(right.zone));
}

function zoneForPath(filePath: string): DoctorZoneStat["zone"] {
  const normalized = filePath.toLowerCase();
  if (isLegacyWordPressPath(normalized) || /(^|\/)(legacy|wordpress)(\/|$)/.test(normalized)) {
    return "legacy";
  }
  if (/(^|\/)(public\/assets|public\/uploads|assets|images|media)(\/|$)/.test(normalized) || isAssetLikePath(normalized)) {
    return "assets";
  }
  if (/^(docs|rfcs|research|papers|philosophy)\//.test(normalized) || normalized.endsWith(".md")) {
    return "docs";
  }
  if (/^(apps|src|app|pages|components|packages\/(?:cli|context|cognition|kernel))\//.test(normalized)) {
    return "core";
  }
  if (/(^|\/)(api|server|backend|runtime|mcp|compiler|memory|privacy|security|world-model)(\/|$)/.test(normalized)) {
    return "backend";
  }
  if (/(^|\/)(frontend|ui|client|components|pages|app)(\/|$)/.test(normalized)) {
    return "frontend";
  }
  return "other";
}

function calculateNoiseRisk(
  indexedFiles: number,
  legacyWordPressDetected: boolean,
  assetNoiseFiles: number,
  lmtiIgnoreExists: boolean,
  ignoreRulesApplied: boolean
): NoiseRisk {
  if (legacyWordPressDetected || assetNoiseFiles > 50 || (indexedFiles > 0 && assetNoiseFiles / indexedFiles > 0.25)) {
    return "high";
  }
  if (!lmtiIgnoreExists || !ignoreRulesApplied || assetNoiseFiles > 0) {
    return "medium";
  }
  return "low";
}

function suggestedActionsFor(input: {
  projectMemory: ProjectMemoryStatus;
  lmtiIgnoreExists: boolean;
  ignoreRulesApplied: boolean;
  noiseRisk: NoiseRisk;
  sensitivePathFindings: DoctorSensitivePathFinding[];
}): string[] {
  const actions = new Set<string>();
  if (input.projectMemory === "missing") {
    actions.add("Run `lmti compile` after reviewing .lmtiignore.");
  }
  if (input.projectMemory === "invalid") {
    actions.add("Regenerate .lmti/project.amf.json with `lmti compile`.");
  }
  if (input.projectMemory === "uncompiled") {
    actions.add("Project memory is a placeholder; run `lmti compile` before trusting context.");
  }
  if (!input.lmtiIgnoreExists) {
    actions.add("Add .lmtiignore to block build artifacts, legacy WordPress folders, assets and local secrets.");
  } else if (!input.ignoreRulesApplied) {
    actions.add("Run `lmti compile` so .lmtiignore rules are reflected in AMF sourceBoundary.");
  }
  if (input.noiseRisk === "high") {
    actions.add("Reduce AMF noise before agent use; exclude legacy/assets or split context by zone.");
  } else if (input.noiseRisk === "medium") {
    actions.add("Review top folders and zone counts before using AMF as task context.");
  }
  if (input.sensitivePathFindings.length > 0) {
    actions.add("Keep detected sensitive files out of AMF and source control; rotate exposed credentials if any value was committed.");
  }
  if (actions.size === 0) {
    actions.add("No immediate action; continue verifying memory against source before edits.");
  }
  return Array.from(actions);
}

function verificationRules(): string[] {
  return [
    "Memory and AMF are advisory context, not source of truth.",
    "Verify endpoints, schemas, imports and module existence with `rg` or file reads before editing.",
    "When AMF conflicts with source code, source code and command output win.",
    "Do not delete or refactor files based only on memory; prove imports/references first."
  ];
}

async function findSensitivePathFindings(root: string): Promise<DoctorSensitivePathFinding[]> {
  const findings = new Map<DoctorSensitivePathFinding["kind"], string[]>();
  const ignoredDirectories = new Set([
    ".git",
    ".lmti",
    ".atlas",
    "node_modules",
    "dist",
    "build",
    "coverage",
    ".next",
    ".turbo",
    ".cache"
  ]);
  let visited = 0;
  const maxVisited = 20_000;

  async function walk(directory: string): Promise<void> {
    if (visited >= maxVisited) {
      return;
    }
    let entries: import("node:fs").Dirent[] = [];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (visited >= maxVisited) {
        return;
      }
      visited += 1;
      const absolutePath = path.join(directory, entry.name);
      const relativePath = normalizePath(path.relative(root, absolutePath));
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        if (ignoredDirectories.has(entry.name.toLowerCase())) {
          continue;
        }
        await walk(absolutePath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const kind = sensitivePathKind(relativePath);
      if (!kind) {
        continue;
      }
      const paths = findings.get(kind) ?? [];
      paths.push(relativePath);
      findings.set(kind, paths);
    }
  }

  await walk(root);
  return Array.from(findings.entries()).map(([kind, paths]) => ({
    kind,
    count: paths.length,
    examples: paths.slice(0, 5)
  }));
}

function sensitivePathKind(filePath: string): DoctorSensitivePathFinding["kind"] | undefined {
  const normalized = filePath.toLowerCase();
  const baseName = path.posix.basename(normalized);
  if ((baseName === ".env" || /^\.env\.(?!example$|sample$)/.test(baseName)) && !isEnvExamplePath(normalized)) {
    return "env";
  }
  if (/\.(pem|key|p12|pfx|crt|cer|token)$/.test(normalized) || /^id_(rsa|ed25519)(\.pub)?$/.test(baseName)) {
    return "secret-key";
  }
  if (/\.(sql|dump|bak|zip)$/.test(normalized)) {
    return "database-dump";
  }
  if (
    baseName === ".npmrc" ||
    baseName === ".yarnrc" ||
    /^wp-config(?:\.local)?\.php$/.test(baseName) ||
    /^docker-compose\.local\.ya?ml$/.test(baseName) ||
    /\.local\.(json|ya?ml|toml)$/.test(baseName)
  ) {
    return "local-config";
  }
  return undefined;
}

function isEnvExamplePath(filePath: string): boolean {
  const baseName = path.posix.basename(filePath.toLowerCase());
  return baseName === ".env.example" || baseName === ".env.sample" || baseName.endsWith(".example.env");
}

function isLegacyWordPressPath(filePath: string): boolean {
  return /(^|\/)(wp-admin|wp-content|wp-includes)(\/|$)/i.test(filePath);
}

function isAssetLikePath(filePath: string): boolean {
  return /\.(png|jpe?g|gif|webp|avif|ico|bmp|tiff?|mp4|mov|avi|webm|mp3|wav|woff2?|ttf|eot)$/i.test(filePath);
}

function firstPathSegment(filePath: string): string {
  return normalizePath(filePath).split("/").filter(Boolean)[0] ?? "root";
}

function statusForProblems(problems: DoctorProblem[]): DoctorStatus {
  if (problems.some((problem) => problem.severity === "error")) {
    return "error";
  }
  if (problems.some((problem) => problem.severity === "warning")) {
    return "warning";
  }
  return "ok";
}

function statusForDoctor(problems: DoctorProblem[], amf: DoctorAmfDiagnostics): DoctorStatus {
  const problemStatus = statusForProblems(problems);
  if (problemStatus === "error" || amf.projectMemory === "invalid" || amf.projectMemory === "missing") {
    return "error";
  }
  if (
    problemStatus === "warning" ||
    amf.projectMemory === "uncompiled" ||
    amf.noiseRisk !== "low" ||
    !amf.ignoreRulesApplied ||
    amf.sensitivePathFindings.length > 0
  ) {
    return "warning";
  }
  return "ok";
}

function recommendedFixesFor(problems: DoctorProblem[]): string[] {
  return Array.from(new Set(problems.map((problem) => problem.recommendedFix)));
}

function summarizeLegacyEntry(entry: LegacyEntry): Omit<LegacyEntry, "absolutePath" | "safeToRead"> {
  return {
    path: entry.path,
    kind: entry.kind,
    reason: entry.reason,
    sizeBytes: entry.sizeBytes
  };
}

function createPlaceholderAmf(cwd: string): AmfDocument {
  const root = path.resolve(cwd);
  const projectName = path.basename(root);
  return createEmptyAmf({
    name: projectName,
    root: normalizePath(root),
    compiledAt: "",
    atlasVersion: "0.0.0",
    amfVersion: AMF_VERSION,
    compiler: {
      name: "LMTI migration placeholder",
      version: "0.1.0"
    },
    sourceBoundary: {
      root: normalizePath(root),
      ignoredDirectories: [],
      ignoredFiles: [],
      maxFileBytes: 0
    },
    checksum: "uncompiled"
  });
}

function looksLikeMindDocument(value: unknown): value is JsonRecord {
  if (!isRecord(value)) {
    return false;
  }
  if (isRecord(value.project)) {
    return true;
  }
  return AMF_ARRAY_FIELDS.some((field) => Array.isArray(value[field]));
}

async function describePath(targetPath: string): Promise<PathInfo | undefined> {
  try {
    const stats = await fs.lstat(targetPath);
    if (stats.isSymbolicLink()) {
      return { kind: "symlink" };
    }
    if (stats.isDirectory()) {
      return { kind: "directory" };
    }
    if (stats.isFile()) {
      return { kind: "file", sizeBytes: stats.size };
    }
    return undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function readJsonIfRecord(filePath: string): Promise<JsonRecord | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function legacyPriority(relativePath: string): number {
  const normalized = relativePath.toLowerCase().replace(/\\/g, "/");
  const priorities = [
    ".atlas/project.amf.json",
    "atlas/project.amf.json",
    "project.amf.json",
    "atlas.project.amf.json",
    ".atlas/atlas.project.amf.json",
    "atlas/atlas.project.amf.json",
    ".atlas/mind.atlas",
    "atlas/mind.atlas",
    "mind.atlas"
  ];
  const index = priorities.indexOf(normalized);
  return index === -1 ? 100 : index;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function appendSection(lines: string[], title: string, entries: string[]): void {
  if (entries.length === 0) {
    return;
  }
  lines.push(`${title}:`);
  for (const entry of entries) {
    lines.push(`- ${entry}`);
  }
}

function appendFolderStats(lines: string[], title: string, entries: DoctorFolderStat[]): void {
  if (entries.length === 0) {
    return;
  }
  lines.push(`${title}:`);
  for (const entry of entries) {
    lines.push(`- ${entry.name}: ${entry.files} files, ${formatBytes(entry.sizeBytes)}`);
  }
}

function appendZoneStats(lines: string[], title: string, entries: DoctorZoneStat[]): void {
  if (entries.length === 0) {
    return;
  }
  lines.push(`${title}:`);
  for (const entry of entries) {
    lines.push(`- ${entry.zone}: ${entry.files} files, ${formatBytes(entry.sizeBytes)}`);
  }
}

function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }
  const kib = value / 1024;
  if (kib < 1024) {
    return `${kib.toFixed(1)} KB`;
  }
  return `${(kib / 1024).toFixed(1)} MB`;
}

function formatTimestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
    "-",
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes()),
    pad(date.getUTCSeconds())
  ].join("");
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}
