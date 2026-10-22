import { promises as fs } from "node:fs";
import { execFile, fork, type ChildProcess } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appendAuditEvent as appendAuditEventImpl, readAuditEvents,
  retainAuditEvents as retainAuditEventsImpl, verifyAuditIntegrity } from "../src/audit";

const children = new Set<ChildProcess>();
const pendingWrites = new Set<Promise<unknown>>();
const fixtures: string[] = [];
function trackedWrite<T>(operation: Promise<T>): Promise<T> {
  pendingWrites.add(operation);
  void operation.then(() => pendingWrites.delete(operation), () => pendingWrites.delete(operation));
  return operation;
}
const appendAuditEvent: typeof appendAuditEventImpl = (...args) => trackedWrite(appendAuditEventImpl(...args));
const retainAuditEvents: typeof retainAuditEventsImpl = (...args) => trackedWrite(retainAuditEventsImpl(...args));
const source = path.resolve("packages/privacy/src/audit.ts");
const workerScript = path.resolve("packages/privacy/test/fixtures/audit-worker.mjs");
const event = (id: string) => ({ action: "test.audit", recordId: id, sensitivity: "public" as const,
  role: "developer" as const, decision: "allow" as const, command: "audit-test", reason: "synthetic" });
async function fixture(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lmti-audit-"));
  fixtures.push(directory); return directory;
}
const log = (cwd: string) => path.join(cwd, ".lmti", "privacy", "audit.jsonl");

// Fingerprints avoid putting account SIDs or ACL text into failed-test output.
async function windowsAcl(mode: "inspect" | "protected" | "deny-write", name: string): Promise<string> {
  const script = `
$ErrorActionPreference = 'Stop'
$section = [System.Security.AccessControl.AccessControlSections]::Access
$name = $env:LMTI_ACL_FIXTURE_PATH
if ($env:LMTI_ACL_FIXTURE_MODE -ne 'inspect') {
  $acl = New-Object System.Security.AccessControl.FileSecurity
  $acl.SetAccessRuleProtection($true, $false)
  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'Allow')))
  if ($env:LMTI_ACL_FIXTURE_MODE -eq 'deny-write') {
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'WriteData', 'Deny')))
  }
  [System.IO.File]::SetAccessControl($name, $acl)
}
$acl = [System.IO.File]::GetAccessControl($name, $section)
$bytes = [System.Text.Encoding]::UTF8.GetBytes($acl.GetSecurityDescriptorSddlForm($section))
$digest = [System.Security.Cryptography.SHA256]::Create().ComputeHash($bytes)
[Console]::Out.Write([System.BitConverter]::ToString($digest))
`;
  return new Promise((resolve, reject) => execFile(path.join(process.env.SystemRoot || "C:\\Windows",
    "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoLogo", "-NoProfile", "-NonInteractive",
    "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    windowsHide: true, timeout: 10000, maxBuffer: 4096,
    env: { ...process.env, LMTI_ACL_FIXTURE_PATH: name, LMTI_ACL_FIXTURE_MODE: mode }
  }, (error, stdout) => error ? reject(new Error("ACL_FIXTURE_FAILED")) : resolve(stdout)));
}

function worker(cwd: string, mode: string, count = 1, prefix = mode) {
  const child = fork(workerScript, [source, cwd, mode, String(count), prefix], {
    execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"], env: { ...process.env, NODE_NO_WARNINGS: "1" }
  });
  children.add(child);
  let resolveReady!: () => void;
  let resolvePhase!: (value: string) => void;
  let resolveResult!: (value: { ok: boolean; code?: string }) => void;
  let result: { ok: boolean; code?: string } | undefined;
  const ready = new Promise<void>(resolve => { resolveReady = resolve; });
  const phase = new Promise<string>(resolve => { resolvePhase = resolve; });
  const done = new Promise<{ ok: boolean; code?: string }>(resolve => { resolveResult = resolve; });
  child.on("message", value => {
    const message = value as { kind: string; phase?: string; ok?: boolean; code?: string };
    if (message.kind === "ready") resolveReady();
    if (message.kind === "phase") resolvePhase(message.phase!);
    if (message.kind === "done") result = { ok: message.ok!, code: message.code };
  });
  child.on("error", () => { resolveReady(); resolveResult({ ok: false, code: "CHILD_ERROR" }); });
  child.on("close", () => { children.delete(child); resolveResult(result ?? { ok: false, code: "CHILD_CLOSED" }); });
  return { child, ready, phase, done, start: () => child.send({ go: true }) };
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(resolve => { child.once("close", () => resolve()); child.kill("SIGKILL"); });
}

