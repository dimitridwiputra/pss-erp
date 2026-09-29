import type { Pool, PoolClient } from 'pg';
import { runAuditedWork } from '@pss/audit';
import { z } from 'zod';
import { OptionalAuditContextSchema, resolveAuditContext } from './support/audit-context';

const ReleaseReservationInputSchema = z.strictObject({
  referenceType: z.string().min(1),
  referenceId: z.uuid(),
  ...OptionalAuditContextSchema.shape,
});

export type ReleaseReservationInput = z.input<typeof ReleaseReservationInputSchema>;

interface ActiveReservationRow {
  id: string;
  organization_id: string;
  warehouse_id: string;
  product_id: string;
  qty: string;
}

/**
 * Releases every ACTIVE reservation for a reference, returning the reserved qty to available
 * stock. Same open-transaction-sharing convention as `reserveStock`/`issueInventory`.
 *
 * Unlike those two, this command has a legitimate no-op path: a reference with no ACTIVE
 * reservation left (already released, already consumed, or never reserved) is not an error —
 * releasing is safe to retry. Since no mutation happens on that path, no audit entry is written
 * either (AGENTS.md §14 requires audit for state mutation; a no-op mutates nothing). That is
 * also why this command manages its own transaction directly instead of going through the
 * `withConnection` helper used by the other two commands: `runAuditedWork` rejects a callback
 * that returns without ever calling `appendAuditEntry`, which would make the no-op path throw.
 */
export async function releaseReservation(
  pool: Pool,
  client: PoolClient | undefined,
  input: ReleaseReservationInput,
): Promise<{ releasedCount: number }> {
  const parsed = ReleaseReservationInputSchema.parse(input);
  const ownsClient = client === undefined;
  const tx = client ?? (await pool.connect());
  let begun = false;
  try {
    if (ownsClient) {
      await tx.query('BEGIN');
      begun = true;
    }

    const active = await tx.query<ActiveReservationRow>(
      `SELECT id, organization_id, warehouse_id, product_id, qty
       FROM inventory.stock_reservation
       WHERE reference_type = $1 AND reference_id = $2 AND status = 'ACTIVE'
       FOR UPDATE`,
      [parsed.referenceType, parsed.referenceId],
    );

    if (active.rows.length === 0) {
      if (ownsClient) await tx.query('COMMIT');
      return { releasedCount: 0 };
    }

    const releasedCount = await runAuditedWork(tx, async (transaction) => {
      for (const reservation of active.rows) {
        await transaction.client.query(
          `UPDATE inventory.stock_balance
           SET qty_reserved = qty_reserved - $1::numeric, version = version + 1, updated_at = now()
           WHERE warehouse_id = $2 AND product_id = $3`,
          [reservation.qty, reservation.warehouse_id, reservation.product_id],
        );
      }
      await transaction.client.query(
        `UPDATE inventory.stock_reservation
         SET status = 'RELEASED', released_at = now()
         WHERE reference_type = $1 AND reference_id = $2 AND status = 'ACTIVE'`,
        [parsed.referenceType, parsed.referenceId],
      );

      const firstReservation = active.rows[0];
      if (!firstReservation) throw new Error('Active reservation row disappeared under lock.');
      const auditContext = resolveAuditContext(parsed, parsed.referenceId);
      await transaction.appendAuditEntry({
        organizationId: firstReservation.organization_id,
        actor: auditContext.actor,
        action: 'STOCK_RESERVATION_RELEASED',
        entity: { domain: 'inventory', type: 'StockReservation', id: parsed.referenceId, version: 1 },
        changes: active.rows.map((reservation) => ({
          path: `reservations[${reservation.id}].status`,
          classification: 'INTERNAL' as const,
          before: 'ACTIVE',
          after: 'RELEASED',
        })),
        requestId: auditContext.requestId,
        correlationId: auditContext.correlationId,
        source: auditContext.source,
      });

      return active.rows.length;
    });

    if (ownsClient) await tx.query('COMMIT');
    return { releasedCount };
  } catch (error) {
    if (ownsClient && begun) await tx.query('ROLLBACK');
    throw error;
  } finally {
    if (ownsClient) tx.release();
  }
}
