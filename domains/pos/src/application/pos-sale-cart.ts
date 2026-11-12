import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import type { AuditedTransaction } from '@pss/audit';
import { DomainError } from '@pss/contracts';
import { withConnection } from '@pss/platform';
import { parseOrThrow, QuantityInputSchema, RequestMetaShape } from './support/command-input';

const CreatePosSaleSchema = z.strictObject({ shiftId: z.uuid(), ...RequestMetaShape });
export type CreatePosSaleInput = z.input<typeof CreatePosSaleSchema>;

export interface PosSaleCart { id: string; status: 'CART' }

/**
 * POS-003: opens an empty cart on an OPEN shift. The terminal and organization come from the
 * shift itself, never from the caller, so a sale can never be attached to another terminal's
 * shift. No price or stock is resolved here; only AddPosSaleLine does that.
 */
export async function createPosSale(pool: Pool, client: PoolClient | undefined, raw: CreatePosSaleInput): Promise<PosSaleCart> {
  const input = parseOrThrow(CreatePosSaleSchema, raw);
  return withConnection(pool, client, async ({ client, appendAuditEntry }) => {
    const shift = await client.query<{ status: string; organization_id: string; terminal_id: string; branch_id: string }>(
      `SELECT s.status, s.organization_id, s.terminal_id, t.branch_id
       FROM pos.pos_shift s JOIN pos.pos_terminal t ON t.id = s.terminal_id WHERE s.id = $1 FOR SHARE OF s`, [input.shiftId],
    );
    const shiftRow = shift.rows[0];
    if (!shiftRow) throw new DomainError('NOT_FOUND');
    if (shiftRow.status !== 'OPEN') throw new DomainError('POS_SHIFT_NOT_OPEN');
    const id = randomUUID();
    await client.query(
      `INSERT INTO pos.pos_sale (id, organization_id, terminal_id, shift_id, status) VALUES ($1, $2, $3, $4, 'CART')`,
      [id, shiftRow.organization_id, shiftRow.terminal_id, input.shiftId],
    );
    await appendAuditEntry({
      organizationId: shiftRow.organization_id, branchId: shiftRow.branch_id, actor: input.actor,
      action: 'POS_SALE_CREATED', entity: { domain: 'pos', type: 'PosSale', id, version: 1 },
      changes: [{ path: 'status', classification: 'INTERNAL', after: 'CART' }],
      requestId: input.requestId, correlationId: input.correlationId, source: input.source,
    });
    return { id, status: 'CART' as const };
  });
}

export interface LockedCart { organizationId: string; branchId: string; version: number }

/** Locks a CART sale for a line edit; the shift must still be OPEN (POS-003.BR04: a closed shift's cart is expired). */
export async function lockCart(client: PoolClient, saleId: string): Promise<LockedCart> {
  const sale = await client.query<{ status: string; organization_id: string; version: number; shift_status: string; branch_id: string }>(
    `SELECT sale.status, sale.organization_id, sale.version, s.status AS shift_status, t.branch_id
     FROM pos.pos_sale sale JOIN pos.pos_shift s ON s.id = sale.shift_id JOIN pos.pos_terminal t ON t.id = sale.terminal_id
     WHERE sale.id = $1 FOR UPDATE OF sale`, [saleId],
  );
  const row = sale.rows[0];
  if (!row) throw new DomainError('NOT_FOUND');
  if (row.status !== 'CART') throw new DomainError('INVALID_STATE_TRANSITION');
  if (row.shift_status !== 'OPEN') throw new DomainError('POS_SHIFT_NOT_OPEN');
  return { organizationId: row.organization_id, branchId: row.branch_id, version: row.version };
}

/** Server-side SUM avoids any JS float/decimal-string arithmetic (same technique used by domains/orders). */
export async function recomputeSaleTotals(client: PoolClient, saleId: string): Promise<{ total: string; version: number }> {
  const updated = await client.query<{ total: string; version: number }>(
    `UPDATE pos.pos_sale SET
       subtotal = COALESCE((SELECT SUM(line_total) FROM pos.pos_sale_line WHERE sale_id = $1), 0),
       total = COALESCE((SELECT SUM(line_total) FROM pos.pos_sale_line WHERE sale_id = $1), 0),
       version = version + 1, updated_at = now()
     WHERE id = $1 RETURNING total::text, version`,
    [saleId],
  );
  return updated.rows[0]!;
}

const UpdatePosSaleLineSchema = z.strictObject({ saleId: z.uuid(), lineId: z.uuid(), qty: QuantityInputSchema, ...RequestMetaShape });
export type UpdatePosSaleLineInput = z.input<typeof UpdatePosSaleLineSchema>;

async function auditLineChange(transaction: AuditedTransaction, cart: LockedCart, input: { saleId: string; lineId: string } & z.output<z.ZodObject<typeof RequestMetaShape>>, action: string, after: { qty?: string; total: string; version: number }) {
  await transaction.appendAuditEntry({
    organizationId: cart.organizationId, branchId: cart.branchId, actor: input.actor, action,
    entity: { domain: 'pos', type: 'PosSale', id: input.saleId, version: after.version },
    changes: [
      { path: `lines.${input.lineId}.qty`, classification: 'INTERNAL', after: after.qty ?? '0' },
      { path: 'total', classification: 'INTERNAL', after: after.total },
    ],
    requestId: input.requestId, correlationId: input.correlationId, source: input.source,
  });
}

/** Qty-only edit: price was already snapshotted by AddPosSaleLine (POS-003.BR02), so only line_total is recomputed. */
export async function updatePosSaleLine(pool: Pool, client: PoolClient | undefined, raw: UpdatePosSaleLineInput): Promise<{ total: string }> {
  const input = parseOrThrow(UpdatePosSaleLineSchema, raw);
  return withConnection(pool, client, async (transaction) => {
    const cart = await lockCart(transaction.client, input.saleId);
    const result = await transaction.client.query(
      'UPDATE pos.pos_sale_line SET qty = $3, line_total = (unit_price * $3::numeric) WHERE id = $1 AND sale_id = $2',
      [input.lineId, input.saleId, input.qty],
    );
    if (result.rowCount === 0) throw new DomainError('NOT_FOUND');
    const totals = await recomputeSaleTotals(transaction.client, input.saleId);
    await auditLineChange(transaction, cart, input, 'POS_SALE_LINE_UPDATED', { qty: input.qty, ...totals });
    return { total: totals.total };
  });
}

const RemovePosSaleLineSchema = z.strictObject({ saleId: z.uuid(), lineId: z.uuid(), ...RequestMetaShape });
export type RemovePosSaleLineInput = z.input<typeof RemovePosSaleLineSchema>;

export async function removePosSaleLine(pool: Pool, client: PoolClient | undefined, raw: RemovePosSaleLineInput): Promise<{ total: string }> {
  const input = parseOrThrow(RemovePosSaleLineSchema, raw);
  return withConnection(pool, client, async (transaction) => {
    const cart = await lockCart(transaction.client, input.saleId);
    const result = await transaction.client.query('DELETE FROM pos.pos_sale_line WHERE id = $1 AND sale_id = $2', [input.lineId, input.saleId]);
    if (result.rowCount === 0) throw new DomainError('NOT_FOUND');
    const totals = await recomputeSaleTotals(transaction.client, input.saleId);
    await auditLineChange(transaction, cart, input, 'POS_SALE_LINE_REMOVED', totals);
    return { total: totals.total };
  });
}
