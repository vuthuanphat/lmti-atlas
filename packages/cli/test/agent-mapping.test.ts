import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  canonicalMappingJson, grantFingerprint, mappingCurrentFingerprint, mappingNativeFingerprint,
  mappingReadAuthorityFingerprint, mappingSourceFingerprint, MappingError,
  type MappingCurrentSnapshot, type MappingReaderConfig,
} from "@atlas/impact";
import {
  AGENT_MAPPING_LIMITS, agentMappingArguments, agentMappingCommand, agentMappingError,
  checkedAgentMappingConfig, checkedAgentMappingQuery, encodeAgentMappingResult, readAgentMappingRequest,
  type AgentMappingOwnerConfig,
} from "../src/agent-mapping.js";
import { mappingNativeAuthorityFingerprint } from "../src/impact-mapping-native.js";
import { mappingSourceAuthorityFingerprint } from "../src/impact-mapping-source.js";

// Only factories/read outcomes and their close-held idle notifications are
// controlled here. Real bundled Node/native/LMIP proof belongs to the Python
// complete-chain suite. Config files and streams in this suite are real.
const mocks = vi.hoisted(() => ({ reader: vi.fn(), native: vi.fn(), source: vi.fn() }));
vi.mock("@atlas/impact", async importOriginal => ({
  ...await importOriginal<typeof import("@atlas/impact")>(), createImpactMappingReader: mocks.reader,
}));
vi.mock("../src/impact-mapping-native.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/impact-mapping-native.js")>(), createFixedMappingNativeObserver: mocks.native,
}));
vi.mock("../src/impact-mapping-source.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/impact-mapping-source.js")>(), createFixedMappingSourceObserver: mocks.source,
}));

