import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import type { AuditedTransaction } from '@pss/audit';
import { DomainError } from '@pss/contracts';
import { withConnection } from '@pss/platform';
import { assertPosReasonCode, MoneyInputSchema, parseOrThrow, RequestMetaShape } from './support/command-input';

const OpenPosShiftSchema = z.strictObject({
  organizationId: z.uuid(), terminalId: z.uuid(), cashierUserId: z.uuid(), openingFloat: MoneyInputSchema,
  ...RequestMetaShape,
});
export type OpenPosShiftInput = z.input<typeof OpenPosShiftSchema>;

export interface PosShift {
  id: string; terminalId: string; cashierUserId: string; status: 'OPEN' | 'CLOSED' | 'CLOSED_WITH_DISCREPANCY' | 'HANDED_OVER';
  openingFloat: string;
}

export async function openPosShift(pool: Pool, client: PoolClient | undefined, raw: OpenPosShiftInput): Promise<PosShift> {
  const input = parseOrThrow(OpenPosShiftSchema, raw);
  return withConnection(pool, client, async ({ client, appendAuditEntry }) => {
    const terminal = await client.query<{ status: string; branch_id: string }>(
      'SELECT status, branch_id FROM pos.pos_terminal WHERE id = $1 AND organization_id = $2', [input.terminalId, input.organizationId],
    );
    const terminalRow = terminal.rows[0];
    if (!terminalRow) throw new DomainError('NOT_FOUND');
    if (terminalRow.status !== 'ACTIVE') throw new DomainError('INVALID_STATE_TRANSITION');
    const id = randomUUID();
    const inserted = await client.query<{ opening_float: string }>(
      `INSERT INTO pos.pos_shift (id, organization_id, terminal_id, cashier_user_id, opening_float, status)
       VALUES ($1, $2, $3, $4, $5, 'OPEN')
       ON CONFLICT DO NOTHING RETURNING opening_float::text`,
      [id, input.organizationId, input.terminalId, input.cashierUserId, input.openingFloat],
    );
    // POS-000.R08: the partial unique indexes allow one OPEN shift per terminal and per cashier.
    // ON CONFLICT keeps the transaction usable, so the refusal is a clean domain error.
    const openingFloat = inserted.rows[0]?.opening_float;
    if (openingFloat === undefined) throw new DomainError('POS_SHIFT_ALREADY_OPEN');
    await appendAuditEntry({
      organizationId: input.organizationId, branchId: terminalRow.branch_id, actor: input.actor,
      action: 'POS_SHIFT_OPENED', entity: { domain: 'pos', type: 'PosShift', id, version: 1 },
      changes: [{ path: 'status', classification: 'INTERNAL', after: 'OPEN' }, { path: 'openingFloat', classification: 'INTERNAL', after: openingFloat }],
      requestId: input.requestId, correlationId: input.correlationId, source: input.source,
    });
    return { id, terminalId: input.terminalId, cashierUserId: input.cashierUserId, status: 'OPEN' as const, openingFloat };
  });
}

const CloseInputShape = {
  shiftId: z.uuid(),
  countedCash: MoneyInputSchema,
  denominations: z.record(z.string().regex(/^\d+$/), z.number().int().nonnegative()).optional(),
  // A registered RC-POS-* code (Appendix F). Required only when the count differs from expected.
  reasonCode: z.string().min(1).optional(),
  note: z.string().max(500).optional(),
  // The variance allowed without a reason. No tolerance is configured (PLT-009 has no
  // `pos.close_tolerance` key yet), so any difference needs a reason, which fails closed.
  closeTolerance: MoneyInputSchema.default('0'),
  ...RequestMetaShape,
};
const ClosePosShiftSchema = z.strictObject(CloseInputShape);
export type ClosePosShiftInput = z.input<typeof ClosePosShiftSchema>;

export interface ClosedPosShift {
  id: string; status: 'CLOSED' | 'CLOSED_WITH_DISCREPANCY'; openingFloat: string; expectedCash: string; countedCash: string; variance: string;
}

