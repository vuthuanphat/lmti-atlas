import type { ApiResult, ErrorCode } from '../../web-api/src/contracts';

export class RequestError extends Error {
  constructor(public code: ErrorCode | 'NETWORK', message: string) { super(message); }
}
// Capability stays in this module's closure; never persisted, logged or sent to agents.
let bearer: string | undefined;
type AuthenticationFailure = 'UNAUTHENTICATED' | 'SESSION_EXPIRED';
export type ServiceConnection = 'unknown' | 'reachable' | 'unreachable';
let serviceConnection: ServiceConnection = 'unknown';
const connectionListeners = new Set<(state: ServiceConnection) => void>();
export const getServiceConnection = () => serviceConnection;
export function subscribeServiceConnection(listener: (state: ServiceConnection) => void): () => void {
  connectionListeners.add(listener);
  return () => { connectionListeners.delete(listener); };
}
function connectionChanged(state: ServiceConnection) {
  serviceConnection = state;
  for (const listener of [...connectionListeners]) {
    try { listener(state); } catch { /* Presentation cannot change request semantics. */ }
  }
}
const sessionInvalidated = new Set<(code: AuthenticationFailure) => void>();
export function subscribeSessionInvalidated(listener: (code: AuthenticationFailure) => void): () => void {
  sessionInvalidated.add(listener);
  return () => { sessionInvalidated.delete(listener); };
}
function invalidateSession(code: AuthenticationFailure) {
  bearer = undefined;
  // Notify synchronously before a panel can catch the rejected request locally.
  // One observer must not prevent other cleanup or replace the API error.
  for (const listener of [...sessionInvalidated]) {
    try { listener(code); } catch { /* The original authentication error remains authoritative. */ }
  }
}
export async function request<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  if (!path.startsWith('/api/v1/')) throw new Error('Invalid API route');
  let response: Response;
  try {
    response = await fetch(path, { method, signal, credentials: 'omit', cache: 'no-store',
      headers: { 'X-LMTI-UI': '1', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    connectionChanged('unreachable');
    throw new RequestError('NETWORK', 'The local service could not be reached.');
  }
  let result: ApiResult<T>;
  try { result = await response.json(); } catch { connectionChanged('unreachable'); throw new RequestError('NETWORK', 'The local service response could not be read.'); }
  if (!result || result.apiVersion !== 1) { connectionChanged('unreachable'); throw new RequestError('NETWORK', 'Unsupported service response.'); }
  connectionChanged('reachable');
  if (!result.ok) {
    if (result.error.code === 'UNAUTHENTICATED' || result.error.code === 'SESSION_EXPIRED') invalidateSession(result.error.code);
    throw new RequestError(result.error.code, result.error.message);
  }
  return result.data;
}
export async function bootstrap(): Promise<void> {
  const fragment = location.hash;
  history.replaceState(null, '', location.pathname);
  const nonce = /^#bootstrap=([A-Za-z0-9_-]{43})$/.exec(fragment)?.[1];
  if (!nonce) throw new RequestError('UNAUTHENTICATED', 'Open LMTI using its local launcher to start a private session.');
  const session = await request<{ token: string }>('/api/v1/session/bootstrap', 'POST', { nonce });
  bearer = session.token;
}
export async function signOut() { try { await request('/api/v1/session', 'DELETE'); } finally { bearer = undefined; } }
