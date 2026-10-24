import { constants, promises as fs, type BigIntStats } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { DatabaseSync } from "node:sqlite";
import type { AuditEvent, AuditIntegrityReport, AuditRetentionResult } from "@atlas/types";
import { resolveAuditAclHelper } from "./audit-runtime.mts";

export const PRIVACY_DIR = "privacy";
export const AUDIT_FILE = "audit.jsonl";
const LOCK_FILE = ".audit-lock.sqlite";
const LOCK_TIMEOUT_MS = 5000;

type Boundary = {
  root: { name: string; identity: BigIntStats };
  directory: string;
  directories: Array<{ name: string; identity: BigIntStats }>;
  lock?: { name: string; identity: BigIntStats };
};
type Snapshot = { bytes: Buffer; identity?: BigIntStats };
type AuditInput = Omit<AuditEvent, "id" | "timestamp" | "sequence" | "previousHash" | "hash">;

function fail(code: string): never { throw new Error(code); }
function safeFailure(error: unknown): never {
  if (error instanceof Error && /^AUDIT_[A-Z_]+$/.test(error.message)) throw error;
  fail("AUDIT_STORAGE_UNAVAILABLE");
}
function code(error: unknown): string | undefined { return (error as NodeJS.ErrnoException)?.code; }
function sameFile(left: BigIntStats, right: BigIntStats): boolean { return left.dev === right.dev && left.ino === right.ino; }
function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}
function permissions(info: BigIntStats, write: boolean): void {
  if (process.platform === "win32") return;
  if (typeof process.getuid === "function" && info.uid !== BigInt(process.getuid())) fail("AUDIT_OWNER_MISMATCH");
  // Inspection of legacy logs stays possible; mutation never silently chmods them.
  if (write && (info.mode & 0o077n) !== 0n) fail("AUDIT_PRIVATE_PERMISSIONS_REQUIRED");
}

async function checkedDirectory(name: string, write: boolean, create: boolean): Promise<BigIntStats | undefined> {
  let info: BigIntStats;
  try { info = await fs.lstat(name, { bigint: true }); }
  catch (error) {
    if (code(error) !== "ENOENT") fail("AUDIT_STORAGE_UNAVAILABLE");
    if (!create) return undefined;
    try { await fs.mkdir(name, { mode: 0o700 }); }
    catch (creationError) { if (code(creationError) !== "EEXIST") fail("AUDIT_STORAGE_UNAVAILABLE"); }
    info = await fs.lstat(name, { bigint: true });
  }
  if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await fs.realpath(name), name)) fail("AUDIT_SOURCE_BOUNDARY_DENIED");
  permissions(info, write);
  return info;
}

async function boundary(cwd: string, write: boolean): Promise<Boundary | undefined> {
  // A project may be selected through an alias. Below its canonical root the
  // private namespace is never redirected through links or junctions.
  let root: string;
  try { root = await fs.realpath(cwd); } catch { fail("AUDIT_SOURCE_BOUNDARY_DENIED"); }
  const rootIdentity = await fs.lstat(root, { bigint: true });
  if (!rootIdentity.isDirectory() || rootIdentity.isSymbolicLink()) fail("AUDIT_SOURCE_BOUNDARY_DENIED");
  const directories: Boundary["directories"] = [];
  let directory = root;
  const owner: Boundary = { root: { name: root, identity: rootIdentity }, directory, directories };
  for (const component of [".lmti", PRIVACY_DIR]) {
    await recheck(owner, write);
    directory = path.join(directory, component);
    const identity = await checkedDirectory(directory, write, write);
    if (!identity) return undefined;
    directories.push({ name: directory, identity });
    owner.directory = directory;
  }
  await recheck(owner, write);
  return owner;
}

