import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { AuditEntryInputSchema } from '../domain/audit-entry';
import { redactAuditChanges } from '../domain/rules/redact-audit-changes';

export interface AuditedTransaction {
  /** Use this client for the owning domain mutation and outbox insert. */
  client: PoolClient;
  appendAuditEntry(input: unknown): Promise<string>;
}

/** Use inside an already-open write transaction; rejects a callback that omitted audit. */
export async function runAuditedWork<T>(client: PoolClient, work: (transaction: AuditedTransaction) => Promise<T>): Promise<T> {
  let active = true;
  let auditCount = 0;
  try {
    const result = await work({
      client,
      appendAuditEntry: async (rawInput) => {
        if (!active) throw new Error('Audit transaction has ended.');
        const input = AuditEntryInputSchema.parse(rawInput);
        const id = randomUUID();
        await client.query(
          `INSERT INTO audit.audit_entry (
            id, organization_id, branch_id, actor_user_id, actor_roles, actor_on_behalf_of,
            actor_service_identity, action, entity_domain, entity_type, entity_id,
            entity_version, changes, reason_code, request_id, correlation_id,
            causation_id, source
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb,
            $14, $15, $16, $17, $18
          )`,
          [
            id, input.organizationId, input.branchId ?? null, input.actor.userId ?? null,
            input.actor.roles, input.actor.onBehalfOf ?? null, input.actor.serviceIdentity ?? null,
            input.action, input.entity.domain, input.entity.type, input.entity.id,
            input.entity.version, JSON.stringify(redactAuditChanges(input.changes)), input.reasonCode ?? null,
            input.requestId, input.correlationId, input.causationId ?? null, input.source,
          ],
        );
        auditCount += 1;
        return id;
      },
    });
    if (auditCount === 0) throw new Error('A state mutation requires an audit entry.');
    return result;
  } finally {
    active = false;
  }
}

/** A write transaction cannot commit until it has an audit entry. */
export async function withAuditedTransaction<T>(pool: Pool, work: (transaction: AuditedTransaction) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let begun = false;
  try {
    await client.query('BEGIN');
    begun = true;
    const result = await runAuditedWork(client, work);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    if (begun) await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
