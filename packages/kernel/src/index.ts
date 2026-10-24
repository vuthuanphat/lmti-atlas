import type {
  AmfDocument,
  ApiEntry,
  ArchitectureEntry,
  ContextMemory,
  ContextPack,
  ContextPackOptions,
  DatabaseEntry,
  FileEntry,
  HistoryEntry,
  InferredIntent,
  InspectionStats,
  IntentCategory,
  MemorySearchResult,
  ModuleEntry,
  RiskEntry,
  RuleEntry,
  UnresolvedQuestionEntry
} from "@atlas/types";

const KERNEL_VERSION = "0.1.0";
const LOW_SCORE_THRESHOLD = 3;

const INTENT_LEXICON: Record<IntentCategory, string[]> = {
  bugfix: ["bug", "fix", "bugfix", "broken", "fail", "failed", "failure", "error", "exception", "issue"],
  deploy: ["deploy", "deployment", "release", "build", "env", "environment", "docker", "ci", "cd", "log", "logs"],
  debug: ["debug", "trace", "error", "exception", "stack", "risk", "investigate", "diagnose"],
  auth: ["auth", "login", "logout", "session", "jwt", "token", "oauth", "password"],
  permission: ["permission", "403", "forbidden", "unauthorized", "role", "access", "least", "privilege", "deny", "denied"],
  routing: ["route", "routing", "router", "redirect", "path", "url", "endpoint"],
  dashboard: ["dashboard", "summary", "metric", "panel", "agent"],
  ui: ["ui", "ux", "screen", "button", "modal", "form", "view", "layout"],
  api: ["api", "endpoint", "route", "http", "request", "response", "controller", "handler"],
  database: ["database", "db", "sql", "schema", "table", "query"],
  partner: ["partner", "vendor", "affiliate"],
  admin: ["admin", "administrator", "backoffice"],
  memory: ["memory", "remember", "lesson", "decision", "rule", "context"],
  privacy: ["privacy", "secret", "confidential", "sensitive", "redact", "prompt", "policy"],
  unknown: []
};

const NEGATIVE_KEYWORDS_BY_INTENT: Partial<Record<IntentCategory, string[]>> = {
  dashboard: ["logo", "brand", "image", "asset"],
  permission: ["logo", "ui asset", "brand", "image"],
  debug: ["logo", "brand", "image", "asset"],
  deploy: ["logo", "brand", "image", "asset"],
  routing: ["logo", "brand", "image", "asset"]
};

export class MindKernel {
  private readonly amf: AmfDocument;

  constructor(amf: AmfDocument) {
    this.amf = loadAmf(amf);
  }

  inspect(): InspectionStats {
    return inspectAmf(this.amf);
  }

  createContextPack(task: string, options: ContextPackOptions = {}): ContextPack {
    return buildContextPack(this.amf, task, options);
  }

  getAmf(): AmfDocument {
    return this.amf;
  }
}

export function createMindKernel(amf: AmfDocument): MindKernel {
  return new MindKernel(amf);
}

export function loadAmf(input: string | AmfDocument): AmfDocument {
  const parsed = typeof input === "string" ? (JSON.parse(input) as Partial<AmfDocument>) : input;
  const amf = normalizeAmf(parsed);
  validateAmf(amf);
  return amf;
}

export function inspectAmf(amfInput: AmfDocument): InspectionStats {
  const amf = loadAmf(amfInput);
  return {
    project: amf.project.name,
    files: amf.files.length,
    modules: amf.modules.length,
    dependencies: amf.dependencies.length,
    symbols: amf.symbols.length,
    api: amf.api.length,
    database: amf.database.length,
    rules: amf.rules.length,
    risks: amf.risks.length,
    architecture: amf.architecture.length,
    unresolvedQuestions: amf.unresolvedQuestions.length,
    lastCompiled: amf.project.compiledAt,
    amfVersion: amf.version
  };
}

