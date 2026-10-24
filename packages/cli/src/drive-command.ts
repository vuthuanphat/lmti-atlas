import { randomBytes } from "node:crypto";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { authorizeGoogleDrive, GoogleDriveReader, GoogleDriveAuthSession, DRIVE_ERROR_CODES } from "@atlas/drive";

// This local-view protocol is deliberately separate from desktop-bridge/AI context.
const REQUEST = "lmti.desktop.drive.request.v1";
const RESPONSE = "lmti.desktop.drive.response.v1";
const EVENT = "lmti.desktop.drive.event.v1";
const MAX_LINE = 16 * 1024;
const baseFields = ["schema", "requestId", "projectId", "documentPath", "projectRevision", "connectionId", "operation"];
const operationFields: Record<string, string[]> = {
  status: [], connect: ["acknowledgedScope"], "browse-folders": ["folderId", "cursor"],
  "select-folder": ["folderReference"], list: ["folderId", "cursor"], read: ["fileId", "expectedVersion"],
  "choose-folder": [], disconnect: []
};
interface DriveRequest {
  schema: string; requestId: number; projectId: string; documentPath: string; projectRevision: number;
  connectionId: string; operation: string; acknowledgedScope?: boolean; folderId?: string;
  cursor?: string; folderReference?: string; fileId?: string; expectedVersion?: string;
}
type Reader = Pick<GoogleDriveReader, "account" | "browseFolders" | "selectRoot" | "list" | "read" | "clear">;
export interface DriveBrokerOptions {
  enabled: boolean; clientId?: string; clientSecret?: string;
  authorize?: typeof authorizeGoogleDrive;
  createReader?: (session: GoogleDriveAuthSession) => Reader;
}
class BrokerError extends Error { constructor(readonly code: string) { super(code); } }
function deny(code = "DRIVE_REQUEST_DENIED"): never { throw new BrokerError(code); }
function string(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
}
function parse(input: unknown): DriveRequest {
  if (!input || typeof input !== "object" || Array.isArray(input)) deny();
  const r = input as DriveRequest;
  if (r.schema !== REQUEST || !Number.isSafeInteger(r.requestId) || r.requestId < 1 ||
      !string(r.projectId, 160) || !/^[A-Za-z0-9_-]+$/.test(r.projectId) ||
      !string(r.documentPath, 4096) || !path.isAbsolute(r.documentPath) ||
      !Number.isSafeInteger(r.projectRevision) || r.projectRevision < 1 ||
      !string(r.connectionId, 64) || (r.connectionId !== "" && !/^[a-f0-9]{64}$/.test(r.connectionId)) ||
      typeof r.operation !== "string" || !Object.hasOwn(operationFields, r.operation)) deny();
  if (Object.keys(r).some(key => !baseFields.includes(key) && !operationFields[r.operation].includes(key))) deny();
  for (const key of ["folderId", "fileId"] as const)
    if (r[key] !== undefined && (!string(r[key], 200) || !/^[A-Za-z0-9_-]+$/.test(r[key]))) deny();
  if (r.cursor !== undefined && (!string(r.cursor, 64) || !/^[a-f0-9]{64}$/.test(r.cursor))) deny();
  if (r.operation === "connect" && r.acknowledgedScope !== true) deny("DRIVE_SCOPE_ACK_REQUIRED");
  if (r.operation === "select-folder" && (!string(r.folderReference, 2048) || !r.folderReference)) deny();
  if (r.operation === "read" && (!r.fileId || !string(r.expectedVersion, 20) || !/^\d{1,20}$/.test(r.expectedVersion))) deny();
  return r;
}
function identity(r: DriveRequest) {
  return { requestId: r.requestId, projectId: r.projectId, documentPath: r.documentPath,
    projectRevision: r.projectRevision, connectionId: r.connectionId };
}
function configurationValid(options: DriveBrokerOptions): boolean {
  return typeof options.clientId === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}\.apps\.googleusercontent\.com$/.test(options.clientId) &&
    (options.clientSecret === undefined || (string(options.clientSecret, 512) && options.clientSecret.length > 0));
}
// Never reflect upstream error messages, URLs, response bodies or credentials.
function safeCode(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? error.code : "";
  const allowed = new Set<string>([...DRIVE_ERROR_CODES,
    "DRIVE_REQUEST_DENIED", "DRIVE_SCOPE_ACK_REQUIRED", "DRIVE_CLOSED", "DRIVE_PROJECT_CHANGED",
    "DRIVE_CONNECTION_CHANGED", "DRIVE_DISABLED", "DRIVE_NOT_CONFIGURED", "DRIVE_ALREADY_CONNECTED",
    "OAUTH_ACCESS_DENIED", "OAUTH_AUTHORIZATION_FAILED", "OAUTH_AUTHORIZATION_TIMEOUT", "OAUTH_BROWSER_UNAVAILABLE",
    "OAUTH_CANCELLED", "OAUTH_CONFIGURATION_INVALID", "OAUTH_LISTENER_UNAVAILABLE", "OAUTH_SCOPE_DENIED",
    "OAUTH_SESSION_CLOSED", "OAUTH_SESSION_EXPIRED", "OAUTH_SESSION_REVOKED", "OAUTH_TOKEN_REQUEST_FAILED",
    "OAUTH_TOKEN_RESPONSE_INVALID", "OAUTH_TOKEN_RESPONSE_TOO_LARGE", "OAUTH_TOKEN_TIMEOUT"]);
  return typeof code === "string" && allowed.has(code)
    ? code : "DRIVE_UNAVAILABLE";
}

