import path from "node:path";
import { CliUsageError, parseArgs, stringFlag } from "../arguments.js";
import { CliJsonEnvelope, CliStatus, createCliEnvelope, printSafeJson, printSafeText } from "../output.js";
import { GitStatusEntry, matchesBranchPattern, matchesProtectedPath, normalizeGitPath, normalizeRepoLocator, parseGitStatus, runGit, sanitizeRepoLocator, summarizeFileStates } from "../git.js";
import { isRecord, splitLines, stringArrayRecordValue, stringRecordValue, uniqueStrings } from "../values.js";
import { pathExists, readJsonFileIfExists } from "../files.js";

const DEFAULT_PUBLISH_TARGET_BRANCH = "main";

const DEFAULT_PUBLISH_ALLOWED_BRANCHES = ["main", "release/*", "publish/*", "publish-*"];

const DEFAULT_PRIVATE_REPO_PATTERNS = ["/atlas", "private", "internal"];

const DEFAULT_PROTECTED_PUBLISH_PATHS = [
  ".env",
  ".env.*",
  ".lmti/memory/*.sqlite",
  ".lmti/private/**",
  "**/secrets/**",
  "**/*.pem",
  "**/*.key",
  "**/*.p12",
  "**/*.pfx"
];

type PublishPreflightStatus = "pass" | "warn" | "error";

type PublishPreflightResultState = "pass" | "warning" | "blocked";

export interface PublishPreflightCheck {
  name: string;
  title: string;
  status: PublishPreflightStatus;
  message: string;
  fix?: string;
}

export interface PublishPreflightResult {
  command: "lmti publish preflight";
  result: PublishPreflightResultState;
  exitCode: 0 | 1 | 2;
  targetRepo?: string;
  currentOrigin?: string;
  currentBranch?: string;
  targetBranch: string;
  checks: PublishPreflightCheck[];
  next: string;
  configSources: string[];
}

interface PublishPreflightOptions {
  target?: string;
  strict?: boolean;
  publicRepo?: string;
}

interface PublishPreflightConfig {
  publicRepo?: string;
  privateRepoPatterns: string[];
  targetBranch: string;
  allowedPublishBranches: string[];
  protectedPaths: string[];
  sources: string[];
}

export async function runPublish(args: string[], cwd = process.cwd()): Promise<void> {
  const [subcommand, ...rest] = args;
  if (subcommand === "preflight" || subcommand === "check") {
    await runPublishPreflight(rest, cwd);
    return;
  }
  throw new CliUsageError("Usage: lmti publish <check|preflight> [--target main] [--json] [--strict] [--fix-suggest]");
}

export async function runPublishPreflight(args: string[], cwd = process.cwd()): Promise<void> {
  const { flags } = parseArgs(args, {
    "fix-suggest": "boolean",
    json: "boolean",
    strict: "boolean",
    target: "value"
  }, 0);
  const result = await publishPreflightCommand(cwd, {
    target: stringFlag(flags, "target"),
    strict: Boolean(flags.strict)
  });

  process.exitCode = result.exitCode;
  if (flags.json) {
    printSafeJson(createPublishEnvelope(result), "publish preflight");
    return;
  }
  printSafeText(formatPublishPreflight(result, { fixSuggest: Boolean(flags["fix-suggest"]) }));
}

