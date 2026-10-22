import { promises as fs } from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import {
  createImpactReport, createSyntheticImpactDemo, digest, getImpactEvidence, ImpactError,
  importImpactSnapshot, initializeImpactStore, listImpactImports, loadImpactReport,
  lookupImpactEntity, readImpactHistory, readImpactImport, readImpactSnapshot, reviewImpactImport, saveImpactReport,
  sourceAllowed, compileMappedCodeSource, compileNativeProjectSource, nativeSourceId, identifier,
  upgradeImpactStore, createImpactReviewOperator, listImpactReportSummaries,
  validateChange, validateGrant, validateImport, type ChangeRequest, type ImpactGrant,
  type ImpactImport, type ImpactReport, type SourceCheck
} from "@atlas/impact";
import { renderImpactReview } from "./impact-view";
import { pinNativeSource, readNativeOwner, validateNativeSourceConfig, type NativeSourceConfig } from "./impact-native";

interface SourceBinding { sourceId: string; file: string; snapshotDigest: string; revision: string; digest: string; inputs?: Array<{ file: string; digest: string }>; native?: NativeSourceConfig }
export interface ImpactLauncherConfig {
  schema: "lmti.impact.launcher.v1";
  database: string;
  grant: ImpactGrant;
  sources: SourceBinding[];
  nativeSource?: NativeSourceConfig;
}
const RESPONSE_SCHEMA = "lmti.impact.response.v1";
const MAX_FILE = 4 * 1024 * 1024;
function denied(code: string): never { throw new ImpactError(code); }
function fields(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) denied("INVALID_REQUEST");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !allowed.includes(key))) denied("UNEXPECTED_FIELD");
  return record;
}
function string(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 1024 || /[\x00-\x1f\x7f]/.test(value)) denied("INVALID_ARGUMENT");
  return value;
}
function relative(value: unknown): string {
  const name = string(value);
  if (path.isAbsolute(name) || name.includes(":") || name.split(/[\\/]/).some(part => ["..", ".lmti", ".git"].includes(part.toLowerCase()))) denied("PATH_DENIED");
  return name;
}
function inside(root: string, filename: string): boolean {
  const tail = path.relative(root, filename);
  return tail !== ".." && !tail.startsWith(`..${path.sep}`) && !path.isAbsolute(tail);
}
async function ownedFile(root: string, name: string, exists = true): Promise<string> {
  const filename = path.resolve(root, relative(name));
  const parent = await fs.realpath(path.dirname(filename));
  if (!inside(root, parent)) denied("PATH_DENIED");
  try {
    const stat = await fs.lstat(filename);
    if (stat.isSymbolicLink() || !stat.isFile() || !inside(root, await fs.realpath(filename))) denied("PATH_DENIED");
  } catch (error) { if (exists || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return filename;
}
async function boundedFile(filename: string, maxBytes: number): Promise<Buffer> {
  const handle = await fs.open(filename, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > maxBytes) denied("INPUT_SIZE_DENIED");
    const bytes = Buffer.alloc(Math.min(before.size, maxBytes) + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maxBytes) denied("INPUT_SIZE_DENIED");
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) denied("SOURCE_CHANGED_DURING_READ");
    return bytes.subarray(0, length);
  } finally { await handle.close(); }
}
async function jsonFile(filename: string, maxBytes = MAX_FILE): Promise<unknown> {
  const bytes = await boundedFile(filename, maxBytes);
  return parseJson(bytes);
}
function parseJson(bytes: Buffer): unknown {
  try { return JSON.parse(bytes.toString("utf8")); } catch { denied("INVALID_JSON"); }
}
export async function loadImpactLauncher(filename: string) {
  const fullPath = path.resolve(filename);
  if ((await fs.lstat(fullPath)).isSymbolicLink()) denied("CONFIG_PATH_DENIED");
  const root = await fs.realpath(path.dirname(fullPath));
  const data = fields(await jsonFile(fullPath, 128 * 1024), ["schema", "database", "grant", "sources", "nativeSource"]);
  if (data.schema !== "lmti.impact.launcher.v1" || !Array.isArray(data.sources) || data.sources.length > 200) denied("CONFIG_INVALID");
  const sources = data.sources.map(value => {
    const record = fields(value, ["sourceId", "file", "snapshotDigest", "revision", "digest", "inputs", "native"]);
    const binding: SourceBinding = { sourceId: string(record.sourceId), file: relative(record.file), snapshotDigest: string(record.snapshotDigest), revision: string(record.revision), digest: string(record.digest) };
    if (![binding.snapshotDigest, binding.digest].every(hash => /^[a-f0-9]{64}$/.test(hash))) denied("CONFIG_INVALID");
    if (record.inputs !== undefined) {
      if (!Array.isArray(record.inputs) || record.inputs.length > 101) denied("CONFIG_INVALID");
      binding.inputs = record.inputs.map(value => {
        const input = fields(value, ["file", "digest"]);
        const result = { file: relative(input.file), digest: string(input.digest) };
        if (!/^[a-f0-9]{64}$/.test(result.digest)) denied("CONFIG_INVALID");
        return result;
      });
      if (new Set(binding.inputs.map(input => input.file)).size !== binding.inputs.length) denied("CONFIG_INVALID");
    }
    if (record.native !== undefined) {
      binding.native = validateNativeSourceConfig(record.native);
      if (record.inputs !== undefined || data.nativeSource === undefined || digest(binding.native) !== digest(validateNativeSourceConfig(data.nativeSource))) denied("NATIVE_CONFIG_INVALID");
    }
    return binding;
  });
  if (new Set(sources.map(source => source.sourceId)).size !== sources.length) denied("CONFIG_INVALID");
  const config: ImpactLauncherConfig = { schema: data.schema, database: relative(data.database), grant: validateGrant(data.grant), sources };
  if (data.nativeSource !== undefined) {
    config.nativeSource = validateNativeSourceConfig(data.nativeSource);
    if (config.grant.projectId !== config.nativeSource.projectId || !config.grant.siteIds.includes(config.nativeSource.site) || !config.grant.environmentIds.includes(config.nativeSource.environmentId)) denied("NATIVE_SCOPE_DENIED");
  }
  const database = await ownedFile(root, config.database);
  return { root, filename: fullPath, database, config };
}

