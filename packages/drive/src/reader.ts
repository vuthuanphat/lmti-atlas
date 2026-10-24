import { createHash, randomBytes } from "node:crypto";
import { DriveError, type DriveAccount, type DriveErrorCode, type DriveItem, type DrivePage, type DriveRead } from "./model.js";

const BASE = "https://www.googleapis.com/drive/v3";
const FOLDER = "application/vnd.google-apps.folder";
const DOCS = "application/vnd.google-apps.document";
const SLIDES = "application/vnd.google-apps.presentation";
const TEXT_MIMES = new Set(["text/plain", "text/markdown", "text/csv"]);
const FILE_FIELDS = "id,name,mimeType,version,modifiedTime,trashed,parents,capabilities(canDownload,canListChildren)";
const METADATA_LIMIT = 1024 * 1024;
const TEXT_LIMIT = 512 * 1024;
const MAX_DEPTH = 16;
const MAX_REQUESTS = 40;
const CURSOR_TTL = 5 * 60_000;
interface Metadata { item: DriveItem; parents: string[]; trashed: boolean; canListChildren: boolean; }
interface Operation { generation: number; controller: AbortController; requests: number; }
interface Cursor { parent: string; mode: "picker" | "scope"; token: string; generation: number; createdAt: number; }
export interface GoogleDriveReaderOptions { accessToken: () => Promise<string>; fetch?: typeof fetch; now?: () => Date; }
function fail(code: DriveErrorCode): never { throw new DriveError(code); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("DRIVE_INVALID_RESPONSE");
  return value as Record<string, unknown>;
}
function id(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,200}$/u.test(value)) fail("DRIVE_INVALID_REQUEST");
  return value;
}
function label(value: unknown, max: number): string {
  if (typeof value !== "string" || !value || value.length > max || /[\x00-\x1f\x7f]/u.test(value)) fail("DRIVE_INVALID_RESPONSE");
  return value;
}
function version(value: unknown): string {
  if (typeof value !== "string" || !/^\d{1,20}$/u.test(value)) fail("DRIVE_INVALID_RESPONSE");
  return value;
}
function metadata(value: unknown): Metadata {
  const raw = object(value), capabilities = raw.capabilities === undefined ? {} : object(raw.capabilities);
  let fileId: string;
  try { fileId = id(raw.id); } catch { fail("DRIVE_INVALID_RESPONSE"); }
  const mimeType = label(raw.mimeType, 160), kind = mimeType === FOLDER ? "folder" : TEXT_MIMES.has(mimeType) || mimeType === DOCS || mimeType === SLIDES ? "document" : "unsupported";
  if (raw.trashed !== undefined && typeof raw.trashed !== "boolean") fail("DRIVE_INVALID_RESPONSE");
  for (const name of ["canDownload", "canListChildren"]) if (capabilities[name] !== undefined && typeof capabilities[name] !== "boolean") fail("DRIVE_INVALID_RESPONSE");
  const parents = raw.parents === undefined ? [] : raw.parents;
  if (!Array.isArray(parents) || parents.length > 1) fail("DRIVE_INVALID_RESPONSE");
  const parentIds = parents.map(value => { try { return id(value); } catch { fail("DRIVE_INVALID_RESPONSE"); } });
  const item: DriveItem = { id: fileId!, name: label(raw.name, 1024), mimeType, version: version(raw.version), canDownload: capabilities.canDownload === true, kind, readable: kind === "document" && capabilities.canDownload === true && raw.trashed !== true };
  if (raw.modifiedTime !== undefined) {
    const date = label(raw.modifiedTime, 64);
    if (!/^\d{4}-\d{2}-\d{2}T/u.test(date) || !Number.isFinite(Date.parse(date))) fail("DRIVE_INVALID_RESPONSE");
    item.modifiedTime = date;
  }
  return { item, parents: parentIds, trashed: raw.trashed === true, canListChildren: capabilities.canListChildren === true };
}
function folderReference(value: string): string {
  if (typeof value !== "string" || value.length > 2048) fail("DRIVE_INVALID_REQUEST");
  if (/^[A-Za-z0-9_-]{1,200}$/u.test(value)) return id(value);
  let url: URL;
  try { url = new URL(value); } catch { fail("DRIVE_INVALID_REQUEST"); }
  if (url!.origin !== "https://drive.google.com" || url!.username || url!.password || url!.hash || [...url!.searchParams.keys()].some(key => key !== "usp")) fail("DRIVE_INVALID_REQUEST");
  const match = /^\/drive\/(?:u\/\d+\/)?folders\/([A-Za-z0-9_-]{1,200})\/?$/u.exec(url!.pathname);
  if (!match) fail("DRIVE_INVALID_REQUEST");
  return id(match[1]);
}

