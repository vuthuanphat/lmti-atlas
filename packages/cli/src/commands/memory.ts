import type { NewMemoryRecord } from "@atlas/types";
import { createMemory, listMemory, searchProjectMemory, searchMemory, migrateJsonMemoryToProjectMemory, initProjectMemoryStorage, classifyLibraryMemory, addProjectMemory, retrieveMemoryForTask, getProjectMemoryStats, checkProjectMemoryPrivacy, retrieveMemoryContextForTask, consolidateMemory, decayMemoryLifecycle, reinforceMemory, reviewMemory, getMemoryAssociations, explainMemory, promoteMemory, deleteMemory } from "@atlas/memory";
import { inferIntent } from "@atlas/kernel";
import { runShortMemoryAdd, runShortMemoryCleanup, runShortMemoryEvaluate, runShortMemoryExpire, runShortMemoryPromote, runShortMemoryRetrieve } from "./memory-short.js";
import { runProjectMemoryLesson } from "./memory-lessons.js";
import { CliUsageError, optionalKind, optionalLibraryPrivacyLevel, optionalLibraryZone, optionalScope, parseArgs, parseBooleanFlag, parseConfidence, parseCsv, parseKind, parseLibraryZones, parseNowFlag, parseNumberFlag, parsePrivacyMode, parseRole, parseScope, parseSensitivity, stringFlag } from "../arguments.js";
import { detectProjectId, safeMemoryForCli, warnIfSensitive } from "./memory-records.js";
import { printCliEnvelope, printSafeJson } from "../output.js";
import { createCliPrivacyContext } from "../privacy-context.js";

export async function runMemory(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;

  switch (subcommand) {
    case "init":
      await runProjectMemoryInit(rest);
      return;
    case "add":
      await runMemoryAdd(rest);
      return;
    case "list":
      await runMemoryList(rest);
      return;
    case "search":
      await runMemorySearch(rest);
      return;
    case "retrieve":
      await runProjectMemoryRetrieve(rest);
      return;
    case "context":
      await runMemoryContext(rest);
      return;
    case "short:add":
      await runShortMemoryAdd(rest);
      return;
    case "short:search":
    case "short:retrieve":
      await runShortMemoryRetrieve(rest);
      return;
    case "short:expire":
      await runShortMemoryExpire(rest);
      return;
    case "short:cleanup":
      await runShortMemoryCleanup(rest);
      return;
    case "short:evaluate":
      await runShortMemoryEvaluate(rest);
      return;
    case "short:promote":
      await runShortMemoryPromote(rest);
      return;
    case "lesson":
      await runProjectMemoryLesson(rest);
      return;
    case "stats":
      parseArgs(rest, {  }, 0);
      await runProjectMemoryStats();
      return;
    case "privacy-check":
      parseArgs(rest, {  }, 0);
      await runProjectMemoryPrivacyCheck();
      return;
    case "migrate-json":
      await runProjectMemoryMigrateJson(rest);
      return;
    case "consolidate":
      await runMemoryConsolidate(rest);
      return;
    case "decay":
      await runMemoryDecay(rest);
      return;
    case "reinforce":
      await runMemoryReinforce(rest);
      return;
    case "review":
      await runMemoryReview(rest);
      return;
    case "associations":
      await runMemoryAssociations(rest);
      return;
    case "explain":
      await runMemoryExplain(rest);
      return;
    case "promote":
      await runMemoryPromote(rest);
      return;
    case "delete":
      await runMemoryDelete(rest);
      return;
    default:
      throw new CliUsageError("Usage: lmti memory <init|add|list|search|retrieve|context|short:add|short:retrieve|short:expire|short:cleanup|short:evaluate|short:promote|lesson|stats|privacy-check|migrate-json|consolidate|decay|reinforce|review|associations|explain|promote|delete>");
  }
}

