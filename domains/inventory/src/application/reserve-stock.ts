import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { AuditedTransaction } from '@pss/audit';
import { DecimalStringSchema, DomainError, type FieldError } from '@pss/contracts';
import { z } from 'zod';
import { ActorInputSchema, SourceSchema } from './support/audit-context';
import { withConnection } from '@pss/platform';
import { isUniqueViolation } from './is-unique-violation';

const ReserveStockLineSchema = z.strictObject({
  productId: z.uuid(),
  uom: z.string().min(1),
  qty: DecimalStringSchema,
});

const ReserveStockInputSchema = z.strictObject({
  organizationId: z.uuid(),
  warehouseId: z.uuid(),
  referenceType: z.string().min(1),
  referenceId: z.uuid(),
  lines: z.array(ReserveStockLineSchema).min(1),
  actor: ActorInputSchema,
  requestId: z.string().min(1),
  correlationId: z.string().min(1),
  source: SourceSchema,
});

export type ReserveStockInput = z.input<typeof ReserveStockInputSchema>;

interface LockedBalance {
  id: string;
  hasEnough: boolean;
}

/** Locks the (warehouse, product) balance row, auto-creating a zero-balance row when missing. */
async function lockStockBalance(
  client: PoolClient,
  organizationId: string,
  warehouseId: string,
  productId: string,
  uom: string,
  qty: string,
): Promise<LockedBalance> {
  // ON CONFLICT DO NOTHING makes the auto-create idempotent under concurrent first reservations;
  // the following SELECT ... FOR UPDATE is then guaranteed to find and lock a row.
  await client.query(
    `INSERT INTO inventory.stock_balance (id, organization_id, warehouse_id, product_id, uom, qty_on_hand, qty_reserved, version)
     VALUES ($1, $2, $3, $4, $5, 0, 0, 1)
     ON CONFLICT (warehouse_id, product_id) DO NOTHING`,
    [randomUUID(), organizationId, warehouseId, productId, uom],
  );
  // The shortfall comparison happens in SQL (numeric arithmetic) so it stays decimal-exact —
  // qty is never parsed into a JS float (AGENTS.md §11.1 applies to quantities, not just money).
  const result = await client.query<{ id: string; has_enough: boolean }>(
    `SELECT id, (qty_on_hand - qty_reserved) >= $3::numeric AS has_enough
     FROM inventory.stock_balance
     WHERE warehouse_id = $1 AND product_id = $2
     FOR UPDATE`,
    [warehouseId, productId, qty],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Stock balance row missing immediately after its own auto-create insert.');
  return { id: row.id, hasEnough: row.has_enough };
}

/**
 * Reserves stock for every line of a checkout in one all-or-nothing transaction (POS-005.BR02):
 * FULL reservation only, no partial/backorder. If any line is short, nothing is reserved.
 */
export async function reserveStock(
  pool: Pool,
  client: PoolClient | undefined,
  input: ReserveStockInput,
): Promise<{ reservationIds: string[] }> {
  const parsed = ReserveStockInputSchema.parse(input);

  const work = async (transaction: AuditedTransaction): Promise<{ reservationIds: string[] }> => {
    const tx = transaction.client;
    const fieldErrors: FieldError[] = [];
    const lockedBalances: Array<{ balanceId: string; productId: string; uom: string; qty: string }> = [];

    for (const [index, line] of parsed.lines.entries()) {
      const balance = await lockStockBalance(tx, parsed.organizationId, parsed.warehouseId, line.productId, line.uom, line.qty);
      if (!balance.hasEnough) {
        fieldErrors.push({ path: `lines[${index}].qty`, code: 'insufficient_stock', message: 'Periksa nilai ini.' });
      }
      lockedBalances.push({ balanceId: balance.id, productId: line.productId, uom: line.uom, qty: line.qty });
    }

    if (fieldErrors.length > 0) {
      // Throwing here rolls back the whole transaction (including balances already locked and
      // read above) — nothing gets partially reserved.
      throw new DomainError('INSUFFICIENT_STOCK', [], fieldErrors);
    }

    const reservationIds: string[] = [];
    for (const [index, line] of lockedBalances.entries()) {
      const reservationId = randomUUID();
      try {
        await tx.query(
          `INSERT INTO inventory.stock_reservation (
             id, organization_id, warehouse_id, product_id, uom, qty, status, reference_type, reference_id
           ) VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', $7, $8)`,
          [reservationId, parsed.organizationId, parsed.warehouseId, line.productId, line.uom, line.qty, parsed.referenceType, parsed.referenceId],
        );
      } catch (error) {
        // Two lines for one product in one unit is one line, not two: the unique key says so (MVP-OD-12).
        // Letting the constraint violation escape would reach a POS caller as a 500 and a "Terjadi
        // kendala" screen for a cart the cashier can fix by scanning once instead of twice.
        if (!isUniqueViolation(error)) throw error;
        throw new DomainError('VALIDATION_FAILED', [], [{
          path: `lines[${index}].productId`,
          code: 'duplicate_line',
          message: 'Barang dan satuan yang sama sudah ada di keranjang. Gabungkan jadi satu baris.',
        }]);
      }
      reservationIds.push(reservationId);
      await tx.query(
        `UPDATE inventory.stock_balance
         SET qty_reserved = qty_reserved + $1::numeric, version = version + 1, updated_at = now()
         WHERE id = $2`,
        [line.qty, line.balanceId],
      );
    }

    await transaction.appendAuditEntry({
      organizationId: parsed.organizationId,
      actor: parsed.actor,
      action: 'STOCK_RESERVED',
      entity: { domain: 'inventory', type: 'StockReservation', id: parsed.referenceId, version: 1 },
      changes: parsed.lines.map((line, index) => ({
        path: `lines[${index}].qtyReserved`,
        classification: 'INTERNAL' as const,
        after: line.qty,
      })),
      requestId: parsed.requestId,
      correlationId: parsed.correlationId,
      source: parsed.source,
    });

    return { reservationIds };
  };

  return withConnection(pool, client, work);
}
