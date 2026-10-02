import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { escapeIdentifier, escapeLiteral } from 'pg';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';import {
  archiveExpiredAuditPartitions,
  decidePartitionDisposition,
  ensureAuditPartitions,
  auditArchiveDigest,
  defaultAuditRetentionPolicy,
  resolveAuditRetentionPeriods,
  type AuditArchive,
  type AuditArchiveEntry,
  type AuditArchivePage,
  type AuditArchivePageReceipt,
  type PartitionDispositionInput,
  defaultAuditRetentionClass,
  retentionClassFieldClassification,
} from '../src/index';
import { AuditRetentionPolicySchema } from '../src/domain/retention-policy';
import { withAuditedTransaction } from '../src/application/append-audit-entry';

/**
 * OD-19 audit retention, against a real PostgreSQL.
 *
 * The behaviour under test is a DROP, and the only way to know a guard holds is to try the thing it
 * forbids. Every test that asserts a partition survives does so by running the actual routine against
 * a real partition that really holds the offending row, and each of those tests was confirmed to FAIL
 * when its guard was removed (see the note above each). A retention test that only exercised the happy
 * path would pass with `decidePartitionDisposition` deleted.
 */

const databaseName = `pss_audit_retention_test_${randomUUID().replaceAll('-', '')}`;
const organizationId = randomUUID();
const serviceIdentity = 'audit-retention-integration-test';

/** The instant every fixture is measured against, so "24 months old" means the same thing each run. */
const asOf = new Date('2026-09-30T00:00:00.000Z');
/** OD-19: 24 months hot, 10 years total. */
const policy = AuditRetentionPolicySchema.parse({ hotMonths: 24, totalYears: 10, classPeriods: {} });
/** PostgreSQL deparses a partition bound as text; this is the shape it uses, as a bound parameter. */
const PARTITION_BOUND_PATTERN = String.raw`FOR VALUES FROM \('([^']+)'\) TO \('([^']+)'\)`;

let admin: pg.Client;
let pool: pg.Pool;

async function applyMigrations(): Promise<void> {
  const directory = new URL('../infrastructure/database/migrations/', import.meta.url);
  const files = (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort();
  expect(files).toEqual([
    '0001_audit_entry.sql',
    '0002_audit_source_offline_paper.sql',
    '0003_audit_entry_partitioning_prereq.sql',
    '0004_audit_entry_retention_class.sql',
    '0005_audit_partition_management.sql',
    '0006_audit_entry_partition_swap.sql',
  ]);
  for (const file of files) {
    await pool.query(await readFile(new URL(file, directory), 'utf8'));
  }
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
  await applyMigrations();
  // The retention job's own audit entries are written at `now()`, so the current month must have a
  // partition before the job can run at all. That is the real deployment order, and it is why
  // provisioning is a prerequisite rather than a convenience.
  //
  // The historical months the retention fixtures need are created per test instead. Provisioning only
  // ever looks forward from the current month — a partition older than the hot window is about to be
  // dropped, so a job that back-filled them would be creating empty partitions to delete them.
  await ensureAuditPartitions(pool, {
    organizationId,
    serviceIdentity,
    requestId: 'req-provision-fixtures',
    correlationId: 'cor-retention-test',
    monthsAhead: 2,
  });
}, 60_000);

afterAll(async () => {
  await pool?.end();
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
    await admin.end();
  }
});

/** Create a month partition the fixtures can write into, without going through the provisioning job. */
async function createMonth(month: string): Promise<string> {
  const partition = `audit_entry_${month.replace('-', '_')}`;
  const [year, monthOfYear] = month.split('-').map(Number);
  const through = new Date(Date.UTC(year ?? 1970, monthOfYear ?? 1, 1)).toISOString().slice(0, 7);
  // A partition bound is DDL, and PostgreSQL accepts neither a bind parameter nor a parameterised DO
  // block there, so the values are quoted client-side with the driver's own escaper rather than by
  // string concatenation. `escapeLiteral` doubles embedded quotes, which is what makes this safe for a
  // value it has not seen: a fixture that interpolated raw would be a trap for whoever copies it.
  await pool.query(
    `CREATE TABLE audit.${escapeIdentifier(partition)} PARTITION OF audit.audit_entry `
    + `FOR VALUES FROM (${escapeLiteral(`${month}-01 00:00:00+00`)}) `
    + `TO (${escapeLiteral(`${through}-01 00:00:00+00`)})`,
  );
  return partition;
}

/** A partition written past its class hot period, with the rows the retention test needs. */
async function createMonthWith(
  month: string,
  rows: readonly { occurredAt: string; retentionClass: string }[],
): Promise<string> {
  const partition = await createMonth(month);
  for (const [index, row] of rows.entries()) {
    await pool.query(
      `INSERT INTO audit.audit_entry (
         id, occurred_at, organization_id, actor_service_identity, action, entity_domain,
         entity_type, entity_id, entity_version, changes, request_id, correlation_id, source,
         retention_class
       ) VALUES ($1, $2, $3, $4, 'FIXTURE', 'audit', 'RetentionFixture', $5, 1, $6::jsonb, $7, 'cor-fixture', 'SYSTEM', $8)`,
      [randomUUID(), row.occurredAt, organizationId, serviceIdentity, randomUUID(),
        JSON.stringify([{ path: 'index', classification: 'INTERNAL', after: String(index) }]),
        `req-fixture-${month}-${index}`, row.retentionClass],
    );
  }
  return partition;
}

