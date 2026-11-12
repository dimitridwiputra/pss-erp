import type { UpstreamRead, UpstreamTransport } from '../experience/sources';

/**
 * The two upstreams the BFF reads, kept apart because they are two services: `apps/api` serves the
 * core domains and `apps/finance-api` serves accounting. A read carries the caller's own access token
 * and the domain resolves and authorizes the acting user itself, so the BFF never claims an identity
 * of its own (AGENTS.md §15, RBAC-002).
 *
 * `method` is the literal `'GET'` in the type, so neither transport can express a mutation
 * (PLT-008.NC01) — the same guarantee `httpUpstreamTransport` gives for the core API, applied to the
 * finance one, which had no server-side reader yet.
 */
export const coreBaseUrl = (): string => process.env.PSS_API_BASE_URL ?? 'http://127.0.0.1:4000';
export const financeBaseUrl = (): string => process.env.PSS_FINANCE_API_BASE_URL ?? 'http://127.0.0.1:4001';

function getOnly(baseUrl: () => string, label: string): UpstreamTransport {
  return (read: UpstreamRead) => {
    if (read.method !== 'GET') {
      // Unreachable through the type. Thrown rather than ignored so a widened type fails loudly here
      // rather than posting something through a reader.
      throw new Error(`${label} transport is read-only; ${read.method} is not expressible.`);
    }
    return fetch(`${baseUrl()}${read.path}`, {
      method: read.method,
      headers: { authorization: `Bearer ${read.accessToken}` },
      cache: 'no-store',
    });
  };
}

export const coreTransport: UpstreamTransport = getOnly(coreBaseUrl, 'core');
export const financeTransport: UpstreamTransport = getOnly(financeBaseUrl, 'finance');
