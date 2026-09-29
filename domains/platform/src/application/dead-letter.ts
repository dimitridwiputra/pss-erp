import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { DomainError } from '@pss/contracts';
import { withAuditedTransaction } from '@pss/audit';
import { boundedFailureMessage, type DeliveryFailureClass } from './delivery-failure';
import { DEAD_LETTER_RETENTION_DAYS } from './retry-policy';
import type { PublishableEvent } from './outbox';

const DeadLetterTargetSchema = z.strictObject({
  stage: z.enum(['OUTBOX', 'CONSUMER']),
  consumerName: z.string().min(1).max(200).optional(),
  eventId: z.uuid(),
  eventType: z.string().min(1),
  aggregateType: z.string().min(1),
  aggregateId: z.string().min(1),
  aggregateVersion: z.int().positive(),
  organizationId: z.uuid().optional(),
  branchId: z.uuid().optional(),
  envelope: z.record(z.string(), z.unknown()),
  failureCode: z.string().min(1).max(100),
  failureClass: z.enum(['TRANSIENT', 'PERMANENT']),
  failureMessage: z.string().optional(),
  /** Cumulative failed attempts for this event on this stage, never lower than what is stored. */
  attemptCount: z.int().positive(),
});
export type DeadLetterTarget = z.input<typeof DeadLetterTargetSchema>;

export interface DeadLetterRecord {
  id: string;
  stage: 'OUTBOX' | 'CONSUMER';
  consumerName: string | null;
  eventId: string;
  eventType: string;
  failureCode: string;
  failureClass: DeliveryFailureClass;
  failureMessage: string | null;
  attemptCount: number;
  firstFailedAt: string;
  lastFailedAt: string;
  status: 'OPEN' | 'REPLAYED' | 'DISCARDED';
  replayCount: number;
  version: number;
}

export interface DeadLetterSummary {
  stage: 'OUTBOX' | 'CONSUMER';
  consumerName: string | null;
  eventType: string;
  open: number;
  oldestOpenAgeMinutes: number | null;
}

/**
 * PLT-005.BR03: a dead letter is never discarded automatically. The same event+consumer pair
 * updates the row it already has, so a redelivered failure raises the attempt count instead of
 * creating a second open row (AGENTS.md 3.6). Must run on the caller's transaction client so the
 * dead letter and whatever marked the event dead commit together.
 */
export async function upsertDeadLetter(client: PoolClient, rawTarget: DeadLetterTarget): Promise<DeadLetterRecord> {
  const parsed = DeadLetterTargetSchema.safeParse(rawTarget);
  if (!parsed.success) throw new DomainError('VALIDATION_FAILED');
  if (parsed.data.stage === 'CONSUMER' && !parsed.data.consumerName) {
    throw new Error('A consumer dead letter requires the consumer name that failed.');
  }
  const target = parsed.data;
  const { rows } = await client.query<{
    id: string; stage: 'OUTBOX' | 'CONSUMER'; consumer_name: string | null; event_id: string;
    event_type: string; failure_code: string; failure_class: DeliveryFailureClass; failure_message: string | null;
    attempt_count: number; first_failed_at: Date; last_failed_at: Date;
    status: 'OPEN' | 'REPLAYED' | 'DISCARDED'; replay_count: number; version: number;
  }>(
    `INSERT INTO platform.event_dead_letter (
       id, stage, consumer_name, event_id, event_type, aggregate_type, aggregate_id, aggregate_version,
       organization_id, branch_id, envelope, failure_code, failure_class, failure_message, attempt_count
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15)
     ON CONFLICT (event_id, coalesce(consumer_name, '')) WHERE status = 'OPEN'
     DO UPDATE SET
       attempt_count = GREATEST(platform.event_dead_letter.attempt_count, EXCLUDED.attempt_count),
       failure_code = EXCLUDED.failure_code,
       failure_class = EXCLUDED.failure_class,
       failure_message = EXCLUDED.failure_message,
       envelope = EXCLUDED.envelope,
       last_failed_at = now(),
       version = platform.event_dead_letter.version + 1
     RETURNING id, stage, consumer_name, event_id, event_type, failure_code, failure_class,
               failure_message, attempt_count, first_failed_at, last_failed_at, status, replay_count, version`,
    [
      randomUUID(), target.stage, target.consumerName ?? null, target.eventId, target.eventType,
      target.aggregateType, target.aggregateId, target.aggregateVersion,
      target.organizationId ?? null, target.branchId ?? null, JSON.stringify(target.envelope),
      target.failureCode, target.failureClass,
      target.failureMessage === undefined ? null : boundedFailureMessage(target.failureMessage),
      target.attemptCount,
    ],
  );
  return toDeadLetterRecord(rows[0]!);
}

