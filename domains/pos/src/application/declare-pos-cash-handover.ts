import type { Pool } from 'pg';
import { z } from 'zod';
import { declareCashHandover } from '@pss/payments';
import { DomainError } from '@pss/contracts';

function parseOrThrow<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  const fieldErrors = result.error.issues.map((issue) => ({ path: issue.path.join('.') || 'input', code: issue.code, message: 'Periksa nilai ini.' }));
  throw new DomainError('VALIDATION_FAILED', [], fieldErrors);
}

const DeclarePosCashHandoverSchema = z.strictObject({ shiftId: z.uuid() });
export type DeclarePosCashHandoverInput = z.input<typeof DeclarePosCashHandoverSchema>;

export interface DeclaredPosCashHandover { cashCustodyRecordId: string; declaredAmount: string }

/** POS-014: declares the shift's TUNAI takings (excluding the opening float, POS-014.BR01) for Finance to verify. */
export async function declarePosCashHandover(pool: Pool, raw: DeclarePosCashHandoverInput): Promise<DeclaredPosCashHandover> {
  const input = parseOrThrow(DeclarePosCashHandoverSchema, raw);
  const shift = await pool.query<{ organization_id: string; cashier_user_id: string; status: string }>(
    'SELECT organization_id, cashier_user_id, status FROM pos.pos_shift WHERE id = $1', [input.shiftId],
  );
  const shiftRow = shift.rows[0];
  if (!shiftRow) throw new DomainError('NOT_FOUND');
  if (shiftRow.status !== 'CLOSED' && shiftRow.status !== 'CLOSED_WITH_DISCREPANCY') throw new DomainError('INVALID_STATE_TRANSITION');

  const payments = await pool.query<{ payment_id: string }>(
    `SELECT t.payment_id FROM pos.pos_tender t JOIN pos.pos_sale s ON s.id = t.sale_id
     WHERE s.shift_id = $1 AND t.method = 'TUNAI' AND t.status = 'ACCEPTED' AND t.payment_id IS NOT NULL`,
    [input.shiftId],
  );
  const paymentIds = payments.rows.map((row) => row.payment_id);
  if (paymentIds.length === 0) {
    throw new DomainError('VALIDATION_FAILED', [], [{ path: 'shiftId', code: 'no_cash', message: 'Tidak ada tunai untuk diserahkan.' }]);
  }

  const declaration = await declareCashHandover(pool, {
    organizationId: shiftRow.organization_id, source: 'POS_SHIFT', collectorId: shiftRow.cashier_user_id, paymentIds,
  });
  await pool.query("UPDATE pos.pos_shift SET status = 'HANDED_OVER', handed_over_at = now(), updated_at = now() WHERE id = $1", [input.shiftId]);
  return declaration;
}
