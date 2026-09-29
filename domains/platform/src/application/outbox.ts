import type { Pool, PoolClient } from 'pg';
import { parseEventForPublication } from '@pss/contracts';
import { boundedFailureMessage, classifyDeliveryFailure } from './delivery-failure';
import { upsertDeadLetter } from './dead-letter';
import {
  EVENT_RETRY_BACKOFF_MS, EVENTS_ARCHIVE_DAYS, RETRY_EXHAUSTED_FAILURE_CODE,
  hasRetryBudget, retryDelayMs,
} from './retry-policy';

export type PublishableEvent = ReturnType<typeof parseEventForPublication>;

/** Insert using the owning mutation's PoolClient before that transaction commits. */
export async function appendOutboxEvent(client: PoolClient, rawEvent: unknown): Promise<void> {
  const event = parseEventForPublication(rawEvent);
  await client.query(
    `INSERT INTO platform.outbox_event (
      event_id, event_type, aggregate_type, aggregate_id, aggregate_version, envelope
    ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [event.eventId, event.eventType, event.aggregateType, event.aggregateId, event.aggregateVersion, JSON.stringify(event)],
  );
}

export interface EventTransport {
  publish(event: PublishableEvent): Promise<void>;
}

export interface DispatchAttempt {
  eventId: string;
  eventType: string;
  attempt: number;
  failureClass: 'TRANSIENT' | 'PERMANENT';
  failureCode: string;
  willRetry: boolean;
  nextAttemptAt: string | null;
  deadLetterId: string | null;
}

export interface DispatchOptions {
  limit?: number;
  /** Bounded backoff table; defaults to the registered `events.retry_backoff`. */
  retryBackoffMs?: readonly number[];
  /** Called once per failed attempt so the worker can log or count it without re-querying. */
  onFailure?: (attempt: DispatchAttempt) => void | Promise<void>;
}

export interface DispatchResult {
  published: number;
  /** The oldest event that is still waiting on its backoff window, for the PLT-004.R05 lag metric. */
  oldestPendingCreatedAt: string | null;
  attempts: DispatchAttempt[];
}

function validateLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Outbox dispatch limit must be between 1 and 1000.');
}

/**
 * PLT-004 main flow plus PLT-005 bounded retry. One aggregate-ordered row at a time; a failed
 * send records the attempt, schedules the next try from the backoff table, and stops blocking
 * that aggregate only once the row is dead-lettered. Delivery is at least once, so a crash
 * after the transport accepted a message can duplicate it; consumers deduplicate by eventId.
 * `options` also accepts a plain limit for the existing call sites.
 */
export async function dispatchPendingEvents(
  pool: Pool, transport: EventTransport, options: DispatchOptions | number = {},
): Promise<DispatchResult> {
  const resolved: DispatchOptions = typeof options === 'number' ? { limit: options } : options;
  const limit = resolved.limit ?? 100;
  validateLimit(limit);
  const backoff = resolved.retryBackoffMs ?? EVENT_RETRY_BACKOFF_MS;
  if (backoff.length === 0) throw new Error('Retry backoff must contain at least one delay.');

  let published = 0;
  const attempts: DispatchAttempt[] = [];
  for (let index = 0; index < limit; index += 1) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{
        event_id: string; event_type: string; aggregate_type: string; aggregate_id: string;
        aggregate_version: number; organization_id: string; envelope: unknown; attempt_count: number;
      }>(
        `SELECT o.event_id, o.event_type, o.aggregate_type, o.aggregate_id, o.aggregate_version,
                o.envelope, o.attempt_count
         FROM platform.outbox_event o
         WHERE o.published_at IS NULL
           AND o.dead_lettered_at IS NULL
           AND o.next_attempt_at <= now()
           AND NOT EXISTS (
             SELECT 1 FROM platform.outbox_event older
             WHERE older.aggregate_type = o.aggregate_type
               AND older.aggregate_id = o.aggregate_id
               AND older.published_at IS NULL
               AND older.dead_lettered_at IS NULL
               AND (older.aggregate_version, older.created_at, older.event_id)
                 < (o.aggregate_version, o.created_at, o.event_id)
           )
         ORDER BY o.created_at, o.event_id
         LIMIT 1 FOR UPDATE OF o SKIP LOCKED`,
      );
      const row = rows[0];
      if (!row) {
        await client.query('COMMIT');
        break;
      }
      const event = parseEventForPublication(row.envelope);
      try {
        await transport.publish(event);
      } catch (error) {
        const attempt = await recordFailedDispatch(client, row, backoff, error);
        attempts.push(attempt);
        await client.query('COMMIT');
        await resolved.onFailure?.(attempt);
        continue;
      }
      await client.query(
        `UPDATE platform.outbox_event SET published_at = now(), attempt_count = attempt_count + 1,
                last_failure_code = NULL, last_failure_at = NULL
         WHERE event_id = $1`, [row.event_id],
      );
      await client.query('COMMIT');
      published += 1;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  return { published, oldestPendingCreatedAt: await oldestPendingAge(pool), attempts };
}

async function recordFailedDispatch(
  client: PoolClient,
  row: { event_id: string; event_type: string; aggregate_type: string; aggregate_id: string;
    aggregate_version: number; organization_id: string; envelope: unknown; attempt_count: number },
  backoff: readonly number[],
  error: unknown,
): Promise<DispatchAttempt> {
  const attempt = row.attempt_count + 1;
  const failure = classifyDeliveryFailure(error);
  const willRetry = hasRetryBudget(attempt, backoff);
  const nextAttemptAt = willRetry ? new Date(Date.now() + retryDelayMs(attempt, backoff)) : null;
  let deadLetterId: string | null = null;
  if (!willRetry) {
    const deadLetter = await upsertDeadLetter(client, {
      stage: 'OUTBOX',
      eventId: row.event_id, eventType: row.event_type, aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id, aggregateVersion: row.aggregate_version,
      organizationId: row.organization_id,
      envelope: row.envelope as Record<string, unknown>,
      failureCode: RETRY_EXHAUSTED_FAILURE_CODE, failureClass: failure.class,
      failureMessage: boundedFailureMessage(failure.message), attemptCount: attempt,
    });
    deadLetterId = deadLetter.id;
  }
  await client.query(
    `UPDATE platform.outbox_event
     SET attempt_count = $2,
         next_attempt_at = COALESCE($3::timestamptz, next_attempt_at),
         last_failure_code = $4, last_failure_at = now(),
         dead_lettered_at = CASE WHEN $5::boolean THEN now() ELSE dead_lettered_at END,
         dead_letter_id = CASE WHEN $5::boolean THEN $6::uuid ELSE dead_letter_id END
     WHERE event_id = $1`,
    [row.event_id, attempt, nextAttemptAt?.toISOString() ?? null, failure.code, !willRetry, deadLetterId],
  );
  return {
    eventId: row.event_id, eventType: row.event_type, attempt, failureClass: failure.class,
    failureCode: failure.code, willRetry,
    nextAttemptAt: nextAttemptAt?.toISOString() ?? null, deadLetterId,
  };
}

/** PLT-004.R05: age of the oldest undelivered event, the number that says whether we are behind. */
export async function oldestPendingAge(pool: Pool): Promise<string | null> {
  const { rows } = await pool.query<{ oldest: Date | null }>(
    `SELECT min(created_at) AS oldest FROM platform.outbox_event
     WHERE published_at IS NULL AND dead_lettered_at IS NULL`,
  );
  return rows[0]?.oldest?.toISOString() ?? null;
}

/** PLT-004.R05: pending depth and dispatch throughput counters, sampled by the worker. */
export async function outboxDeliveryStats(pool: Pool): Promise<{
  pending: number; deadLettered: number; oldestPendingCreatedAt: string | null;
}> {
  const { rows } = await pool.query<{ pending: number; dead_lettered: number; oldest: Date | null }>(
    `SELECT count(*) FILTER (WHERE published_at IS NULL AND dead_lettered_at IS NULL)::int AS pending,
            count(*) FILTER (WHERE dead_lettered_at IS NOT NULL)::int AS dead_lettered,
            min(created_at) FILTER (WHERE published_at IS NULL AND dead_lettered_at IS NULL) AS oldest
     FROM platform.outbox_event`,
  );
  return {
    pending: rows[0]!.pending, deadLettered: rows[0]!.dead_lettered,
    oldestPendingCreatedAt: rows[0]!.oldest?.toISOString() ?? null,
  };
}

/**
 * Retention for the event archive that doubles as the outbox. Only rows the dispatcher has
 * finished with are eligible; pending and dead-lettered events are never removed by a clock.
 */
export async function deleteDispatchedOutboxEvents(
  pool: Pool, retentionDays: number = EVENTS_ARCHIVE_DAYS,
): Promise<number> {
  if (!Number.isInteger(retentionDays) || retentionDays < 1) {
    throw new Error('Outbox retention must be at least one day.');
  }
  const result = await pool.query(
    `DELETE FROM platform.outbox_event
     WHERE published_at IS NOT NULL
       AND published_at < now() - make_interval(days => $1)`, [retentionDays],
  );
  return result.rowCount ?? 0;
}