function toDeadLetterRecord(row: {
  id: string; stage: 'OUTBOX' | 'CONSUMER'; consumer_name: string | null; event_id: string;
  event_type: string; failure_code: string; failure_class: DeliveryFailureClass; failure_message: string | null;
  attempt_count: number; first_failed_at: Date; last_failed_at: Date;
  status: 'OPEN' | 'REPLAYED' | 'DISCARDED'; replay_count: number; version: number;
}): DeadLetterRecord {
  return {
    id: row.id, stage: row.stage, consumerName: row.consumer_name, eventId: row.event_id,
    eventType: row.event_type, failureCode: row.failure_code, failureClass: row.failure_class,
    failureMessage: row.failure_message, attemptCount: row.attempt_count,
    firstFailedAt: row.first_failed_at.toISOString(),
    lastFailedAt: row.last_failed_at.toISOString(), status: row.status,
    replayCount: row.replay_count, version: row.version,
  };
}

const ListDeadLettersSchema = z.strictObject({
  stage: z.enum(['OUTBOX', 'CONSUMER']).optional(),
  consumerName: z.string().min(1).optional(),
  eventType: z.string().min(1).optional(),
  before: z.iso.datetime().optional(),
  limit: z.int().min(1).max(200).default(50),
});
export type ListDeadLettersInput = z.input<typeof ListDeadLettersSchema>;

/** PLT-005.R02 read path: what is stuck, since when, and why. */
export async function listOpenDeadLetters(pool: Pool, rawInput: ListDeadLettersInput = {}): Promise<DeadLetterRecord[]> {
  const input = ListDeadLettersSchema.parse(rawInput);
  const { rows } = await pool.query<Parameters<typeof toDeadLetterRecord>[0]>(
    `SELECT id, stage, consumer_name, event_id, event_type, failure_code, failure_class, failure_message,
            attempt_count, first_failed_at, last_failed_at, status, replay_count, version
     FROM platform.event_dead_letter
     WHERE status = 'OPEN'
       AND ($1::text IS NULL OR stage = $1)
       AND ($2::text IS NULL OR consumer_name = $2)
       AND ($3::text IS NULL OR event_type = $3)
       AND ($4::timestamptz IS NULL OR last_failed_at <= $4::timestamptz)
     ORDER BY first_failed_at, id
     LIMIT $5`,
    [input.stage ?? null, input.consumerName ?? null, input.eventType ?? null,
      input.before ?? null, input.limit],
  );
  return rows.map(toDeadLetterRecord);
}

/** Per-consumer DLQ depth and age, the two numbers PLT-005.R02 asks the dashboard to show. */
export async function summariseDeadLetters(pool: Pool): Promise<DeadLetterSummary[]> {
  const { rows } = await pool.query<{
    stage: 'OUTBOX' | 'CONSUMER'; consumer_name: string | null; event_type: string;
    open: number; oldest_open_age_minutes: number | null;
  }>(
    `SELECT stage, consumer_name, event_type, count(*)::int AS open,
            max(extract(epoch FROM (now() - first_failed_at)) / 60) AS oldest_open_age_minutes
     FROM platform.event_dead_letter
     WHERE status = 'OPEN'
     GROUP BY stage, consumer_name, event_type
     ORDER BY stage, consumer_name NULLS FIRST, event_type`,
  );
  return rows.map((row) => ({
    stage: row.stage, consumerName: row.consumer_name, eventType: row.event_type,
    open: row.open,
    oldestOpenAgeMinutes: row.oldest_open_age_minutes === null
      ? null : Math.floor(Number(row.oldest_open_age_minutes)),
  }));
}

