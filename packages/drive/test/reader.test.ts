import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DRIVE_ERROR_CODES, DriveError } from "../src/model.js";
import { GoogleDriveReader } from "../src/reader.js";

const FOLDER = "application/vnd.google-apps.folder";
const DOCS = "application/vnd.google-apps.document";
const SLIDES = "application/vnd.google-apps.presentation";
const STAMP = "2026-10-13T12:00:00.000Z";
type RawFile = { id: string; name: string; mimeType: string; version: string; modifiedTime: string; trashed: boolean; parents: string[]; capabilities: { canDownload: boolean; canListChildren: boolean } };
function file(id: string, parent: string | undefined, mimeType = FOLDER): RawFile {
  return { id, name: id, mimeType, version: "7", modifiedTime: STAMP, trashed: false, parents: parent ? [parent] : [], capabilities: { canDownload: mimeType !== FOLDER, canListChildren: mimeType === FOLDER } };
}
function json(value: unknown): Response { return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } }); }
type RequestOptions = Parameters<typeof fetch>[1];
type Hook = (url: URL, init: RequestOptions) => Response | undefined | Promise<Response | undefined>;
function fixture() {
  const records = new Map<string, RawFile>([
    ["drive_root", file("drive_root", undefined)], ["selected", file("selected", "drive_root")],
    ["nested", file("nested", "selected")], ["other", file("other", "drive_root")],
    ["doc", file("doc", "nested", DOCS)]
  ]);
  const calls: { url: URL; init: RequestOptions }[] = [];
  let hook: Hook | undefined;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); calls.push({ url, init });
    const intercepted = await hook?.(url, init);
    if (intercepted) return intercepted;
    if (url.pathname === "/drive/v3/about") return json({ user: { permissionId: "account_123", displayName: "Test account" } });
    if (url.pathname === "/drive/v3/files") {
      const q = url.searchParams.get("q") ?? "", parent = /^'([A-Za-z0-9_-]+)' in parents/u.exec(q)?.[1];
      return json({ files: [...records.values()].filter(value => value.parents[0] === parent && !value.trashed && (!q.includes("mimeType") || value.mimeType === FOLDER)) });
    }
    if (url.pathname.endsWith("/export") || url.searchParams.get("alt") === "media") return new Response("Hello, knowledge!\n");
    const requested = url.pathname.split("/").at(-1), value = records.get(requested === "root" ? "drive_root" : requested ?? "");
    return value ? json(value) : new Response("untrusted provider details", { status: 404 });
  };
  const reader = new GoogleDriveReader({ accessToken: async () => "synthetic-test-token", fetch: fetcher, now: () => new Date(STAMP) });
  return { records, calls, reader, fetcher, intercept(value: Hook | undefined) { hook = value; }, async select() { return reader.selectRoot("selected"); } };
}
async function code(promise: Promise<unknown>, expected: string): Promise<void> { await expect(promise).rejects.toMatchObject({ name: "DriveError", code: expected, message: expected }); }
afterEach(() => { vi.useRealTimers(); });

