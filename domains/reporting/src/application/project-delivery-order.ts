import type { Pool } from 'pg';
import { DeliveryOrderDeliveredV1Schema } from '@pss/contracts';
import { withInbox } from '@pss/platform';

const CONSUMER_NAME = 'reporting.delivery_order_status.v1';

/** The inbox receipt and projection commit together; replaying the same event is safe. */
export async function projectDeliveredOrder(pool: Pool, rawEvent: unknown) {
  const event = DeliveryOrderDeliveredV1Schema.parse(rawEvent);
  return withInbox(pool, {
    reserve: async (client, eventId) => {
      const receipt = await client.query(
        `INSERT INTO reporting.inbox_event (consumer_name, event_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`, [CONSUMER_NAME, eventId],
      );
      return receipt.rowCount === 1;
    },
  }, event, async (client) => {
    await client.query(
      `INSERT INTO reporting.delivery_order_status (
         delivery_order_id, organization_id, status, delivered_at, aggregate_version, source_event_id
       ) VALUES ($1, $2, 'DELIVERED', $3, $4, $5)
       ON CONFLICT (delivery_order_id) DO UPDATE SET
         status = EXCLUDED.status,
         delivered_at = EXCLUDED.delivered_at,
         aggregate_version = EXCLUDED.aggregate_version,
         source_event_id = EXCLUDED.source_event_id,
         updated_at = now()
       WHERE reporting.delivery_order_status.aggregate_version < EXCLUDED.aggregate_version`,
      [event.payload.doId, event.organizationId, event.payload.deliveredAt, event.aggregateVersion, event.eventId],
    );
  });
}
