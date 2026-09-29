import type { ProblemDetails } from '@pss/contracts';

export class KasirApiError extends Error {
  constructor(readonly problem: ProblemDetails) {
    super(problem.message);
  }
}

/** Every mutating /kasir or /pos call needs a client-generated Idempotency-Key (POS-013.R01, PLT-006). */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

export async function kasirFetch<T>(path: string, init?: RequestInit & { idempotencyKey?: string }): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set('content-type', 'application/json');
  if (init?.idempotencyKey) headers.set('idempotency-key', init.idempotencyKey);
  const response = await fetch(path, { ...init, headers, credentials: 'include' });
  if (!response.ok) {
    const problem = (await response.json().catch(() => null)) as ProblemDetails | null;
    if (problem) throw new KasirApiError(problem);
    throw new Error(`Permintaan gagal (${response.status}).`);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}
