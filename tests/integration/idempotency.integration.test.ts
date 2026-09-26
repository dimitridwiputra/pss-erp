import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runAuditedWork } from '../../domains/audit/src/application/append-audit-entry';
import { deleteExpiredIdempotencyKeys, IdempotencyError, withIdempotentCommand } from '../../domains/platform/src/application/idempotency';

const databaseName = `pss_idempotency_test_${randomUUID().replaceAll('-', '')}`;
const organizationId = randomUUID();
const identityId = randomUUID();
const requestHash = createHash('sha256').update('{"amount":"125000.00"}').digest('hex');
let admin: pg.Client;
let pool: pg.Pool;

function key(suffix: string) {
  return { organizationId, identityId, commandName: 'ApplyPayment', key: suffix, requestHash };
}

function auditInput(entityId: string, requestId: string) {
  return {
    organizationId, actor: { serviceIdentity: 'idempotency-integration-test', roles: ['SYSTEM'] },
    action: 'PAYMENT_APPLIED', entity: { domain: 'platform', type: 'test_mutation', id: entityId, version: 1 },
    changes: [{ path: 'status', classification: 'INTERNAL', after: 'APPLIED' }],
    requestId, correlationId: requestId, source: 'SYSTEM',
  };
}

beforeAll(async () => {
  const baseUrl = process.env.PSS_TEST_DATABASE_URL;
  if (!baseUrl) throw new Error('PSS_TEST_DATABASE_URL is required for PostgreSQL integration tests.');
  admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${databaseName}`);
  const testUrl = new URL(baseUrl);
  testUrl.pathname = `/${databaseName}`;
  pool = new pg.Pool({ connectionString: testUrl.toString(), max: 20 });
  for (const file of ['0001_outbox_event.sql', '0002_idempotency_key.sql']) {
    const migration = await readFile(new URL(`../../domains/platform/infrastructure/database/migrations/${file}`, import.meta.url), 'utf8');
    await pool.query(migration);
  }
  const auditMigration = await readFile(new URL('../../domains/audit/infrastructure/database/migrations/0001_audit_entry.sql', import.meta.url), 'utf8');
  await pool.query(auditMigration);
  await pool.query('CREATE TABLE public.test_mutation (id uuid PRIMARY KEY)');
}, 30_000);

afterAll(async () => {
  await pool?.end();
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
    await admin.end();
  }
});

describe('PLT-006 command idempotency', () => {
  it('executes one of 50 simultaneous identical requests and replays the same result', async () => {
    let executions = 0;
    const results = await Promise.all(Array.from({ length: 50 }, () => withIdempotentCommand(pool, key('parallel-1'), runAuditedWork, async ({ client, appendAuditEntry }) => {
      executions += 1;
      await delay(20);
      const id = randomUUID();
      await client.query('INSERT INTO public.test_mutation (id) VALUES ($1)', [id]);
      await appendAuditEntry(auditInput(id, 'parallel-1'));
      return { code: 201, body: { id, status: 'APPLIED' } };
    })));
    expect(executions).toBe(1);
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    expect(results.map((result) => result.body)).toEqual(Array(50).fill(results[0]?.body));
    expect((await pool.query('SELECT count(*)::int AS count FROM public.test_mutation')).rows[0].count).toBe(1);
    expect((await pool.query('SELECT count(*)::int AS count FROM audit.audit_entry WHERE request_id = $1', ['parallel-1'])).rows[0].count).toBe(1);
  }, 30_000);

  it('rejects a changed request hash but keeps identity scopes separate', async () => {
    await expect(withIdempotentCommand(pool, { ...key('parallel-1'), requestHash: 'a'.repeat(64) }, runAuditedWork, async () => ({ code: 201, body: {} })))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    const otherIdentity = await withIdempotentCommand(pool, { ...key('parallel-1'), identityId: randomUUID() }, runAuditedWork, async ({ appendAuditEntry }) => {
      await appendAuditEntry(auditInput(randomUUID(), 'other-identity'));
      return { code: 422, body: { code: 'CREDIT_APPROVAL_REQUIRED' } };
    });
    expect(otherIdentity).toMatchObject({ code: 422, replayed: false });
  });

  it('rolls back a technical failure and accepts a safe retry', async () => {
    const businessId = randomUUID();
    await expect(withIdempotentCommand(pool, key('failed-first'), runAuditedWork, async ({ client }) => {
      await client.query('INSERT INTO public.test_mutation (id) VALUES ($1)', [businessId]);
      throw new Error('database write failed');
    })).rejects.toThrow('database write failed');
    expect((await pool.query('SELECT id FROM public.test_mutation WHERE id = $1', [businessId])).rowCount).toBe(0);
    expect((await pool.query('SELECT * FROM platform.idempotency_key WHERE idempotency_key = $1', ['failed-first'])).rowCount).toBe(0);
    const retry = await withIdempotentCommand(pool, key('failed-first'), runAuditedWork, async ({ client, appendAuditEntry }) => {
      await client.query('INSERT INTO public.test_mutation (id) VALUES ($1)', [businessId]);
      await appendAuditEntry(auditInput(businessId, 'failed-first'));
      return { code: 201, body: { id: businessId } };
    });
    expect(retry.replayed).toBe(false);
  });

  it('rolls back a command that omits its audit entry', async () => {
    const businessId = randomUUID();
    await expect(withIdempotentCommand(pool, key('no-audit'), runAuditedWork, async ({ client }) => {
      await client.query('INSERT INTO public.test_mutation (id) VALUES ($1)', [businessId]);
      return { code: 201, body: { id: businessId } };
    })).rejects.toThrow('requires an audit entry');
    expect((await pool.query('SELECT id FROM public.test_mutation WHERE id = $1', [businessId])).rowCount).toBe(0);
    expect((await pool.query('SELECT idempotency_key FROM platform.idempotency_key WHERE idempotency_key = $1', ['no-audit'])).rowCount).toBe(0);
  });

  it('requires a key and retains it for at least seven days', async () => {
    await expect(withIdempotentCommand(pool, { ...key(''), key: '' }, runAuditedWork, async () => ({ code: 200, body: {} })))
      .rejects.toBeInstanceOf(IdempotencyError);
    const retention = await pool.query<{ days: number }>(
      `SELECT extract(epoch FROM (expires_at - created_at)) / 86400 AS days
       FROM platform.idempotency_key WHERE idempotency_key = $1`, ['parallel-1'],
    );
    expect(Number(retention.rows[0]?.days)).toBeGreaterThanOrEqual(7);
    await pool.query(
      `UPDATE platform.idempotency_key
       SET created_at = now() - interval '6 days', expires_at = now() + interval '1 day'
       WHERE idempotency_key = $1`, ['parallel-1'],
    );
    const offlineReplay = await withIdempotentCommand(pool, key('parallel-1'), runAuditedWork, async () => {
      throw new Error('A six-day-old key must replay instead of executing.');
    });
    expect(offlineReplay.replayed).toBe(true);
  });

  it('deletes only expired keys during maintenance', async () => {
    await pool.query(
      `UPDATE platform.idempotency_key
       SET created_at = now() - interval '8 days', expires_at = now() - interval '1 day'
       WHERE idempotency_key = $1`, ['failed-first'],
    );
    expect(await deleteExpiredIdempotencyKeys(pool)).toBe(1);
    expect((await pool.query('SELECT idempotency_key FROM platform.idempotency_key WHERE idempotency_key = $1 AND identity_id = $2', ['parallel-1', identityId])).rowCount)
      .toBe(1);
  });
});