async function recheck(owner: Boundary, write: boolean): Promise<void> {
  const root = await fs.lstat(owner.root.name, { bigint: true });
  if (!root.isDirectory() || root.isSymbolicLink() || !sameFile(root, owner.root.identity) ||
      !samePath(await fs.realpath(owner.root.name), owner.root.name)) fail("AUDIT_SOURCE_BOUNDARY_DENIED");
  for (const entry of owner.directories) {
    const now = await checkedDirectory(entry.name, write, false);
    if (!now || !sameFile(entry.identity, now)) fail("AUDIT_SOURCE_BOUNDARY_DENIED");
  }
  if (owner.lock) {
    const lock = await fileInfo(owner.lock.name, true);
    if (!lock || !sameFile(lock, owner.lock.identity)) fail("AUDIT_SOURCE_BOUNDARY_DENIED");
  }
}

async function fileInfo(name: string, write: boolean): Promise<BigIntStats | undefined> {
  let info: BigIntStats;
  try { info = await fs.lstat(name, { bigint: true }); }
  catch (error) { if (code(error) === "ENOENT") return undefined; fail("AUDIT_STORAGE_UNAVAILABLE"); }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n) fail("AUDIT_SOURCE_BOUNDARY_DENIED");
  permissions(info, write);
  return info;
}

async function snapshot(owner: Boundary, name: string, write: boolean, writable = false): Promise<Snapshot> {
  await recheck(owner, write);
  const before = await fileInfo(name, write);
  if (!before) return { bytes: Buffer.alloc(0) };
  // Mutation must also be authorized by the existing file's Windows DACL, not
  // just by delete/rename permission on its parent. This handle never changes
  // bytes; replacement happens only after reading and validating the snapshot.
  const file = await fs.open(name, (writable ? constants.O_RDWR : constants.O_RDONLY) | (constants.O_NOFOLLOW ?? 0));
  try {
    const held = await file.stat({ bigint: true });
    if (!sameFile(before, held) || held.nlink !== 1n) fail("AUDIT_SOURCE_BOUNDARY_DENIED");
    permissions(held, write);
    const bytes = await file.readFile();
    const after = await file.stat({ bigint: true });
    if (after.size !== held.size || after.mtimeNs !== held.mtimeNs) fail("AUDIT_SOURCE_CHANGED");
    await recheck(owner, write);
    return { bytes, identity: after };
  } finally { await file.close(); }
}

async function expectedFile(name: string, expected?: BigIntStats): Promise<void> {
  const current = await fileInfo(name, true);
  if (expected ? !current || !sameFile(expected, current) || expected.size !== current.size || expected.mtimeNs !== current.mtimeNs : !!current)
    fail("AUDIT_SOURCE_CHANGED");
}

async function syncDirectory(directory: string): Promise<void> {
  // Windows does not expose directory fsync through Node. File fsync + atomic
  // rename still protects process-crash consistency, not a power-loss guarantee.
  if (process.platform === "win32") return;
  const handle = await fs.open(directory, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

// The native helper only copies DACLs from audit.jsonl to an empty audit temp
// file; it never reads event bytes, changes owner/SACL or runs a shell. Missing
// runtime fails closed. Fixed-length framing keeps Unicode paths off argv.
async function copyWindowsAccess(source: string, target: string): Promise<void> {
  if (process.platform !== "win32") return;
  const executable = await resolveAuditAclHelper();
  const sourceBytes = Buffer.from(source, "utf8"), targetBytes = Buffer.from(target, "utf8");
  if (sourceBytes.length > 65536 || targetBytes.length > 65536) fail("AUDIT_ACCESS_PRESERVATION_FAILED");
  const header = Buffer.alloc(16);
  header.write("LMTIACL1", 0, "ascii");
  header.writeUInt32LE(sourceBytes.length, 8); header.writeUInt32LE(targetBytes.length, 12);
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, ["--copy-access-v1"], {
      shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      env: { SystemRoot: systemRoot, WINDIR: systemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP }
    });
    let response = "", outputBytes = 0, failed = false;
    const abort = () => { failed = true; child.kill(); };
    const timeout = setTimeout(abort, 10000);
    child.stdout.on("data", (bytes: Buffer) => {
      outputBytes += bytes.length;
      if (outputBytes > 4096) abort(); else response += bytes.toString("utf8");
    });
    child.stderr.on("data", (bytes: Buffer) => { outputBytes += bytes.length; if (outputBytes > 4096) abort(); });
    child.on("error", () => { failed = true; });
    child.stdin.on("error", () => { failed = true; });
    child.on("close", exitCode => {
      clearTimeout(timeout);
      if (!failed && exitCode === 0 && response === "ok") resolve();
      else reject(new Error("AUDIT_ACCESS_PRESERVATION_FAILED"));
    });
    child.stdin.end(Buffer.concat([header, sourceBytes, targetBytes]));
  });
}

