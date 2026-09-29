import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import { DomainError } from '@pss/contracts';
import { createPosSale } from './pos-sale-cart';
import { addPosSaleLine } from './add-pos-sale-line';
import { checkoutPosSale } from './checkout-pos-sale';
import { acceptPosTender } from './accept-pos-tender';

function parseOrThrow<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  const fieldErrors = result.error.issues.map((issue) => ({ path: issue.path.join('.') || 'input', code: issue.code, message: 'Periksa nilai ini.' }));
  throw new DomainError('VALIDATION_FAILED', [], fieldErrors);
}

const OfflineSaleLineSchema = z.strictObject({ productId: z.uuid(), uom: z.string().min(1), sku: z.string().min(1), name: z.string().min(1), qty: z.string() });
const OfflineSaleSchema = z.strictObject({
  offlineSaleId: z.uuid(), number: z.string().min(1), customerId: z.uuid().nullable(),
  lines: z.array(OfflineSaleLineSchema).min(1), cashReceived: z.string(), deviceTime: z.string(),
});
const SyncPosOfflineBatchSchema = z.strictObject({
  organizationId: z.uuid(), terminalId: z.uuid(), priceListScope: z.string().min(1),
  actorId: z.uuid(), sales: z.array(OfflineSaleSchema).min(1),
});
export type SyncPosOfflineBatchInput = z.input<typeof SyncPosOfflineBatchSchema>;

export interface OfflineSaleSyncResult { offlineSaleId: string; outcome: 'SAVED' | 'NEEDS_REVIEW'; posSaleId: string | null; reason: string | null }
export interface SyncedPosOfflineBatch { batchId: string; status: 'APPLIED' | 'APPLIED_WITH_CONFLICTS'; results: OfflineSaleSyncResult[] }

/**
 * POS-013: replays a batch of offline cash sales. Idempotent per `offlineSaleId` — a batch
 * resubmitted after a partial network failure skips any sale already recorded (matched by its
 * offline-block `number`, which is unique per organization same as any other PosSale number).
 * Each sale runs the normal online path (createPosSale -> addPosSaleLine* -> checkoutPosSale ->
 * acceptPosTender) so it gets exactly the same server-side guards (stock, price) as an online
 * sale; a failure for one sale is recorded as `NEEDS_REVIEW` and does not abort the rest of the
 * batch (PP-09: nothing silently drops).
 */
export async function syncPosOfflineBatch(pool: Pool, raw: SyncPosOfflineBatchInput): Promise<SyncedPosOfflineBatch> {
  const input = parseOrThrow(SyncPosOfflineBatchSchema, raw);
  const shift = await pool.query<{ id: string }>("SELECT id FROM pos.pos_shift WHERE terminal_id = $1 AND status = 'OPEN'", [input.terminalId]);
  const shiftId = shift.rows[0]?.id;

  const batchId = randomUUID();
  await pool.query(
    "INSERT INTO pos.pos_offline_batch (id, terminal_id, status, payload) VALUES ($1, $2, 'RECEIVED', $3::jsonb)",
    [batchId, input.terminalId, JSON.stringify(input.sales)],
  );

  const results: OfflineSaleSyncResult[] = [];
  for (const sale of input.sales) {
    try {
      const existing = await pool.query<{ id: string }>('SELECT id FROM pos.pos_sale WHERE organization_id = $1 AND number = $2', [input.organizationId, sale.number]);
      if (existing.rows[0]) { results.push({ offlineSaleId: sale.offlineSaleId, outcome: 'SAVED', posSaleId: existing.rows[0].id, reason: null }); continue; }
      if (!shiftId) throw new DomainError('POS_SHIFT_NOT_OPEN');

      const created = await createPosSale(pool, { organizationId: input.organizationId, terminalId: input.terminalId, shiftId });
      await pool.query('UPDATE pos.pos_sale SET number = $2 WHERE id = $1', [created.id, sale.number]);
      if (sale.customerId) await pool.query('UPDATE pos.pos_sale SET customer_id = $2 WHERE id = $1', [created.id, sale.customerId]);

      for (const line of sale.lines) {
        await addPosSaleLine(pool, {
          organizationId: input.organizationId, saleId: created.id, priceListScope: input.priceListScope,
          productId: line.productId, uom: line.uom, sku: line.sku, name: line.name, qty: line.qty,
        });
      }

      await checkoutPosSale(pool, {
        saleId: created.id, actor: { userId: input.actorId, roles: [] },
        requestId: randomUUID(), correlationId: randomUUID(), source: 'MOBILE',
      });
      await acceptPosTender(pool, {
        saleId: created.id, method: 'TUNAI', cashReceived: sale.cashReceived, acceptedBy: input.actorId,
        requestId: randomUUID(), correlationId: randomUUID(), source: 'MOBILE',
      });

      results.push({ offlineSaleId: sale.offlineSaleId, outcome: 'SAVED', posSaleId: created.id, reason: null });
    } catch (error) {
      const reason = error instanceof DomainError ? error.code : 'UNKNOWN_ERROR';
      results.push({ offlineSaleId: sale.offlineSaleId, outcome: 'NEEDS_REVIEW', posSaleId: null, reason });
    }
  }

  const status = results.every((result) => result.outcome === 'SAVED') ? 'APPLIED' : 'APPLIED_WITH_CONFLICTS';
  await pool.query(
    "UPDATE pos.pos_offline_batch SET status = $2, result = $3::jsonb, applied_at = now() WHERE id = $1",
    [batchId, status, JSON.stringify(results)],
  );
  return { batchId, status, results };
}
