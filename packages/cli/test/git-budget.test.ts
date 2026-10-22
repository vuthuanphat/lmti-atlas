import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { runGit } from "../src/git.js";

vi.mock("node:child_process", () => ({spawnSync: vi.fn()}));
afterEach(() => vi.resetAllMocks());

describe("bounded Git reads", () => {
  it("sets a finite subprocess/output budget and retains successful stdout", () => {
    vi.mocked(spawnSync).mockReturnValue({status: 0, stdout: "main\n", stderr: "", pid: 1, signal: null, output: []});
    expect(runGit("fixture", ["branch", "--show-current"])).toEqual({ok: true, stdout: "main\n", stderr: "", exitCode: 0});
    expect(spawnSync).toHaveBeenCalledWith("git", ["branch", "--show-current"], expect.objectContaining({
      cwd: "fixture", shell: false, windowsHide: true, timeout: 10000, maxBuffer: 1024*1024
    }));
  });

  it.each(["timeout", "exit", "output"])('discards partial output and sensitive diagnostics after %s failure', kind => {
    const sensitive = "https://fixture-credential@example.test/private";
    vi.mocked(spawnSync).mockReturnValue({status: kind === "exit" ? 1 : null,
      stdout: sensitive, stderr: sensitive, error: kind === "exit" ? undefined : new Error(sensitive),
      pid: 1, signal: null, output: []});
    const result = runGit("fixture", ["ls-files"]);
    expect(result.ok).toBe(false);expect(result.stdout).toBe("");
    expect(JSON.stringify(result)).not.toContain(sensitive);
    expect(result.stderr).toBe("Git command failed or exceeded its execution budget.");
    expect(result.exitCode).toBe(1);
  });
});
