/** Postgres SQLSTATE 23505 (unique_violation); see https://www.postgresql.org/docs/current/errcodes-appendix.html. */
const UNIQUE_VIOLATION_SQLSTATE = '23505';

export function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === UNIQUE_VIOLATION_SQLSTATE;
}
