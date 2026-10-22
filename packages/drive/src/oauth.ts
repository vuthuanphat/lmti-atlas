import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";

export const GOOGLE_DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
const AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const MAX_TOKEN_BYTES = 64 * 1024;

export class OAuthError extends Error {
  constructor(public readonly code: string) { super(code); this.name = "OAuthError"; }
}
export interface GoogleDriveAuthSession {
  accessToken(): Promise<string>;
  /** Forget this local session; does not revoke any remote grant. */
  close(): void;
}
export interface GoogleDriveOAuthOptions {
  /** Installed-application registration selected by the trusted package/launcher. */
  clientId: string; clientSecret?: string;
  /** Send this URL to the desktop's external-browser action, never an Agent tool. */
  onAuthorizationUrl: (url: string) => void;
  signal?: AbortSignal;
  /** Trusted injection seams for tests; never request/CLI arguments. */
  fetch?: typeof fetch; now?: () => number;
  authorizationTimeoutMs?: number; tokenTimeoutMs?: number;
}
function fail(code: string): never { throw new OAuthError(code); }
function timeout(value: number | undefined, maximum: number): number {
  if (value === undefined) return maximum;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) fail("OAUTH_CONFIGURATION_INVALID");
  return value;
}
function validClient(value: unknown): string {
  if (typeof value !== "string" || value.length > 256 || !/^[A-Za-z0-9][A-Za-z0-9_-]*\.apps\.googleusercontent\.com$/u.test(value)) fail("OAUTH_CONFIGURATION_INVALID");
  return value;
}
function opaqueToken(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 8192 || /[^\x21-\x7e]/u.test(value)) fail("OAUTH_TOKEN_RESPONSE_INVALID");
  return value;
}
function send(response: ServerResponse, status: number, text: string): void {
  response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", Connection: "close" });
  response.end(text);
}
function sameState(actual: string, expected: string): boolean {
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
async function authorizationCode(clientId: string, callback: (url: string) => void, signal: AbortSignal | undefined, maxMs: number): Promise<{ code: string; verifier: string; redirectUri: string }> {
  const verifier = randomBytes(32).toString("base64url"), state = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return new Promise((resolve, reject) => {
    let settled = false, redirectUri = "", expectedHost = "";
    const sockets = new Set<Socket>();
    const server = createServer({ maxHeaderSize: 8192, connectionsCheckingInterval: 1000 }, (request: IncomingMessage, response: ServerResponse) => {
      if (settled) { send(response, 409, "This authorization request has finished."); return; }
      const hostHeaders = request.rawHeaders.filter((_value, index, headers) => index % 2 === 0 && headers[index].toLowerCase() === "host").length;
      if (request.method !== "GET" || hostHeaders !== 1 || request.headers.host !== expectedHost || (request.headers["content-length"] !== undefined && request.headers["content-length"] !== "0") || request.headers["transfer-encoding"] !== undefined || !request.url || request.url.length > 8192 || !request.url.startsWith("/oauth2/callback?")) {
        send(response, 400, "Invalid authorization callback."); return;
      }
      let url: URL;
      try { url = new URL(request.url, redirectUri); } catch { send(response, 400, "Invalid authorization callback."); return; }
      const fields = new Set(["code", "state", "scope", "authuser", "prompt", "hd", "iss", "error", "error_description"]);
      const keys = [...url.searchParams.keys()];
      if (url.origin !== `http://${expectedHost}` || url.pathname !== "/oauth2/callback" || url.hash || keys.length > fields.size || new Set(keys).size !== keys.length || keys.some(key => !fields.has(key)) || [...url.searchParams.values()].some(value => value.length > 4096 || /[\x00-\x1f\x7f]/u.test(value))) {
        send(response, 400, "Invalid authorization callback."); return;
      }
      if (!sameState(url.searchParams.get("state") ?? "", state)) {
        // A stray/hostile callback cannot cancel a real login still in progress.
        send(response, 400, "Invalid authorization state."); return;
      }
      const code = url.searchParams.get("code"), error = url.searchParams.get("error");
      if ((code && error) || (!code && !error)) { send(response, 400, "Invalid authorization callback."); return; }
      if (error) {
        send(response, 200, "Authorization was not completed. Return to LMTI.");
        finish(new OAuthError("OAUTH_ACCESS_DENIED"), undefined, request.socket); return;
      }
      send(response, 200, "Authorization received. You may close this tab and return to LMTI.");
      finish(undefined, code!, request.socket);
    });
    server.maxConnections = 8; server.maxRequestsPerSocket = 1;
    server.headersTimeout = 5000; server.requestTimeout = 5000; server.keepAliveTimeout = 1000;
    server.setTimeout(5000, socket => socket.destroy());
    server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
    const timer = setTimeout(() => finish(new OAuthError("OAUTH_AUTHORIZATION_TIMEOUT")), maxMs);
    function finish(error?: OAuthError, code?: string, answeredSocket?: Socket) {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener("abort", aborted);
      server.close();
      // Preserve the constant callback response while closing any unfinished peers.
      for (const socket of sockets) if (socket !== answeredSocket) socket.destroy();
      if (error) reject(error);
      else resolve({ code: code!, verifier, redirectUri });
    }
    const aborted = () => finish(new OAuthError("OAUTH_CANCELLED"));
    signal?.addEventListener("abort", aborted, { once: true });
    server.on("error", () => finish(new OAuthError("OAUTH_LISTENER_UNAVAILABLE")));
    server.on("clientError", (_error, socket) => { socket.destroy(); });
    if (signal?.aborted) { aborted(); return; }
    server.listen(0, "127.0.0.1", () => {
      if (settled) { server.close(); return; }
      const address = server.address();
      if (!address || typeof address === "string") { finish(new OAuthError("OAUTH_LISTENER_UNAVAILABLE")); return; }
      expectedHost = `127.0.0.1:${address.port}`;
      redirectUri = `http://${expectedHost}/oauth2/callback`;
      const url = new URL(AUTHORIZATION_ENDPOINT);
      url.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri,
        response_type: "code", scope: GOOGLE_DRIVE_SCOPE, code_challenge: challenge,
        code_challenge_method: "S256", state, access_type: "offline", prompt: "select_account" }).toString();
      try { callback(url.href); } catch { finish(new OAuthError("OAUTH_BROWSER_UNAVAILABLE")); }
    });
  });
}
interface TokenResult { accessToken: string; refreshToken?: string; expiresIn: number; }
async function tokenRequest(fetcher: typeof fetch, parameters: URLSearchParams, controller: AbortController, timeoutMs: number): Promise<TokenResult> {
  let timedOut = false, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new OAuthError(timedOut ? "OAUTH_TOKEN_TIMEOUT" : "OAUTH_CANCELLED"));
    controller.signal.addEventListener("abort", onAbort, { once: true });
    if (controller.signal.aborted) onAbort();
  });
  try {
    return await Promise.race([aborted, (async () => {
      const response = await fetcher(TOKEN_ENDPOINT, { method: "POST", redirect: "error", signal: controller.signal,
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: parameters.toString() });
      if (controller.signal.aborted) { void response.body?.cancel().catch(() => undefined); fail(timedOut ? "OAUTH_TOKEN_TIMEOUT" : "OAUTH_CANCELLED"); }
      if (!response.body) fail("OAUTH_TOKEN_RESPONSE_INVALID");
      reader = response.body.getReader();
      if (response.url && response.url !== TOKEN_ENDPOINT) fail("OAUTH_TOKEN_RESPONSE_INVALID");
      const length = response.headers.get("content-length");
      if (length !== null && (!/^\d+$/u.test(length) || Number(length) > MAX_TOKEN_BYTES)) fail("OAUTH_TOKEN_RESPONSE_TOO_LARGE");
      const parts: Uint8Array[] = []; let size = 0;
      for (;;) {
        const part = await reader.read();
        if (controller.signal.aborted) fail(timedOut ? "OAUTH_TOKEN_TIMEOUT" : "OAUTH_CANCELLED");
        if (part.done) break;
        size += part.value.byteLength;
        if (size > MAX_TOKEN_BYTES) fail("OAUTH_TOKEN_RESPONSE_TOO_LARGE");
        parts.push(part.value);
      }
      let data: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts)));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("OAUTH_TOKEN_RESPONSE_INVALID");
        data = parsed as Record<string, unknown>;
      } catch { fail("OAUTH_TOKEN_RESPONSE_INVALID"); }
      if (data.error === "invalid_grant" || response.status === 401 || response.status === 403) fail("OAUTH_SESSION_REVOKED");
      if (!response.ok || data.error !== undefined) fail("OAUTH_TOKEN_REQUEST_FAILED");
      if (typeof data.scope !== "string" || data.scope.trim() !== GOOGLE_DRIVE_SCOPE) fail("OAUTH_SCOPE_DENIED");
      if (data.token_type !== "Bearer" || typeof data.expires_in !== "number" || !Number.isSafeInteger(data.expires_in) || data.expires_in < 1 || data.expires_in > 86400) fail("OAUTH_TOKEN_RESPONSE_INVALID");
      return { accessToken: opaqueToken(data.access_token), expiresIn: data.expires_in,
        ...(data.refresh_token === undefined ? {} : { refreshToken: opaqueToken(data.refresh_token) }) };
    })()]);
  } catch (error) {
    if (error instanceof OAuthError) throw error;
    throw new OAuthError(controller.signal.aborted ? (timedOut ? "OAUTH_TOKEN_TIMEOUT" : "OAUTH_CANCELLED") : "OAUTH_TOKEN_REQUEST_FAILED");
  } finally {
    clearTimeout(timer); controller.signal.removeEventListener("abort", onAbort);
    void reader?.cancel().catch(() => undefined);
  }
}

