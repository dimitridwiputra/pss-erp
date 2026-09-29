/**
 * Retry and alert values are configuration in PRD Appendix N section 72 (`events.*`). The
 * defaults below are the registered values; changing one is a configuration change, not a
 * code change (AGENTS.md HIER.R06). They are named constants so no call site can invent a
 * backoff of its own.
 */

/** `events.retry_backoff` — 1s, 5s, 30s, 2m, 10m. */
export const EVENT_RETRY_BACKOFF_MS: readonly number[] = [1_000, 5_000, 30_000, 120_000, 600_000];

/** `events.archive_days` — at least one year, so a read model or DW loader can be rebuilt. */
export const EVENTS_ARCHIVE_DAYS = 400;

/** `events.dlq_alert_minutes` — an open dead letter older than this raises an alert (PLT-005.R02). */
export const EVENTS_DLQ_ALERT_MINUTES = 15;

/** `idempotency.retention_days` — the database also enforces this floor. */
export const IDEMPOTENCY_RETENTION_DAYS = 7;

/**
 * A replayed or discarded dead letter is kept for the archive window so the audit trail and the
 * operator's "what did we drop" question both still have an answer after the queue itself is clean.
 */
export const DEAD_LETTER_RETENTION_DAYS = EVENTS_ARCHIVE_DAYS;

export const RETRY_EXHAUSTED_FAILURE_CODE = 'RETRY_EXHAUSTED';
export const OUT_OF_ORDER_FAILURE_CODE = 'OUT_OF_ORDER_AGGREGATE_VERSION';
export const OUTBOX_TRANSPORT_FAILURE_CODE = 'OUTBOX_TRANSPORT_UNAVAILABLE';

/** How long to wait before the attempt after `attempt` (1-based); bounded by the backoff table. */
export function retryDelayMs(attempt: number, backoff: readonly number[] = EVENT_RETRY_BACKOFF_MS): number {
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error('Retry attempt must be a positive integer.');
  if (backoff.length === 0) throw new Error('Retry backoff must contain at least one delay.');
  return backoff[Math.min(attempt, backoff.length) - 1]!;
}

/** True when the next attempt after `attempt` is still allowed by the bounded backoff table. */
export function hasRetryBudget(attempt: number, backoff: readonly number[] = EVENT_RETRY_BACKOFF_MS): boolean {
  return attempt < backoff.length;
}