async function runMemoryAdd(args: string[]): Promise<void> {
  const { flags } = parseArgs(args, {
    confidence: "value",
    content: "value",
    "expires-at": "value",
    importance: "value",
    kind: "value",
    legacy: "boolean",
    "privacy-level": "value",
    "project-id": "value",
    scope: "value",
    sensitivity: "value",
    source: "value",
    "source-refs": "value",
    "source-type": "value",
    tags: "value",
    title: "value",
    zone: "value"
  }, 0);
  if (!flags.legacy && !flags.scope) {
    await runProjectMemoryAdd(args);
    return;
  }

  const title = stringFlag(flags, "title");
  const content = stringFlag(flags, "content");

  if (!title || !content) {
    throw new CliUsageError('Usage: lmti memory add --scope <short_term|long_term> --kind <kind> --title "..." --content "..."');
  }

  const record: NewMemoryRecord = {
    scope: parseScope(stringFlag(flags, "scope") ?? "short_term"),
    kind: parseKind(stringFlag(flags, "kind") ?? "system_note"),
    title,
    content,
    projectId: stringFlag(flags, "project-id") ?? (await detectProjectId()),
    sourceRefs: parseCsv(stringFlag(flags, "source-refs")),
    tags: parseCsv(stringFlag(flags, "tags")),
    importance: parseNumberFlag(flags, "importance", 0.5),
    confidence: parseConfidence(stringFlag(flags, "confidence") ?? "medium"),
    sensitivity: parseSensitivity(stringFlag(flags, "sensitivity") ?? "internal"),
    expiresAt: stringFlag(flags, "expires-at")
  };

  const memory = await createMemory(record, { cwd: process.cwd() });
  warnIfSensitive(memory);
  printSafeJson(safeMemoryForCli(memory), "memory add");
}

async function runMemoryList(args: string[]): Promise<void> {
  const { flags } = parseArgs(args, {
    "include-raw": "boolean",
    "include-secret": "boolean",
    role: "value",
    scope: "value"
  }, 0);
  const scope = stringFlag(flags, "scope");
  const role = parseRole(stringFlag(flags, "role") ?? "developer");
  const memories = await listMemory(scope ? parseScope(scope) : undefined, {
    cwd: process.cwd(),
    privacyContext: createCliPrivacyContext(role, flags, "memory list", "list memory")
  });
  if (role !== "developer" || flags["include-secret"]) {
    console.warn(`[LMTI] Sensitive memory access requested as role=${role}. Policy enforcement applied.`);
  }
  printSafeJson(memories, "memory list");
}

async function runMemorySearch(args: string[]): Promise<void> {
  const { positional, flags } = parseArgs(args, {
    "include-raw": "boolean",
    "include-secret": "boolean",
    json: "boolean",
    kind: "value",
    legacy: "boolean",
    limit: "value",
    "privacy-mode": "value",
    role: "value",
    scope: "value",
    zone: "value",
    zones: "value"
  }, 1);
  const query = positional[0];
  if (!query) {
    throw new CliUsageError('Usage: lmti memory search "<query>" [--legacy] [--zone deployment,security]');
  }

  if (!flags.legacy) {
    const results = await searchProjectMemory(query, {
      cwd: process.cwd(),
      zones: parseLibraryZones(stringFlag(flags, "zone") ?? stringFlag(flags, "zones")),
      privacyMode: parsePrivacyMode(stringFlag(flags, "privacy-mode")),
      limit: parseNumberFlag(flags, "limit", 10)
    });
    if (flags.json) {
      printCliEnvelope("lmti.memory.search", "pass", [], [], { query, results });
      return;
    }
    printSafeJson(results, "memory search");
    return;
  }

  const results = await searchMemory(query, {
    cwd: process.cwd(),
    scope: optionalScope(stringFlag(flags, "scope")),
    kind: optionalKind(stringFlag(flags, "kind")),
    includeSecret: Boolean(flags["include-secret"]),
    privacyContext: createCliPrivacyContext(parseRole(stringFlag(flags, "role") ?? "developer"), flags, "memory search", "search memory"),
    limit: parseNumberFlag(flags, "limit", 20)
  });
  if (flags["include-secret"] || stringFlag(flags, "role")) {
    console.warn("[LMTI] Sensitive memory search requested. Policy enforcement applied.");
  }
  if (flags.json) {
    printCliEnvelope("lmti.memory.search", "pass", [], [], { query, results });
    return;
  }
  printSafeJson(results, "memory search");
}

async function runProjectMemoryInit(args: string[]): Promise<void> {
  const { flags } = parseArgs(args, { "dry-run": "boolean", "migrate-json": "boolean" }, 0);
  // Validate migration before opening/creating the target database.
  const migration = flags["migrate-json"] ? await migrateJsonMemoryToProjectMemory({ cwd: process.cwd(), dryRun: Boolean(flags["dry-run"]) }) : undefined;
  if (flags["dry-run"] && flags["migrate-json"]) {
    printSafeJson({ migration }, "memory init");
    return;
  }
  const storage = await initProjectMemoryStorage(process.cwd());
  printSafeJson({ ...storage, migration }, "memory init");
}

