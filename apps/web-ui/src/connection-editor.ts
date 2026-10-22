import type { McpServerDto } from '../../web-api/src/contracts';

export type ConnectionField = 'label' | 'key' | 'site' | 'endpoint';
export type ConnectionDraft = { kind: string; label: string; key: string; site: string; endpoint: string; enabled: boolean };
export type ConnectionValidation = { ok: true; server: McpServerDto } | { ok: false; field: ConnectionField; message: string };

export const connectionLimits = { label: 120, site: 64, endpoint: 512 } as const;
const controls = /[\x00-\x1f\x7f-\x9f]/;
const byteLength = (value: string) => new TextEncoder().encode(value).length;
// Check the original input before trimming: a tab/newline must not be silently
// erased, and lone surrogates must not become replacement characters in UTF-8.
const validText = (value: string, cap: number) => !controls.test(value) &&
  !/[\uD800-\uDFFF]/u.test(value) && value.trim().length > 0 && byteLength(value.trim()) <= cap;

/** UI preflight only. The native owner still validates authority and metadata. */
export function validateConnectionDraft(draft: ConnectionDraft): ConnectionValidation {
  if (!validText(draft.label, connectionLimits.label)) return { ok: false, field: 'label', message: 'Name must contain 1–120 UTF-8 bytes without control characters.' };
  if (controls.test(draft.key) || !/^[a-z][a-z0-9_-]{0,47}$/.test(draft.key.trim())) return { ok: false, field: 'key', message: 'Server key must start with a lowercase letter and contain up to 48 lowercase letters, digits, underscores or hyphens.' };
  const base = { id: draft.key.trim(), label: draft.label.trim(), enabled: draft.enabled };
  if (draft.kind === 'local') {
    if (!validText(draft.site, connectionLimits.site)) return { ok: false, field: 'site', message: 'Site must contain 1–64 UTF-8 bytes without control characters.' };
    return { ok: true, server: { ...base, transport: 'lmti_local', auth: 'none', site: draft.site.trim() } };
  }
  if (!validText(draft.endpoint, connectionLimits.endpoint)) return { ok: false, field: 'endpoint', message: 'Endpoint must contain 1–512 UTF-8 bytes without control characters.' };
  const endpoint = draft.endpoint.trim();
  try {
    const url = new URL(endpoint);
    if (!endpoint.startsWith('https://') || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || /[?#@\\ "<>{}]/.test(endpoint)) throw new Error();
  } catch { return { ok: false, field: 'endpoint', message: 'Use an HTTPS MCP endpoint without credentials, query parameters, fragments or spaces.' }; }
  return { ok: true, server: { ...base, transport: 'remote_https', auth: 'client_oauth', endpoint, privateEndpoint: draft.kind === 'private' } };
}