describe("Google Drive read-only provider", () => {
  it("browses folders before selection, resolves root metadata, and clears account and scope", async () => {
    const f = fixture();
    expect(await f.reader.account()).toEqual({ id: "account_123", displayName: "Test account" });
    expect(await f.reader.account()).toEqual({ id: "account_123", displayName: "Test account" });
    expect(f.calls.filter(call => call.url.pathname.endsWith("/about"))).toHaveLength(1);
    const picker = await f.reader.browseFolders();
    expect(picker.folder.id).toBe("drive_root");
    expect(picker.files.map(value => value.id)).toEqual(["selected", "other"]);
    expect(picker.files.every(value => value.kind === "folder" && !value.readable)).toBe(true);
    const selected = await f.reader.selectRoot("https://drive.google.com/drive/u/0/folders/selected?usp=sharing");
    expect(selected.scopeId).toMatch(/^[a-f0-9]{64}$/u);
    expect(selected.scopeId).not.toContain("account_123");
    await code(f.reader.browseFolders(), "DRIVE_ALREADY_SELECTED");
    await code(f.reader.selectRoot("other"), "DRIVE_ALREADY_SELECTED");
    f.reader.clear();
    await code(f.reader.list(), "DRIVE_NOT_CONNECTED");
    expect((await f.reader.browseFolders()).folder.id).toBe("drive_root");
    expect((await f.select()).scopeId).toBe(selected.scopeId);
    expect(f.calls.filter(call => call.url.pathname.endsWith("/about"))).toHaveLength(2);
  });

  it("allows only fixed HTTPS GET requests and does not retain raw provider fields", async () => {
    const f = fixture(); await f.select();
    const result = await f.reader.read("doc", "7");
    expect(result).toEqual({ file: { id: "doc", name: "doc", mimeType: DOCS, version: "7", modifiedTime: STAMP, canDownload: true, kind: "document", readable: true }, text: "Hello, knowledge!\n", contentHash: createHash("sha256").update("Hello, knowledge!\n").digest("hex"), checkedAt: STAMP, scopeId: expect.stringMatching(/^[a-f0-9]{64}$/u) });
    for (const call of f.calls) {
      expect(call.url.origin).toBe("https://www.googleapis.com");
      expect(call.url.pathname.startsWith("/drive/v3/")).toBe(true);
      expect(call.init).toMatchObject({ method: "GET", redirect: "error", credentials: "omit" });
      expect(call.init?.body).toBeUndefined();
      expect(call.url.href).not.toContain("synthetic-test-token");
    }
    expect(JSON.stringify(result)).not.toContain("parents");
    expect(JSON.stringify(result)).not.toContain("synthetic-test-token");
  });

  it.each([DOCS, SLIDES, "text/plain", "text/markdown", "text/csv"])("reads supported text MIME %s with an explicit version", async mime => {
    const f = fixture(); f.records.get("doc")!.mimeType = mime; await f.select();
    const result = await f.reader.read("doc", "7");
    expect(result.text).toBe("Hello, knowledge!\n");
    const content = f.calls.find(call => call.url.pathname.endsWith("/export") || call.url.searchParams.has("alt"))!;
    if (mime === DOCS || mime === SLIDES) expect(content.url.searchParams.get("mimeType")).toBe("text/plain");
    else expect(content.url.searchParams.get("alt")).toBe("media");
  });

  it("lists direct children only and labels Sheets, PDF and shortcuts as metadata-only", async () => {
    const f = fixture();
    for (const [name, mime] of [["sheet", "application/vnd.google-apps.spreadsheet"], ["pdf", "application/pdf"], ["shortcut", "application/vnd.google-apps.shortcut"]]) f.records.set(name, file(name, "selected", mime));
    await f.select(); const page = await f.reader.list();
    expect(page.files.map(value => value.id)).toEqual(["nested", "sheet", "pdf", "shortcut"]);
    expect(page.files.filter(value => value.kind === "unsupported").every(value => !value.readable)).toBe(true);
    expect(f.calls.filter(call => call.url.pathname === "/drive/v3/files")).toHaveLength(1);
    expect(f.calls.some(call => call.url.pathname.endsWith("/doc"))).toBe(false);
    for (const name of ["sheet", "pdf", "shortcut"]) await code(f.reader.read(name, "7"), "DRIVE_UNSUPPORTED");
    expect(f.calls.some(call => call.url.searchParams.has("alt") || call.url.pathname.endsWith("/export"))).toBe(false);
  });

  it("rejects an old expected version before downloading text", async () => {
    const f = fixture(); await f.select(); await code(f.reader.read("doc", "6"), "DRIVE_CHANGED");
    expect(f.calls.some(call => call.url.pathname.endsWith("/export"))).toBe(false);
  });

  it.each(["version", "moved", "ancestor-moved", "revoked", "trashed"])("discards content if %s changes during a read", async change => {
    const f = fixture(); await f.select();
    f.intercept(url => {
      if (!url.pathname.endsWith("/export")) return;
      if (change === "version") f.records.get("doc")!.version = "8";
      if (change === "moved") f.records.get("doc")!.parents = ["other"];
      if (change === "ancestor-moved") f.records.get("nested")!.parents = ["other"];
      if (change === "revoked") f.records.get("doc")!.capabilities.canDownload = false;
      if (change === "trashed") f.records.get("doc")!.trashed = true;
      return new Response("must never return this stale text");
    });
    await code(f.reader.read("doc", "7"), change === "version" ? "DRIVE_CHANGED" : change === "moved" || change === "ancestor-moved" ? "DRIVE_SCOPE_DENIED" : "DRIVE_ACCESS_DENIED");
  });

  it("denies foreign files, moved folders, ancestry cycles and paths beyond depth 16", async () => {
    const f = fixture(); await f.select();
    await code(f.reader.list("other"), "DRIVE_SCOPE_DENIED");
    f.records.get("nested")!.parents = ["nested"];
    await code(f.reader.read("doc", "7"), "DRIVE_SCOPE_DENIED");
    for (let depth = 0; depth < 18; depth++) f.records.set(`deep${depth}`, file(`deep${depth}`, depth ? `deep${depth - 1}` : "selected"));
    f.records.get("doc")!.parents = ["deep17"];
    await code(f.reader.read("doc", "7"), "DRIVE_LIMIT_EXCEEDED");
    expect(f.calls.some(call => call.url.pathname.endsWith("/export"))).toBe(false);
  });

  it.each(["root-revoked", "root-trashed", "root-deleted", "ancestor-trashed"])("rechecks %s before returning document contents", async change => {
    const f = fixture(); await f.select();
    f.intercept(url => {
      if (!url.pathname.endsWith("/export")) return;
      if (change === "root-revoked") f.records.get("selected")!.capabilities.canListChildren = false;
      if (change === "root-trashed") f.records.get("selected")!.trashed = true;
      if (change === "root-deleted") f.records.delete("selected");
      if (change === "ancestor-trashed") f.records.get("nested")!.trashed = true;
      return new Response("content invalidated by owner scope");
    });
    await code(f.reader.read("doc", "7"), change === "root-deleted" ? "DRIVE_NOT_FOUND" : "DRIVE_ACCESS_DENIED");
  });

  it("checks parent scope again after a list and rejects fabricated direct children", async () => {
    const f = fixture(); await f.select();
    f.intercept(url => url.pathname === "/drive/v3/files" ? json({ files: [f.records.get("doc")] }) : undefined);
    await code(f.reader.list(), "DRIVE_SCOPE_DENIED");
    f.intercept(url => { if (url.pathname === "/drive/v3/files") { f.records.get("nested")!.parents = ["other"]; return json({ files: [] }); } });
    await code(f.reader.list("nested"), "DRIVE_SCOPE_DENIED");
  });

  it("binds opaque continuation cursors to folder, mode and selection lifetime", async () => {
    const f = fixture();
    f.intercept(url => url.pathname === "/drive/v3/files" ? json({ files: [], nextPageToken: "provider-private-cursor" }) : undefined);
    const picker = await f.reader.browseFolders();
    expect(picker.nextCursor).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(picker)).not.toContain("provider-private-cursor");
    await f.select();
    await code(f.reader.list(undefined, picker.nextCursor), "DRIVE_CURSOR_INVALID");
    const page = await f.reader.list(); expect(page.partial).toBe(true);
    await code(f.reader.list("nested", page.nextCursor), "DRIVE_CURSOR_INVALID");
    await f.reader.list(undefined, page.nextCursor);
    expect(f.calls.some(call => call.url.searchParams.get("pageToken") === "provider-private-cursor")).toBe(true);
    f.reader.clear(); await f.select();
    await code(f.reader.list(undefined, page.nextCursor), "DRIVE_CURSOR_INVALID");
  });

  it("expires cursors and reports incomplete provider searches", async () => {
    vi.useFakeTimers(); const f = fixture(); await f.select();
    f.intercept(url => url.pathname === "/drive/v3/files" ? json({ files: [], nextPageToken: "private", incompleteSearch: true }) : undefined);
    const page = await f.reader.list(); expect(page.partial).toBe(true);
    await vi.advanceTimersByTimeAsync(300_001);
    await code(f.reader.list(undefined, page.nextCursor), "DRIVE_CURSOR_INVALID");
  });

  it.each([401, 403, 404, 429, 500])("maps HTTP %i to fixed errors without exposing provider bodies", async status => {
    const f = fixture(); f.intercept(() => new Response("sensitive-provider-body", { status }));
    const expected = ({ 401: "DRIVE_AUTH_REQUIRED", 403: "DRIVE_ACCESS_DENIED", 404: "DRIVE_NOT_FOUND", 429: "DRIVE_RATE_LIMITED" } as Record<number, string>)[status] ?? "DRIVE_UNAVAILABLE";
    await code(f.reader.account(), expected);
  });

  it("normalizes thrown network errors and blocks redirects", async () => {
    const f = fixture(); f.intercept(() => { throw new Error("raw network credential details"); });
    await code(f.reader.account(), "DRIVE_UNAVAILABLE");
    const redirected = json({ user: {} }); Object.defineProperty(redirected, "redirected", { value: true });
    f.intercept(() => redirected); await code(f.reader.account(), "DRIVE_UNAVAILABLE");
    const wrongOrigin = json({ user: {} }); Object.defineProperty(wrongOrigin, "url", { value: "https://unexpected.example/" });
    f.intercept(() => wrongOrigin); await code(f.reader.account(), "DRIVE_UNAVAILABLE");
  });

  it.each(["https://attacker.example/drive/folders/selected", "https://drive.google.com.attacker.example/drive/folders/selected", "https://user@drive.google.com/drive/folders/selected", "https://drive.google.com/drive/folders/selected#fragment", "https://drive.google.com/drive/folders/selected?resourcekey=unknown", "selected' or trashed = true", "../selected"])("rejects unsafe folder reference %s without any fetch", async reference => {
    const f = fixture(); await code(f.reader.selectRoot(reference), "DRIVE_INVALID_REQUEST"); expect(f.calls).toHaveLength(0);
  });

  it("enforces decoded stream byte caps independently of advertised sizes", async () => {
    const f = fixture(); await f.select();
    let cancelled = false;
    f.intercept(url => url.pathname.endsWith("/export") ? new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(512 * 1024)); controller.enqueue(new Uint8Array(1)); }, cancel() { cancelled = true; } }), { headers: { "content-length": "1" } }) : undefined);
    await code(f.reader.read("doc", "7"), "DRIVE_LIMIT_EXCEEDED"); expect(cancelled).toBe(true);
    f.intercept(url => url.pathname.endsWith("/export") ? new Response("small body", { headers: { "content-length": String(512 * 1024 + 1) } }) : undefined);
    await code(f.reader.read("doc", "7"), "DRIVE_LIMIT_EXCEEDED");
    f.reader.clear(); f.intercept(() => new Response("x".repeat(1024 * 1024 + 1)));
    await code(f.reader.account(), "DRIVE_LIMIT_EXCEEDED");
  });

  it("accepts the exact 512 KiB limit and rejects invalid UTF-8 or binary text", async () => {
    const f = fixture(); await f.select();
    f.intercept(url => url.pathname.endsWith("/export") ? new Response("x".repeat(512 * 1024)) : undefined);
    expect((await f.reader.read("doc", "7")).text.length).toBe(512 * 1024);
    for (const bytes of [new Uint8Array([0xc3, 0x28]), new Uint8Array([0])]) {
      f.intercept(url => url.pathname.endsWith("/export") ? new Response(bytes) : undefined);
      await code(f.reader.read("doc", "7"), "DRIVE_UNSUPPORTED");
    }
  });

  it("hashes emitted UTF-8 text consistently after removing a source BOM", async () => {
    const f = fixture(); f.records.get("doc")!.mimeType = "text/plain"; await f.select();
    const text = "Kiến thức dự án — 日本語\r\n", source = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, "utf8")]);
    f.intercept(url => url.searchParams.get("alt") === "media" ? new Response(source) : undefined);
    const result = await f.reader.read("doc", "7");
    expect(result.text).toBe(text);
    expect(result.contentHash).toBe(createHash("sha256").update(result.text, "utf8").digest("hex"));
    expect(result.contentHash).not.toBe(createHash("sha256").update(source).digest("hex"));
  });

  it("rejects overfull, duplicate and malformed provider metadata", async () => {
    const f = fixture(); await f.select();
    for (const files of [Array.from({ length: 101 }, (_, i) => file(`f${i}`, "selected")), [file("duplicate", "selected"), file("duplicate", "selected")], [{ ...file("bad", "selected"), version: 7 }]]) {
      f.intercept(url => url.pathname === "/drive/v3/files" ? json({ files }) : undefined);
      await code(f.reader.list(), "DRIVE_INVALID_RESPONSE");
    }
  });

  it("clear cancels pending operations and late authentication cannot restore a selection", async () => {
    let resolve: (value: string) => void = () => undefined;
    const f = fixture(), reader = new GoogleDriveReader({ accessToken: () => new Promise(done => { resolve = done; }), fetch: f.fetcher });
    const pending = reader.selectRoot("selected"); const rejection = code(pending, "DRIVE_CANCELLED");
    await Promise.resolve(); await code(reader.account(), "DRIVE_BUSY");
    reader.clear(); resolve("synthetic-test-token"); await rejection;
    await code(reader.list(), "DRIVE_NOT_CONNECTED"); expect(f.calls).toHaveLength(0);
  });

  it("times out authentication and stalled decoded bodies even when mocks ignore abort", async () => {
    vi.useFakeTimers(); const f = fixture();
    const reader = new GoogleDriveReader({ accessToken: () => new Promise(() => undefined), fetch: f.fetcher });
    const auth = code(reader.account(), "DRIVE_TIMEOUT"); await vi.advanceTimersByTimeAsync(10_000); await auth;
    await f.select();
    f.intercept(url => url.pathname.endsWith("/export") ? new Response(new ReadableStream({ start() {} })) : undefined);
    const body = code(f.reader.read("doc", "7"), "DRIVE_TIMEOUT"); await vi.advanceTimersByTimeAsync(10_000); await body;
  });

  it("bounds a whole multi-request operation to 30 seconds", async () => {
    vi.useFakeTimers(); const f = fixture(); await f.select();
    f.intercept(async () => { await new Promise(resolve => setTimeout(resolve, 9000)); return undefined; });
    const pending = code(f.reader.read("doc", "7"), "DRIVE_TIMEOUT");
    await vi.advanceTimersByTimeAsync(30_000); await pending;
    expect(f.calls.filter(call => call.url.pathname.endsWith("/export"))).toHaveLength(1);
  });

  it("exposes only the fixed error whitelist", () => {
    expect(new DriveError("invalid-foreign-code" as never).code).toBe("DRIVE_UNAVAILABLE");
    expect(DRIVE_ERROR_CODES.every(value => new DriveError(value).message === value)).toBe(true);
  });
});
