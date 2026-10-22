import { createHash } from "node:crypto";
import {
  closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync,
  type BigIntStats,
} from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import {
  canonicalMappingJson, createImpactMappingReader, MappingError,
  normalizeMappingSourceAuthority, validateGrant,
  type DeepReadonly, type ImpactGrant, type MappingCurrentSnapshot, type MappingDigest,
  type MappingReader, type MappingReadCode, type MappingReadQuery, type MappingSourceAuthority,
  type MappingUuid,
} from "@atlas/impact";
import {
  createFixedMappingNativeObserver, mappingNativeAuthorityFingerprint,
  type FixedMappingNativeConfig, type FixedMappingNativeObserver,
} from "./impact-mapping-native.js";
import {
  createFixedMappingSourceObserver, mappingSourceAuthorityFingerprint,
  type FixedMappingSourceConfig, type FixedMappingSourceObserver,
} from "./impact-mapping-source.js";
import { absolute, copyData, freeze, hash, id, object, requireValue, strictJson, uuid } from "./impact-mapping-private.js";

/** A launcher capability, never a request-selected database, source or grant. */
export interface AgentMappingOwnerConfig {
  readonly schema: "lmti.agent.mapping-owner.v1";
  readonly storePath: string;
  readonly storeUuid: MappingUuid;
  readonly sourceIdentityDigest: MappingDigest;
  readonly grant: DeepReadonly<ImpactGrant>;
  readonly authority: MappingSourceAuthority;
  readonly native: FixedMappingNativeConfig;
  readonly source: FixedMappingSourceConfig;
}
export const AGENT_MAPPING_LIMITS = Object.freeze({
  configBytes: 131072, inputBytes: 4096, outputBytes: 4194304,
  inputMilliseconds: 5000, commandMilliseconds: 95000,
});
export interface AgentMappingArguments { readonly configPath: string; readonly configSha256: string; }
export interface AgentMappingErrorReply {
  readonly schema: "lmti.impact.mapping-current.v1";
  readonly error: MappingReadCode;
}
export type AgentMappingOwnerRequest = MappingReadQuery;
export type AgentMappingOwnerReply = MappingCurrentSnapshot | AgentMappingErrorReply;
const readCodes = new Set<MappingReadCode>([
  "INVALID_INPUT", "UNSUPPORTED_FORMAT", "UNSUPPORTED_MAPPING", "SCOPE_DENIED", "BUSY",
  "BUDGET_EXCEEDED", "CONFIG_CHANGED", "SOURCE_UNAVAILABLE", "SOURCE_CHANGED",
  "NATIVE_UNAVAILABLE", "NATIVE_CHANGED", "OWNER_UNAVAILABLE",
]);
function deny(code: MappingReadCode): never { throw new MappingError(code); }
function fixed(error: unknown): MappingError {
  return new MappingError(error instanceof MappingError && readCodes.has(error.code as MappingReadCode)
    ? error.code as MappingReadCode : "OWNER_UNAVAILABLE");
}
export function agentMappingError(error: unknown): AgentMappingErrorReply {
  return { schema: "lmti.impact.mapping-current.v1", error: fixed(error).code as MappingReadCode };
}
export function agentMappingArguments(argv: readonly string[]): AgentMappingArguments {
  requireValue(Array.isArray(argv) && argv.length === 7 && argv.every(v => typeof v === "string"));
  requireValue(argv[2] === "accepted-mappings" && argv[3] === "--config" && argv[5] === "--config-sha256");
  return Object.freeze({ configPath: absolute(argv[4]), configSha256: hash(argv[6]) });
}
export function checkedAgentMappingQuery(value: unknown): MappingReadQuery {
  const q = object(copyData(value, AGENT_MAPPING_LIMITS.inputBytes), ["sourceId"]);
  return Object.freeze({ sourceId: id(q.sourceId) });
}
/** Pure validation and cross-capability comparison precede every owner I/O. */
export function checkedAgentMappingConfig(value: unknown): AgentMappingOwnerConfig {
  try {
    const o = object(copyData(value, AGENT_MAPPING_LIMITS.configBytes), [
      "schema", "storePath", "storeUuid", "sourceIdentityDigest", "grant", "authority", "native", "source",
    ]);
    requireValue(o.schema === "lmti.agent.mapping-owner.v1");
    const g = object(o.grant, ["principalId", "projectId", "siteIds", "environmentIds", "allowInternal", "policyVersion"]);
    const grant = validateGrant(g), authority = normalizeMappingSourceAuthority(o.authority);
    requireValue(authority.kind !== "native", "UNSUPPORTED_MAPPING");
    const native = o.native as FixedMappingNativeConfig, sourceRaw = o.source as FixedMappingSourceConfig;
    const nativeFingerprint = mappingNativeAuthorityFingerprint(native);
    const sourceFingerprint = mappingSourceAuthorityFingerprint(sourceRaw);
    // The existing source normalizer only reorders allowedInputs; preserve every
    // checked locator spelling while returning that same normalized order.
    const source: FixedMappingSourceConfig = sourceRaw.kind === "code"
      ? { ...sourceRaw, allowedInputs: [...sourceRaw.allowedInputs].sort() } : sourceRaw;
    requireValue(authority.projectId === grant.projectId && grant.siteIds.length === 1 &&
      grant.siteIds[0] === authority.siteId && grant.environmentIds.length === 1 &&
      grant.environmentIds[0] === authority.environmentId, "SCOPE_DENIED");
    requireValue((native.visibility === "local") === grant.allowInternal &&
      (grant.allowInternal || (authority.minimumClassification === "public" && source.allowInternal === false)), "SCOPE_DENIED");
    requireValue(native.projectId === authority.projectId && native.storeUuid === authority.nativeStoreUuid &&
      native.projectId === authority.nativeProjectId && native.siteId === authority.siteId &&
      native.environmentId === authority.environmentId && nativeFingerprint === authority.nativeAuthorityFingerprint,
    "CONFIG_CHANGED");
    requireValue(source.sourceId === authority.sourceId && source.projectId === authority.projectId &&
      source.siteId === authority.siteId && source.environmentId === authority.environmentId &&
      source.kind === authority.kind && source.minimumClassification === authority.minimumClassification &&
      source.policyVersion === authority.policyVersion && sourceFingerprint === authority.sourceAuthorityFingerprint,
    "CONFIG_CHANGED");
    return freeze({
      schema: o.schema, storePath: absolute(o.storePath), storeUuid: uuid(o.storeUuid),
      sourceIdentityDigest: hash(o.sourceIdentityDigest), grant, authority, native, source,
    });
  } catch (error) {
    if (error instanceof MappingError) throw error;
    deny("INVALID_INPUT");
  }
}