export function formatInspection(stats: InspectionStats): string {
  return [
    `Project: ${stats.project}`,
    `Files: ${stats.files}`,
    `Modules: ${stats.modules}`,
    `Dependencies: ${stats.dependencies}`,
    `Symbols: ${stats.symbols}`,
    `API: ${stats.api}`,
    `Database: ${stats.database}`,
    `Rules: ${stats.rules}`,
    `Risks: ${stats.risks}`,
    `Architecture: ${stats.architecture}`,
    `Unresolved questions: ${stats.unresolvedQuestions}`,
    `AMF version: ${stats.amfVersion}`,
    `Last compiled: ${stats.lastCompiled}`
  ].join("\n");
}

export function inferIntent(task: string): InferredIntent {
  const normalized = normalizeSearchText(task);
  const taskTokens = tokenize(task);
  const scores = new Map<IntentCategory, number>();

  for (const [intent, terms] of Object.entries(INTENT_LEXICON) as Array<[IntentCategory, string[]]>) {
    if (intent === "unknown") {
      continue;
    }
    let score = 0;
    for (const term of terms) {
      const normalizedTerm = normalizeSearchText(term);
      if (normalized.includes(normalizedTerm)) {
        score += normalizedTerm.length > 3 ? 2 : 1;
      }
    }
    if (score > 0) {
      scores.set(intent, score);
    }
  }

  if (normalized.includes("403") || normalized.includes("forbidden")) {
    scores.set("permission", (scores.get("permission") ?? 0) + 8);
    scores.set("api", (scores.get("api") ?? 0) + 1);
  }
  if (normalized.includes("dashboard") && normalized.includes("summary")) {
    scores.set("dashboard", (scores.get("dashboard") ?? 0) + 2);
    scores.set("api", (scores.get("api") ?? 0) + 1);
  }
  if (normalized.includes("partner")) {
    scores.set("partner", (scores.get("partner") ?? 0) + 3);
  }
  if (normalized.includes("dashboard") && normalized.includes("agent")) {
    scores.set("dashboard", (scores.get("dashboard") ?? 0) + 3);
  }
  if (normalized.includes("error")) {
    scores.set("bugfix", (scores.get("bugfix") ?? 0) + 3);
    scores.set("debug", (scores.get("debug") ?? 0) + 2);
  }

  const ranked = Array.from(scores.entries()).sort((left, right) => right[1] - left[1]);
  const primaryIntent = ranked[0]?.[0] ?? "unknown";
  const secondaryIntents = ranked
    .slice(1)
    .filter(([, score]) => score > 0)
    .map(([intent]) => intent)
    .slice(0, 4);

  const keywordSet = new Set(taskTokens);
  for (const intent of [primaryIntent, ...secondaryIntents]) {
    for (const keyword of expandKeywordsForIntent(intent)) {
      keywordSet.add(keyword);
    }
  }

  const negativeSet = new Set<string>();
  for (const intent of [primaryIntent, ...secondaryIntents]) {
    for (const keyword of NEGATIVE_KEYWORDS_BY_INTENT[intent] ?? []) {
      negativeSet.add(keyword);
    }
  }

  const totalScore = ranked.reduce((sum, [, score]) => sum + score, 0);
  const confidence = primaryIntent === "unknown" ? 0 : Math.min(1, Math.max(0.25, (ranked[0]?.[1] ?? 0) / Math.max(4, totalScore)));

  return {
    primaryIntent,
    secondaryIntents,
    keywords: Array.from(keywordSet),
    negativeKeywords: Array.from(negativeSet),
    confidence: Number(confidence.toFixed(2))
  };
}