export async function publishPreflightCommand(cwd: string, options: PublishPreflightOptions = {}): Promise<PublishPreflightResult> {
  // One invocation observes each metadata file once. Never retain this snapshot
  // across invocations: changed publish identity must be checked on the next run.
  const gitRootResult = runGit(cwd, ["rev-parse", "--show-toplevel"]);
  const repoRoot = gitRootResult.ok && gitRootResult.stdout.trim() ? gitRootResult.stdout.trim() : cwd;
  const [configJson, layer, packageJson] = await Promise.all([
    readJsonFileIfExists(path.join(repoRoot, ".lmti", "config.json")),
    readJsonFileIfExists(path.join(repoRoot, ".lmti", "layer.json")),
    readJsonFileIfExists(path.join(repoRoot, "package.json"))
  ]);
  const config = loadPublishPreflightConfig(options, configJson, layer, packageJson);
  const checks: PublishPreflightCheck[] = [];
  const targetBranch = options.target ?? config.targetBranch;
  const targetRef = `origin/${targetBranch}`;

  checks.push(
    config.publicRepo
      ? {
          name: "publish_target",
          title: "Publish target",
          status: "pass",
          message: `Configured target is ${sanitizeRepoLocator(config.publicRepo)}.`
        }
      : {
          name: "publish_target",
          title: "Publish target",
          status: "error",
          message: "No public publish repository is configured.",
          fix: "Add publish.publicRepo to .lmti/config.json, publish_repository to .lmti/layer.json, or repository.url to package.json."
        }
  );

  if (!gitRootResult.ok || !gitRootResult.stdout.trim()) {
    checks.push({
      name: "repository_identity",
      title: "Repository identity",
      status: "error",
      message: "Current directory is not inside a Git repository.",
      fix: "Run the publish preflight from the repository root before opening a PR or publishing."
    });
    return finalizePublishPreflight({
      checks,
      config,
      targetBranch,
      strict: Boolean(options.strict)
    });
  }

  const identity = readPublishIdentity(layer, packageJson);
  checks.push(createRepositoryIdentityCheck(identity, config.publicRepo));

  const originResult = runGit(repoRoot, ["remote", "get-url", "origin"]);
  const currentOrigin = originResult.ok ? originResult.stdout.trim() : undefined;
  checks.push(createRemoteOriginCheck(currentOrigin, config));

  const branchResult = runGit(repoRoot, ["branch", "--show-current"]);
  const currentBranch = branchResult.ok ? branchResult.stdout.trim() : undefined;
  checks.push(createBranchSafetyCheck(currentBranch, config.allowedPublishBranches));

  const targetExists = runGit(repoRoot, ["rev-parse", "--verify", "--quiet", targetRef]);
  let hasCommonHistory = false;
  if (!targetExists.ok) {
    checks.push({
      name: "git_history",
      title: "Git history",
      status: "error",
      message: `Target ref ${targetRef} was not found locally.`,
      fix: `Fetch the target branch first, then run lmti publish preflight --target ${targetBranch} again.`
    });
  } else {
    const mergeBase = runGit(repoRoot, ["merge-base", "HEAD", targetRef]);
    hasCommonHistory = mergeBase.ok && mergeBase.stdout.trim().length > 0;
    checks.push(
      hasCommonHistory
        ? {
            name: "git_history",
            title: "Git history",
            status: "pass",
            message: `Branch shares history with ${targetRef}.`
          }
        : {
            name: "git_history",
            title: "Git history",
            status: "error",
            message: `Current branch does not share Git history with ${targetRef}. This may create a PR with entirely different commit histories.`,
            fix: `Recreate the branch from ${targetRef}, then cherry-pick or re-apply only the intended publish commits.`
          }
    );
  }

  checks.push(createDivergenceCheck(repoRoot, targetRef, hasCommonHistory));

  const statusResult = runGit(repoRoot, ["status", "--porcelain=v1"]);
  const statusEntries = statusResult.ok ? parseGitStatus(statusResult.stdout) : [];
  checks.push(createWorkingTreeCheck(statusResult.ok, statusEntries));

  const trackedFilesResult = runGit(repoRoot, ["ls-files"]);
  const trackedFiles = trackedFilesResult.ok ? splitLines(trackedFilesResult.stdout) : [];
  checks.push(trackedFilesResult.ok ? createProtectedFilesCheck(statusEntries, trackedFiles, config.protectedPaths) : {
    name: "protected_files",
    title: "Protected files",
    status: "error",
    message: "Could not inspect Git tracked files.",
    fix: "Resolve Git errors and rerun publish preflight before publishing."
  });

  checks.push(createPackageMetadataCheck(packageJson));
  checks.push(await createOpenSourceDocsCheck(repoRoot));
  checks.push(await createLmtiIdentityCheck(repoRoot, layer));

  return finalizePublishPreflight({
    checks,
    config,
    targetBranch,
    currentOrigin,
    currentBranch,
    strict: Boolean(options.strict)
  });
}

