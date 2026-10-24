import path from "node:path";
import { spawn } from "node:child_process";
import {
  MappingError, mappingNativeFingerprint, type MappingDigest, type MappingUuid,
  type MappingNativeReadRequest, type MappingReadObservationContext,
  type MappingNativeObservation, type MappingTarget, type MappingTargetObservation
} from "@atlas/impact";
import {
  Admission, absolute, authority, context, copyData, executableHash, fail, freeze,
  hash, id, object, requireValue, strictJson, tagged, timestamp, uuid
} from "./impact-mapping-private.js";

interface FixedMappingNativeFields {
  readonly executable: string;
  readonly executableDigest: MappingDigest;
  readonly database: string;
  readonly projectId: string;
  readonly storeUuid: MappingUuid;
  readonly siteId: string;
  readonly environmentId: string;
  readonly visibility: "local" | "external";
}
export type FixedMappingNativeConfig = FixedMappingNativeFields & (
  | { readonly schema: "lmti.impact.mapping-native.v1" }
  | { readonly schema: "lmti.impact.mapping-native.v2" }
);
export interface FixedMappingObserverRuntime {
  readonly authorize: () => void;
  readonly clock: () => string;
}
export interface FixedMappingNativeObserver {
  observe(request: MappingNativeReadRequest, context: MappingReadObservationContext): Promise<MappingNativeObservation>;
  isIdle(): boolean;
  waitForIdle(): Promise<void>;
}
const CAP = 4194304, STDERR_CAP = 65536, CHILD_MS = 35000;
const kinds = ["area", "asset", "component", "environment", "knowledge", "repository", "site", "subsystem"] as const;
function config(value: FixedMappingNativeConfig): FixedMappingNativeConfig {
  const o = object(copyData(value, 16384), ["schema", "executable", "executableDigest", "database",
    "projectId", "storeUuid", "siteId", "environmentId", "visibility"]);
  requireValue((o.schema === "lmti.impact.mapping-native.v1" || o.schema === "lmti.impact.mapping-native.v2") &&
    (o.visibility === "local" || o.visibility === "external"));
  const executable = absolute(o.executable), database = absolute(o.database);
  requireValue(["lmti-project", "lmti-project.exe"].includes(path.basename(executable).toLowerCase()));
  return freeze({ schema: o.schema, executable, executableDigest: hash(o.executableDigest), database,
    projectId: id(o.projectId, true), storeUuid: uuid(o.storeUuid), siteId: id(o.siteId, true),
    environmentId: id(o.environmentId, true), visibility: o.visibility });
}
export function mappingNativeAuthorityFingerprint(value: FixedMappingNativeConfig): MappingDigest {
  return tagged("lmti.impact.mapping.native-authority.v1", config(value));
}
function target(value: unknown, c: FixedMappingNativeConfig): MappingTarget {
  const o = object(value, ["projectId", "storeUuid", "kind", "id"]);
  requireValue(typeof o.kind === "string" && (kinds as readonly string[]).includes(o.kind));
  const t: MappingTarget = { projectId: id(o.projectId, true), storeUuid: uuid(o.storeUuid),
    kind: o.kind as MappingTarget["kind"], id: id(o.id, true) };
  requireValue(t.projectId === c.projectId && t.storeUuid === c.storeUuid, "SCOPE_DENIED"); return t;
}
const targetKey = (t: MappingTarget) => JSON.stringify([t.projectId, t.storeUuid, t.kind, t.id]);
function checkedTargets(value: unknown, c: FixedMappingNativeConfig): MappingTarget[] {
  requireValue(Array.isArray(value)); requireValue(value.length <= 4000, "BUDGET_EXCEEDED");
  const targets = value.map(v => target(v, c));
  // IDs and kinds are ASCII; array comparison is unambiguous and locale independent.
  targets.sort((a, b) => a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  requireValue(new Set(targets.map(targetKey)).size === targets.length);
  return targets;
}
function nativeEnvironment(executable: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP"]) {
    const v = process.env[key];
    if (v && !/[\x00-\x1f\x7f]/u.test(v)) env[key] = v;
  }
  const root = process.platform === "win32" ? env.SystemRoot ?? "C:\\Windows" : "";
  env.PATH = path.dirname(executable) + (root ? path.delimiter + path.join(root, "System32") : "");
  env.QT_PLUGIN_PATH = path.join(path.dirname(executable), "plugins");
  return env;
}
interface Closed { bytes: Buffer; code: number | null; signal: NodeJS.Signals | null; failed: boolean; }
/** No early promise settlement can hide a live child from the reader's worker
 * accounting. Timeout/abort may terminate this read-only child, then await close. */