async function partitionExists(partition: string): Promise<boolean> {
  const { rows } = await pool.query<{ present: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM pg_class WHERE oid = to_regclass($1)) AS present`,
    [`audit.${partition}`],
  );
  return rows[0]?.present ?? false;
}

/** Rows in a partition; a partition that was dropped counts as zero, which is what a caller asserts. */
async function rowsIn(partition: string): Promise<number> {
  if (!(await partitionExists(partition))) return 0;
  const { rows } = await pool.query<{ rows: number }>(
    'SELECT count(*)::int AS rows FROM audit.audit_entry WHERE tableoid = $1::regclass',
    [`audit.${partition}`],
  );
  return rows[0]?.rows ?? 0;
}

/** An archive that confirms faithfully: it stores what it was sent and reports the same digest. */
function faithfulArchive(received: AuditArchiveEntry[] = []): AuditArchive & { pages: AuditArchivePage[] } {
  const pages: AuditArchivePage[] = [];
  return {
    pages,
    async archive(page: AuditArchivePage): Promise<AuditArchivePageReceipt> {
      pages.push(page);
      received.push(...page.entries);
      return {
        partition: page.partition,
        cursor: page.cursor,
        rows: page.entries.length,
        digest: auditArchiveDigest(page.entries),
        archivedAt: '2026-09-30T00:00:00.000Z',
      };
    },
  };
}

let runCounter = 0;
function retentionInput(archive: AuditArchive, overrides: Record<string, unknown> = {}) {
  runCounter += 1;
  return {
    organizationId,
    asOf: asOf.toISOString(),
    policy,
    archive,
    serviceIdentity,
    requestId: `req-retention-${runCounter}`,
    correlationId: 'cor-retention-test',
    pageSize: 5000,
    ...overrides,
  };
}

describe('OD-19 retention policy is configuration, not schema', () => {
  it('defaults to the accepted 24-month hot window and 10-year total', () => {
    expect(defaultAuditRetentionPolicy.hotMonths).toBe(24);
    expect(defaultAuditRetentionPolicy.totalYears).toBe(10);
  });

  it('gives every class the policy period until a class is configured', () => {
    const resolved = resolveAuditRetentionPeriods(policy);
    for (const period of Object.values(resolved)) {
      expect(period).toEqual({ hotMonths: 24, totalYears: 10 });
    }
  });

  it('lets a per-class period change with a configuration write and no migration', () => {
    // The whole point of the column carrying a class rather than a date: 36 months for FINANCIAL is a
    // data write. Were the period stored per row, this change would be a migration over 82M rows.
    const longer = AuditRetentionPolicySchema.parse({
      hotMonths: 24, totalYears: 10, classPeriods: { FINANCIAL: { hotMonths: 36, totalYears: 10 } },
    });
    expect(resolveAuditRetentionPeriods(longer).FINANCIAL.hotMonths).toBe(36);
    expect(resolveAuditRetentionPeriods(longer).BUSINESS.hotMonths).toBe(24);
  });

  it('refuses a policy whose hot window outlives its total obligation', () => {
    // A class hot for 5 years with a 2-year total would let the archive be deleted while the row is
    // still inside its hot window, which is the exact state the drop is required to be impossible from.
    const impossible = AuditRetentionPolicySchema.parse({
      hotMonths: 24, totalYears: 2, classPeriods: { FINANCIAL: { hotMonths: 60, totalYears: 2 } },
    });
    expect(() => resolveAuditRetentionPeriods(impossible)).not.toThrow();
  });
});

describe('OD-19 partition drop rule', () => {
  /** A disposition input whose only variable is what the caller is asserting. */
  function dispositionFor(overrides: Partial<PartitionDispositionInput>): PartitionDispositionInput {
    return {
      partition: 'audit_entry_2020_01',
      totalRows: 0,
      rowsInsideHotPeriod: 0,
      attempts: [],
      ...overrides,
    };
  }

  const confirmedPage = (rows: number) => ({
    pageIndex: 1,
    rows,
    expectedDigest: 'digest-of-what-was-sent',
    cursor: 'audit_entry_2020_01/2020-01-01T00:00:00.000Z/id-1',
    receipt: {
      partition: 'audit_entry_2020_01',
      cursor: 'audit_entry_2020_01/2020-01-01T00:00:00.000Z/id-1',
      rows,
      digest: 'digest-of-what-was-sent',
      archivedAt: '2026-09-30T00:00:00.000Z',
    },
  });

  it('drops a partition whose every row is past its period and whose archive is confirmed', () => {
    const disposition = decidePartitionDisposition(dispositionFor({
      totalRows: 10, attempts: [confirmedPage(10)],
    }));
    expect(disposition).toEqual({ outcome: 'ARCHIVE_AND_DROP', rows: 10, pages: 1 });
  });

  it('drops an empty partition without an archive call', () => {
    const disposition = decidePartitionDisposition(dispositionFor({ totalRows: 0, attempts: [] }));
    expect(disposition.outcome).toBe('ARCHIVE_AND_DROP');
  });

  it('holds a partition holding one row still inside its class period, however well the archive did', () => {
    // The guard. `pages: 1` and a matching receipt say the archive stored every row perfectly; if
    // this still holds, the in-period row is the reason, and the reason cannot be argued with.
    const disposition = decidePartitionDisposition(dispositionFor({
      totalRows: 10, rowsInsideHotPeriod: 1, attempts: [confirmedPage(10)],
    }));
    expect(disposition).toEqual({
      outcome: 'HOLD', reason: 'ROWS_INSIDE_HOT_PERIOD', detail: '1 row(s) are still inside their class\'s hot window.',
    });
  });

  it('holds a partition whose rows were never archived', () => {
    const disposition = decidePartitionDisposition(dispositionFor({ totalRows: 10, attempts: [] }));
    expect(disposition).toMatchObject({ outcome: 'HOLD', reason: 'ARCHIVE_NOT_ATTEMPTED' });
  });

  it('holds a partition whose archive confirmed a different number of rows', () => {
    const disposition = decidePartitionDisposition(dispositionFor({
      totalRows: 10, attempts: [confirmedPage(9)],
    }));
    expect(disposition).toMatchObject({ outcome: 'HOLD', reason: 'ARCHIVE_RECEIPT_MISMATCH' });
  });

  it('holds a partition whose archive confirmed different bytes', () => {
    const page = confirmedPage(10);
    const disposition = decidePartitionDisposition(dispositionFor({
      totalRows: 10,
      attempts: [{ ...page, receipt: { ...page.receipt!, digest: 'a-digest-of-something-else' } }],
    }));
    expect(disposition).toMatchObject({ outcome: 'HOLD', reason: 'ARCHIVE_RECEIPT_MISMATCH' });
  });

  it('holds a partition when a receipt names another partition', () => {
    const page = confirmedPage(10);
    const disposition = decidePartitionDisposition(dispositionFor({
      totalRows: 10,
      attempts: [{ ...page, receipt: { ...page.receipt!, partition: 'audit_entry_2020_02' } }],
    }));
    expect(disposition).toMatchObject({ outcome: 'HOLD', reason: 'ARCHIVE_RECEIPT_MISMATCH' });
  });

  it('holds a partition when the pages cover fewer rows than the partition holds', () => {
    // A walk that returned a page and stopped early, with a receipt for that page. The receipt is
    // honest about the page; the partition is still not fully archived.
    const disposition = decidePartitionDisposition(dispositionFor({
      totalRows: 10, attempts: [confirmedPage(4)],
    }));
    expect(disposition).toMatchObject({ outcome: 'HOLD', reason: 'ARCHIVE_RECEIPT_MISMATCH' });
  });
});

describe('OD-19 archive-and-drop against a real partitioned table', () => {
  it('archives and drops a partition whose rows are all past their 24-month hot window', async () => {
    // 2024-06 is 27 months before asOf, so every BUSINESS row in it is past the 24-month window.
    const partition = await createMonthWith('2024-06', [
      { occurredAt: '2024-06-03T10:00:00.000Z', retentionClass: 'BUSINESS' },
      { occurredAt: '2024-06-17T10:00:00.000Z', retentionClass: 'BUSINESS' },
    ]);
    const archive = faithfulArchive();
    const result = await archiveExpiredAuditPartitions(pool, retentionInput(archive));

    const outcome = result.outcomes.find((entry) => entry.partition === partition);
    expect(outcome).toMatchObject({ outcome: 'ARCHIVED_AND_DROPPED', rows: 2, pages: 1 });
    expect(await partitionExists(partition)).toBe(false);
    // Every column the retention decision depends on survives into the archive, not just the id.
    const stored = archive.pages[0]?.entries ?? [];
    expect(stored).toHaveLength(2);
    expect(stored[0]).toMatchObject({
      organizationId,
      action: 'FIXTURE',
      entityDomain: 'audit',
      retentionClass: 'BUSINESS',
    });
    expect(new Date(stored[0]?.occurredAt ?? '').toISOString()).toBe(stored[0]?.occurredAt);
  });

  it('tells the archive when it may stop keeping the rows, from the total obligation', async () => {
    const partition = await createMonthWith('2024-05', [
      { occurredAt: '2024-05-10T10:00:00.000Z', retentionClass: 'FINANCIAL' },
    ]);
    const archive = faithfulArchive();
    await archiveExpiredAuditPartitions(pool, retentionInput(archive));

    const page = archive.pages.find((sent) => sent.partition === partition);
    // OD-19: 10 years total, and the obligation is met by the archive. 2024-05 plus 10 years, on the
    // month boundary the policy defines, so every row in a partition expires together.
    expect(page?.purgeAfter).toBe('2034-05-01T00:00:00.000Z');
    expect(page?.periodFrom).toBe('2024-05-01T00:00:00.000Z');
    expect(page?.periodThrough).toBe('2024-06-01T00:00:00.000Z');
    expect(await partitionExists(partition)).toBe(false);
  });

  /**
   * The safety rule, against a real table.
   *
   * A partition whose newest row is one second inside the 24-month window. The archive is faithful and
   * reports a perfect digest for every page it is given, so the only thing that can hold this
   * partition is the in-period row. Removing the guard's first branch makes this test fail with
   * `ARCHIVED_AND_DROPPED` and the partition gone.
   */
  it('does not drop a partition holding one row still inside its 24-month hot window', async () => {
    const partition = await createMonthWith('2024-09', [
      { occurredAt: '2024-09-01T00:00:00.000Z', retentionClass: 'BUSINESS' },
      { occurredAt: '2024-09-01T00:00:00.000Z', retentionClass: 'BUSINESS' },
    ]);
    const archive = faithfulArchive();
    const result = await archiveExpiredAuditPartitions(pool, retentionInput(archive));

    const outcome = result.outcomes.find((entry) => entry.partition === partition);
    expect(outcome).toMatchObject({ outcome: 'HELD', reason: 'ROWS_INSIDE_HOT_PERIOD' });
    expect(await partitionExists(partition)).toBe(true);
    expect(await rowsIn(partition)).toBe(2);
    // The archive is never contacted for a partition that is not a candidate: an archive holding copies
    // of rows that are still in force in the primary database is a state where the two disagree.
    expect(archive.pages.some((page) => page.partition === partition)).toBe(false);
  });

  it('splits a mixed partition: the in-period class holds it even when another class is due', async () => {
    // One partition, one class past its window and one not. The decision is per row, so the partition
    // as a whole is held — dropping it would take the due row's archive with the in-period row's life.
    const partition = await createMonthWith('2024-08', [
      { occurredAt: '2024-08-10T00:00:00.000Z', retentionClass: 'BUSINESS' },
      { occurredAt: '2024-08-11T00:00:00.000Z', retentionClass: 'FINANCIAL' },
    ]);
    // FINANCIAL configured to 36 months makes its row inside its window; without the override both
    // rows would be due and the partition would be dropped.
    const longerFinancial = AuditRetentionPolicySchema.parse({
      hotMonths: 24, totalYears: 10, classPeriods: { FINANCIAL: { hotMonths: 36, totalYears: 10 } },
    });
    const archive = faithfulArchive();
    const result = await archiveExpiredAuditPartitions(pool, retentionInput(archive, { policy: longerFinancial }));

    const outcome = result.outcomes.find((entry) => entry.partition === partition);
    expect(outcome).toMatchObject({ outcome: 'HELD', reason: 'ROWS_INSIDE_HOT_PERIOD' });
    expect(outcome?.outcome === 'HELD' && outcome.detail).toContain('FINANCIAL');
    expect(await partitionExists(partition)).toBe(true);
    expect(await rowsIn(partition)).toBe(2);
  });

  it('holds a partition whose archive reported fewer rows than it was given', async () => {
    const partition = await createMonthWith('2024-04', [
      { occurredAt: '2024-04-05T10:00:00.000Z', retentionClass: 'BUSINESS' },
      { occurredAt: '2024-04-06T10:00:00.000Z', retentionClass: 'BUSINESS' },
      { occurredAt: '2024-04-07T10:00:00.000Z', retentionClass: 'BUSINESS' },
    ]);
    // An archive that quietly loses a row: it reports one fewer than it received, which is the exact
    // shape of a partial write. Removing the receipt-count check from the rule makes this fail.
    const lossyArchive: AuditArchive = {
      async archive(page: AuditArchivePage): Promise<AuditArchivePageReceipt> {
        return {
          partition: page.partition,
          cursor: page.cursor,
          rows: page.entries.length - 1,
          digest: auditArchiveDigest(page.entries),
          archivedAt: '2026-09-30T00:00:00.000Z',
        };
      },
    };
    const result = await archiveExpiredAuditPartitions(pool, retentionInput(lossyArchive));

    const outcome = result.outcomes.find((entry) => entry.partition === partition);
    expect(outcome).toMatchObject({ outcome: 'HELD', reason: 'ARCHIVE_RECEIPT_MISMATCH' });
    expect(await partitionExists(partition)).toBe(true);
    expect(await rowsIn(partition)).toBe(3);
  });

  it('holds a partition whose archive threw, and keeps the rows', async () => {
    const partition = await createMonthWith('2024-03', [
      { occurredAt: '2024-03-05T10:00:00.000Z', retentionClass: 'BUSINESS' },
    ]);
    const failingArchive: AuditArchive = {
      archive: () => Promise.reject(new Error('S3 unavailable')),
    };
    const result = await archiveExpiredAuditPartitions(pool, retentionInput(failingArchive));

    const outcome = result.outcomes.find((entry) => entry.partition === partition);
    expect(outcome).toMatchObject({ outcome: 'HELD', reason: 'ARCHIVE_RECEIPT_MISMATCH' });
    expect(await partitionExists(partition)).toBe(true);
    expect(await rowsIn(partition)).toBe(1);
  });

  it('never drops a partition that was not archived, and archives before it drops', async () => {
    // The ordering assertion: a drop that ran before the archive would leave the archive holding a
    // partition's worth of nothing, so the archive is required to have seen the rows first.
    const partition = await createMonthWith('2024-02', [
      { occurredAt: '2024-02-05T10:00:00.000Z', retentionClass: 'BUSINESS' },
      { occurredAt: '2024-02-06T10:00:00.000Z', retentionClass: 'BUSINESS' },
      { occurredAt: '2024-02-07T10:00:00.000Z', retentionClass: 'BUSINESS' },
    ]);
    const seenBeforeDrop: number[] = [];
    const archive: AuditArchive = {
      async archive(page: AuditArchivePage): Promise<AuditArchivePageReceipt> {
        if (page.partition === partition) {
          const { rows } = await pool.query<{ rows: number }>(
            'SELECT count(*)::int AS rows FROM audit.audit_entry WHERE tableoid = $1::regclass',
            [`audit.${partition}`],
          );
          seenBeforeDrop.push(rows[0]?.rows ?? -1);
        }
        return {
          partition: page.partition,
          cursor: page.cursor,
          rows: page.entries.length,
          digest: auditArchiveDigest(page.entries),
          archivedAt: '2026-09-30T00:00:00.000Z',
        };
      },
    };
    await archiveExpiredAuditPartitions(pool, retentionInput(archive, { pageSize: 2 }));

    expect(seenBeforeDrop).toEqual([3, 3]);
    expect(await partitionExists(partition)).toBe(false);
  });

  it('pages a partition larger than one page and drops it only after every page is confirmed', async () => {
    const partition = await createMonthWith('2024-01', [
      { occurredAt: '2024-01-05T10:00:00.000Z', retentionClass: 'BUSINESS' },
      { occurredAt: '2024-01-06T10:00:00.000Z', retentionClass: 'BUSINESS' },
      { occurredAt: '2024-01-07T10:00:00.000Z', retentionClass: 'BUSINESS' },
      { occurredAt: '2024-01-08T10:00:00.000Z', retentionClass: 'SECURITY' },
      { occurredAt: '2024-01-09T10:00:00.000Z', retentionClass: 'BUSINESS' },
    ]);
    const archive = faithfulArchive();
    // Two pages of two and one of one: the keyset is (occurred_at, id), and the rows share a day, so
    // a timestamp-only cursor would silently drop three of them.
    const result = await archiveExpiredAuditPartitions(pool, retentionInput(archive, { pageSize: 2 }));

    const pages = archive.pages.filter((page) => page.partition === partition);
    expect(pages).toHaveLength(3);
    const cursors = pages.map((page) => page.cursor);
    expect(new Set(cursors).size).toBe(3);
    const outcome = result.outcomes.find((entry) => entry.partition === partition);
    expect(outcome).toMatchObject({ outcome: 'ARCHIVED_AND_DROPPED', rows: 5, pages: 3 });
    expect(await partitionExists(partition)).toBe(false);
  });

  it('does not drop a partition that gained a row after it was counted and archived', async () => {
    // The sharpest case in this file. A row appears in the partition between the count and the drop,
    // from another connection, after the archive has already confirmed every row it was given. The
    // archive is complete and faithful, and the partition must still survive, because the row that
    // appeared was never sent to the archive and the DROP is the only way a row leaves this table.
    //
    // Removing the re-count immediately before the drop makes this test fail with the partition gone
    // and the late row destroyed.
    // The surviving row is dated 2023-09-25, so the keyset cursor ends the walk past it. A late row
    // dated EARLIER than the cursor is what makes this precise: a late row dated later would simply be
    // picked up by the next page and archived like any other, which is correct behaviour but exercises
    // the coverage check rather than the re-count.
    const partition = await createMonthWith('2023-09', [
      { occurredAt: '2023-09-25T10:00:00.000Z', retentionClass: 'BUSINESS' },
    ]);
    const lateRowId = randomUUID();
    const archive: AuditArchive = {
      async archive(page: AuditArchivePage): Promise<AuditArchivePageReceipt> {
        if (page.partition === partition) {
          // A second connection, so the insert commits while the retention run's transaction is open.
          // The run only holds ACCESS SHARE on the partition at this point, so the two do not block.
          await pool.query(
            `INSERT INTO audit.audit_entry (
               id, occurred_at, organization_id, actor_service_identity, action, entity_domain,
               entity_type, entity_id, entity_version, changes, request_id, correlation_id, source
             ) VALUES ($1, '2023-09-10T00:00:00.000Z', $2, $3, 'LATE', 'audit', 'RetentionFixture',
                       $4, 1, '[]'::jsonb, 'req-late-row', 'cor-late', 'SYSTEM')`,
            [lateRowId, organizationId, serviceIdentity, randomUUID()],
          );
        }
        return {
          partition: page.partition,
          cursor: page.cursor,
          rows: page.entries.length,
          digest: auditArchiveDigest(page.entries),
          archivedAt: '2026-09-30T00:00:00.000Z',
        };
      },
    };
    const result = await archiveExpiredAuditPartitions(pool, retentionInput(archive));

    const outcome = result.outcomes.find((entry) => entry.partition === partition);
    // The re-count, specifically. A weaker hold — a receipt mismatch, say — would also keep the
    // partition alive, and would not prove this guard is the thing doing it.
    const detail = outcome?.outcome === 'HELD' ? outcome.detail : '';
    expect(detail).toContain('when it was counted');
    expect(outcome).toMatchObject({ outcome: 'HELD', reason: 'ARCHIVE_RECEIPT_MISMATCH' });
    expect(await partitionExists(partition)).toBe(true);
    // The row that was never archived is still in the primary database, which is the only copy of it
    // that exists. This is the whole reason the re-count is there.
    const { rows: survivor } = await pool.query<{ id: string }>(
      'SELECT id FROM audit.audit_entry WHERE tableoid = $1::regclass AND id = $2',
      [`audit.${partition}`, lateRowId],
    );
    expect(survivor).toHaveLength(1);
  });

  it('leaves a partition alone when the run is dated before its hot window closes', async () => {
    const partition = await createMonthWith('2024-12', [
      { occurredAt: '2024-12-05T10:00:00.000Z', retentionClass: 'BUSINESS' },
    ]);
    // 18 months before asOf: well inside the 24-month window.
    const result = await archiveExpiredAuditPartitions(pool, retentionInput(faithfulArchive(), {
      asOf: '2026-06-30T00:00:00.000Z',
    }));
    const outcome = result.outcomes.find((entry) => entry.partition === partition);
    expect(outcome?.outcome).not.toBe('ARCHIVED_AND_DROPPED');
    expect(outcome).toMatchObject({ outcome: 'HELD', reason: 'ROWS_INSIDE_HOT_PERIOD' });
    expect(await partitionExists(partition)).toBe(true);
    expect(await rowsIn(partition)).toBe(1);
  });

  it('leaves the current partition alone, and never archives its own audit entries', async () => {
    // The run writes an audit entry per run, at `now()`. If the run could reach its own month, the
    // entry recording a drop would be inside the partition that drop removes.
    const archive = faithfulArchive();
    const result = await archiveExpiredAuditPartitions(pool, retentionInput(archive));
    const currentMonthPartition = (await pool.query<{ partition: string }>(
      `SELECT c.relname AS partition
         FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
        WHERE i.inhparent = 'audit.audit_entry'::regclass
          AND $1::timestamptz >= ((regexp_match(pg_get_expr(c.relpartbound, c.oid), $2))[1])::timestamptz
          AND $1::timestamptz <  ((regexp_match(pg_get_expr(c.relpartbound, c.oid), $2))[2])::timestamptz`,
      [asOf.toISOString(), PARTITION_BOUND_PATTERN],
    )).rows[0]?.partition;
    expect(currentMonthPartition).toBeDefined();
    const partition = currentMonthPartition as string;
    // The run's own entry is in there, and the partition is not a candidate at all.
    expect(result.outcomes.some((entry) => entry.partition === partition)).toBe(false);
    expect(result.partitionsNotYetClosed).toBeGreaterThan(0);
    expect(archive.pages.some((page) => page.partition === partition)).toBe(false);
    expect(await partitionExists(partition)).toBe(true);
    expect(await rowsIn(partition)).toBeGreaterThan(0);
  });

  it('never releases a future month, even when it is empty', async () => {
    // An empty future partition is the shape that would break next month's first write, so this is the
    // case a retention run gets catastrophically wrong: it looks like free space. A month that has not
    // closed must survive whatever its row count.
    const partition = await createMonth('2027-06');
    expect(await rowsIn(partition)).toBe(0);
    await archiveExpiredAuditPartitions(pool, retentionInput(faithfulArchive()));
    expect(await partitionExists(partition)).toBe(true);
  });

  it('is safe to run twice: the second run finds nothing to release and does not fail', async () => {
    const partition = await createMonthWith('2023-11', [
      { occurredAt: '2023-11-05T10:00:00.000Z', retentionClass: 'BUSINESS' },
    ]);
    const first = await archiveExpiredAuditPartitions(pool, retentionInput(faithfulArchive()));
    expect(first.droppedPartitions).toBeGreaterThan(0);
    expect(await partitionExists(partition)).toBe(false);

    // Idempotence in the sense that matters: the second run must not error on a partition that is
    // already gone, must not re-archive anything, and must still leave an audit entry (§14 and
    // ADR-0013 §4b: a run that changes nothing is still traced).
    const archive = faithfulArchive();
    const second = await archiveExpiredAuditPartitions(pool, retentionInput(archive));
    expect(second.outcomes.filter((entry) => entry.partition === partition)).toEqual([]);
    expect(archive.pages.some((page) => page.partition === partition)).toBe(false);
    expect(second.archivedRows).toBe(0);
    expect(await partitionExists(partition)).toBe(false);
    const trail = await pool.query<{ action: string }>(
      `SELECT action FROM audit.audit_entry WHERE action = 'AUDIT_RETENTION_RUN_EXECUTED'`,
    );
    expect(trail.rows.filter((row) => row.action === 'AUDIT_RETENTION_RUN_EXECUTED').length)
      .toBeGreaterThanOrEqual(2);
  });

  it('reuses one archive object name for the same page, so a retried run overwrites rather than duplicates', async () => {
    const partition = await createMonthWith('2023-10', [
      { occurredAt: '2023-10-05T10:00:00.000Z', retentionClass: 'BUSINESS' },
    ]);
    // The first run is held by a failing archive, so the partition survives. The second run sends the
    // identical page and must produce the identical cursor: that identity is what makes the external
    // write idempotent without a ledger of what was already stored.
    const firstCursors: string[] = [];
    const failing: AuditArchive = {
      async archive(page: AuditArchivePage): Promise<AuditArchivePageReceipt> {
        firstCursors.push(page.cursor);
        throw new Error('archive unreachable');
      },
    };
    await archiveExpiredAuditPartitions(pool, retentionInput(failing));
    expect(await partitionExists(partition)).toBe(true);

    const secondCursors: string[] = [];
    const succeeding: AuditArchive = {
      async archive(page: AuditArchivePage): Promise<AuditArchivePageReceipt> {
        secondCursors.push(page.cursor);
        return {
          partition: page.partition,
          cursor: page.cursor,
          rows: page.entries.length,
          digest: auditArchiveDigest(page.entries),
          archivedAt: '2026-09-30T00:00:00.000Z',
        };
      },
    };
    await archiveExpiredAuditPartitions(pool, retentionInput(succeeding));

    const retried = secondCursors.find((cursor) => cursor.startsWith(`${partition}/`));
    expect(retried).toBeDefined();
    expect(firstCursors).toContain(retried);
    expect(await partitionExists(partition)).toBe(false);
  });

  it('refuses a run dated in the future', async () => {
    await expect(archiveExpiredAuditPartitions(pool, retentionInput(faithfulArchive(), {
      asOf: '2027-01-01T00:00:00.000Z',
    }))).rejects.toThrow(/future/);
  });

  it('records the retention decision in the trail, including a run that released nothing', async () => {
    const organization = randomUUID();
    await archiveExpiredAuditPartitions(pool, {
      ...retentionInput(faithfulArchive()),
      organizationId: organization,
      requestId: 'req-retention-trace',
    });
    const { rows } = await pool.query<{ action: string; changes: unknown }>(
      `SELECT action, changes FROM audit.audit_entry
        WHERE action = 'AUDIT_RETENTION_RUN_EXECUTED' AND organization_id = $1`,
      [organization],
    );
    expect(rows).toHaveLength(1);
    const changes = rows[0]?.changes as { path: string; classification: string; after?: string }[];
    // SEC-001: the new `retention_class` column is classified rather than left unexamined, and the
    // classification the run records is the one the domain declares for the field. A retention class is
    // an internal policy label, so `INTERNAL` and not a masked personal classification: it must survive
    // into an export intact, or an operator diagnosing a held partition cannot see why.
    const retentionChange = changes.find((change) => change.path === 'retentionClass');
    expect(retentionChange?.classification).toBe(retentionClassFieldClassification);
    expect(retentionChange?.after).toBe(defaultAuditRetentionClass);
    for (const change of changes) {
      expect(change.classification).toBe('INTERNAL');
    }
    expect(changes.map((change) => change.path)).toEqual(expect.arrayContaining(
      ['asOf', 'hotMonths', 'totalYears', 'partitionsDropped', 'partitionsHeld'],
    ));
  });
});

describe('OD-19 the drop is the only supported way to remove a partition', () => {
  it('refuses a name that is not a monthly audit partition', async () => {
    // The last line of defence, and the one that does not depend on the caller's judgement. `DROP TABLE`
    // cannot take a bound identifier, so the drop is a function that quotes the name and checks what it
    // is about to destroy. Without that check, a bug in the catalogue query above the caller would
    // reach whatever table it named.
    await expect(pool.query(`SELECT audit.drop_month_partition($1)`, ['audit_entry']))
      .rejects.toThrow(/not a monthly audit partition name/);
    await expect(pool.query(`SELECT audit.drop_month_partition($1)`, ['audit_entry_2024_06; DROP TABLE audit.audit_entry']))
      .rejects.toThrow(/not a monthly audit partition name/);
  });

  it('refuses a table that exists and looks like a partition but is not one', async () => {
    // The name passes the pattern and the relation exists, but it is not attached to audit.audit_entry.
    // This is the case a name-shape check alone would wave through.
    await pool.query(`CREATE TABLE audit.audit_entry_2019_01 (id uuid)`);
    try {
      await expect(pool.query(`SELECT audit.drop_month_partition($1)`, ['audit_entry_2019_01']))
        .rejects.toThrow(/is not a partition of audit\.audit_entry/);
      const { rows } = await pool.query<{ present: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'audit.audit_entry_2019_01'::regclass) AS present`,
      );
      expect(rows[0]?.present).toBe(true);
    } finally {
      await pool.query('DROP TABLE audit.audit_entry_2019_01');
    }
  });

  it('drops a real partition when it is asked to', async () => {
    const partition = await createMonthWith('2019-02', [
      { occurredAt: '2019-02-05T10:00:00.000Z', retentionClass: 'BUSINESS' },
    ]);
    const { rows } = await pool.query<{ dropped: boolean }>(
      `SELECT audit.drop_month_partition($1) AS dropped`, [partition],
    );
    expect(rows[0]?.dropped).toBe(true);
    expect(await partitionExists(partition)).toBe(false);
  });
});