function finalizePublishPreflight(input: {
  checks: PublishPreflightCheck[];
  config: PublishPreflightConfig;
  targetBranch: string;
  currentOrigin?: string;
  currentBranch?: string;
  strict: boolean;
}): PublishPreflightResult {
  const checks = input.strict
    ? input.checks.map((check) => (check.status === "warn" ? { ...check, status: "error" as const, message: `Strict mode: ${check.message}` } : check))
    : input.checks;
  const hasError = checks.some((check) => check.status === "error");
  const hasWarn = checks.some((check) => check.status === "warn");
  const result: PublishPreflightResultState = hasError ? "blocked" : hasWarn ? "warning" : "pass";
  const exitCode: 0 | 1 | 2 = hasError ? 2 : hasWarn ? 1 : 0;
  return {
    command: "lmti publish preflight",
    result,
    exitCode,
    targetRepo: input.config.publicRepo ? sanitizeRepoLocator(input.config.publicRepo) : undefined,
    currentOrigin: input.currentOrigin ? sanitizeRepoLocator(input.currentOrigin) : undefined,
    currentBranch: input.currentBranch,
    targetBranch: input.targetBranch,
    checks,
    next: result === "blocked"
      ? "Stop. Do not push, publish, open a PR, or change remotes until the ERROR items are resolved."
      : result === "warning"
        ? "Review warning items before opening the PR or publishing."
        : "Safe to continue with the publish/PR flow.",
    configSources: input.config.sources
  };
}

function formatPublishPreflight(result: PublishPreflightResult, options: { fixSuggest?: boolean } = {}): string {
  const lines = [
    "LMTI Publish Preflight",
    "",
    `Target repo: ${result.targetRepo ?? "(missing)"}`,
    `Current origin: ${result.currentOrigin ?? "(missing)"}`,
    `Current branch: ${result.currentBranch ?? "(detached or unknown)"}`,
    `Target branch: ${result.targetBranch}`,
    "",
    "| Check | Status | Detail |",
    "|---|---|---|",
    ...result.checks.map((check) => `| ${check.title} | ${check.status.toUpperCase()} | ${check.message.replace(/\|/g, "\\|")} |`),
    "",
    `Result: ${result.result === "warning" ? "PASS WITH WARNINGS" : result.result.toUpperCase()}`,
    `Next: ${result.next}`
  ];

  const fixes = Array.from(new Set(result.checks.filter((check) => check.status !== "pass" && check.fix).map((check) => check.fix as string)));
  if ((options.fixSuggest || result.result === "blocked") && fixes.length > 0) {
    lines.push("", "Fix:");
    fixes.forEach((fix, index) => {
      lines.push(`${index + 1}. ${fix}`);
    });
  }
  return lines.join("\n");
}

function createPublishEnvelope(result: PublishPreflightResult): CliJsonEnvelope {
  return createCliEnvelope(
    "lmti.publish.preflight",
    publishResultToCliStatus(result.result),
    result.checks
      .filter((check) => check.status === "warn")
      .map((check) => ({ code: publishCheckCode(check), message: check.message, suggestion: check.fix })),
    result.checks
      .filter((check) => check.status === "error")
      .map((check) => ({ code: publishCheckCode(check), message: check.message, suggestion: check.fix })),
    result
  );
}

function publishCheckCode(check: PublishPreflightCheck): string {
  switch (check.name) {
    case "publish_target":
      return "PUBLISH_TARGET_MISSING";
    case "remote_origin":
      return "REMOTE_ORIGIN_MISMATCH";
    case "git_history":
      return "GIT_HISTORY_NO_COMMON_ANCESTOR";
    case "branch_safety":
      return "BRANCH_NOT_ALLOWED";
    case "dirty_working_tree":
      return "WORKING_TREE_DIRTY";
    case "protected_files":
      return "PROTECTED_FILE_DETECTED";
    case "open_source_docs":
      return "PUBLISH_TARGET_MISSING";
    case "package_metadata":
      return "CONFIG_INVALID";
    default:
      return check.status === "error" ? "UNKNOWN_ERROR" : "CONFIG_INVALID";
  }
}

