import { randomUUID } from 'node:crypto';
import { BusinessDateSchema, DomainError, newEventId, registryCatalog } from '@pss/contracts';
import { appendOutboxEvent, withConnection } from '@pss/platform';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

const VerifyCashCustodyInputSchema = z.strictObject({
  cashCustodyRecordId: z.uuid(),
  // Matches payments.cash_custody_record.counted_amount: numeric(18,2). A count is never negative.
  countedAmount: z.string().regex(/^\d+(\.\d{1,2})?$/),
  verifiedBy: z.uuid(),
  // Registered Appendix F reason codes of area CSH (RC-CSH-COUNT_SHORT, ...). See the rule below.
  reasonCode: z.string().min(1).optional(),
  businessDate: BusinessDateSchema.optional(),
  branchId: z.uuid().optional(),
  requestId: z.string().min(1).optional(),
  correlationId: z.string().min(1).optional(),
});
export type VerifyCashCustodyInput = z.input<typeof VerifyCashCustodyInputSchema>;
type ParsedVerifyCashCustodyInput = z.output<typeof VerifyCashCustodyInputSchema>;

export interface VerifiedCashCustody {
  cashCustodyRecordId: string;
  status: 'VERIFIED' | 'DISCREPANCY';
  variance: string;
}

const cashReasonCodes: ReadonlySet<string> = new Set(registryCatalog.reasonCodes.filter((reason) => reason.area === 'CSH').map((reason) => reason.code));

function jakartaBusinessDate(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function parseInput(rawInput: VerifyCashCustodyInput): ParsedVerifyCashCustodyInput {
  const parsed = VerifyCashCustodyInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new DomainError('VALIDATION_FAILED', [], parsed.error.issues.map((issue) => ({
      path: issue.path.join('.') || 'input',
      code: issue.code,
      message: 'Periksa nilai ini.',
    })));
  }
  if (parsed.data.reasonCode !== undefined && !cashReasonCodes.has(parsed.data.reasonCode)) {
    throw new DomainError('VALIDATION_FAILED', [], [{ path: 'reasonCode', code: 'invalid_value', message: 'Pilih alasan selisih yang tersedia.' }]);
  }
  return parsed.data;
}

/**
 * Verifies a DECLARED cash custody record against a physically counted amount.
 * SOD-06: the verifier must not be the collector who declared the handover.
 *
 * - A matching count sets VERIFIED and cascades VERIFIED to every linked payment.
 * - A differing count with a registered CSH reason code is also VERIFIED: the verifier accepts
 *   the count and records why it differs. The variance travels on CASH_CUSTODY_VERIFIED, where
 *   Finance posts it (MVP_PLAN §8; MVP-OD-9, demo default).
 * - A differing count without a reason stays DISCREPANCY, linked payments untouched, for the
 *   CSH-002 decision — out of scope in this slice.
 *
 * A VERIFIED POS-shift record publishes CASH_CUSTODY_VERIFIED v1 in the same transaction, built
 * from the stored record. Pass an open transaction's `client` to compose with the caller.
 */
