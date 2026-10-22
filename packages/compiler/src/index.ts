import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  AMF_VERSION,
  type ApiEntry,
  type ArchitectureEntry,
  type AmfDocument,
  type Confidence,
  type DatabaseEntry,
  type DependencyEntry,
  type FileEntry,
  type HistoryEntry,
  type ModuleEntry,
  type PrivacyLevel,
  type RiskEntry,
  type RuleEntry,
  type SummaryEntry,
  type SymbolEntry,
  type UnresolvedQuestionEntry
} from "@atlas/types";
import { attachModuleDependencies } from "@atlas/graph";
import { hasSecretLikeMaterial, redactText } from "@atlas/privacy";

const COMPILER_VERSION = "0.1.0";
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const LMTI_IGNORE_FILE = ".lmtiignore";

const IGNORED_DIRECTORIES = [
  ".lmti",
  ".atlas",
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  "cache",
  "logs",
  "tmp",
  "temp",
  "vendor",
  ".pnpm-store",
  "wp-admin",
  "wp-content",
  "wp-includes"
];

const IGNORED_FILE_PATTERNS = [
  /^\.env(?:\..*)?$/i,
  /^\.npmrc$/i,
  /^\.yarnrc$/i,
  /^wp-config(?:\.local)?\.php$/i,
  /^docker-compose\.local\.ya?ml$/i,
  /^config\.local\.(?:json|ya?ml|toml)$/i,
  /\.local\.(?:json|ya?ml|toml)$/i,
  /^id_rsa(?:\.pub)?$/i,
  /^id_ed25519(?:\.pub)?$/i,
  /\.tsbuildinfo$/i,
  /\.min\.js$/i,
  /\.map$/i,
  /\.(?:pem|key|p12|pfx|crt|cer|token)$/i,
  /\.(?:zip|bak|log|dump)$/i,
  /\.(?:png|jpe?g|gif|webp|avif|ico|bmp|tiff?|mp4|mov|avi|webm|mp3|wav|woff2?|ttf|eot)$/i
];

const IGNORED_PATH_PATTERNS = [
  /(^|\/)public\/uploads(\/|$)/i,
  /(^|\/)public\/assets(\/|$)/i,
  /(^|\/)wp-admin(\/|$)/i,
  /(^|\/)wp-content(\/|$)/i,
  /(^|\/)wp-includes(\/|$)/i
];

const TEXT_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".env",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".prisma",
  ".sql",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml"
]);

const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"]);
const DATABASE_EXTENSIONS = new Set([".sql", ".prisma"]);

export interface CompileOptions {
  cwd?: string;
  maxFileBytes?: number;
  lmtiIgnoreFile?: string;
}

export type CompiledAmfFreshnessReason =
  | "compiled_metadata_invalid"
  | "compiler_changed"
  | "source_boundary_changed"
  | "source_root_not_authorized"
  | "source_inventory_changed"
  | "source_content_changed"
  | "source_not_fully_hashed"
  | "source_unreadable"
  | "source_changed_during_check"
  | "scan_budget_exceeded";

export interface CompiledAmfFreshness {
  status: "fresh" | "stale" | "unknown";
  checkedAt: string;
  scope: "compiler-source-boundary";
  reasons: CompiledAmfFreshnessReason[];
  checkedFileCount: number;
}

export interface CheckCompiledAmfFreshnessOptions extends CompileOptions {
  /** Authorized checkout. Artifact metadata cannot extend this filesystem boundary. */
  cwd?: string;
  maxFiles?: number;
  maxTotalBytes?: number;
  now?: Date;
}

interface SourceScanBudget {
  maxFiles: number;
  maxTotalBytes: number;
  maxEntries: number;
  checkedFiles: number;
  readBytes: number;
  visitedEntries: number;
  deadline: number;
}

class SourceScanError extends Error {
  constructor(readonly reason: CompiledAmfFreshnessReason) {
    super(reason);
  }
}

interface SourceBoundaryRules {
  ignoredDirectories: string[];
  ignoredFiles: string[];
  ignoreRules: IgnoreRule[];
}

interface IgnoreRule {
  raw: string;
  negated: boolean;
  regex: RegExp;
}

interface ObservedFile {
  absolutePath: string;
  relativePath: string;
  extension: string;
  sizeBytes: number;
  text: string | null;
  skippedReason?: string;
}

interface ParsedFile {
  api: ApiEntry[];
  database: DatabaseEntry[];
  dependencies: DependencyEntry[];
  symbols: SymbolEntry[];
  risks: RiskEntry[];
  rules: RuleEntry[];
  summary: string;
  privacy: PrivacyLevel;
  riskFlags: string[];
}