async function publish(owner: Boundary, name: string, bytes: Buffer, expected?: BigIntStats,
  accessSource = expected ? { name, identity: expected } : undefined): Promise<void> {
  await recheck(owner, true);
  const temporary = path.join(path.dirname(name), `.audit-tmp-${randomUUID()}`);
  let created = false, published = false;
  try {
    const file = await fs.open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
    created = true;
    try {
      const identity = await file.stat({ bigint: true });
      if (process.platform === "win32" && accessSource) {
        await expectedFile(accessSource.name, accessSource.identity);
        // The replacement and retention archive must be protected while still
        // empty; fixing their DACL after writing would expose private bytes.
        await copyWindowsAccess(accessSource.name, temporary);
        await recheck(owner, true);
        await expectedFile(accessSource.name, accessSource.identity);
        await expectedFile(temporary, identity);
      }
      await file.writeFile(bytes); await file.sync();
    } finally { await file.close(); }
    await recheck(owner, true);
    await expectedFile(name, expected);
    await fs.rename(temporary, name);
    published = true;
    await syncDirectory(path.dirname(name));
    await recheck(owner, true);
  } catch (error) {
    if (published) fail("AUDIT_WRITE_OUTCOME_UNKNOWN");
    throw error;
  } finally {
    // Only remove this operation's unpublished temporary file, after checking
    // its parent namespace again. Crash leftovers are never treated as events.
    if (created && !published) {
      try { await recheck(owner, true); await fs.unlink(temporary); } catch { /* Preserve evidence if the namespace changed. */ }
    }
  }
}

async function withWriter<T>(cwd: string, operation: (owner: Boundary) => Promise<T>): Promise<T> {
  try { return await writeLocked(cwd, operation); } catch (error) { safeFailure(error); }
}

