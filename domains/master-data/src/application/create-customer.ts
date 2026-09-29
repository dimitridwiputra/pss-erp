import { randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import { DomainError } from '@pss/contracts';
import { withAuditedTransaction } from '@pss/audit';
import { isUniqueViolation } from '../domain/rules/is-unique-violation';
import { parseCommandInput } from '../domain/rules/parse-command-input';

const CreateCustomerInputSchema = z.strictObject({
  organizationId: z.uuid(),
  branchId: z.uuid().optional(),
  name: z.string().min(1).max(200),
  phone: z.string().min(1).max(32).optional(),
  npwp: z.string().min(1).max(32).optional(),
  segment: z.string().min(1).max(50).optional(),
  channel: z.string().min(1).max(50).optional(),
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
            id, organization_id, branch_id, code, name, phone, npwp, segment, channel, is_walk_in, status
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, false, 'PENDING_REVIEW')`,
          [id, input.organizationId, input.branchId ?? null, code, input.name, input.phone ?? null, input.npwp ?? null, input.segment ?? null, input.channel ?? null],
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
