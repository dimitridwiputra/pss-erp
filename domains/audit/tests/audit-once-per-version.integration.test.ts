import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listMigrations } from '../../../scripts/apply-migrations.mjs';

/**
 * AUD-RISK-001 — what the partitioned audit table does and does not still enforce.
 *
 * The partitioned unique constraint reads as protection:
 *
 *     UNIQUE (occurred_at, request_id, entity_domain, entity_type, entity_id, entity_version)
 *
 * and it is not. `occurred_at` defaults to `now()` at microsecond precision, so two audit rows
 * for one entity version written milliseconds apart carry different `occurred_at` values and
 * the constraint cannot fire — not across months, and not inside one.
 *
 * These tests assert that inertness on purpose. A migration that later adds a genuinely global
 * constraint would fail here and force this ADR to be revisited, rather than letting a reader
 * assume the table is protected because a UNIQUE constraint exists in its definition.
 */
const databaseName = `pss_audit_once_per_version_${randomUUID().replaceAll('-', '')}`;
const organizationId = randomUUID();
let admin: pg.Client;
let pool: pg.Pool;

const insertEntry = (requestId: string, entityId: string) => pool.query(
  `INSERT INTO audit.audit_entry (
     id, organization_id, actor_service_identity, action, entity_domain, entity_type,
     entity_id, entity_version, changes, request_id, correlation_id, source
   ) VALUES ($1, $2, 'audit-invariant-test', 'PROBE', 'audit', 'Probe', $3, 1, '[]'::jsonb, $4, $5, 'SYSTEM')`,
  [randomUUID(), organizationId, entityId, requestId, randomUUID()],
);

beforeAll(async () => {
  const baseUrl = process.env.PSS_TEST_DATABASE_URL;
  if (!baseUrl) throw new Error('PSS_TEST_DATABASE_URL is required.');
  admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${databaseName}`);
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  pool = new pg.Pool({ connectionString: url.toString() });
  for (const file of await listMigrations(new URL('../infrastructure/database/migrations/', import.meta.url).pathname)) {
    await pool.query(await readFile(new URL(`../infrastructure/database/migrations/${file}`, import.meta.url), 'utf8'));
  }
}, 60_000);

afterAll(async () => {
  await pool?.end();
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
    await admin.end();
  }
});

describe('AUD-RISK-001 — the partitioned once-per-version constraint is inert', () => {
  it('stores two entries for one entity version in the same month, same session', async () => {
    const requestId = randomUUID();
    const entityId = randomUUID();
    await insertEntry(requestId, entityId);
    // Deliberately not wrapped in expect(...).rejects: the point of this test is that the
    // database does NOT object. Before the swap this raised a unique violation.
    await insertEntry(requestId, entityId);
    const { rows } = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM audit.audit_entry WHERE request_id = $1 AND entity_id = $2',
      [requestId, entityId],
    );
    expect(rows[0]?.n).toBe(2);
  }, 30_000);

  it('still forbids rewriting a committed entry, which is the guarantee that does hold', async () => {
    const requestId = randomUUID();
    await insertEntry(requestId, randomUUID());
    await expect(pool.query(
      `UPDATE audit.audit_entry SET action = 'TAMPER' WHERE request_id = $1`, [requestId],
    )).rejects.toThrow('append-only');
    await expect(pool.query('DELETE FROM audit.audit_entry WHERE request_id = $1', [requestId])).rejects.toThrow('append-only');
  }, 30_000);

  it('carries the partition key in the constraint, which is why it cannot fire', async () => {
    const { rows } = await pool.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def
         FROM pg_constraint
        WHERE conrelid = 'audit.audit_entry'::regclass AND contype = 'u'`,
    );
    const definition = rows[0]?.def ?? '';
    expect(definition).toContain('occurred_at');
    // If a future migration restores a genuinely global constraint, this fails and ADR-0014 has
    // to be revisited rather than left describing a protection that no longer exists.
    expect(definition).toMatch(/UNIQUE \(occurred_at,/);
  }, 30_000);

  it('stamps occurred_at from the server, not from the writer', async () => {
    // The writer never supplies occurred_at, so a client cannot file an audit row into an
    // arbitrary month and thereby steer it past a partition that is about to be dropped.
    const requestId = randomUUID();
    const before = Date.now();
    await insertEntry(requestId, randomUUID());
    const { rows } = await pool.query<{ occurred_at: Date }>(
      'SELECT occurred_at FROM audit.audit_entry WHERE request_id = $1', [requestId],
    );
    const occurred = rows[0]?.occurred_at.getTime() ?? 0;
    expect(occurred).toBeGreaterThanOrEqual(before - 60_000);
    expect(occurred).toBeLessThanOrEqual(Date.now() + 60_000);
  }, 30_000);
});
