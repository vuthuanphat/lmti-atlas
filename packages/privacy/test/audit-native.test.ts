import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { execFile, spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { auditHelperLocation, resolveAuditAclHelper } from "../src/audit-runtime.mts";

const fixtures: string[] = [];
async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lmti-acl-native-"));
  fixtures.push(directory); return directory;
}
afterEach(async () => {
  for (const directory of fixtures.splice(0)) {
    if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith("lmti-acl-native-")) throw new Error("FIXTURE_BOUNDARY");
    await fs.rm(directory, { recursive: true, force: true });
  }
});
function frame(source: string, target: string) {
  const left = Buffer.from(source), right = Buffer.from(target), header = Buffer.alloc(16);
  header.write("LMTIACL1"); header.writeUInt32LE(left.length, 8); header.writeUInt32LE(right.length, 12);
  return Buffer.concat([header, left, right]);
}
async function helper(input: Buffer, args = ["--copy-access-v1"]) {
  const executable = await resolveAuditAclHelper();
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timeout = setTimeout(() => { child.kill(); reject(new Error("HELPER_TIMEOUT")); }, 10000);
    child.stdout.on("data", bytes => { stdout += bytes.toString(); });
    child.stderr.on("data", bytes => { stderr += bytes.toString(); });
    child.stdin.on("error", () => {}); // Early protocol rejection may close stdin.
    child.once("error", reject);
    child.once("close", code => { clearTimeout(timeout); resolve({ code, stdout, stderr }); });
    child.stdin.end(input);
  });
}
async function aclFingerprint(filename: string): Promise<string> {
  const script = `$ErrorActionPreference='Stop';$s=[System.Security.AccessControl.AccessControlSections]::Access;$a=[System.IO.File]::GetAccessControl($env:LMTI_ACL_TEST_FILE,$s);$h=[System.Security.Cryptography.SHA256]::Create();[Console]::Out.Write([BitConverter]::ToString($h.ComputeHash([Text.Encoding]::UTF8.GetBytes($a.GetSecurityDescriptorSddlForm($s)))))`;
  return new Promise((resolve, reject) => execFile(path.join(process.env.SystemRoot || "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { windowsHide: true, timeout: 10000, maxBuffer: 4096, env: { ...process.env, LMTI_ACL_TEST_FILE: filename } },
    (error, output) => error ? reject(new Error("ACL_FIXTURE_FAILED")) : resolve(output)));
}

describe("audit helper location", () => {
  it("selects fixed source/dist and owner-bundle locations without cwd or executable env overrides", () => {
    const root = path.resolve("synthetic-runtime-root");
    for (const kind of ["src", "dist"]) {
      const found = auditHelperLocation(pathToFileURL(path.join(root, "packages/privacy", kind, "audit-runtime.mjs")).href);
      expect(found).toEqual({ root, parts: ["build", "audit-acl", "bin", "lmti-audit-acl.exe"] });
    }
    for (const owner of ["knowledge-owner", "mapping-owner"]) {
      expect(auditHelperLocation(pathToFileURL(path.join(root, "share/lmti", owner, "index.js")).href))
        .toEqual({ root, parts: ["bin", "lmti-audit-acl.exe"] });
    }
    expect(() => auditHelperLocation(pathToFileURL(path.join(root, "untrusted/index.js")).href)).toThrow("AUDIT_ACCESS_PRESERVATION_FAILED");
  });
});

describe.skipIf(process.platform !== "win32")("native audit ACL protocol", () => {
  it("rejects truncated/oversized/invalid-UTF8 frames and extra command arguments without diagnostic leaks", async () => {
    const invalidUtf8 = frame("x", "y"); invalidUtf8[16] = 0xff;
    for (const input of [Buffer.alloc(0), Buffer.from("LMTIACL1"), Buffer.alloc(131089), invalidUtf8]) {
      const result = await helper(input);
      expect(result).toEqual({ code: 1, stdout: "", stderr: "" });
    }
    expect(await helper(Buffer.alloc(0), ["--copy-access-v1", "extra"]))
      .toEqual({ code: 1, stdout: "", stderr: "" });
  });

  it("refuses an ancestor junction before changing outside ACLs or file bytes", async () => {
    const root = await fixture(), outside = await fixture();
    const privacy = path.join(root, ".lmti/privacy");
    await fs.mkdir(path.join(root, ".lmti"));
    const source = path.join(outside, "audit.jsonl"), tempName = ".audit-tmp-00000000-0000-0000-0000-000000000001";
    const target = path.join(outside, tempName);
    await fs.writeFile(source, "synthetic sentinel"); await fs.writeFile(target, "");
    const before = await Promise.all([aclFingerprint(source), aclFingerprint(target)]);
    await fs.symlink(outside, privacy, "junction");
    expect(await helper(frame(path.join(privacy, "audit.jsonl"), path.join(privacy, tempName))))
      .toEqual({ code: 1, stdout: "", stderr: "" });
    expect(await fs.readFile(source, "utf8")).toBe("synthetic sentinel");
    expect((await fs.stat(target)).size).toBe(0);
    expect(await Promise.all([aclFingerprint(source), aclFingerprint(target)])).toEqual(before);
  }, 15000);
});