function run(c: FixedMappingNativeConfig, input: Buffer, signal: AbortSignal, check: () => void): Promise<Closed> {
  check();
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      check();
      const command = c.schema === "lmti.impact.mapping-native.v1" ? "mapping-observation" : "mapping-observation-v2";
      child = spawn(c.executable, [command, c.database, c.projectId, c.storeUuid,
        c.siteId, c.environmentId, c.visibility], {
        shell: false, windowsHide: true, cwd: path.dirname(c.executable),
        stdio: ["pipe", "pipe", "pipe"], env: nativeEnvironment(c.executable)
      });
    } catch { reject(new MappingError("OWNER_UNAVAILABLE")); return; }
    let failed = false, killRequested = false, outputBytes = 0, errorBytes = 0;
    const chunks: Buffer[] = [];
    const stop = () => {
      failed = true; chunks.length = 0;
      if (!killRequested) { killRequested = true; try { child.kill(); } catch { /* Still wait for close. */ } }
    };
    const timer = setTimeout(stop, CHILD_MS);
    const aborted = () => stop();
    signal.addEventListener("abort", aborted, { once: true });
    child.on("error", stop); // Even a pre-spawn error is retained until Node's close event.
    child.stdin!.on("error", stop);
    child.stdout!.on("error", stop);
    child.stderr!.on("error", stop);
    child.stdout!.on("data", (raw: Buffer) => {
      const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      outputBytes += bytes.length;
      if (outputBytes > CAP) stop();
      if (!failed) chunks.push(bytes);
    });
    child.stderr!.on("data", (raw: Buffer) => {
      errorBytes += raw.length; if (errorBytes > STDERR_CAP) stop();
    });
    child.once("close", (code, exitSignal) => {
      clearTimeout(timer); signal.removeEventListener("abort", aborted);
      resolve({ bytes: failed ? Buffer.alloc(0) : Buffer.concat(chunks), code, signal: exitSignal, failed });
    });
    if (signal.aborted) stop();
    try { child.stdin!.end(input); } catch { stop(); }
  });
}
function decode(r: Closed, c: FixedMappingNativeConfig, requested: readonly MappingTarget[],
  authorityFingerprint: string, checkedAt: string): MappingNativeObservation {
  requireValue(!r.failed && r.signal === null, "OWNER_UNAVAILABLE");
  let raw: Record<string, unknown>;
  try {
    const v = strictJson(r.bytes, CAP, true);
    requireValue(v !== null && typeof v === "object" && !Array.isArray(v)); raw = v as Record<string, unknown>;
  } catch { fail("OWNER_UNAVAILABLE"); }
  if (raw.ok === false) {
    try { object(raw, ["ok", "code"]); requireValue(r.code === 1 && typeof raw.code === "string"); }
    catch { fail("OWNER_UNAVAILABLE"); }
    switch (raw.code) {
      case "NATIVE_UNAVAILABLE": fail("NATIVE_UNAVAILABLE");
      case "CONFIG_CHANGED": fail("NATIVE_CHANGED");
      case "NOT_SUPPORTED": fail("UNSUPPORTED_MAPPING");
      case "BUDGET_EXCEEDED": fail("BUDGET_EXCEEDED");
      default: fail("OWNER_UNAVAILABLE");
    }
  }
  try {
    const schema3 = c.schema === "lmti.impact.mapping-native.v2";
    object(raw, ["ok", "schema", "projectId", "storeUuid", "revision", "targets", ...(schema3 ? ["storageSchema"] : [])]);
    requireValue(r.code === 0 && raw.ok === true &&
      raw.schema === (schema3 ? "lmti.project.mapping-observation.v2" : "lmti.project.mapping-observation.v1") &&
      (!schema3 || raw.storageSchema === 3) &&
      raw.projectId === c.projectId && raw.storeUuid === c.storeUuid &&
      typeof raw.revision === "number" && Number.isSafeInteger(raw.revision) &&
      raw.revision >= 1 && raw.revision < Number.MAX_SAFE_INTEGER &&
      Array.isArray(raw.targets) && raw.targets.length === requested.length);
    const targets: MappingTargetObservation[] = raw.targets.map((value, index) => {
      const row = object(value, ["target", "effectiveClassification", "ancestryFingerprint", "referenceFingerprint", "identityState"]);
      const t = target(row.target, c), reference = t.kind === "repository" || t.kind === "knowledge";
      requireValue(targetKey(t) === targetKey(requested[index]) &&
        (row.effectiveClassification === "public" || row.effectiveClassification === "internal") &&
        (c.visibility === "local" || row.effectiveClassification === "public") &&
        row.identityState === (reference ? "present_reference" : "active"));
      requireValue(reference ? typeof row.referenceFingerprint === "string" : row.referenceFingerprint === null);
      return { target: t, effectiveClassification: row.effectiveClassification,
        ancestryFingerprint: hash(row.ancestryFingerprint),
        referenceFingerprint: reference ? hash(row.referenceFingerprint) : null,
        identityState: reference ? "present_reference" : "active" };
    });
    const content = { schema: schema3 ? 3 as const : 2 as const, projectId: c.projectId, storeUuid: c.storeUuid,
      revision: raw.revision, authorityFingerprint, targets };
    return freeze({ ...content, checkedAt, fingerprint: mappingNativeFingerprint(content) });
  } catch { fail("OWNER_UNAVAILABLE"); }
}
export function createFixedMappingNativeObserver(
  value: FixedMappingNativeConfig, runtime: FixedMappingObserverRuntime
): FixedMappingNativeObserver {
  const c = config(value), pin = mappingNativeAuthorityFingerprint(c);
  requireValue(runtime !== null && typeof runtime === "object" &&
    typeof runtime.authorize === "function" && typeof runtime.clock === "function");
  const clock = runtime.clock, admission = new Admission(runtime.authorize);
  return Object.freeze({
    isIdle: () => admission.isIdle(), waitForIdle: () => admission.waitForIdle(),
    async observe(input: MappingNativeReadRequest, ctx: MappingReadObservationContext): Promise<MappingNativeObservation> {
      context(ctx);
      const req = object(copyData(input, CAP), ["phase", "pass", "authority", "targets", "allowInternal"]);
      requireValue(req.phase === "current" && (req.pass === 1 || req.pass === 2) && typeof req.allowInternal === "boolean");
      requireValue(c.visibility !== "local" || req.allowInternal, "SCOPE_DENIED");
      const a = authority(req.authority), targets = checkedTargets(req.targets, c);
      requireValue(a.nativeAuthorityFingerprint === pin && a.nativeProjectId === c.projectId &&
        a.nativeStoreUuid === c.storeUuid && a.projectId === c.projectId && a.siteId === c.siteId &&
        a.environmentId === c.environmentId, "CONFIG_CHANGED");
      requireValue(a.kind !== "native", "UNSUPPORTED_MAPPING");
      const bytes = Buffer.from(JSON.stringify({ targets: targets.map(t => ({ kind: t.kind, id: t.id })) }) + "\n");
      requireValue(bytes.length <= CAP, "BUDGET_EXCEEDED");
      admission.begin();
      const check = () => { admission.check(); requireValue(!ctx.signal.aborted, "OWNER_UNAVAILABLE"); };
      try {
        check(); requireValue(await executableHash(c.executable, check) === c.executableDigest, "CONFIG_CHANGED");
        check(); const closed = await run(c, bytes, ctx.signal, check); check();
        requireValue(await executableHash(c.executable, check) === c.executableDigest, "CONFIG_CHANGED"); check();
        const result = decode(closed, c, targets, pin, timestamp(clock())); check(); return result;
      } catch (error) {
        if (error instanceof MappingError) throw error;
        fail("OWNER_UNAVAILABLE");
      } finally { admission.end(); }
    }
  });
}