const roots: string[] = [], streams: PassThrough[] = [], workers: Promise<unknown>[] = [], releases: Array<() => void> = [];
const STORE = "11111111-2222-4333-8444-555555555555", NATIVE = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const NOW = "2026-10-20T12:00:00.000Z";
const sha = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  releases.push(resolve); return { promise, resolve };
}
function tracked<T>(p: Promise<T>): Promise<T> { workers.push(p); void p.catch(() => {}); return p; }
function input(): PassThrough { const value = new PassThrough(); streams.push(value); return value; }
function root(): string {
  const value = mkdtempSync(path.join(realpathSync(tmpdir()), "lmti-agent-mapping-")); roots.push(value); return value;
}
function config(folder: string): AgentMappingOwnerConfig {
  const native = {
    schema: "lmti.impact.mapping-native.v1" as const,
    executable: path.join(folder, process.platform === "win32" ? "lmti-project.exe" : "lmti-project"),
    executableDigest: "a".repeat(64), database: path.join(folder, "native.sqlite"),
    projectId: "factory-monitor", storeUuid: NATIVE, siteId: "factory-demo", environmentId: "test",
    visibility: "external" as const,
  };
  const source = {
    schema: "lmti.impact.mapping-source.v1" as const, kind: "manifest" as const,
    sourceId: "registered-manifest", projectId: native.projectId, siteId: native.siteId, environmentId: native.environmentId,
    root: folder, descriptorFile: "manifest.json", parserVersion: "fixture.v1", policyVersion: "policy-one",
    minimumClassification: "public" as const, allowInternal: false,
  };
  return {
    schema: "lmti.agent.mapping-owner.v1", storePath: path.join(folder, "impact.sqlite"),
    storeUuid: STORE, sourceIdentityDigest: "b".repeat(64),
    grant: { principalId: "reviewed-agent", projectId: native.projectId, siteIds: [native.siteId],
      environmentIds: [native.environmentId], allowInternal: false, policyVersion: "policy-one" },
    authority: { sourceId: source.sourceId, projectId: source.projectId, siteId: source.siteId,
      environmentId: source.environmentId, kind: "manifest", minimumClassification: "public",
      sourceAuthorityFingerprint: mappingSourceAuthorityFingerprint(source), nativeProjectId: native.projectId,
      nativeStoreUuid: NATIVE, nativeAuthorityFingerprint: mappingNativeAuthorityFingerprint(native), policyVersion: source.policyVersion },
    native, source,
  };
}
function result(c: AgentMappingOwnerConfig): MappingCurrentSnapshot {
  const sourceFields = { sourceId: c.authority.sourceId, authorityFingerprint: c.authority.sourceAuthorityFingerprint,
    revision: "source-v1", digest: "c".repeat(64), classification: "public" as const };
  const nativeFields = { schema: 2 as const, projectId: c.native.projectId, storeUuid: NATIVE, authorityFingerprint: c.authority.nativeAuthorityFingerprint,
    revision: 9, targets: [] };
  const body: Omit<MappingCurrentSnapshot, "fingerprint"> = {
    schema: "lmti.impact.mapping-current.v1", storeUuid: STORE, graphRevision: 4, sourceId: c.authority.sourceId,
    grantFingerprint: grantFingerprint(c.grant as any), authorityFingerprint: mappingReadAuthorityFingerprint(c.authority),
    accepted: { batchId: "batch-one", mappingVersion: "mapping-v1", payloadDigest: "d".repeat(64), reviewedAt: NOW },
    source: { id: c.authority.sourceId, projectId: c.native.projectId, siteId: c.native.siteId,
      environmentId: c.native.environmentId, privacy: "public", kind: "manifest", revision: "source-v1",
      digest: "c".repeat(64), capturedAt: NOW, parserVersion: "fixture.v1", complete: true },
    sourceObservation: { ...sourceFields, checkedAt: NOW, fingerprint: mappingSourceFingerprint(sourceFields) },
    sourceContentFingerprint: "e".repeat(64),
    nativeObservation: { ...nativeFields, checkedAt: NOW, fingerprint: mappingNativeFingerprint(nativeFields) },
    mappings: [], evidenceBindings: [], complete: true, checkedAt: NOW,
  };
  return { ...body, fingerprint: mappingCurrentFingerprint(body) };
}
function fixture() {
  const folder = root(), value = config(folder), file = path.join(folder, "mapping-config.json");
  const bytes = Buffer.from(JSON.stringify(value)); writeFileSync(file, bytes);
  const reply = result(value);
  const reader = { readCurrent: vi.fn(async (_query: unknown, _options?: { signal?: AbortSignal }) => reply),
    isIdle: () => true, waitForIdle: vi.fn(async () => {}) };
  const native = { observe: vi.fn(), isIdle: () => true, waitForIdle: vi.fn(async () => {}) };
  const source = { observe: vi.fn(), isIdle: () => true, waitForIdle: vi.fn(async () => {}) };
  mocks.reader.mockReturnValue(reader); mocks.native.mockReturnValue(native); mocks.source.mockReturnValue(source);
  const args = { configPath: file, configSha256: sha(bytes) };
  return { folder, value, file, bytes, reply, reader, native, source, args,
    query: { sourceId: value.authority.sourceId } };
}
function start(f: ReturnType<typeof fixture>, signal?: AbortSignal) {
  return tracked(agentMappingCommand(f.args, f.query, signal === undefined ? {} : { signal }));
}
beforeEach(() => { mocks.reader.mockReset(); mocks.native.mockReset(); mocks.source.mockReset(); });
afterEach(async () => {
  vi.useRealTimers();
  releases.splice(0).forEach(done => done());
  streams.splice(0).forEach(s => { s.on("error", () => {}); s.destroy(); });
  await Promise.allSettled(workers.splice(0));
  for (const folder of roots.splice(0)) {
    const resolved = realpathSync(folder), relative = path.relative(realpathSync(tmpdir()), resolved);
    expect(relative && !relative.startsWith("..") && !path.isAbsolute(relative)).toBeTruthy();
    expect(path.basename(resolved).startsWith("lmti-agent-mapping-")).toBe(true);
    expect(lstatSync(folder).isSymbolicLink()).toBe(false);
    rmSync(resolved, { recursive: true });
  }
});