/** Dedicated trusted desktop owner. No token is persisted, logged or given to an Agent. */
export async function authorizeGoogleDrive(options: GoogleDriveOAuthOptions): Promise<GoogleDriveAuthSession> {
  let clientId = validClient(options.clientId), clientSecret = options.clientSecret;
  if (clientSecret !== undefined && (typeof clientSecret !== "string" || !clientSecret || clientSecret.length > 512 || /[\x00-\x1f\x7f]/u.test(clientSecret))) fail("OAUTH_CONFIGURATION_INVALID");
  if (typeof options.onAuthorizationUrl !== "function") fail("OAUTH_CONFIGURATION_INVALID");
  const maxAuthorizationMs = timeout(options.authorizationTimeoutMs, 300_000), maxTokenMs = timeout(options.tokenTimeoutMs, 15_000);
  const fetcher = options.fetch ?? fetch, now = options.now ?? Date.now, signal = options.signal;
  if (typeof fetcher !== "function" || typeof now !== "function") fail("OAUTH_CONFIGURATION_INVALID");
  let closed = false, access = "", refresh = "", refreshAt = 0;
  let inFlight: Promise<string> | undefined, tokenController: AbortController | undefined;
  const close = () => {
    if (closed) return;
    closed = true; access = ""; refresh = ""; refreshAt = 0; clientId = ""; clientSecret = undefined;
    tokenController?.abort(); signal?.removeEventListener("abort", close);
  };
  signal?.addEventListener("abort", close, { once: true });
  function install(result: TokenResult): string {
    if (closed) fail("OAUTH_SESSION_CLOSED");
    const at = now();
    if (!Number.isFinite(at)) fail("OAUTH_CONFIGURATION_INVALID");
    access = result.accessToken;
    if (result.refreshToken) refresh = result.refreshToken;
    refreshAt = at + result.expiresIn * 1000 - Math.min(30_000, result.expiresIn * 100);
    return access;
  }
  function parameters(fields: Record<string, string>): URLSearchParams {
    return new URLSearchParams({ client_id: clientId, ...(clientSecret ? { client_secret: clientSecret } : {}), ...fields });
  }
  try {
    if (signal?.aborted) fail("OAUTH_CANCELLED");
    let flow = await authorizationCode(clientId, options.onAuthorizationUrl, signal, maxAuthorizationMs);
    if (closed) fail("OAUTH_SESSION_CLOSED");
    tokenController = new AbortController();
    try { install(await tokenRequest(fetcher, parameters({ grant_type: "authorization_code", code: flow.code,
      code_verifier: flow.verifier, redirect_uri: flow.redirectUri }), tokenController, maxTokenMs)); }
    finally { flow = { code: "", verifier: "", redirectUri: "" }; tokenController = undefined; }
  } catch (error) { close(); if (error instanceof OAuthError) throw error; fail("OAUTH_AUTHORIZATION_FAILED"); }
  return Object.freeze({
    close,
    async accessToken(): Promise<string> {
      if (closed) fail("OAUTH_SESSION_CLOSED");
      if (access && now() < refreshAt) return access;
      if (inFlight) return inFlight;
      if (!refresh) { close(); fail("OAUTH_SESSION_EXPIRED"); }
      tokenController = new AbortController();
      inFlight = (async () => {
        try { return install(await tokenRequest(fetcher, parameters({ grant_type: "refresh_token", refresh_token: refresh }), tokenController!, maxTokenMs)); }
        catch (error) {
          if (error instanceof OAuthError && ["OAUTH_SESSION_REVOKED", "OAUTH_SCOPE_DENIED", "OAUTH_TOKEN_RESPONSE_INVALID"].includes(error.code)) close();
          if (error instanceof OAuthError) throw error;
          fail("OAUTH_TOKEN_REQUEST_FAILED");
        } finally { tokenController = undefined; inFlight = undefined; }
      })();
      return inFlight;
    }
  });
}
