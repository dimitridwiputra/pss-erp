import type { Pool, PoolClient } from 'pg';
import type { AuditedTransaction } from '@pss/audit';
import { withConnection } from '@pss/platform';
import { BusinessDateSchema, DecimalStringSchema, newEventId, parseCommandInput } from '@pss/contracts';
import { z } from 'zod';
import { OptionalAuditContextSchema, resolveAuditContext } from './support/audit-context';
import { applyMovingAverage } from '../domain/rules/moving-average-cost';
import { requirePositiveQuantity } from '../domain/rules/quantity';
import { lockBalance, writeBalanceQuantity } from './stock-balance';
import { resolveBusinessDate } from './business-date';
import { assertWarehouseNotForeign } from './warehouse-ownership';
import { publishInventoryReceived, type InventoryMovementFacts } from '../infrastructure/events/inventory-movement-events';

/**
 * `sourceType` says which kind of receipt this is, and it is the whole of `INVENTORY_RECEIVED`'s
 * `sourceType`. It is required rather than defaulted, and it is separate from `referenceType`, because
 * the two answer different questions: `referenceType` is the ledger's opaque pointer to whatever
 * document the caller used (a purchase order, a transfer note, a WMS task), while `sourceType` is the
 * closed vocabulary Finance's posting rules switch on. Deriving one from the other would let a caller
 * invent a value the General Ledger posts from.
 */
const ReceiveStockSourceTypeSchema = z.enum(['GOODS_RECEIPT', 'WMS_RECEIPT']);

const ReceiveStockLineSchema = z.strictObject({
  productId: z.uuid(),
  uom: z.string().min(1).max(16),
  qty: DecimalStringSchema,
  /**
   * Omitted or null means the line is received UNVALUED: the movement records no cost, the balance's
   * average does not move, and the event carries `unitCost: null` so finance routes it to its
   * exception queue instead of posting a zero (MVP_PLAN §5, AGENTS.md §3.7).
   */
  unitCost: DecimalStringSchema.nullish(),
});

const ReceiveStockInputSchema = z.strictObject({
  organizationId: z.uuid(),
  warehouseId: z.uuid(),
  /** The caller's opaque pointer to the document the goods arrived on. */
  referenceType: z.string().min(1),
  referenceId: z.uuid(),
  sourceType: ReceiveStockSourceTypeSchema,
  /**
   * The event's `sourceId`: the document the movement is about. Defaults to `referenceId`, because it
   * is the same document in every call and asking a caller to state one UUID twice is an invitation to
   * state two different ones — which would put a movement in the ledger under one document and publish
   * it under another.
   */
  sourceId: z.uuid().optional(),
  /**
   * Omitted means "the day this is recorded", resolved from the database clock in Asia/Jakarta
   * (AGENTS.md §11.1). A caller that knows the business date — the back office, an import replaying a
   * dated document — passes it, so the event is reproducible.
   */
  businessDate: BusinessDateSchema.optional(),
  lines: z.array(ReceiveStockLineSchema).min(1),
  ...OptionalAuditContextSchema.shape,
});

export type ReceiveStockInput = z.input<typeof ReceiveStockInputSchema>;

/**
 * WMS-003 goods receipt, with costing.
 *
 * This is the entry point for the demo's opening stock: the catalog arrives through this command, so
 * its value reaches the General Ledger as `INVENTORY_RECEIVED` → Dr Persediaan / Cr Barang Diterima
 * Belum Ditagih, exactly as a real purchase receipt would. It bypasses the full spec's
 * `procurement.PostGoodsReceipt` (PO matching, three-way match) because `procurement` does not exist
 * in this build — MVP_PLAN §9 lists purchase orders and AP invoices as out of scope.
 *
 * Locking, averaging and writing back is `lockBalance` → `applyMovingAverage` →
 * `writeBalanceQuantity`, in that order and in one transaction, so two receipts for the same product
 * cannot both average into a stale balance.
 */
export async function receiveStock(
  pool: Pool,
  client: PoolClient | undefined,
  rawInput: ReceiveStockInput,
): Promise<{ movementIds: string[] }> {
  const input = parseCommandInput(ReceiveStockInputSchema, rawInput);
  const sourceId = input.sourceId ?? input.referenceId;
  input.lines.forEach((line, index) => requirePositiveQuantity(line.qty, `lines[${index}].qty`, 'Jumlah barang masuk'));

  const work = async (transaction: AuditedTransaction): Promise<{ movementIds: string[] }> => {
    const tx = transaction.client;
    await assertWarehouseNotForeign(tx, input.organizationId, input.warehouseId);
    const businessDate = await resolveBusinessDate(tx, input.businessDate);
    const movementIds: string[] = [];
    const facts: InventoryMovementFacts[] = [];

    for (const line of input.lines) {
      const balance = await lockBalance(tx, input.organizationId, input.warehouseId, line.productId, line.uom);
      const costing = applyMovingAverage({
        balanceQtyOnHand: balance.qtyOnHand,
        balanceAvgUnitCost: balance.avgUnitCost,
        kind: 'RECEIVE',
        qty: line.qty,
        receivedUnitCost: line.unitCost ?? null,
      });
      await writeBalanceQuantity(tx, balance, {
        qtyOnHandDelta: line.qty,
        qtyReservedDelta: '0',
        avgUnitCost: costing.balanceAvgUnitCost,
      });

      // A uuid v7, like every event id: it is time-ordered, so the ledger's own id is a stable
      // tiebreak for two movements written in the same millisecond (a `randomUUID` v4 would order
      // them arbitrarily and the Stok screen's history would shuffle between pages).
      const movementId = newEventId();
      movementIds.push(movementId);
      await tx.query(
        `INSERT INTO inventory.stock_movement (
           id, organization_id, warehouse_id, product_id, uom, qty, movement_type,
           reference_type, reference_id, unit_cost, total_cost
         ) VALUES ($1, $2, $3, $4, $5, $6, 'RECEIVE', $7, $8, $9::numeric, $10::numeric)`,
        [
          movementId, input.organizationId, input.warehouseId, line.productId, line.uom, line.qty,
          input.sourceType, input.referenceId, costing.movementUnitCost, costing.movementTotalCost,
        ],
      );
      facts.push({ movementId, productId: line.productId, uom: line.uom, qty: line.qty, ...costing });
    }

    // The same transaction as the movement rows: an event that outlives the fact it describes, or
    // arrives without it, is a reconciliation problem rather than a retry problem (MVP_PLAN §5).
    const auditContext = resolveAuditContext(input, input.referenceId);
    await publishInventoryReceived(tx, {
      organizationId: input.organizationId,
      warehouseId: input.warehouseId,
      businessDate,
      sourceId,
      causationId: auditContext.requestId,
      correlationId: auditContext.correlationId,
      actor: auditContext.actor,
    }, input.sourceType, facts);

    await transaction.appendAuditEntry({
      organizationId: input.organizationId,
      actor: auditContext.actor,
      action: 'INVENTORY_RECEIVED',
      entity: { domain: 'inventory', type: 'InventoryMovement', id: input.referenceId, version: 1 },
      changes: input.lines.map((line, index) => ({
        path: `lines[${index}].qtyReceived`, classification: 'INTERNAL' as const, after: line.qty,
      })),
      requestId: auditContext.requestId, correlationId: auditContext.correlationId, source: auditContext.source,
    });

    return { movementIds };
  };

  return withConnection(pool, client, work);
}