export function buildContextPack(amfInput: AmfDocument, task: string, options: ContextPackOptions = {}): ContextPack {
  const amf = loadAmf(amfInput);
  const includeSecret = Boolean(options.includeSecret);
  const includeLowScore = Boolean(options.includeLowScore);
  const inferredIntent = options.inferredIntent ?? inferIntent(task);
  const keywords = inferredIntent.keywords.length > 0 ? inferredIntent.keywords : tokenize(task);
  const minScore = includeLowScore ? 1 : LOW_SCORE_THRESHOLD;
  const scoredModules = amf.modules
    .map((module) => ({
      ...module,
      ...scoreContextCandidate(inferredIntent, [module.name, module.path, module.summary, ...module.dependencies], { moduleLike: true })
    }))
    .filter((module) => module.score >= minScore)
    .sort(sortByScore)
    .slice(0, 8);

  const allScoredFiles = amf.files.map((file) => ({
    ...file,
    ...scoreContextCandidate(inferredIntent, [file.path, file.module, file.kind, file.summary, ...file.riskFlags], { moduleLike: true, fileKind: file.kind })
  }));
  const scoredFiles = allScoredFiles
    .filter((file) => file.score >= minScore && (includeSecret || file.privacy !== "protected"))
    .sort(sortByScore)
    .slice(0, 12);
  const filteredOutFiles = allScoredFiles.filter((file) => file.score < minScore || (!includeSecret && file.privacy === "protected")).length;

  const scoredApi = amf.api
    .map((entry) => ({
      ...entry,
      ...scoreContextCandidate(inferredIntent, [entry.name, entry.kind, entry.method ?? "", entry.route ?? "", entry.summary], { routeLike: true })
    }))
    .filter((entry) => entry.score >= minScore && (includeSecret || entry.privacy !== "protected"))
    .sort(sortByScore)
    .slice(0, 8);

  const scoredDatabase = amf.database
    .map((entry) => ({ ...entry, ...scoreContextCandidate(inferredIntent, [entry.name, entry.kind, entry.summary, entry.source], { fileKind: "database" }) }))
    .filter((entry) => entry.score >= minScore && (includeSecret || entry.privacy !== "protected"))
    .sort(sortByScore)
    .slice(0, 8);

  const scoredRules = amf.rules
    .map((rule) => ({ ...rule, ...scoreContextCandidate(inferredIntent, [rule.text, rule.source]) }))
    .filter((rule) => rule.score >= minScore)
    .sort(sortByScore)
    .slice(0, 8);

  const scoredRisks = amf.risks
    .map((risk) => ({
      ...sanitizeRiskForContext(risk, includeSecret),
      ...scoreContextCandidate(inferredIntent, [risk.type, risk.message, risk.file ?? "", risk.recommendation], { riskLike: true })
    }))
    .filter((risk) => risk.score >= minScore || scoredFiles.some((file) => file.path === risk.file))
    .sort(sortByScore)
    .slice(0, 8);

  const scoredArchitecture = amf.architecture
    .map((entry) => ({ ...entry, ...scoreContextCandidate(inferredIntent, [entry.kind, entry.summary, entry.source], { moduleLike: true }) }))
    .filter((entry) => entry.score >= minScore || scoredModules.some((module) => entry.source === module.path || entry.summary.includes(module.name)))
    .sort(sortByScore)
    .slice(0, 8);

  const relatedMemories = (options.memories ?? [])
    .filter((result) => includeSecret || result.record.sensitivity !== "secret")
    .map((result) => memoryToContext(result, includeSecret));
  const relatedShortTermMemories = relatedMemories.filter((memory) => memory.scope === "short_term").slice(0, 8);
  const relatedLongTermMemories = relatedMemories.filter((memory) => memory.scope === "long_term").slice(0, 8);

  return {
    task,
    generatedAt: new Date().toISOString(),
    kernel: {
      name: "Mind Kernel",
      version: KERNEL_VERSION
    },
    project: amf.project.name,
    source: {
      amfVersion: amf.version,
      compiledAt: amf.project.compiledAt,
      checksum: amf.project.checksum,
      freshness: options.sourceFreshness ?? {
        status: "unknown", checkedAt: new Date().toISOString(), scope: "compiler-source-boundary",
        reasons: ["freshness_not_checked"], checkedFileCount: 0
      }
    },
    memorySource: options.memorySource,
    inferredIntent,
    filteredOut: {
      files: filteredOutFiles,
      memories: options.memoriesFilteredOut ?? 0
    },
    relatedModules: scoredModules.map(({ name, path, summary, dependencies, score, why }) => ({
      name,
      path,
      summary,
      dependencies,
      score,
      why
    })),
    relatedFiles: scoredFiles.map(({ path, module, kind, summary, privacy, riskFlags, score, why }) => ({
      path,
      module,
      kind,
      summary,
      privacy,
      riskFlags,
      score,
      why
    })),
    relatedApi: scoredApi,
    relatedDatabase: scoredDatabase,
    knownRules: scoredRules,
    risks: scoredRisks,
    architecture: scoredArchitecture,
    history: amf.history.slice(0, 5),
    unresolvedQuestions: selectQuestions(amf.unresolvedQuestions, keywords),
    relatedShortTermMemories,
    relatedLongTermMemories,
    recommendedSteps: [
      ...(options.sourceFreshness?.status === "fresh" ? [] : [
        "Compiled context is stale or unverified. Run `lmti compile`, then recheck sources before relying on this context as current truth."
      ]),
      ...recommendSteps(
      scoredModules,
      scoredFiles,
      scoredApi,
      scoredDatabase,
      scoredRisks,
      scoredArchitecture,
      relatedShortTermMemories,
      relatedLongTermMemories
    )]
  };
}

