import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { runAuditedWork, withAuditedTransaction } from '@pss/audit';
import { DomainError } from '@pss/contracts';

const ActorSchema = z.strictObject({ userId: z.uuid().optional(), roles: z.array(z.string()).default([]), serviceIdentity: z.string().optional() });
const RequestMetaSchema = z.strictObject({ requestId: z.string().min(1), correlationId: z.string().min(1), source: z.enum(['WEB', 'MOBILE', 'API', 'SYSTEM', 'IMPORT']) });

function parseOrThrow<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  const fieldErrors = result.error.issues.map((issue) => ({ path: issue.path.join('.') || 'input', code: issue.code, message: 'Periksa nilai ini.' }));
  throw new DomainError('VALIDATION_FAILED', [], fieldErrors);
}

const OpenPosShiftSchema = z.strictObject({
  organizationId: z.uuid(), terminalId: z.uuid(), cashierUserId: z.uuid(),
  openingFloat: z.string().regex(/^\d+(\.\d{1,2})?$/), actor: ActorSchema,
}).extend(RequestMetaSchema.shape);
export type OpenPosShiftInput = z.input<typeof OpenPosShiftSchema>;

export interface PosShift {
  id: string; terminalId: string; cashierUserId: string; status: 'OPEN' | 'CLOSED' | 'CLOSED_WITH_DISCREPANCY' | 'HANDED_OVER';
}

export async function openPosShift(pool: Pool, raw: OpenPosShiftInput): Promise<PosShift> {
  const input = parseOrThrow(OpenPosShiftSchema, raw);
  return withAuditedTransaction(pool, async ({ client, appendAuditEntry }) => {
    const terminal = await client.query<{ status: string; organization_id: string; branch_id: string }>(
      'SELECT status, organization_id, branch_id FROM pos.pos_terminal WHERE id = $1', [input.terminalId],
    );
    const terminalRow = terminal.rows[0];
    if (!terminalRow) throw new DomainError('NOT_FOUND');
    if (terminalRow.status !== 'ACTIVE') throw new DomainError('POS_SHIFT_STILL_OPEN');
    const id = randomUUID();
    try {
      await client.query(
        `INSERT INTO pos.pos_shift (id, organization_id, terminal_id, cashier_user_id, opening_float, status)
         VALUES ($1, $2, $3, $4, $5, 'OPEN')`,
        [id, input.organizationId, input.terminalId, input.cashierUserId, input.openingFloat],
      );
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw new DomainError('POS_SHIFT_ALREADY_OPEN');
      throw error;
    }
    await appendAuditEntry({
      organizationId: input.organizationId, branchId: terminalRow.branch_id, actor: input.actor,
      action: 'POS_SHIFT_OPENED', entity: { domain: 'pos', type: 'PosShift', id, version: 1 },
      changes: [{ path: 'status', classification: 'INTERNAL', after: 'OPEN' }, { path: 'openingFloat', classification: 'INTERNAL', after: input.openingFloat }],
      requestId: input.requestId, correlationId: input.correlationId, source: input.source,
    });
    return { id, terminalId: input.terminalId, cashierUserId: input.cashierUserId, status: 'OPEN' as const };
  });
}

const CloseInputShape = {
  shiftId: z.uuid(),
  countedCash: z.string().regex(/^\d+(\.\d{1,2})?$/),
  denominations: z.record(z.string(), z.number().int().nonnegative()).optional(),
  reasonCode: z.string().min(1).optional(),
  note: z.string().optional(),
  closeTolerance: z.string().regex(/^\d+(\.\d{1,2})?$/).default('0'),
  actor: ActorSchema,
};
const ClosePosShiftSchema = z.strictObject(CloseInputShape).extend(RequestMetaSchema.shape);
export type ClosePosShiftInput = z.input<typeof ClosePosShiftSchema>;

export interface ClosedPosShift {
  id: string; status: 'CLOSED' | 'CLOSED_WITH_DISCREPANCY'; expectedCash: string; countedCash: string; variance: string;
}

