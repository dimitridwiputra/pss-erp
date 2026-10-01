import type { Pool, PoolClient } from 'pg';
import Decimal from 'decimal.js';
import type { AuditedTransaction } from '@pss/audit';
import { withConnection } from '@pss/platform';
import { BusinessDateSchema, DecimalStringSchema, DomainError, newEventId, parseCommandInput } from '@pss/contracts';
import { z } from 'zod';
import { OptionalAuditContextSchema, resolveAuditContext } from './support/audit-context';
import { applyMovingAverage } from '../domain/rules/moving-average-cost';
import { requirePositiveQuantity } from '../domain/rules/quantity';
import { assertBalanceUnit, lockBalance, writeBalanceQuantity } from './stock-balance';
import { resolveBusinessDate } from './business-date';
import { publishInventoryIssued, type InventoryMovementFacts } from '../infrastructure/events/inventory-movement-events';

const IssueInventoryLineSchema = z.strictObject({
  productId: z.uuid(),
  uom: z.string().min(1).max(16),
  qty: DecimalStringSchema,
});

const IssueInventoryInputSchema = z.strictObject({
  organizationId: z.uuid(),
  warehouseId: z.uuid(),
  referenceType: z.string().min(1),
  referenceId: z.uuid(),
  /** The handover, delivery order, or other document the goods left on. */
  sourceId: z.uuid().optional(),
  businessDate: BusinessDateSchema.optional(),
  lines: z.array(IssueInventoryLineSchema).min(1),
  ...OptionalAuditContextSchema.shape,
});

export type IssueInventoryInput = z.input<typeof IssueInventoryInputSchema>;

/**
 * Issues inventory against an existing ACTIVE reservation per line (pickup handover). The qty issued
 * may be less than the qty reserved (partial pickup, POS-010) — only the qty passed in is decremented
 * and moved onto the ledger. Reconciling the remaining reserved qty on a partially-picked-up line is
 * the caller's responsibility, not this function's.
 *
 * The issue is valued at the balance's current moving average, which is what makes the demo's gross
 * profit real: the sale carries a cost for Dr HPP / Cr Persediaan, not just revenue. When the balance
 * was never valued the movement is unvalued and the event says so, for finance to route to its
 * exception queue (MVP-OD-15) rather than posting a zero.
 *
 * The reservation row is locked before the balance, and the balance before anything is written. That
 * order is the same in every movement path here, so two concurrent handovers cannot deadlock against
 * each other.
 */
export async function issueInventory(
  pool: Pool,
  client: PoolClient | undefined,
  rawInput: IssueInventoryInput,
): Promise<{ movementIds: string[] }> {
  const input = parseCommandInput(IssueInventoryInputSchema, rawInput);
  input.lines.forEach((line, index) => requirePositiveQuantity(line.qty, `lines[${index}].qty`, 'Jumlah barang keluar'));

  const work = async (transaction: AuditedTransaction): Promise<{ movementIds: string[] }> => {
    const tx = transaction.client;
    const businessDate = await resolveBusinessDate(tx, input.businessDate);
    const movementIds: string[] = [];
    const facts: InventoryMovementFacts[] = [];

    for (const [index, line] of input.lines.entries()) {
      // The unit is part of the match, not just the insert key (MVP-OD-28): a sale may hold 2 KARTON
      // and 3 PCS of one product, and the handover has to consume the line for the unit it is
      // handing over rather than whichever line the query found first.
      const reservation = await tx.query<{ id: string }>(
        `SELECT id FROM inventory.stock_reservation
         WHERE reference_type = $1 AND reference_id = $2 AND product_id = $3 AND uom = $4 AND status = 'ACTIVE'
         FOR UPDATE`,
        [input.referenceType, input.referenceId, line.productId, line.uom],
      );
      const reservationRow = reservation.rows[0];
      if (!reservationRow) throw new DomainError('NOT_FOUND');

      const balance = await lockBalance(tx, input.organizationId, input.warehouseId, line.productId, line.uom);
      // The reservation above already matched on unit, so this is the backstop for a balance that is
      // counted in a different unit from the reservation it carries — the corruption MVP-OD-28 refuses
      // at reservation time, checked again here because the ledger line is written from this balance
      // and would otherwise be valued in the wrong unit.
      assertBalanceUnit(balance, line.uom, `lines[${index}].uom`);
      const costing = applyMovingAverage({
        balanceQtyOnHand: balance.qtyOnHand,
        balanceAvgUnitCost: balance.avgUnitCost,
        kind: 'ISSUE',
        qty: line.qty,
      });
      // qty_reserved has CHECK (qty_reserved >= 0) and CHECK (qty_reserved <= qty_on_hand); a caller
      // passing more qty than was reserved fails that constraint and rolls back here, rather than
      // being (incorrectly) accepted by a JS-side float comparison. Both quantities come down together
      // so the units are not still promised to a second sale.
      await writeBalanceQuantity(tx, balance, {
        qtyOnHandDelta: new Decimal(line.qty).negated().toFixed(3),
        qtyReservedDelta: new Decimal(line.qty).negated().toFixed(3),
        avgUnitCost: costing.balanceAvgUnitCost,
      });
      await tx.query(`UPDATE inventory.stock_reservation SET status = 'CONSUMED' WHERE id = $1`, [reservationRow.id]);

      const movementId = newEventId();
      movementIds.push(movementId);
      await tx.query(
        `INSERT INTO inventory.stock_movement (
           id, organization_id, warehouse_id, product_id, uom, qty, movement_type,
           reference_type, reference_id, unit_cost, total_cost
         ) VALUES ($1, $2, $3, $4, $5, $6, 'ISSUE', $7, $8, $9::numeric, $10::numeric)`,
        [
          movementId, input.organizationId, input.warehouseId, line.productId, line.uom, line.qty,
          input.referenceType, input.referenceId, costing.movementUnitCost, costing.movementTotalCost,
        ],
      );
      facts.push({ movementId, productId: line.productId, uom: line.uom, qty: line.qty, ...costing });
    }

    const auditContext = resolveAuditContext(input, input.referenceId);
    await publishInventoryIssued(tx, {
      organizationId: input.organizationId,
      warehouseId: input.warehouseId,
      businessDate,
      sourceId: input.sourceId ?? input.referenceId,
      causationId: auditContext.requestId,
      correlationId: auditContext.correlationId,
      actor: auditContext.actor,
    }, facts);

    await transaction.appendAuditEntry({
      organizationId: input.organizationId,
      actor: auditContext.actor,
      action: 'INVENTORY_ISSUED',
      entity: { domain: 'inventory', type: 'InventoryMovement', id: input.referenceId, version: 1 },
      changes: input.lines.map((line, index) => ({
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