const ReplayDeadLetterSchema = z.strictObject({
  deadLetterId: z.uuid(),
  organizationId: z.uuid(),
  actorId: z.uuid(),
  requestId: z.string().min(1),
  correlationId: z.string().min(1),
  reason: z.string().trim().min(1).max(500),
});
export type ReplayDeadLetterInput = z.input<typeof ReplayDeadLetterSchema>;

export interface ReplayDeadLetterResult {
  deadLetter: DeadLetterRecord;
  /** The full canonical envelope, for the caller to hand back to its transport. */
  envelope: PublishableEvent;
}

/**
 * PLT-005.R03 and AGENTS.md 14: a replay is an operator decision, so it is audited. The audit
 * entry and the OPEN -> REPLAYED transition share one transaction, so a replay can never
 * succeed without its audit trail. Platform does not re-deliver anything here; it hands the
 * verified envelope back and the owning consumer's transport decides where it goes.
 */
export async function replayDeadLetter(
  pool: Pool, rawInput: ReplayDeadLetterInput,
): Promise<ReplayDeadLetterResult> {
  const parsed = ReplayDeadLetterSchema.safeParse(rawInput);
  if (!parsed.success) throw new DomainError('VALIDATION_FAILED');
  const input = parsed.data;
  return withAuditedTransaction(pool, async ({ client, appendAuditEntry }) => {
    const { rows } = await client.query<{
      id: string; stage: 'OUTBOX' | 'CONSUMER'; consumer_name: string | null; event_id: string;
      event_type: string; aggregate_type: string; aggregate_id: string; aggregate_version: number;
      organization_id: string | null; branch_id: string | null; envelope: unknown; failure_code: string;
      failure_class: DeliveryFailureClass; attempt_count: number; first_failed_at: Date;
      last_failed_at: Date; status: 'OPEN' | 'REPLAYED' | 'DISCARDED'; replay_count: number; version: number;
    }>(
      `SELECT id, stage, consumer_name, event_id, event_type, aggregate_type, aggregate_id,
              aggregate_version, organization_id, branch_id, envelope, failure_code, failure_class,
              failure_message, attempt_count, first_failed_at, last_failed_at, status, replay_count, version
       FROM platform.event_dead_letter WHERE id = $1 FOR UPDATE`, [input.deadLetterId],
    );
    const row = rows[0];
    if (!row) throw new DomainError('NOT_FOUND');
    if (row.status !== 'OPEN') throw new DomainError('INVALID_STATE_TRANSITION');
    const version = row.version + 1;
    const updated = await client.query<Parameters<typeof toDeadLetterRecord>[0]>(
      `UPDATE platform.event_dead_letter
       SET status = 'REPLAYED', replayed_at = now(), replayed_by = $2,
           replay_count = replay_count + 1, version = $3
       WHERE id = $1 RETURNING id, stage, consumer_name, event_id, event_type, failure_code,
         failure_class, failure_message, attempt_count, first_failed_at, last_failed_at,
         status, replay_count, version`,
      [input.deadLetterId, input.actorId, version],
    );
    await client.query(
      `UPDATE platform.outbox_event SET dead_lettered_at = NULL, dead_letter_id = NULL,
              next_attempt_at = now(), attempt_count = 0
       WHERE event_id = $1 AND published_at IS NULL AND $2::text = 'OUTBOX'`, [row.event_id, row.stage],
    );
    await appendAuditEntry({
      organizationId: input.organizationId,
      ...(row.branch_id ? { branchId: row.branch_id } : {}),
      actor: { userId: input.actorId, roles: [] },
      action: 'EVENT_DEAD_LETTER_REPLAYED',
      entity: { domain: 'platform', type: 'EventDeadLetter', id: row.id, version },
      changes: [
        { path: 'status', classification: 'INTERNAL', before: 'OPEN', after: 'REPLAYED' },
        { path: 'replayCount', classification: 'INTERNAL', before: String(row.replay_count),
          after: String(row.replay_count + 1) },
      ],
      reasonCode: input.reason,
      requestId: input.requestId, correlationId: input.correlationId, source: 'API',
    });
    return {
      deadLetter: toDeadLetterRecord(updated.rows[0]!),
      envelope: row.envelope as PublishableEvent,
    };
  });
}