function loadPublishPreflightConfig(options: PublishPreflightOptions, configJson: unknown, layer: unknown, packageJson: unknown): PublishPreflightConfig {
  const sources: string[] = [];
  const configPublish = getPublishBlock(configJson);
  const layerPublicRepo = stringRecordValue(layer, "publish_repository");
  const packageRepo = packageRepositoryUrl(packageJson);

  let publicRepo = options.publicRepo;
  if (publicRepo) {
    sources.push("option.publicRepo");
  }
  if (!publicRepo && configPublish.publicRepo) {
    publicRepo = configPublish.publicRepo;
    sources.push(".lmti/config.json:publish.publicRepo");
  }
  if (!publicRepo && layerPublicRepo) {
    publicRepo = layerPublicRepo;
    sources.push(".lmti/layer.json:publish_repository");
  }
  if (!publicRepo && packageRepo) {
    publicRepo = packageRepo;
    sources.push("package.json:repository.url");
  }

  return {
    publicRepo,
    privateRepoPatterns: uniqueStrings([...DEFAULT_PRIVATE_REPO_PATTERNS, ...configPublish.privateRepoPatterns]),
    targetBranch: configPublish.targetBranch ?? DEFAULT_PUBLISH_TARGET_BRANCH,
    allowedPublishBranches: configPublish.allowedPublishBranches.length > 0 ? configPublish.allowedPublishBranches : DEFAULT_PUBLISH_ALLOWED_BRANCHES,
    protectedPaths: configPublish.protectedPaths.length > 0 ? configPublish.protectedPaths : DEFAULT_PROTECTED_PUBLISH_PATHS,
    sources
  };
}

function readPublishIdentity(layer: unknown, packageJson: unknown): { declaredRepos: string[]; sources: string[] } {
  const declaredRepos: string[] = [];
  const sources: string[] = [];
  const layerRepo = stringRecordValue(layer, "publish_repository");
  const packageRepo = packageRepositoryUrl(packageJson);
  if (layerRepo) {
    declaredRepos.push(layerRepo);
    sources.push(".lmti/layer.json:publish_repository");
  }
  if (packageRepo) {
    declaredRepos.push(packageRepo);
    sources.push("package.json:repository.url");
  }
  return { declaredRepos, sources };
}

function createRepositoryIdentityCheck(identity: { declaredRepos: string[]; sources: string[] }, publicRepo?: string): PublishPreflightCheck {
  if (!publicRepo) {
    return {
      name: "repository_identity",
      title: "Repository identity",
      status: "error",
      message: "Repository identity cannot be verified without a publish target.",
      fix: "Declare the public LMTI publish repository before creating a public PR or release."
    };
  }
  if (identity.declaredRepos.length === 0) {
    return {
      name: "repository_identity",
      title: "Repository identity",
      status: "warn",
      message: "No repository identity metadata was found in .lmti/layer.json or package.json.",
      fix: "Add publish_repository to .lmti/layer.json or repository.url to package.json."
    };
  }
  const target = normalizeRepoLocator(publicRepo);
  const matches = identity.declaredRepos.some((repo) => normalizeRepoLocator(repo) === target);
  return matches
    ? {
        name: "repository_identity",
        title: "Repository identity",
        status: "pass",
        message: `Repository metadata matches publish target via ${identity.sources.join(", ")}.`
      }
    : {
        name: "repository_identity",
        title: "Repository identity",
        status: "error",
        message: "Repository metadata does not match the configured publish target.",
        fix: "Fix repository metadata before publishing so agents do not confuse private/internal and public repository identity."
      };
}

function createRemoteOriginCheck(currentOrigin: string | undefined, config: PublishPreflightConfig): PublishPreflightCheck {
  if (!currentOrigin) {
    return {
      name: "remote_origin",
      title: "Remote origin",
      status: "error",
      message: "Git remote origin is missing.",
      fix: "Add the correct public origin remote or run from a clone that has origin configured."
    };
  }
  if (!config.publicRepo) {
    return {
      name: "remote_origin",
      title: "Remote origin",
      status: "error",
      message: "Origin cannot be verified because no publish target is configured.",
      fix: "Declare publish.publicRepo before pushing or opening a public PR."
    };
  }
  const normalizedOrigin = normalizeRepoLocator(currentOrigin);
  const normalizedTarget = normalizeRepoLocator(config.publicRepo);
  if (normalizedOrigin === normalizedTarget) {
    return {
      name: "remote_origin",
      title: "Remote origin",
      status: "pass",
      message: "Origin matches configured public repo."
    };
  }
  const matchedPrivatePattern = config.privateRepoPatterns.find((pattern) => normalizedOrigin.includes(pattern.toLowerCase()));
  return {
    name: "remote_origin",
    title: "Remote origin",
    status: "error",
    message: matchedPrivatePattern
      ? `Origin appears to point at a private/internal or legacy repo pattern (${matchedPrivatePattern}) instead of the publish target.`
      : "Origin does not match the configured public publish repo.",
    fix: "Confirm the intended public repo remote. Do not change remotes automatically; ask the owner to approve the safe recovery path."
  };
}

