import type { UpstreamRead, UpstreamTransport } from './sources';

const apiBaseUrl = () => process.env.PSS_API_BASE_URL ?? 'http://127.0.0.1:4000';

/**
 * The BFF's only way to reach a domain. The caller's own access token is forwarded so the
 * domain resolves and authorizes the acting user itself (AGENTS.md §15, RBAC-002); the BFF
 * never claims an identity of its own. `method` comes from the read itself and is always
 * `'GET'`, so this function can never be used to mutate (PLT-008.NC01).
 */
export const httpUpstreamTransport: UpstreamTransport = (read: UpstreamRead) =>
  fetch(`${apiBaseUrl()}${read.path}`, {
    method: read.method,
    headers: { authorization: `Bearer ${read.accessToken}` },
    cache: 'no-store',
  });
