import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as files from "../src/files.js";
import * as git from "../src/git.js";
import { publishPreflightCommand } from "../src/commands/publish.js";

const root = path.resolve("synthetic-publish-root");
const publicRepo = "https://example.test/public/lmti";
function setup() {
  let repository = publicRepo;
  const reads = vi.spyOn(files, "readJsonFileIfExists").mockImplementation(async file => {
    if (file === path.join(root, ".lmti/config.json")) return {};
    if (file === path.join(root, ".lmti/layer.json"))
      return { type: "independent_agent_layer", publish_repository: repository };
    if (file === path.join(root, "package.json"))
      return { description: "Synthetic test", repository: {url: repository}, author: "Fixture", license: "Apache-2.0" };
    throw new Error("Unexpected metadata path");
  });
  vi.spyOn(files, "pathExists").mockResolvedValue(true);
  const commands = vi.spyOn(git, "runGit").mockImplementation((_cwd, args) => {
    const key = args.join(" ");
    const stdout = key === "rev-parse --show-toplevel" ? root
      : key === "remote get-url origin" ? publicRepo
      : key === "branch --show-current" ? "main"
      : key === "rev-parse --verify --quiet origin/main" || key === "merge-base HEAD origin/main" ? "abc123"
      : key === "rev-list --left-right --count HEAD...origin/main" ? "0 0"
      : "";
    return {ok: true, stdout, stderr: "", exitCode: 0};
  });
  return {reads, commands, changeRepository(value: string) {repository = value;}};
}
afterEach(() => vi.restoreAllMocks());

describe("publish preflight metadata lifetime", () => {
  it("reads identity files once for one invocation and refreshes them on the next invocation", async () => {
    const f = setup();
    expect((await publishPreflightCommand(path.join(root, "nested"))).result).toBe("pass");
    expect(f.commands.mock.calls.filter(([, args]) => args.join(" ") === "rev-parse --show-toplevel")).toHaveLength(1);
    for (const relative of [".lmti/config.json", ".lmti/layer.json", "package.json"])
      expect(f.reads.mock.calls.filter(([file]) => file === path.join(root, relative))).toHaveLength(1);

    f.changeRepository("https://example.test/public/changed");
    const changed = await publishPreflightCommand(root, {publicRepo});
    expect(changed.result).toBe("blocked");
    expect(changed.checks.find(check => check.name === "repository_identity")?.status).toBe("error");
    for (const relative of [".lmti/config.json", ".lmti/layer.json", "package.json"])
      expect(f.reads.mock.calls.filter(([file]) => file === path.join(root, relative))).toHaveLength(2);
  });

  it("blocks when tracked-file inspection fails instead of treating partial inventory as clean", async () => {
    const f = setup(), original = f.commands.getMockImplementation()!;
    f.commands.mockImplementation((cwd, args) => args[0] === "ls-files"
      ? {ok: false, stdout: "", stderr: "fixed failure", exitCode: 1}
      : original(cwd, args));
    const result = await publishPreflightCommand(root);
    expect(result.result).toBe("blocked");
    expect(result.exitCode).toBe(2);
    expect(result.checks.find(check => check.name === "protected_files")?.status).toBe("error");
  });
});
