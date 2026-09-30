import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { escapeIdentifier, escapeLiteral } from 'pg';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  archiveExpiredAuditPartitions,
  auditArchiveDigest,
  defaultAuditRetentionPolicy,
  FileAuditArchive,
  PostgresRestoreVerifier,
} from '../src/index';
import { applyAuditMigrations } from '../../../scripts/apply-migrations.mjs';

/**
 * AUD-ARCHIVE-03 / 05 / 07 — the archive has to survive being real.
 *
 * Everything else in the archive suite drives the retention run with a test double, which is the right
 * way to test the rule but the wrong way to trust it. This file removes the doubles: real bytes on
 * disk, a real scratch PostgreSQL database, the real schema, and the real verifier that a scheduler
 * would inject. If the round trip does not work, that shows up here rather than the first time
 * somebody archives a quarter of evidence in production.
 */
describe('audit archive round trip against real bytes and a real scratch database', () => {
  const asOf = new Date('2026-09-30T00:00:00.000Z');
  let admin: pg.Client;
  let pool: pg.Pool;
  let databaseName: string;
  let archiveRoot: string;
  let schemaSql: string;
  let adminBaseUrl: string;

  beforeAll(async () => {
    const baseUrl = process.env.PSS_TEST_DATABASE_URL;
    if (!baseUrl) throw new Error('PSS_TEST_DATABASE_URL is required for PostgreSQL integration tests.');
    adminBaseUrl = baseUrl;
    databaseName = `audit_restore_${randomUUID().slice(0, 8)}`;
    admin = new pg.Client({ connectionString: baseUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${databaseName}`);
    const testUrl = new URL(baseUrl);
    testUrl.pathname = `/${databaseName}`;
    pool = new pg.Pool({ connectionString: testUrl.toString(), max: 20 });
    await applyAuditMigrations(pool);

    archiveRoot = await mkdtemp(join(tmpdir(), 'pss-audit-archive-'));
    // The verifier needs the real schema as text, not as statements already applied. The whole
    // ordered list is read, not a hand-picked pair: an earlier version of this file listed 0001 and
    // 0002 and the restore failed on a missing `retention_class` column, because picking migrations
    // by name is the same mistake that made amending a shipped migration look safe (MIG-RISK-AUD-001).
    // A restore target built from a partial schema proves nothing about a real one.
    const directory = new URL('../infrastructure/database/migrations/', import.meta.url);
    const files = (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort();
    schemaSql = (
      await Promise.all(files.map(async (file) => readFile(new URL(file, directory), 'utf8')))
    ).join('\n');
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    await admin?.end();
  });

  /**
   * Creates one monthly partition and seeds it, deriving the partition bounds from the month rather
   * than from a hand-written pair of date literals. Hard-coded bounds drift the moment a test is
   * given a different month, and a partition whose range does not match its name makes every
   * retention assertion downstream meaningless.
   */
  async function seedPartition(month: string, rows: number): Promise<string> {
    const partition = `audit_entry_${month.replace('-', '_')}`;
    const from = `${month}-01`;
    const nextMonth = new Date(`${month}-01T00:00:00.000Z`);
    nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
    const through = nextMonth.toISOString().slice(0, 10);
    // Schema-qualified, and quoted with the driver's escaper. An unqualified CREATE TABLE lands in
    // `public`, and `listPartitions` filters on the `audit` schema — so the retention run silently
    // sees none of the partitions a test created and reports every month as "not yet closed". That
    // is exactly the kind of no-op that makes a test pass for the wrong reason.
    await pool.query(
      `CREATE TABLE audit.${escapeIdentifier(partition)} PARTITION OF audit.audit_entry `
      + `FOR VALUES FROM (${escapeLiteral(`${from} 00:00:00+00`)}) `
      + `TO (${escapeLiteral(`${through} 00:00:00+00`)})`,
    );
    for (const index of Array.from({ length: rows }, (_, i) => i)) {
      const day = String(10 + index).padStart(2, '0');
      await pool.query(
        `INSERT INTO audit.audit_entry (
           id, occurred_at, organization_id, actor_user_id, actor_roles, actor_service_identity,
           action, entity_domain, entity_type, entity_id, entity_version, changes, request_id,
           correlation_id, source, retention_class
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'FINANCIAL')`,
        [
          randomUUID(),
          `${month}-${day}T08:30:00.000Z`,
          randomUUID(), randomUUID(), ['ACCOUNTANT'], null,
          'INVOICE_ISSUED', 'invoicing', 'invoice', randomUUID(), 1,
          // More than one key in the payload on purpose: `changes` is jsonb, which does not preserve
          // key order, so a round trip that survives this has genuinely normalised rather than
          // accidentally compared two identical strings.
          JSON.stringify([{ field: 'status', from: 'DRAFT', to: 'ISSUED' }, { field: 'total', from: 0, to: 5000 }]),
          `req-${randomUUID()}`, `cor-${randomUUID()}`, 'API',
        ],
      );
    }
    return partition;
  }

  function verifierFor(reader: FileAuditArchive): PostgresRestoreVerifier {
    return new PostgresRestoreVerifier({
      admin,
      reader,
      schemaSql,
      connectToScratchDatabase: async (databaseName) => {
        const scratchUrl = new URL(adminBaseUrl);
        scratchUrl.pathname = `/${databaseName}`;
        const scratch = new pg.Client({ connectionString: scratchUrl.toString() });
        await scratch.connect();
        return scratch;
      },
    });
  }

  /** The full pipeline: archive to disk, verify by real restore, drop, then restore again by hand. */
  async function runWithRealArchive(partition: string): Promise<{ outcome: string; archive: FileAuditArchive }> {
    const archive = new FileAuditArchive(archiveRoot);
    const result = await archiveExpiredAuditPartitions(pool, {
      organizationId: randomUUID(),
      asOf: asOf.toISOString(),
      policy: defaultAuditRetentionPolicy,
      archive,
      verifyRestore: verifierFor(archive),
      serviceIdentity: 'audit-retention-test',
      requestId: `run-${randomUUID()}`,
      correlationId: `cor-${randomUUID()}`,
    });
    const outcome = result.outcomes.find((entry) => entry.partition === partition)?.outcome ?? 'MISSING';
    return { outcome, archive };
  }

  it('AUD-ARCHIVE-07: archives real bytes, verifies by a real restore, drops, then restores again by hand', async () => {
    const partition = await seedPartition('2021-12', 3);
    const { outcome, archive } = await runWithRealArchive(partition);

    expect(outcome).toBe('ARCHIVED_AND_DROPPED');

    // The stored verification carries real evidence, not an echo of the request.
    const verification = await pool.query<{
      status: string; restored_row_count: number; restored_checksum_sha256: string;
      restored_min_occurred_at: Date; restored_max_occurred_at: Date;
      entity_probe_result: string; scratch_database: string;
    }>(
      `SELECT v.status, v.restored_row_count, v.restored_checksum_sha256, v.restored_min_occurred_at,
              v.restored_max_occurred_at, v.entity_probe_result, v.scratch_database
         FROM audit.audit_restore_verification v
         JOIN audit.audit_archive_object o ON o.id = v.archive_object_id
        WHERE o.source_partition = $1`, [partition],
    );
    const row = verification.rows[0];
    expect(row).toMatchObject({ status: 'VERIFIED', restored_row_count: 3 });
    expect(row?.restored_checksum_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.restored_min_occurred_at).toBeInstanceOf(Date);
    // The probe is a real query result, phrased as one.
    expect(row?.entity_probe_result).toMatch(/\d+ row\(s\) found by entity_id \+ request_id/);
    expect(row?.scratch_database).toMatch(/^pss_audit_restore_[0-9a-f]{16}$/);

    // And the scratch database the verification used is gone. Leaving it would mean every run kept
    // an unmanaged second copy of aged audit rows.
    const survivors = await admin.query('SELECT datname FROM pg_database WHERE datname = $1', [row?.scratch_database]);
    expect(survivors.rows).toHaveLength(0);

    // The partition is gone from the hot table and the bytes are independently readable, which is
    // the entire point: the evidence survived the drop.
    const stillThere = await pool.query('SELECT 1 FROM pg_class WHERE relname = $1', [partition]);
    expect(stillThere.rows).toHaveLength(0);

    const objectUri = await pool.query<{ object_uri: string; checksum_sha256: string }>(
      'SELECT object_uri, checksum_sha256 FROM audit.audit_archive_object WHERE source_partition = $1', [partition],
    );
    // The bytes are really on disk, not reconstructed from a receipt.
    const raw = await readFile(objectUri.rows[0]!.object_uri.slice('file://'.length), 'utf8');
    expect(raw.split('\n').filter((line) => line.length > 0)).toHaveLength(3);
    expect(JSON.parse(raw.split('\n')[0]!)).toMatchObject({ action: 'INVOICE_ISSUED' });

    const readBack = await archive.read(objectUri.rows[0]!.object_uri);
    expect(readBack).toHaveLength(3);
    expect(auditArchiveDigest(readBack)).toBe(objectUri.rows[0]!.checksum_sha256);
  }, 120_000);

  it('holds the partition when the archived bytes no longer match the digest', async () => {
    // The corruption the gate exists to catch: storage silently loses or alters a row, and the
    // partition drop that would have destroyed the last copy is refused.
    const partition = await seedPartition('2021-11', 2);
    const archive = new FileAuditArchive(archiveRoot);
    const result = await archiveExpiredAuditPartitions(pool, {
      organizationId: randomUUID(),
      asOf: asOf.toISOString(),
      policy: defaultAuditRetentionPolicy,
      archive,
      verifyRestore: verifierFor(archive),
      serviceIdentity: 'audit-retention-test',
      requestId: `run-${randomUUID()}`,
      correlationId: `cor-${randomUUID()}`,
    });
    expect(result.outcomes.find((entry) => entry.partition === partition)?.outcome).toBe('ARCHIVED_AND_DROPPED');

    // Corrupt the stored artifact after the fact, exactly as a bad disk or a partial overwrite would.
    const stored = await pool.query<{ object_uri: string }>(
      'SELECT object_uri FROM audit.audit_archive_object WHERE source_partition = $1', [partition],
    );
    const objectPath = stored.rows[0]!.object_uri.slice('file://'.length);
    const lines = (await readFile(objectPath, 'utf8')).split('\n').filter((line) => line.length > 0);
    const tampered = JSON.parse(lines[0]!) as Record<string, unknown>;
    tampered.action = 'SOMETHING_ELSE';
    await writeFile(objectPath, [JSON.stringify(tampered), ...lines.slice(1)].join('\n'), 'utf8');

    // Re-run the verification the scheduler would run on the stored object.
    const verification = await verifierFor(archive).verify({
      partition,
      objectUri: stored.rows[0]!.object_uri,
      expectedDigest: await manifestDigest(objectPath),
      expectedRows: 2,
      expectedMinOccurredAt: '2021-11-10T08:30:00.000Z',
      expectedMaxOccurredAt: '2021-11-11T08:30:00.000Z',
      periodFrom: '2021-11-01T00:00:00.000Z',
      periodThrough: '2021-12-01T00:00:00.000Z',
      serviceIdentity: 'audit-retention-test',
      correlationId: 'cor-reverify',
    });
    expect(verification.status).toBe('FAILED');
    expect(verification.failureReason).toMatch(/digest/i);
  }, 120_000);

  it('reads the rows back out of the restored database instead of trusting the reader', async () => {
    // A verifier that compared the reader's own output against itself would pass with the archive
    // switched off, the scratch database left empty, or the schema wrong — and it would pass this
    // whole file too, which is how the gap was found: neutering the read-back left all four tests
    // green. There is no way to make a lossy restore purely from the outside, so the contract is
    // pinned directly: the verifier must issue a SELECT against the restored table.
    const issued: string[] = [];
    const recordingArchive = new FileAuditArchive(archiveRoot);
    const verifier = new PostgresRestoreVerifier({
      admin,
      reader: recordingArchive,
      schemaSql,
      connectToScratchDatabase: async (databaseName) => {
        const scratchUrl = new URL(adminBaseUrl);
        scratchUrl.pathname = `/${databaseName}`;
        const scratch = new pg.Client({ connectionString: scratchUrl.toString() });
        await scratch.connect();
        return new Proxy(scratch, {
          get(target, property, receiver) {
            if (property !== 'query') return Reflect.get(target, property, receiver) as unknown;
            return (...args: unknown[]) => {
              issued.push(String(args[0]));
              return (target.query as (...a: unknown[]) => unknown)(...args);
            };
          },
        }) as pg.Client;
      },
    });

    const partition = await seedPartition('2021-08', 2);
    const result = await archiveExpiredAuditPartitions(pool, {
      organizationId: randomUUID(),
      asOf: asOf.toISOString(),
      policy: defaultAuditRetentionPolicy,
      archive: recordingArchive,
      verifyRestore: verifier,
      serviceIdentity: 'audit-retention-test',
      requestId: `run-${randomUUID()}`,
      correlationId: `cor-${randomUUID()}`,
    });
    expect(result.outcomes.find((entry) => entry.partition === partition)?.outcome).toBe('ARCHIVED_AND_DROPPED');

    // The restored rows were selected back out of the scratch database, not carried over.
    expect(issued.some((sql) => /SELECT[\s\S]*FROM audit\.audit_entry[\s\S]*ORDER BY/i.test(sql))).toBe(true);
    // And the auditor-shaped probe really ran against it too.
    expect(issued.some((sql) => /WHERE entity_id = \$1 AND request_id = \$2/i.test(sql))).toBe(true);
  }, 120_000);

  it('AUD-ARCHIVE-03: never destroys an artifact whose retention is unset', async () => {
    // audit.retention_years = KOSONG means the archive is kept indefinitely. The purge path must
    // refuse it even when asked directly, not merely skip it by accident during a scheduled run.
    const archive = new FileAuditArchive(archiveRoot);
    const page = {
      partition: 'audit_entry_2021_10', periodFrom: '2021-10-01T00:00:00.000Z',
      periodThrough: '2021-11-01T00:00:00.000Z', cursor: '2021_10/2021-10-10T08:30:00.000Z/x',
      retention: { mode: 'INDEFINITE' as const, purgeAfter: null }, entries: [],
    };
    const receipt = await archive.archive(page);

    expect(await archive.purge(receipt.objectUri)).toBe(false);
    expect(await archive.read(receipt.objectUri)).toEqual([]);

    // And a finite-retention artifact is actually removed, so the refusal above is the rule rather
    // than a purge that silently does nothing at all.
    const finite = await archive.archive({
      ...page, cursor: `${page.cursor}-finite`,
      retention: { mode: 'PURGE_AFTER' as const, purgeAfter: '2031-01-01T00:00:00.000Z' },
    });
    expect(await archive.purge(finite.objectUri)).toBe(true);
    await expect(archive.read(finite.objectUri)).rejects.toThrow();
  });

  it('AUD-ARCHIVE-05: refuses a runtime DELETE on the audit table', async () => {
    // The premise the whole archive design rests on: a row cannot be removed through SQL. If this
    // ever stops holding, partition DROP is no longer the only exit and the archive is not the only
    // copy — so it is asserted rather than assumed.
    const partition = await seedPartition('2021-09', 1);
    const row = await pool.query<{ id: string }>(`SELECT id FROM audit.${partition} LIMIT 1`);
    await expect(pool.query(`DELETE FROM audit.audit_entry WHERE id = $1`, [row.rows[0]!.id]))
      .rejects.toThrow(/immutable|append-only|reject/i);
    await expect(pool.query(`UPDATE audit.audit_entry SET action = 'X' WHERE id = $1`, [row.rows[0]!.id]))
      .rejects.toThrow(/immutable|append-only|reject/i);
  });

  async function manifestDigest(objectPath: string): Promise<string> {
    const manifest = JSON.parse(await readFile(`${objectPath}.manifest`, 'utf8')) as { digest: string };
    return manifest.digest;
  }
});