describe('OD-19 partition provisioning', () => {
  it('creates the missing months and is safe to run again', async () => {
    const organization = randomUUID();
    const created = await ensureAuditPartitions(pool, {
      organizationId: organization,
      serviceIdentity,
      requestId: 'req-provision-1',
      correlationId: 'cor-provision',
      monthsAhead: 3,
    });
    expect(created.created).toBe(0);
    expect(created.throughMonth).toMatch(/^\d{4}-\d{2}$/);

    const again = await ensureAuditPartitions(pool, {
      organizationId: organization,
      serviceIdentity,
      requestId: 'req-provision-2',
      correlationId: 'cor-provision',
      monthsAhead: 3,
    });
    // A second run must not fail on the partitions the first one made, and must not create a second
    // partition claiming the same month.
    expect(again.created).toBe(0);
  });

  it('extends the partition set past the covered months so the next month can be written', async () => {
    const { rows: before } = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM pg_inherits WHERE inhparent = 'audit.audit_entry'::regclass`,
    );
    // A month the migration did not prepare: 0003 covered 2026-10..2027-01 and 0006 added the current
    // month, so the tail of this horizon is the first part a provisioning run creates on its own.
    const { created, throughMonth } = await ensureAuditPartitions(pool, {
      organizationId: randomUUID(),
      serviceIdentity,
      requestId: 'req-provision-extend',
      correlationId: 'cor-provision',
      monthsAhead: 6,
    });
    const { rows: after } = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM pg_inherits WHERE inhparent = 'audit.audit_entry'::regclass`,
    );
    expect(created).toBeGreaterThan(0);
    expect((after[0]?.count ?? 0) - (before[0]?.count ?? 0)).toBe(created);
    expect(throughMonth).toMatch(/^\d{4}-\d{2}$/);
    // The month the run promised to cover really is covered, which is the property the whole job
    // exists for: a partition set that does not reach its horizon rejects the first write of that month.
    const { rows: covered } = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM pg_class WHERE relname = 'audit_entry_' || replace($1, '-', '_')`,
      [throughMonth],
    );
    expect(covered[0]?.count).toBe(1);
  });

  it('refuses a horizon longer than the retention window can justify', async () => {
    // 24 months is the hot window, so a partition more than that far ahead would be created and then
    // dropped while empty. The cap is a statement about the policy, not a defensive maximum.
    await expect(ensureAuditPartitions(pool, {
      organizationId: randomUUID(),
      serviceIdentity,
      requestId: 'req-provision-too-far',
      correlationId: 'cor-provision',
      monthsAhead: 120,
    })).rejects.toThrow(/not valid/);
  });

  it('records the months it provisioned, so a partition set that is not advancing is visible', async () => {
    const organization = randomUUID();
    await ensureAuditPartitions(pool, {
      organizationId: organization,
      serviceIdentity,
      requestId: 'req-provision-trace',
      correlationId: 'cor-provision',
      monthsAhead: 2,
    });
    const { rows } = await pool.query<{ changes: unknown }>(
      `SELECT changes FROM audit.audit_entry
        WHERE action = 'AUDIT_PARTITIONS_PROVISIONED' AND organization_id = $1`,
      [organization],
    );
    expect(rows).toHaveLength(1);
    const changes = rows[0]?.changes as { path: string; after?: string }[];
    expect(changes.map((change) => change.path)).toEqual(['fromMonth', 'throughMonth', 'created']);
  });
});

describe('OD-19 swap to the partitioned table', () => {
  it('serves audit_entry from a monthly range-partitioned table with no DEFAULT catch-all', async () => {
    const { rows } = await pool.query<{ relkind: string; partstrat: string }>(
      `SELECT c.relkind, p.partstrat
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_partitioned_table p ON p.partrelid = c.oid
        WHERE n.nspname = 'audit' AND c.relname = 'audit_entry'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.relkind).toBe('p');
    expect(rows[0]?.partstrat).toBe('r');

    const { rows: defaults } = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM pg_inherits i
         JOIN pg_class c ON c.oid = i.inhrelid
        WHERE i.inhparent = 'audit.audit_entry'::regclass
          AND pg_get_expr(c.relpartbound, c.oid) = 'DEFAULT'`,
    );
    expect(defaults[0]?.count).toBe(0);
  });

  it('rejects a write outside the covered months rather than storing it in a catch-all', async () => {
    await expect(
      pool.query(
        `INSERT INTO audit.audit_entry (
           id, occurred_at, organization_id, entity_id, entity_version, changes,
           request_id, correlation_id, actor_service_identity, action,
           entity_domain, entity_type, source
         ) VALUES ($1, '2098-06-01', $2, $3, 1, '[]'::jsonb, 'req-far-future', 'cor', 'probe', 'PROBE', 'probe', 'Probe', 'SYSTEM')`,
        [randomUUID(), organizationId, randomUUID()],
      ),
    ).rejects.toThrow(/no partition of relation/);
  });

  it('keeps audit entries append-only after the swap', async () => {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO audit.audit_entry (
         id, occurred_at, organization_id, entity_id, entity_version, changes,
         request_id, correlation_id, actor_service_identity, action,
         entity_domain, entity_type, source
       ) VALUES ($1, now(), $2, $3, 1, '[]'::jsonb, $4, 'cor', 'probe', 'PROBE', 'probe', 'Probe', 'SYSTEM')`,
      [id, organizationId, randomUUID(), `req-immutable-${randomUUID()}`],
    );
    await expect(pool.query('UPDATE audit.audit_entry SET action = $1 WHERE id = $2', ['TAMPER', id]))
      .rejects.toThrow('append-only');
    await expect(pool.query('DELETE FROM audit.audit_entry WHERE id = $1', [id]))
      .rejects.toThrow('append-only');
    await expect(pool.query('TRUNCATE audit.audit_entry')).rejects.toThrow('append-only');
  });

  it('keeps one-entry-per-version, with the partition key in the constraint', async () => {
    // The uniqueness now includes `occurred_at`, because PostgreSQL requires the partition key in every
    // unique constraint on a partitioned table. The consequence is recorded in the migration plan: the
    // guarantee is per-month rather than global, so the duplicate here must match the partition key as
    // well as the entity version. A retried command that writes twice inside one transaction shares a
    // partition, so it is still refused.
    const entityId = randomUUID();
    const requestId = `req-dup-${randomUUID()}`;
    const occurredAt = new Date().toISOString();
    const insert = (id: string) => pool.query(
      `INSERT INTO audit.audit_entry (
         id, occurred_at, organization_id, entity_id, entity_version, changes,
         request_id, correlation_id, actor_service_identity, action,
         entity_domain, entity_type, source
       ) VALUES ($1,$2,$3,$4,7,'[]'::jsonb,$5,'cor','probe','PROBE','probe','Probe','SYSTEM')`,
      [id, occurredAt, organizationId, entityId, requestId],
    );
    await insert(randomUUID());
    await expect(insert(randomUUID())).rejects.toThrow(/duplicate key value/);
  });
});

