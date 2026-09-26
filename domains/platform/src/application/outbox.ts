import type { Pool, PoolClient } from 'pg';
import { parseEventForPublication } from '@pss/contracts';

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

/** Publish one aggregate-ordered row at a time; failed sends remain pending for retry. */
export async function dispatchPendingEvents(pool: Pool, transport: EventTransport, limit = 100): Promise<number> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Outbox dispatch limit must be between 1 and 1000.');
  let published = 0;
  for (let index = 0; index < limit; index += 1) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ event_id: string; envelope: unknown }>(
        `SELECT o.event_id, o.envelope
         FROM platform.outbox_event o
         WHERE o.published_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM platform.outbox_event older
             WHERE older.aggregate_type = o.aggregate_type
               AND older.aggregate_id = o.aggregate_id
               AND older.published_at IS NULL
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
      await transport.publish(event);
      await client.query('UPDATE platform.outbox_event SET published_at = now() WHERE event_id = $1', [row.event_id]);
      await client.query('COMMIT');
      published += 1;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  return published;
}