export async function compileProject(projectPath: string, options: CompileOptions = {}): Promise<AmfDocument> {
  const cwd = options.cwd ?? process.cwd();
  const root = path.resolve(cwd, projectPath);
  const rootStat = await fs.stat(root);

  if (!rootStat.isDirectory()) {
    throw new Error(`Project path is not a directory: ${root}`);
  }

  const realRoot = await fs.realpath(root);
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const sourceBoundary = await createSourceBoundary(realRoot, options.lmtiIgnoreFile ?? LMTI_IGNORE_FILE);
  const observedFiles = await scanProject(realRoot, maxFileBytes, sourceBoundary);
  const projectName = await detectProjectName(realRoot);
  const fileSet = new Set(observedFiles.map((file) => file.relativePath));
  const fileToModule = new Map<string, string>();

  const files: FileEntry[] = [];
  const api: ApiEntry[] = [];
  const database: DatabaseEntry[] = [];
  const dependencies: DependencyEntry[] = [];
  const symbols: SymbolEntry[] = [];
  const risks: RiskEntry[] = [];
  const rules: RuleEntry[] = [];
  const summaries: SummaryEntry[] = [];
  const modulesByName = new Map<string, ModuleEntry>();

  let riskCounter = 1;
  let ruleCounter = 1;

  for (const observed of observedFiles) {
    const moduleName = detectModuleName(observed.relativePath);
    fileToModule.set(observed.relativePath, moduleName);

    const moduleEntry = getOrCreateModule(modulesByName, moduleName, observed.relativePath);
    moduleEntry.files.push(observed.relativePath);

    const parsed = parseObservedFile(observed, moduleName, fileSet, riskCounter, ruleCounter);
    riskCounter += parsed.risks.length;
    ruleCounter += parsed.rules.length;

    files.push({
      path: observed.relativePath,
      extension: observed.extension,
      kind: detectFileKind(observed.relativePath),
      module: moduleName,
      sizeBytes: observed.sizeBytes,
      lines: observed.text ? countLines(observed.text) : 0,
      hash: hashObservedFile(observed),
      summary: parsed.summary,
      privacy: parsed.privacy,
      riskFlags: parsed.riskFlags
    });

    dependencies.push(...parsed.dependencies);
    symbols.push(...parsed.symbols);
    api.push(...parsed.api);
    database.push(...parsed.database);
    risks.push(...parsed.risks);
    rules.push(...parsed.rules);
    summaries.push({
      target: observed.relativePath,
      targetType: "file",
      text: parsed.summary,
      confidence: observed.text ? "medium" : "low"
    });
  }

  for (const symbol of symbols) {
    modulesByName.get(symbol.module)?.symbols.push(symbol.name);
  }

  dependencies.push(...extractPackageDependencies(observedFiles, riskCounter));

  const modules = attachModuleDependencies(
    Array.from(modulesByName.values()).map((module) => ({
      ...module,
      files: module.files.sort(),
      symbols: Array.from(new Set(module.symbols)).sort(),
      summary: summarizeModule(module)
    })),
    dependencies,
    fileToModule
  ).sort((a, b) => a.name.localeCompare(b.name));

  for (const module of modules) {
    summaries.push({
      target: module.name,
      targetType: "module",
      text: module.summary,
      confidence: module.confidence
    });
  }

  summaries.unshift({
    target: projectName,
    targetType: "project",
    text: summarizeProject(projectName, files, modules, dependencies, risks),
    confidence: "medium"
  });

  const architecture = createArchitectureEntries(modules, dependencies, risks);
  const history = createHistoryEntries(projectName, observedFiles, maxFileBytes);
  const unresolvedQuestions = createUnresolvedQuestions(projectName, api, database, rules, risks);

  const checksum = hashText(
    JSON.stringify({
      files: files.map((file) => [file.path, file.hash]),
      api: api.map((entry) => [entry.source, entry.method, entry.route, entry.kind]),
      database: database.map((entry) => [entry.source, entry.name, entry.kind]),
      dependencies: dependencies.map((dependency) => [dependency.from, dependency.to, dependency.kind]),
      symbols: symbols.map((symbol) => [symbol.file, symbol.name, symbol.kind])
    })
  );

  const generatedAt = new Date().toISOString();

  return {
    version: AMF_VERSION,
    generatedAt,
    project: {
      name: projectName,
      root: normalizePath(realRoot),
      compiledAt: generatedAt,
      atlasVersion: "0.0.0",
      amfVersion: AMF_VERSION,
      compiler: {
        name: "Knowledge Compiler v0",
        version: COMPILER_VERSION
      },
      sourceBoundary: {
        root: normalizePath(realRoot),
        ignoredDirectories: sourceBoundary.ignoredDirectories,
        ignoredFiles: sourceBoundary.ignoredFiles,
        maxFileBytes
      },
      checksum
    },
    modules,
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
    symbols: symbols.sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name)),
    dependencies: dedupeDependencies(dependencies).sort((a, b) => {
      return a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.kind.localeCompare(b.kind);
    }),
    api: api.sort((a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name)),
    database: database.sort((a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name)),
    rules,
    risks,
    history,
    architecture,
    summaries,
    unresolvedQuestions
  };
}

/**
 * Read-only check against the compiler's own inventory and content-hash semantics.
 * A successful scan is an as-of observation, not an atomic snapshot or a claim that
 * uncompiled/ignored content is understood. No paths or source text leave this API.
 */
