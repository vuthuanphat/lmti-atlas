import type {
  ContextMemory as AtlasContextMemory,
  InferredIntent as AtlasInferredIntent,
  MemorySearchResult as AtlasMemorySearchResult
} from "./memory";

export const AMF_VERSION = "0.1.0";

export type {
  ContextMemory,
  InferredIntent,
  IntentCategory,
  CommandRunSummary,
  MemoryContextMode,
  MemoryConfidence,
  DecisionSummary,
  ErrorSummary,
  Evidence,
  EvidenceType,
  FileTouchSummary,
  LessonApprovalStatus,
  LessonCandidate,
  LessonCandidateType,
  MemoryAssociation,
  MemoryKind,
  MemoryPatch,
  MemoryRecord,
  MemoryScope,
  MemorySearchOptions,
  MemorySearchResult,
  MemorySensitivity,
  MemoryStatus,
  NewMemoryRecord,
  PromptPolicy,
  SourceRef,
  TaskObservation,
  TaskObservationPrivacyStatus,
  TaskOutcome,
  TestRunSummary
} from "./memory";

export type {
  AccessDecision,
  AccessRole,
  AuditEvent,
  AuditIntegrityReport,
  AuditRetentionResult,
  PrivacyContext,
  PrivacyEvaluation,
  PrivacyPolicy,
  PrivacyProtectedRecord,
  SensitivityLevel
} from "./privacy";

export type {
  AdapterKind,
  AdapterManifest,
  AdapterPrivacyProfile,
  AdapterSandboxResult,
  AdapterScope,
  BlockedMemory,
  ContextCandidate,
  ContextCandidateStrategy,
  ContextDecisionExplanation,
  ContextEgressScan,
  ContextPackage,
  ContextRequest,
  HardGateReason,
  MemoryLifecycleStatus,
  MemoryMetadata,
  MetadataGateResult,
  ObserverFrame,
  PolicyAction,
  PolicyDecision,
  PolicyEffect,
  PolicySafeMemoryResult,
  PreflightResult
} from "./preflight";

export type PrivacyLevel = "public" | "internal" | "protected";
export type Confidence = "low" | "medium" | "high";
export type RiskSeverity = "low" | "medium" | "high";

export interface ProjectMetadata {
  name: string;
  root: string;
  compiledAt: string;
  atlasVersion: string;
  amfVersion: string;
  compiler: {
    name: string;
    version: string;
  };
  sourceBoundary: {
    root: string;
    ignoredDirectories: string[];
    ignoredFiles: string[];
    maxFileBytes: number;
  };
  checksum: string;
}

export interface FileEntry {
  path: string;
  extension: string;
  kind: "source" | "config" | "documentation" | "database" | "test" | "unknown";
  module: string;
  sizeBytes: number;
  lines: number;
  hash: string;
  summary: string;
  privacy: PrivacyLevel;
  riskFlags: string[];
}

export interface ModuleEntry {
  name: string;
  path: string;
  files: string[];
  symbols: string[];
  dependencies: string[];
  summary: string;
  confidence: Confidence;
}

export interface SymbolEntry {
  name: string;
  kind: "function" | "class" | "interface" | "type" | "constant" | "variable";
  file: string;
  line: number;
  module: string;
  exported: boolean;
}

export interface DependencyEntry {
  from: string;
  to: string;
  specifier: string;
  kind: "import" | "require" | "dynamic-import" | "export" | "package";
  external: boolean;
}

export interface ApiEntry {
  id: string;
  name: string;
  kind: "http-route" | "controller" | "handler" | "event" | "unknown";
  source: string;
  method?: string;
  route?: string;
  summary: string;
  confidence: Confidence;
  privacy: PrivacyLevel;
}

export interface DatabaseEntry {
  id: string;
  name: string;
  kind: "table" | "model" | "migration" | "query" | "schema" | "unknown";
  source: string;
  summary: string;
  confidence: Confidence;
  privacy: PrivacyLevel;
}

export interface RuleEntry {
  id: string;
  text: string;
  source: string;
  confidence: Confidence;
}