async function writeLocked<T>(cwd: string, operation: (owner: Boundary) => Promise<T>): Promise<T> {
  const owner = await boundary(cwd, true);
  if (!owner) fail("AUDIT_SOURCE_BOUNDARY_DENIED");
  const lockPath = path.join(owner.directory, LOCK_FILE);
  await recheck(owner, true);
  try {
    const initial = await fs.open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
    await initial.close();
  } catch (error) { if (code(error) !== "EEXIST") throw error; }
  const identity = await fileInfo(lockPath, true);
  if (!identity) fail("AUDIT_SOURCE_BOUNDARY_DENIED");
  // SQLite may initialize its header/journal while acquiring the first lock.
  // Validate every existing sidecar before SQLite is allowed to open it.
  for (const suffix of ["-journal", "-wal", "-shm"])
    await fileInfo(lockPath + suffix, true);
  // This database holds no audit data, head or migration state. BEGIN IMMEDIATE
  // is solely an inter-process mutex released by the OS if its process dies.
  // Never delete/recreate this file or reclaim a lock using elapsed wall time.
  let sqlite: typeof import("node:sqlite");
  try { sqlite = await import("node:sqlite"); } catch { fail("AUDIT_RUNTIME_UNSUPPORTED_NODE_SQLITE_REQUIRED"); }
  let lock: DatabaseSync;
  try { lock = new sqlite.DatabaseSync(lockPath); } catch { fail("AUDIT_LOCK_UNAVAILABLE"); }
  let acquired = false, completed = false;
  try {
    lock.exec("PRAGMA busy_timeout = 0");
    const deadline = performance.now() + LOCK_TIMEOUT_MS;
    while (!acquired) {
      try { lock.exec("BEGIN IMMEDIATE"); acquired = true; }
      catch (error) {
        if (((error as { errcode?: number }).errcode ?? 0) % 256 !== 5) fail("AUDIT_LOCK_UNAVAILABLE");
        if (performance.now() >= deadline) fail("AUDIT_BUSY");
        // Do not block the event loop: another operation in this process may
        // own the lock while awaiting its file write/fsync.
        await delay(10);
      }
    }
    const current = await fileInfo(lockPath, true);
    if (!current || !sameFile(identity, current)) fail("AUDIT_SOURCE_BOUNDARY_DENIED");
    owner.lock = { name: lockPath, identity };
    await recheck(owner, true);
    const result = await operation(owner);
    completed = true;
    return result;
  } finally {
    try {
      try { if (acquired) lock.exec("ROLLBACK"); } finally { lock.close(); }
    } catch {
      if (completed) fail("AUDIT_WRITE_OUTCOME_UNKNOWN");
      fail("AUDIT_LOCK_UNAVAILABLE");
    }
  }
}

function decode(bytes: Buffer): AuditEvent[] {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== "object" || Array.isArray(value)) fail("AUDIT_INVALID_LOG");
      return value as AuditEvent;
    });
  } catch { fail("AUDIT_INVALID_LOG"); }
}