/** Bind content, not the revision string supplied inside an edited manifest. */
export async function checkImpactSources(root: string, bindings: SourceBinding[]): Promise<SourceCheck[]> {
  const results: SourceCheck[] = [];
  const deadline = Date.now() + (bindings.some(binding => binding.native) ? 15_000 : 5000);
  let totalBytes = 0;
  for (const binding of bindings) {
    const checkedAt = new Date().toISOString();
    try {
      if (Date.now() > deadline || totalBytes > 64 * 1024 * 1024) denied("SOURCE_SCAN_BUDGET_EXCEEDED");
      const file = await ownedFile(root, binding.file);
      totalBytes += (await fs.stat(file)).size;
      if (totalBytes > 64 * 1024 * 1024) denied("SOURCE_SCAN_BUDGET_EXCEEDED");
      const current = await jsonFile(file);
      const actual = digest(current);
      let changed = actual !== binding.snapshotDigest;
      const hashes: string[] = [actual];
      if (binding.native) {
        const imported = validateImport(current);
        const compiled = compileNativeProjectSource(await readNativeOwner(binding.native), { environmentId: binding.native.environmentId, capturedAt: imported.source.capturedAt });
        hashes.push(compiled.fingerprint);
        if (compiled.snapshot.source.id !== binding.sourceId || compiled.fingerprint !== binding.digest || digest(compiled.snapshot) !== binding.snapshotDigest) changed = true;
      }
      for (const input of binding.inputs ?? []) {
        if (Date.now() > deadline || totalBytes > 64 * 1024 * 1024) denied("SOURCE_SCAN_BUDGET_EXCEEDED");
        const bytes = await boundedFile(await ownedFile(root, input.file), 256 * 1024);
        totalBytes += bytes.length;
        if (Date.now() > deadline || totalBytes > 64 * 1024 * 1024) denied("SOURCE_SCAN_BUDGET_EXCEEDED");
        const hash = createHash("sha256").update(bytes).digest("hex");
        hashes.push(hash);
        if (hash !== input.digest) changed = true;
      }
      if (Date.now() > deadline || totalBytes > 64 * 1024 * 1024) denied("SOURCE_SCAN_BUDGET_EXCEEDED");
      results.push(changed
        ? { sourceId: binding.sourceId, status: "available", checkedAt, revision: `unregistered:${digest(hashes)}`, digest: digest(hashes) }
        : { sourceId: binding.sourceId, status: "available", checkedAt, revision: binding.revision, digest: binding.digest });
    } catch (error) {
      results.push({ sourceId: binding.sourceId, checkedAt, status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "deleted" : "unavailable" });
    }
  }
  return results;
}

