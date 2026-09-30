import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { declareCashHandover } from '@pss/payments';
import { DomainError } from '@pss/contracts';
import { withConnection } from '@pss/platform';
import { parseOrThrow, RequestMetaShape } from './support/command-input';

const DeclarePosCashHandoverSchema = z.strictObject({ shiftId: z.uuid(), ...RequestMetaShape });
export type DeclarePosCashHandoverInput = z.input<typeof DeclarePosCashHandoverSchema>;

export interface DeclaredPosCashHandover { cashCustodyRecordId: string; declaredAmount: string; openingFloat: string }

/**
 * POS-014: declares the shift's TUNAI takings, excluding the opening float (POS-014.BR01), for
 * Finance to verify. The custody record and the shift's HANDED_OVER state commit together, so a
 * failure never leaves cash declared on a shift that still reads CLOSED.
 */
export async function declarePosCashHandover(pool: Pool, client: PoolClient | undefined, raw: DeclarePosCashHandoverInput): Promise<DeclaredPosCashHandover> {
  const input = parseOrThrow(DeclarePosCashHandoverSchema, raw);
  return withConnection(pool, client, async ({ client, appendAuditEntry }) => {
    const shift = await client.query<{ organization_id: string; cashier_user_id: string; status: string; version: number; branch_id: string; opening_float: string }>(
      `SELECT s.organization_id, s.cashier_user_id, s.status, s.version, t.branch_id, s.opening_float::text
       FROM pos.pos_shift s JOIN pos.pos_terminal t ON t.id = s.terminal_id WHERE s.id = $1 FOR UPDATE OF s`, [input.shiftId],
    );
    const shiftRow = shift.rows[0];
    if (!shiftRow) throw new DomainError('NOT_FOUND');
    if (shiftRow.status !== 'CLOSED' && shiftRow.status !== 'CLOSED_WITH_DISCREPANCY') throw new DomainError('INVALID_STATE_TRANSITION');

    const payments = await client.query<{ payment_id: string }>(
      `SELECT t.payment_id FROM pos.pos_tender t JOIN pos.pos_sale s ON s.id = t.sale_id
       WHERE s.shift_id = $1 AND t.method = 'TUNAI' AND t.status = 'ACCEPTED' AND t.payment_id IS NOT NULL`,
      [input.shiftId],
    );
    const paymentIds = payments.rows.map((row) => row.payment_id);
    if (paymentIds.length === 0) {
      throw new DomainError('VALIDATION_FAILED', [], [{ path: 'shiftId', code: 'no_cash', message: 'Tidak ada tunai untuk diserahkan.' }]);
    }

    const declaration = await declareCashHandover(pool, client, {
      organizationId: shiftRow.organization_id, branchId: shiftRow.branch_id, source: 'POS_SHIFT', sourceId: input.shiftId,
      collectorId: shiftRow.cashier_user_id, paymentIds, requestId: input.requestId, correlationId: input.correlationId,
    });
    await client.query(
      "UPDATE pos.pos_shift SET status = 'HANDED_OVER', handed_over_at = now(), version = version + 1, updated_at = now() WHERE id = $1",
      [input.shiftId],
    );
    await appendAuditEntry({
      organizationId: shiftRow.organization_id, branchId: shiftRow.branch_id, actor: input.actor, action: 'POS_SHIFT_HANDED_OVER',
      entity: { domain: 'pos', type: 'PosShift', id: input.shiftId, version: shiftRow.version + 1 },
      changes: [
        { path: 'status', classification: 'INTERNAL', before: shiftRow.status, after: 'HANDED_OVER' },
        { path: 'cashCustodyRecordId', classification: 'INTERNAL', after: declaration.cashCustodyRecordId },
      ],
      requestId: input.requestId, correlationId: input.correlationId, source: input.source,
    });
    return { ...declaration, openingFloat: shiftRow.opening_float };
  });
}