/** Read-only provider. It neither stores documents nor supplies model context. */
export class GoogleDriveReader {
  private readonly token: GoogleDriveReaderOptions["accessToken"];
  private readonly fetcher: typeof fetch;
  private readonly now: () => Date;
  private generation = 0;
  private active?: Operation;
  private accountValue?: DriveAccount;
  private selection?: { rootId: string; scopeId: string };
  private readonly cursors = new Map<string, Cursor>();

  constructor(options: GoogleDriveReaderOptions) {
    if (!options || typeof options.accessToken !== "function" || (options.fetch !== undefined && typeof options.fetch !== "function") || (options.now !== undefined && typeof options.now !== "function")) fail("DRIVE_INVALID_REQUEST");
    this.token = options.accessToken;
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? (() => new Date());
  }
  clear(): void {
    this.generation++;
    this.active?.controller.abort(new DriveError("DRIVE_CANCELLED"));
    this.active = undefined;
    this.accountValue = undefined;
    this.selection = undefined;
    this.cursors.clear();
  }
  account(): Promise<DriveAccount> { return this.operation(op => this.getAccount(op)); }
  browseFolders(parentId = "root", cursor?: string): Promise<DrivePage> {
    return this.operation(async op => {
      if (this.selection) fail("DRIVE_ALREADY_SELECTED");
      const parent = await this.getFile(id(parentId), op);
      this.requireFolder(parent);
      return this.page(parent, "picker", cursor, op);
    });
  }
  selectRoot(reference: string): Promise<{ root: DriveItem; scopeId: string }> {
    return this.operation(async op => {
      if (this.selection) fail("DRIVE_ALREADY_SELECTED");
      const selected = folderReference(reference), account = await this.getAccount(op), root = await this.getFile(selected, op);
      this.requireFolder(root);
      const scopeId = createHash("sha256").update(JSON.stringify(["google-drive", account.id, root.item.id])).digest("hex");
      this.check(op);
      this.cursors.clear();
      this.selection = { rootId: root.item.id, scopeId };
      return { root: { ...root.item }, scopeId };
    });
  }
  list(folderId?: string, cursor?: string): Promise<DrivePage> {
    return this.operation(async op => {
      const selected = this.requireSelection(), folder = await this.getFile(id(folderId ?? selected.rootId), op);
      this.requireFolder(folder);
      const beforePath = await this.ancestry(folder, op);
      const page = await this.page(folder, "scope", cursor, op);
      const after = await this.getFile(folder.item.id, op), afterPath = await this.ancestry(after, op);
      this.requireFolder(after);
      if (this.changed(folder, after) || JSON.stringify(beforePath) !== JSON.stringify(afterPath)) fail("DRIVE_CHANGED");
      return page;
    });
  }
  read(fileId: string, expectedVersion: string): Promise<DriveRead> {
    return this.operation(async op => {
      const selected = this.requireSelection();
      if (typeof expectedVersion !== "string" || !/^\d{1,20}$/u.test(expectedVersion)) fail("DRIVE_INVALID_REQUEST");
      const before = await this.getFile(id(fileId), op);
      const beforePath = await this.ancestry(before, op);
      this.requireReadable(before);
      if (before.item.version !== expectedVersion) fail("DRIVE_CHANGED");
      const workspaceDocument = before.item.mimeType === DOCS || before.item.mimeType === SLIDES;
      const endpoint = `/files/${encodeURIComponent(before.item.id)}${workspaceDocument ? "/export" : ""}`;
      const params: Record<string, string> = workspaceDocument ? { mimeType: "text/plain" } : { alt: "media", supportsAllDrives: "true" };
      const bytes = await this.request(endpoint, params, TEXT_LIMIT, op, false);
      let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { fail("DRIVE_UNSUPPORTED"); }
      if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(text!)) fail("DRIVE_UNSUPPORTED");
      const after = await this.getFile(before.item.id, op), afterPath = await this.ancestry(after, op);
      this.requireReadable(after);
      if (this.changed(before, after) || JSON.stringify(beforePath) !== JSON.stringify(afterPath)) fail("DRIVE_CHANGED");
      this.check(op);
      return { file: { ...after.item }, text: text!, contentHash: createHash("sha256").update(text!, "utf8").digest("hex"), checkedAt: this.now().toISOString(), scopeId: selected.scopeId };
    });
  }
  private requireSelection(): { rootId: string; scopeId: string } {
    if (!this.selection) fail("DRIVE_NOT_CONNECTED");
    return this.selection;
  }
  private requireFolder(value: Metadata): void {
    if (value.trashed || !value.canListChildren) fail("DRIVE_ACCESS_DENIED");
    if (value.item.kind !== "folder") fail("DRIVE_UNSUPPORTED");
  }
  private requireReadable(value: Metadata): void {
    if (value.trashed || !value.item.canDownload) fail("DRIVE_ACCESS_DENIED");
    if (value.item.kind !== "document") fail("DRIVE_UNSUPPORTED");
  }
  private changed(before: Metadata, after: Metadata): boolean {
    return JSON.stringify(before) !== JSON.stringify(after);
  }
  private async ancestry(file: Metadata, op: Operation): Promise<string[]> {
    const selected = this.requireSelection(), seen = new Set<string>(), chain: string[] = [];
    let current = file;
    for (let depth = 0; depth <= MAX_DEPTH; depth++) {
      if (seen.has(current.item.id)) fail("DRIVE_SCOPE_DENIED");
      seen.add(current.item.id); chain.push(current.item.id);
      if (current.trashed) fail("DRIVE_ACCESS_DENIED");
      if (current.item.id === selected.rootId) { this.requireFolder(current); return chain; }
      if (current.parents.length !== 1) fail("DRIVE_SCOPE_DENIED");
      if (depth === MAX_DEPTH) fail("DRIVE_LIMIT_EXCEEDED");
      current = await this.getFile(current.parents[0], op);
      this.requireFolder(current);
    }
    fail("DRIVE_LIMIT_EXCEEDED");
  }
  private async getAccount(op: Operation): Promise<DriveAccount> {
    if (this.accountValue) return { ...this.accountValue };
    const response = object(await this.json("/about", { fields: "user(permissionId,displayName)" }, op)), user = object(response.user);
    let accountId: string;
    try { accountId = id(user.permissionId); } catch { fail("DRIVE_INVALID_RESPONSE"); }
    const account = { id: accountId!, displayName: label(user.displayName, 240) };
    this.check(op); this.accountValue = account;
    return { ...account };
  }
  private async getFile(fileId: string, op: Operation): Promise<Metadata> {
    const file = metadata(await this.json(`/files/${encodeURIComponent(fileId)}`, { fields: FILE_FIELDS, supportsAllDrives: "true" }, op));
    if (fileId !== "root" && file.item.id !== fileId) fail("DRIVE_INVALID_RESPONSE");
    return file;
  }
  private async page(parent: Metadata, mode: Cursor["mode"], cursor: string | undefined, op: Operation): Promise<DrivePage> {
    const stored = cursor === undefined ? undefined : this.cursors.get(cursor);
    if (cursor !== undefined && (!stored || stored.parent !== parent.item.id || stored.mode !== mode || stored.generation !== this.generation || Date.now() - stored.createdAt > CURSOR_TTL)) fail("DRIVE_CURSOR_INVALID");
    const q = `'${parent.item.id}' in parents and trashed = false${mode === "picker" ? ` and mimeType = '${FOLDER}'` : ""}`;
    const response = object(await this.json("/files", { q, fields: `nextPageToken,incompleteSearch,files(${FILE_FIELDS})`, pageSize: "100", spaces: "drive", orderBy: "folder,name", supportsAllDrives: "true", includeItemsFromAllDrives: "true", ...(stored ? { pageToken: stored.token } : {}) }, op));
    if (!Array.isArray(response.files) || response.files.length > 100 || (response.incompleteSearch !== undefined && typeof response.incompleteSearch !== "boolean")) fail("DRIVE_INVALID_RESPONSE");
    const files = response.files.map(metadata);
    if (new Set(files.map(file => file.item.id)).size !== files.length) fail("DRIVE_INVALID_RESPONSE");
    for (const file of files) {
      if (file.trashed || file.parents.length !== 1 || file.parents[0] !== parent.item.id) fail("DRIVE_SCOPE_DENIED");
      if (mode === "picker" && file.item.kind !== "folder") fail("DRIVE_INVALID_RESPONSE");
    }
    let nextCursor: string | undefined;
    if (response.nextPageToken !== undefined) {
      const token = label(response.nextPageToken, 4096);
      nextCursor = randomBytes(32).toString("hex");
      if (this.cursors.size >= 100) this.cursors.delete(this.cursors.keys().next().value!);
      this.cursors.set(nextCursor, { parent: parent.item.id, mode, token, generation: this.generation, createdAt: Date.now() });
    }
    if (mode === "picker") {
      const after = await this.getFile(parent.item.id, op); this.requireFolder(after);
      if (this.changed(parent, after)) fail("DRIVE_CHANGED");
    }
    this.check(op);
    return { folder: { ...parent.item }, files: files.map(file => ({ ...file.item })), ...(nextCursor ? { nextCursor } : {}), partial: nextCursor !== undefined || response.incompleteSearch === true, checkedAt: this.now().toISOString() };
  }
  private check(op: Operation): void {
    if (op.generation !== this.generation) fail("DRIVE_CANCELLED");
    if (op.controller.signal.aborted) throw op.controller.signal.reason instanceof DriveError ? op.controller.signal.reason : new DriveError("DRIVE_CANCELLED");
  }
  private async operation<T>(action: (op: Operation) => Promise<T>): Promise<T> {
    if (this.active) fail("DRIVE_BUSY");
    const op: Operation = { generation: this.generation, controller: new AbortController(), requests: 0 };
    this.active = op;
    const timer = setTimeout(() => op.controller.abort(new DriveError("DRIVE_TIMEOUT")), 30_000);
    try { const result = await action(op); this.check(op); return result; }
    catch (error) { this.check(op); throw error instanceof DriveError ? error : new DriveError("DRIVE_UNAVAILABLE"); }
    finally { clearTimeout(timer); if (this.active === op) this.active = undefined; }
  }
  private async wait<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) throw signal.reason;
    let abort: () => void = () => undefined;
    const cancelled = new Promise<never>((_, reject) => { abort = () => reject(signal.reason); signal.addEventListener("abort", abort, { once: true }); });
    try { return await Promise.race([work, cancelled]); }
    finally { signal.removeEventListener("abort", abort); }
  }
  private async json(endpoint: string, params: Record<string, string>, op: Operation): Promise<unknown> {
    const bytes = await this.request(endpoint, params, METADATA_LIMIT, op, true);
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { fail("DRIVE_INVALID_RESPONSE"); }
  }
  private async request(endpoint: string, params: Record<string, string>, limit: number, op: Operation, json: boolean): Promise<Buffer> {
    this.check(op); if (++op.requests > MAX_REQUESTS) fail("DRIVE_LIMIT_EXCEEDED");
    const controller = new AbortController(), cancelled = () => controller.abort(op.controller.signal.reason);
    op.controller.signal.addEventListener("abort", cancelled, { once: true });
    const timer = setTimeout(() => controller.abort(new DriveError("DRIVE_TIMEOUT")), 10_000);
    try {
      const token = await this.wait(Promise.resolve().then(() => this.token()), controller.signal);
      if (typeof token !== "string" || !/^[\x21-\x7e]{1,16384}$/u.test(token)) fail("DRIVE_AUTH_REQUIRED");
      const url = new URL(BASE + endpoint);
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
      const response = await this.wait(this.fetcher(url.href, { method: "GET", headers: { Authorization: `Bearer ${token}`, Accept: json ? "application/json" : "text/plain", "Cache-Control": "no-store" }, redirect: "error", credentials: "omit", signal: controller.signal }), controller.signal);
      if (response.redirected || (response.url && new URL(response.url).origin !== url.origin)) {
        void response.body?.cancel().catch(() => undefined);
        fail("DRIVE_UNAVAILABLE");
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        fail(response.status === 401 ? "DRIVE_AUTH_REQUIRED" : response.status === 403 ? "DRIVE_ACCESS_DENIED" : response.status === 404 ? "DRIVE_NOT_FOUND" : response.status === 429 ? "DRIVE_RATE_LIMITED" : "DRIVE_UNAVAILABLE");
      }
      const advertised = response.headers.get("content-length");
      if (advertised && /^\d+$/u.test(advertised) && Number(advertised) > limit) { void response.body?.cancel().catch(() => undefined); fail("DRIVE_LIMIT_EXCEEDED"); }
      const reader = response.body?.getReader();
      if (!reader) return Buffer.alloc(0);
      const chunks: Buffer[] = []; let length = 0;
      try {
        for (;;) {
          const part = await this.wait(reader.read(), controller.signal);
          if (part.done) break;
          length += part.value.byteLength;
          if (length > limit) fail("DRIVE_LIMIT_EXCEEDED");
          chunks.push(Buffer.from(part.value));
        }
      } finally { void reader.cancel().catch(() => undefined); try { reader.releaseLock(); } catch { /* A timed-out stream may still have a pending reader. */ } }
      this.check(op);
      if (controller.signal.aborted) throw controller.signal.reason;
      return Buffer.concat(chunks, length);
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason instanceof DriveError ? controller.signal.reason : new DriveError("DRIVE_TIMEOUT");
      throw error instanceof DriveError ? error : new DriveError("DRIVE_UNAVAILABLE");
    } finally { clearTimeout(timer); op.controller.signal.removeEventListener("abort", cancelled); }
  }
}
