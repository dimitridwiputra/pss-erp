import { randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import { DomainError } from '@pss/contracts';
import { withAuditedTransaction } from '@pss/audit';
import { isUniqueViolation } from '../domain/rules/is-unique-violation';
import { parseCommandInput } from '../domain/rules/parse-command-input';

const CustomerTaxTreatmentSchema = z.enum(['VAT_OUTPUT', 'EXEMPT', 'NON_VAT']);

const CreateCustomerInputSchema = z.strictObject({
  organizationId: z.uuid(),
  branchId: z.uuid().optional(),
  name: z.string().min(1).max(200),
  phone: z.string().min(1).max(32).optional(),
  npwp: z.string().min(1).max(32).optional(),
  segment: z.string().min(1).max(50).optional(),
  channel: z.string().min(1).max(50).optional(),
  /**
   * The sales tax code this customer is charged at (TAX-001: default kode pajak per customer).
   *
   * Optional on purpose. Omitting it stores null, which means "undetermined" — not "no tax" — and
   * a taxable invoice to that customer is refused until the treatment is recorded. Defaulting a new
   * customer to VAT_OUTPUT would be a tax decision made by whoever forgot the field, and defaulting
   * it to NON_VAT would waive tax the same way. `VAT_INPUT` is not offered: it is the supplier
   * purchase flow's code (TAX-003), not a customer's.
   */
  taxTreatment: CustomerTaxTreatmentSchema.optional(),
  actor: z.strictObject({
    userId: z.uuid().optional(),
    roles: z.array(z.string().min(1)),
    serviceIdentity: z.string().min(1).optional(),
  }).refine((actor) => actor.userId !== undefined || actor.serviceIdentity !== undefined, 'An actor is required.'),
  requestId: z.string().min(1),
  correlationId: z.string().min(1),
  source: z.enum(['WEB', 'MOBILE', 'API', 'SYSTEM', 'IMPORT']),
});

export type CreateCustomerInput = z.input<typeof CreateCustomerInputSchema>;

export interface CreatedCustomer {
  id: string;
  organizationId: string;
  branchId: string | null;
  code: string;
  name: string;
  phone: string | null;
  npwp: string | null;
  segment: string | null;
  channel: string | null;
  taxTreatment: z.infer<typeof CustomerTaxTreatmentSchema> | null;
  status: 'PENDING_REVIEW';
  version: number;
}

const MAX_CODE_ATTEMPTS = 5;

function generateCustomerCode(): string {
  return `CUS-${randomBytes(3).toString('hex').toUpperCase()}`;
}

/**
 * Quick-registers a walk-up/prospect customer as `PENDING_REVIEW` (a review/approval workflow that
 * transitions it further is out of scope here). Retries on a generated `code` collision; CUS-003
 * duplicate-person detection and MDM-006 merge are not implemented in this slice.
 *
 * The tax treatment is recorded here rather than only in a follow-up command because TAX-002 reads
 * it when an invoice is prepared, and a customer created without one blocks its own first invoice —
 * which is the intended fail-closed behaviour, not an oversight.
 */
export async function createCustomer(pool: Pool, rawInput: CreateCustomerInput): Promise<CreatedCustomer> {
  const input = parseCommandInput(CreateCustomerInputSchema, rawInput);

  for (let attempt = 1; attempt <= MAX_CODE_ATTEMPTS; attempt += 1) {
    const code = generateCustomerCode();
    try {
      return await withAuditedTransaction(pool, async ({ client, appendAuditEntry }) => {
        const id = randomUUID();
        // Event publication deferred: no registered payload schema for CUSTOMER_CREATED yet (OD-06 tracks product ownership of this gap).
        await client.query(
          `INSERT INTO core.customer (
            id, organization_id, branch_id, code, name, phone, npwp, segment, channel, tax_treatment, is_walk_in, status
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, false, 'PENDING_REVIEW')`,
          [id, input.organizationId, input.branchId ?? null, code, input.name, input.phone ?? null,
            input.npwp ?? null, input.segment ?? null, input.channel ?? null, input.taxTreatment ?? null],
        );
        await appendAuditEntry({
          organizationId: input.organizationId,
          branchId: input.branchId,
          actor: input.actor,
          action: 'CUSTOMER_CREATED',
          entity: { domain: 'master-data', type: 'Customer', id, version: 1 },
          changes: [
            { path: 'name', classification: 'INTERNAL', after: input.name },
            { path: 'code', classification: 'INTERNAL', after: code },
            { path: 'status', classification: 'INTERNAL', after: 'PENDING_REVIEW' },
            // PII per AGENTS.md §15: phone/npwp are classified PERSONAL, which redactAuditChanges masks in the stored entry.
            ...(input.phone !== undefined ? [{ path: 'phone', classification: 'PERSONAL' as const, after: input.phone }] : []),
            ...(input.npwp !== undefined ? [{ path: 'npwp', classification: 'PERSONAL' as const, after: input.npwp }] : []),
            // A tax treatment is a business classification, not personal data: it is recorded as
            // the value it is. Writing 'UNSET' rather than omitting it keeps the audit trail honest
            // that the field was considered and left unresolved.
            { path: 'taxTreatment', classification: 'INTERNAL' as const, after: input.taxTreatment ?? 'UNSET' },
          ],
          requestId: input.requestId,
          correlationId: input.correlationId,
          source: input.source,
        });
        return {
          id,
          organizationId: input.organizationId,
          branchId: input.branchId ?? null,
          code,
          name: input.name,
          phone: input.phone ?? null,
          npwp: input.npwp ?? null,
          segment: input.segment ?? null,
          channel: input.channel ?? null,
          taxTreatment: input.taxTreatment ?? null,
          status: 'PENDING_REVIEW',
          version: 1,
        };
      });
    } catch (error) {
      if (isUniqueViolation(error) && attempt < MAX_CODE_ATTEMPTS) continue;
      if (isUniqueViolation(error)) throw new DomainError('DUPLICATE_CODE');
      throw error;
    }
  }
  // Satisfies the return type: the loop above always returns or throws before falling through.
  throw new DomainError('DUPLICATE_CODE');
}