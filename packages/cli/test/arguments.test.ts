import { mkdtemp, mkdir, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CliUsageError, parseArgs } from "../src/arguments";
import { main } from "../src/index";

async function capture(args: string[], cwd: string) {
  const log = console.log, warn = console.warn, originalCode = process.exitCode;
  const stdout: string[] = [], stderr: string[] = [];
  console.log = (...values: unknown[]) => { stdout.push(values.map(String).join(" ")); };
  console.warn = (...values: unknown[]) => { stderr.push(values.map(String).join(" ")); };
  process.exitCode = undefined;
  try {
    await main(args, { cwd });
    return { stdout: stdout.join("\n"), stderr: stderr.join("\n"), code: process.exitCode ?? 0 };
  } finally {
    console.log = log; console.warn = warn; process.exitCode = originalCode;
  }
}

async function skillFixture() {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "lmti-cli-arguments-"));
  await mkdir(path.join(cwd, "skills", "publish"), { recursive: true });
  await writeFile(path.join(cwd, "skills", "registry.toml"), [
    "[[skills]]", 'id = "publish"', 'name = "Publish"',
    'description = "Check publication"', 'file = "skills/publish/SKILL.md"',
    'intents = ["publish"]', "requiresPolicy = true", "requiresMemory = false", 'riskLevel = "high"'
  ].join("\n"));
  await writeFile(path.join(cwd, "skills", "publish", "SKILL.md"), "# Publish\nCheck before publishing.\n");
  return cwd;
}

describe("typed CLI options", () => {
  it.each(["json", "yes", "fix", "strict", "dry-run", "include-secret", "include-raw", "force"])(
    "boolean --%s does not consume the following task", key => {
      expect(parseArgs([`--${key}`, "a task"], { [key]: "boolean" })).toEqual({
        positional: ["a task"], flags: { [key]: true }
      });
    }
  );

  it("stops option parsing at -- and preserves literal option-like task text", () => {
    expect(parseArgs(["--json", "--", "--unknown", "--json=false"], { json: "boolean" })).toEqual({
      positional: ["--unknown", "--json=false"], flags: { json: true }
    });
  });

  it("accepts separate and equals values, preserving the established last-value precedence", () => {
    expect(parseArgs(["--role", "developer", "--role=owner", "--json=false", "task"], { role: "value", json: "boolean" })).toEqual({
      positional: ["task"], flags: { role: "owner", json: false }
    });
    expect(parseArgs(["--title=--a-title"], { title: "value" }).flags.title).toBe("--a-title");
  });

  it.each([[], ["false"], ["true"], ["0"], ["no"]].map(values => ({ values })))("retains the explicit boolean-value grammar for memory reinforce $values", ({ values }) => {
    const result = parseArgs(["--success", ...values, "memory-id"], { success: "boolean-value" });
    expect(result.positional).toEqual(["memory-id"]);
    expect(result.flags.success).toBe(values.length === 0 || values[0] === "true");
  });

  it.each([
    ["--unknown"], ["--__proto__"], ["--constructor"], ["--title"],
    ["--title", "--json"], ["--title", "--"], ["--json=maybe"]
  ].map(args => ({ args })))("refuses unknown options or missing/invalid option values before execution: $args", ({ args }) => {
    expect(() => parseArgs(args, { title: "value", json: "boolean" })).toThrow(CliUsageError);
  });

  it("rejects unused positional values rather than silently performing a flag-only command", () => {
    expect(() => parseArgs(["--fix", "some-project"], { fix: "boolean" }, 0)).toThrow(CliUsageError);
  });
});

describe.sequential("CLI command boundary regressions", () => {
  it.each(["doctor", "check"])("%s uses identical failure exit status for text and JSON", async command => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "lmti-doctor-status-"));
    const text = await capture([command], cwd);
    const json = await capture([command, "--json"], cwd);
    expect(text.code).toBe(json.code);
    expect(text.code).toBeGreaterThan(0);
    expect(JSON.parse(json.stdout)).toMatchObject({ schemaVersion: "lmti.cli.v1", command: "lmti.doctor", status: "blocked" });
  });

  it.each(["doctor", "check"])("%s --security uses identical exit status for both output formats", async command => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "lmti-security-status-"));
    const jsonCwd = await mkdtemp(path.join(os.tmpdir(), "lmti-security-status-json-"));
    const text = await capture([command, "--security"], cwd);
    const json = await capture([command, "--security", "--json"], jsonCwd);
    const report = JSON.parse(text.stdout);
    expect(text.code).toBe(json.code);
    expect(text.code).toBe(report.status === "pass" ? 0 : report.status === "warn" ? 1 : 2);
    expect(JSON.parse(json.stdout).command).toBe("lmti.doctor.security");
  });

  it("route accepts --json before a task, with the same result as the trailing option", async () => {
    const cwd = await skillFixture();
    const before = await capture(["route", "--json", "publish the repository"], cwd);
    const after = await capture(["route", "publish the repository", "--json"], cwd);
    expect(JSON.parse(before.stdout)).toEqual(JSON.parse(after.stdout));
    expect(JSON.parse(before.stdout).data.request).toBe("publish the repository");
  });

  it("route passes a literal option-like request after --", async () => {
    const result = await capture(["route", "--json", "--", "--publish this change"], await skillFixture());
    expect(JSON.parse(result.stdout).data.request).toBe("--publish this change");
  });

  it("reports unknown options as INVALID_USAGE JSON before doctor --fix can create files", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "lmti-invalid-option-"));
    const result = await capture(["doctor", "--json", "--fix", "--jsoon"], cwd);
    expect(result.code).toBe(4);
    expect(JSON.parse(result.stdout)).toMatchObject({schemaVersion:"lmti.cli.v1",status:"error",errors:[{code:"INVALID_USAGE"}]});
    expect(await readdir(cwd)).toEqual([]);
  });

  it("rejects typo options before a mutating compile can create state", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "lmti-invalid-compile-"));
    await expect(capture(["compile", "--jsoon"], cwd)).rejects.toThrow(CliUsageError);
    expect(await readdir(cwd)).toEqual([]);
  });

  it("rejects malformed numeric options before a memory read initializes state", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "lmti-invalid-number-"));
    const original = process.cwd();
    let result;
    try {
      process.chdir(cwd);
      result = await capture(["memory", "search", "task", "--limit", "not-a-number", "--json"], cwd);
    } finally { process.chdir(original); }
    expect(result.code).toBe(4);
    expect(JSON.parse(result.stdout).errors[0].code).toBe("INVALID_USAGE");
    expect(await readdir(cwd)).toEqual([]);
  });

  it("retains the separate private-owner protocol instead of wrapping it in lmti.cli.v1", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "lmti-private-protocol-"));
    await expect(capture(["agent-context", "--json"], cwd)).rejects.toThrow("stdin only");
  });

  it.each([["help"], ["skill", "help"], ["thoth", "help"]].map(command => ({ command })))("does not silently accept typo options on help: $command", async ({ command }) => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "lmti-help-option-"));
    await expect(capture([...command, "--unknown"], cwd)).rejects.toThrow(CliUsageError);
  });
});