describe("fixed Agent mapping read transport", () => {
  it("accepts only the one seven-argument command, local config and exact digest", () => {
    const f = fixture(), argv = ["node", "index.js", "accepted-mappings", "--config", f.file, "--config-sha256", sha(f.bytes)];
    expect(agentMappingArguments(argv)).toEqual(f.args);
    for (const bad of [
      [...argv, "--write"], argv.slice(0, -1), [...argv.slice(0, 2), "accept", ...argv.slice(3)],
      [...argv.slice(0, 3), "--database", ...argv.slice(4)],
      [...argv.slice(0, 6), sha(f.bytes) + "\n"],
      [...argv.slice(0, 4), "\\\\untrusted\\share\\config.json", ...argv.slice(5)],
    ]) expect(() => agentMappingArguments(bad)).toThrow("INVALID_INPUT");
    expect(mocks.reader).not.toHaveBeenCalled();
  });
  it("requires true EOF and preserves the existing nonhex Impact source ID", async () => {
    const s = input(), pending = tracked(readAgentMappingRequest(s));
    let settled = false; void pending.then(() => { settled = true; });
    s.write(Buffer.from('{"sourceId":"registered-manifest"}'));
    await turn(); expect(settled).toBe(false);
    s.end(); expect(await pending).toEqual({ sourceId: "registered-manifest" });
  });
  it.each([
    ["escaped duplicate", '{"sourceId":"x","\\u0073ourceId":"y"}'],
    ["extra authority", '{"sourceId":"x","grant":{}}'],
    ["extra cursor", '{"sourceId":"x","cursor":"a"}'],
    ["control Z", '{"sourceId":"x"}\u001agarbage'],
    ["NUL", '{"sourceId":"x"}\u0000'],
    ["second object", '{"sourceId":"x"}{}'],
    ["lone scalar", '{"sourceId":"before\\ud800after"}'],
    ["non-string ID", '{"sourceId":["x"]}'],
    ["invalid UTF8", Buffer.concat([Buffer.from('{"sourceId":"'), Buffer.from([0xff]), Buffer.from('"}')])],
  ])("rejects raw request %s before any owner construction", async (_name, bytes) => {
    const s = input(), pending = tracked(readAgentMappingRequest(s)); s.end(Buffer.from(bytes));
    await expect(pending).rejects.toThrow("INVALID_INPUT");
    expect(mocks.reader).not.toHaveBeenCalled();
  });
  it("checks the actual 4096-byte input boundary without an array-limit shortcut", async () => {
    const body = '{"sourceId":"x"}';
    const exact = Buffer.from(body + " ".repeat(4096 - Buffer.byteLength(body)));
    expect(exact.length).toBe(4096);
    const a = input(), accepted = tracked(readAgentMappingRequest(a)); a.end(exact);
    expect(await accepted).toEqual({ sourceId: "x" });
    const b = input(), refused = tracked(readAgentMappingRequest(b)); b.end(Buffer.concat([exact, Buffer.from(" ")]));
    await expect(refused).rejects.toThrow("BUDGET_EXCEEDED");
  });
  it("bounds incomplete input, retains no authority, and absorbs late stream failure", async () => {
    vi.useFakeTimers();
    const s = input(), pending = tracked(readAgentMappingRequest(s)); s.write(Buffer.from('{"sourceId":'));
    await vi.advanceTimersByTimeAsync(5000);
    await expect(pending).rejects.toThrow("OWNER_UNAVAILABLE");
    expect(() => s.emit("error", new Error("private input detail"))).not.toThrow();
    expect(mocks.reader).not.toHaveBeenCalled();
  });
  it("refuses premature stream close and pre-aborted requests", async () => {
    const a = input(), early = tracked(readAgentMappingRequest(a)); a.destroy();
    await expect(early).rejects.toThrow("OWNER_UNAVAILABLE");
    const controller = new AbortController(); controller.abort();
    await expect(readAgentMappingRequest(input(), controller.signal)).rejects.toThrow("OWNER_UNAVAILABLE");
  });
  it("copies and freezes exact singleton capabilities without mutating source config", () => {
    const f = fixture(), before = JSON.stringify(f.value), normalized = checkedAgentMappingConfig(f.value);
    expect(normalized).toEqual(f.value); expect(Object.isFrozen(normalized.source)).toBe(true);
    expect(Object.isFrozen(normalized.grant.siteIds)).toBe(true);
    (f.value.source as any).root = path.join(f.folder, "changed");
    expect(normalized.source.root).toBe(f.folder);
    expect(before).not.toBe(JSON.stringify(f.value));
  });
  it("preserves independent grant policy and normalizes only code input ordering", () => {
    const f = fixture(), c = copy(f.value) as any;
    c.grant.policyVersion = "separate-grant-policy";
    c.source.kind = "code"; c.source.parserVersion = "mapped-named-function-1";
    c.source.allowedInputs = ["z.ts", "A.ts"]; c.authority.kind = "code";
    c.authority.sourceAuthorityFingerprint = mappingSourceAuthorityFingerprint(c.source);
    const value = checkedAgentMappingConfig(c);
    expect(value.grant.policyVersion).toBe("separate-grant-policy");
    expect(value.authority.policyVersion).toBe("policy-one");
    expect(value.source.kind === "code" && value.source.allowedInputs).toEqual(["A.ts", "z.ts"]);
    expect(c.source.allowedInputs).toEqual(["z.ts", "A.ts"]);
    expect(mappingSourceAuthorityFingerprint(value.source)).toBe(c.authority.sourceAuthorityFingerprint);
  });
  it("refuses extra/nested/operator fields and unsupported native source before factories", async () => {
    const f = fixture();
    for (const mutate of [
      (c: any) => { c.maintenance = { upgrade: true }; },
      (c: any) => { c.grant.command = "accept"; },
      (c: any) => { c.native.arguments = ["write"]; },
      (c: any) => { c.source.file = "other"; },
    ]) {
      const c = copy(f.value); mutate(c);
      expect(() => checkedAgentMappingConfig(c)).toThrow("INVALID_INPUT");
    }
    const unsupported = copy(f.value); (unsupported.authority as any).kind = "native";
    expect(() => checkedAgentMappingConfig(unsupported)).toThrow("UNSUPPORTED_MAPPING");
    expect(mocks.native).not.toHaveBeenCalled(); expect(mocks.source).not.toHaveBeenCalled();
  });
  it("refuses broader or mismatched grants and both privacy-ceiling mismatches before I/O", () => {
    const f = fixture();
    for (const mutate of [
      (c: any) => { c.grant.siteIds.push("another-site"); },
      (c: any) => { c.grant.environmentIds.push("another-environment"); },
      (c: any) => { c.grant.projectId = "other-project"; },
      (c: any) => { c.grant.allowInternal = true; },
      (c: any) => { c.native.visibility = "local"; c.authority.nativeAuthorityFingerprint = mappingNativeAuthorityFingerprint(c.native); },
      (c: any) => { c.source.allowInternal = true; c.authority.sourceAuthorityFingerprint = mappingSourceAuthorityFingerprint(c.source); },
    ]) {
      const c = copy(f.value); mutate(c);
      expect(() => checkedAgentMappingConfig(c)).toThrow("SCOPE_DENIED");
    }
    const local = copy(f.value);
    (local.grant as any).allowInternal = true; (local.native as any).visibility = "local";
    (local.authority as any).nativeAuthorityFingerprint = mappingNativeAuthorityFingerprint(local.native);
    expect(checkedAgentMappingConfig(local).source.allowInternal).toBe(false);
    expect(mocks.reader).not.toHaveBeenCalled();
  });
  it("compares every fixed source/native identity and authority fingerprint before owner reads", () => {
    const f = fixture();
    for (const mutate of [
      (c: any) => { c.authority.sourceAuthorityFingerprint = "f".repeat(64); },
      (c: any) => { c.authority.nativeAuthorityFingerprint = "f".repeat(64); },
      (c: any) => { c.source.sourceId = "different-source"; },
      (c: any) => { c.native.storeUuid = STORE; },
      (c: any) => { c.native.database = path.join(f.folder, "replacement.sqlite"); },
    ]) {
      const c = copy(f.value); mutate(c);
      expect(() => checkedAgentMappingConfig(c)).toThrow("CONFIG_CHANGED");
    }
    expect(mocks.reader).not.toHaveBeenCalled();
  });
  it("validates startup bytes and requested source before opening any store or observer", async () => {
    const f = fixture();
    await expect(agentMappingCommand({ ...f.args, configSha256: "f".repeat(64) }, f.query)).rejects.toThrow("CONFIG_CHANGED");
    await expect(agentMappingCommand(f.args, { sourceId: "other-source" })).rejects.toThrow("SCOPE_DENIED");
    await expect(agentMappingCommand(f.args, { ...f.query, path: "private" } as any)).rejects.toThrow("INVALID_INPUT");
    expect(mocks.reader).not.toHaveBeenCalled(); expect(mocks.native).not.toHaveBeenCalled();
  });
  it("admits an exact 128KiB config file and refuses one extra byte before factory construction", async () => {
    const f = fixture(), exact = Buffer.concat([f.bytes, Buffer.alloc(131072 - f.bytes.length, 32)]);
    writeFileSync(f.file, exact);
    await expect(agentMappingCommand({ ...f.args, configSha256: sha(exact) }, f.query)).resolves.toEqual(f.reply);
    const before = mocks.reader.mock.calls.length, overflow = Buffer.concat([exact, Buffer.from(" ")]);
    writeFileSync(f.file, overflow);
    await expect(agentMappingCommand({ ...f.args, configSha256: sha(overflow) }, f.query)).rejects.toThrow("BUDGET_EXCEEDED");
    expect(mocks.reader).toHaveBeenCalledTimes(before);
  });
  it("uses exactly the read factory/one authority with no maintenance or write dispatcher", async () => {
    const f = fixture(), value = await start(f);
    expect(value).toEqual(f.reply);
    expect(mocks.reader).toHaveBeenCalledTimes(1);
    const c = mocks.reader.mock.calls[0][0] as MappingReaderConfig;
    expect(Object.keys(c).sort()).toEqual(["storePath", "storeUuid", "sourceIdentityDigest", "grant", "authorities", "observers", "authorize", "clock"].sort());
    expect(c.authorities).toEqual([f.value.authority]);
    expect(f.reader.readCurrent).toHaveBeenCalledTimes(1);
    expect(f.reader.readCurrent).toHaveBeenCalledWith(f.query, {});
    expect(mocks.native.mock.calls[0][0]).toEqual(f.value.native);
    expect(mocks.source.mock.calls[0][0]).toEqual(f.value.source);
    expect(new Date(c.clock()).toISOString()).toMatch(/Z$/);
    expect(encodeAgentMappingResult(value).at(-1)).toBe(10);
    expect(readFileSync(f.file)).toEqual(f.bytes);
  });
  it("latches config revocation even if original bytes are restored", async () => {
    const f = fixture(), gate = deferred();
    f.reader.readCurrent.mockImplementation(async () => { await gate.promise; return f.reply; });
    const pending = start(f), c = mocks.reader.mock.calls[0][0] as MappingReaderConfig;
    writeFileSync(f.file, Buffer.from("changed private bytes"));
    expect(() => c.authorize()).toThrow("CONFIG_CHANGED");
    writeFileSync(f.file, f.bytes);
    expect(() => c.authorize()).toThrow("CONFIG_CHANGED");
    gate.resolve(); await expect(pending).rejects.toThrow("CONFIG_CHANGED");
  });
  it("refuses same-path byte-identical replacement instead of pinning the new inode", async () => {
    const f = fixture(), gate = deferred();
    f.reader.readCurrent.mockImplementation(async () => { await gate.promise; return f.reply; });
    const pending = start(f);
    const moved = path.join(f.folder, "old-config.json");
    // Both exact file targets are inside this fixture; no directory tree move.
    expect(path.dirname(f.file)).toBe(f.folder); expect(path.dirname(moved)).toBe(f.folder);
    expect(lstatSync(f.file).isSymbolicLink()).toBe(false);
    renameSync(f.file, moved); writeFileSync(f.file, f.bytes);
    gate.resolve(); await expect(pending).rejects.toThrow("CONFIG_CHANGED");
    expect(mocks.reader).toHaveBeenCalledTimes(1);
  });
  it("publishes only after reader and both independently controlled observers are idle", async () => {
    const f = fixture(), r = deferred(), n = deferred(), s = deferred();
    f.reader.waitForIdle.mockImplementation(() => r.promise);
    f.native.waitForIdle.mockImplementation(() => n.promise);
    f.source.waitForIdle.mockImplementation(() => s.promise);
    const pending = start(f); let settled = false; void pending.then(() => { settled = true; });
    await turn(); expect(settled).toBe(false);
    r.resolve(); n.resolve(); await turn(); expect(settled).toBe(false);
    s.resolve(); expect(await pending).toEqual(f.reply);
    expect(mocks.reader).toHaveBeenCalledTimes(1);
  });
  it("keeps bounded read failure pending through late observer closure without retry", async () => {
    const f = fixture(), closed = deferred();
    f.reader.readCurrent.mockRejectedValue(new MappingError("NATIVE_CHANGED"));
    f.native.waitForIdle.mockImplementation(() => closed.promise);
    const pending = start(f); let settled = false; void pending.catch(() => { settled = true; });
    await turn(); expect(settled).toBe(false);
    closed.resolve(); await expect(pending).rejects.toThrow("NATIVE_CHANGED");
    expect(mocks.reader).toHaveBeenCalledTimes(1); expect(f.reader.readCurrent).toHaveBeenCalledTimes(1);
  });
  it("forwards abort and waits for actual idle before reporting cancellation", async () => {
    const f = fixture(), closed = deferred(), controller = new AbortController();
    f.native.waitForIdle.mockImplementation(() => closed.promise);
    f.reader.readCurrent.mockImplementation(async (_q: unknown, options: any) => {
      await new Promise<void>(resolve => options.signal.addEventListener("abort", () => resolve(), { once: true }));
      throw new MappingError("OWNER_UNAVAILABLE");
    });
    const pending = start(f, controller.signal); let settled = false; void pending.catch(() => { settled = true; });
    controller.abort(); await turn(); expect(settled).toBe(false);
    closed.resolve(); await expect(pending).rejects.toThrow("OWNER_UNAVAILABLE");
  });
  it("reauthorizes after drain before returning a successful typed result", async () => {
    const f = fixture(), idle = deferred();
    f.source.waitForIdle.mockImplementation(() => idle.promise);
    const pending = start(f); await turn();
    writeFileSync(f.file, Buffer.from(JSON.stringify({ ...f.value, sourceIdentityDigest: "f".repeat(64) })));
    idle.resolve(); await expect(pending).rejects.toThrow("CONFIG_CHANGED");
  });
  it("counts the complete serialized frame including LF and returns no partial bytes", () => {
    const f = fixture();
    let body = { ...copy(f.reply), source: { ...f.reply.source, parserVersion: "" } };
    // Serializer-only typed payload; not a claim that a legal maximal accepted
    // import with this oversized metadata can pass the domain reader.
    const base = Buffer.byteLength(canonicalMappingJson(body)) + 1;
    body = { ...body, source: { ...body.source, parserVersion: "x".repeat(4194304 - base) } };
    expect(encodeAgentMappingResult(body).length).toBe(4194304);
    body = { ...body, source: { ...body.source, parserVersion: body.source.parserVersion + "x" } };
    expect(() => encodeAgentMappingResult(body)).toThrow("BUDGET_EXCEEDED");
    expect(AGENT_MAPPING_LIMITS.outputBytes).toBe(4194304);
  });
  it("emits only the bounded schema/code pair and never exception text or paths", () => {
    expect(agentMappingError(new MappingError("SOURCE_CHANGED"))).toEqual({
      schema: "lmti.impact.mapping-current.v1", error: "SOURCE_CHANGED",
    });
    for (const error of [new Error("private /path/raw bytes"), new MappingError("CONFLICT"), { code: "SOURCE_CHANGED" }]) {
      expect(agentMappingError(error)).toEqual({ schema: "lmti.impact.mapping-current.v1", error: "OWNER_UNAVAILABLE" });
    }
    expect(() => checkedAgentMappingQuery({ sourceId: "good", operation: "accept" })).toThrow("INVALID_INPUT");
  });
});
