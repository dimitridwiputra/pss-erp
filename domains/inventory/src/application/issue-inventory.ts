import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { AuditedTransaction } from '@pss/audit';
import { DecimalStringSchema, DomainError } from '@pss/contracts';
import { z } from 'zod';
import { OptionalAuditContextSchema, resolveAuditContext } from './support/audit-context';
import { withConnection } from '@pss/platform';

const IssueInventoryLineSchema = z.strictObject({
  productId: z.uuid(),
  uom: z.string().min(1),
  qty: DecimalStringSchema,
});

const IssueInventoryInputSchema = z.strictObject({
  organizationId: z.uuid(),
  warehouseId: z.uuid(),
  referenceType: z.string().min(1),
  referenceId: z.uuid(),
  lines: z.array(IssueInventoryLineSchema).min(1),
  ...OptionalAuditContextSchema.shape,
});

export type IssueInventoryInput = z.input<typeof IssueInventoryInputSchema>;

/**
 * Issues inventory against an existing ACTIVE reservation per line (pickup handover). The qty
 * issued may be less than the qty reserved (partial pickup, POS-010) — only the actual qty
 * passed in is decremented from on-hand/reserved and moved onto the ledger. Reconciling any
 * remaining reserved qty on a partially-picked-up line (e.g. explicitly releasing it) is the
 * caller/fulfilment domain's responsibility, not this function's.
 */
export async function issueInventory(
  pool: Pool,
  client: PoolClient | undefined,
  input: IssueInventoryInput,
): Promise<{ movementIds: string[] }> {
  const parsed = IssueInventoryInputSchema.parse(input);

  const work = async (transaction: AuditedTransaction): Promise<{ movementIds: string[] }> => {
    const tx = transaction.client;
    const movementIds: string[] = [];

    for (const line of parsed.lines) {
      const reservation = await tx.query<{ id: string }>(
        `SELECT id FROM inventory.stock_reservation
         WHERE reference_type = $1 AND reference_id = $2 AND product_id = $3 AND status = 'ACTIVE'
         FOR UPDATE`,
        [parsed.referenceType, parsed.referenceId, line.productId],
      );
      const reservationRow = reservation.rows[0];
      if (!reservationRow) throw new DomainError('NOT_FOUND');

      // qty_reserved has CHECK (qty_reserved >= 0) and CHECK (qty_reserved <= qty_on_hand); a
      // caller passing more qty than was reserved fails that constraint and rolls back here
      // rather than being (incorrectly) accepted by a JS-side float comparison.
      await tx.query(
        `UPDATE inventory.stock_balance
         SET qty_on_hand = qty_on_hand - $1::numeric, qty_reserved = qty_reserved - $1::numeric,
             version = version + 1, updated_at = now()
         WHERE warehouse_id = $2 AND product_id = $3`,
        [line.qty, parsed.warehouseId, line.productId],
      );

      await tx.query(`UPDATE inventory.stock_reservation SET status = 'CONSUMED' WHERE id = $1`, [reservationRow.id]);

      const movementId = randomUUID();
      movementIds.push(movementId);
      await tx.query(
        `INSERT INTO inventory.stock_movement (
           id, organization_id, warehouse_id, product_id, uom, qty, movement_type, reference_type, reference_id
         ) VALUES ($1, $2, $3, $4, $5, $6, 'ISSUE', $7, $8)`,
        [movementId, parsed.organizationId, parsed.warehouseId, line.productId, line.uom, line.qty, parsed.referenceType, parsed.referenceId],
      );
    }

    const auditContext = resolveAuditContext(parsed, parsed.referenceId);
    await transaction.appendAuditEntry({
      organizationId: parsed.organizationId,
      actor: auditContext.actor,
      action: 'INVENTORY_ISSUED',
      entity: { domain: 'inventory', type: 'StockMovement', id: parsed.referenceId, version: 1 },
      changes: parsed.lines.map((line, index) => ({
        path: `lines[${index}].qtyIssued`,
        classification: 'INTERNAL' as const,
        after: line.qty,
      })),
      requestId: auditContext.requestId,
      correlationId: auditContext.correlationId,
      source: auditContext.source,
    });

    return { movementIds };
  };

  return withConnection(pool, client, work);
}