const physical = (s: BigIntStats) => `${s.dev}/${s.ino}/${s.birthtimeNs}`;
const fileStamp = (s: BigIntStats) => `${physical(s)}/${s.size}/${s.mtimeNs}/${s.ctimeNs}`;
const pathKey = (s: string) => process.platform === "win32" ? path.resolve(s).toLowerCase() : path.resolve(s);
interface ConfigRead { readonly bytes: Buffer; readonly chain: string; readonly stamp: string; }
function configChain(filename: string): string {
  const root = path.parse(filename).root, parts = filename.slice(root.length).split(/[\\/]/u);
  let current = root;
  const identities: string[] = [];
  for (let i = -1; i < parts.length; i++) {
    if (i >= 0) current = path.join(current, parts[i]);
    const s = lstatSync(current, { bigint: true });
    requireValue(!s.isSymbolicLink() &&
      (i === parts.length - 1 ? s.isFile() && s.nlink === 1n : s.isDirectory()), "CONFIG_CHANGED");
    identities.push(physical(s));
  }
  requireValue(pathKey(realpathSync(filename)) === pathKey(filename), "CONFIG_CHANGED");
  return JSON.stringify(identities);
}
/** These bounded local checks detect replacement; they are not an OS namespace lease. */
function readConfig(filename: string): ConfigRead {
  const chain = configChain(filename), before = lstatSync(filename, { bigint: true });
  requireValue(before.size <= BigInt(AGENT_MAPPING_LIMITS.configBytes), "BUDGET_EXCEEDED");
  const fd = openSync(filename, "r");
  try {
    const opened = fstatSync(fd, { bigint: true });
    requireValue(opened.isFile() && opened.nlink === 1n && fileStamp(opened) === fileStamp(before), "CONFIG_CHANGED");
    const bytes = Buffer.alloc(Number(opened.size) + 1);
    let length = 0;
    while (length < bytes.length) {
      const n = readSync(fd, bytes, length, bytes.length - length, length);
      if (!n) break;
      length += n;
    }
    requireValue(length <= AGENT_MAPPING_LIMITS.configBytes, "BUDGET_EXCEEDED");
    const after = fstatSync(fd, { bigint: true }), current = lstatSync(filename, { bigint: true });
    requireValue(!current.isSymbolicLink() && current.nlink === 1n && length === Number(opened.size) &&
      fileStamp(opened) === fileStamp(after) && fileStamp(after) === fileStamp(current) &&
      configChain(filename) === chain, "CONFIG_CHANGED");
    return { bytes: bytes.subarray(0, length), chain, stamp: fileStamp(opened) };
  } finally { closeSync(fd); }
}
function configCapability(filename: string, expectedHash: string) {
  const original = readConfig(filename);
  const digest = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  requireValue(digest(original.bytes) === expectedHash, "CONFIG_CHANGED");
  const config = checkedAgentMappingConfig(strictJson(original.bytes, AGENT_MAPPING_LIMITS.configBytes));
  let revoked = false;
  function authorize(): void {
    if (revoked) deny("CONFIG_CHANGED");
    try {
      const current = readConfig(filename);
      requireValue(current.chain === original.chain && current.stamp === original.stamp &&
        digest(current.bytes) === expectedHash, "CONFIG_CHANGED");
    } catch {
      revoked = true;
      deny("CONFIG_CHANGED");
    }
  }
  return { config, authorize };
}

