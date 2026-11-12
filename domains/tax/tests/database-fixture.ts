import { randomUUID } from 'node:crypto';
import pg from 'pg';

/**
 * A throwaway database with this domain's and `audit`'s migrations applied.
 *
 * `applyMigrations` replays each domain's ordered list from its directory, so a new migration is
 * picked up here without editing this file. `audit` is included because `scheduleTaxRate` and
 * `applyApprovalDecision` both write through `@pss/audit`, and the audit guard rejects a mutation
 * with no entry — so a fixture without that table would fail for the wrong reason.
 */
export async function createTestDatabase(prefix: string): Promise<{
  pool: pg.Pool;
  drop: () => Promise<void>;
}> {
  const baseUrl = process.env.PSS_TEST_DATABASE_URL;
  if (!baseUrl) throw new Error('PSS_TEST_DATABASE_URL is required for PostgreSQL integration tests.');
  const databaseName = `${prefix}_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${databaseName}`);
  const testUrl = new URL(baseUrl);
  testUrl.pathname = `/${databaseName}`;
  const pool = new pg.Pool({ connectionString: testUrl.toString() });
  const { applyAuditMigrations, applyMigrations } = await import('../../../scripts/apply-migrations.mjs');
  await applyAuditMigrations(pool);
  await applyMigrations(pool, 'tax');
  return {
    pool,
    drop: async () => {
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
      await admin.end();
    },
  };
}