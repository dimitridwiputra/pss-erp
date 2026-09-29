import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';

/**
 * PLT-012 / OD-188 prerequisite, driven by the capacity arithmetic in
 * infrastructure/terraform/README.md: at ~225,000 audit rows/day the table is the
 * largest in the system, so the monthly-range-partitioned form has to exist before
 * a three-year retention window is agreed.
 *
 * These tests assert the SHAPE of the prepared table, not the swap. The swap is
 * deliberately not done: it needs a reviewed .migration-plan.md and an answered
 * retention period (OD-19), and AGENTS.md 20 forbids inventing one.
 */

const testDatabaseUrl = process.env.PSS_TEST_DATABASE_URL;
const describeIfDatabase = testDatabaseUrl ? describe : describe.skip;

describeIfDatabase('AUD-001 partitioned audit prerequisites', () => {
  let pool: pg.Pool;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: testDatabaseUrl, max: 2 });
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('creates audit_entry_partitioned as a range-partitioned table on occurred_at', async () => {
    const result = await pool.query<{ relkind: string; partstrat: string }>(
      `SELECT c.relkind, p.partstrat
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_partitioned_table p ON p.partrelid = c.oid
        WHERE n.nspname = 'audit' AND c.relname = 'audit_entry_partitioned'`,
    );
    expect(result.rows).toHaveLength(1);
    // 'p' is a partitioned table; 'r' is the plain heap this replaces.
    expect(result.rows[0].relkind).toBe('p');
    expect(result.rows[0].partstrat).toBe('r');
  });

  it('has no DEFAULT partition, so an out-of-range write fails loudly', async () => {
    // A blanket DEFAULT partition silently becomes where missing history lands.
    const defaults = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM pg_inherits i
         JOIN pg_class c ON c.oid = i.inhrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'audit' AND c.relname = 'audit_entry_partitioned'
          AND pg_get_expr(c.relpartbound, c.oid) = 'DEFAULT'`,
    );
    expect(defaults.rows[0].count).toBe(0);

    await expect(
      pool.query(
        `INSERT INTO audit.audit_entry_partitioned
           (id, occurred_at, organization_id, entity_id, entity_version, changes,
            request_id, correlation_id, actor_service_identity, action,
            entity_domain, entity_type, source)
         VALUES ($1, '2098-06-01', $2, $3, 1, '[]'::jsonb, 'req-far-future', 'cor', 'probe', 'PROBE', 'probe', 'Probe', 'SYSTEM')`,
        [randomUUID(), randomUUID(), randomUUID()],
      ),
    ).rejects.toThrow(/no partition of relation/);
  });

  it('routes an in-range write to exactly the covering monthly partition', async () => {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO audit.audit_entry_partitioned
         (id, occurred_at, organization_id, entity_id, entity_version, changes,
          request_id, correlation_id, actor_service_identity, action,
          entity_domain, entity_type, source)
       VALUES ($1, '2026-10-15T09:00:00Z', $2, $3, 1, '[]'::jsonb, 'req-route', 'cor', 'probe', 'PROBE', 'probe', 'Probe', 'SYSTEM')`,
      [id, randomUUID(), randomUUID()],
    );
    const located = await pool.query<{ partition: string }>(
      'SELECT tableoid::regclass::text AS partition FROM audit.audit_entry_partitioned WHERE id = $1', [id],
    );
    expect(located.rows[0].partition).toBe('audit.audit_entry_2026_10');
    await pool.query('DELETE FROM audit.audit_entry_partitioned WHERE id = $1', [id]);
  });

  it('keeps the one-entry-per-version guarantee, with occurred_at in the key', async () => {
    const entityId = randomUUID();
    const row = () => [
      randomUUID(), '2026-11-02T09:00:00Z', randomUUID(), entityId, 7, 'req-dup', 'cor', 'probe', 'PROBE', 'probe', 'Probe', 'SYSTEM',
    ];
    await pool.query(
      `INSERT INTO audit.audit_entry_partitioned
         (id, occurred_at, organization_id, entity_id, entity_version, changes,
          request_id, correlation_id, actor_service_identity, action,
          entity_domain, entity_type, source)
       VALUES ($1,$2,$3,$4,$5,'[]'::jsonb,$6,$7,$8,$9,$10,$11,$12)`, row(),
    );
    // Same (request_id, domain, type, entity, version) must be refused, or a
    // retried command would produce two audit rows for one effect.
    await expect(
      pool.query(
        `INSERT INTO audit.audit_entry_partitioned
           (id, occurred_at, organization_id, entity_id, entity_version, changes,
            request_id, correlation_id, actor_service_identity, action,
            entity_domain, entity_type, source)
         VALUES ($1,$2,$3,$4,$5,'[]'::jsonb,$6,$7,$8,$9,$10,$11,$12)`, row(),
      ),
    ).rejects.toThrow(/duplicate key value/);
    await pool.query('DELETE FROM audit.audit_entry_partitioned WHERE request_id = $1', ['req-dup']);
  });

  it('leaves the live audit_entry append-only and still the write target', async () => {
    const tableoid = await pool.query<{ table: string }>(
      'SELECT tableoid::regclass::text AS table FROM audit.audit_entry LIMIT 1',
    );
    expect(tableoid.rows.length === 0 || tableoid.rows[0].table === 'audit.audit_entry').toBe(true);

    // The immutability trigger must still refuse a mutation on the live table.
    await expect(
      pool.query(`UPDATE audit.audit_entry SET action = 'TAMPERED' WHERE id = (SELECT id FROM audit.audit_entry LIMIT 1)`),
    ).rejects.toThrow(/append-only/);
  });
});
