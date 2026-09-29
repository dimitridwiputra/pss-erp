import { createHash } from 'node:crypto';
import { MalformedRequestError } from '@pss/contracts';
import type { ObservedRequest } from '@pss/observability';

/**
 * Reads the `Idempotency-Key` header required by any command matching
 * `@pss/platform`'s `withIdempotentCommand` (PLT-006 / AGENTS.md L.3). Throws a
 * `MalformedRequestError` (HTTP 400) when the header is missing — a missing key is a
 * malformed request, not a domain-level `IDEMPOTENCY_KEY_REQUIRED` rejection, since the
 * caller never reached business logic.
 */
export function readIdempotencyKey(request: ObservedRequest): string {
  const raw = request.headers['idempotency-key'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || value.length < 1 || value.length > 200) {
    throw new MalformedRequestError([{ path: 'Idempotency-Key', code: 'required', message: 'Header Idempotency-Key wajib diisi.' }]);
  }
  return value;
}

/** Canonical sha256 hex digest of a JSON-serializable request body, matching `CommandKeySchema.requestHash` in `@pss/platform`. */
export function hashRequestBody(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body ?? null)).digest('hex');
}
