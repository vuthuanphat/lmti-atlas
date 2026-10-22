import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, writeFile, rm, lstat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mappingNativeFingerprint, type MappingSourceAuthority, type MappingNativeReadRequest } from "@atlas/impact";
import { createFixedMappingNativeObserver, mappingNativeAuthorityFingerprint, type FixedMappingNativeConfig } from "../src/impact-mapping-native.js";
import { strictJson } from "../src/impact-mapping-private.js";

// Only child events/streams are simulated here. Integration has the real native
// process; there is no injectable spawn/clock hook in the production factory.
const mocked = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocked.spawn }));
class Child extends EventEmitter {
  pid = 9876;
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn(() => false);
  closed = false;
  constructor() { super(); this.stdin.resume(); }
  close(code: number | null = 0, signal: NodeJS.Signals | null = null) {
    if (this.closed) return; this.closed = true;
    this.stdout.end(); this.stderr.end(); this.stdin.destroy();
    this.emit("close", code, signal);
  }
}
const roots: string[] = [], children: Child[] = [], workers: Promise<unknown>[] = [];
const uuid = "11111111-2222-4333-8444-555555555555", now = "2026-10-20T10:00:00.000Z";
afterEach(async () => {
  vi.useRealTimers();
  children.splice(0).forEach(c => c.close(1));
  await Promise.allSettled(workers.splice(0)); mocked.spawn.mockReset();
  for (const root of roots.splice(0)) {
    expect(path.dirname(root)).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(root)).toMatch(/^lmti-current-native-/);
    expect((await lstat(root)).isSymbolicLink()).toBe(false);
    await rm(root, { recursive: true });
  }
});
async function fixture(visibility: "local" | "external" = "external",
  schema: FixedMappingNativeConfig["schema"] = "lmti.impact.mapping-native.v1") {
  const root = await mkdtemp(path.join(path.resolve(os.tmpdir()), "lmti-current-native-")); roots.push(root);
  const bytes = Buffer.from("Pinned non-executable fixture; spawn is explicitly mocked.");
  const config: FixedMappingNativeConfig = { schema,
    executable: path.join(root, process.platform === "win32" ? "lmti-project.exe" : "lmti-project"),
    executableDigest: createHash("sha256").update(bytes).digest("hex"), database: path.join(root, "never-open.sqlite"),
    projectId: "project-one", storeUuid: uuid, siteId: "site-one", environmentId: "test", visibility };
  await writeFile(config.executable, bytes);
  const authority: MappingSourceAuthority = { sourceId: "manifest-one", projectId: config.projectId,
    siteId: config.siteId, environmentId: config.environmentId, kind: "manifest", minimumClassification: "public",
    sourceAuthorityFingerprint: "a".repeat(64), nativeProjectId: config.projectId, nativeStoreUuid: uuid,
    nativeAuthorityFingerprint: mappingNativeAuthorityFingerprint(config), policyVersion: "policy-one" };
  const request: MappingNativeReadRequest = { phase: "current", pass: 1, authority, allowInternal: visibility === "local",
    targets: [{ projectId: config.projectId, storeUuid: uuid, kind: "component", id: "component-one" }] };
  let authorized = true;
  const observer = createFixedMappingNativeObserver(config, {
    authorize: () => { if (!authorized) throw new Error("private configuration text"); }, clock: () => now
  });
  mocked.spawn.mockImplementation(() => { const child = new Child(); children.push(child); return child; });
  return { root, config, request, observer, revoke: () => { authorized = false; }, restore: () => { authorized = true; } };
}
function start(f: Awaited<ReturnType<typeof fixture>>, request = f.request, signal = new AbortController().signal) {
  const result = f.observer.observe(request, { signal, timeoutMilliseconds: 40000 });
  workers.push(result); void result.catch(() => {}); return result;
}
async function child(): Promise<Child> {
  for (let i = 0; i < 200 && !children.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
  expect(children.length).toBeGreaterThan(0); return children.at(-1)!;
}
function success(f: Awaited<ReturnType<typeof fixture>>) {
  const schema3 = f.config.schema === "lmti.impact.mapping-native.v2";
  return { ok: true, schema: schema3 ? "lmti.project.mapping-observation.v2" : "lmti.project.mapping-observation.v1",
    ...(schema3 ? { storageSchema: 3 } : {}), projectId: f.config.projectId,
    storeUuid: uuid, revision: 7, targets: [...f.request.targets].sort((a, b) =>
      a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(target => ({
      target, effectiveClassification: "public", ancestryFingerprint: "b".repeat(64),
      referenceFingerprint: ["repository", "knowledge"].includes(target.kind) ? "c".repeat(64) : null,
      identityState: ["repository", "knowledge"].includes(target.kind) ? "present_reference" : "active"
    })) };
}
function frame(value: unknown): Buffer { return Buffer.from(JSON.stringify(value) + "\n"); }

describe("fixed current native adapter", () => {
  it.each([
    ["lmti.impact.mapping-native.v1", "mapping-observation", 2],
    ["lmti.impact.mapping-native.v2", "mapping-observation-v2", 3],
  ] as const)("pins %s authority, argv and environment; publishes only after synthetic child close", async (schema, command, storageSchema) => {
    const f = await fixture("external", schema), pending = start(f), c = await child();
    const [exe, args, options] = mocked.spawn.mock.calls[0];
    expect(exe).toBe(f.config.executable);
    expect(args).toEqual([command, f.config.database, "project-one", uuid, "site-one", "test", "external"]);
    expect(options).toMatchObject({ shell: false, windowsHide: true, cwd: f.root, stdio: ["pipe", "pipe", "pipe"] });
    expect(Object.keys(options.env).every(k => ["SystemRoot", "WINDIR", "TEMP", "TMP", "PATH", "QT_PLUGIN_PATH"].includes(k))).toBe(true);
    let settled = false; void pending.then(() => { settled = true; });
    c.stdout.end(frame(success(f))); await new Promise(resolve => setImmediate(resolve));
    expect(settled).toBe(false); expect(f.observer.isIdle()).toBe(false);
    c.close(); const result = await pending;
    const { checkedAt, fingerprint, ...content } = result;
    expect(result.schema).toBe(storageSchema);
    expect(Object.keys(result).sort()).toEqual(["schema", "projectId", "storeUuid", "revision",
      "authorityFingerprint", "targets", "checkedAt", "fingerprint"].sort());
    expect(checkedAt).toBe(now); expect(fingerprint).toBe(mappingNativeFingerprint(content));
    expect(Object.isFrozen(result.targets)).toBe(true); expect(f.observer.isIdle()).toBe(true);
    expect(mocked.spawn).toHaveBeenCalledTimes(1);
  });
  it("preserves v1 authority golden bytes and pins v2 as a different immutable authority", () => {
    const windows = process.platform === "win32";
    const config: FixedMappingNativeConfig = {
      schema: "lmti.impact.mapping-native.v1",
      executable: windows ? "C:/lmti-fixture/lmti-project.exe" : "/lmti-fixture/lmti-project",
      executableDigest: "e".repeat(64),
      database: windows ? "C:/lmti-fixture/project.sqlite" : "/lmti-fixture/project.sqlite",
      projectId: "project-one", storeUuid: uuid, siteId: "site-one", environmentId: "test", visibility: "external",
    };
    expect(mappingNativeAuthorityFingerprint(config)).toBe(windows
      ? "4bb2e4dd8743cfe03984397beeb73113edcd395292f6712c2d15fee61a77a9f3"
      : "0dd8b4b54b0cea2bb783f3cfbfcb2b533f78c66d77627bcb4c129afcc4497ea5");
    expect(mappingNativeAuthorityFingerprint({ ...config, schema: "lmti.impact.mapping-native.v2" })).toBe(windows
      ? "dc9a81fabc430810a79ee51897a49677b757b731caf688350eeabff760884d40"
      : "52e42a668bbcfaa7802809bab359d612c9c393f3b246c93fb415d2af16807ad4");
    for (const schema of [undefined, null, true, 2, "lmti.impact.mapping-native.v3"]) {
      expect(() => mappingNativeAuthorityFingerprint({ ...config, schema } as unknown as FixedMappingNativeConfig)).toThrow("INVALID_INPUT");
    }
    expect(() => mappingNativeAuthorityFingerprint({ ...config, storageSchema: 3 } as FixedMappingNativeConfig)).toThrow("INVALID_INPUT");
    expect(mocked.spawn).not.toHaveBeenCalled();
  });
  it.each([
    ["lmti.impact.mapping-native.v1", "v2 frame", "schema", "lmti.project.mapping-observation.v2"],
    ["lmti.impact.mapping-native.v1", "extra schema field", "storageSchema", 2],
    ["lmti.impact.mapping-native.v2", "v1 frame", "schema", "lmti.project.mapping-observation.v1"],
    ["lmti.impact.mapping-native.v2", "missing schema", "storageSchema", undefined],
    ["lmti.impact.mapping-native.v2", "wrong schema2", "storageSchema", 2],
    ["lmti.impact.mapping-native.v2", "unknown schema", "storageSchema", 4],
    ["lmti.impact.mapping-native.v2", "string schema", "storageSchema", "3"],
    ["lmti.impact.mapping-native.v2", "Boolean schema", "storageSchema", true],
    ["lmti.impact.mapping-native.v2", "null schema", "storageSchema", null],
    ["lmti.impact.mapping-native.v2", "private ledger field", "receipts", []],
  ] as const)("refuses crossed %s response: %s", async (schema, _name, key, value) => {
    const f = await fixture("external", schema), pending = start(f), c = await child();
    const reply: Record<string, unknown> = { ...success(f), [key]: value };
    if (value === undefined) delete reply[key];
    c.stdout.end(frame(reply)); c.close();
    await expect(pending).rejects.toThrow("OWNER_UNAVAILABLE");
    expect(mocked.spawn).toHaveBeenCalledTimes(1);
  });
  it("never falls back from explicit v2 refusal or reuses the old registered authority", async () => {
    const f = await fixture("external", "lmti.impact.mapping-native.v2");
    const stale = { ...f.request, authority: { ...f.request.authority,
      nativeAuthorityFingerprint: mappingNativeAuthorityFingerprint({ ...f.config, schema: "lmti.impact.mapping-native.v1" }) } };
    await expect(start(f, stale)).rejects.toThrow("CONFIG_CHANGED");
    expect(mocked.spawn).not.toHaveBeenCalled();
    const pending = start(f), c = await child();
    c.stdout.end(frame({ ok: false, code: "NOT_SUPPORTED" })); c.close(1);
    await expect(pending).rejects.toThrow("UNSUPPORTED_MAPPING");
    expect(mocked.spawn).toHaveBeenCalledTimes(1);
    expect(mocked.spawn.mock.calls[0][1][0]).toBe("mapping-observation-v2");
  });
  it("copies config and request before awaits and keeps original tuples", async () => {
    const f = await fixture(), pending = start(f);
    (f.config as { database: string }).database = path.join(f.root, "replacement.sqlite");
    (f.request.targets[0] as { id: string }).id = "mutated";
    const c = await child(), reply = success(f);
    reply.targets[0].target = { ...reply.targets[0].target, id: "component-one" };
    c.stdout.end(frame(reply)); c.close();
    expect((await pending).targets[0].target.id).toBe("component-one");
    expect(mocked.spawn.mock.calls[0][1][1]).toBe(path.join(f.root, "never-open.sqlite"));
  });
  it("refuses local observation for an external-only grant before any spawn", async () => {
    const f = await fixture("local");
    await expect(start(f, { ...f.request, allowInternal: false })).rejects.toThrow("SCOPE_DENIED");
    expect(mocked.spawn).not.toHaveBeenCalled(); expect(f.observer.isIdle()).toBe(true);
  });
  it("refuses changed authority, duplicate targets, extra fields and native-as-source before spawn", async () => {
    const f = await fixture();
    for (const req of [
      { ...f.request, authority: { ...f.request.authority, nativeAuthorityFingerprint: "d".repeat(64) } },
      { ...f.request, targets: [f.request.targets[0], f.request.targets[0]] },
      { ...f.request, command: "snapshot" },
      { ...f.request, authority: { ...f.request.authority, kind: "native" } }
    ]) await expect(start(f, req as MappingNativeReadRequest)).rejects.toThrow();
    expect(mocked.spawn).not.toHaveBeenCalled();
  });
  it("validates executable digest before spawn and latches authorization failure", async () => {
    const f = await fixture();
    await writeFile(f.config.executable, "changed");
    await expect(start(f)).rejects.toThrow("CONFIG_CHANGED"); expect(mocked.spawn).not.toHaveBeenCalled();
    f.revoke(); await expect(start(f)).rejects.toThrow("CONFIG_CHANGED"); f.restore();
    await expect(start(f)).rejects.toThrow("CONFIG_CHANGED");
  });
  it("accepts all eight kinds with same ID and exact active/reference-null coherence", async () => {
    const f = await fixture();
    const kinds = ["subsystem", "site", "repository", "knowledge", "environment", "component", "asset", "area"] as const;
    const request = { ...f.request, targets: kinds.map(kind => ({ projectId: f.config.projectId, storeUuid: uuid, kind, id: "same" })) };
    const pending = start(f, request), c = await child();
    const reply = success({ ...f, request }); c.stdout.end(frame(reply)); c.close();
    expect((await pending).targets.map(row => row.target.kind)).toEqual([...kinds].sort());
  });
  it.each([
    ["duplicate decoded key", (v: string) => v.replace('"revision":7', '"revision":7,"\\u0072evision":7')],
    ["lone high surrogate", (v: string) => v.replace("component-one", "before\\ud800after")],
    ["invalid UTF8", (v: string) => Buffer.concat([Buffer.from(v.slice(0, 20)), Buffer.from([255]), Buffer.from(v.slice(20))])],
    ["missing LF", (v: string) => v.slice(0, -1)],
    ["double LF", (v: string) => v + "\n"],
    ["CRLF", (v: string) => v.slice(0, -1) + "\r\n"],
    ["trailing NUL", (v: string) => v + "\0"],
    ["extra private field", (v: string) => v.replace('"ok":true', '"ok":true,"path":"private"')],
    ["wrong identity", (v: string) => v.replaceAll(uuid, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee")],
    ["max unsafe project revision", (v: string) => v.replace('"revision":7', '"revision":9007199254740991')],
    ["registry/reference mismatch", (v: string) => v.replace('"identityState":"active"', '"identityState":"present_reference"')]
  ])("rejects malformed complete frame: %s", async (_name, transform) => {
    const f = await fixture(), pending = start(f), c = await child();
    c.stdout.end(transform(JSON.stringify(success(f)) + "\n")); c.close();
    await expect(pending).rejects.toThrow("OWNER_UNAVAILABLE");
  });
  it.each([
    ["NATIVE_UNAVAILABLE", "NATIVE_UNAVAILABLE"], ["CONFIG_CHANGED", "NATIVE_CHANGED"],
    ["NOT_SUPPORTED", "UNSUPPORTED_MAPPING"], ["BUDGET_EXCEEDED", "BUDGET_EXCEEDED"],
    ["OWNER_UNAVAILABLE", "OWNER_UNAVAILABLE"], ["INVALID_INPUT", "OWNER_UNAVAILABLE"], ["unknown", "OWNER_UNAVAILABLE"]
  ])("correlates native refusal %s with exit1", async (code, expected) => {
    const f = await fixture(), pending = start(f), c = await child();
    c.stdout.end(frame({ ok: false, code })); c.close(1);
    await expect(pending).rejects.toThrow(expected);
  });
  it("refuses success on nonzero exit and error on zero exit", async () => {
    const f = await fixture(), pending = start(f), c = await child();
    c.stdout.end(frame(success(f))); c.close(1); await expect(pending).rejects.toThrow("OWNER_UNAVAILABLE");
    children.length = 0;
    const again = start(f), second = await child();
    second.stdout.end(frame({ ok: false, code: "NATIVE_UNAVAILABLE" })); second.close(0);
    await expect(again).rejects.toThrow("OWNER_UNAVAILABLE");
  });
  it("holds BUSY after synthetic abort/error/stdout EOF until close; never retries", async () => {
    const f = await fixture(), controller = new AbortController(), pending = start(f, f.request, controller.signal), c = await child();
    controller.abort(); c.emit("error", new Error("private raw error")); c.stdout.end(frame(success(f)));
    let idle = false; void f.observer.waitForIdle().then(() => { idle = true; });
    await expect(start(f)).rejects.toThrow("BUSY");
    await new Promise(resolve => setImmediate(resolve)); expect(idle).toBe(false);
    expect(c.kill).toHaveBeenCalledTimes(1); expect(mocked.spawn).toHaveBeenCalledTimes(1);
    c.close(1); await expect(pending).rejects.toThrow("OWNER_UNAVAILABLE");
    await f.observer.waitForIdle(); expect(idle).toBe(true);
  });
  it("uses the fixed35s deadline with a fake clock but awaits actual synthetic close", async () => {
    const f = await fixture();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = start(f);
    // File I/O remains real; only advance timers after spawn is observed.
    for (let i = 0; i < 200 && !children.length; i++) await sleep(5);
    expect(children).toHaveLength(1); const c = children[0];
    await vi.advanceTimersByTimeAsync(35000);
    expect(c.kill).toHaveBeenCalledTimes(1); expect(f.observer.isIdle()).toBe(false);
    await expect(start(f)).rejects.toThrow("BUSY");
    vi.useRealTimers(); c.close(1); await expect(pending).rejects.toThrow("OWNER_UNAVAILABLE");
  });
  it.each(["stdout", "stderr"] as const)("drains %s overflow and retains slot to close", async stream => {
    const f = await fixture(), pending = start(f), c = await child();
    c[stream].write(Buffer.alloc((stream === "stdout" ? 4194304 : 65536) + 1, 32));
    expect(c.kill).toHaveBeenCalledTimes(1); expect(f.observer.isIdle()).toBe(false);
    c.close(1); await expect(pending).rejects.toThrow("OWNER_UNAVAILABLE");
  });
  it("withholds a valid reply after late authority revocation and does not revive after restoration", async () => {
    const f = await fixture(), pending = start(f), c = await child();
    f.revoke(); c.stdout.end(frame(success(f))); c.close();
    await expect(pending).rejects.toThrow("CONFIG_CHANGED"); f.restore();
    await expect(start(f)).rejects.toThrow("CONFIG_CHANGED"); expect(mocked.spawn).toHaveBeenCalledTimes(1);
  });
  it("strict bytes preserve legal supplementary strings and exact4MiB boundary, without a lower generic array cap", () => {
    expect(strictJson(Buffer.from('{"x":"before\\ud83d\\ude00after"}'), 4194304)).toEqual({ x: "before😀after" });
    const base = Buffer.from('{"items":[]}'), exact = Buffer.concat([base, Buffer.alloc(4194304 - base.length, 32)]);
    expect(strictJson(exact, 4194304)).toEqual({ items: [] });
    expect(() => strictJson(Buffer.concat([exact, Buffer.from(" ")]), 4194304)).toThrow("BUDGET_EXCEEDED");
    const array = Array.from({ length: 5000 }, (_, i) => i);
    expect((strictJson(Buffer.from(JSON.stringify({ array })), 4194304) as { array: number[] }).array).toHaveLength(5000);
    expect(() => strictJson(Buffer.concat([Buffer.from('{"x":"before'), Buffer.from([255]), Buffer.from('after"}')]), 4194304)).toThrow();
    expect(() => strictJson(Buffer.from('{"x":"before\\ud800after"}'), 4194304)).toThrow();
    expect(() => strictJson(Buffer.from('{"x":"before\\udc00after"}'), 4194304)).toThrow();
    expect(() => strictJson(Buffer.from('{"x":1,"\\u0078":2}'), 4194304)).toThrow();
  });
  it("accepts all4000 requested targets and refuses4001 before a second spawn", async () => {
    const f = await fixture();
    const request = { ...f.request, authority: { ...f.request.authority, policyVersion: "p".repeat(160) },
      targets: Array.from({ length: 4000 }, (_, i) => ({ ...f.request.targets[0], id: `component-${String(i).padStart(4, "0")}` })) };
    const pending = start(f, request), c = await child();
    const bytes = frame(success({ ...f, request }));
    expect(bytes.length).toBeLessThan(4194304); c.stdout.end(bytes); c.close();
    expect((await pending).targets).toHaveLength(4000);
    await expect(start(f, { ...request, targets: [...request.targets, { ...request.targets[0], id: "extra" }] })).rejects.toThrow("BUDGET_EXCEEDED");
    expect(mocked.spawn).toHaveBeenCalledTimes(1);
  });
});