async function closeShift(client: PoolClient, appendAuditEntry: (input: unknown) => Promise<string>, input: z.output<typeof ClosePosShiftSchema>, forced: boolean): Promise<ClosedPosShift> {
  const shift = await client.query<{ organization_id: string; status: string; opening_float: string }>(
    'SELECT organization_id, status, opening_float FROM pos.pos_shift WHERE id = $1 FOR UPDATE', [input.shiftId],
  );
  const shiftRow = shift.rows[0];
  if (!shiftRow) throw new DomainError('NOT_FOUND');
  if (shiftRow.status !== 'OPEN') throw new DomainError('INVALID_STATE_TRANSITION');

  const pending = await client.query('SELECT id FROM pos.pos_sale WHERE shift_id = $1 AND status = $2', [input.shiftId, 'PENDING_PAYMENT']);
  if ((pending.rowCount ?? 0) > 0) throw new DomainError('POS_SHIFT_HAS_PENDING_SALE');

  // POS-002.BR01: cash drawer = opening float + Σ ACCEPTED TUNAI tender `amount` (already net of change,
  // per POS-006.BR01). VOIDED tunai tenders are excluded by construction — P0 has no void path (POS-012
  // is deferred); when it lands, a VOIDED tunai tender's `cash_received` must be subtracted here too.
  const tenderSum = await client.query<{ total: string | null }>(
    `SELECT SUM(t.amount)::text AS total FROM pos.pos_tender t JOIN pos.pos_sale s ON s.id = t.sale_id
     WHERE s.shift_id = $1 AND t.method = 'TUNAI' AND t.status = 'ACCEPTED'`,
    [input.shiftId],
  );
  const expected = await client.query<{ expected: string }>(
    `SELECT ($1::numeric + COALESCE($2::numeric, 0))::text AS expected`,
    [shiftRow.opening_float, tenderSum.rows[0]?.total ?? null],
  );
  const expectedCash = expected.rows[0]!.expected;
  const variance = await client.query<{ variance: string }>(
    'SELECT ($1::numeric - $2::numeric)::text AS variance', [input.countedCash, expectedCash],
  );
  const varianceValue = variance.rows[0]!.variance;
  const withinTolerance = await client.query<{ ok: boolean }>(
    'SELECT abs($1::numeric) <= $2::numeric AS ok', [varianceValue, input.closeTolerance],
  );
  if (!withinTolerance.rows[0]!.ok && !input.reasonCode) {
    throw new DomainError('VALIDATION_FAILED', [], [{ path: 'reasonCode', code: 'required', message: 'Alasan diperlukan bila ada selisih.' }]);
  }
  const status = withinTolerance.rows[0]!.ok ? 'CLOSED' : 'CLOSED_WITH_DISCREPANCY';

  await client.query(
    `UPDATE pos.pos_shift SET status = $2, expected_cash = $3, counted_cash = $4, variance = $5,
       denominations = $6::jsonb, reason_code = $7, forced_close = $8, closed_at = now(), updated_at = now()
     WHERE id = $1`,
    [input.shiftId, status, expectedCash, input.countedCash, varianceValue,
      input.denominations ? JSON.stringify(input.denominations) : null, input.reasonCode ?? null, forced],
  );
  await appendAuditEntry({
    organizationId: shiftRow.organization_id, actor: input.actor, action: 'POS_SHIFT_CLOSED',
    entity: { domain: 'pos', type: 'PosShift', id: input.shiftId, version: 2 },
    changes: [
      { path: 'status', classification: 'INTERNAL', before: 'OPEN', after: status },
      { path: 'variance', classification: 'INTERNAL', after: varianceValue },
    ],
    reasonCode: input.reasonCode,
    requestId: input.requestId, correlationId: input.correlationId, source: input.source,
  });
  return { id: input.shiftId, status, expectedCash, countedCash: input.countedCash, variance: varianceValue };
}

export async function closePosShift(pool: Pool, raw: ClosePosShiftInput): Promise<ClosedPosShift> {
  const input = parseOrThrow(ClosePosShiftSchema, raw);
  return withAuditedTransaction(pool, ({ client, appendAuditEntry }) => closeShift(client, appendAuditEntry, input, false));
}

const ForceClosePosShiftSchema = z.strictObject({ ...CloseInputShape, supervisorReasonCode: z.string().min(1) }).extend(RequestMetaSchema.shape);
export type ForceClosePosShiftInput = z.input<typeof ForceClosePosShiftSchema>;

export async function forceClosePosShift(pool: Pool, raw: ForceClosePosShiftInput): Promise<ClosedPosShift> {
  const input = parseOrThrow(ForceClosePosShiftSchema, raw);
  return withAuditedTransaction(pool, ({ client, appendAuditEntry }) =>
    closeShift(client, appendAuditEntry, { ...input, reasonCode: input.reasonCode ?? input.supervisorReasonCode }, true));
}

/** Shared-transaction variant for callers (e.g. cash handover) that already hold an open client. */
export async function loadOpenShiftForTerminal(client: PoolClient, terminalId: string): Promise<{ id: string; cashierUserId: string } | null> {
  const result = await client.query<{ id: string; cashier_user_id: string }>(
    "SELECT id, cashier_user_id FROM pos.pos_shift WHERE terminal_id = $1 AND status = 'OPEN'", [terminalId],
  );
  const row = result.rows[0];
  return row ? { id: row.id, cashierUserId: row.cashier_user_id } : null;
}

export { runAuditedWork };