export async function verifyCashCustody(pool: Pool, client: PoolClient | undefined, rawInput: VerifyCashCustodyInput): Promise<VerifiedCashCustody> {
  const input = parseInput(rawInput);
  const requestId = input.requestId ?? randomUUID();
  const correlationId = input.correlationId ?? requestId;
  const businessDate = input.businessDate ?? jakartaBusinessDate();

  return withConnection(pool, client, async ({ client, appendAuditEntry }) => {
    const record = await client.query<{
      organization_id: string; collector_id: string; status: string; source: string; source_id: string | null;
    }>(
      `SELECT organization_id, collector_id, status, source, source_id
       FROM payments.cash_custody_record WHERE id = $1 FOR UPDATE`,
      [input.cashCustodyRecordId],
    );
    const custody = record.rows[0];
    if (!custody) throw new DomainError('NOT_FOUND');
    if (custody.status !== 'DECLARED') throw new DomainError('CUSTODY_ALREADY_VERIFIED');
    if (input.verifiedBy === custody.collector_id) throw new DomainError('SEGREGATION_OF_DUTIES');

    // Decimal arithmetic stays server-side so the comparison never touches a JS float.
    const comparison = await client.query<{ matches: boolean }>(
      'SELECT ($1::numeric = declared_amount) AS matches FROM payments.cash_custody_record WHERE id = $2',
      [input.countedAmount, input.cashCustodyRecordId],
    );
    const matches = comparison.rows[0]!.matches;
    const status: 'VERIFIED' | 'DISCREPANCY' = matches || input.reasonCode !== undefined ? 'VERIFIED' : 'DISCREPANCY';
    const reasonCode = matches ? null : input.reasonCode ?? null;

    const updated = await client.query<{ version: number; declared_amount: string; counted_amount: string; variance: string }>(
      `UPDATE payments.cash_custody_record
       SET status = $1, counted_amount = $2, verified_by = $3, verified_at = now(), reason_code = $5,
           verified_business_date = $6, version = version + 1
       WHERE id = $4
       RETURNING version, declared_amount::text, counted_amount::text,
                 (counted_amount - declared_amount)::numeric(18,2)::text AS variance`,
      [status, input.countedAmount, input.verifiedBy, input.cashCustodyRecordId, reasonCode, businessDate],
    );
    const stored = updated.rows[0]!;

    if (status === 'VERIFIED') {
      await client.query(
        `UPDATE payments.payment SET status = 'VERIFIED', verified_by = $1, verified_at = now(), version = version + 1
         WHERE id IN (SELECT payment_id FROM payments.cash_custody_payment WHERE cash_custody_record_id = $2)`,
        [input.verifiedBy, input.cashCustodyRecordId],
      );
    }

    await appendAuditEntry({
      organizationId: custody.organization_id,
      ...(input.branchId ? { branchId: input.branchId } : {}),
      actor: { userId: input.verifiedBy },
      action: status === 'VERIFIED' ? 'CASH_CUSTODY_VERIFIED' : 'CASH_CUSTODY_DISCREPANCY_RECORDED',
      entity: { domain: 'payments', type: 'CashCustodyRecord', id: input.cashCustodyRecordId, version: stored.version },
      changes: [
        { path: 'status', classification: 'INTERNAL', before: 'DECLARED', after: status },
        { path: 'countedAmount', classification: 'CONFIDENTIAL', after: stored.counted_amount },
        { path: 'variance', classification: 'CONFIDENTIAL', after: stored.variance },
      ],
      ...(reasonCode ? { reasonCode } : {}),
      requestId, correlationId, source: 'API',
    });

    if (status === 'VERIFIED' && custody.source === 'POS_SHIFT') {
      if (!custody.source_id) throw new Error('A POS shift custody record was stored without its shift.');
      await appendOutboxEvent(client, {
        eventId: newEventId(), eventType: 'CASH_CUSTODY_VERIFIED', eventVersion: 1,
        occurredAt: new Date().toISOString(), businessDate,
        organizationId: custody.organization_id, ...(input.branchId ? { branchId: input.branchId } : {}),
        aggregateType: 'CashCustodyRecord', aggregateId: input.cashCustodyRecordId, aggregateVersion: stored.version,
        producer: 'payments', actor: { userId: input.verifiedBy },
        correlationId, causationId: requestId,
        payload: {
          cashCustodyRecordId: input.cashCustodyRecordId, declaredAmount: stored.declared_amount,
          countedAmount: stored.counted_amount, varianceAmount: stored.variance, verifiedBy: input.verifiedBy,
          sourceType: 'POS_SHIFT', sourceId: custody.source_id, businessDate,
        },
      });
    }

    return { cashCustodyRecordId: input.cashCustodyRecordId, status, variance: stored.variance };
  });
}