const DiscardDeadLetterSchema = z.strictObject({
  deadLetterId: z.uuid(),
  organizationId: z.uuid(),
  actorId: z.uuid(),
  requestId: z.string().min(1),
  correlationId: z.string().min(1),
  reason: z.string().trim().min(1).max(500),
});
export type DiscardDeadLetterInput = z.input<typeof DiscardDeadLetterSchema>;

/** STAGE transition OPEN -> DISCARDED. Always needs a reason, and always writes an audit entry. */
export async function discardDeadLetter(pool: Pool, rawInput: DiscardDeadLetterInput): Promise<DeadLetterRecord> {
  const parsed = DiscardDeadLetterSchema.safeParse(rawInput);
  if (!parsed.success) throw new DomainError('VALIDATION_FAILED');
  const input = parsed.data;
  return withAuditedTransaction(pool, async ({ client, appendAuditEntry }) => {
    const { rows } = await client.query<{
      id: string; organization_id: string | null; branch_id: string | null; status: string; version: number;
    }>(
      `SELECT id, organization_id, branch_id, status, version
       FROM platform.event_dead_letter WHERE id = $1 FOR UPDATE`, [input.deadLetterId],
    );
    const row = rows[0];
    if (!row) throw new DomainError('NOT_FOUND');
    if (row.status !== 'OPEN') throw new DomainError('INVALID_STATE_TRANSITION');
    const version = row.version + 1;
    const updated = await client.query<Parameters<typeof toDeadLetterRecord>[0]>(
      `UPDATE platform.event_dead_letter
       SET status = 'DISCARDED', discarded_at = now(), discarded_by = $2, discard_reason = $3, version = $4
       WHERE id = $1 RETURNING id, stage, consumer_name, event_id, event_type, failure_code,
         failure_class, failure_message, attempt_count, first_failed_at, last_failed_at,
         status, replay_count, version`,
      [input.deadLetterId, input.actorId, input.reason, version],
    );
    await appendAuditEntry({
      organizationId: input.organizationId,
      ...(row.branch_id ? { branchId: row.branch_id } : {}),
      actor: { userId: input.actorId, roles: [] },
      action: 'EVENT_DEAD_LETTER_DISCARDED',
      entity: { domain: 'platform', type: 'EventDeadLetter', id: row.id, version },
      changes: [{ path: 'status', classification: 'INTERNAL', before: 'OPEN', after: 'DISCARDED' }],
      reasonCode: input.reason,
      requestId: input.requestId, correlationId: input.correlationId, source: 'API',
    });
    return toDeadLetterRecord(updated.rows[0]!);
  });
}

/**
 * Retention for the dead-letter trail. Open rows are never touched, so a stuck event stays
 * visible until an operator replays or discards it with a reason.
 */
export async function deleteClosedDeadLetters(
  pool: Pool, retentionDays: number = DEAD_LETTER_RETENTION_DAYS,
): Promise<number> {
  if (!Number.isInteger(retentionDays) || retentionDays < 1) {
    throw new DomainError('VALIDATION_FAILED');
  }
  const result = await pool.query(
    `DELETE FROM platform.event_dead_letter
     WHERE status IN ('REPLAYED', 'DISCARDED')
       AND last_failed_at < now() - make_interval(days => $1)`, [retentionDays],
  );
  return result.rowCount ?? 0;
}
