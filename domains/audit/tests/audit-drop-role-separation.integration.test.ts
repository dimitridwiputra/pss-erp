import { randomUUID } from 'node:crypto';
import { escapeIdentifier, escapeLiteral } from 'pg';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyAuditMigrations } from '../../../scripts/apply-migrations.mjs';

/**
 * AUD-ARCHIVE-06 — the application role cannot drop an audit partition.
 *
 * Written as a violation rather than an observation. Asserting that a role "does not have" a
 * privilege is a claim about a catalogue; asserting that `SET ROLE pss_app` followed by a drop
 * raises `permission denied` is a claim about the database's behaviour, and only the second one would
 * notice if a future migration granted the function back to PUBLIC.
 *
 * The roles are created by migration 0008 in every environment, and the test connects as the
 * migration role, so `SET ROLE` can reach them. Where the role is absent — a database whose
 * migrations predate 0008 — the test says so and fails rather than passing vacuously.
 */
describe('AUD-ARCHIVE-06: audit partition drop is restricted to the maintenance role', () => {
  let admin: pg.Client;
  let pool: pg.Pool;
  let databaseName: string;

  beforeAll(async () => {
    const baseUrl = process.env.PSS_TEST_DATABASE_URL;
    if (!baseUrl) throw new Error('PSS_TEST_DATABASE_URL is required for PostgreSQL integration tests.');
    databaseName = `audit_roles_${randomUUID().slice(0, 8)}`;
    admin = new pg.Client({ connectionString: baseUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${databaseName}`);
    const testUrl = new URL(baseUrl);
    testUrl.pathname = `/${databaseName}`;
    pool = new pg.Pool({ connectionString: testUrl.toString(), max: 10 });
    await applyAuditMigrations(pool);
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    // The roles are cluster-wide, so the temporary database cannot clean them up. They are NOLOGIN
    // group roles carrying no password and no data; leaving them matches what the migration leaves
    // behind in any other database on this server.
    await admin?.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    await admin?.end();
  });

  async function seedMonth(month: string): Promise<string> {
    const partition = `audit_entry_${month.replace('-', '_')}`;
    const [year, monthOfYear] = month.split('-').map(Number);
    const through = new Date(Date.UTC(year ?? 1970, monthOfYear ?? 1, 1)).toISOString().slice(0, 7);
    await pool.query(
      `CREATE TABLE audit.${escapeIdentifier(partition)} PARTITION OF audit.audit_entry `
      + `FOR VALUES FROM (${escapeLiteral(`${month}-01 00:00:00+00`)}) `
      + `TO (${escapeLiteral(`${through}-01 00:00:00+00`)})`,
    );
    await pool.query(
      `INSERT INTO audit.audit_entry (
         id, occurred_at, organization_id, actor_roles, actor_service_identity, action,
         entity_domain, entity_type, entity_id, entity_version, changes, request_id,
         correlation_id, source, retention_class
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'FINANCIAL')`,
      [
        randomUUID(), `${month}-05T00:00:00.000Z`, randomUUID(), ['ADMIN'], 'wms-api',
        'ORDER_CONFIRMED', 'orders', 'sales_order', randomUUID(), 1,
        JSON.stringify([{ field: 'status', from: null, to: 'CONFIRMED' }]),
        `req-${randomUUID()}`, `cor-${randomUUID()}`, 'API',
      ],
    );
    return partition;
  }

  async function exists(partition: string): Promise<boolean> {
    const found = await pool.query('SELECT to_regclass($1) AS oid', [`audit.${partition}`]);
    return (found.rows[0] as { oid: string | null } | undefined)?.oid !== null;
  }

  it('refuses audit.drop_month_partition to the application role', async () => {
    const partition = await seedMonth('2022-01');
    expect(await exists(partition)).toBe(true);

    await pool.query('BEGIN');
    try {
      await pool.query('SET LOCAL ROLE pss_app');
      await expect(pool.query('SELECT audit.drop_month_partition($1)', [partition]))
        .rejects.toThrow(/permission denied|must be owner/i);
      await pool.query('ROLLBACK');
    } catch (error) {
      await pool.query('ROLLBACK').catch(() => undefined);
      throw error;
    }

    // Not merely an error: the partition and its rows are untouched. An assertion that stopped at the
    // error message would pass even if the drop had happened and then failed on something later.
    expect(await exists(partition)).toBe(true);
    const rows = await pool.query<{ rows: number }>('SELECT count(*)::int AS rows FROM audit.audit_entry WHERE tableoid = $1::regclass', [`audit.${partition}`]);
    expect(rows.rows[0]?.rows).toBe(1);
  }, 60_000);

  it('still lets the maintenance role drop the partition, so the retention job is not bricked', async () => {
    // The other half. Restricting a function nobody can call is not a control, it is an outage.
    const partition = await seedMonth('2022-02');
    // No transaction wrapper here: the earlier version opened one and rolled it back, which undid
    // the very drop it was asserting. A test that rolls back the effect it is checking would pass
    // while the role could not drop anything.
    await pool.query('SET ROLE pss_maintenance');
    try {
      await pool.query('SELECT audit.drop_month_partition($1)', [partition]);
    } finally {
      await pool.query('RESET ROLE');
    }

    expect(await exists(partition)).toBe(false);
  }, 60_000);

  it('does not let the application forge the evidence that gates a drop', async () => {
    // The gate can also be defeated from the other direction: an application able to write a
    // VERIFIED row into audit.audit_restore_verification could unlock its own partition deletion
    // without ever restoring anything. So the archive lifecycle tables are maintenance-only.
    await pool.query('BEGIN');
    try {
      await pool.query('SET LOCAL ROLE pss_app');
      await expect(
        pool.query(
          `INSERT INTO audit.audit_restore_verification (
             id, archive_object_id, status, restored_row_count, restored_checksum_sha256,
             restored_min_occurred_at, restored_max_occurred_at, verified_at,
             operator_service_identity, correlation_id
           ) VALUES ($1,$2,'VERIFIED',1,'deadbeef',now(),now(),now(),'forged','forged')`,
          [randomUUID(), randomUUID()],
        ),
      ).rejects.toThrow(/permission denied/i);
      await pool.query('ROLLBACK');
    } catch (error) {
      await pool.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  }, 60_000);

  it('lets the application append and read audit entries, or the invariant is useless', async () => {
    // A role that cannot write the audit trail would be fixed by removing the audit guard, which is
    // a far worse outcome than a bypassable drop. So the positive half is asserted too.
    const id = randomUUID();
    const organizationId = randomUUID();
    await pool.query('BEGIN');
    await pool.query('SET LOCAL ROLE pss_app');
    await pool.query(
      `INSERT INTO audit.audit_entry (
         id, occurred_at, organization_id, actor_roles, actor_user_id, action, entity_domain,
         entity_type, entity_id, entity_version, changes, request_id, correlation_id, source,
         retention_class
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'FINANCIAL')`,
      // Now, not a fixed date: the migrations create partitions from the current month onwards, so a
      // literal date passes until its month ends and then fails with no partition for the row.
      [
        id, new Date().toISOString(), organizationId, ['WAREHOUSE_OPERATOR'], randomUUID(),
        'PICK_CONFIRMED', 'wms', 'pick_task', randomUUID(), 1,
        JSON.stringify([{ field: 'state', from: 'OPEN', to: 'PICKED' }]),
        `req-${randomUUID()}`, `cor-${randomUUID()}`, 'API',
      ],
    );
    const read = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM audit.audit_entry WHERE organization_id = $1', [organizationId],
    );
    await pool.query('ROLLBACK');

    expect(read.rows[0]?.n).toBe(1);
  }, 60_000);
});
