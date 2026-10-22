/** Attempt server revocation once, but always end the local UI session.
 * A rejected revocation remains rejected; local cleanup never claims success
 * on the server and cannot depend on a working connection to the owner.
 */
export async function endLocalSession(revoke: () => Promise<unknown>, clearLocal: () => void): Promise<void> {
  try { await revoke(); }
  finally { clearLocal(); }
}