export interface RiskEntry {
  id: string;
  type: "secret" | "unsafe-code" | "dependency" | "privacy" | "size" | "unknown";
  severity: RiskSeverity;
  message: string;
  file?: string;
  evidence: string;
  recommendation: string;
  privacy: PrivacyLevel;
}

export interface SummaryEntry {
  target: string;
  targetType: "project" | "module" | "file";
  text: string;
  confidence: Confidence;
}

export interface HistoryEntry {
  id: string;
  kind: "compile" | "source-boundary" | "change" | "unknown";
  summary: string;
  source?: string;
  confidence: Confidence;
  privacy: PrivacyLevel;
}

export interface ArchitectureEntry {
  id: string;
  kind: "boundary" | "dependency" | "risk" | "constraint" | "unknown";
  summary: string;
  source: string;
  confidence: Confidence;
  privacy: PrivacyLevel;
}

export interface UnresolvedQuestionEntry {
  id: string;
  question: string;
  source?: string;
  confidence: Confidence;
  privacy: PrivacyLevel;
}

export interface AmfDocument {
  version: string;
  generatedAt: string;
  project: ProjectMetadata;
  modules: ModuleEntry[];
  files: FileEntry[];
  symbols: SymbolEntry[];
  dependencies: DependencyEntry[];
  api: ApiEntry[];
  database: DatabaseEntry[];
  rules: RuleEntry[];
  risks: RiskEntry[];
  history: HistoryEntry[];
  architecture: ArchitectureEntry[];
  summaries: SummaryEntry[];
  unresolvedQuestions: UnresolvedQuestionEntry[];
}

export interface InspectionStats {
  project: string;
  files: number;
  modules: number;
  dependencies: number;
  symbols: number;
  api: number;
  database: number;
  rules: number;
  risks: number;
  architecture: number;
  unresolvedQuestions: number;
  lastCompiled: string;
  amfVersion: string;
}

export interface ContextSourceFreshness {
  status: "fresh" | "stale" | "unknown";
  checkedAt: string;
  scope: "compiler-source-boundary";
  reasons: string[];
  checkedFileCount: number;
}

export interface ContextMemorySource {
  source: "sqlite" | "legacy_json" | "none";
  completeness: "complete" | "incomplete";
}

export interface ContextPack {
  task: string;
  generatedAt: string;
  kernel: {
    name: "Mind Kernel";
    version: string;
  };
  project: string;
  source: {
    amfVersion: string;
    compiledAt: string;
    checksum: string;
    freshness?: ContextSourceFreshness;
  };
  memorySource?: ContextMemorySource;
  inferredIntent: AtlasInferredIntent;
  filteredOut: {
    files: number;
    memories: number;
  };
  relatedModules: Array<Pick<ModuleEntry, "name" | "path" | "summary" | "dependencies"> & { score: number; why: string[] }>;
  relatedFiles: Array<Pick<FileEntry, "path" | "module" | "kind" | "summary" | "privacy" | "riskFlags"> & { score: number; why: string[] }>;
  relatedApi: Array<ApiEntry & { score: number }>;
  relatedDatabase: Array<DatabaseEntry & { score: number }>;
  knownRules: Array<RuleEntry & { score: number }>;
  risks: Array<RiskEntry & { score: number }>;
  architecture: Array<ArchitectureEntry & { score: number }>;
  history: HistoryEntry[];
  unresolvedQuestions: UnresolvedQuestionEntry[];
  relatedShortTermMemories: AtlasContextMemory[];
  relatedLongTermMemories: AtlasContextMemory[];
  recommendedSteps: string[];
}

export interface ContextPackOptions {
  memories?: AtlasMemorySearchResult[];
  includeSecret?: boolean;
  includeLowScore?: boolean;
  inferredIntent?: AtlasInferredIntent;
  memoriesFilteredOut?: number;
  sourceFreshness?: ContextSourceFreshness;
  memorySource?: ContextMemorySource;
}

export interface AtlasIndex {
  version: string;
  projectName: string;
  amfPath: string;
  compiledAt: string;
  files: number;
  modules: number;
  dependencies: number;
  risks: number;
}

export function createEmptyAmf(project: ProjectMetadata): AmfDocument {
  return {
    version: AMF_VERSION,
    generatedAt: project.compiledAt,
    project,
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
  };
}
