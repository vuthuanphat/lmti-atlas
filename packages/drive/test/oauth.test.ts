import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { request } from "node:http";
import {
  authorizeGoogleDrive, GOOGLE_DRIVE_SCOPE, OAuthError,
  type GoogleDriveAuthSession, type GoogleDriveOAuthOptions,
} from "../src/oauth.js";

const CLIENT = "123456-synthetic.apps.googleusercontent.com";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const controllers: AbortController[] = [], sessions: GoogleDriveAuthSession[] = [];
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.abort();
  for (const session of sessions.splice(0)) session.close();
});

function token(fields: Record<string, unknown> = {}, status = 200): Response {
  return Response.json({ access_token: "synthetic-access", refresh_token: "synthetic-refresh",
    expires_in: 100, token_type: "Bearer", scope: GOOGLE_DRIVE_SCOPE, ...fields }, { status });
}
function mockFetch(response: Response = token()) {
  return vi.fn<typeof fetch>(async () => response);
}
function begin(options: Partial<GoogleDriveOAuthOptions> = {}) {
  const controller = new AbortController(); controllers.push(controller);
  let announce!: (url: URL) => void;
  const url = new Promise<URL>(resolve => { announce = resolve; });
  const promise = authorizeGoogleDrive({ clientId: CLIENT, fetch: mockFetch(),
    onAuthorizationUrl: value => announce(new URL(value)), signal: controller.signal, ...options });
  // Register both outcomes immediately so an intentionally failing callback is handled.
  void promise.then(session => sessions.push(session), () => undefined);
  return { url, promise, controller };
}
type Flow = ReturnType<typeof begin>;
function callback(auth: URL, options: { state?: string; suffix?: string; method?: string; host?: string; path?: string; error?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; text: string }> {
  const redirect = new URL(auth.searchParams.get("redirect_uri")!);
  const query = new URLSearchParams({ state: options.state ?? auth.searchParams.get("state")!,
    ...(options.error ? { error: options.error } : { code: "synthetic-auth-code" }) });
  return new Promise((resolve, reject) => {
    const call = request({ hostname: redirect.hostname, port: redirect.port, method: options.method ?? "GET",
      path: options.path ?? `${redirect.pathname}?${query}${options.suffix ?? ""}`,
      headers: { Host: options.host ?? redirect.host, ...options.headers } }, response => {
      let text = "";
      response.setEncoding("utf8"); response.on("data", data => { text += data; });
      response.on("end", () => resolve({ status: response.statusCode!, text }));
      response.on("error", reject);
    });
    call.setTimeout(2000, () => call.destroy(new Error("Synthetic callback timed out")));
    call.on("error", reject); call.end();
  });
}
async function complete(flow: Flow): Promise<GoogleDriveAuthSession> {
  expect((await callback(await flow.url)).status).toBe(200);
  return flow.promise;
}

describe("dedicated session-only Google Drive OAuth", () => {
  it("uses an external authorization URL, random state, PKCE S256 and the pinned token endpoint", async () => {
    const fetcher = mockFetch(), flow = begin({ fetch: fetcher });
    const url = await flow.url;
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("scope")).toBe(GOOGLE_DRIVE_SCOPE);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(url.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth2\/callback$/u);
    const session = await complete(flow);
    expect(await session.accessToken()).toBe("synthetic-access");
    const [endpoint, init] = fetcher.mock.calls[0];
    expect(endpoint).toBe(TOKEN_URL); expect(init?.method).toBe("POST"); expect(init?.redirect).toBe("error");
    const body = new URLSearchParams(String(init?.body));
    expect(body.get("client_id")).toBe(CLIENT); expect(body.has("client_secret")).toBe(false);
    expect(body.get("code")).toBe("synthetic-auth-code");
    expect(body.get("redirect_uri")).toBe(url.searchParams.get("redirect_uri"));
    const verifier = body.get("code_verifier")!;
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(url.searchParams.get("code_challenge"));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(Object.keys(session).sort()).toEqual(["accessToken", "close"]);
    expect(JSON.stringify(session)).toBe("{}");
  });

  it("rejects stray state, duplicate queries and nonexact callback boundaries without cancelling login", async () => {
    const fetcher = mockFetch(), flow = begin({ fetch: fetcher }), url = await flow.url;
    const attempts = [
      { state: "incorrect-state" }, { suffix: "&state=duplicate" }, { suffix: "&unexpected=value" },
      { method: "POST" }, { host: "localhost:123" }, { path: "/other?state=bad" },
      { path: "/other/../oauth2/callback?state=bad" }, { suffix: "&error_description=%00" },
      { headers: { "Content-Length": "1" } },
    ];
    for (const attempt of attempts) expect((await callback(url, attempt)).status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
    const session = await complete(flow);
    expect(await session.accessToken()).toBe("synthetic-access");
  });

  it("consumes a callback only once and closes its listener", async () => {
    const fetcher = mockFetch(), flow = begin({ fetch: fetcher }), url = await flow.url;
    await complete(flow);
    await expect(callback(url)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
    const second = begin();
    expect((await second.url).searchParams.get("state")).not.toBe(url.searchParams.get("state"));
    second.controller.abort();
    await expect(second.promise).rejects.toMatchObject({ code: "OAUTH_CANCELLED" });
  });

  it("rejects oversized callback headers without disabling the valid login", async () => {
    const flow = begin(), url = await flow.url;
    await expect(callback(url, { headers: { "X-Synthetic-Limit": "x".repeat(9000) } })).rejects.toThrow();
    const session = await complete(flow);
    expect(await session.accessToken()).toBe("synthetic-access");
  });

  it("returns a constant denial response and never reflects provider errors", async () => {
    const fetcher = mockFetch(), flow = begin({ fetch: fetcher });
    const response = await callback(await flow.url, { error: "synthetic-private-error", suffix: "&error_description=synthetic-private-detail" });
    expect(response.status).toBe(200); expect(response.text).not.toContain("synthetic-private");
    await expect(flow.promise).rejects.toMatchObject({ code: "OAUTH_ACCESS_DENIED", message: "OAUTH_ACCESS_DENIED" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([undefined, "", `${GOOGLE_DRIVE_SCOPE} https://www.googleapis.com/auth/drive`, "https://www.googleapis.com/auth/drive.file"])(
    "fails closed when the granted token scope is missing or different (%s)", async scope => {
      const flow = begin({ fetch: mockFetch(token({ scope })) });
      await expect(complete(flow)).rejects.toMatchObject({ code: "OAUTH_SCOPE_DENIED" });
    });

  it("bounds token response headers and streamed content independently", async () => {
    for (const response of [new Response("{}", { headers: { "Content-Length": "65537" } }), new Response("x".repeat(65537))]) {
      await expect(complete(begin({ fetch: mockFetch(response) }))).rejects.toMatchObject({ code: "OAUTH_TOKEN_RESPONSE_TOO_LARGE" });
    }
  });

  it("sanitizes transport/provider failures and rejects malformed responses", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => { throw new Error("synthetic-private-network-content"); });
    await expect(complete(begin({ fetch: fetcher }))).rejects.toMatchObject({ message: "OAUTH_TOKEN_REQUEST_FAILED" });
    for (const response of [new Response("synthetic-private-non-json"), token({ token_type: "MAC" }), token({ access_token: "bad\nvalue" }), token({ expires_in: 0 })]) {
      await expect(complete(begin({ fetch: mockFetch(response) }))).rejects.toMatchObject({ message: "OAUTH_TOKEN_RESPONSE_INVALID" });
    }
    await expect(complete(begin({ fetch: mockFetch(token({ error: "synthetic-private-provider-error" }, 400)) })))
      .rejects.toMatchObject({ message: "OAUTH_TOKEN_REQUEST_FAILED" });
  });

  it("keeps optional developer client secret only in token exchange, never authorization URL", async () => {
    const fetcher = mockFetch(), flow = begin({ clientSecret: "synthetic-developer-configuration", fetch: fetcher });
    expect((await flow.url).href).not.toContain("synthetic-developer-configuration");
    await complete(flow);
    expect(new URLSearchParams(String(fetcher.mock.calls[0][1]?.body)).get("client_secret")).toBe("synthetic-developer-configuration");
  });

  it("rejects malformed developer configuration before opening a listener", async () => {
    const announce = vi.fn();
    for (const options of [{ clientId: "https://untrusted.example" }, { clientId: "123.apps.googleusercontent.com.evil.example" },
      { clientSecret: "synthetic\ninvalid" }, { clientSecret: "x".repeat(513) }, { authorizationTimeoutMs: 300001 }, { tokenTimeoutMs: 15001 }]) {
      await expect(authorizeGoogleDrive({ clientId: CLIENT, onAuthorizationUrl: announce, ...options }))
        .rejects.toMatchObject({ code: "OAUTH_CONFIGURATION_INVALID" });
    }
    expect(announce).not.toHaveBeenCalled();
  });

  it("cancels before or during browser login and bounds the authorization wait", async () => {
    const abort = new AbortController(); abort.abort();
    const announce = vi.fn();
    await expect(authorizeGoogleDrive({ clientId: CLIENT, onAuthorizationUrl: announce, signal: abort.signal })).rejects.toMatchObject({ code: "OAUTH_CANCELLED" });
    expect(announce).not.toHaveBeenCalled();
    const flow = begin(), url = await flow.url;
    flow.controller.abort();
    await expect(flow.promise).rejects.toMatchObject({ code: "OAUTH_CANCELLED" });
    await expect(callback(url)).rejects.toThrow();
    const expiring = begin({ authorizationTimeoutMs: 25 });
    await expect(expiring.promise).rejects.toMatchObject({ code: "OAUTH_AUTHORIZATION_TIMEOUT" });
  });

  it("bounds token exchange time even when an injected transport ignores AbortSignal", async () => {
    const fetcher = vi.fn<typeof fetch>(() => new Promise<Response>(() => undefined));
    const flow = begin({ fetch: fetcher, tokenTimeoutMs: 25 });
    await expect(complete(flow)).rejects.toMatchObject({ code: "OAUTH_TOKEN_TIMEOUT" });
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it("cancels rejected and stalled token response bodies so they cannot retain a connection", async () => {
    const refused = vi.fn();
    const overLimit = new Response(new ReadableStream<Uint8Array>({ cancel: refused }), { headers: { "Content-Length": "65537" } });
    await expect(complete(begin({ fetch: mockFetch(overLimit) }))).rejects.toMatchObject({ code: "OAUTH_TOKEN_RESPONSE_TOO_LARGE" });
    expect(refused).toHaveBeenCalledOnce();
    const stalled = vi.fn();
    const stream = new Response(new ReadableStream<Uint8Array>({ cancel: stalled }));
    await expect(complete(begin({ fetch: mockFetch(stream), tokenTimeoutMs: 25 }))).rejects.toMatchObject({ code: "OAUTH_TOKEN_TIMEOUT" });
    expect(stalled).toHaveBeenCalledOnce();
  });

  it("serializes refresh, uses the latest rotated token and caches only until its safety margin", async () => {
    let now = 0;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(token())
      .mockResolvedValueOnce(token({ access_token: "synthetic-next-access", refresh_token: "synthetic-next-refresh" }))
      .mockResolvedValueOnce(token({ access_token: "synthetic-third-access", refresh_token: undefined }));
    const session = await complete(begin({ fetch: fetcher, now: () => now }));
    expect(await session.accessToken()).toBe("synthetic-access");
    now = 90_000;
    expect(await Promise.all([session.accessToken(), session.accessToken(), session.accessToken()]))
      .toEqual(["synthetic-next-access", "synthetic-next-access", "synthetic-next-access"]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const firstRefresh = new URLSearchParams(String(fetcher.mock.calls[1][1]?.body));
    expect(firstRefresh.get("grant_type")).toBe("refresh_token");
    expect(firstRefresh.get("refresh_token")).toBe("synthetic-refresh");
    expect(firstRefresh.has("code")).toBe(false); expect(firstRefresh.has("code_verifier")).toBe(false);
    now = 180_000;
    expect(await session.accessToken()).toBe("synthetic-third-access");
    expect(new URLSearchParams(String(fetcher.mock.calls[2][1]?.body)).get("refresh_token")).toBe("synthetic-next-refresh");
    for (const [endpoint, init] of fetcher.mock.calls) { expect(endpoint).toBe(TOKEN_URL); expect(init?.redirect).toBe("error"); }
  });

  it.each([token({ error: "invalid_grant", error_description: "synthetic-private-revocation" }, 400),
    token({ scope: `${GOOGLE_DRIVE_SCOPE} extra-scope` }), token({}, 401)])(
    "permanently clears a session after refresh revocation or scope widening", async response => {
      let now = 0;
      const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(token()).mockResolvedValueOnce(response);
      const session = await complete(begin({ fetch: fetcher, now: () => now })); now = 100_000;
      await expect(session.accessToken()).rejects.toBeInstanceOf(OAuthError);
      await expect(session.accessToken()).rejects.toMatchObject({ code: "OAUTH_SESSION_CLOSED" });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

  it("expires without an available refresh token and does not attempt a network fallback", async () => {
    let now = 0;
    const fetcher = mockFetch(token({ refresh_token: undefined, expires_in: 1 }));
    const session = await complete(begin({ fetch: fetcher, now: () => now })); now = 1000;
    await expect(session.accessToken()).rejects.toMatchObject({ code: "OAUTH_SESSION_EXPIRED" });
    await expect(session.accessToken()).rejects.toMatchObject({ code: "OAUTH_SESSION_CLOSED" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("close cancels pending refresh and never revokes a remote grant", async () => {
    let now = 0, started!: () => void;
    const refreshStarted = new Promise<void>(resolve => { started = resolve; });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(token()).mockImplementationOnce(async () => {
      started(); return new Promise<Response>(() => undefined);
    });
    const session = await complete(begin({ fetch: fetcher, now: () => now })); now = 100_000;
    const refreshing = session.accessToken();
    const rejected = expect(refreshing).rejects.toMatchObject({ code: "OAUTH_CANCELLED" });
    await refreshStarted; session.close(); session.close(); await rejected;
    await expect(session.accessToken()).rejects.toMatchObject({ code: "OAUTH_SESSION_CLOSED" });
    expect(fetcher.mock.calls[1][1]?.signal?.aborted).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
