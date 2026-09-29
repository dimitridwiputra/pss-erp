import { randomUUID } from 'node:crypto';
import { runAuditedWork } from '@pss/audit';
import { DomainError, MoneyAmountSchema } from '@pss/contracts';
import type { Pool } from 'pg';
import { z } from 'zod';

const VerifyCashCustodyInputSchema = z.strictObject({
  cashCustodyRecordId: z.uuid(),
  // Matches payments.cash_custody_record.counted_amount: numeric(18,2).
  countedAmount: MoneyAmountSchema,
  verifiedBy: z.uuid(),
});

export type VerifyCashCustodyInput = z.input<typeof VerifyCashCustodyInputSchema>;
type ParsedVerifyCashCustodyInput = z.output<typeof VerifyCashCustodyInputSchema>;

export interface VerifiedCashCustody {
  cashCustodyRecordId: string;
  status: 'VERIFIED' | 'DISCREPANCY';
  variance: string;
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
  return parsed.data;
}

/**
 * Verifies a DECLARED cash custody record against a physically counted amount.
 * SOD-06: the verifier must not be the collector who declared the handover.
 * A matching count cascades VERIFIED to every linked payment; a mismatch
 * records DISCREPANCY and leaves linked payments PENDING_VERIFICATION —
 * resolving a discrepancy (CSH-002) is separate, out-of-scope future work.
 */
export async function verifyCashCustody(pool: Pool, rawInput: VerifyCashCustodyInput): Promise<VerifiedCashCustody> {
  const input = parseInput(rawInput);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const record = await client.query<{
      id: string;
      organization_id: string;
      collector_id: string;
      declared_amount: string;
      status: 'DECLARED' | 'VERIFIED' | 'DISCREPANCY' | 'RESOLVED';
    }>(
      `SELECT id, organization_id, collector_id, declared_amount, status
       FROM payments.cash_custody_record WHERE id = $1 FOR UPDATE`,
      [input.cashCustodyRecordId],
    );
    const custody = record.rows[0];
    if (!custody) throw new DomainError('NOT_FOUND');
    if (custody.status !== 'DECLARED') throw new DomainError('CUSTODY_ALREADY_VERIFIED');
    if (input.verifiedBy === custody.collector_id) throw new DomainError('SEGREGATION_OF_DUTIES');

    // Decimal arithmetic stays server-side so the comparison never touches a JS float.
    const comparison = await client.query<{ variance: string; matches: boolean }>(
      `SELECT ($1::numeric - declared_amount)::text AS variance, ($1::numeric = declared_amount) AS matches
       FROM payments.cash_custody_record WHERE id = $2`,
      [input.countedAmount, input.cashCustodyRecordId],
    );
    const { variance, matches } = comparison.rows[0]!;
    const status: 'VERIFIED' | 'DISCREPANCY' = matches ? 'VERIFIED' : 'DISCREPANCY';

    const result = await runAuditedWork(client, async ({ appendAuditEntry }) => {
      await client.query(
        `UPDATE payments.cash_custody_record
         SET status = $1, counted_amount = $2, verified_by = $3, verified_at = now()
         WHERE id = $4`,
        [status, input.countedAmount, input.verifiedBy, input.cashCustodyRecordId],
      );

      if (status === 'VERIFIED') {
        await client.query(
          `UPDATE payments.payment SET status = 'VERIFIED', verified_by = $1, verified_at = now(), version = version + 1
           WHERE id IN (SELECT payment_id FROM payments.cash_custody_payment WHERE cash_custody_record_id = $2)`,
          [input.verifiedBy, input.cashCustodyRecordId],
        );
      }

      await appendAuditEntry({
        organizationId: custody.organization_id,
        actor: { userId: input.verifiedBy },
        action: status === 'VERIFIED' ? 'CASH_CUSTODY_VERIFIED' : 'CASH_CUSTODY_DISCREPANCY_RECORDED',
        // cash_custody_record has no version column (unlike payment); this is a synthetic
        // sequence for the audit trail — 1 = declared, 2 = the single verify/discrepancy
        // transition this slice supports — not an optimistic-concurrency counter.
        entity: { domain: 'payments', type: 'CashCustodyRecord', id: input.cashCustodyRecordId, version: 2 },
        changes: [
          { path: 'status', classification: 'INTERNAL', before: 'DECLARED', after: status },
          { path: 'countedAmount', classification: 'CONFIDENTIAL', after: input.countedAmount },
          { path: 'variance', classification: 'CONFIDENTIAL', after: variance },
        ],
        requestId: randomUUID(),
        correlationId: randomUUID(),
        source: 'API',
      });

      return { cashCustodyRecordId: input.cashCustodyRecordId, status, variance };
    });

    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