async function closeShift(transaction: AuditedTransaction, input: z.output<typeof ClosePosShiftSchema>, forced: boolean): Promise<ClosedPosShift> {
  const { client, appendAuditEntry } = transaction;
  assertPosReasonCode(input.reasonCode, 'reasonCode');
  const shift = await client.query<{ organization_id: string; status: string; version: number; branch_id: string }>(
    `SELECT s.organization_id, s.status, s.version, t.branch_id
     FROM pos.pos_shift s JOIN pos.pos_terminal t ON t.id = s.terminal_id WHERE s.id = $1 FOR UPDATE OF s`, [input.shiftId],
  );
  const shiftRow = shift.rows[0];
  if (!shiftRow) throw new DomainError('NOT_FOUND');
  if (shiftRow.status !== 'OPEN') throw new DomainError('INVALID_STATE_TRANSITION');

  const pending = await client.query("SELECT id FROM pos.pos_sale WHERE shift_id = $1 AND status = 'PENDING_PAYMENT'", [input.shiftId]);
  if ((pending.rowCount ?? 0) > 0) throw new DomainError('POS_SHIFT_HAS_PENDING_SALE');

  // POS-002.BR01: cash drawer = opening float + Σ ACCEPTED TUNAI tender `amount` (already net of
  // change, POS-006.BR01). VOIDED tenders are excluded; P0 has no void path (POS-012 is deferred).
  // Every comparison is numeric in Postgres, never a JS float.
  const computed = await client.query<{ expected: string; variance: string; within: boolean }>(
    `WITH totals AS (
       SELECT s.opening_float + COALESCE((
         SELECT SUM(t.amount) FROM pos.pos_tender t JOIN pos.pos_sale sale ON sale.id = t.sale_id
         WHERE sale.shift_id = s.id AND t.method = 'TUNAI' AND t.status = 'ACCEPTED'), 0) AS expected
       FROM pos.pos_shift s WHERE s.id = $1)
     SELECT expected::numeric(18,2)::text AS expected,
            ($2::numeric - expected)::numeric(18,2)::text AS variance,
            abs($2::numeric - expected) <= $3::numeric AS within
     FROM totals`,
    [input.shiftId, input.countedCash, input.closeTolerance],
  );
  const { expected: expectedCash, variance, within } = computed.rows[0]!;
  if (!within && !input.reasonCode) {
    throw new DomainError('VALIDATION_FAILED', [], [{ path: 'reasonCode', code: 'required', message: 'Alasan diperlukan bila ada selisih.' }]);
  }
  const status = within ? 'CLOSED' : 'CLOSED_WITH_DISCREPANCY';

  const updated = await client.query<{ opening_float: string; counted_cash: string }>(
    `UPDATE pos.pos_shift SET status = $2, expected_cash = $3, counted_cash = $4, variance = $5,
       denominations = $6::jsonb, reason_code = $7, forced_close = $8, closed_at = now(), version = version + 1, updated_at = now()
     WHERE id = $1 RETURNING opening_float::text, counted_cash::text`,
    [input.shiftId, status, expectedCash, input.countedCash, variance,
      input.denominations ? JSON.stringify(input.denominations) : null, within ? null : input.reasonCode ?? null, forced],
  );
  await appendAuditEntry({
    organizationId: shiftRow.organization_id, branchId: shiftRow.branch_id, actor: input.actor, action: 'POS_SHIFT_CLOSED',
    entity: { domain: 'pos', type: 'PosShift', id: input.shiftId, version: shiftRow.version + 1 },
    changes: [
      { path: 'status', classification: 'INTERNAL', before: 'OPEN', after: status },
      { path: 'expectedCash', classification: 'INTERNAL', after: expectedCash },
      { path: 'variance', classification: 'INTERNAL', after: variance },
      ...(input.note ? [{ path: 'note', classification: 'INTERNAL' as const, after: input.note }] : []),
    ],
    ...(within || !input.reasonCode ? {} : { reasonCode: input.reasonCode }),
    requestId: input.requestId, correlationId: input.correlationId, source: input.source,
  });
  return {
    id: input.shiftId, status, openingFloat: updated.rows[0]!.opening_float, expectedCash,
    countedCash: updated.rows[0]!.counted_cash, variance,
  };
}

export async function closePosShift(pool: Pool, client: PoolClient | undefined, raw: ClosePosShiftInput): Promise<ClosedPosShift> {
  const input = parseOrThrow(ClosePosShiftSchema, raw);
  return withConnection(pool, client, (transaction) => closeShift(transaction, input, false));
}

const ForceClosePosShiftSchema = z.strictObject({ ...CloseInputShape, supervisorReasonCode: z.string().min(1) });
export type ForceClosePosShiftInput = z.input<typeof ForceClosePosShiftSchema>;

export async function forceClosePosShift(pool: Pool, client: PoolClient | undefined, raw: ForceClosePosShiftInput): Promise<ClosedPosShift> {
  const input = parseOrThrow(ForceClosePosShiftSchema, raw);
  assertPosReasonCode(input.supervisorReasonCode, 'supervisorReasonCode');
  const { supervisorReasonCode, ...closeInput } = input;
  return withConnection(pool, client, (transaction) =>
    closeShift(transaction, { ...closeInput, reasonCode: input.reasonCode ?? supervisorReasonCode }, true));
}
