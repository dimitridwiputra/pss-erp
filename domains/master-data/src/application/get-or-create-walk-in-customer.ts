import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import { withAuditedTransaction } from '@pss/audit';
import { isUniqueViolation } from '../domain/rules/is-unique-violation';
import { parseCommandInput } from '../domain/rules/parse-command-input';

const GetOrCreateWalkInCustomerInputSchema = z.strictObject({
  organizationId: z.uuid(),
  branchId: z.uuid(),
});

export type GetOrCreateWalkInCustomerInput = z.input<typeof GetOrCreateWalkInCustomerInputSchema>;

export interface WalkInCustomer {
  id: string;
  organizationId: string;
  branchId: string;
  code: string;
  name: string;
  status: string;
}

interface CustomerRow {
  id: string;
  organization_id: string;
  code: string;
  name: string;
  status: string;
}

const WALK_IN_CUSTOMER_NAME = 'Pelanggan Umum Grosir';

function walkInCode(branchId: string): string {
  return `WALKIN-${branchId.replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}

async function findWalkInCustomer(pool: Pool, organizationId: string, branchId: string): Promise<CustomerRow | undefined> {
  const result = await pool.query<CustomerRow>(
    `SELECT id, organization_id, code, name, status
     FROM core.customer
     WHERE organization_id = $1 AND branch_id = $2 AND is_walk_in = true`,
    [organizationId, branchId],
  );
  return result.rows[0];
}

/**
 * Returns the branch's single walk-in customer (invariant: exactly one `is_walk_in` row per branch),
 * creating it on first use. Safe under concurrent callers: a losing INSERT hits the partial unique
 * index `customer_walk_in_per_branch_idx` (Postgres 23505) and re-selects the winner's row instead of
 * failing the caller.
 */
export async function getOrCreateWalkInCustomer(pool: Pool, rawInput: GetOrCreateWalkInCustomerInput): Promise<WalkInCustomer> {
  const input = parseCommandInput(GetOrCreateWalkInCustomerInputSchema, rawInput);

  const existing = await findWalkInCustomer(pool, input.organizationId, input.branchId);
  if (existing) {
    return { id: existing.id, organizationId: existing.organization_id, branchId: input.branchId, code: existing.code, name: existing.name, status: existing.status };
  }

  const code = walkInCode(input.branchId);
  try {
    return await withAuditedTransaction(pool, async ({ client, appendAuditEntry }) => {
      const id = randomUUID();
      // Event publication deferred: no registered payload schema for CUSTOMER_CREATED yet (OD-06 tracks product ownership of this gap).
      await client.query(
        `INSERT INTO core.customer (
          id, organization_id, branch_id, code, name, is_walk_in, credit_disabled, status
        ) VALUES ($1, $2, $3, $4, $5, true, true, 'ACTIVE')`,
        [id, input.organizationId, input.branchId, code, WALK_IN_CUSTOMER_NAME],
      );
      // Synthetic request/correlation IDs: this convenience command has no upstream request context to thread through.
      await appendAuditEntry({
        organizationId: input.organizationId,
        branchId: input.branchId,
        actor: { serviceIdentity: 'master-data.walk-in-customer-provisioner', roles: [] },
        action: 'CUSTOMER_CREATED',
        entity: { domain: 'master-data', type: 'Customer', id, version: 1 },
        changes: [
          { path: 'code', classification: 'INTERNAL', after: code },
          { path: 'isWalkIn', classification: 'INTERNAL', after: true },
          { path: 'status', classification: 'INTERNAL', after: 'ACTIVE' },
        ],
        requestId: randomUUID(),
        correlationId: randomUUID(),
        source: 'SYSTEM',
      });
      return { id, organizationId: input.organizationId, branchId: input.branchId, code, name: WALK_IN_CUSTOMER_NAME, status: 'ACTIVE' };
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const raceWinner = await findWalkInCustomer(pool, input.organizationId, input.branchId);
    if (!raceWinner) throw error;
    return { id: raceWinner.id, organizationId: raceWinner.organization_id, branchId: input.branchId, code: raceWinner.code, name: raceWinner.name, status: raceWinner.status };
  }
}
