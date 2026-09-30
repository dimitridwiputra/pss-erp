import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * OD-19 / PLT-012: the swap of `audit.audit_entry` to the prepared monthly range-partitioned table.
 *
 * This is the one migration in the audit domain that destroys a table, so it is tested against a
 * database that already holds rows rather than against an empty one. `0006` verifies the copy by row
 * count and by retention class before it drops anything, and both of those verifications are only
 * meaningful when there is data to verify: on an empty table a copy bug is invisible.
 *
 * It replaces the test that asserted the swap had NOT happened. That premise expired when the owner
 * answered OD-19, and keeping it would have meant a test asserting the shape the swap deliberately
 * removed.
 *
 * The partition set is asserted to cover every month the pre-existing rows span, because a legacy
 * table's `occurred_at` values are not limited to the months anyone planned for.
 */

const databaseName = `pss_audit_swap_test_${randomUUID().replaceAll('-', '')}`;
const organizationId = randomUUID();

let admin: pg.Client;
let pool: pg.Pool;

const migrationDirectory = new URL('../infrastructure/database/migrations/', import.meta.url);

/** Months the fixture rows span, and therefore the months the swap has to partition. */
const legacyRows = [
  { occurredAt: '2023-04-12T08:00:00.000Z', retentionClass: 'FINANCIAL' },
  { occurredAt: '2023-04-28T08:00:00.000Z', retentionClass: 'BUSINESS' },
  { occurredAt: '2023-05-02T08:00:00.000Z', retentionClass: 'SECURITY' },
  { occurredAt: '2023-05-19T08:00:00.000Z', retentionClass: 'RAW_LANDING' },
] as const;

async function applyMigration(file: string): Promise<void> {
  await pool.query(await readFile(new URL(file, migrationDirectory), 'utf8'));
}