function normalizeAmf(input: Partial<AmfDocument>): AmfDocument {
  return {
    version: input.version ?? "",
    generatedAt: input.generatedAt ?? input.project?.compiledAt ?? "",
    project: input.project as AmfDocument["project"],
    modules: input.modules ?? [],
    files: input.files ?? [],
    symbols: input.symbols ?? [],
    dependencies: input.dependencies ?? [],
    api: input.api ?? [],
    database: input.database ?? [],
    rules: input.rules ?? [],
    risks: input.risks ?? [],
    history: input.history ?? [],
    architecture: input.architecture ?? [],
    summaries: input.summaries ?? [],
    unresolvedQuestions: input.unresolvedQuestions ?? []
  };
}

function validateAmf(amf: AmfDocument): void {
  if (!amf.version) {
    throw new Error("Invalid AMF: version is required.");
  }
  if (!amf.project?.name || !amf.project.compiledAt || !amf.project.checksum) {
    throw new Error("Invalid AMF: project identity, compiledAt and checksum are required.");
  }
  const arrayFields: Array<keyof Pick<
    AmfDocument,
    "modules" | "files" | "symbols" | "dependencies" | "api" | "database" | "rules" | "risks" | "history" | "architecture" | "summaries" | "unresolvedQuestions"
  >> = [
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
  ];
  for (const field of arrayFields) {
    if (!Array.isArray(amf[field])) {
      throw new Error(`Invalid AMF: ${field} must be an array.`);
    }
  }
}

function sanitizeRiskForContext(risk: RiskEntry, includeSecret: boolean): RiskEntry {
  if (risk.privacy !== "protected" || includeSecret) {
    return risk;
  }

  return {
    ...risk,
    evidence: "Protected evidence withheld by Mind Kernel."
  };
}

function selectQuestions(questions: UnresolvedQuestionEntry[], keywords: string[]): UnresolvedQuestionEntry[] {
  const scored = questions
    .map((question) => ({ question, score: scoreText(keywords, [question.question, question.source ?? "", question.privacy]) }))
    .sort((left, right) => right.score - left.score);
  return scored.slice(0, 5).map((entry) => entry.question);
}

