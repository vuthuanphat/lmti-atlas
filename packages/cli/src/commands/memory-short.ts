import { createShortMemoryNote, retrieveShortMemoryForTask, expireShortMemoryNotes, cleanupShortMemoryNotes, evaluateShortMemoryForPromotion, promoteShortMemoryToLongMemory } from "@atlas/memory";
import { CliUsageError, parseArgs, parseCsv, parseNowFlag, parseNumberFlag, parsePrivacyMode, parseShortMemoryPriority, parseShortMemoryTtl, stringFlag } from "../arguments.js";
import { printSafeJson } from "../output.js";

export async function runShortMemoryAdd(args: string[]): Promise<void> {
  const { flags } = parseArgs(args, {
    content: "value",
    priority: "value",
    source: "value",
    "source-type": "value",
    tags: "value",
    title: "value",
    "ttl-days": "value",
    "ttl-hours": "value",
    "ttl-minutes": "value"
  }, 0);
  const title = stringFlag(flags, "title");
  const content = stringFlag(flags, "content");
  if (!title || !content) {
    throw new CliUsageError('Usage: lmti memory short:add --title "..." --content "..." [--priority high] [--ttl-hours 72]');
  }

  const note = await createShortMemoryNote(
    {
      title,
      content,
      source: stringFlag(flags, "source"),
      sourceType: stringFlag(flags, "source-type"),
      tags: parseCsv(stringFlag(flags, "tags")),
      priority: parseShortMemoryPriority(stringFlag(flags, "priority") ?? "medium"),
      ttl: parseShortMemoryTtl(flags)
    },
    { cwd: process.cwd() }
  );
  printSafeJson(note, "memory short:add");
}

export async function runShortMemoryRetrieve(args: string[]): Promise<void> {
  const { positional, flags } = parseArgs(args, {
    "include-expired": "boolean",
    limit: "value",
    "privacy-mode": "value",
    tags: "value"
  }, 1);
  const task = positional[0];
  if (!task) {
    throw new CliUsageError('Usage: lmti memory short:retrieve "<task>" [--limit 8] [--tags a,b]');
  }

  const result = await retrieveShortMemoryForTask(task, {
    cwd: process.cwd(),
    limit: parseNumberFlag(flags, "limit", 8),
    tags: parseCsv(stringFlag(flags, "tags")),
    includeExpired: Boolean(flags["include-expired"]),
    privacyMode: parsePrivacyMode(stringFlag(flags, "privacy-mode"))
  });
  printSafeJson(result, "memory short:retrieve");
}

export async function runShortMemoryExpire(args: string[]): Promise<void> {
  const { flags } = parseArgs(args, { now: "value" }, 0);
  const result = await expireShortMemoryNotes({
    cwd: process.cwd(),
    now: parseNowFlag(flags)
  });
  printSafeJson(result, "memory short:expire");
}

export async function runShortMemoryCleanup(args: string[]): Promise<void> {
  const { flags } = parseArgs(args, { "delete-expired-older-than-hours": "value", "dry-run": "boolean", now: "value" }, 0);
  const result = await cleanupShortMemoryNotes({
    cwd: process.cwd(),
    now: parseNowFlag(flags),
    deleteExpiredOlderThanHours: parseNumberFlag(flags, "delete-expired-older-than-hours", 24),
    dryRun: Boolean(flags["dry-run"])
  });
  printSafeJson(result, "memory short:cleanup");
}

export async function runShortMemoryEvaluate(args: string[]): Promise<void> {
  const { flags, positional } = parseArgs(args, { "note-id": "value" }, 1);
  const noteId = stringFlag(flags, "note-id") ?? positional[0];
  if (!noteId) {
    throw new CliUsageError('Usage: lmti memory short:evaluate --note-id "..."');
  }
  printSafeJson(await evaluateShortMemoryForPromotion(noteId, { cwd: process.cwd() }), "memory short:evaluate");
}

export async function runShortMemoryPromote(args: string[]): Promise<void> {
  const { flags, positional } = parseArgs(args, { force: "boolean", "note-id": "value", reason: "value" }, 1);
  const noteId = stringFlag(flags, "note-id") ?? positional[0];
  if (!noteId) {
    throw new CliUsageError('Usage: lmti memory short:promote --note-id "..." [--reason "..."] [--force]');
  }
  const result = await promoteShortMemoryToLongMemory(
    {
      noteId,
      reason: stringFlag(flags, "reason"),
      force: Boolean(flags.force)
    },
    { cwd: process.cwd() }
  );
  printSafeJson(result, "memory short:promote");
}