/** Read one true-EOF request. Ctrl-Z, NUL, trailing objects and duplicate keys are data errors. */
export function readAgentMappingRequest(input: Readable, signal?: AbortSignal): Promise<MappingReadQuery> {
  return new Promise((resolve, reject) => {
    let ended = false, settled = false, size = 0;
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => done(new MappingError("OWNER_UNAVAILABLE")), AGENT_MAPPING_LIMITS.inputMilliseconds);
    function done(error?: unknown, value?: MappingReadQuery) {
      if (settled) return;
      settled = true; clearTimeout(timer); input.pause();
      input.removeListener("data", data); input.removeListener("end", end);
      input.removeListener("close", closed);
      // An interrupted input can fail later. Keep its error listener until close;
      // cancellation must not turn a late stream error into an uncaught exception.
      if (ended || input.destroyed) input.removeListener("error", failed);
      else input.once("close", () => input.removeListener("error", failed));
      signal?.removeEventListener("abort", aborted);
      if (error) reject(fixed(error)); else resolve(value!);
    }
    function data(chunk: unknown) {
      if (!Buffer.isBuffer(chunk)) return done(new MappingError("INVALID_INPUT"));
      size += chunk.length;
      if (size > AGENT_MAPPING_LIMITS.inputBytes) return done(new MappingError("BUDGET_EXCEEDED"));
      chunks.push(chunk);
    }
    function end() {
      ended = true;
      try { done(undefined, checkedAgentMappingQuery(strictJson(Buffer.concat(chunks), AGENT_MAPPING_LIMITS.inputBytes))); }
      catch (error) { done(error); }
    }
    function failed() { done(new MappingError("OWNER_UNAVAILABLE")); }
    function closed() { if (!ended) failed(); }
    function aborted() { failed(); }
    input.on("data", data); input.once("end", end); input.on("error", failed); input.once("close", closed);
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted || input.destroyed || input.readableEnded) failed();
  });
}

/** The only owner operation in this transport is current accepted read. */
export async function agentMappingCommand(
  args: AgentMappingArguments, query: MappingReadQuery, options: { readonly signal?: AbortSignal } = {},
): Promise<MappingCurrentSnapshot> {
  let native: FixedMappingNativeObserver | undefined, source: FixedMappingSourceObserver | undefined;
  let reader: MappingReader | undefined;
  let result: MappingCurrentSnapshot | undefined, failure: MappingError | undefined;
  let finalCheck: (() => void) | undefined;
  try {
    const a = object(copyData(args, 16384), ["configPath", "configSha256"]);
    const filename = absolute(a.configPath), digest = hash(a.configSha256);
    const q = checkedAgentMappingQuery(query), o = object(options, [], ["signal"]);
    requireValue(o.signal === undefined || o.signal instanceof AbortSignal);
    const signal = o.signal as AbortSignal | undefined;
    if (signal?.aborted) deny("OWNER_UNAVAILABLE");
    const { config: c, authorize } = configCapability(filename, digest);
    requireValue(q.sourceId === c.authority.sourceId, "SCOPE_DENIED");
    const check = () => { if (signal?.aborted) deny("OWNER_UNAVAILABLE"); authorize(); };
    finalCheck = check;
    const runtime = { authorize: check, clock: () => new Date().toISOString() };
    check();
    native = createFixedMappingNativeObserver(c.native, runtime);
    source = createFixedMappingSourceObserver(c.source, runtime);
    reader = createImpactMappingReader({
      storePath: c.storePath, storeUuid: c.storeUuid, sourceIdentityDigest: c.sourceIdentityDigest,
      grant: c.grant, authorities: [c.authority],
      observers: { native: (request, context) => native!.observe(request, context),
        source: (request, context) => source!.observe(request, context) },
      authorize: check, clock: runtime.clock,
    });
    result = await reader.readCurrent(q, signal === undefined ? {} : { signal });
  } catch (error) { failure = fixed(error); }
  finally {
    // Even a bounded reader failure can leave a cooperative observer settling.
    // Never publish/exit while its native child has not actually closed.
    const drains = await Promise.allSettled([reader, native, source].map(owner =>
      Promise.resolve().then(() => owner?.waitForIdle())));
    if (drains.some(row => row.status === "rejected")) failure ??= new MappingError("OWNER_UNAVAILABLE");
  }
  if (failure) throw failure;
  if (!result || !finalCheck) deny("OWNER_UNAVAILABLE");
  finalCheck();
  encodeAgentMappingResult(result);
  return result;
}
/** The cap covers the whole wire frame, including its sole terminal LF. */
export function encodeAgentMappingResult(result: MappingCurrentSnapshot): Buffer {
  const frame = Buffer.from(canonicalMappingJson(result) + "\n", "utf8");
  requireValue(frame.length <= AGENT_MAPPING_LIMITS.outputBytes, "BUDGET_EXCEEDED");
  return frame;
}
