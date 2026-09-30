import type { Pool, PoolClient } from 'pg';
import type { AuditedTransaction } from '@pss/audit';
import { withConnection } from '@pss/platform';
import { BusinessDateSchema, DomainError, newEventId, parseCommandInput } from '@pss/contracts';
import { z } from 'zod';
import { OptionalAuditContextSchema, resolveAuditContext } from './support/audit-context';
import { applyMovingAverage } from '../domain/rules/moving-average-cost';
import { requireNonZeroQuantity } from '../domain/rules/quantity';
import { lockBalance, writeBalanceQuantity } from './stock-balance';
import { resolveBusinessDate } from './business-date';
import { publishInventoryAdjusted, type InventoryAdjustmentFact } from '../infrastructure/events/inventory-movement-events';

// Signed decimal: a discrepancy can be a surplus (+) or a shortage (-).
const SignedDecimalStringSchema = z.string().regex(/^-?\d+(\.\d{1,3})?$/);

const AdjustStockLineSchema = z.strictObject({
  productId: z.uuid(),
  uom: z.string().min(1).max(16),
  qtyDelta: SignedDecimalStringSchema,
  /**
   * Must be an active code in `inventory.stock_adjustment_reason`. Checked per line rather than once
   * for the whole request, so a form with one bad row points at that row — and because an adjustment
   * is a correction an operator has to justify, the reason is mandatory (AGENTS.md §14 lists stock
   * adjustment as an audited mutation with a reason code).
   */
  reasonCode: z.string().min(1).max(64),
});

const AdjustStockInputSchema = z.strictObject({
  organizationId: z.uuid(),
  warehouseId: z.uuid(),
  referenceType: z.string().min(1),
  referenceId: z.uuid(),
  businessDate: BusinessDateSchema.optional(),
  lines: z.array(AdjustStockLineSchema).min(1),
  ...OptionalAuditContextSchema.shape,
});

export type AdjustStockInput = z.input<typeof AdjustStockInputSchema>;

/** `inventory.stock_adjustment_reason` is this domain's own table, so a code check is local SQL. */
async function requireActiveReason(tx: PoolClient, line: { reasonCode: string }, path: string): Promise<string> {
  const reason = await tx.query<{ label: string }>(
    'SELECT label FROM inventory.stock_adjustment_reason WHERE code = $1 AND is_active',
    [line.reasonCode],
  );
  const row = reason.rows[0];
  if (!row) {
    throw new DomainError('VALIDATION_FAILED', [], [{
      path, code: 'unknown_reason',
      message: `Alasan "${line.reasonCode}" tidak dikenal. Pilih salah satu alasan yang tersedia.`,
    }]);
  }
  return row.label;
}

/**
 * WMS-010/011: applies a signed quantity correction and values it at the balance's current average.
 *
 * It bypasses the full INV-006 approval workflow (`StockAdjustment` REQUESTED → APPROVED → POSTED),
 * which does not exist yet, so it applies immediately as if already POSTED. `inventory.adjustment.request`
 * is what the caller's permission check should be — `admin.demo` holds it (MVP_PLAN §7) while
 * `inventory.adjustment.approve` belongs to a role no demo user holds — and the missing second stage
 * is recorded in this domain's DOMAIN.md rather than silently skipped.
 *
 * A gain and a loss are both corrections, so both are valued and both publish `INVENTORY_ADJUSTED`;
 * finance's posting rule routes the sign to Selisih Persediaan or to Persediaan (MVP_PLAN §8). The
 * average does not move, which is what makes the adjustment's own value equal to the quantity at the
 * average it just wrote off.
 */
export async function adjustStock(
  pool: Pool,
  client: PoolClient | undefined,
  rawInput: AdjustStockInput,
): Promise<{ movementIds: string[] }> {
  const input = parseCommandInput(AdjustStockInputSchema, rawInput);
  input.lines.forEach((line, index) => requireNonZeroQuantity(line.qtyDelta, `lines[${index}].qtyDelta`, 'Selisih jumlah'));

  const work = async (transaction: AuditedTransaction): Promise<{ movementIds: string[] }> => {
    const tx = transaction.client;
    const businessDate = await resolveBusinessDate(tx, input.businessDate);
    const movementIds: string[] = [];
    const facts: InventoryAdjustmentFact[] = [];
    const reasons: { path: string; label: string }[] = [];

    for (const [index, line] of input.lines.entries()) {
      const label = await requireActiveReason(tx, line, `lines[${index}].reasonCode`);
      reasons.push({ path: `lines[${index}].reasonCode`, label });
      const balance = await lockBalance(tx, input.organizationId, input.warehouseId, line.productId, line.uom);
      const costing = applyMovingAverage({
        balanceQtyOnHand: balance.qtyOnHand,
        balanceAvgUnitCost: balance.avgUnitCost,
        kind: 'ADJUSTMENT',
        qty: line.qtyDelta,
      });
      await writeBalanceQuantity(tx, balance, {
        qtyOnHandDelta: line.qtyDelta,
        qtyReservedDelta: '0',
        avgUnitCost: costing.balanceAvgUnitCost,
      }, 'MUST_NOT_DROP_BELOW_RESERVED');

      const movementId = newEventId();
      movementIds.push(movementId);
      await tx.query(
        `INSERT INTO inventory.stock_movement (
           id, organization_id, warehouse_id, product_id, uom, qty, movement_type,
           reference_type, reference_id, reason_code, unit_cost, total_cost
         ) VALUES ($1, $2, $3, $4, $5, $6, 'ADJUSTMENT', $7, $8, $9, $10::numeric, $11::numeric)`,
        [
          movementId, input.organizationId, input.warehouseId, line.productId, line.uom, line.qtyDelta,
          input.referenceType, input.referenceId, line.reasonCode, costing.movementUnitCost, costing.movementTotalCost,
        ],
      );
      facts.push({
        movementId, productId: line.productId, uom: line.uom, qty: line.qtyDelta, reasonCode: line.reasonCode, ...costing,
      });
    }

    const auditContext = resolveAuditContext(input, input.referenceId);
    await publishInventoryAdjusted(tx, {
      organizationId: input.organizationId,
      warehouseId: input.warehouseId,
      businessDate,
      sourceId: input.referenceId,
      causationId: auditContext.requestId,
      correlationId: auditContext.correlationId,
      actor: auditContext.actor,
    }, facts);

    await transaction.appendAuditEntry({
      organizationId: input.organizationId,
      actor: auditContext.actor,
      action: 'INVENTORY_ADJUSTED',
      entity: { domain: 'inventory', type: 'StockAdjustment', id: input.referenceId, version: 1 },
      changes: [
        ...input.lines.map((line, index) => ({
          path: `lines[${index}].qtyDelta`, classification: 'INTERNAL' as const, after: line.qtyDelta,
        })),
        // The label, so an auditor reading the trail sees "Barang rusak" and not only "RUSAK".
        ...reasons.map((reason) => ({
          path: reason.path, classification: 'INTERNAL' as const, after: reason.label,
        })),
      ],
      // The first line's reason stands for the whole request: the audit entry's `reason_code` column is
      // a single value, and a request that mixed reasons would be two adjustments wearing one
      // reference. Each line's own code is on its movement, its event, and in `changes`.
      reasonCode: input.lines[0]!.reasonCode,
      requestId: auditContext.requestId, correlationId: auditContext.correlationId, source: auditContext.source,
    });

    return { movementIds };
  };

  return withConnection(pool, client, work);
}
