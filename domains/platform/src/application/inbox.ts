import type { Pool, PoolClient } from 'pg';
import { parseEventForPublication } from '@pss/contracts';
import type { PublishableEvent } from './outbox';

export interface ConsumerInbox {
  /** Insert a receipt in the consuming domain's own table using this client. */
  reserve(client: PoolClient, eventId: string): Promise<boolean>;
}

export type InboxResult<T> =
  | { status: 'PROCESSED'; value: T }
  | { status: 'DUPLICATE' };

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
): Promise<InboxResult<T>> {
  const event = parseEventForPublication(rawEvent);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
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