export async function checkCompiledAmfFreshness(
  amf: AmfDocument,
  options: CheckCompiledAmfFreshnessOptions = {}
): Promise<CompiledAmfFreshness> {
  const requestedTime = options.now;
  const checkedTime = requestedTime instanceof Date && Number.isFinite(requestedTime.getTime()) ? requestedTime : undefined;
  const budget: SourceScanBudget = {
    maxFiles: options.maxFiles ?? 10_000,
    maxTotalBytes: options.maxTotalBytes ?? 64 * 1024 * 1024,
    maxEntries: Math.min((options.maxFiles ?? 10_000) * 8 + 1024, 100_000),
    checkedFiles: 0,
    readBytes: 0,
    visitedEntries: 0,
    deadline: Date.now() + 15_000
  };
  const finish = (status: CompiledAmfFreshness["status"], ...reasons: CompiledAmfFreshnessReason[]): CompiledAmfFreshness => ({
    status,
    checkedAt: (checkedTime ?? new Date()).toISOString(),
    scope: "compiler-source-boundary",
    reasons,
    checkedFileCount: budget.checkedFiles
  });

  try {
    const project = amf?.project;
    const boundary = project?.sourceBoundary;
    if (!project?.compiledAt || !Number.isFinite(Date.parse(project.compiledAt)) || !project.compiler || !boundary || !project.root ||
        !boundary.root || !/^[a-f0-9]{64}$/.test(project.checksum) || !Array.isArray(amf.files) ||
        !Array.isArray(boundary.ignoredDirectories) || !Array.isArray(boundary.ignoredFiles) ||
        !Number.isSafeInteger(boundary.maxFileBytes) || boundary.maxFileBytes < 1 ||
        amf.files.some((file) => typeof file.path !== "string" || isPathTraversal(file.path) ||
          !/^[a-f0-9]{64}$/.test(file.hash)) || new Set(amf.files.map((file) => file.path)).size !== amf.files.length) {
      return finish("unknown", "compiled_metadata_invalid");
    }
    if (!Number.isSafeInteger(budget.maxFiles) || budget.maxFiles < 1 || budget.maxFiles > 100_000 ||
        !Number.isSafeInteger(budget.maxTotalBytes) || budget.maxTotalBytes < 1 || budget.maxTotalBytes > 256 * 1024 * 1024) {
      return finish("unknown", "scan_budget_exceeded");
    }
    if (project.compiler.name !== "Knowledge Compiler v0" || project.compiler.version !== COMPILER_VERSION ||
        amf.version !== AMF_VERSION || project.amfVersion !== AMF_VERSION) {
      return finish("stale", "compiler_changed");
    }

    const authorizedRoot = await fs.realpath(path.resolve(options.cwd ?? process.cwd()));
    const declaredRoot = path.resolve(project.root);
    if (!isPathInside(authorizedRoot, declaredRoot) || path.resolve(boundary.root) !== declaredRoot) {
      return finish("unknown", "source_root_not_authorized");
    }
    const realRoot = await fs.realpath(declaredRoot);
    if (!isPathInside(authorizedRoot, realRoot)) {
      return finish("unknown", "source_root_not_authorized");
    }

    const maxFileBytes = options.maxFileBytes ?? boundary.maxFileBytes;
    if (maxFileBytes !== boundary.maxFileBytes) return finish("stale", "source_boundary_changed");
    const ignoreFile = options.lmtiIgnoreFile ?? LMTI_IGNORE_FILE;
    const sourceBoundary = await createSourceBoundary(realRoot, ignoreFile);
    if (JSON.stringify(sourceBoundary.ignoredDirectories) !== JSON.stringify(boundary.ignoredDirectories) ||
        JSON.stringify(sourceBoundary.ignoredFiles) !== JSON.stringify(boundary.ignoredFiles)) {
      return finish("stale", "source_boundary_changed");
    }
    const observedFiles = await scanProject(realRoot, maxFileBytes, sourceBoundary, budget);
    // Re-read ignore policy so a policy change during the traversal cannot be called fresh.
    const finalBoundary = await createSourceBoundary(realRoot, ignoreFile);
    if (JSON.stringify(sourceBoundary.ignoredFiles) !== JSON.stringify(finalBoundary.ignoredFiles)) {
      return finish("unknown", "source_changed_during_check");
    }
    const previous = new Map(amf.files.map((file) => [file.path, file.hash]));
    if (observedFiles.length !== previous.size || observedFiles.some((file) => !previous.has(file.relativePath))) {
      return finish("stale", "source_inventory_changed");
    }
    if (observedFiles.some((file) => previous.get(file.relativePath) !== hashObservedFile(file))) {
      return finish("stale", "source_content_changed");
    }
    // Legacy skipped-file hashes contain only path + size. They cannot prove freshness.
    // Replacement characters also mean distinct input bytes may have decoded alike.
    if (observedFiles.some((file) => file.text === null || file.text.includes("\ufffd"))) {
      return finish("unknown", "source_not_fully_hashed");
    }
    return finish("fresh");
  } catch (error) {
    return finish("unknown", error instanceof SourceScanError ? error.reason : "source_unreadable");
  }
}

function hashObservedFile(file: ObservedFile): string {
  return hashText(file.text ?? `${file.relativePath}:${file.sizeBytes}`);
}