function recommendSteps(
  modules: Array<ModuleEntry & { score: number }>,
  files: Array<FileEntry & { score: number }>,
  api: Array<ApiEntry & { score: number }>,
  database: Array<DatabaseEntry & { score: number }>,
  risks: Array<RiskEntry & { score: number }>,
  architecture: Array<ArchitectureEntry & { score: number }>,
  shortTermMemories: ContextMemory[],
  longTermMemories: ContextMemory[]
): string[] {
  const steps = [
    "Review the highest-scoring cognitive structures before editing.",
    "Confirm compiled summaries still match source reality when the task is high impact."
  ];

  if (architecture.length > 0) {
    steps.push("Use architecture entries to preserve module boundaries and dependency direction.");
  }

  if (api.length > 0) {
    steps.push("Check related API surfaces for caller-visible behavior changes.");
  }

  if (database.length > 0) {
    steps.push("Check related database structures before changing persistence behavior.");
  }

  if (risks.length > 0) {
    steps.push("Check risk zones before making changes, especially protected findings.");
  }

  if (files.some((file) => file.kind === "test")) {
    steps.push("Run or update the related tests after the change.");
  } else {
    steps.push("Add or identify a focused verification path for this task.");
  }

  if (modules.some((module) => module.dependencies.length > 0)) {
    steps.push("Check module dependencies for downstream impact.");
  }

  if (shortTermMemories.length > 0) {
    steps.push("Use related short-term memory to preserve active task context.");
  }

  if (longTermMemories.length > 0) {
    steps.push("Apply related long-term memory before changing behavior.");
  }

  return steps;
}

function expandKeywordsForIntent(intent: IntentCategory): string[] {
  switch (intent) {
    case "permission":
      return ["permission", "access", "403", "least privilege"];
    case "routing":
      return ["route", "routing", "redirect", "path"];
    case "dashboard":
      return ["dashboard", "summary", "agent"];
    case "deploy":
      return ["deploy", "build", "env", "logs"];
    case "debug":
      return ["debug", "error", "risk", "module"];
    case "bugfix":
      return ["bug", "fix", "error"];
    case "api":
      return ["api", "endpoint", "route"];
    case "database":
      return ["database", "schema", "table", "query"];
    case "privacy":
      return ["privacy", "secret", "confidential", "prompt policy"];
    case "memory":
      return ["memory", "lesson", "rule", "decision"];
    default:
      return INTENT_LEXICON[intent] ?? [];
  }
}