function createBranchSafetyCheck(currentBranch: string | undefined, allowedBranches: string[]): PublishPreflightCheck {
  if (!currentBranch) {
    return {
      name: "branch_safety",
      title: "Branch safety",
      status: "error",
      message: "Current checkout is detached or branch name could not be resolved.",
      fix: "Checkout a named publish branch created from the target branch before publishing."
    };
  }
  if (allowedBranches.some((pattern) => matchesBranchPattern(currentBranch, pattern))) {
    return {
      name: "branch_safety",
      title: "Branch safety",
      status: "pass",
      message: `Branch ${currentBranch} matches allowed publish patterns.`
    };
  }
  return {
    name: "branch_safety",
    title: "Branch safety",
    status: "warn",
    message: `Branch ${currentBranch} does not match allowed publish patterns: ${allowedBranches.join(", ")}.`,
    fix: "Use main, release/*, publish/*, or a configured publish branch pattern for public PR/release work."
  };
}

function createDivergenceCheck(cwd: string, targetRef: string, hasCommonHistory: boolean): PublishPreflightCheck {
  if (!hasCommonHistory) {
    return {
      name: "commit_divergence",
      title: "Branch divergence",
      status: "error",
      message: `Cannot compute ahead/behind because HEAD has no common ancestor with ${targetRef}.`,
      fix: `Recreate the branch from ${targetRef} before opening a PR.`
    };
  }
  const divergence = runGit(cwd, ["rev-list", "--left-right", "--count", `HEAD...${targetRef}`]);
  if (!divergence.ok) {
    return {
      name: "commit_divergence",
      title: "Branch divergence",
      status: "error",
      message: `Could not compute ahead/behind against ${targetRef}.`,
      fix: "Fetch the target branch and rerun publish preflight."
    };
  }
  const [aheadText, behindText] = divergence.stdout.trim().split(/\s+/u);
  const ahead = Number(aheadText ?? "0");
  const behind = Number(behindText ?? "0");
  if (ahead === 0 && behind === 0) {
    return {
      name: "commit_divergence",
      title: "Branch divergence",
      status: "pass",
      message: `Ahead 0 commits, behind 0 commits against ${targetRef}.`
    };
  }
  return {
    name: "commit_divergence",
    title: "Branch divergence",
    status: "warn",
    message: `Ahead ${Number.isFinite(ahead) ? ahead : 0} commits, behind ${Number.isFinite(behind) ? behind : 0} commits against ${targetRef}.`,
    fix: "Review divergence before publishing. Rebase/merge only after owner-approved branch hygiene for the release or PR flow."
  };
}

function createWorkingTreeCheck(statusOk: boolean, statusEntries: GitStatusEntry[]): PublishPreflightCheck {
  if (!statusOk) {
    return {
      name: "dirty_working_tree",
      title: "Working tree",
      status: "error",
      message: "Could not inspect Git working tree status.",
      fix: "Run git status locally, resolve Git errors, and rerun publish preflight."
    };
  }
  if (statusEntries.length === 0) {
    return {
      name: "dirty_working_tree",
      title: "Working tree",
      status: "pass",
      message: "No uncommitted changes."
    };
  }
  const states = summarizeFileStates(statusEntries);
  return {
    name: "dirty_working_tree",
    title: "Working tree",
    status: "warn",
    message: `${statusEntries.length} changed path(s): ${states}.`,
    fix: "Commit, stash, or intentionally remove local changes before publishing."
  };
}

function createProtectedFilesCheck(statusEntries: GitStatusEntry[], trackedFiles: string[], protectedPaths: string[]): PublishPreflightCheck {
  const stateByPath = new Map<string, string>();
  for (const entry of statusEntries) {
    stateByPath.set(normalizeGitPath(entry.path), entry.state);
  }
  for (const file of trackedFiles) {
    const normalized = normalizeGitPath(file);
    if (!stateByPath.has(normalized)) {
      stateByPath.set(normalized, "tracked");
    }
  }

  const protectedMatches = Array.from(stateByPath.entries())
    .filter(([file]) => protectedPaths.some((pattern) => matchesProtectedPath(file, pattern)))
    .map(([file, state]) => `${file} (${state})`);

  if (protectedMatches.length === 0) {
    return {
      name: "protected_files",
      title: "Protected files",
      status: "pass",
      message: "No protected files detected in tracked, staged, unstaged, or untracked paths."
    };
  }
  return {
    name: "protected_files",
    title: "Protected files",
    status: "error",
    message: `Protected path(s) detected: ${protectedMatches.join(", ")}.`,
    fix: "Remove protected files from the publish branch and keep secrets/private memory out of Git before publishing."
  };
}

