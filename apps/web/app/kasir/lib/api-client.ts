import type { ProblemDetails } from '@pss/contracts';

/** A refusal from the server, with its registered Indonesian copy. */
export class KasirApiError extends Error {
  constructor(readonly problem: ProblemDetails) {
    super(problem.message);
  }
}

/** The request never got an answer; the same Idempotency-Key must be reused on retry. */
export class KasirNetworkError extends Error {
  constructor() {
    super('Koneksi terputus. Periksa internet lalu coba lagi.');
  }
}

/** Every mutating /pos call needs a client-generated Idempotency-Key (PLT-006). */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

/** API paths such as `/pos/shifts` go through the web BFF proxy, which attaches the session token server-side. */
const BFF_CORE_PREFIX = '/api/bff/core';

export async function kasirFetch<T>(path: string, init?: RequestInit & { idempotencyKey?: string }): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set('content-type', 'application/json');
  if (init?.idempotencyKey) headers.set('idempotency-key', init.idempotencyKey);
  let response: Response;
  try {
    response = await fetch(`${BFF_CORE_PREFIX}${path}`, { ...init, headers, credentials: 'same-origin', cache: 'no-store' });
  } catch {
    throw new KasirNetworkError();
  }
  if (!response.ok) {
    const problem = (await response.json().catch(() => null)) as ProblemDetails | null;
    if (problem?.code) throw new KasirApiError(problem);
    throw new KasirNetworkError();
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** The problem to show for a failed call, or null for a network failure. */
export function problemOf(error: unknown): ProblemDetails | null {
  return error instanceof KasirApiError ? error.problem : null;
}
