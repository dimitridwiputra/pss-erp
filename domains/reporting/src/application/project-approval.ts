import type { Pool } from 'pg';
import {
  ApprovalDecidedV1Schema, ApprovalDecidedV2Schema,
  ApprovalRequestedV1Schema, ApprovalRequestedV2Schema,
} from '@pss/contracts';
import { withInbox } from '@pss/platform';

const CONSUMER_NAME = 'reporting.approval_status.v1';

export async function projectApproval(pool: Pool, rawEvent: unknown) {
  const requestedV1 = ApprovalRequestedV1Schema.safeParse(rawEvent);
  const requestedV2 = ApprovalRequestedV2Schema.safeParse(rawEvent);
  const decidedV1 = ApprovalDecidedV1Schema.safeParse(rawEvent);
  const event = requestedV1.success ? requestedV1.data
    : requestedV2.success ? requestedV2.data
      : decidedV1.success ? decidedV1.data : ApprovalDecidedV2Schema.parse(rawEvent);
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
      `INSERT INTO reporting.approval_status (
         approval_id, organization_id, branch_id, type_code, owner_domain, subject_ref,
         status, aggregate_version, source_event_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (approval_id) DO UPDATE SET
         status = EXCLUDED.status, aggregate_version = EXCLUDED.aggregate_version,
         source_event_id = EXCLUDED.source_event_id, updated_at = now()
       WHERE reporting.approval_status.aggregate_version < EXCLUDED.aggregate_version`,
      [event.payload.requestId, event.organizationId, event.branchId ?? null,
        event.payload.type, event.payload.ownerDomain, event.payload.subjectRef,
        event.payload.decision, event.aggregateVersion, event.eventId],
    );
  });
}
