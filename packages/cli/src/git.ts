import { spawnSync } from "node:child_process";
import path from "node:path";
import { escapeRegExp } from "./files.js";

interface GitCommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface GitStatusEntry {
  path: string;
  state: string;
}

export function runGit(cwd: string, args: string[]): GitCommandResult {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    windowsHide: true,
    timeout: 10000,
    maxBuffer: 1024 * 1024
  });
  const exitCode = typeof result.status === "number" ? result.status : 1;
  const ok = exitCode === 0 && !result.error;
  return {
    ok,
    // Failed commands can contain partial inventory or credential-bearing URLs.
    // Callers only consume successful output; errors keep the existing fixed checks.
    stdout: ok ? String(result.stdout ?? "") : "",
    stderr: ok ? "" : "Git command failed or exceeded its execution budget.",
    exitCode
  };
}

export function parseGitStatus(output: string): GitStatusEntry[] {
  const entries: GitStatusEntry[] = [];
  for (const line of output.split(/\r?\n/u).filter((entry) => entry.length > 0)) {
    if (line.startsWith("?? ")) {
      entries.push({ path: line.slice(3), state: "untracked" });
      continue;
    }
    const indexStatus = line[0] ?? " ";
    const workTreeStatus = line[1] ?? " ";
    const rawPath = line.slice(3);
    const state = indexStatus !== " " && workTreeStatus !== " " ? "staged+unstaged" : indexStatus !== " " ? "staged" : "unstaged";
    for (const filePath of rawPath.split(" -> ")) {
      if (filePath.trim()) {
        entries.push({ path: filePath.trim(), state });
      }
    }
  }
  return entries;
}

export function summarizeFileStates(entries: GitStatusEntry[]): string {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    counts.set(entry.state, (counts.get(entry.state) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([state, count]) => `${state}=${count}`)
    .join(", ");
}

export function matchesBranchPattern(branch: string, pattern: string): boolean {
  if (pattern === branch) {
    return true;
  }
  if (!pattern.includes("*")) {
    return false;
  }
  return globPatternToRegExp(pattern).test(branch);
}

export function matchesProtectedPath(filePath: string, pattern: string): boolean {
  return globPatternToRegExp(normalizeGitPath(pattern)).test(normalizeGitPath(filePath));
}

function globPatternToRegExp(pattern: string): RegExp {
  const normalized = normalizeGitPath(pattern);
  let source = "";
  for (let index = 0; index < normalized.length; index += 1) {
    if (normalized.startsWith("**/", index)) {
      source += "(?:.*/)?";
      index += 2;
      continue;
    }
    if (normalized.startsWith("**", index)) {
      source += ".*";
      index += 1;
      continue;
    }
    const char = normalized[index];
    source += char === "*" ? "[^/]*" : escapeRegExp(char);
  }
  return new RegExp(`^${source}$`, "iu");
}

export function normalizeGitPath(filePath: string): string {
  return filePath.replace(/^"|"$/gu, "").replace(/\\/g, "/").replace(/^\.\//u, "");
}

export function normalizeRepoLocator(locator: string): string {
  let normalized = locator.trim().replace(/^git\+/iu, "");
  normalized = normalized.replace(/^(https?:\/\/)[^/@\s]+@/iu, "$1");
  const sshMatch = normalized.match(/^git@([^:]+):(.+)$/iu);
  if (sshMatch) {
    normalized = `https://${sshMatch[1]}/${sshMatch[2]}`;
  }
  normalized = normalized.replace(/\\/g, "/").replace(/\.git$/iu, "").replace(/\/+$/u, "");
  if (!/^[a-z][a-z0-9+.-]*:\/\//iu.test(normalized)) {
    normalized = path.resolve(normalized).replace(/\\/g, "/").replace(/\.git$/iu, "").replace(/\/+$/u, "");
  }
  return normalized.toLowerCase();
}

export function sanitizeRepoLocator(locator: string): string {
  return locator.trim().replace(/^(https?:\/\/)[^/@\s]+@/iu, "$1[redacted]@").replace(/\.git$/iu, "");
}