async function runProjectMemoryAdd(args: string[]): Promise<void> {
  const { flags } = parseArgs(args, {
    confidence: "value",
    content: "value",
    "expires-at": "value",
    importance: "value",
    "privacy-level": "value",
    source: "value",
    "source-type": "value",
    tags: "value",
    title: "value",
    zone: "value"
  }, 0);
  const title = stringFlag(flags, "title");
  const content = stringFlag(flags, "content");
  if (!content) {
    throw new CliUsageError('Usage: lmti memory add --title "..." --content "..." [--zone lesson] [--privacy-level internal]');
  }

  const memory = await (async () => {
    const classification = classifyLibraryMemory({
      title,
      content,
      source: stringFlag(flags, "source"),
      sourceType: stringFlag(flags, "source-type"),
      tags: parseCsv(stringFlag(flags, "tags"))
    });
    return {
      classification,
      item: await addProjectMemory(
        {
          title,
          content,
          source: stringFlag(flags, "source"),
          sourceType: stringFlag(flags, "source-type"),
          tags: parseCsv(stringFlag(flags, "tags")),
          zone: optionalLibraryZone(stringFlag(flags, "zone")),
          privacyLevel: optionalLibraryPrivacyLevel(stringFlag(flags, "privacy-level")),
          confidence: flags.confidence === undefined ? undefined : parseNumberFlag(flags, "confidence", classification.confidence),
          importance: flags.importance === undefined ? undefined : parseNumberFlag(flags, "importance", classification.importance),
          expiresAt: stringFlag(flags, "expires-at")
        },
        { cwd: process.cwd() }
      )
    };
  })();
  printSafeJson(memory, "memory add");
}

async function runProjectMemoryRetrieve(args: string[]): Promise<void> {
  const { positional, flags } = parseArgs(args, {
    intent: "value",
    json: "boolean",
    limit: "value",
    "privacy-mode": "value",
    zone: "value",
    zones: "value"
  }, 1);
  const task = stringFlag(flags, "intent") ?? positional[0];
  if (!task) {
    throw new CliUsageError('Usage: lmti memory retrieve "<task>" or lmti memory retrieve --intent <intent> [--zone deployment,security] [--limit 8]');
  }

  const results = await retrieveMemoryForTask(task, {
    cwd: process.cwd(),
    zones: parseLibraryZones(stringFlag(flags, "zone") ?? stringFlag(flags, "zones")),
    privacyMode: parsePrivacyMode(stringFlag(flags, "privacy-mode")),
    limit: parseNumberFlag(flags, "limit", 8)
  });
  if (flags.json) {
    printCliEnvelope("lmti.memory.retrieve", "pass", [], [], {
      intent: task,
      results,
      privacy: { secret: "blocked", doNotPrompt: "blocked" }
    });
    return;
  }
  printSafeJson(results, "memory retrieve");
}

async function runProjectMemoryStats(): Promise<void> {
  printSafeJson(await getProjectMemoryStats({ cwd: process.cwd() }), "memory stats");
}

async function runProjectMemoryPrivacyCheck(): Promise<void> {
  printSafeJson(await checkProjectMemoryPrivacy({ cwd: process.cwd() }), "memory privacy-check");
}

async function runProjectMemoryMigrateJson(args: string[]): Promise<void> {
  const { flags } = parseArgs(args, { "dry-run": "boolean" }, 0);
  printSafeJson(await migrateJsonMemoryToProjectMemory({ cwd: process.cwd(), dryRun: Boolean(flags["dry-run"]) }), "memory migrate-json");
}

async function runMemoryContext(args: string[]): Promise<void> {
  const { positional, flags } = parseArgs(args, {
    "long-limit": "value",
    now: "value",
    "privacy-mode": "value",
    "short-limit": "value"
  }, 1);
  const task = positional[0];
  if (!task) {
    throw new CliUsageError('Usage: lmti memory context "<task>" [--short-limit 8] [--long-limit 8]');
  }
  const result = await retrieveMemoryContextForTask(task, {
    cwd: process.cwd(),
    shortLimit: parseNumberFlag(flags, "short-limit", 8),
    longLimit: parseNumberFlag(flags, "long-limit", 8),
    privacyMode: parsePrivacyMode(stringFlag(flags, "privacy-mode")),
    now: parseNowFlag(flags)
  });
  printSafeJson(result, "memory context");
}

async function runMemoryConsolidate(args: string[]): Promise<void> {
  const { flags } = parseArgs(args, { "include-raw": "boolean", "include-secret": "boolean", role: "value" }, 0);
  const result = await consolidateMemory({
    cwd: process.cwd(),
    privacyContext: createCliPrivacyContext(parseRole(stringFlag(flags, "role") ?? "developer"), flags, "memory consolidate", "consolidate memory")
  });
  printSafeJson(result, "memory consolidate");
}

