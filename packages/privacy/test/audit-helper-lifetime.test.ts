import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appendAuditEvent, verifyAuditIntegrity } from "../src/audit";

vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(), spawn: vi.fn()
}));
const fixtures: string[] = [];
const event = (recordId: string) => ({ action: "test.helper", recordId, sensitivity: "public" as const,
  role: "developer" as const, decision: "allow" as const, command: "test", reason: "synthetic" });
async function fixture() {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lmti-acl-lifetime-")); fixtures.push(cwd);
  await appendAuditEvent(cwd, event("seed"));
  const log = path.join(cwd, ".lmti/privacy/audit.jsonl");
  return { cwd, log, before: await fs.readFile(log) };
}
function childFixture() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true)
  });
  let admitted!: () => void;
  const ready = new Promise<void>(resolve => { admitted = resolve; });
  vi.mocked(spawn).mockImplementationOnce(() => { admitted(); return child as unknown as ChildProcess; });
  return { child, ready };
}
afterEach(async () => {
  vi.useRealTimers(); vi.mocked(spawn).mockReset();
  for (const directory of fixtures.splice(0)) {
    if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith("lmti-acl-lifetime-")) throw new Error("FIXTURE_BOUNDARY");
    await fs.rm(directory, { recursive: true, force: true });
  }
});

describe.skipIf(process.platform !== "win32")("audit helper child lifetime", () => {
  it("kills a timed-out helper and retains ownership until its close event", async () => {
    const { cwd, log, before } = await fixture(), { child, ready } = childFixture();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let settled = false;
    const writing = appendAuditEvent(cwd, event("timeout"));
    void writing.then(() => { settled = true; }, () => { settled = true; });
    await ready;
    await vi.advanceTimersByTimeAsync(10000);
    expect(child.kill).toHaveBeenCalledOnce(); expect(settled).toBe(false);
    child.emit("close", null);
    await expect(writing).rejects.toThrow("AUDIT_ACCESS_PRESERVATION_FAILED");
    expect(await fs.readFile(log)).toEqual(before);
    await expect(verifyAuditIntegrity(cwd)).resolves.toMatchObject({ valid: true, checked: 1 });
  });

  it("bounds combined helper output and still waits for close before cleanup", async () => {
    const { cwd, log, before } = await fixture(), { child, ready } = childFixture();
    const writing = appendAuditEvent(cwd, event("overflow"));
    await ready;
    child.stdout.write(Buffer.alloc(2048)); child.stderr.write(Buffer.alloc(2049));
    expect(child.kill).toHaveBeenCalledOnce();
    child.emit("close", 1);
    await expect(writing).rejects.toThrow("AUDIT_ACCESS_PRESERVATION_FAILED");
    expect(await fs.readFile(log)).toEqual(before);
    expect((await fs.readdir(path.dirname(log))).filter(name => name.startsWith(".audit-tmp-"))).toEqual([]);
  });

  it("redacts launch failures and requires the exact success response", async () => {
    const { cwd, log, before } = await fixture();
    for (const mode of ["error", "extra-response"]) {
      const { child, ready } = childFixture(), writing = appendAuditEvent(cwd, event(mode));
      await ready;
      if (mode === "error") child.emit("error", new Error("synthetic private diagnostic"));
      else child.stdout.write("ok-extra");
      child.emit("close", mode === "error" ? 1 : 0);
      await expect(writing).rejects.toThrow(/^AUDIT_ACCESS_PRESERVATION_FAILED$/);
      expect(await fs.readFile(log)).toEqual(before);
    }
  });
});