function hashAuditEvent(event: Partial<AuditEvent>): string {
  const canonical = {
    id: event.id ?? "", sequence: event.sequence ?? null, timestamp: event.timestamp ?? "",
    action: event.action ?? "", recordId: event.recordId ?? "", sensitivity: event.sensitivity ?? "",
    role: event.role ?? "", decision: event.decision ?? "", command: event.command ?? "",
    reason: event.reason ?? "", previousHash: event.previousHash ?? null
  };
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

function integrity(events: AuditEvent[]): AuditIntegrityReport {
  const failures: AuditIntegrityReport["failures"] = [];
  for (let index = 0; index < events.length; index++) {
    const event = events[index], previous = events[index - 1];
    if (!event.hash) { failures.push({ sequence: event.sequence, id: event.id, reason: "missing_hash" }); continue; }
    if (event.hash !== hashAuditEvent(event)) failures.push({ sequence: event.sequence, id: event.id, reason: "hash_mismatch" });
    if (previous?.hash && event.previousHash !== previous.hash) failures.push({ sequence: event.sequence, id: event.id, reason: "previous_hash_mismatch" });
    if (previous?.sequence !== undefined && event.sequence !== undefined && event.sequence !== previous.sequence + 1)
      failures.push({ sequence: event.sequence, id: event.id, reason: "sequence_gap" });
  }
  return { valid: failures.length === 0, checked: events.length, failures, checkpointPreviousHash: events[0]?.previousHash };
}

function checkedInput(event: AuditInput): AuditInput {
  const fields = ["action", "recordId", "sensitivity", "role", "decision", "command", "reason"] as const;
  if (!event || typeof event !== "object" || Object.keys(event).some(key => !fields.includes(key as never)) || fields.some(key => typeof event[key] !== "string"))
    fail("AUDIT_INVALID_EVENT");
  if (!["public", "internal", "confidential", "secret"].includes(event.sensitivity) ||
      !["owner", "maintainer", "developer", "agent", "readonly", "external_model"].includes(event.role) ||
      !["allow", "deny", "redact", "summarize"].includes(event.decision)) fail("AUDIT_INVALID_EVENT");
  return { action: event.action, recordId: event.recordId, sensitivity: event.sensitivity, role: event.role,
    decision: event.decision, command: event.command, reason: event.reason };
}

export async function appendAuditEvent(cwd: string, event: AuditInput): Promise<AuditEvent> {
  const input = checkedInput(event);
  return withWriter(cwd, async owner => {
    const name = path.join(owner.directory, AUDIT_FILE), before = await snapshot(owner, name, true, true);
    const events = decode(before.bytes);
    if (!integrity(events).valid) fail("AUDIT_INTEGRITY_INVALID");
    const last = events.at(-1), sequence = (last?.sequence ?? events.length) + 1;
    if (!Number.isSafeInteger(sequence) || sequence < 1) fail("AUDIT_INVALID_LOG");
    const value = { ...input, id: randomUUID(), sequence, timestamp: new Date().toISOString(), previousHash: last?.hash };
    const audit: AuditEvent = { ...value, hash: hashAuditEvent(value) };
    const separator = before.bytes.length && before.bytes.at(-1) !== 10 ? "\n" : "";
    await publish(owner, name, Buffer.concat([before.bytes, Buffer.from(`${separator}${JSON.stringify(audit)}\n`)]), before.identity);
    return audit;
  });
}

async function readAuditFile(cwd: string): Promise<AuditEvent[]> {
  try {
    const owner = await boundary(cwd, false);
    return owner ? decode((await snapshot(owner, path.join(owner.directory, AUDIT_FILE), false)).bytes) : [];
  } catch (error) { safeFailure(error); }
}

export async function readAuditEvents(cwd: string, limit = 50): Promise<AuditEvent[]> {
  const events = await readAuditFile(cwd);
  return events.slice(Math.max(0, events.length - limit)).reverse();
}

export async function verifyAuditIntegrity(cwd: string): Promise<AuditIntegrityReport> {
  return integrity(await readAuditFile(cwd));
}

export async function retainAuditEvents(cwd: string, maxEvents: number): Promise<AuditRetentionResult> {
  if (!Number.isInteger(maxEvents) || maxEvents < 1) throw new Error("Audit retention maxEvents must be a positive integer.");
  return withWriter(cwd, async owner => {
    const name = path.join(owner.directory, AUDIT_FILE), before = await snapshot(owner, name, true, true);
    const events = decode(before.bytes);
    if (!integrity(events).valid) fail("AUDIT_INTEGRITY_INVALID");
    if (events.length <= maxEvents) return { retained: events.length, archived: 0 };
    const archive = events.slice(0, events.length - maxEvents), retained = events.slice(events.length - maxEvents);
    const archiveDirectory = path.join(owner.directory, "archive");
    const archiveIdentity = await checkedDirectory(archiveDirectory, true, true);
    if (!archiveIdentity) fail("AUDIT_SOURCE_BOUNDARY_DENIED");
    const archivalOwner = { ...owner, directories: [...owner.directories, { name: archiveDirectory, identity: archiveIdentity }] };
    const archiveBytes = Buffer.from(archive.map(event => JSON.stringify(event)).join("\n") + "\n");
    const digest = createHash("sha256").update(archiveBytes).digest("hex");
    const archivePath = path.join(archiveDirectory, `audit-${digest}.jsonl`);
    const existing = await snapshot(archivalOwner, archivePath, true);
    if (existing.identity) {
      if (!existing.bytes.equals(archiveBytes)) fail("AUDIT_ARCHIVE_CONFLICT");
    } else await publish(archivalOwner, archivePath, archiveBytes, undefined, { name, identity: before.identity! });
    // Archive first, then replace the active log. A crash between the two leaves
    // the original active log intact and an archival copy, never lost events.
    // The content address makes retrying the same split idempotent. Archives may
    // overlap after a crash and a different later retention; event IDs disambiguate.
    await publish(owner, name, Buffer.from(retained.map(event => JSON.stringify(event)).join("\n") + "\n"), before.identity);
    return { retained: retained.length, archived: archive.length, archivePath };
  });
}