async function scanProject(root: string, maxFileBytes: number, sourceBoundary: SourceBoundaryRules, budget?: SourceScanBudget): Promise<ObservedFile[]> {
  const observed: ObservedFile[] = [];

  async function walk(directory: string, depth = 0): Promise<void> {
    if (budget && (depth > 64 || Date.now() > budget.deadline)) throw new SourceScanError("scan_budget_exceeded");
    const realDirectory = await fs.realpath(directory);
    if (!isPathInside(root, realDirectory)) throw new SourceScanError("source_unreadable");
    const beforeDirectory = budget ? await fs.stat(directory) : undefined;
    const entries = await fs.readdir(directory, { withFileTypes: true });
    if (budget && budget.visitedEntries + entries.length > budget.maxEntries) throw new SourceScanError("scan_budget_exceeded");
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (budget) {
        budget.visitedEntries += 1;
        if (Date.now() > budget.deadline) throw new SourceScanError("scan_budget_exceeded");
      }
      if (entry.isSymbolicLink()) {
        continue;
      }

      const absolutePath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        const relativeDirectory = normalizePath(path.relative(root, absolutePath));
        if (isIgnoredDirectory(entry.name, relativeDirectory, sourceBoundary)) {
          continue;
        }
        await walk(absolutePath, depth + 1);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const relativePath = normalizePath(path.relative(root, absolutePath));
      const realEntryPath = await fs.realpath(absolutePath);
      if (!isPathInside(root, realEntryPath) || isPathTraversal(relativePath)) {
        continue;
      }
      if (isIgnoredFile(entry.name, relativePath, sourceBoundary)) {
        continue;
      }

      if (budget && observed.length >= budget.maxFiles) throw new SourceScanError("scan_budget_exceeded");

      const stats = await fs.stat(absolutePath);
      const extension = path.extname(entry.name).toLowerCase();

      if (stats.size > maxFileBytes) {
        observed.push({
          absolutePath,
          relativePath,
          extension,
          sizeBytes: stats.size,
          text: null,
          skippedReason: "file-too-large"
        });
        if (budget) budget.checkedFiles += 1;
        continue;
      }

      if (!isTextCandidate(entry.name, extension)) {
        observed.push({
          absolutePath,
          relativePath,
          extension,
          sizeBytes: stats.size,
          text: null,
          skippedReason: "non-text"
        });
        if (budget) budget.checkedFiles += 1;
        continue;
      }

      if (budget && budget.readBytes + stats.size > budget.maxTotalBytes) throw new SourceScanError("scan_budget_exceeded");
      const text = await fs.readFile(absolutePath, "utf8");
      if (budget) {
        budget.readBytes += Buffer.byteLength(text);
        if (budget.readBytes > budget.maxTotalBytes) throw new SourceScanError("scan_budget_exceeded");
        const after = await fs.stat(absolutePath);
        if (stats.size !== after.size || stats.mtimeMs !== after.mtimeMs || stats.ctimeMs !== after.ctimeMs || stats.ino !== after.ino) {
          throw new SourceScanError("source_changed_during_check");
        }
        budget.checkedFiles += 1;
      }
      observed.push({
        absolutePath,
        relativePath,
        extension,
        sizeBytes: stats.size,
        text: text.includes("\u0000") ? null : text,
        skippedReason: text.includes("\u0000") ? "binary-like-text" : undefined
      });
    }
    if (beforeDirectory) {
      const afterDirectory = await fs.stat(directory);
      if (beforeDirectory.mtimeMs !== afterDirectory.mtimeMs || beforeDirectory.ctimeMs !== afterDirectory.ctimeMs || beforeDirectory.ino !== afterDirectory.ino) {
        throw new SourceScanError("source_changed_during_check");
      }
    }
  }

  await walk(root);
  return observed;
}

function parseObservedFile(
  file: ObservedFile,
  moduleName: string,
  fileSet: Set<string>,
  riskStart: number,
  ruleStart: number
): ParsedFile {
  if (!file.text) {
    return {
      api: [],
      database: [],
      dependencies: [],
      symbols: [],
      risks: [],
      rules: [],
      summary: `Skipped ${file.relativePath} (${file.skippedReason ?? "unreadable"}).`,
      privacy: "internal",
      riskFlags: file.skippedReason === "file-too-large" ? ["large_file_skipped"] : []
    };
  }

  const dependencies = SOURCE_EXTENSIONS.has(file.extension)
    ? extractCodeDependencies(file.relativePath, file.text, fileSet)
    : [];
  const symbols = SOURCE_EXTENSIONS.has(file.extension)
    ? extractSymbols(file.relativePath, file.text, moduleName)
    : [];
  const api = SOURCE_EXTENSIONS.has(file.extension) ? extractApiEntries(file.relativePath, file.text, symbols) : [];
  const database = DATABASE_EXTENSIONS.has(file.extension)
    ? extractDatabaseEntries(file.relativePath, file.text)
    : [];
  const risks = extractRisks(file.relativePath, file.text, riskStart);
  const rules = extractRules(file.relativePath, file.text, ruleStart);
  const riskFlags = risks.map((risk) => risk.type);
  const privacy: PrivacyLevel = risks.some((risk) => risk.type === "secret") ? "protected" : "internal";

  return {
    api,
    database,
    dependencies,
    symbols,
    risks,
    rules,
    summary: summarizeFile(file, dependencies, symbols),
    privacy,
    riskFlags
  };
}

