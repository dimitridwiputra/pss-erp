import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import { DomainError } from '@pss/contracts';

function parseOrThrow<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  const fieldErrors = result.error.issues.map((issue) => ({ path: issue.path.join('.') || 'input', code: issue.code, message: 'Periksa nilai ini.' }));
  throw new DomainError('VALIDATION_FAILED', [], fieldErrors);
}

const CreatePosSaleSchema = z.strictObject({ organizationId: z.uuid(), terminalId: z.uuid(), shiftId: z.uuid() });
export type CreatePosSaleInput = z.input<typeof CreatePosSaleSchema>;

export interface PosSaleCart { id: string; status: 'CART' }

/** POS-003: opens an empty cart. No price/stock resolution happens here — only AddPosSaleLine does. */
export async function createPosSale(pool: Pool, raw: CreatePosSaleInput): Promise<PosSaleCart> {
  const input = parseOrThrow(CreatePosSaleSchema, raw);
  const shift = await pool.query<{ status: string }>('SELECT status FROM pos.pos_shift WHERE id = $1', [input.shiftId]);
  if (shift.rows[0]?.status !== 'OPEN') throw new DomainError('POS_SHIFT_NOT_OPEN');
  const id = randomUUID();
  await pool.query(
    `INSERT INTO pos.pos_sale (id, organization_id, terminal_id, shift_id, status) VALUES ($1, $2, $3, $4, 'CART')`,
    [id, input.organizationId, input.terminalId, input.shiftId],
  );
  return { id, status: 'CART' };
}

async function assertCart(pool: Pool, saleId: string): Promise<void> {
  const sale = await pool.query<{ status: string }>('SELECT status FROM pos.pos_sale WHERE id = $1', [saleId]);
  if (!sale.rows[0]) throw new DomainError('NOT_FOUND');
  if (sale.rows[0].status !== 'CART') throw new DomainError('INVALID_STATE_TRANSITION');
}

const UpdatePosSaleLineSchema = z.strictObject({ saleId: z.uuid(), lineId: z.uuid(), qty: z.string().regex(/^\d+(\.\d{1,3})?$/) });
export type UpdatePosSaleLineInput = z.input<typeof UpdatePosSaleLineSchema>;

/** Qty-only edit — price was already snapshotted by AddPosSaleLine (POS-003.BR02); just recompute line_total. */
export async function updatePosSaleLine(pool: Pool, raw: UpdatePosSaleLineInput): Promise<void> {
  const input = parseOrThrow(UpdatePosSaleLineSchema, raw);
  await assertCart(pool, input.saleId);
  const result = await pool.query(
    `UPDATE pos.pos_sale_line SET qty = $3, line_total = (unit_price * $3::numeric)
     WHERE id = $1 AND sale_id = $2`,
    [input.lineId, input.saleId, input.qty],
  );
  if (result.rowCount === 0) throw new DomainError('NOT_FOUND');
  await recomputeSaleTotals(pool, input.saleId);
}

const RemovePosSaleLineSchema = z.strictObject({ saleId: z.uuid(), lineId: z.uuid() });
export type RemovePosSaleLineInput = z.input<typeof RemovePosSaleLineSchema>;

export async function removePosSaleLine(pool: Pool, raw: RemovePosSaleLineInput): Promise<void> {
  const input = parseOrThrow(RemovePosSaleLineSchema, raw);
  await assertCart(pool, input.saleId);
  await pool.query('DELETE FROM pos.pos_sale_line WHERE id = $1 AND sale_id = $2', [input.lineId, input.saleId]);
  await recomputeSaleTotals(pool, input.saleId);
}

/** POS-003.BR04: a held cart simply stays in CART; expiry is a read-time computation (shift closed ⇒ expired), not a stored state. */
const HoldPosSaleSchema = z.strictObject({ saleId: z.uuid() });
export type HoldPosSaleInput = z.input<typeof HoldPosSaleSchema>;

export async function holdPosSale(pool: Pool, raw: HoldPosSaleInput): Promise<void> {
  const input = parseOrThrow(HoldPosSaleSchema, raw);
  await assertCart(pool, input.saleId);
  // No-op state change: CART already represents "held" until CheckoutPosSale is called.
  // Recorded as a distinct command for UX/audit-trail clarity (matches the PRD's `HoldPosSale` API concept).
}

/** Server-side SUM avoids any JS float/decimal-string arithmetic (same technique used by domains/orders). */
export async function recomputeSaleTotals(pool: Pool, saleId: string): Promise<void> {
  await pool.query(
    `UPDATE pos.pos_sale SET
       subtotal = COALESCE((SELECT SUM(line_total) FROM pos.pos_sale_line WHERE sale_id = $1), 0),
       total = COALESCE((SELECT SUM(line_total) FROM pos.pos_sale_line WHERE sale_id = $1), 0),
       updated_at = now()
     WHERE id = $1`,
    [saleId],
  );
}
