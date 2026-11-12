import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { AuditedTransaction } from '@pss/audit';
import { BusinessDateSchema, DecimalStringSchema, DomainError } from '@pss/contracts';
import { withConnection } from '@pss/platform';
import { TaxCodeSchema } from '../domain/tax-code';

const ScheduleTaxRateInputSchema = z.strictObject({
  organizationId: z.uuid(),
  /** One of the statutory codes; a zero-rated code is rejected by the database and here. */
  taxCode: TaxCodeSchema,
  /**
   * The rate in percentage points. A decimal string, never a JavaScript number: DB.R04 forbids a
   * float for any value a rate feeds into, and TAX-001.R01 forbids a rate literal in code.
   */
  rate: DecimalStringSchema,
  /**
   * The first day the rate applies (Asia/Jakarta business date). It may be in the past — a
   * retroactive correction of a mis-set rate is a legitimate thing to schedule — and it may be in
   * the future, which is how a regulatory change is put in place before it takes effect.
   */
  validFrom: BusinessDateSchema,
  /**
   * The `platform.approval_request` this rate waits on. TAX-001.NC02: a rate cannot reach ACTIVE
   * without one, so the reference is captured at the moment the row is written and the ACTIVE
   * transition is driven by the approval decision rather than by the requester.
   */
  approvalId: z.uuid(),
  /** Free-text justification for the audit trail; AGENTS.md §14 requires a reason for a policy change. */
  reason: z.string().trim().min(1).max(500),
  actor: z.strictObject({
    userId: z.uuid().optional(),
    roles: z.array(z.string().min(1)),
    serviceIdentity: z.string().min(1).optional(),
  }).refine((actor) => actor.userId !== undefined || actor.serviceIdentity !== undefined, 'An actor is required.'),
  requestId: z.string().min(1),
  correlationId: z.string().min(1),
  source: z.enum(['WEB', 'MOBILE', 'API', 'SYSTEM', 'IMPORT']),
});
export type ScheduleTaxRateInput = z.input<typeof ScheduleTaxRateInputSchema>;

export interface ScheduledTaxRate {
  taxRateId: string;
  taxCode: z.infer<typeof TaxCodeSchema>;
  rate: string;
  validFrom: string;
  status: 'SCHEDULED';
  approvalId: string;
  version: number;
}

function parseOrThrow<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  const fieldErrors = result.error.issues.map((issue) => ({
    path: issue.path.join('.') || 'input', code: issue.code, message: 'Periksa nilai ini.',
  }));
  throw new DomainError('VALIDATION_FAILED', [], fieldErrors);
}

/**
 * TAX-001 main flow 2: a new rate row for a code, effective from a date, awaiting approval.
 *
 * The row is written SCHEDULED with the approval id it will be activated by, so a rate that never
 * gets approved is visible as pending rather than silently absent (AGENTS.md §3.7). Activation
 * happens in `applyApprovalDecision` when `APPROVAL_DECIDED` arrives, which is what makes
 * TAX-001.NC02 structural rather than a convention: this command has no path to ACTIVE.
 *
 * TAX-001.BR02 — a change is a new row. Scheduling a rate for a code that already has one covering
 * the same period is rejected by `tax_rate_effective_range_excl`, and the transaction rolls back
 * whole, including the range it closed on its predecessor. The exclusion constraint is the
 * authority; this command does not pre-check it, because a check-then-write would still race.
 *
 * Note the transaction boundary: `withConnection` reuses a caller's open client so that a caller
 * composing several domain commands commits them together (ADR-0013), and audits in the same
 * transaction as the write (DB.R09).
 */
export async function scheduleTaxRate(
  pool: Pool,
  client: import('pg').PoolClient | undefined,
  rawInput: ScheduleTaxRateInput,
): Promise<ScheduledTaxRate> {
  const input = parseOrThrow(ScheduleTaxRateInputSchema, rawInput);

  return withConnection(pool, client, async (transaction: AuditedTransaction) => {
    const code = await transaction.client.query<{ id: string; zero_rated: boolean }>(
      `SELECT id, zero_rated FROM core.tax_code WHERE code = $1 AND active`, [input.taxCode],
    );
    const taxCode = code.rows[0];
    if (!taxCode) throw new DomainError('TAX_CODE_MISSING', ['Hubungi Finance'], [{
      path: 'taxCode', code: 'unknown', message: `Kode pajak ${input.taxCode} belum dikonfigurasi.`,
    }]);
    if (taxCode.zero_rated) {
      throw new DomainError('VALIDATION_FAILED', [], [{
        path: 'taxCode', code: 'zero_rated',
        message: 'Kode bebas PPN dan tidak kena PPN tidak memiliki tarif.',
      }]);
    }

    // Close the predecessor's open range at the new rate's start, so the exclusion constraint in
    // DB.R06 holds and an invoice dated the day before still finds the old rate (TAX-001.AC01).
    await transaction.client.query(
      `UPDATE core.tax_rate
       SET valid_to = $3::date, updated_at = now(), version = version + 1
       WHERE organization_id = $1::uuid AND tax_code_id = $2::uuid
         AND (valid_to IS NULL OR valid_to > $3::date)
         AND valid_from < $3::date`,
      [input.organizationId, taxCode.id, input.validFrom],
    );

    const taxRateId = randomUUID();
    const inserted = await transaction.client.query<{ status: string; version: number }>(
      `INSERT INTO core.tax_rate (
         id, organization_id, tax_code_id, rate, valid_from, status, approval_id
       ) VALUES ($1, $2, $3, $4::numeric, $5::date, 'SCHEDULED', $6)
       RETURNING status, version`,
      [taxRateId, input.organizationId, taxCode.id, input.rate, input.validFrom, input.approvalId],
    );
    const row = inserted.rows[0];
    if (!row) throw new Error('The tax rate was not returned after insertion.');

    await transaction.appendAuditEntry({
      organizationId: input.organizationId,
      actor: input.actor,
      action: 'TAX_RATE_SCHEDULED',
      entity: { domain: 'tax', type: 'TaxRate', id: taxRateId, version: row.version },
      changes: [
        { path: 'taxCode', classification: 'INTERNAL', after: input.taxCode },
        { path: 'rate', classification: 'INTERNAL', after: input.rate },
        { path: 'validFrom', classification: 'INTERNAL', after: input.validFrom },
        { path: 'status', classification: 'INTERNAL', after: row.status },
        { path: 'approvalId', classification: 'INTERNAL', after: input.approvalId },
      ],
      reasonCode: input.reason,
      requestId: input.requestId,
      correlationId: input.correlationId,
      source: input.source,
    });

    return {
      taxRateId,
      taxCode: input.taxCode,
      rate: input.rate,
      validFrom: input.validFrom,
      status: 'SCHEDULED',
      approvalId: input.approvalId,
      version: row.version,
    };
  });
}