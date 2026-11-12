import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { DomainError } from '@pss/contracts';

const GetDeliveryOrderLinesInputSchema = z.strictObject({ deliveryOrderId: z.uuid() });
export type GetDeliveryOrderLinesInput = z.input<typeof GetDeliveryOrderLinesInputSchema>;

export interface DeliveryOrderLine {
  id: string; productId: string; uom: string; qtyOrdered: string; qtyDelivered: string;
}

/**
 * Read-only query added so callers that only know a `deliveryOrderId` (e.g.
 * `domains/pos`'s pickup-handover flow) can look up each line's product/UOM/qty
 * without ever reading `sales.*` tables directly — the no-cross-domain-DB-access
 * rule requires going through this application-layer query, not a raw join.
 */
/** Pass `client` to read inside the caller's transaction, so the lines match what it then locks. */
export async function getDeliveryOrderLines(pool: Pool, rawInput: GetDeliveryOrderLinesInput, client?: PoolClient): Promise<DeliveryOrderLine[]> {
  const parsed = GetDeliveryOrderLinesInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new DomainError('VALIDATION_FAILED', [], parsed.error.issues.map((issue) => ({
      path: issue.path.join('.') || 'input', code: issue.code, message: 'Periksa nilai ini.',
    })));
  }
  const result = await (client ?? pool).query<{ id: string; product_id: string; uom: string; qty_ordered: string; qty_delivered: string }>(
    'SELECT id, product_id, uom, qty_ordered, qty_delivered FROM sales.delivery_order_line WHERE delivery_order_id = $1',
    [parsed.data.deliveryOrderId],
  );
  return result.rows.map((row) => ({ id: row.id, productId: row.product_id, uom: row.uom, qtyOrdered: row.qty_ordered, qtyDelivered: row.qty_delivered }));
}