function extractCodeDependencies(filePath: string, text: string, fileSet: Set<string>): DependencyEntry[] {
  const dependencies: DependencyEntry[] = [];
  const patterns: Array<{ regex: RegExp; kind: DependencyEntry["kind"] }> = [
    { regex: /\bimport\s+(?:type\s+)?(?:[^'"]+\s+from\s+)?["']([^"']+)["']/g, kind: "import" },
    { regex: /\bexport\s+[^'"]+\s+from\s+["']([^"']+)["']/g, kind: "export" },
    { regex: /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g, kind: "require" },
    { regex: /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g, kind: "dynamic-import" }
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.regex.exec(text)) !== null) {
      const specifier = match[1];
      const external = isExternalSpecifier(specifier);
      dependencies.push({
        from: filePath,
        to: external ? specifier : resolveRelativeSpecifier(filePath, specifier, fileSet),
        specifier,
        kind: pattern.kind,
        external
      });
    }
  }

  return dedupeDependencies(dependencies);
}

function extractPackageDependencies(observedFiles: ObservedFile[], riskStart: number): DependencyEntry[] {
  const dependencies: DependencyEntry[] = [];
  let riskOffset = riskStart;
  void riskOffset;

  for (const file of observedFiles) {
    if (path.basename(file.relativePath) !== "package.json" || !file.text) {
      continue;
    }

    try {
      const manifest = JSON.parse(file.text) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
      };
      const groups = [manifest.dependencies, manifest.devDependencies, manifest.peerDependencies];
      for (const group of groups) {
        for (const name of Object.keys(group ?? {})) {
          dependencies.push({
            from: file.relativePath,
            to: name,
            specifier: name,
            kind: "package",
            external: true
          });
        }
      }
    } catch {
      // Invalid manifests are handled as low-confidence project understanding.
    }
  }

  return dedupeDependencies(dependencies);
}

function extractSymbols(filePath: string, text: string, moduleName: string): SymbolEntry[] {
  const symbols: SymbolEntry[] = [];
  const patterns: Array<{ regex: RegExp; kind: SymbolEntry["kind"]; exported: boolean }> = [
    { regex: /\bexport\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g, kind: "function", exported: true },
    { regex: /\bexport\s+class\s+([A-Za-z_$][\w$]*)/g, kind: "class", exported: true },
    { regex: /\bexport\s+interface\s+([A-Za-z_$][\w$]*)/g, kind: "interface", exported: true },
    { regex: /\bexport\s+type\s+([A-Za-z_$][\w$]*)/g, kind: "type", exported: true },
    { regex: /\bexport\s+const\s+([A-Za-z_$][\w$]*)/g, kind: "constant", exported: true },
    { regex: /(?:^|\n)\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g, kind: "function", exported: false },
    { regex: /(?:^|\n)\s*class\s+([A-Za-z_$][\w$]*)/g, kind: "class", exported: false },
    { regex: /(?:^|\n)\s*const\s+([A-Za-z_$][\w$]*)/g, kind: "constant", exported: false }
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.regex.exec(text)) !== null) {
      const name = match[1];
      if (symbols.some((symbol) => symbol.name === name && symbol.file === filePath)) {
        continue;
      }
      symbols.push({
        name,
        kind: pattern.kind,
        file: filePath,
        line: lineNumberAt(text, match.index),
        module: moduleName,
        exported: pattern.exported
      });
    }
  }

  return symbols;
}

function extractApiEntries(filePath: string, text: string, symbols: SymbolEntry[]): ApiEntry[] {
  const entries: ApiEntry[] = [];
  const routePatterns: Array<{ regex: RegExp; methodIndex: number; routeIndex: number }> = [
    { regex: /\b(?:app|router)\.(get|post|put|patch|delete|options|head)\s*\(\s*["'`]([^"'`]+)["'`]/gi, methodIndex: 1, routeIndex: 2 },
    { regex: /@(Get|Post|Put|Patch|Delete|Options|Head)\s*\(\s*["'`]?([^"'`)]*)["'`]?\s*\)/g, methodIndex: 1, routeIndex: 2 },
    {
      regex: /\bmethod\s*:\s*["'`](GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)["'`][\s\S]{0,160}?\bpath\s*:\s*["'`]([^"'`]+)["'`]/gi,
      methodIndex: 1,
      routeIndex: 2
    }
  ];

  for (const pattern of routePatterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.regex.exec(text)) !== null) {
      const method = normalizeHttpMethod(match[pattern.methodIndex]);
      const route = sanitizeRoute(match[pattern.routeIndex] ?? "");
      const line = lineNumberAt(text, match.index);
      if (!route) {
        continue;
      }
      entries.push({
        id: stableId("API", `${filePath}:${line}:${method}:${route}`),
        name: `${method ?? "UNKNOWN"} ${route}`,
        kind: "http-route",
        source: `${filePath}:${line}`,
        method,
        route,
        summary: `HTTP ${method ?? "UNKNOWN"} route declared in ${filePath}.`,
        confidence: "medium",
        privacy: "internal"
      });
    }
  }

  const apiLikePath = /(^|\/)(api|routes|controllers?|handlers?)(\/|$)/i.test(filePath);
  if (apiLikePath && entries.length === 0) {
    const exportedHandler = symbols.find((symbol) => symbol.exported && ["function", "class", "constant"].includes(symbol.kind));
    entries.push({
      id: stableId("API", `${filePath}:handler`),
      name: exportedHandler?.name ?? path.posix.basename(filePath),
      kind: exportedHandler?.kind === "class" ? "controller" : "handler",
      source: exportedHandler ? `${filePath}:${exportedHandler.line}` : filePath,
      summary: `API-like boundary inferred from ${filePath}.`,
      confidence: "low",
      privacy: "internal"
    });
  }

  return dedupeById(entries);
}

function extractDatabaseEntries(filePath: string, text: string): DatabaseEntry[] {
  const entries: DatabaseEntry[] = [];
  const patterns: Array<{ regex: RegExp; kind: DatabaseEntry["kind"] }> = [
    { regex: /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?([A-Za-z_][\w.]*)["'`]?/gi, kind: "table" },
    { regex: /^\s*model\s+([A-Za-z_][\w]*)\s*\{/gm, kind: "model" },
    { regex: /^\s*(?:CREATE|ALTER|DROP)\s+(?:INDEX|VIEW|SCHEMA)\s+["'`]?([A-Za-z_][\w.]*)["'`]?/gim, kind: "schema" }
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.regex.exec(text)) !== null) {
      const name = sanitizeIdentifier(match[1]);
      if (!name) {
        continue;
      }
      const line = lineNumberAt(text, match.index);
      entries.push({
        id: stableId("DB", `${filePath}:${line}:${pattern.kind}:${name}`),
        name,
        kind: pattern.kind,
        source: `${filePath}:${line}`,
        summary: `Database ${pattern.kind} "${name}" declared in ${filePath}.`,
        confidence: "medium",
        privacy: "internal"
      });
    }
  }

  if (entries.length === 0) {
    entries.push({
      id: stableId("DB", `${filePath}:database-file`),
      name: path.posix.basename(filePath),
      kind: filePath.endsWith(".prisma") ? "schema" : "migration",
      source: filePath,
      summary: `Database-related file observed at ${filePath}.`,
      confidence: "low",
      privacy: "internal"
    });
  }

  return dedupeById(entries);
}

function extractRisks(filePath: string, text: string, riskStart: number): RiskEntry[] {
  const risks: RiskEntry[] = [];
  const unsafePatterns = [
    { regex: /\beval\s*\(/, message: "Dynamic eval usage can lead to code execution risk." },
    { regex: /\bnew\s+Function\s*\(/, message: "Dynamic Function constructor can lead to code execution risk." },
    { regex: /\bchild_process\b|\bexec\s*\(|\bspawn\s*\(/, message: "Process execution surface detected." }
  ];

  let offset = 0;

  if (hasSecretLikeMaterial(text)) {
    risks.push({
      id: `RISK-${String(riskStart + offset).padStart(4, "0")}`,
      type: "secret",
      severity: "high",
      message: "Secret-like material detected and excluded from AMF content.",
      file: filePath,
      evidence: "secret-like pattern matched; value redacted",
      recommendation: "Move secrets to environment variables or a secret manager and keep them out of source control.",
      privacy: "protected"
    });
    offset += 1;
  }

  for (const unsafe of unsafePatterns) {
    if (unsafe.regex.test(text)) {
      risks.push({
        id: `RISK-${String(riskStart + offset).padStart(4, "0")}`,
        type: "unsafe-code",
        severity: "medium",
        message: unsafe.message,
        file: filePath,
        evidence: "unsafe-code pattern matched; source text not copied",
        recommendation: "Review this execution surface and validate all inputs before use.",
        privacy: "internal"
      });
      offset += 1;
    }
  }

  return risks;
}

function extractRules(filePath: string, text: string, ruleStart: number): RuleEntry[] {
  const rules: RuleEntry[] = [];
  const lines = text.split(/\r?\n/);
  const ruleRegex = /\b(must|should|required|business rule|policy|invariant|never|always)\b/i;

  for (const [index, line] of lines.entries()) {
    if (!ruleRegex.test(line)) {
      continue;
    }
    const sanitized = sanitizeEvidence(line.trim());
    if (!sanitized) {
      continue;
    }
    rules.push({
      id: `RULE-${String(ruleStart + rules.length).padStart(4, "0")}`,
      text: sanitized,
      source: `${filePath}:${index + 1}`,
      confidence: "low"
    });
    if (rules.length >= 5) {
      break;
    }
  }

  return rules;
}

function summarizeFile(file: ObservedFile, dependencies: DependencyEntry[], symbols: SymbolEntry[]): string {
  if (file.extension === ".md" && file.text) {
    const heading = file.text.split(/\r?\n/).find((line) => line.trim().startsWith("#"));
    if (heading) {
      return `Documentation file headed "${sanitizeEvidence(heading.replace(/^#+\s*/, ""))}".`;
    }
  }

  if (path.basename(file.relativePath) === "package.json") {
    return `Package manifest with dependency metadata.`;
  }

  if (DATABASE_EXTENSIONS.has(file.extension)) {
    return `Database-related file in ${detectModuleName(file.relativePath)}.`;
  }

  if (SOURCE_EXTENSIONS.has(file.extension)) {
    return `Source file with ${symbols.length} detected symbols and ${dependencies.length} detected dependencies.`;
  }

  return `${detectFileKind(file.relativePath)} file observed by compiler.`;
}

function summarizeModule(module: ModuleEntry): string {
  const fileCount = module.files.length;
  const symbolCount = module.symbols.length;
  const fileWord = fileCount === 1 ? "file" : "files";
  return `Module ${module.name} contains ${fileCount} ${fileWord} and ${symbolCount} detected symbols.`;
}

function summarizeProject(
  projectName: string,
  files: FileEntry[],
  modules: ModuleEntry[],
  dependencies: DependencyEntry[],
  risks: RiskEntry[]
): string {
  return `${projectName} compiled into Project DNA with ${files.length} files, ${modules.length} modules, ${dependencies.length} dependencies and ${risks.length} risks.`;
}

function createHistoryEntries(projectName: string, observedFiles: ObservedFile[], maxFileBytes: number): HistoryEntry[] {
  const skipped = observedFiles.filter((file) => file.skippedReason).length;
  return [
    {
      id: "HISTORY-0001",
      kind: "compile",
      summary: `${projectName} compiled from ${observedFiles.length} observed files.`,
      confidence: "high",
      privacy: "internal"
    },
    {
      id: "HISTORY-0002",
      kind: "source-boundary",
      summary: `Compiler excluded ignored directories, secret-like filenames and files larger than ${maxFileBytes} bytes; ${skipped} files were skipped by type or size.`,
      confidence: "medium",
      privacy: "internal"
    }
  ];
}

function createArchitectureEntries(
  modules: ModuleEntry[],
  dependencies: DependencyEntry[],
  risks: RiskEntry[]
): ArchitectureEntry[] {
  const entries: ArchitectureEntry[] = [];

  for (const module of modules) {
    entries.push({
      id: stableId("ARCH", `module:${module.name}`),
      kind: "boundary",
      summary: `Module boundary "${module.name}" owns ${module.files.length} files and exposes ${module.symbols.length} detected symbols.`,
      source: module.path,
      confidence: module.confidence,
      privacy: "internal"
    });
  }

  const externalDependencies = Array.from(new Set(dependencies.filter((dependency) => dependency.external).map((dependency) => dependency.to))).sort();
  if (externalDependencies.length > 0) {
    entries.push({
      id: stableId("ARCH", `external-dependencies:${externalDependencies.join(",")}`),
      kind: "dependency",
      summary: `Project depends on ${externalDependencies.length} external packages or module specifiers.`,
      source: "dependencies",
      confidence: "medium",
      privacy: "internal"
    });
  }

  if (risks.length > 0) {
    entries.push({
      id: stableId("ARCH", `risk-zones:${risks.map((risk) => risk.id).join(",")}`),
      kind: "risk",
      summary: `${risks.length} risk candidates were detected and should constrain future context generation.`,
      source: "risks",
      confidence: "medium",
      privacy: risks.some((risk) => risk.privacy === "protected") ? "protected" : "internal"
    });
  }

  return entries;
}

function createUnresolvedQuestions(
  projectName: string,
  api: ApiEntry[],
  database: DatabaseEntry[],
  rules: RuleEntry[],
  risks: RiskEntry[]
): UnresolvedQuestionEntry[] {
  const questions: UnresolvedQuestionEntry[] = [
    {
      id: "QUESTION-0001",
      question: `Which invariants in ${projectName} are business-critical but not explicit in source or docs?`,
      confidence: "low",
      privacy: "internal"
    }
  ];

  if (api.length === 0) {
    questions.push({
      id: `QUESTION-${String(questions.length + 1).padStart(4, "0")}`,
      question: "No API surface was confidently detected; confirm whether the project exposes APIs through unsupported patterns.",
      confidence: "low",
      privacy: "internal"
    });
  }

  if (database.length === 0) {
    questions.push({
      id: `QUESTION-${String(questions.length + 1).padStart(4, "0")}`,
      question: "No database schema was detected; confirm whether persistence exists outside the observed repository boundary.",
      confidence: "low",
      privacy: "internal"
    });
  }

  if (rules.length === 0) {
    questions.push({
      id: `QUESTION-${String(questions.length + 1).padStart(4, "0")}`,
      question: "No business rules were detected from explicit rule language; ask maintainers for domain invariants before high-risk edits.",
      confidence: "low",
      privacy: "internal"
    });
  }

  if (risks.some((risk) => risk.type === "secret")) {
    questions.push({
      id: `QUESTION-${String(questions.length + 1).padStart(4, "0")}`,
      question: "Secret-like material was detected; verify the repository hygiene and rotate exposed credentials if real.",
      confidence: "medium",
      privacy: "protected"
    });
  }

  return questions;
}

function getOrCreateModule(modules: Map<string, ModuleEntry>, name: string, relativePath: string): ModuleEntry {
  const existing = modules.get(name);
  if (existing) {
    return existing;
  }

  const module: ModuleEntry = {
    name,
    path: name === "root" ? "." : relativePath.split("/").slice(0, name.split("/").length).join("/"),
    files: [],
    symbols: [],
    dependencies: [],
    summary: "",
    confidence: "medium"
  };
  modules.set(name, module);
  return module;
}

async function detectProjectName(root: string): Promise<string> {
  const packagePath = path.join(root, "package.json");
  try {
    const manifest = JSON.parse(await fs.readFile(packagePath, "utf8")) as { name?: string };
    if (manifest.name && typeof manifest.name === "string") {
      return manifest.name;
    }
  } catch {
    // Fall through to folder name.
  }
  return path.basename(root);
}

function detectModuleName(relativePath: string): string {
  const parts = normalizePath(relativePath).split("/").filter(Boolean);
  if (parts.length <= 1) {
    return "root";
  }
  if (parts[0] === "packages" && parts[1]) {
    return `packages/${parts[1]}`;
  }
  if (["src", "app", "apps", "lib", "services", "modules", "features"].includes(parts[0]) && parts[1]) {
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0];
}

function detectFileKind(relativePath: string): FileEntry["kind"] {
  const extension = path.extname(relativePath).toLowerCase();
  const base = path.basename(relativePath).toLowerCase();

  if (base.includes(".test.") || base.includes(".spec.") || relativePath.includes("/test/") || relativePath.includes("/tests/")) {
    return "test";
  }
  if (extension === ".md" || relativePath.startsWith("docs/")) {
    return "documentation";
  }
  if (DATABASE_EXTENSIONS.has(extension) || relativePath.startsWith("database/") || relativePath.startsWith("db/")) {
    return "database";
  }
  if (SOURCE_EXTENSIONS.has(extension)) {
    return "source";
  }
  if (["package.json", "tsconfig.json", ".eslintrc", ".prettierrc"].includes(base) || extension === ".yml" || extension === ".yaml") {
    return "config";
  }
  return "unknown";
}

function resolveRelativeSpecifier(fromFile: string, specifier: string, fileSet: Set<string>): string {
  const fromDir = path.posix.dirname(fromFile);
  const base = normalizePath(path.posix.normalize(path.posix.join(fromDir, specifier)));
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.mjs`,
    `${base}.cjs`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
    `${base}/index.js`,
    `${base}/index.jsx`
  ];

  return candidates.find((candidate) => fileSet.has(candidate)) ?? base;
}

function isExternalSpecifier(specifier: string): boolean {
  return !specifier.startsWith(".") && !specifier.startsWith("/");
}

async function createSourceBoundary(root: string, ignoreFileName: string): Promise<SourceBoundaryRules> {
  const ignoreRules = await readLmtiIgnoreRules(root, ignoreFileName);
  return {
    ignoredDirectories: [...IGNORED_DIRECTORIES, ...IGNORED_PATH_PATTERNS.map((pattern) => pattern.source)],
    ignoredFiles: [
      ...IGNORED_FILE_PATTERNS.map((pattern) => pattern.source),
      ...IGNORED_PATH_PATTERNS.map((pattern) => pattern.source),
      ...ignoreRules.map((rule) => `${normalizePath(ignoreFileName)}:${rule.raw}`)
    ],
    ignoreRules
  };
}

async function readLmtiIgnoreRules(root: string, ignoreFileName: string): Promise<IgnoreRule[]> {
  let text = "";
  try {
    const ignorePath = path.resolve(root, ignoreFileName);
    if (!isPathInside(root, ignorePath)) throw new SourceScanError("source_root_not_authorized");
    const realIgnorePath = await fs.realpath(ignorePath);
    if (!isPathInside(root, realIgnorePath)) throw new SourceScanError("source_root_not_authorized");
    const stats = await fs.stat(realIgnorePath);
    if (stats.size > 64 * 1024) throw new SourceScanError("scan_budget_exceeded");
    text = await fs.readFile(realIgnorePath, "utf8");
    if (Buffer.byteLength(text) > 64 * 1024) throw new SourceScanError("scan_budget_exceeded");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    return [];
  }

  return text
    .split(/\r?\n/)
    .map(parseLmtiIgnoreRule)
    .filter((rule): rule is IgnoreRule => Boolean(rule));
}

function parseLmtiIgnoreRule(line: string): IgnoreRule | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return undefined;
  }

  const negated = trimmed.startsWith("!");
  const rawPattern = negated ? trimmed.slice(1).trim() : trimmed;
  if (!rawPattern || rawPattern.startsWith("#")) {
    return undefined;
  }

  const normalized = normalizePath(rawPattern);
  const directoryOnly = normalized.endsWith("/");
  const anchored = normalized.startsWith("/");
  const body = normalized.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!body) {
    return undefined;
  }

  const hasSlash = body.includes("/");
  const prefix = anchored || hasSlash ? "^" : "(^|.*/)";
  const suffix = directoryOnly ? "(?:/.*)?$" : "$";
  return {
    raw: trimmed,
    negated,
    regex: new RegExp(`${prefix}${globToRegexSource(body)}${suffix}`, "i")
  };
}

function globToRegexSource(pattern: string): string {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];
    if (char === "*" && next === "*") {
      source += ".*";
      index += 1;
      continue;
    }
    if (char === "*") {
      source += "[^/]*";
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    source += escapeRegex(char);
  }
  return source;
}

function escapeRegex(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function isIgnoredDirectory(name: string, relativePath: string, sourceBoundary: SourceBoundaryRules): boolean {
  return (
    IGNORED_DIRECTORIES.includes(name.toLowerCase()) ||
    isIgnoredByPathPattern(relativePath) ||
    isIgnoredByLmtiIgnore(relativePath, sourceBoundary.ignoreRules)
  );
}

function isIgnoredFile(name: string, relativePath: string, sourceBoundary: SourceBoundaryRules): boolean {
  const normalizedName = name.toLowerCase();
  const normalizedPath = relativePath.toLowerCase();
  const ignoredByDefaultFilePattern = !isEnvExampleFile(name) &&
    IGNORED_FILE_PATTERNS.some((pattern) => pattern.test(normalizedName) || pattern.test(normalizedPath));

  return (
    ignoredByDefaultFilePattern ||
    isIgnoredByPathPattern(relativePath) ||
    isIgnoredByLmtiIgnore(relativePath, sourceBoundary.ignoreRules)
  );
}

function isEnvExampleFile(name: string): boolean {
  const normalizedName = name.toLowerCase();
  return normalizedName === ".env.example" || normalizedName === ".env.sample" || normalizedName.endsWith(".example.env");
}

function isIgnoredByPathPattern(relativePath: string): boolean {
  const normalizedPath = normalizePath(relativePath);
  return IGNORED_PATH_PATTERNS.some((pattern) => pattern.test(normalizedPath));
}

function isIgnoredByLmtiIgnore(relativePath: string, ignoreRules: IgnoreRule[]): boolean {
  const normalizedPath = normalizePath(relativePath).replace(/\/+$/, "");
  let ignored = false;
  for (const rule of ignoreRules) {
    if (rule.regex.test(normalizedPath)) {
      ignored = !rule.negated;
    }
  }
  return ignored;
}

function isTextCandidate(name: string, extension: string): boolean {
  if (TEXT_EXTENSIONS.has(extension)) {
    return true;
  }
  return ["Dockerfile", "Makefile", "LICENSE"].includes(name);
}

function countLines(text: string): number {
  if (!text) {
    return 0;
  }
  return text.split(/\r?\n/).length;
}

function lineNumberAt(text: string, index: number): number {
  return text.slice(0, index).split(/\r?\n/).length;
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function stableId(prefix: string, input: string): string {
  return `${prefix}-${hashText(input).slice(0, 12).toUpperCase()}`;
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}

function normalizeHttpMethod(value: string | undefined): string | undefined {
  return value ? value.toUpperCase() : undefined;
}

function sanitizeRoute(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 120) {
    return "";
  }
  return trimmed.replace(/\s+/g, " ");
}

function sanitizeIdentifier(value: string): string {
  const trimmed = value.trim().replace(/^["'`]+|["'`]+$/g, "");
  return /^[A-Za-z_][\w.]*$/.test(trimmed) ? trimmed : "";
}

function sanitizeEvidence(value: string): string {
  return redactText(value)
    .replace(/\s+/g, " ")
    .slice(0, 180)
    .trim();
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isPathTraversal(relativePath: string): boolean {
  return relativePath === ".." || relativePath.startsWith("../") || path.isAbsolute(relativePath);
}

function dedupeDependencies(dependencies: DependencyEntry[]): DependencyEntry[] {
  const seen = new Set<string>();
  return dependencies.filter((dependency) => {
    const key = `${dependency.from}\u0000${dependency.to}\u0000${dependency.kind}\u0000${dependency.specifier}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function dedupeById<T extends { id: string }>(entries: T[]): T[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (seen.has(entry.id)) {
      return false;
    }
    seen.add(entry.id);
    return true;
  });
}
