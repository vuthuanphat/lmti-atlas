import { afterEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import type { GoogleDriveAuthSession, GoogleDriveOAuthOptions, DriveItem, DrivePage } from "@atlas/drive";
import { DriveDesktopBroker, runDriveDesktop, type DriveBrokerOptions } from "../src/drive-command.js";

const REQUEST = "lmti.desktop.drive.request.v1", RESPONSE = "lmti.desktop.drive.response.v1";
const CLIENT = "123456-synthetic.apps.googleusercontent.com";
const documentPath = path.resolve("synthetic-drive-project.sqlite");
const brokers: DriveDesktopBroker[] = [];
afterEach(() => { for (const broker of brokers.splice(0)) broker.close(); });
function request(operation: string, requestId = 1, fields: Record<string, unknown> = {}) {
  return { schema: REQUEST, requestId, projectId: "synthetic-project", documentPath,
    projectRevision: 1, connectionId: "", operation, ...fields };
}
type Reply = { schema: string; ok: boolean; error?: { code: string }; result?: Record<string, unknown>; [key: string]: unknown };
function fixture(overrides: Partial<DriveBrokerOptions> = {}) {
  const session: GoogleDriveAuthSession = { accessToken: vi.fn(async () => "synthetic-private-token"), close: vi.fn() };
  const folder: DriveItem = { id: "synthetic-folder", name: "Synthetic folder", mimeType: "application/vnd.google-apps.folder",
    version: "1", canDownload: false, kind: "folder", readable: false };
  const file: DriveItem = { id: "synthetic-file", name: "Synthetic document", mimeType: "text/plain",
    version: "7", canDownload: true, kind: "document", readable: true };
  const page: DrivePage = { folder, files: [folder], partial: false, checkedAt: "2026-10-13T00:00:00.000Z" };
  const reader = {
    account: vi.fn(async () => ({ id: "synthetic-account", displayName: "Synthetic account" })),
    browseFolders: vi.fn(async () => page), selectRoot: vi.fn(async () => ({ root: folder, scopeId: "a".repeat(64) })),
    list: vi.fn(async () => ({ ...page, files: [file] })),
    read: vi.fn(async () => ({ file, text: "Synthetic local document.", contentHash: "b".repeat(64), checkedAt: page.checkedAt, scopeId: "a".repeat(64) })),
    clear: vi.fn(),
  };
  const authorize = vi.fn(async (options: GoogleDriveOAuthOptions) => {
    options.onAuthorizationUrl("https://accounts.google.com/o/oauth2/v2/auth?state=synthetic-state");
    return session;
  });
  const createReader = vi.fn(() => reader);
  const options: DriveBrokerOptions = { enabled: true, clientId: CLIENT, clientSecret: "synthetic-developer-configuration",
    authorize, createReader, ...overrides };
  const broker = new DriveDesktopBroker(options); brokers.push(broker);
  let sequence = 0, connectionId = "";
  const events: object[] = [];
  async function call(operation: string, fields: Record<string, unknown> = {}): Promise<Reply> {
    const reply = await broker.handle(request(operation, ++sequence, { connectionId, ...fields }), value => events.push(value)) as Reply;
    if (reply.ok && operation === "connect") connectionId = reply.result!.connectionId as string;
    if (reply.ok && operation === "disconnect") connectionId = "";
    return reply;
  }
  return { broker, options, session, reader, authorize, createReader, call, events };
}

describe("dedicated desktop Drive broker", () => {
  it("remains disconnected without a developer registration and requires explicit permission acknowledgement", async () => {
    for (const options of [{ enabled: false }, { clientId: undefined }, { clientId: "malformed" }]) {
      const f = fixture(options);
      expect((await f.call("status")).result).toEqual({ configured: false, connected: false });
      expect((await f.call("connect", { acknowledgedScope: true })).ok).toBe(false);
      expect(f.authorize).not.toHaveBeenCalled(); expect(f.createReader).not.toHaveBeenCalled();
    }
    const f = fixture();
    expect((await f.call("status")).result).toEqual({ configured: true, connected: false });
    expect((await f.call("connect")).ok).toBe(false);
    expect((await f.call("connect", { acknowledgedScope: false })).ok).toBe(false);
    expect(f.authorize).not.toHaveBeenCalled();
    expect((await f.call("connect", { acknowledgedScope: true })).ok).toBe(true);
  });

  it("uses launcher credentials, binds every event/response and exposes only local viewing results", async () => {
    const f = fixture(), reply = await f.call("connect", { acknowledgedScope: true });
    expect(reply).toMatchObject({ schema: RESPONSE, requestId: 1, projectId: "synthetic-project", documentPath,
      projectRevision: 1, connectionId: "", operation: "connect", purpose: "local_view", externalEgress: "denied", ok: true });
    expect(reply.result?.connectionId).toMatch(/^[a-f0-9]{64}$/u);
    expect(f.authorize.mock.calls[0][0]).toMatchObject({ clientId: CLIENT, clientSecret: "synthetic-developer-configuration" });
    expect(f.events).toEqual([expect.objectContaining({ schema: "lmti.desktop.drive.event.v1", event: "authorize", requestId: 1,
      projectId: "synthetic-project", documentPath, projectRevision: 1, connectionId: "" })]);
    expect(f.reader.account).toHaveBeenCalledTimes(1); expect(f.reader.browseFolders).toHaveBeenCalledTimes(1);
    expect(f.reader.read).not.toHaveBeenCalled();
    const encoded = JSON.stringify([reply, ...f.events]);
    expect(encoded).not.toContain("synthetic-private-token"); expect(encoded).not.toContain("synthetic-developer-configuration");
    expect(encoded).not.toContain("refresh_token");
  });

  it("rejects arbitrary fields, credentials, operation injection and malformed identities before invoking an owner", async () => {
    const invalid: unknown[] = [null, [], "value", request("delete"), request("connect", 1, { acknowledgedScope: true, accessToken: "synthetic-secret" }),
      request("status", 1, { role: "operator" }), request("status", 1, { schema: "lmti.desktop.request.v1" }),
      request("status", 1, { projectId: "../../other-project" }), request("status", 1, { documentPath: "relative.sqlite" }),
      request("status", 1, { projectRevision: 0 }), request("status", 1, { requestId: Number.MAX_SAFE_INTEGER + 1 }),
      request("status", 1, { connectionId: "synthetic-token" }), request("read", 1, { fileId: "id", expectedVersion: "7e1" }),
      request("list", 1, { folderId: "folder' or trashed=false" }), request("list", 1, { cursor: "provider-private-page-token" }),
      request("select-folder", 1, { folderReference: "x\nsecret" }), request("status", 1, { operation: "__proto__" })];
    for (const value of invalid) {
      const f = fixture(), reply = await f.broker.handle(value) as Reply;
      expect(reply).toEqual({ schema: RESPONSE, ok: false, error: { code: "DRIVE_REQUEST_DENIED" } });
      expect(f.authorize).not.toHaveBeenCalled(); expect(f.createReader).not.toHaveBeenCalled();
      expect(JSON.stringify(reply)).not.toContain("synthetic-secret");
    }
  });

  it("rejects replayed request IDs and mismatched connections without dispatching a read", async () => {
    const f = fixture(), connected = await f.call("connect", { acknowledgedScope: true });
    const connectionId = connected.result!.connectionId as string;
    const replay = await f.broker.handle(request("read", 1, { connectionId, fileId: "synthetic-file", expectedVersion: "7" })) as Reply;
    expect(replay.error?.code).toBe("DRIVE_REQUEST_DENIED");
    expect((await f.call("read", { connectionId: "f".repeat(64), fileId: "synthetic-file", expectedVersion: "7" })).error?.code).toBe("DRIVE_CONNECTION_CHANGED");
    expect(f.reader.read).not.toHaveBeenCalled();
    expect((await f.call("read", { fileId: "synthetic-file", expectedVersion: "7" })).ok).toBe(true);
    expect(f.reader.read).toHaveBeenCalledExactlyOnceWith("synthetic-file", "7");
  });

  it.each([{ projectId: "other-project" }, { documentPath: path.resolve("different-copy.sqlite") }, { projectRevision: 2 }])(
    "permanently closes the session if project identity, exact document or revision changes", async changed => {
      const f = fixture(); await f.call("connect", { acknowledgedScope: true });
      expect((await f.call("status", changed)).error?.code).toBe("DRIVE_PROJECT_CHANGED");
      expect(f.reader.clear).toHaveBeenCalled(); expect(f.session.close).toHaveBeenCalled();
      expect((await f.call("status")).error?.code).toBe("DRIVE_CLOSED");
      expect(f.reader.read).not.toHaveBeenCalled();
    });

  it("routes selected-folder operations, resets scope explicitly and drops account sessions on disconnect", async () => {
    const f = fixture();
    expect((await f.call("list")).error?.code).toBe("DRIVE_NOT_CONNECTED");
    const first = await f.call("connect", { acknowledgedScope: true });
    expect((await f.call("connect", { acknowledgedScope: true })).error?.code).toBe("DRIVE_ALREADY_CONNECTED");
    expect((await f.call("browse-folders", { folderId: "synthetic-child", cursor: "c".repeat(64) })).ok).toBe(true);
    expect(f.reader.browseFolders).toHaveBeenLastCalledWith("synthetic-child", "c".repeat(64));
    expect((await f.call("select-folder", { folderReference: "synthetic-folder" })).ok).toBe(true);
    expect(f.reader.selectRoot).toHaveBeenCalledExactlyOnceWith("synthetic-folder");
    expect(f.reader.list).toHaveBeenCalledOnce();
    expect((await f.call("choose-folder")).ok).toBe(true);
    expect(f.reader.clear).toHaveBeenCalledOnce(); expect(f.createReader).toHaveBeenCalledTimes(2);
    expect((await f.call("disconnect")).ok).toBe(true);
    expect(f.session.close).toHaveBeenCalledOnce(); expect(f.reader.clear).toHaveBeenCalledTimes(2);
    expect((await f.call("status")).result).toEqual({ configured: true, connected: false });
    expect((await f.call("read", { fileId: "synthetic-file", expectedVersion: "7" })).error?.code).toBe("DRIVE_NOT_CONNECTED");
    const second = await f.call("connect", { acknowledgedScope: true });
    expect(second.result!.connectionId).not.toBe(first.result!.connectionId);
  });

  it("never reflects unknown provider error codes, messages, bodies or tokens", async () => {
    const f = fixture();
    f.reader.account.mockRejectedValueOnce(Object.assign(new Error("synthetic-private-provider-response"), { code: "OAUTH_PRIVATE_TOKEN_VALUE" }));
    const reply = await f.call("connect", { acknowledgedScope: true });
    expect(reply.error?.code).toBe("DRIVE_UNAVAILABLE");
    expect(JSON.stringify(reply)).not.toContain("PRIVATE_TOKEN");
    expect(JSON.stringify(reply)).not.toContain("synthetic-private");
    expect(f.session.close).toHaveBeenCalled(); expect(f.reader.clear).toHaveBeenCalled();
    expect((await f.call("status")).result).toEqual({ configured: true, connected: false });
  });

  it("cancels pending login on broker close, suppresses late browser events and rejects concurrent work", async () => {
    let started!: () => void, auth!: GoogleDriveOAuthOptions;
    const authorizationStarted = new Promise<void>(resolve => { started = resolve; });
    const authorize = vi.fn(async (options: GoogleDriveOAuthOptions): Promise<GoogleDriveAuthSession> => {
      auth = options; started();
      return new Promise((_resolve, reject) => options.signal!.addEventListener("abort", () => reject(new Error("synthetic-private-cancel")), { once: true }));
    });
    const f = fixture({ authorize }), connecting = f.call("connect", { acknowledgedScope: true });
    await authorizationStarted;
    expect((await f.call("status")).error?.code).toBe("DRIVE_BUSY");
    f.broker.close();
    expect(auth.signal?.aborted).toBe(true);
    auth.onAuthorizationUrl("https://accounts.google.com/o/oauth2/v2/auth?state=late");
    expect(f.events).toEqual([]);
    expect((await connecting).ok).toBe(false);
    expect(f.createReader).not.toHaveBeenCalled();
  });

  it("clears a late authorizer result even if the provider ignored cancellation", async () => {
    let provide!: (session: GoogleDriveAuthSession) => void;
    const f = fixture({ authorize: async () => new Promise(resolve => { provide = resolve; }) });
    const connecting = f.call("connect", { acknowledgedScope: true });
    f.broker.close(); provide(f.session);
    expect((await connecting).error?.code).toBe("DRIVE_CLOSED");
    expect(f.session.close).toHaveBeenCalled(); expect(f.createReader).not.toHaveBeenCalled();
  });
});

describe("persistent Drive desktop pipe", () => {
  it("keeps the pipe open for an event followed by a response and sends no credentials", async () => {
    const f = fixture(), input = new PassThrough(), output = new PassThrough();
    const lines: Reply[] = []; let buffered = "", done!: () => void;
    const received = new Promise<void>(resolve => { done = resolve; });
    output.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8"); let newline: number;
      while ((newline = buffered.indexOf("\n")) >= 0) {
        lines.push(JSON.parse(buffered.slice(0, newline))); buffered = buffered.slice(newline + 1);
        if (lines.length === 2) done();
      }
    });
    const running = runDriveDesktop(f.options, input, output);
    const text = JSON.stringify(request("connect", 1, { acknowledgedScope: true })) + "\n";
    input.write(text.slice(0, 50)); input.write(text.slice(50)); await received;
    expect(lines[0]).toMatchObject({ schema: "lmti.desktop.drive.event.v1", event: "authorize" });
    expect(lines[1]).toMatchObject({ schema: RESPONSE, ok: true });
    expect(JSON.stringify(lines)).not.toContain("synthetic-private-token");
    expect(JSON.stringify(lines)).not.toContain("synthetic-developer-configuration");
    input.end(); await running;
    expect(f.session.close).toHaveBeenCalled(); output.destroy();
  });

  it("EOF aborts an in-flight authorization instead of retaining a detached credential session", async () => {
    const input = new PassThrough(), output = new PassThrough();
    let started!: () => void, signal!: AbortSignal;
    const startedPromise = new Promise<void>(resolve => { started = resolve; });
    const authorize = vi.fn(async (options: GoogleDriveOAuthOptions): Promise<GoogleDriveAuthSession> => {
      signal = options.signal!; started();
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
    });
    const running = runDriveDesktop({ enabled: true, clientId: CLIENT, authorize }, input, output);
    input.write(JSON.stringify(request("connect", 1, { acknowledgedScope: true })) + "\n");
    await startedPromise; input.end(); await running;
    expect(signal.aborted).toBe(true); expect(output.readableLength).toBe(0); output.destroy();
  });

  it.each(["{invalid-json}\n", "x".repeat(16 * 1024 + 1), "x".repeat(16 * 1024 + 1) + "\n"])(
    "closes malformed or oversized framing without reflecting content", async data => {
      const f = fixture(), input = new PassThrough(), output = new PassThrough();
      const running = runDriveDesktop(f.options, input, output);
      input.write(data); await running;
      expect(output.readableLength).toBe(0); expect(f.authorize).not.toHaveBeenCalled();
      input.destroy(); output.destroy();
    });

  it("closes a blocked output stream instead of buffering an unbounded pipelined response flood", async () => {
    const input = new PassThrough();
    const output = new Writable({ highWaterMark: 1, write(_chunk, _encoding, _callback) { /* Simulate a consumer that never drains. */ } });
    const f = fixture();
    const running = runDriveDesktop(f.options, input, output);
    const finished = running.then(() => true);
    for (let index = 1; index < 20_000 && !input.isPaused(); index++) input.write(JSON.stringify(request("status", index)) + "\n");
    expect(await Promise.race([finished, new Promise(resolve => setTimeout(() => resolve(false), 300))])).toBe(true);
    expect(output.writableLength).toBeLessThanOrEqual(2 * 1024 * 1024);
    input.destroy(); output.destroy();
  });
});
