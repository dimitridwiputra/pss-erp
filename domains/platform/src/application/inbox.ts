import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { DomainError, parseEventForPublication } from '@pss/contracts';
import { classifyDeliveryFailure } from './delivery-failure';
import { upsertDeadLetter, type DeadLetterRecord } from './dead-letter';
import { OUT_OF_ORDER_FAILURE_CODE } from './retry-policy';
import type { PublishableEvent } from './outbox';

export interface ConsumerInbox {
  /** Insert a receipt in the consuming domain's own table using this client. */
  reserve(client: PoolClient, eventId: string): Promise<boolean>;
}

/**
 * PLT-005 alternate flow: a consumer that receives an aggregate version it has not seen yet
 * must not corrupt its read model. It reports the gap and defers instead of writing. The
 * consumer declares how it knows what it already holds; a read model that already applied a
 * later version answers with that version, so a redelivered older event is a no-op rather
 * than a gap.
 */
export interface InboxOrdering {
  /** Highest aggregate version this consumer has already applied, 0 when it has applied none. */
  readAppliedVersion(client: PoolClient, event: PublishableEvent): Promise<number>;
}

export type InboxResult<T> =
  | { status: 'PROCESSED'; value: T }
  | { status: 'DUPLICATE' }
  | { status: 'DEFERRED'; expectedVersion: number };

export interface WithInboxOptions {
  ordering?: InboxOrdering;
}

/**
 * The consumer's reserve callback inserts a unique (consumer, eventId) receipt
 * in its own schema. Its handler uses the same client for every effect. The
 * queue is acked only after this function returns.
 */
export async function withInbox<T>(
  pool: Pool,
  inbox: ConsumerInbox,
  rawEvent: unknown,
  handle: (client: PoolClient, event: PublishableEvent) => Promise<T>,
  options: WithInboxOptions = {},
): Promise<InboxResult<T>> {
  const event = parseEventForPublication(rawEvent);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (options.ordering) {
      const appliedVersion = await options.ordering.readAppliedVersion(client, event);
      const expectedVersion = appliedVersion + 1;
      if (event.aggregateVersion > expectedVersion) {
        // Nothing is written: the receipt, the effect, and the gap record are all still the
        // retry's to make once the missing predecessor arrives.
        await client.query('ROLLBACK');
        return { status: 'DEFERRED', expectedVersion };
      }
    }
    if (!await inbox.reserve(client, event.eventId)) {
      await client.query('COMMIT');
      return { status: 'DUPLICATE' };
    }

    const value = await handle(client, event);
    await client.query('COMMIT');
    return { status: 'PROCESSED', value };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Why a delivery stopped. Both causes end in the same dead-letter row, never discarded. */
export type DeliveryFailureCause = 'HANDLER_FAILED' | 'OUT_OF_ORDER';

const RecordConsumerDeadLetterSchema = z.strictObject({
  consumerName: z.string().min(1).max(200),
  attemptCount: z.int().positive(),
  cause: z.enum(['HANDLER_FAILED', 'OUT_OF_ORDER']),
  expectedVersion: z.int().positive().optional(),
});

export interface RecordConsumerDeadLetterInput {
  consumerName: string;
  event: unknown;
  attemptCount: number;
  cause: DeliveryFailureCause;
  /** Required for OUT_OF_ORDER so the operator can see which predecessor is missing. */
  expectedVersion?: number;
  error?: unknown;
}

/**
 * The terminal step for a delivery that will not succeed, called by the transport once its own
 * attempt budget is spent. Persists the event, the failure code, the attempt count, and both
 * timestamps in one row, so a failed event is never a silent loss (AGENTS.md 3.7) and never a
 * second row competing with an existing one for the same event (PLT-005.BR03).
 */
export async function recordConsumerDeadLetter(
  pool: Pool, rawInput: RecordConsumerDeadLetterInput,
): Promise<DeadLetterRecord> {
  const parsed = RecordConsumerDeadLetterSchema.safeParse({
    consumerName: rawInput.consumerName,
    attemptCount: rawInput.attemptCount,
    cause: rawInput.cause,
    ...(rawInput.expectedVersion === undefined ? {} : { expectedVersion: rawInput.expectedVersion }),
  });
  if (!parsed.success) throw new DomainError('VALIDATION_FAILED');
  const input = parsed.data;
  if (input.cause === 'OUT_OF_ORDER' && input.expectedVersion === undefined) {
    throw new Error('An out-of-order dead letter must name the aggregate version it is waiting for.');
  }
  const event = parseEventForPublication(rawInput.event);
  const failure = input.cause === 'OUT_OF_ORDER'
    ? {
        class: 'TRANSIENT' as const, code: OUT_OF_ORDER_FAILURE_CODE,
        message: `Waiting for aggregate version ${input.expectedVersion} of ${event.aggregateType} ${event.aggregateId}.`,
      }
    : classifyDeliveryFailure(rawInput.error);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const deadLetter = await upsertDeadLetter(client, {
      stage: 'CONSUMER', consumerName: input.consumerName, eventId: event.eventId,
      eventType: event.eventType, aggregateType: event.aggregateType, aggregateId: event.aggregateId,
      aggregateVersion: event.aggregateVersion, organizationId: event.organizationId,
      ...(event.branchId ? { branchId: event.branchId } : {}),
      envelope: event as unknown as Record<string, unknown>,
      failureCode: failure.code, failureClass: failure.class,
      failureMessage: failure.message, attemptCount: input.attemptCount,
    });
    await client.query('COMMIT');
    return deadLetter;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
