import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { AuditEntryInputSchema } from '../domain/audit-entry';
import { redactAuditChanges } from '../domain/rules/redact-audit-changes';

export interface AuditedTransaction {
  /** Use this client for the owning domain mutation and outbox insert. */
  client: PoolClient;
  appendAuditEntry(input: unknown): Promise<string>;
}

/**
 * Audit entries appended per open transaction, keyed by the client that owns it.
 *
 * The count has to belong to the *transaction*, not to one `runAuditedWork` invocation. Commands
 * nest: `runCommand` opens the transaction and hands the domain function an audited transaction,
 * and that function typically re-enters through `withConnection` with the same client. A local
 * counter gave the inner call its own tally, so the outer guard saw zero entries and rejected a
 * mutation that had in fact been audited — a false positive that would have pushed every nested
 * command to open its own connection and so lose atomicity with its idempotency row.
 *
 * A `WeakMap` keyed by the `PoolClient` is the right scope because a client is checked out for
 * exactly one transaction: the entry is unreachable as soon as the client is released, so a
 * rolled-back or committed transaction cannot leak a count into the next one.
 */
const appendedEntries = new WeakMap<PoolClient, number>();

/**
 * Use inside an already-open write transaction; rejects a callback whose transaction appended no
 * audit entry. Nested calls share the transaction's tally, so an inner command that audits
 * satisfies the outer guard too — which is the intent of AGENTS.md §14: the mutation is traced
 * once, not once per wrapper.
 */
export async function runAuditedWork<T>(client: PoolClient, work: (transaction: AuditedTransaction) => Promise<T>): Promise<T> {
  const before = appendedEntries.get(client) ?? 0;
  let active = true;
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
            causation_id, source, retention_class
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb,
            $14, $15, $16, $17, $18, $19
          )`,
          [
            id, input.organizationId, input.branchId ?? null, input.actor.userId ?? null,
            input.actor.roles, input.actor.onBehalfOf ?? null, input.actor.serviceIdentity ?? null,
            input.action, input.entity.domain, input.entity.type, input.entity.id,
            input.entity.version, JSON.stringify(redactAuditChanges(input.changes)), input.reasonCode ?? null,
            input.requestId, input.correlationId, input.causationId ?? null, input.source,
            // The class is written explicitly rather than left to the column default so that the
            // value in the row is the value the schema validated, including the default it filled in.
            // A row whose class only exists as an unstated database default cannot be traced back to
            // the declaration that produced it.
            input.retentionClass,
          ],
        );
        appendedEntries.set(client, (appendedEntries.get(client) ?? 0) + 1);
        return id;
      },
    });
    if ((appendedEntries.get(client) ?? 0) === before) {
      throw new Error('A state mutation requires an audit entry.');
    }
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