export class DriveDesktopBroker {
  private binding = "";
  private lastRequest = 0;
  private busy = false;
  private closed = false;
  private abort = new AbortController();
  private session?: GoogleDriveAuthSession;
  private reader?: Reader;
  private connection = "";
  constructor(private readonly options: DriveBrokerOptions) {}
  close(): void {
    this.closed = true;
    this.abort.abort();
    this.reader?.clear();
    this.session?.close();
    this.reader = undefined;
    this.session = undefined;
    this.connection = "";
  }
  private newReader(): Reader {
    if (!this.session) deny("DRIVE_NOT_CONNECTED");
    return this.options.createReader?.(this.session) ?? new GoogleDriveReader({ accessToken: () => this.session!.accessToken() });
  }
  async handle(input: unknown, emit: (event: object) => void = () => {}): Promise<object> {
    let request: DriveRequest;
    try { request = parse(input); } catch {
      return { schema: RESPONSE, ok: false, error: { code: "DRIVE_REQUEST_DENIED" } };
    }
    const r = request;
    const base = { schema: RESPONSE, ...identity(r), operation: r.operation, purpose: "local_view", externalEgress: "denied" };
    let acquired = false;
    try {
      if (this.closed) deny("DRIVE_CLOSED");
      if (this.busy) deny("DRIVE_BUSY");
      const binding = JSON.stringify([r.projectId, r.documentPath, r.projectRevision]);
      if (this.binding && this.binding !== binding) {
        this.close();
        deny("DRIVE_PROJECT_CHANGED");
      }
      if (r.requestId <= this.lastRequest) deny("DRIVE_REQUEST_DENIED");
      this.lastRequest = r.requestId;
      this.binding = binding;
      if (r.connectionId !== this.connection) deny("DRIVE_CONNECTION_CHANGED");
      this.busy = acquired = true;
      let result: object;
      if (r.operation === "status") {
        result = { configured: this.options.enabled && configurationValid(this.options), connected: !!this.session };
      } else if (r.operation === "disconnect") {
        this.reader?.clear(); this.session?.close();
        this.reader = undefined; this.session = undefined; this.connection = "";
        result = {};
      } else {
        if (!this.options.enabled) deny("DRIVE_DISABLED");
        if (!configurationValid(this.options)) deny("DRIVE_NOT_CONFIGURED");
        if (r.operation === "connect") {
          if (this.session) deny("DRIVE_ALREADY_CONNECTED");
          try {
            this.session = await (this.options.authorize ?? authorizeGoogleDrive)({
              clientId: this.options.clientId!, clientSecret: this.options.clientSecret, signal: this.abort.signal,
              onAuthorizationUrl: url => { if (!this.closed) emit({ schema: EVENT, ...identity(r), event: "authorize", url }); }
            });
            if (this.closed) { this.session.close(); this.session = undefined; deny("DRIVE_CLOSED"); }
            this.reader = this.newReader();
            const account = await this.reader.account();
            const page = await this.reader.browseFolders();
            if (this.closed) deny("DRIVE_CLOSED");
            this.connection = randomBytes(32).toString("hex");
            result = { connectionId: this.connection, account, page };
          } catch (error) {
            this.reader?.clear(); this.session?.close();
            this.reader = undefined; this.session = undefined; this.connection = "";
            throw error;
          }
        } else {
          if (!this.reader || !this.session) deny("DRIVE_NOT_CONNECTED");
          switch (r.operation) {
            case "browse-folders": result = { page: await this.reader.browseFolders(r.folderId, r.cursor) }; break;
            case "select-folder": {
              const scope = await this.reader.selectRoot(r.folderReference!);
              result = { ...scope, page: await this.reader.list() }; break;
            }
            case "list": result = { page: await this.reader.list(r.folderId, r.cursor) }; break;
            case "read": result = { document: await this.reader.read(r.fileId!, r.expectedVersion!) }; break;
            case "choose-folder":
              this.reader.clear(); this.reader = this.newReader();
              result = { page: await this.reader.browseFolders() }; break;
            default: deny();
          }
        }
      }
      if (this.closed) deny("DRIVE_CLOSED");
      return { ...base, ok: true, result };
    } catch (error) {
      return { ...base, ok: false, error: { code: safeCode(error) } };
    } finally { if (acquired) this.busy = false; }
  }
}

export async function runDriveDesktop(options: DriveBrokerOptions, input: Readable = process.stdin,
  output: Writable = process.stdout): Promise<void> {
  const broker = new DriveDesktopBroker(options);
  let pending = Buffer.alloc(0);
  let ended = false;
  let stop = () => {};
  const write = (value: object) => {
    if (ended) return;
    const line = JSON.stringify(value) + "\n";
    if (output.writableLength + Buffer.byteLength(line) > 2 * 1024 * 1024) { stop(); return; }
    output.write(line);
  };
  await new Promise<void>(resolve => {
    const finish = () => {
      if (ended) return;
      ended = true; broker.close(); pending = Buffer.alloc(0);
      input.off("data", data); input.off("end", finish); input.off("error", finish); output.off("error", finish);
      input.pause(); resolve();
    };
    stop = finish;
    const data = (chunk: Buffer | string) => {
      if (Buffer.byteLength(chunk) > 64 * 1024) { finish(); return; }
      pending = Buffer.concat([pending, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      let newline: number;
      while ((newline = pending.indexOf(10)) >= 0) {
        if (newline > MAX_LINE) { finish(); return; }
        const line = pending.subarray(0, newline).toString("utf8");
        pending = pending.subarray(newline + 1);
        let request: unknown;
        try { request = JSON.parse(line); } catch { finish(); return; }
        void broker.handle(request, write).then(write, () => finish());
      }
      if (pending.length > MAX_LINE) finish();
    };
    input.on("data", data); input.once("end", finish); input.once("error", finish); output.once("error", finish);
  });
}