async function createLmtiIdentityCheck(cwd: string, layer: unknown): Promise<PublishPreflightCheck> {
  if (isRecord(layer) && layer.type === "independent_agent_layer") {
    return {
      name: "lmti_layer_identity",
      title: "LMTI layer identity",
      status: "pass",
      message: "LMTI detected as an independent agent memory/context layer."
    };
  }
  if (await pathExists(path.join(cwd, ".lmti"))) {
    return {
      name: "lmti_layer_identity",
      title: "LMTI layer identity",
      status: "warn",
      message: ".lmti exists but layer identity metadata is missing or incomplete.",
      fix: "Add .lmti/layer.json metadata that states LMTI is an independent layer, not application runtime."
    };
  }
  return {
    name: "lmti_layer_identity",
    title: "LMTI layer identity",
    status: "warn",
    message: "No .lmti layer metadata was found; independent LMTI boundary could not be verified.",
    fix: "Initialize or attach LMTI metadata before publishing the LMTI repository."
  };
}

function createPackageMetadataCheck(packageJson: unknown): PublishPreflightCheck {
  if (!isRecord(packageJson)) {
    return {
      name: "package_metadata",
      title: "Package metadata",
      status: "warn",
      message: "package.json was not found; package metadata could not be checked.",
      fix: "Add package metadata or document why this repository is not package-distributed."
    };
  }
  const missing: string[] = [];
  if (!stringRecordValue(packageJson, "description")) {
    missing.push("description");
  }
  if (!packageRepositoryUrl(packageJson)) {
    missing.push("repository");
  }
  if (!stringRecordValue(packageJson, "author")) {
    missing.push("author");
  }
  if (!stringRecordValue(packageJson, "license")) {
    missing.push("license");
  }
  return missing.length === 0
    ? {
        name: "package_metadata",
        title: "Package metadata",
        status: "pass",
        message: "Package metadata includes description, repository, author, and license."
      }
    : {
        name: "package_metadata",
        title: "Package metadata",
        status: "warn",
        message: `Package metadata is missing: ${missing.join(", ")}.`,
        fix: "Complete package metadata before public release; license may remain pending only before final public publish."
      };
}

async function createOpenSourceDocsCheck(cwd: string): Promise<PublishPreflightCheck> {
  const required = ["README.md", "LICENSE", "SECURITY.md"];
  const missing: string[] = [];
  for (const fileName of required) {
    if (!(await pathExists(path.join(cwd, fileName)))) {
      missing.push(fileName);
    }
  }
  return missing.length === 0
    ? {
        name: "open_source_docs",
        title: "Open-source docs",
        status: "pass",
        message: "README, LICENSE, and SECURITY files are present."
      }
    : {
        name: "open_source_docs",
        title: "Open-source docs",
        status: "error",
        message: `Missing required public release document(s): ${missing.join(", ")}.`,
        fix: "Add README, LICENSE, and SECURITY before public release or PR publication."
      };
}

function getPublishBlock(value: unknown): {
  publicRepo?: string;
  privateRepoPatterns: string[];
  targetBranch?: string;
  allowedPublishBranches: string[];
  protectedPaths: string[];
} {
  const publish = isRecord(value) && isRecord(value.publish) ? value.publish : undefined;
  return {
    publicRepo: stringRecordValue(publish, "publicRepo"),
    privateRepoPatterns: stringArrayRecordValue(publish, "privateRepoPatterns"),
    targetBranch: stringRecordValue(publish, "targetBranch"),
    allowedPublishBranches: stringArrayRecordValue(publish, "allowedPublishBranches"),
    protectedPaths: stringArrayRecordValue(publish, "protectedPaths")
  };
}

function packageRepositoryUrl(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (typeof value.repository === "string") {
    return value.repository;
  }
  if (isRecord(value.repository)) {
    return stringRecordValue(value.repository, "url");
  }
  return undefined;
}

function publishResultToCliStatus(status: PublishPreflightResultState): CliStatus {
  return status === "warning" ? "warn" : status;
}