export async function impactRequest(value: unknown, configPath: string): Promise<unknown> {
  const request = fields(value, ["schema", "op", "id", "change"]);
  if (request.schema !== "lmti.impact.request.v1") denied("UNSUPPORTED_REQUEST_SCHEMA");
  const op = string(request.op);
  const allowed = op === "report" ? ["schema", "op", "change"] : ["entity", "evidence", "open-report"].includes(op) ? ["schema", "op", "id"] : ["schema", "op"];
  fields(request, allowed);
  const { root, database, config } = await loadImpactLauncher(configPath);
  // Every call reloads policy; a running bridge cannot retain a revoked grant.
  if (op === "snapshot") return readImpactSnapshot(database, config.grant);
  if (op === "entity") return lookupImpactEntity(database, config.grant, string(request.id));
  if (op === "evidence") return getImpactEvidence(database, config.grant, string(request.id));
  if (op === "inbox") return { imports: listImpactImports(database, config.grant), history: readImpactHistory(database, config.grant) };
  const freshness = await checkImpactSources(root, config.sources);
  if (op === "report") return createImpactReport(database, config.grant, validateChange(request.change), { freshness });
  if (op === "open-report") return loadImpactReport(database, config.grant, string(request.id), { freshness });
  denied("OPERATION_DENIED");
}

