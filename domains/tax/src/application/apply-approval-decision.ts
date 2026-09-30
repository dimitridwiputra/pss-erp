import type { Pool } from 'pg';
import { runAuditedWork } from '@pss/audit';
import { ApprovalDecidedV1Schema } from '@pss/contracts';
import { withInbox } from '@pss/platform';

const CONSUMER_NAME = 'tax.tax_rate_activation.v1';

/** The approval type the PRD names for a tax-rate change (Appendix D.3, §28 TAX-001). */
export const TAX_RATE_CHANGE_APPROVAL_TYPE = 'tax_rate_change';

interface RateRow {
  id: string;
  status: string;
  version: number;
}

/**
 * TAX-001.NC02 / DEC-109: `APPROVAL_DECIDED` is what moves a rate to ACTIVE.
 *
 * The approval engine owns the decision and never writes another domain's data, so this consumer is
 * the only path from "an approver said yes" to "this rate may now be applied to an invoice". Two
 * consequences are deliberate:
 *
 *   - A rate scheduled without an approval can never be activated, because activation resolves by
 *     `approval_id` rather than by "the most recent request".
 *   - The rate row is read `FOR UPDATE`, so a replay cannot double-activate and a rejection racing
 *     an approval is serialized rather than interleaved.
 *
 * Exactly-once comes from `withInbox` plus the receipt in `core.tax_inbox_event`: a redelivered
 * event finds its receipt and skips the handler (PLT-005.BR03, APR-001.AC04/NC02).
 *
 * `TAX_RATE_ACTIVATED` (TAX-001 EVENTS EMITTED) is deliberately NOT emitted here.
 * `packages/contracts`'s `eventSchemaRegistry` has no payload schema for it and `appendOutboxEvent`
 * refuses an event that has none; registering that schema is a `packages/contracts` change this
 * domain does not own. Recorded as an open decision in `domains/tax/DOMAIN.md`.
 */
export async function applyApprovalDecision(pool: Pool, rawEvent: unknown) {
  const event = ApprovalDecidedV1Schema.parse(rawEvent);
  if (event.payload.type !== TAX_RATE_CHANGE_APPROVAL_TYPE || event.payload.ownerDomain !== 'tax') return null;

  return withInbox(pool, {
    reserve: async (client, eventId) => {
      const receipt = await client.query(
        `INSERT INTO core.tax_inbox_event (consumer_name, event_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`, [CONSUMER_NAME, eventId],
      );
      return receipt.rowCount === 1;
    },
  }, event, async (client) => {
    const rate = await client.query<RateRow>(
      `SELECT id, status, version FROM core.tax_rate
       WHERE approval_id = $1::uuid AND organization_id = $2::uuid
       FOR UPDATE`,
      [event.payload.requestId, event.organizationId],
    );
    const row = rate.rows[0];
    // An approval that names no rate of this organization is not this consumer's business. It is
    // still consumed — the receipt is written — because leaving the event unconsumed would put it
    // in a retry loop forever for something that will never become applicable.
    if (!row) return null;
    // A rejected, expired, or already-decided approval leaves the row alone. While it is SCHEDULED
    // it cannot be applied to an invoice, so the effect of a refusal is the refusal itself.
    if (row.status === 'ACTIVE' || event.payload.decision !== 'APPROVED') {
      return { taxRateId: row.id, status: row.status, version: row.version };
    }

    // Only the activating path is a mutation, so only it goes through the audited transaction. A
    // no-op that audited would claim a change that never happened (AGENTS.md §14).
    return runAuditedWork(client, async ({ appendAuditEntry }) => {
      const activated = await client.query<{ version: number }>(
        `UPDATE core.tax_rate SET status = 'ACTIVE', updated_at = now(), version = version + 1
         WHERE id = $1 RETURNING version`, [row.id],
      );
      const version = activated.rows[0]?.version;
      if (version === undefined) throw new Error('The tax rate activation did not return a version.');

      await appendAuditEntry({
        organizationId: event.organizationId,
        ...(event.branchId ? { branchId: event.branchId } : {}),
        // The deciding actor is carried on the event; a service identity is a truthful fallback for
        // a decision the engine recorded without one.
        actor: event.actor ?? { serviceIdentity: CONSUMER_NAME, roles: [] },
        action: 'TAX_RATE_ACTIVATED',
        entity: { domain: 'tax', type: 'TaxRate', id: row.id, version },
        changes: [{ path: 'status', classification: 'INTERNAL', before: row.status, after: 'ACTIVE' }],
        requestId: event.eventId,
        correlationId: event.correlationId,
        causationId: event.payload.requestId,
        source: 'SYSTEM',
      });

      return { taxRateId: row.id, status: 'ACTIVE' as const, version };
    });
  });
}