import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DomainError } from '@pss/contracts';
import { dispatchPendingEvents, appendOutboxEvent, deleteDispatchedOutboxEvents, type PublishableEvent } from '../src/application/outbox';
import { withInbox, recordConsumerDeadLetter, type ConsumerInbox } from '../src/application/inbox';
import {
  deleteClosedDeadLetters, listOpenDeadLetters, replayDeadLetter, discardDeadLetter, summariseDeadLetters,
} from '../src/application/dead-letter';
import { classifyDeliveryFailure } from '../src/application/delivery-failure';
import { EVENT_RETRY_BACKOFF_MS, retryDelayMs, hasRetryBudget } from '../src/application/retry-policy';

const databaseName = `pss_delivery_test_${randomUUID().replaceAll('-', '')}`;
const organizationId = randomUUID();
let admin: pg.Client;
let pool: pg.Pool;

beforeAll(async () => {
  const baseUrl = process.env.PSS_TEST_DATABASE_URL;
  if (!baseUrl) throw new Error('PSS_TEST_DATABASE_URL is required.');
  admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${databaseName}`);
  const testUrl = new URL(baseUrl);
  testUrl.pathname = `/${databaseName}`;
  pool = new pg.Pool({ connectionString: testUrl.toString() });
  for (const relativePath of [
    '../../audit/infrastructure/database/migrations/0001_audit_entry.sql',
    '../infrastructure/database/migrations/0001_outbox_event.sql',
    '../infrastructure/database/migrations/0002_idempotency_key.sql',
    '../infrastructure/database/migrations/0005_event_delivery_reliability.sql',
  ]) {
    await pool.query(await readFile(new URL(relativePath, import.meta.url), 'utf8'));
  }
  await pool.query('CREATE SCHEMA consumer_side');
  await pool.query(`CREATE TABLE consumer_side.inbox_event (
    consumer_name text NOT NULL, event_id uuid NOT NULL,
    processed_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (consumer_name, event_id))`);
  await pool.query(`CREATE TABLE consumer_side.read_model (
    aggregate_id uuid PRIMARY KEY, applied_version integer NOT NULL, effect_count integer NOT NULL DEFAULT 0)`);
}, 30_000);

afterAll(async () => {
  await pool?.end();
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
    await admin.end();
  }
});

let eventSequence = 0;
function event(aggregateId: string, aggregateVersion: number, eventType = 'DELIVERY_ORDER_CLOSED') {
  eventSequence += 1;
  return {
    eventId: `0195a843-6abc-7000-8000-${eventSequence.toString().padStart(12, '0')}`,
    eventType, eventVersion: 1, occurredAt: '2026-09-27T00:00:00.000Z', businessDate: '2026-09-27',
    organizationId, aggregateType: 'DeliveryOrder', aggregateId, aggregateVersion,
    producer: 'fulfillment', correlationId: 'delivery-reliability', causationId: `command-${aggregateVersion}`,
    payload: { doId: aggregateId },
  };
}

async function append(aggregateId: string, aggregateVersion: number, eventType?: string) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await appendOutboxEvent(client, event(aggregateId, aggregateVersion, eventType));
    await client.query('COMMIT');
  } finally {
    client.release();
  }
}

const testConsumer: ConsumerInbox = {
  reserve: async (client, eventId) => {
    const receipt = await client.query(
      `INSERT INTO consumer_side.inbox_event (consumer_name, event_id) VALUES ($1, $2)
       ON CONFLICT (consumer_name, event_id) DO NOTHING`,
      ['delivery-status.v1', eventId],
    );
    return receipt.rowCount === 1;
  },
};

/** The consumer's own read model decides which aggregate version it has already applied. */
const ordering = {
  readAppliedVersion: async (client: pg.PoolClient, message: PublishableEvent) => {
    const { rows } = await client.query<{ applied_version: number }>(
      'SELECT applied_version FROM consumer_side.read_model WHERE aggregate_id = $1', [message.aggregateId],
    );
    return rows[0]?.applied_version ?? 0;
  },
};

const applyEffect = async (client: pg.PoolClient, message: PublishableEvent) => {
  await client.query(
    `INSERT INTO consumer_side.read_model (aggregate_id, applied_version, effect_count)
     VALUES ($1, $2, 1)
     ON CONFLICT (aggregate_id) DO UPDATE SET
       applied_version = EXCLUDED.applied_version, effect_count = consumer_side.read_model.effect_count + 1`,
    [message.aggregateId, message.aggregateVersion],
  );
};

describe('PLT-004/PLT-005 bounded retry on the outbox', () => {
  it('exposes the registered backoff table and its bounds', () => {
    expect([...EVENT_RETRY_BACKOFF_MS]).toEqual([1_000, 5_000, 30_000, 120_000, 600_000]);
    expect(retryDelayMs(1)).toBe(1_000);
    expect(retryDelayMs(3)).toBe(30_000);
    expect(retryDelayMs(99)).toBe(600_000);
    expect(hasRetryBudget(EVENT_RETRY_BACKOFF_MS.length)).toBe(false);
    expect(hasRetryBudget(EVENT_RETRY_BACKOFF_MS.length - 1)).toBe(true);
    expect(() => retryDelayMs(0)).toThrow('positive integer');
  });

  it('PLT-004.AC03 keeps a failing event pending and delays the retry by the backoff delay', async () => {
    const aggregateId = randomUUID();
    await append(aggregateId, 1);
    const slowBackoff = [60_000, 60_000];
    const first = await dispatchPendingEvents(pool, { publish: async () => { throw new DomainError('DEPENDENCY_UNAVAILABLE'); } },
      { retryBackoffMs: slowBackoff, onFailure: () => {} });
    expect(first.published).toBe(0);
    expect(first.attempts[0]?.willRetry).toBe(true);
    expect(first.attempts[0]?.failureCode).toBe('DEPENDENCY_UNAVAILABLE');
    expect((await pool.query<{ dead_lettered_at: Date | null; attempt_count: number }>(
      'SELECT dead_lettered_at, attempt_count FROM platform.outbox_event WHERE aggregate_id = $1', [aggregateId],
    )).rows[0]).toMatchObject({ dead_lettered_at: null, attempt_count: 1 });

    // The event is not "ready" until its backoff window elapses, so the next pass sends nothing.
    expect((await dispatchPendingEvents(pool, { publish: async () => { throw new Error('must not run yet'); } },
      { retryBackoffMs: slowBackoff })).published).toBe(0);

    await pool.query('UPDATE platform.outbox_event SET next_attempt_at = now() WHERE aggregate_id = $1', [aggregateId]);
    const delivered: number[] = [];
    const second = await dispatchPendingEvents(pool, { publish: async (message) => { delivered.push(message.aggregateVersion); } });
    expect(second.published).toBe(1);
    expect(delivered).toEqual([1]);
    expect((await pool.query<{ published_at: Date | null }>(
      'SELECT published_at FROM platform.outbox_event WHERE aggregate_id = $1', [aggregateId],
    )).rows[0]!.published_at).not.toBeNull();
  });

  it('PLT-005.AC03 dead-letters after the backoff is exhausted and frees the aggregate', async () => {
    const aggregateId = randomUUID();
    await append(aggregateId, 1);
    await append(aggregateId, 2);
    const pacedBackoff = [60_000, 60_000, 60_000];
    const failure = async () => {
      await pool.query('UPDATE platform.outbox_event SET next_attempt_at = now() WHERE aggregate_id = $1', [aggregateId]);
      return dispatchPendingEvents(pool, { publish: async () => { throw new DomainError('DEPENDENCY_UNAVAILABLE'); } },
        { retryBackoffMs: pacedBackoff });
    };

    expect((await failure()).attempts[0]).toMatchObject({ willRetry: true, attempt: 1, failureCode: 'DEPENDENCY_UNAVAILABLE' });
    expect((await failure()).attempts[0]).toMatchObject({ willRetry: true, attempt: 2 });
    const exhausted = await failure();
    expect(exhausted.published).toBe(0);
    expect(exhausted.attempts[0]).toMatchObject({ willRetry: false, attempt: 3, failureCode: 'DEPENDENCY_UNAVAILABLE' });
    expect(exhausted.attempts[0]?.deadLetterId).not.toBeNull();

    const deadLetters = await listOpenDeadLetters(pool, { stage: 'OUTBOX' });
    const row = deadLetters.find((entry) => entry.eventId === exhausted.attempts[0]!.eventId)!;
    expect(row).toMatchObject({ stage: 'OUTBOX', status: 'OPEN', attemptCount: 3, failureClass: 'TRANSIENT' });
    expect(row.failureCode).toBe('RETRY_EXHAUSTED');
    expect(row.failureMessage).toContain('DEPENDENCY_UNAVAILABLE');
    expect(row.firstFailedAt).toBeTruthy();
    expect(row.lastFailedAt).toBeTruthy();
    expect((await pool.query<{ dead_lettered_at: Date | null }>(
      'SELECT dead_lettered_at FROM platform.outbox_event WHERE event_id = $1', [row.eventId],
    )).rows[0]!.dead_lettered_at).not.toBeNull();

    // Version 2 is no longer blocked by the dead-lettered version 1, so the aggregate moves on.
    await pool.query('UPDATE platform.outbox_event SET next_attempt_at = now() WHERE aggregate_id = $1', [aggregateId]);
    const delivered: number[] = [];
    expect((await dispatchPendingEvents(pool, {
      publish: async (message) => { delivered.push(message.aggregateVersion); },
    })).published).toBe(1);
    expect(delivered).toEqual([2]);
  });

  it('classifies a permanent failure separately from a retryable one', async () => {
    expect(classifyDeliveryFailure(new DomainError('PERMISSION_DENIED'))).toMatchObject({
      class: 'PERMANENT', code: 'PERMISSION_DENIED',
    });
    expect(classifyDeliveryFailure(new DomainError('DEPENDENCY_UNAVAILABLE'))).toMatchObject({ class: 'TRANSIENT' });
    expect(classifyDeliveryFailure(new DomainError('RATE_LIMITED'))).toMatchObject({ class: 'TRANSIENT' });
    expect(classifyDeliveryFailure(new Error('socket hang up'))).toMatchObject({
      class: 'TRANSIENT', code: 'UNEXPECTED_CONSUMER_FAILURE',
    });
  });
});

describe('PLT-005 inbox dedup, out-of-order tolerance, and dead letters', () => {
  it('PLT-005.AC01 applies one effect for five redeliveries', async () => {
    const aggregateId = randomUUID();
    const message = event(aggregateId, 1);
    const results = await Promise.all(Array.from({ length: 5 }, () => withInbox(pool, testConsumer, message, applyEffect)));
    expect(results.filter((result) => result.status === 'PROCESSED')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'DUPLICATE')).toHaveLength(4);
    expect((await pool.query<{ effect_count: number }>(
      'SELECT effect_count FROM consumer_side.read_model WHERE aggregate_id = $1', [aggregateId],
    )).rows[0]!.effect_count).toBe(1);
  });

  it('PLT-005.TS03 defers a version gap without writing, then applies it once the gap closes', async () => {
    const aggregateId = randomUUID();
    const deferred = await withInbox(pool, testConsumer, event(aggregateId, 3), applyEffect, { ordering });
    expect(deferred).toEqual({ status: 'DEFERRED', expectedVersion: 1 });
    expect((await pool.query('SELECT * FROM consumer_side.read_model WHERE aggregate_id = $1', [aggregateId])).rowCount).toBe(0);
    expect((await pool.query('SELECT * FROM consumer_side.inbox_event WHERE event_id = $1', [event(aggregateId, 3).eventId])).rowCount).toBe(0);

    expect((await withInbox(pool, testConsumer, event(aggregateId, 1), applyEffect, { ordering })).status).toBe('PROCESSED');
    expect((await withInbox(pool, testConsumer, event(aggregateId, 2), applyEffect, { ordering })).status).toBe('PROCESSED');
    expect((await withInbox(pool, testConsumer, event(aggregateId, 3), applyEffect, { ordering })).status).toBe('PROCESSED');

    const readModel = (await pool.query<{ applied_version: number; effect_count: number }>(
      'SELECT applied_version, effect_count FROM consumer_side.read_model WHERE aggregate_id = $1', [aggregateId],
    )).rows[0]!;
    expect(readModel).toEqual({ applied_version: 3, effect_count: 3 });
  });

  it('PLT-005.TS03 an out-of-order event that exhausts its budget becomes one visible dead letter', async () => {
    const aggregateId = randomUUID();
    const message = event(aggregateId, 7);
    const attemptCounts: number[] = [];
    for (let attempt = 1; attempt <= EVENT_RETRY_BACKOFF_MS.length; attempt += 1) {
      expect(await withInbox(pool, testConsumer, message, applyEffect, { ordering })).toEqual({
        status: 'DEFERRED', expectedVersion: 1,
      });
      attemptCounts.push(attempt);
    }
    const deadLetter = await recordConsumerDeadLetter(pool, {
      consumerName: 'delivery-status.v1', event: message, attemptCount: attemptCounts.length,
      cause: 'OUT_OF_ORDER', expectedVersion: 1,
    });
    expect(deadLetter).toMatchObject({
      stage: 'CONSUMER', consumerName: 'delivery-status.v1', status: 'OPEN',
      failureCode: 'OUT_OF_ORDER_AGGREGATE_VERSION', attemptCount: EVENT_RETRY_BACKOFF_MS.length,
    });
    expect(deadLetter.failureMessage).toContain('version 1');
    expect((await pool.query('SELECT count(*)::int AS c FROM platform.event_dead_letter WHERE event_id = $1',
      [message.eventId])).rows[0].c).toBe(1);
  });

  it('PLT-005.AC03 records a handler failure with its code, attempts, and timestamps', async () => {
    const message = event(randomUUID(), 1);
    const deadLetter = await recordConsumerDeadLetter(pool, {
      consumerName: 'delivery-status.v1', event: message, attemptCount: 5, cause: 'HANDLER_FAILED',
      error: new DomainError('CAPACITY_EXCEEDED'),
    });
    expect(deadLetter).toMatchObject({ failureCode: 'CAPACITY_EXCEEDED', failureClass: 'PERMANENT', attemptCount: 5 });
    expect(deadLetter.firstFailedAt).toBeTruthy();
    expect(deadLetter.lastFailedAt).toBeTruthy();

    // A second failure for the same event and consumer updates the row it already has.
    const again = await recordConsumerDeadLetter(pool, {
      consumerName: 'delivery-status.v1', event: message, attemptCount: 6, cause: 'HANDLER_FAILED',
      error: new DomainError('CAPACITY_EXCEEDED'),
    });
    expect(again.id).toBe(deadLetter.id);
    expect(again.attemptCount).toBe(6);
    expect(again.version).toBe(deadLetter.version + 1);
    expect((await pool.query('SELECT count(*)::int AS c FROM platform.event_dead_letter WHERE event_id = $1',
      [message.eventId])).rows[0].c).toBe(1);
  });
});

describe('PLT-005.R03 audited replay and discard', () => {
  it('replays a dead letter with an audit entry and hands back the verified envelope', async () => {
    const actorId = randomUUID();
    const message = event(randomUUID(), 1);
    const deadLetter = await recordConsumerDeadLetter(pool, {
      consumerName: 'delivery-status.v1', event: message, attemptCount: 5, cause: 'HANDLER_FAILED',
      error: new DomainError('DEPENDENCY_UNAVAILABLE'),
    });
    const replayed = await replayDeadLetter(pool, {
      deadLetterId: deadLetter.id, organizationId, actorId,
      requestId: randomUUID(), correlationId: randomUUID(), reason: 'Consumer diperbaiki',
    });
    expect(replayed.deadLetter).toMatchObject({ status: 'REPLAYED', replayCount: 1 });
    expect(replayed.envelope).toEqual(message);

    const auditRows = (await pool.query<{ action: string; actor_user_id: string; reason_code: string; changes: unknown }>(
      `SELECT action, actor_user_id, reason_code, changes FROM audit.audit_entry
       WHERE entity_domain = 'platform' AND entity_type = 'EventDeadLetter' AND entity_id = $1`,
      [deadLetter.id],
    )).rows;
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({ action: 'EVENT_DEAD_LETTER_REPLAYED', actor_user_id: actorId, reason_code: 'Consumer diperbaiki' });
    expect(auditRows[0]!.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'status', before: 'OPEN', after: 'REPLAYED' }),
    ]));

    await expect(replayDeadLetter(pool, {
      deadLetterId: deadLetter.id, organizationId, actorId,
      requestId: randomUUID(), correlationId: randomUUID(), reason: ' kedua',
    })).rejects.toThrow('INVALID_STATE_TRANSITION');
  });

  it('releases a dead-lettered outbox row back to the dispatcher on replay', async () => {
    const aggregateId = randomUUID();
    await append(aggregateId, 1);
    await pool.query('UPDATE platform.outbox_event SET next_attempt_at = now() WHERE aggregate_id = $1', [aggregateId]);
    const exhausted = await dispatchPendingEvents(pool, { publish: async () => { throw new DomainError('DEPENDENCY_UNAVAILABLE'); } },
      { retryBackoffMs: [0] });
    const deadLetter = (await listOpenDeadLetters(pool, { stage: 'OUTBOX' }))
      .find((entry) => entry.eventId === exhausted.attempts[0]!.eventId)!;
    expect((await dispatchPendingEvents(pool, { publish: async () => { throw new Error('must not resend'); } })).published).toBe(0);

    await replayDeadLetter(pool, {
      deadLetterId: deadLetter.id, organizationId, actorId: randomUUID(),
      requestId: randomUUID(), correlationId: randomUUID(), reason: 'Broker kembali normal',
    });
    const delivered: string[] = [];
    expect((await dispatchPendingEvents(pool, { publish: async (message) => { delivered.push(message.eventId); } })).published).toBe(1);
    expect(delivered).toEqual([deadLetter.eventId]);
  });

  it('discards with a mandatory reason and audits it, and refuses an unknown dead letter', async () => {
    const message = event(randomUUID(), 1);
    const deadLetter = await recordConsumerDeadLetter(pool, {
      consumerName: 'delivery-status.v1', event: message, attemptCount: 4, cause: 'HANDLER_FAILED',
      error: new DomainError('PRODUCT_INACTIVE'),
    });
    await expect(discardDeadLetter(pool, {
      deadLetterId: deadLetter.id, organizationId, actorId: randomUUID(),
      requestId: randomUUID(), correlationId: randomUUID(), reason: '',
    })).rejects.toThrow('VALIDATION_FAILED');
    const discarded = await discardDeadLetter(pool, {
      deadLetterId: deadLetter.id, organizationId, actorId: randomUUID(),
      requestId: randomUUID(), correlationId: randomUUID(), reason: 'Event tidak relevan',
    });
    expect(discarded.status).toBe('DISCARDED');
    expect((await pool.query<{ action: string }>(
      `SELECT action FROM audit.audit_entry WHERE entity_id = $1 AND action = 'EVENT_DEAD_LETTER_DISCARDED'`,
      [deadLetter.id],
    )).rowCount).toBe(1);
    await expect(discardDeadLetter(pool, {
      deadLetterId: randomUUID(), organizationId, actorId: randomUUID(),
      requestId: randomUUID(), correlationId: randomUUID(), reason: 'x',
    })).rejects.toThrow('NOT_FOUND');
  });

  it('PLT-005.R02 summarises DLQ depth and age per consumer', async () => {
    const summary = await summariseDeadLetters(pool);
    const reporting = summary.find((entry) => entry.consumerName === 'delivery-status.v1');
    expect(reporting).toBeDefined();
    expect(reporting!.open).toBeGreaterThan(0);
    expect(reporting!.oldestOpenAgeMinutes).toBeGreaterThanOrEqual(0);
    expect(summary.some((entry) => entry.stage === 'OUTBOX')).toBe(true);
  });
});

describe('PLT-004/PLT-005 retention', () => {
  it('removes only dispatched outbox rows past the retention window', async () => {
    const aggregateId = randomUUID();
    await append(aggregateId, 1);
    await pool.query('UPDATE platform.outbox_event SET published_at = now() - interval \'500 days\' WHERE aggregate_id = $1', [aggregateId]);
    const retained = await appendOutboxEventCounts();
    expect(retained).toBeGreaterThan(0);
    const removed = await deleteDispatchedOutboxEvents(pool, 400);
    expect(removed).toBe(retained);
    expect((await pool.query<{ published_at: Date | null }>(
      'SELECT published_at FROM platform.outbox_event WHERE published_at IS NULL',
    )).rowCount).toBeGreaterThan(0);
    expect((await deleteDispatchedOutboxEvents(pool, 400))).toBe(0);
  });

  it('removes closed dead letters but never an open one', async () => {
    const open = await recordConsumerDeadLetter(pool, {
      consumerName: 'retention.probe', event: event(randomUUID(), 1), attemptCount: 2,
      cause: 'HANDLER_FAILED', error: new Error('still broken'),
    });
    const closedMessage = event(randomUUID(), 1);
    const closed = await recordConsumerDeadLetter(pool, {
      consumerName: 'retention.probe', event: closedMessage, attemptCount: 2,
      cause: 'HANDLER_FAILED', error: new Error('fixed later'),
    });
    await discardDeadLetter(pool, {
      deadLetterId: closed.id, organizationId, actorId: randomUUID(),
      requestId: randomUUID(), correlationId: randomUUID(), reason: 'Duplikat upstream',
    });
    expect((await deleteClosedDeadLetters(pool, 400))).toBe(0);
    await pool.query(
      `UPDATE platform.event_dead_letter SET last_failed_at = now() - interval '500 days' WHERE id = $1`, [closed.id],
    );
    expect(await deleteClosedDeadLetters(pool, 400)).toBe(1);
    expect((await pool.query('SELECT status FROM platform.event_dead_letter WHERE id = $1', [open.id])).rows[0]).toEqual({ status: 'OPEN' });
    await expect(deleteClosedDeadLetters(pool, 0)).rejects.toThrow('VALIDATION_FAILED');
  });
});

async function appendOutboxEventCounts(): Promise<number> {
  return (await pool.query<{ c: number }>(
    `SELECT count(*)::int AS c FROM platform.outbox_event
     WHERE published_at < now() - interval '400 days'`,
  )).rows[0]!.c;
}