async function writeExclusive(filename: string, value: unknown) { await fs.writeFile(filename, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", flag: "wx", mode: 0o600 }); }
async function replaceConfig(filename: string, config: ImpactLauncherConfig) {
  const temp = `${filename}.${process.pid}.tmp`;
  await writeExclusive(temp, config);
  await fs.rename(temp, filename);
}
function binding(snapshot: ImpactImport, file: string, inputs?: SourceBinding["inputs"]): SourceBinding {
  return { sourceId: snapshot.source.id, file, snapshotDigest: digest(snapshot), revision: snapshot.source.revision, digest: snapshot.source.digest, ...(inputs ? { inputs } : {}) };
}

export async function setupNativeImpact(directory: string, source: Omit<NativeSourceConfig, "executableDigest">, principalId: string, expectedProjectRevision?: number) {
  const nativeSource = await pinNativeSource(source), native = await readNativeOwner(nativeSource);
  if (expectedProjectRevision !== undefined && native.revision !== expectedProjectRevision) denied("NATIVE_REVISION_CONFLICT");
  const root = path.resolve(directory), parent = await fs.realpath(path.dirname(root));
  if (!inside(parent, root) || path.dirname(root).toLowerCase() !== parent.toLowerCase() || [root, parent].some(candidate => candidate.split(/[\\/]/u).some(part => [".lmti", ".git"].includes(part.toLowerCase())))) denied("PATH_DENIED");
  const config: ImpactLauncherConfig = { schema: "lmti.impact.launcher.v1", database: "impact.sqlite", grant: validateGrant({ principalId, projectId: native.projectId, siteIds: [native.site], environmentIds: [nativeSource.environmentId], allowInternal: nativeSource.target === "local", policyVersion: "native-operator-policy-1" }), sources: [], nativeSource };
  await fs.mkdir(root, { recursive: false });
  const initialized = initializeImpactStore(path.join(root, config.database));
  const configPath = path.join(root, "launcher.json");
  await writeExclusive(configPath, config);
  return { configPath, graphRevision: initialized.graphRevision, native: { projectId: native.projectId, revision: native.revision, site: native.site, target: nativeSource.target } };
}

export async function importNativeImpact(configPath: string, expectedRevision: number, expectedProjectRevision?: number) {
  const loaded = await loadImpactLauncher(configPath), { config, root, database } = loaded;
  if (!config.nativeSource) denied("NATIVE_SOURCE_NOT_CONFIGURED");
  const native = await readNativeOwner(config.nativeSource);
  if (expectedProjectRevision !== undefined && native.revision !== expectedProjectRevision) denied("NATIVE_REVISION_CONFLICT");
  const sourceId = nativeSourceId(native, config.nativeSource.environmentId), previous = config.sources.find(source => source.sourceId === sourceId);
  const compiled = compileNativeProjectSource(native, { environmentId: config.nativeSource.environmentId, capturedAt: new Date().toISOString() });
  let snapshot = compiled.snapshot;
  if (previous && previous.digest === compiled.fingerprint) {
    snapshot = validateImport(await jsonFile(await ownedFile(root, previous.file)));
    if (digest(snapshot) !== previous.snapshotDigest || snapshot.source.digest !== compiled.fingerprint) denied("NATIVE_SNAPSHOT_CHANGED");
  } else {
    // Import and launcher replacement are separate owner transactions. Reuse
    // an already-staged capture time after an interrupted launcher write so a
    // retry reconstructs the same canonical batch instead of reusing its digest.
    const staged = listImpactImports(database, config.grant).find(entry => entry.source.id === sourceId && entry.source.revision === snapshot.source.revision && entry.source.digest === compiled.fingerprint);
    if (staged) snapshot = compileNativeProjectSource(native, { environmentId: config.nativeSource.environmentId, capturedAt: staged.source.capturedAt }).snapshot;
  }
  if (!sourceAllowed(snapshot.source, config.grant) || (!config.grant.allowInternal && [...snapshot.entities, ...snapshot.assertions, ...snapshot.evidence].some(record => record.privacy !== "public"))) denied("SOURCE_SCOPE_DENIED");
  const file = `native-${digest(snapshot)}.snapshot.json`, generated = await ownedFile(root, file, false);
  try { await writeExclusive(generated, snapshot); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST" || digest(await jsonFile(generated)) !== digest(snapshot)) throw error; }
  const imported = importImpactSnapshot(database, snapshot, { expectedRevision, actor: config.grant.principalId });
  config.sources = [...config.sources.filter(source => source.sourceId !== sourceId), { ...binding(snapshot, file), native: config.nativeSource }];
  await replaceConfig(loaded.filename, config);
  return { ...imported, limits: compiled.limits };
}

function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) denied("INVALID_REVISION");
  return value;
}
const desktopBase = ["schema", "op", "projectId", "expectedProjectRevision", "documentPath"];
const desktopFields: Record<string, string[]> = {
  setup: ["site", "environmentId", "allowInternal"], overview: [],
  "import-native": ["graphRevision"], "import-preview": ["batchId"],
  report: ["change"], "save-report": ["report"], "open-report": ["id"],
  review: ["batchId", "graphRevision", "decision", "evidenceReviewed"],
  "read-review": ["reportId"], verify: ["verification"], upgrade: []
};
/** The desktop has a distinct opt-in operator capability; Agent requests stay read-only. */
export async function desktopImpactRequest(value: unknown, configPath: string, operatorAllowed = false): Promise<unknown> {
  const request = fields(value, [...desktopBase, ...new Set(Object.values(desktopFields).flat())]);
  if (request.schema !== "lmti.impact.desktop.request.v1") denied("UNSUPPORTED_REQUEST_SCHEMA");
  const op = string(request.op);
  if (!Object.hasOwn(desktopFields, op)) denied("OPERATION_DENIED");
  fields(request, [...desktopBase, ...desktopFields[op]]);
  const projectId = identifier(request.projectId), expectedProjectRevision = integer(request.expectedProjectRevision);
  if (expectedProjectRevision < 1) denied("INVALID_REVISION");
  if (["setup", "upgrade", "import-native", "review", "save-report", "verify"].includes(op) && !operatorAllowed) denied("OPERATOR_CAPABILITY_REQUIRED");
  if (op === "setup") {
    if (typeof request.allowInternal !== "boolean" || path.basename(configPath) !== "launcher.json") denied("INVALID_ARGUMENT");
    const executable = process.env.LMTI_STUDIO_PROJECT_BINARY;
    if (!executable) denied("NATIVE_BINARY_NOT_CONFIGURED");
    return setupNativeImpact(path.dirname(configPath), { executable, database: string(request.documentPath), projectId, site: identifier(request.site), environmentId: identifier(request.environmentId), target: request.allowInternal ? "local" : "external" }, "studio-operator", expectedProjectRevision);
  }
  const loaded = await loadImpactLauncher(configPath), { config, database, root } = loaded;
  if (!config.nativeSource || config.nativeSource.projectId !== projectId || config.grant.projectId !== projectId) denied("NATIVE_SCOPE_DENIED");
  // A selected JSON launcher is data, not executable authority. Only the
  // desktop's packaged owner binary may be used by this request surface.
  const desktopBinary = process.env.LMTI_STUDIO_PROJECT_BINARY;
  if (!desktopBinary || !path.isAbsolute(desktopBinary)) denied("NATIVE_BINARY_NOT_CONFIGURED");
  const canonical = (name: string) => process.platform === "win32" ? name.toLowerCase() : name;
  let expectedBinary: string, configuredBinary: string;
  try { expectedBinary = await fs.realpath(desktopBinary); configuredBinary = await fs.realpath(config.nativeSource.executable); }
  catch { denied("NATIVE_BINARY_UNAVAILABLE"); }
  if (canonical(expectedBinary!) !== canonical(configuredBinary!)) denied("NATIVE_BINARY_DENIED");
  const requestedDocument = string(request.documentPath);
  if (!path.isAbsolute(requestedDocument)) denied("NATIVE_SCOPE_DENIED");
  let requestedCanonical: string, configuredCanonical: string;
  try { requestedCanonical = await fs.realpath(requestedDocument); configuredCanonical = await fs.realpath(config.nativeSource.database); }
  catch { denied("NATIVE_SOURCE_UNAVAILABLE"); }
  if (canonical(requestedCanonical!) !== canonical(configuredCanonical!)) denied("NATIVE_SCOPE_DENIED");
  const native = await readNativeOwner(config.nativeSource);
  if (native.revision !== expectedProjectRevision) denied("NATIVE_REVISION_CONFLICT");
  const freshness = await checkImpactSources(root, config.sources);
  const operator = createImpactReviewOperator(database, config.grant, { reviewer: config.grant.principalId, freshness: () => freshness });
  const optionalReview = (reportId: string) => {
    try { return operator.read(reportId); }
    catch (error) { if (error instanceof ImpactError && error.code === "REPORT_UNAVAILABLE") return null; throw error; }
  };
  if (op === "overview") {
    const snapshot = readImpactSnapshot(database, config.grant), imports = listImpactImports(database, config.grant);
    const authorizedSources = new Set([...snapshot.sources.map(source => source.source.id), ...imports.map(item => item.source.id)]);
    return { snapshot, inbox: { imports, history: readImpactHistory(database, config.grant) }, savedReports: listImpactReportSummaries(database, config.grant), reviewEnabled: operatorAllowed, native: { projectId: native.projectId, revision: native.revision, site: native.site, target: config.nativeSource.target }, sourceChecks: freshness.filter(source => authorizedSources.has(source.sourceId)) };
  }
  if (op === "import-preview") {
    const batch = readImpactImport(database, config.grant, string(request.batchId));
    return { batch, sourceChecks: freshness.filter(source => source.sourceId === batch.source.id) };
  }
  if (op === "import-native") return importNativeImpact(configPath, integer(request.graphRevision), expectedProjectRevision);
  if (op === "upgrade") {
    const backupPath = await ownedFile(root, `impact-backup-${Date.now()}-${process.pid}.sqlite`, false);
    return upgradeImpactStore(database, { backupPath });
  }
  if (op === "review") {
    if (request.evidenceReviewed !== true || !["accept", "reject"].includes(String(request.decision))) denied("REVIEW_ACKNOWLEDGMENT_REQUIRED");
    const batch = readImpactImport(database, config.grant, string(request.batchId));
    const check = freshness.find(source => source.sourceId === batch.source.id);
    if (!check || check.status !== "available" || check.revision !== batch.source.revision || check.digest !== batch.source.digest) denied("SOURCE_NOT_CURRENT");
    return reviewImpactImport(database, string(request.batchId), { expectedRevision: integer(request.graphRevision), reviewer: config.grant.principalId, decision: request.decision as "accept" | "reject", evidenceReviewed: true, grant: config.grant });
  }
  if (op === "read-review") return { review: operator.read(string(request.reportId)) };
  if (op === "verify") {
    const recorded = operator.record(request.verification);
    const refreshed = await checkImpactSources(root, config.sources);
    return { review: createImpactReviewOperator(database, config.grant, { reviewer: config.grant.principalId, freshness: () => refreshed }).read(recorded.reportId) };
  }
  if (op === "open-report") {
    const report = loadImpactReport(database, config.grant, string(request.id), { freshness });
    return { report, review: optionalReview(report.id) };
  }
  if (op === "save-report") {
    const saved = saveImpactReport(database, config.grant, request.report as ImpactReport, { freshness });
    const report = loadImpactReport(database, config.grant, saved.id, { freshness });
    return { report, review: optionalReview(report.id) };
  }
  const report = createImpactReport(database, config.grant, validateChange(request.change), { freshness });
  return { report, review: optionalReview(report.id) };
}
export async function createImpactDemo(directory: string) {
  const root = path.resolve(directory);
  const parent = await fs.realpath(path.dirname(root));
  if ([root, parent].some(candidate => candidate.split(/[\\/]/).some(part => [".lmti", ".git"].includes(part.toLowerCase())))) denied("PATH_DENIED");
  await fs.mkdir(root, { recursive: false }); // Never replace an existing demo or user database.
  const demo = createSyntheticImpactDemo();
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(path.join(root, "src", "labels.ts"), 'export function renderLabel(packageCode: string): string { return "LABEL=" + packageCode; }\n', { flag: "wx", mode: 0o600 });
  const { digest: _digest, kind: _kind, ...source } = demo.foundation[0].source;
  const codeMapping = { source, mappings: [{ entityId: "label-code", sourceKey: "code:labels", file: "src/labels.ts", exportName: "renderLabel", label: "Package label handler", ownerRole: "Software engineer", privacy: "public" as const, version: "A" }] };
  const code = await compileMappedCodeSource({ root, ...codeMapping });
  const mappingBytes = Buffer.from(JSON.stringify(codeMapping, null, 2) + "\n", "utf8");
  await fs.writeFile(path.join(root, "code-mapping.json"), mappingBytes, { flag: "wx", mode: 0o600 });
  const codeInputs = [...code.inputs, { file: "code-mapping.json", digest: createHash("sha256").update(mappingBytes).digest("hex") }];
  const database = path.join(root, "impact.sqlite");
  let revision = initializeImpactStore(database).graphRevision;
  const config: ImpactLauncherConfig = { schema: "lmti.impact.launcher.v1", database: "impact.sqlite", grant: demo.grant, sources: [] };
  for (const snapshot of [code.snapshot, demo.imports.A]) {
    const filename = `${snapshot.source.id}.json`;
    await writeExclusive(path.join(root, filename), snapshot);
    const imported = importImpactSnapshot(database, snapshot, { expectedRevision: revision, actor: "synthetic-fixture" });
    revision = reviewImpactImport(database, imported.batchId, { expectedRevision: imported.graphRevision, reviewer: "synthetic-fixture-not-human-validation", decision: "accept", evidenceReviewed: true }).graphRevision;
    config.sources.push(binding(snapshot, filename, snapshot.source.kind === "code" ? codeInputs : undefined));
  }
  await writeExclusive(path.join(root, "source-B.json"), demo.imports.B);
  await writeExclusive(path.join(root, "source-C.json"), demo.imports.C);
  await writeExclusive(path.join(root, "change.json"), demo.change);
  await writeExclusive(path.join(root, "launcher.json"), config);
  return { schema: "lmti.impact.demo.v1", directory: root, config: path.join(root, "launcher.json"), graphRevision: revision, validation: "synthetic-engineering-fixture-only" };
}
function argumentsMap(args: string[], allowed: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    if (!key?.startsWith("--") || !allowed.includes(key.slice(2)) || key.slice(2) in result || !args[index + 1]) denied("INVALID_ARGUMENTS");
    result[key.slice(2)] = string(args[index + 1]);
  }
  return result;
}
async function readRequest(maxBytes = 128 * 1024): Promise<unknown> {
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length; if (length > maxBytes) denied("INPUT_SIZE_DENIED"); chunks.push(bytes);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { denied("INVALID_JSON"); }
}
function errorCode(error: unknown): string {
  return error instanceof ImpactError && /^[A-Z_]{1,80}$/.test(error.code) ? error.code : "IMPACT_OPERATION_FAILED";
}
export async function runImpactCommand(args: string[]): Promise<void> {
  const [operation, ...rest] = args;
  let desktopIdentity: { projectId: string; projectRevision: number; op: string } | undefined;
  try {
    if (operation === "demo") {
      const options = argumentsMap(rest, ["out"]);
      console.log(JSON.stringify(await createImpactDemo(string(options.out)))); return;
    }
    if (operation === "setup-native") {
      const options = argumentsMap(rest, ["out", "native-executable", "native-database", "project", "site", "target", "environment", "principal"]);
      if (!["local", "external"].includes(options.target)) denied("INVALID_ARGUMENT");
      console.log(JSON.stringify(await setupNativeImpact(string(options.out), { executable: string(options["native-executable"]), database: string(options["native-database"]), projectId: identifier(options.project), site: identifier(options.site), target: options.target as "local" | "external", environmentId: identifier(options.environment) }, identifier(options.principal)))); return;
    }
    const options = argumentsMap(rest, ["config", "file", "change", "out", "revision", "batch", "decision", "reviewer", "evidence-reviewed", "port"]);
    const configPath = path.resolve(string(options.config));
    if (operation === "desktop-request") {
      if (Object.keys(options).length !== 1) denied("INVALID_ARGUMENTS");
      const value = await readRequest(2 * 1024 * 1024);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const request = value as Record<string, unknown>;
        desktopIdentity = { projectId: identifier(request.projectId), projectRevision: integer(request.expectedProjectRevision), op: string(request.op) };
      }
      const result = await desktopImpactRequest(value, configPath, process.env.LMTI_STUDIO_ALLOW_IMPACT_REVIEW === "1");
      const output = JSON.stringify({ schema: RESPONSE_SCHEMA, ok: true, ...desktopIdentity, result });
      if (Buffer.byteLength(output) > 2 * 1024 * 1024) denied("OUTPUT_SIZE_DENIED");
      console.log(output); return;
    }
    if (operation === "request") {
      if (Object.keys(options).length !== 1) denied("INVALID_ARGUMENTS");
      const result = await impactRequest(await readRequest(), configPath);
      const output = JSON.stringify({ schema: RESPONSE_SCHEMA, ok: true, result });
      if (Buffer.byteLength(output) > 2 * 1024 * 1024) denied("OUTPUT_SIZE_DENIED");
      console.log(output); return;
    }
    const loaded = await loadImpactLauncher(configPath);
    const { root, database, config } = loaded;
    if (operation === "import-native") {
      if (Object.keys(options).some(key => !["config", "revision"].includes(key))) denied("INVALID_ARGUMENTS");
      console.log(JSON.stringify(await importNativeImpact(configPath, integer(Number(options.revision))))); return;
    }
    if (operation === "import" || operation === "import-code") {
      let file = relative(options.file);
      let inputs: SourceBinding["inputs"];
      let snapshot: ImpactImport;
      if (operation === "import-code") {
        const mappingBytes = await boundedFile(await ownedFile(root, file), 128 * 1024);
        const mapping = fields(parseJson(mappingBytes), ["source", "mappings"]);
        const compiled = await compileMappedCodeSource({ root, source: mapping.source as Parameters<typeof compileMappedCodeSource>[0]["source"], mappings: mapping.mappings as Parameters<typeof compileMappedCodeSource>[0]["mappings"] });
        snapshot = compiled.snapshot;
        inputs = [...compiled.inputs, { file, digest: createHash("sha256").update(mappingBytes).digest("hex") }];
        file = `code-${digest(snapshot)}.snapshot.json`;
      } else {
        snapshot = validateImport(await jsonFile(await ownedFile(root, file)));
        // A mapped code source must keep its raw-input checks on later imports.
        if (config.sources.find(source => source.sourceId === snapshot.source.id)?.inputs?.length) denied("MAPPED_CODE_REQUIRES_CODE_IMPORT");
        if (snapshot.source.kind === "native" || config.sources.find(source => source.sourceId === snapshot.source.id)?.native) denied("NATIVE_SOURCE_REQUIRES_OWNER_IMPORT");
      }
      if (!sourceAllowed(snapshot.source, config.grant) || (!config.grant.allowInternal && [...snapshot.entities, ...snapshot.assertions, ...snapshot.evidence].some(record => record.privacy !== "public"))) denied("SOURCE_SCOPE_DENIED");
      if (operation === "import-code") {
        const generated = await ownedFile(root, file, false);
        try { await writeExclusive(generated, snapshot); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST" || digest(await jsonFile(generated)) !== digest(snapshot)) throw error; }
      }
      const imported = importImpactSnapshot(database, snapshot, { expectedRevision: Number(options.revision), actor: config.grant.principalId });
      config.sources = [...config.sources.filter(source => source.sourceId !== snapshot.source.id), binding(snapshot, file, inputs)];
      await replaceConfig(loaded.filename, config);
      console.log(JSON.stringify(imported)); return;
    }
    if (operation === "review") {
      if (options["evidence-reviewed"] !== "true" || !["accept", "reject"].includes(options.decision)) denied("REVIEW_ACKNOWLEDGMENT_REQUIRED");
      const batch = readImpactImport(database, config.grant, string(options.batch));
      const check = (await checkImpactSources(root, config.sources)).find(source => source.sourceId === batch.source.id);
      if (!check || check.status !== "available" || check.revision !== batch.source.revision || check.digest !== batch.source.digest) denied("SOURCE_NOT_CURRENT");
      console.log(JSON.stringify(reviewImpactImport(database, string(options.batch), { expectedRevision: Number(options.revision), reviewer: string(options.reviewer), decision: options.decision as "accept" | "reject", evidenceReviewed: true, grant: config.grant }))); return;
    }
    const getReport = async () => {
      const latest = await loadImpactLauncher(configPath);
      const changeFile = await ownedFile(latest.root, relative(options.change ?? "change.json"));
      const change: ChangeRequest = validateChange(await jsonFile(changeFile, 128 * 1024));
      const report = createImpactReport(latest.database, latest.config.grant, change, { freshness: await checkImpactSources(latest.root, latest.config.sources) });
      const snapshot = readImpactSnapshot(latest.database, latest.config.grant);
      if (snapshot.graphRevision !== report.graphRevision || snapshot.grantFingerprint !== report.grantFingerprint) denied("SNAPSHOT_CHANGED_DURING_READ");
      return { report, snapshot, latest };
    };
    if (operation === "serve") {
      const port = options.port === undefined ? 0 : Number(options.port);
      if (!Number.isInteger(port) || port < 0 || port > 65535) denied("INVALID_PORT");
      const server = createServer(async (request, response) => {
        const bound = server.address();
        const expectedHost = typeof bound === "object" && bound ? `127.0.0.1:${bound.port}` : "";
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("X-Content-Type-Options", "nosniff");
        response.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
        response.setHeader("Referrer-Policy", "no-referrer");
        if (request.method !== "GET" || request.headers.host !== expectedHost || !["/", "/api/report"].includes(request.url ?? "")) { response.writeHead(404); response.end(); return; }
        try {
          const { report, snapshot } = await getReport();
          const body = request.url === "/" ? renderImpactReview(report, snapshot) : JSON.stringify(report);
          if (Buffer.byteLength(body) > 2 * 1024 * 1024) denied("OUTPUT_SIZE_DENIED");
          response.setHeader("Content-Type", request.url === "/" ? "text/html; charset=utf-8" : "application/json; charset=utf-8");
          response.end(body);
        } catch (error) { response.writeHead(409, { "Content-Type": "text/plain; charset=utf-8" }); response.end(errorCode(error)); }
      });
      server.listen(port, "127.0.0.1", () => {
        const address = server.address();
        if (typeof address === "object" && address) console.log(JSON.stringify({ url: `http://127.0.0.1:${address.port}/`, mode: "readonly-synthetic-review", pid: process.pid }));
      }); return;
    }
    if (["report", "export", "save-report"].includes(operation ?? "")) {
      const { report, snapshot, latest } = await getReport();
      if (operation === "report") { console.log(JSON.stringify(report)); return; }
      if (operation === "save-report") { console.log(JSON.stringify(saveImpactReport(latest.database, latest.config.grant, report, { freshness: await checkImpactSources(latest.root, latest.config.sources) }))); return; }
      const filename = await ownedFile(root, relative(options.out), false);
      const html = filename.endsWith(".html");
      if (!html && !filename.endsWith(".json")) denied("EXPORT_FORMAT_DENIED");
      await fs.writeFile(filename, html ? renderImpactReview(report, snapshot) : JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 });
      console.log(JSON.stringify({ file: filename, reportId: report.id, freshnessCheckedAt: report.freshnessCheckedAt })); return;
    }
    denied("OPERATION_DENIED");
  } catch (error) {
    console.log(JSON.stringify({ schema: RESPONSE_SCHEMA, ok: false, ...desktopIdentity, error: errorCode(error) }));
    process.exitCode = 3;
  }
}
