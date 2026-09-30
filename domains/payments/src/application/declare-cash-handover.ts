import { randomUUID } from 'node:crypto';
import { DomainError } from '@pss/contracts';
import { withConnection } from '@pss/platform';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

const DeclareCashHandoverInputSchema = z.strictObject({
  organizationId: z.uuid(),
  branchId: z.uuid().optional(),
  source: z.enum(['POS_SHIFT', 'SFA', 'FLEET']),
  // The source aggregate (a POS shift id). CASH_CUSTODY_VERIFIED v1 names it as `sourceId`.
  sourceId: z.uuid().optional(),
  collectorId: z.uuid(),
  paymentIds: z.array(z.uuid()).min(1).refine(
    (ids) => new Set(ids).size === ids.length,
    'paymentIds must not contain duplicates.',
  ),
  requestId: z.string().min(1).optional(),
  correlationId: z.string().min(1).optional(),
}).refine((input) => input.source !== 'POS_SHIFT' || input.sourceId !== undefined, {
  path: ['sourceId'], message: 'A POS shift handover names its shift.',
});
export type DeclareCashHandoverInput = z.input<typeof DeclareCashHandoverInputSchema>;
type ParsedDeclareCashHandoverInput = z.output<typeof DeclareCashHandoverInputSchema>;

export interface DeclaredCashHandover {
  cashCustodyRecordId: string;
  declaredAmount: string;
}

function parseInput(rawInput: DeclareCashHandoverInput): ParsedDeclareCashHandoverInput {
  const parsed = DeclareCashHandoverInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new DomainError('VALIDATION_FAILED', [], parsed.error.issues.map((issue) => ({
      path: issue.path.join('.') || 'input',
      code: issue.code,
      message: 'Periksa nilai ini.',
    })));
  }
  return parsed.data;
}

/**
 * Declares a cash handover (e.g. a POS shift close) linking a set of TUNAI
 * payments awaiting verification into one custody record. Idempotent per the
 * caller's exact `paymentIds`: if any of them is already linked to a
 * DECLARED/VERIFIED custody record, that existing record is returned instead
 * of creating a duplicate — a payment can only ever belong to one custody
 * declaration (see DOMAIN.md invariants for why this is an application-level
 * check rather than a database constraint). That no-op is still traced
 * (ADR-0013 4b), so the trail shows a repeated declaration changed nothing.
 *
 * Pass an open transaction's `client` to compose with the caller: POS marks its
 * shift HANDED_OVER in the same commit.
 */
export async function declareCashHandover(pool: Pool, client: PoolClient | undefined, rawInput: DeclareCashHandoverInput): Promise<DeclaredCashHandover> {
  const input = parseInput(rawInput);
  const requestId = input.requestId ?? randomUUID();
  const correlationId = input.correlationId ?? requestId;
  const branch = input.branchId ? { branchId: input.branchId } : {};

  return withConnection(pool, client, async ({ client, appendAuditEntry }) => {
    const existing = await client.query<{ id: string; declared_amount: string }>(
      `SELECT DISTINCT ccr.id, ccr.declared_amount
       FROM payments.cash_custody_payment ccp
       JOIN payments.cash_custody_record ccr ON ccr.id = ccp.cash_custody_record_id
       WHERE ccp.payment_id = ANY($1::uuid[]) AND ccr.status IN ('DECLARED', 'VERIFIED')
       LIMIT 1`,
      [input.paymentIds],
    );
    const existingRecord = existing.rows[0];
    if (existingRecord) {
      await appendAuditEntry({
        organizationId: input.organizationId, ...branch,
        actor: { userId: input.collectorId },
        action: 'CASH_HANDOVER_DECLARE_NOOP',
        entity: { domain: 'payments', type: 'CashCustodyRecord', id: existingRecord.id, version: 1 },
        changes: [{ path: 'created', classification: 'INTERNAL', after: '0' }],
        requestId, correlationId, source: 'API',
      });
      return { cashCustodyRecordId: existingRecord.id, declaredAmount: existingRecord.declared_amount };
    }

    const eligible = await client.query<{ matched_count: number; declared_amount: string }>(
      `SELECT count(*)::int AS matched_count, COALESCE(SUM(amount), 0)::text AS declared_amount
       FROM payments.payment
       WHERE id = ANY($1::uuid[]) AND organization_id = $2 AND method = 'TUNAI' AND status = 'PENDING_VERIFICATION'`,
      [input.paymentIds, input.organizationId],
    );
    const summary = eligible.rows[0];
    if (!summary || summary.matched_count !== input.paymentIds.length) {
      throw new DomainError('VALIDATION_FAILED', [], [{
        path: 'paymentIds',
        code: 'invalid_reference',
        message: 'Semua pembayaran harus TUNAI dan berstatus menunggu verifikasi.',
      }]);
    }

    const cashCustodyRecordId = randomUUID();
    await client.query(
      `INSERT INTO payments.cash_custody_record (
         id, organization_id, source, source_id, collector_id, declared_amount, status
       ) VALUES ($1, $2, $3, $4, $5, $6, 'DECLARED')`,
      [cashCustodyRecordId, input.organizationId, input.source, input.sourceId ?? null, input.collectorId, summary.declared_amount],
    );
    for (const paymentId of input.paymentIds) {
      await client.query(
        `INSERT INTO payments.cash_custody_payment (cash_custody_record_id, payment_id) VALUES ($1, $2)`,
        [cashCustodyRecordId, paymentId],
      );
    }

    await appendAuditEntry({
      organizationId: input.organizationId, ...branch,
      actor: { userId: input.collectorId },
      action: 'CASH_HANDED_OVER',
      entity: { domain: 'payments', type: 'CashCustodyRecord', id: cashCustodyRecordId, version: 1 },
      changes: [
        { path: 'status', classification: 'INTERNAL', after: 'DECLARED' },
        { path: 'declaredAmount', classification: 'CONFIDENTIAL', after: summary.declared_amount },
      ],
      requestId, correlationId, source: 'API',
    });
    return { cashCustodyRecordId, declaredAmount: summary.declared_amount };
  });
}
