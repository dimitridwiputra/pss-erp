import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runAuditedWork, withAuditedTransaction } from '../src/application/append-audit-entry';

const databaseName = `pss_audit_test_${randomUUID().replaceAll('-', '')}`;
const organizationId = randomUUID();
const entityId = randomUUID();
const delegatedUserId = randomUUID();
let admin: pg.Client;
let pool: pg.Pool;

function entry(requestId: string, version: number) {
  return {
    organizationId,
    actor: { serviceIdentity: 'audit-integration-test', roles: ['SYSTEM'], onBehalfOf: delegatedUserId },
    action: 'EXAMPLE_STATUS_CHANGED',
    entity: { domain: 'audit', type: 'test_record', id: entityId, version },
    changes: [
      { path: 'status', classification: 'INTERNAL', before: 'DRAFT', after: 'CONFIRMED' },
      { path: 'customer.nik', classification: 'PERSONAL', after: '3273010101010001' },
    ],
    requestId,
    correlationId: 'audit-integration-correlation',
    source: 'SYSTEM',
  };
}

beforeAll(async () => {
  const baseUrl = process.env.PSS_TEST_DATABASE_URL;
  if (!baseUrl) throw new Error('PSS_TEST_DATABASE_URL is required for PostgreSQL integration tests.');
  admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  // Name is generated locally from a UUID, never supplied by a caller.
  await admin.query(`CREATE DATABASE ${databaseName}`);
  const testUrl = new URL(baseUrl);
  testUrl.pathname = `/${databaseName}`;
  pool = new pg.Pool({ connectionString: testUrl.toString() });
  const migration = await readFile(new URL('../infrastructure/database/migrations/0001_audit_entry.sql', import.meta.url), 'utf8');
  await pool.query(migration);
  await pool.query('CREATE TABLE public.test_record (id uuid PRIMARY KEY, status text NOT NULL)');
}, 30_000);

afterAll(async () => {
  await pool?.end();
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
    await admin.end();
  }
});

describe('AUD-001 PostgreSQL transaction boundary', () => {
  it('commits a business row and redacted audit entry together', async () => {
    await withAuditedTransaction(pool, async ({ client, appendAuditEntry }) => {
      await client.query('INSERT INTO public.test_record (id, status) VALUES ($1, $2)', [entityId, 'CONFIRMED']);
      await appendAuditEntry(entry('request-1', 1));
    });
    const business = await pool.query('SELECT status FROM public.test_record WHERE id = $1', [entityId]);
    const audit = await pool.query('SELECT * FROM audit.audit_entry WHERE request_id = $1', ['request-1']);
    expect(business.rows[0].status).toBe('CONFIRMED');
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0].actor_on_behalf_of).toBe(delegatedUserId);
    expect(audit.rows[0].changes[1].after).toBe('[REDACTED]');
    expect(JSON.stringify(audit.rows[0])).not.toContain('3273010101010001');
  });

  it('rolls back the business row if audit fails or is omitted', async () => {
    const duplicateBusinessId = randomUUID();
    await expect(withAuditedTransaction(pool, async ({ client, appendAuditEntry }) => {
      await client.query('INSERT INTO public.test_record (id, status) VALUES ($1, $2)', [duplicateBusinessId, 'CONFIRMED']);
      await appendAuditEntry(entry('request-1', 1));
    })).rejects.toThrow();
    expect((await pool.query('SELECT id FROM public.test_record WHERE id = $1', [duplicateBusinessId])).rowCount).toBe(0);

    const missingAuditBusinessId = randomUUID();
    await expect(withAuditedTransaction(pool, async ({ client }) => {
      await client.query('INSERT INTO public.test_record (id, status) VALUES ($1, $2)', [missingAuditBusinessId, 'CONFIRMED']);
    })).rejects.toThrow('requires an audit entry');
    expect((await pool.query('SELECT id FROM public.test_record WHERE id = $1', [missingAuditBusinessId])).rowCount).toBe(0);
  });

  it('rejects update, delete, and truncate of committed audit entries', async () => {
    await expect(pool.query('UPDATE audit.audit_entry SET action = $1 WHERE request_id = $2', ['TAMPER', 'request-1'])).rejects.toThrow('append-only');
    await expect(pool.query('DELETE FROM audit.audit_entry WHERE request_id = $1', ['request-1'])).rejects.toThrow('append-only');
    await expect(pool.query('TRUNCATE audit.audit_entry')).rejects.toThrow('append-only');
    expect((await pool.query('SELECT action FROM audit.audit_entry WHERE request_id = $1', ['request-1'])).rows[0].action)
      .toBe('EXAMPLE_STATUS_CHANGED');
  });

  /**
   * The audit count belongs to the transaction, not to one `runAuditedWork` invocation. Commands
   * nest: `runCommand` opens the transaction and the domain function re-enters through
   * `withConnection` with the same client. With a per-invocation counter the inner call took its
   * own tally, the outer guard saw zero entries, and it rejected a mutation that had in fact been
   * audited — pushing every nested command to open a second connection and so lose atomicity with
   * its idempotency row.
   */
  it('counts a nested audited call against the same transaction', async () => {
    const nestedBusinessId = randomUUID();
    await withAuditedTransaction(pool, async (outer) => {
      // The inner call appends on the outer client, as a domain function does via withConnection.
      await runAuditedWork(outer.client, async (inner) => {
        await inner.client.query('INSERT INTO public.test_record (id, status) VALUES ($1, $2)', [nestedBusinessId, 'NESTED']);
        await inner.appendAuditEntry(entry('request-nested', 1));
      });
    });
    expect((await pool.query('SELECT status FROM public.test_record WHERE id = $1', [nestedBusinessId])).rows[0].status).toBe('NESTED');
    expect((await pool.query('SELECT count(*)::int AS n FROM audit.audit_entry WHERE request_id = $1', ['request-nested'])).rows[0].n).toBe(1);
  });

  it('still refuses a nested transaction that appends nothing', async () => {
    const unauditedBusinessId = randomUUID();
    await expect(withAuditedTransaction(pool, async (outer) => {
      await runAuditedWork(outer.client, async (inner) => {
        await inner.client.query('INSERT INTO public.test_record (id, status) VALUES ($1, $2)', [unauditedBusinessId, 'UNAUDITED']);
      });
    })).rejects.toThrow('requires an audit entry');
    expect((await pool.query('SELECT id FROM public.test_record WHERE id = $1', [unauditedBusinessId])).rowCount).toBe(0);
  });

  it('does not carry an audit count from one transaction into the next', async () => {
    // A client is checked out for exactly one transaction, so a committed transaction cannot
    // leave a tally behind that would satisfy a later, genuinely unaudited mutation.
    const sequentialBusinessId = randomUUID();
    await withAuditedTransaction(pool, async ({ client, appendAuditEntry }) => {
      await client.query('INSERT INTO public.test_record (id, status) VALUES ($1, $2)', [sequentialBusinessId, 'FIRST']);
      await appendAuditEntry(entry('request-first', 1));
    });
    await expect(withAuditedTransaction(pool, async ({ client }) => {
      await client.query('UPDATE public.test_record SET status = $1 WHERE id = $2', ['SECOND', sequentialBusinessId]);
    })).rejects.toThrow('requires an audit entry');
    expect((await pool.query('SELECT status FROM public.test_record WHERE id = $1', [sequentialBusinessId])).rows[0].status).toBe('FIRST');
  });
});