afterEach(async () => {
  try {
    await Promise.all([...children].map(stop));
    // Vitest timing out a test does not cancel its promises. Let every admitted
    // write close its SQLite/file handles before deleting the fixture namespace.
    while (pendingWrites.size) await Promise.allSettled([...pendingWrites]);
  } finally { vi.restoreAllMocks(); }
  for (const directory of fixtures.splice(0)) await fs.rm(directory, { recursive: true, force: true });
}, 20000);

describe("audit owner", () => {
  it("inspects absent logs without creating project state", async () => {
    const cwd = await fixture();
    await expect(readAuditEvents(cwd)).resolves.toEqual([]);
    await expect(verifyAuditIntegrity(cwd)).resolves.toMatchObject({ valid: true, checked: 0 });
    await expect(fs.stat(path.join(cwd, ".lmti"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serializes same-process appends and preserves existing bytes", async () => {
    const cwd = await fixture();
    await appendAuditEvent(cwd, event("seed"));
    const before = await fs.readFile(log(cwd));
    const writes = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => appendAuditEvent(cwd, event(String(index)))));
    expect(writes.map(value => value.status)).toEqual(Array(8).fill("fulfilled"));
    const rows = await readAuditEvents(cwd, 20);
    expect(rows).toHaveLength(9);
    expect(new Set(rows.map(row => row.sequence)).size).toBe(9);
    expect((await fs.readFile(log(cwd))).subarray(0, before.length)).toEqual(before);
    await expect(verifyAuditIntegrity(cwd)).resolves.toMatchObject({ valid: true, checked: 9 });
  }, 15000);

  it("coordinates first initialization and appends across independent processes", async () => {
    const cwd = await fixture();
    const writers = [worker(cwd, "append", 8, "one"), worker(cwd, "append", 8, "two")];
    await Promise.all(writers.map(value => value.ready));
    writers.forEach(value => value.start());
    expect(await Promise.all(writers.map(value => value.done))).toEqual([{ ok: true, code: undefined }, { ok: true, code: undefined }]);
    const rows = await readAuditEvents(cwd, 20);
    expect(new Set(rows.map(row => row.recordId)).size).toBe(16);
    expect(new Set(rows.map(row => row.sequence)).size).toBe(16);
    await expect(verifyAuditIntegrity(cwd)).resolves.toMatchObject({ valid: true, checked: 16 });
  }, 15000);

  it("does not lose acknowledged events when processes append and retain concurrently", async () => {
    const cwd = await fixture();
    for (let index = 0; index < 5; index++) await appendAuditEvent(cwd, event(`seed-${index}`));
    const workers = [worker(cwd, "append", 8, "one"), worker(cwd, "append", 8, "two"), worker(cwd, "retain", 8)];
    await Promise.all(workers.map(value => value.ready)); workers.forEach(value => value.start());
    for (const result of await Promise.all(workers.map(value => value.done))) expect(result.ok).toBe(true);
    const active = await readAuditEvents(cwd, 100), all = [...active];
    const directory = path.join(cwd, ".lmti", "privacy", "archive");
    for (const name of await fs.readdir(directory)) {
      const rows = (await fs.readFile(path.join(directory, name), "utf8")).trim().split("\n").map(line => JSON.parse(line));
      all.push(...rows);
    }
    expect(new Set(all.map(row => row.recordId)).size).toBe(21);
    expect(new Set(all.map(row => row.sequence)).size).toBe(21);
    await expect(verifyAuditIntegrity(cwd)).resolves.toMatchObject({ valid: true });
  }, 15000);

  it("never silently repairs corrupt hashes during append or retention", async () => {
    const cwd = await fixture();
    await appendAuditEvent(cwd, event("seed"));
    const bad = (await fs.readFile(log(cwd), "utf8")).replace('"synthetic"', '"changed"');
    await fs.writeFile(log(cwd), bad, { mode: 0o600 });
    await expect(verifyAuditIntegrity(cwd)).resolves.toMatchObject({ valid: false });
    await expect(appendAuditEvent(cwd, event("later"))).rejects.toThrow("AUDIT_INTEGRITY_INVALID");
    await expect(retainAuditEvents(cwd, 1)).rejects.toThrow("AUDIT_INTEGRITY_INVALID");
    expect(await fs.readFile(log(cwd), "utf8")).toBe(bad);
  });

  it("rejects malformed JSON safely and does not overwrite it", async () => {
    const cwd = await fixture();
    await appendAuditEvent(cwd, event("seed"));
    await fs.writeFile(log(cwd), "{broken fixture", { mode: 0o600 });
    await expect(appendAuditEvent(cwd, event("later"))).rejects.toThrow("AUDIT_INVALID_LOG");
    await expect(readAuditEvents(cwd)).rejects.toThrow("AUDIT_INVALID_LOG");
    expect(await fs.readFile(log(cwd), "utf8")).toBe("{broken fixture");
  });

  it("releases its lock after a write error and leaves the original log intact", async () => {
    const cwd = await fixture();
    await appendAuditEvent(cwd, event("seed"));
    const before = await fs.readFile(log(cwd));
    const rename = vi.spyOn(fs, "rename").mockRejectedValueOnce(Object.assign(new Error("synthetic"), { code: "EIO" }));
    await expect(appendAuditEvent(cwd, event("failed"))).rejects.toThrow("AUDIT_STORAGE_UNAVAILABLE");
    rename.mockRestore();
    expect(await fs.readFile(log(cwd))).toEqual(before);
    await appendAuditEvent(cwd, event("after"));
    await expect(verifyAuditIntegrity(cwd)).resolves.toMatchObject({ valid: true, checked: 2 });
  });

  it("times out without stealing a live process lock, then recovers after process death", async () => {
    const cwd = await fixture();
    await appendAuditEvent(cwd, event("seed"));
    const before = await fs.readFile(log(cwd));
    const holder = worker(cwd, "hold-lock"); await holder.ready; holder.start();
    expect(await holder.phase).toBe("locked");
    await expect(appendAuditEvent(cwd, event("timeout"))).rejects.toThrow("AUDIT_BUSY");
    expect(holder.child.exitCode).toBeNull();
    expect(await fs.readFile(log(cwd))).toEqual(before);
    await stop(holder.child);
    await appendAuditEvent(cwd, event("after-crash"));
    await expect(verifyAuditIntegrity(cwd)).resolves.toMatchObject({ valid: true, checked: 2 });
  }, 15000);

  it.each(["before-publish", "after-publish"])("keeps a valid snapshot after writer death %s", async mode => {
    const cwd = await fixture();
    await appendAuditEvent(cwd, event("seed"));
    const writer = worker(cwd, mode); await writer.ready; writer.start();
    expect(await writer.phase).toBe(mode);
    await stop(writer.child);
    const expected = mode === "before-publish" ? 1 : 2;
    await expect(verifyAuditIntegrity(cwd)).resolves.toMatchObject({ valid: true, checked: expected });
    await appendAuditEvent(cwd, event("after-crash"));
    await expect(verifyAuditIntegrity(cwd)).resolves.toMatchObject({ valid: true, checked: expected + 1 });
  }, 15000);

  it("retains all data if killed after archive publication and retries the same split safely", async () => {
    const cwd = await fixture();
    for (let index = 0; index < 5; index++) await appendAuditEvent(cwd, event(String(index)));
    const before = await fs.readFile(log(cwd));
    const writer = worker(cwd, "retention-before-publish"); await writer.ready; writer.start();
    expect(await writer.phase).toBe("before-publish"); await stop(writer.child);
    expect(await fs.readFile(log(cwd))).toEqual(before);
    const directory = path.join(cwd, ".lmti", "privacy", "archive");
    expect((await fs.readdir(directory)).filter(name => name.endsWith(".jsonl"))).toHaveLength(1);
    const result = await retainAuditEvents(cwd, 3);
    expect(result).toMatchObject({ retained: 3, archived: 2 });
    expect((await fs.readdir(directory)).filter(name => name.endsWith(".jsonl"))).toHaveLength(1);
    await expect(verifyAuditIntegrity(cwd)).resolves.toMatchObject({ valid: true, checked: 3 });
  }, 15000);

  it("rejects a linked private directory before creating anything outside the project", async () => {
    const cwd = await fixture(), outside = await fixture();
    await fs.symlink(outside, path.join(cwd, ".lmti"), process.platform === "win32" ? "junction" : "dir");
    await expect(appendAuditEvent(cwd, event("blocked"))).rejects.toThrow("AUDIT_SOURCE_BOUNDARY_DENIED");
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it("rejects a hardlinked audit file without changing either name", async () => {
    const cwd = await fixture(), outside = await fixture();
    await appendAuditEvent(cwd, event("seed"));
    const before = await fs.readFile(log(cwd));
    await fs.link(log(cwd), path.join(outside, "copy"));
    await expect(appendAuditEvent(cwd, event("blocked"))).rejects.toThrow("AUDIT_SOURCE_BOUNDARY_DENIED");
    expect(await fs.readFile(path.join(outside, "copy"))).toEqual(before);
  });

  it("rejects linked privacy/archive directories before publication", async () => {
    const cwd = await fixture(), outside = await fixture();
    await fs.mkdir(path.join(cwd, ".lmti"), { mode: 0o700 });
    const privacy = path.join(cwd, ".lmti", "privacy");
    await fs.symlink(outside, privacy, process.platform === "win32" ? "junction" : "dir");
    await expect(appendAuditEvent(cwd, event("blocked"))).rejects.toThrow("AUDIT_SOURCE_BOUNDARY_DENIED");
    expect(await fs.readdir(outside)).toEqual([]);
    await fs.unlink(privacy);
    await appendAuditEvent(cwd, event("one")); await appendAuditEvent(cwd, event("two"));
    const before = await fs.readFile(log(cwd));
    await fs.symlink(outside, path.join(privacy, "archive"), process.platform === "win32" ? "junction" : "dir");
    await expect(retainAuditEvents(cwd, 1)).rejects.toThrow("AUDIT_SOURCE_BOUNDARY_DENIED");
    expect(await fs.readdir(outside)).toEqual([]);
    expect(await fs.readFile(log(cwd))).toEqual(before);
  });

  it("does not let SQLite follow a hardlinked mutex sidecar", async () => {
    const cwd = await fixture(), outside = await fixture();
    await appendAuditEvent(cwd, event("seed"));
    const target = path.join(outside, "unrelated");
    await fs.writeFile(target, "untouched", { mode: 0o600 });
    await fs.link(target, path.join(cwd, ".lmti", "privacy", ".audit-lock.sqlite-journal"));
    await expect(appendAuditEvent(cwd, event("blocked"))).rejects.toThrow("AUDIT_SOURCE_BOUNDARY_DENIED");
    expect(await fs.readFile(target, "utf8")).toBe("untouched");
  });

  it.skipIf(process.platform !== "win32")("preserves a protected DACL before writing replacement and archive bytes", async () => {
    const cwd = await fixture();
    await appendAuditEvent(cwd, event("one")); await appendAuditEvent(cwd, event("two"));
    const expected = await windowsAcl("protected", log(cwd));
    const originalOpen = fs.open.bind(fs), observed: string[] = [];
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      if (String(args[0]).includes(".audit-tmp-")) {
        const write = handle.writeFile.bind(handle);
        vi.spyOn(handle, "writeFile").mockImplementation(async (...writeArgs) => {
          expect((await handle.stat()).size).toBe(0);
          observed.push(await windowsAcl("inspect", String(args[0])));
          expect(observed.at(-1)).toBe(expected);
          return write(...writeArgs);
        });
      }
      return handle;
    });
    await appendAuditEvent(cwd, event("three"));
    expect(await windowsAcl("inspect", log(cwd))).toBe(expected);
    const result = await retainAuditEvents(cwd, 1);
    expect(await windowsAcl("inspect", result.archivePath!)).toBe(expected);
    expect(await windowsAcl("inspect", log(cwd))).toBe(expected);
    expect(observed).toHaveLength(3);
    await expect(verifyAuditIntegrity(cwd)).resolves.toMatchObject({ valid: true, checked: 1 });
  }, 15000);

  it.skipIf(process.platform !== "win32")("does not bypass an existing file write denial through parent rename permission", async () => {
    const cwd = await fixture(); await appendAuditEvent(cwd, event("seed"));
    const before = await fs.readFile(log(cwd));
    const expected = await windowsAcl("deny-write", log(cwd));
    await expect(appendAuditEvent(cwd, event("blocked"))).rejects.toThrow("AUDIT_STORAGE_UNAVAILABLE");
    expect(await fs.readFile(log(cwd))).toEqual(before);
    expect(await windowsAcl("inspect", log(cwd))).toBe(expected);
  });

  it.skipIf(process.platform !== "win32")("fails closed and releases its lock if Windows access preservation is unavailable", async () => {
    const cwd = await fixture(); await appendAuditEvent(cwd, event("seed"));
    const before = await fs.readFile(log(cwd));
    const original = fs.lstat.bind(fs);
    const unavailable = vi.spyOn(fs, "lstat").mockImplementation((...args) => {
      if (String(args[0]).endsWith("lmti-audit-acl.exe")) return Promise.reject(Object.assign(new Error("synthetic"), { code: "ENOENT" }));
      return original(...args);
    });
    await expect(appendAuditEvent(cwd, event("blocked"))).rejects.toThrow("AUDIT_ACCESS_PRESERVATION_FAILED");
    unavailable.mockRestore();
    expect(await fs.readFile(log(cwd))).toEqual(before);
    expect((await fs.readdir(path.dirname(log(cwd)))).some(name => name.startsWith(".audit-tmp-"))).toBe(false);
    await appendAuditEvent(cwd, event("after"));
    await expect(verifyAuditIntegrity(cwd)).resolves.toMatchObject({ valid: true, checked: 2 });
  });

  it.skipIf(process.platform === "win32")("creates private POSIX files and permits read-only inspection of legacy broad modes", async () => {
    const cwd = await fixture();
    await appendAuditEvent(cwd, event("seed"));
    for (const name of [path.join(cwd, ".lmti"), path.join(cwd, ".lmti", "privacy")])
      expect((await fs.stat(name)).mode & 0o777).toBe(0o700);
    for (const name of [log(cwd), path.join(cwd, ".lmti", "privacy", ".audit-lock.sqlite")])
      expect((await fs.stat(name)).mode & 0o777).toBe(0o600);
    await fs.chmod(log(cwd), 0o644);
    await expect(verifyAuditIntegrity(cwd)).resolves.toMatchObject({ valid: true, checked: 1 });
    await expect(appendAuditEvent(cwd, event("blocked"))).rejects.toThrow("AUDIT_PRIVATE_PERMISSIONS_REQUIRED");
    expect((await fs.stat(log(cwd))).mode & 0o777).toBe(0o644);
    await fs.chmod(log(cwd), 0o600);
    await fs.chmod(path.join(cwd, ".lmti"), 0o755);
    await expect(verifyAuditIntegrity(cwd)).resolves.toMatchObject({ valid: true, checked: 1 });
    await expect(appendAuditEvent(cwd, event("blocked-directory"))).rejects.toThrow("AUDIT_PRIVATE_PERMISSIONS_REQUIRED");
    expect((await fs.stat(path.join(cwd, ".lmti"))).mode & 0o777).toBe(0o755);
  });
});