async function runMemoryDecay(args: string[]): Promise<void> {
  const { flags } = parseArgs(args, { "include-raw": "boolean", "include-secret": "boolean", role: "value" }, 0);
  const result = await decayMemoryLifecycle({
    cwd: process.cwd(),
    privacyContext: createCliPrivacyContext(parseRole(stringFlag(flags, "role") ?? "developer"), flags, "memory decay", "decay memory")
  });
  printSafeJson(result, "memory decay");
}

async function runMemoryReinforce(args: string[]): Promise<void> {
  const { positional, flags } = parseArgs(args, {
    "include-raw": "boolean",
    "include-secret": "boolean",
    intensity: "value",
    role: "value",
    success: "boolean-value"
  }, 1);
  const id = positional[0];
  if (!id) {
    throw new CliUsageError("Usage: lmti memory reinforce <id> --success true|false");
  }
  const success = parseBooleanFlag(flags, "success");
  const result = await reinforceMemory(id, {
    cwd: process.cwd(),
    success,
    intensity: parseNumberFlag(flags, "intensity", success ? 1 : 1.2),
    privacyContext: createCliPrivacyContext(parseRole(stringFlag(flags, "role") ?? "developer"), flags, "memory reinforce", "reinforce memory")
  });
  printSafeJson({ success: result.success, memory: safeMemoryForCli(result.memory) }, "memory reinforce");
}

async function runMemoryReview(args: string[]): Promise<void> {
  const { flags } = parseArgs(args, { "include-raw": "boolean", "include-secret": "boolean", role: "value" }, 0);
  const result = await reviewMemory({
    cwd: process.cwd(),
    privacyContext: createCliPrivacyContext(parseRole(stringFlag(flags, "role") ?? "developer"), flags, "memory review", "review memory")
  });
  printSafeJson(result, "memory review");
}

async function runMemoryAssociations(args: string[]): Promise<void> {
  const { positional, flags } = parseArgs(args, { "include-raw": "boolean", "include-secret": "boolean", role: "value" }, 1);
  const id = positional[0];
  if (!id) {
    throw new CliUsageError("Usage: lmti memory associations <id>");
  }
  const result = await getMemoryAssociations(id, {
    cwd: process.cwd(),
    privacyContext: createCliPrivacyContext(parseRole(stringFlag(flags, "role") ?? "developer"), flags, "memory associations", "inspect memory associations")
  });
  printSafeJson(result, "memory associations");
}

async function runMemoryExplain(args: string[]): Promise<void> {
  const { positional, flags } = parseArgs(args, {
    "include-low-score": "boolean",
    "include-raw": "boolean",
    "include-secret": "boolean",
    kind: "value",
    limit: "value",
    role: "value",
    scope: "value"
  }, 1);
  const query = positional[0];
  if (!query) {
    throw new CliUsageError('Usage: lmti memory explain "<query>" [--role developer]');
  }
  const taskIntent = inferIntent(query);
  const result = await explainMemory(query, {
    cwd: process.cwd(),
    scope: optionalScope(stringFlag(flags, "scope")),
    kind: optionalKind(stringFlag(flags, "kind")),
    includeSecret: Boolean(flags["include-secret"]),
    includeRaw: Boolean(flags["include-raw"]),
    includeLowScore: Boolean(flags["include-low-score"]),
    limit: parseNumberFlag(flags, "limit", 16),
    taskIntent,
    privacyContext: createCliPrivacyContext(parseRole(stringFlag(flags, "role") ?? "developer"), flags, "memory explain", "explain memory retrieval")
  });
  printSafeJson(result, "memory explain");
}

async function runMemoryPromote(args: string[]): Promise<void> {
  const { positional } = parseArgs(args, {  }, 1);
  const id = positional[0];
  if (!id) {
    throw new CliUsageError("Usage: lmti memory promote <id>");
  }
  printSafeJson(await promoteMemory(id, { cwd: process.cwd() }), "memory promote");
}

async function runMemoryDelete(args: string[]): Promise<void> {
  const { positional } = parseArgs(args, {  }, 1);
  const id = positional[0];
  if (!id) {
    throw new CliUsageError("Usage: lmti memory delete <id>");
  }
  const deleted = await deleteMemory(id, { cwd: process.cwd() });
  printSafeJson({ id, deleted }, "memory delete");
}