beforeAll(async () => {
  const baseUrl = process.env.PSS_TEST_DATABASE_URL;
  if (!baseUrl) throw new Error('PSS_TEST_DATABASE_URL is required for PostgreSQL integration tests.');
  admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${databaseName}`);
  const testUrl = new URL(baseUrl);
  testUrl.pathname = `/${databaseName}`;
  pool = new pg.Pool({ connectionString: testUrl.toString() });

  const available = (await readdir(migrationDirectory)).filter((file) => file.endsWith('.sql')).sort();
  // Everything except the swap. The swap runs last, after the table holds rows.
  for (const file of available.filter((name) => name !== '0006_audit_entry_partition_swap.sql')) {
    await applyMigration(file);
  }

  for (const [index, row] of legacyRows.entries()) {
    await pool.query(
      `INSERT INTO audit.audit_entry (
         id, occurred_at, organization_id, actor_service_identity, action, entity_domain,
         entity_type, entity_id, entity_version, changes, request_id, correlation_id, source,
         retention_class
       ) VALUES ($1, $2, $3, 'audit-swap-test', 'PRE_SWAP', 'audit', 'SwapFixture', $4, 1, $5::jsonb,
                 $6, 'cor-swap', 'SYSTEM', $7)`,
      [randomUUID(), row.occurredAt, organizationId, randomUUID(),
        JSON.stringify([{ path: 'index', classification: 'INTERNAL', after: String(index) }]),
        `req-pre-swap-${index}`, row.retentionClass],
    );
  }
}, 60_000);

afterAll(async () => {
  await pool?.end();
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
    await admin.end();
  }
});

describe('OD-19 partition swap over an existing table', () => {
  it('leaves the legacy heap a plain heap until the swap runs', async () => {
    const { rows } = await pool.query<{ relkind: string; rows: number }>(
      `SELECT c.relkind, (SELECT count(*)::int FROM audit.audit_entry) AS rows
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'audit' AND c.relname = 'audit_entry'`,
    );
    expect(rows[0]?.relkind).toBe('r');
    expect(rows[0]?.rows).toBe(legacyRows.length);
  });

  it('carries every row across, with its retention class intact', async () => {
    // If a row lost its class on the way, it would be archived under a period nobody chose, which is
    // the one failure this whole change exists to prevent. `0006` asserts this itself before the drop;
    // the test asserts it afterwards, because a migration that aborts correctly is still not a
    // migration that worked.
    await applyMigration('0006_audit_entry_partition_swap.sql');

    const { rows } = await pool.query<{ occurred_at: Date; retention_class: string; action: string }>(
      `SELECT occurred_at, retention_class, action FROM audit.audit_entry ORDER BY occurred_at`,
    );
    expect(rows).toHaveLength(legacyRows.length);
    for (const [index, legacy] of legacyRows.entries()) {
      const carried = rows[index];
      expect(carried?.occurred_at.toISOString()).toBe(legacy.occurredAt);
      expect(carried?.retention_class).toBe(legacy.retentionClass);
      expect(carried?.action).toBe('PRE_SWAP');
    }
  });

  it('partitions every month the pre-existing rows span, not only the months someone planned for', async () => {
    // The legacy table's history is whatever was written, and it can predate any partition set. A
    // backfill that only covered the current month would abort on the first historical row.
    const { rows } = await pool.query<{ partition: string; rows: number }>(
      `SELECT c.relname AS partition, count(*)::int AS rows
         FROM audit.audit_entry e
         JOIN pg_inherits i ON i.inhrelid = e.tableoid
         JOIN pg_class c ON c.oid = i.inhrelid
        GROUP BY c.relname ORDER BY 1`,
    );
    const byPartition = new Map(rows.map((row) => [row.partition, row.rows]));
    expect(byPartition.get('audit_entry_2023_04')).toBe(2);
    expect(byPartition.get('audit_entry_2023_05')).toBe(2);
  });

  it('drops the legacy heap rather than keeping a second copy of the largest table', async () => {
    const { rows } = await pool.query<{ present: boolean }>(
      // `to_regclass` rather than a `::regclass` cast: casting a name that no longer resolves is an
      // error, and the absence of the prepared table is the thing being asserted here.
      `SELECT to_regclass('audit.audit_entry_partitioned') IS NOT NULL AS present`,
    );
    expect(rows[0]?.present).toBe(false);
    const { rows: partitioned } = await pool.query<{ relkind: string }>(
      `SELECT c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'audit' AND c.relname = 'audit_entry'`,
    );
    expect(partitioned[0]?.relkind).toBe('p');
  });

  it('still accepts a write afterwards, at the current time, with the class default applied', async () => {
    // The default on `occurred_at` is what routes the write, and `0003` had omitted it from the
    // prepared table. Without `0006` setting it back, every audit write after the swap would fail with
    // "no partition of relation found for row" — the failure that made the column-shape assertion in
    // `0006` necessary.
    await expect(pool.query(
      `INSERT INTO audit.audit_entry (
         id, organization_id, actor_service_identity, action, entity_domain, entity_type,
         entity_id, entity_version, changes, request_id, correlation_id, source
       ) VALUES ($1, $2, 'post-swap', 'POST_SWAP', 'audit', 'SwapFixture', $3, 1, '[]'::jsonb,
                 $4, 'cor-swap', 'SYSTEM')
       RETURNING retention_class, occurred_at`,
      [randomUUID(), organizationId, randomUUID(), `req-post-swap-${randomUUID()}`],
    )).resolves.toMatchObject({ rowCount: 1 });
  });

  it('keeps the once-per-version guarantee for writes that share a month', async () => {
    // PostgreSQL requires the partition key in every unique constraint on a partitioned table, so the
    // guarantee became per-month. A retried command writes twice inside one transaction, so both rows
    // land in the same month and are still refused.
    const entityId = randomUUID();
    const requestId = `req-dup-${randomUUID()}`;
    const occurredAt = new Date('2023-05-10T00:00:00.000Z').toISOString();
    const insert = (id: string) => pool.query(
      `INSERT INTO audit.audit_entry (
         id, occurred_at, organization_id, actor_service_identity, action, entity_domain,
         entity_type, entity_id, entity_version, changes, request_id, correlation_id, source
       ) VALUES ($1, $2, $3, 'audit-swap-test', 'DUP', 'audit', 'SwapFixture', $4, 4, '[]'::jsonb,
                 $5, 'cor-swap', 'SYSTEM')`,
      [id, occurredAt, organizationId, entityId, requestId],
    );
    await insert(randomUUID());
    await expect(insert(randomUUID())).rejects.toThrow(/duplicate key value/);
  });

  it('rejects a write outside the covered months rather than creating a catch-all', async () => {
    await expect(pool.query(
      `INSERT INTO audit.audit_entry (
         id, occurred_at, organization_id, actor_service_identity, action, entity_domain,
         entity_type, entity_id, entity_version, changes, request_id, correlation_id, source
       ) VALUES ($1, '1998-01-01', $2, 'probe', 'PROBE', 'audit', 'Probe', $3, 1, '[]'::jsonb,
                 'req-far-past', 'cor-swap', 'SYSTEM')`,
      [randomUUID(), organizationId, randomUUID()],
    )).rejects.toThrow(/no partition of relation/);
  });
});
