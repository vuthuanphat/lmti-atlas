/** Attempt server revocation once, but always end the local UI session.
 * A rejected revocation remains rejected; local cleanup never claims success
 * on the server and cannot depend on a working connection to the owner.
 */
export async function endLocalSession(revoke: () => Promise<unknown>, clearLocal: () => void): Promise<void> {
  try { await revoke(); }
  finally { clearLocal(); }
}

export type SessionEndReason = 'signed_out' | 'expired' | 'unauthenticated' | 'startup_network' | 'startup_refused';
export function sessionFailureReason(code: string, startup = false): SessionEndReason | null {
  if (code === 'SESSION_EXPIRED') return 'expired';
  if (code === 'UNAUTHENTICATED') return 'unauthenticated';
  if (!startup) return null;
  return code === 'NETWORK' ? 'startup_network' : 'startup_refused';
}

/** A connection check is one read only. It never starts a session, replays a
 * write or changes any caller-owned preview, unknown result or recovery gate. */
export async function checkServiceConnection(read: (path: string, method: string) => Promise<unknown>): Promise<void> {
  await read('/api/v1/write-status', 'GET');
}