function scoreContextCandidate(
  intent: InferredIntent,
  values: string[],
  options: { routeLike?: boolean; moduleLike?: boolean; riskLike?: boolean; fileKind?: string } = {}
): { score: number; why: string[] } {
  const corpus = normalizeSearchText(values.join(" "));
  const why: string[] = [];
  let intentMatch = 0;
  let routeMatch = 0;
  let moduleMatch = 0;
  let keywordMatch = 0;
  let negativeKeywordPenalty = 0;
  let kindWeight = 0;

  const primaryTerms = [intent.primaryIntent, ...expandKeywordsForIntent(intent.primaryIntent)].map(normalizeSearchText);
  if (intent.primaryIntent !== "unknown" && primaryTerms.some((term) => term && corpus.includes(term))) {
    intentMatch = 1;
    why.push(`matched primary intent ${intent.primaryIntent}`);
  }

  for (const secondary of intent.secondaryIntents) {
    const secondaryTerms = [secondary, ...expandKeywordsForIntent(secondary)].map(normalizeSearchText);
    if (secondaryTerms.some((term) => term && corpus.includes(term))) {
      intentMatch += 0.5;
      why.push(`matched secondary intent ${secondary}`);
    }
  }

  if (options.routeLike || /\/[a-z0-9_-]+/i.test(corpus) || corpus.includes("route") || corpus.includes("endpoint")) {
    if (intent.primaryIntent === "routing" || intent.secondaryIntents.includes("routing") || intent.secondaryIntents.includes("api") || intent.primaryIntent === "api") {
      routeMatch = 1;
      why.push("matched route/API surface");
    }
  }

  if (options.moduleLike && intent.keywords.some((keyword) => corpus.includes(normalizeSearchText(keyword)))) {
    moduleMatch = 1;
    why.push("matched module or file boundary");
  }

  for (const keyword of intent.keywords) {
    const normalizedKeyword = normalizeSearchText(keyword);
    if (normalizedKeyword && corpus.includes(normalizedKeyword)) {
      keywordMatch += normalizedKeyword.length > 3 ? 2 : 1;
    }
  }
  if (keywordMatch > 0) {
    why.push(`matched ${keywordMatch} keyword weight`);
  }

  for (const keyword of intent.negativeKeywords) {
    const normalizedKeyword = normalizeSearchText(keyword);
    if (normalizedKeyword && corpus.includes(normalizedKeyword)) {
      negativeKeywordPenalty += 1;
    }
  }
  if (negativeKeywordPenalty > 0) {
    why.push(`penalized ${negativeKeywordPenalty} negative keyword match`);
  }

  if (options.riskLike && (intent.primaryIntent === "debug" || intent.primaryIntent === "bugfix" || intent.secondaryIntents.includes("debug"))) {
    kindWeight += 2;
    why.push("risk entry fits debug/bugfix intent");
  }
  if (options.fileKind === "database" && intent.primaryIntent === "database") {
    kindWeight += 2;
    why.push("database file fits database intent");
  }

  const score = intentMatch * 5 + routeMatch * 4 + moduleMatch * 3 + kindWeight + keywordMatch - negativeKeywordPenalty * 5;
  return {
    score: Math.max(0, Math.round(score * 10) / 10),
    why
  };
}

function memoryToContext(result: MemorySearchResult, includeSecret: boolean): ContextMemory {
  const { record, score } = result;
  const base = {
    id: record.id,
    scope: record.scope,
    kind: record.kind,
    title: record.title,
    tags: record.tags,
    importance: record.importance,
    confidence: record.confidence,
    sensitivity: record.sensitivity,
    promptPolicy: result.promptPolicy ?? record.promptPolicy,
    mode: result.mode && result.mode !== "excluded" ? result.mode : undefined,
    why: result.why,
    score,
    activation: result.activation
  };

  if (result.mode === "metadata_only") {
    return {
      ...base,
      mode: "metadata_only"
    };
  }

  if (result.mode === "summary") {
    return {
      ...base,
      mode: "summary",
      summary: record.content
    };
  }

  if (result.mode === "raw") {
    return {
      ...base,
      mode: "raw",
      content: record.content
    };
  }

  if (record.sensitivity === "confidential") {
    return {
      ...base,
      summary: "Confidential memory matched. Content withheld; use title, tags and source refs only."
    };
  }

  if (record.sensitivity === "secret" && !includeSecret) {
    return {
      ...base,
      summary: "Secret memory withheld."
    };
  }

  return {
    ...base,
    mode: "raw",
    content: record.content
  };
}

function scoreText(keywords: string[], values: string[]): number {
  if (keywords.length === 0) {
    return 0;
  }

  const corpus = normalizeSearchText(values.join(" "));
  let score = 0;

  for (const keyword of keywords) {
    if (corpus.includes(keyword)) {
      score += keyword.length > 3 ? 2 : 1;
    }
  }

  return score;
}

function tokenize(task: string): string[] {
  const stopWords = new Set(["the", "and", "for", "with", "that", "this", "from", "into", "fix", "bug"]);
  return Array.from(
    new Set(
      normalizeSearchText(task)
        .split(/[^a-z0-9_]+/i)
        .map((part) => part.trim())
        .filter((part) => part.length >= 2 && !stopWords.has(part))
    )
  );
}

function sortByScore<T extends { score: number }>(left: T, right: T): number {
  return right.score - left.score;
}

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}