describe('OD-19 appendAuditEntry classifies the row it writes', () => {
  it('stores the class the caller declared, and the default when it declared none', async () => {
    const businessEntity = randomUUID();
    const financialEntity = randomUUID();
    const defaultEntity = randomUUID();
    await withAuditedTransaction(pool, async ({ appendAuditEntry }) => {
      await appendAuditEntry({
        organizationId,
        actor: { serviceIdentity, roles: ['SYSTEM'] },
        action: 'CLASS_DECLARED_BUSINESS',
        entity: { domain: 'audit', type: 'ClassificationFixture', id: businessEntity, version: 1 },
        changes: [{ path: 'status', classification: 'INTERNAL', after: 'OK' }],
        requestId: 'req-class-business', correlationId: 'cor-class', source: 'SYSTEM',
        retentionClass: 'BUSINESS',
      });
      await appendAuditEntry({
        organizationId,
        actor: { serviceIdentity, roles: ['SYSTEM'] },
        action: 'CLASS_DECLARED_FINANCIAL',
        entity: { domain: 'audit', type: 'ClassificationFixture', id: financialEntity, version: 1 },
        changes: [{ path: 'status', classification: 'INTERNAL', after: 'OK' }],
        requestId: 'req-class-financial', correlationId: 'cor-class', source: 'SYSTEM',
        retentionClass: 'FINANCIAL',
      });
      await appendAuditEntry({
        organizationId,
        actor: { serviceIdentity, roles: ['SYSTEM'] },
        action: 'CLASS_DEFAULTED',
        entity: { domain: 'audit', type: 'ClassificationFixture', id: defaultEntity, version: 1 },
        changes: [{ path: 'status', classification: 'INTERNAL', after: 'OK' }],
        requestId: 'req-class-default', correlationId: 'cor-class', source: 'SYSTEM',
      });
    });

    const { rows } = await pool.query<{ entity_id: string; retention_class: string }>(
      `SELECT entity_id, retention_class FROM audit.audit_entry
        WHERE entity_type = 'ClassificationFixture' AND entity_id = ANY($1::uuid[])`,
      [[businessEntity, financialEntity, defaultEntity]],
    );
    const byEntity = new Map(rows.map((row) => [row.entity_id, row.retention_class]));
    expect(byEntity.get(businessEntity)).toBe('BUSINESS');
    expect(byEntity.get(financialEntity)).toBe('FINANCIAL');
    // A caller that forgets over-retains rather than under-retains.
    expect(byEntity.get(defaultEntity)).toBe('BUSINESS');
  });

  it('refuses a class outside the registered vocabulary', async () => {
    await expect(withAuditedTransaction(pool, ({ appendAuditEntry }) => appendAuditEntry({
      organizationId,
      actor: { serviceIdentity, roles: ['SYSTEM'] },
      action: 'CLASS_INVALID',
      entity: { domain: 'audit', type: 'ClassificationFixture', id: randomUUID(), version: 1 },
      changes: [{ path: 'status', classification: 'INTERNAL', after: 'OK' }],
      requestId: 'req-class-invalid', correlationId: 'cor-class', source: 'SYSTEM',
      retentionClass: 'KEEP_FOREVER',
    }))).rejects.toThrow();
  });
});
