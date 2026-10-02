import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import {
  auditArchiveDigest,
  type AuditArchive,
  type AuditArchiveEntry,
  type AuditArchivePage,
  type AuditArchivePageReceipt,
} from '../domain/audit-archive';
import {
  decidePartitionDisposition,
  type PartitionHoldReason,
  type PartitionPageAttempt,
} from '../domain/rules/partition-retention-decision';
import {
  assertAuditRetentionPolicy,
  auditRetentionHotCutoff,
  auditRetentionPurgeAfter,
  AuditRetentionPolicySchema,
  defaultAuditRetentionClass,
  resolveAuditRetentionPeriods,
  retentionClassFieldClassification,
  type AuditRetentionClass,
  type AuditRetentionPolicy,
} from '../domain/retention-policy';
import { withAuditedTransaction, type AuditedTransaction } from './append-audit-entry';

/**
 * OD-19 archive-and-drop: move audit entries past their hot window to cold archive storage, then
 * release the primary database of the partition that held them.
 *
 * WHY THE DROP IS SAFE AND WHY IT IS NOT OBVIOUS. `audit.audit_entry` is append-only and its
 * triggers refuse UPDATE, DELETE and TRUNCATE, so a partition DROP is the ONLY way a row leaves the
 * primary database. That makes the archive the sole remaining copy, which is exactly the state the
 * decision intends and exactly the state in which a mistake is unrecoverable. Every path to the DROP
 * therefore goes through `decidePartitionDisposition`, and the order inside that function is the
 * safety property: a row still inside its class period outranks a perfectly confirmed archive.
 *
 * WHY ONE TRANSACTION. The DROP and the audit entry that records it commit together, so a crash can
 * never leave a partition gone with nothing in the trail saying so. The archive call is the one
 * effect that cannot be transactional; it is made idempotent by a content-derived cursor instead, so a
 * re-run rewrites the same objects rather than duplicating them. A rollback after a successful archive
 * leaves the partition in place with its rows already archived, and the next run archives them again
 * to the same keys. That is the safe direction: rows are never lost, and the archive never diverges
 * from the table.
 *
 * WHY THERE IS NO RECURSION. This job appends its own audit entries, and those entries are written
 * with `occurred_at = now()`, so they land in the current month's partition. A partition is only ever
 * examined when its month has closed, so the entries describing a drop can never be inside the
 * partition that drop removes. An audit entry for this run is itself archived, under its own class,
 * 24 months from now — which is the correct answer, since a retention decision is a record worth
 * keeping.
 *
 * WHY IT USES `withAuditedTransaction` RATHER THAN `runCommand`. `@pss/platform` depends on
 * `@pss/audit`, so the audit domain cannot import the platform's command pipeline without a package
 * cycle. The two primitives are the same objects: ADR-0013 defines `withConnection` as
 * `runAuditedWork` on an open client or `withAuditedTransaction` otherwise, and both of those are
 * defined here. The audit guard, the append-only trigger and the transaction boundary are therefore
 * identical; only the idempotency record, which lives in a `platform` table, is not available to a
 * domain that owns no platform table. Idempotency is instead a property of the algorithm — see
 * `isAlreadySettled` below.
 */

const ArchiveExpiredAuditPartitionsSchema = z.strictObject({
  organizationId: z.uuid(),
  /** The instant retention is evaluated at. Injected so a run is reproducible and testable. */
  asOf: z.iso.datetime({ offset: true }),
  policy: AuditRetentionPolicySchema,
  archive: z.custom<AuditArchive>((value) => typeof (value as AuditArchive).archive === 'function',
    'An archive target must implement archive(page).'),
  /** The service identity the run acts as. A scheduled job has no user. */
  serviceIdentity: z.string().min(1),
  requestId: z.string().min(1),
  correlationId: z.string().min(1),
  /** Partitions examined per run, so one run cannot walk the whole history in a single transaction. */
  maxPartitions: z.number().int().min(1).max(120).default(24),
  /** Rows sent to the archive per call. A month of audit rows does not fit in memory. */
  pageSize: z.number().int().min(1).max(20_000).default(5_000),
});
export type ArchiveExpiredAuditPartitionsInput = z.input<typeof ArchiveExpiredAuditPartitionsSchema>;

export type PartitionOutcome =
  | { partition: string; outcome: 'ARCHIVED_AND_DROPPED'; rows: number; pages: number; purgeAfter: string }
  | { partition: string; outcome: 'HELD'; reason: PartitionHoldReason; detail: string };

export interface ArchiveExpiredAuditPartitionsResult {
  asOf: string;
  policy: AuditRetentionPolicy;
  outcomes: readonly PartitionOutcome[];
  archivedRows: number;
  droppedPartitions: number;
  heldPartitions: number;
  /** Partitions whose month had not closed at `asOf` and were therefore never candidates. */
  partitionsNotYetClosed: number;
}

interface PartitionRow {
  partition: string;
  periodFrom: Date;
  periodThrough: Date;
}

/**
 * `id` is the tiebreak in the keyset because a month's entries share an `occurred_at` to within
 * microseconds of each other at the projected volume; paging on the timestamp alone would skip rows.
 */
interface ArchiveRowRecord {
  id: string;
  occurred_at: Date;
  retention_class: string;
  organization_id: string;
  branch_id: string | null;
  actor_user_id: string | null;
  actor_roles: string[];
  actor_on_behalf_of: string | null;
  actor_service_identity: string | null;
  action: string;
  entity_domain: string;
  entity_type: string;
  entity_id: string;
  entity_version: number;
  changes: unknown;
  reason_code: string | null;
  request_id: string;
  correlation_id: string;
  causation_id: string | null;
  source: string;
}

const ENTRY_COLUMNS = `id, occurred_at, retention_class, organization_id, branch_id, actor_user_id,
  actor_roles, actor_on_behalf_of, actor_service_identity, action, entity_domain, entity_type,
  entity_id, entity_version, changes, reason_code, request_id, correlation_id, causation_id, source`;

/**
 * A cursor is derived from the partition and the first row of the page, so the same page always
 * produces the same object name. A retried run overwrites the same archive objects instead of writing
 * a second copy, which is what makes the external side effect idempotent without a second ledger.
 */
function pageCursor(partition: string, first: { occurredAt: string; id: string }): string {
  return `${partition}/${first.occurredAt}/${first.id}`;
}

function toArchiveEntry(row: ArchiveRowRecord): AuditArchiveEntry {
  return {
    id: row.id,
    // `toISOString` rather than the raw `Date`: the digest is taken over the value the archive will
    // store, and a lossy or re-formatted timestamp would make a faithful archive look tampered with.
    occurredAt: row.occurred_at.toISOString(),
    retentionClass: row.retention_class as AuditRetentionClass,
    organizationId: row.organization_id,
    branchId: row.branch_id,
    actorUserId: row.actor_user_id,
    actorRoles: row.actor_roles,
    actorOnBehalfOf: row.actor_on_behalf_of,
    actorServiceIdentity: row.actor_service_identity,
    action: row.action,
    entityDomain: row.entity_domain,
    entityType: row.entity_type,
    entityId: row.entity_id,
    entityVersion: row.entity_version,
    changes: row.changes,
    reasonCode: row.reason_code,
    requestId: row.request_id,
    correlationId: row.correlation_id,
    causationId: row.causation_id,
    source: row.source,
  };
}

/**
 * PostgreSQL has no catalog function that returns a partition bound as a timestamptz, only as the
 * deparsed expression text. The text is parsed with a pattern parameter rather than an inlined literal
 * so a bound format change fails as a NULL the caller can see, not as a syntax error that aborts the
 * run mid-transaction, and the result is cast to `timestamptz` in the database rather than parsed in
 * JavaScript so the session time zone cannot shift the instant.
 */
const PARTITION_BOUND_PATTERN = String.raw`FOR VALUES FROM \('([^']+)'\) TO \('([^']+)'\)`;

/**
 * The schema-qualified regclass of a partition, checked against the naming rule first.
 *
 * Two things are being defended. A bare name in a `regclass` cast resolves against `search_path`,
 * which does not contain the audit schema, so an unqualified name raises "relation does not exist"
 * for a partition that plainly does — a failure that reads like a lost table. And the name is
 * interpolated rather than bound, so it must be one this domain could have created. The catalogue
 * query above already filters on the same pattern; repeating it here means a change to that query
 * cannot widen what reaches a query against the table.
 */
const PARTITION_NAME_PATTERN = /^audit_entry_\d{4}_\d{2}$/;

function partitionRegclass(partition: string): string {
  if (!PARTITION_NAME_PATTERN.test(partition)) {
    throw new Error(`${partition} is not a monthly audit partition name.`);
  }
  return `audit.${partition}`;
}

/** Every month partition attached to the live table, oldest first. */
async function listPartitions(client: PoolClient): Promise<readonly PartitionRow[]> {
  const { rows } = await client.query<{ partition: string; period_from: Date; period_through: Date }>(
    `SELECT c.relname AS partition,
            ((regexp_match(pg_get_expr(c.relpartbound, c.oid), $1))[1])::timestamptz AS period_from,
            ((regexp_match(pg_get_expr(c.relpartbound, c.oid), $1))[2])::timestamptz AS period_through
       FROM pg_inherits i
       JOIN pg_class c ON c.oid = i.inhrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE i.inhparent = 'audit.audit_entry'::regclass
        AND n.nspname = 'audit'
        AND c.relkind = 'r'
      ORDER BY c.relname`,
    [PARTITION_BOUND_PATTERN],
  );
  return rows.map((row) => ({
    partition: row.partition,
    periodFrom: row.period_from,
    periodThrough: row.period_through,
  }));
}

/**
 * Rows inside their own class's hot window, per class.
 *
 * The cutoff differs per class, so a single global `occurred_at < cutoff` predicate would either
 * release a FINANCIAL row early or hold a BUSINESS row late. The cutoffs are passed as an array and
 * joined per class, which is the only formulation that answers "is every row in this partition past
 * ITS class period" rather than "past the shortest period".
 */
async function countRowsInsideHotWindow(
  client: PoolClient, partition: string, cutoffs: Readonly<Record<AuditRetentionClass, Date>>,
): Promise<{ total: number; inside: number; insideByClass: Record<string, number> }> {
  const { rows } = await client.query<{ retention_class: string; rows: number; inside: number }>(
    `SELECT r.retention_class,
            count(*)::int AS rows,
            count(*) FILTER (WHERE r.occurred_at >= c.cutoff)::int AS inside
       FROM audit.audit_entry r
       CROSS JOIN unnest($2::text[], $3::timestamptz[]) AS c(retention_class, cutoff)
      WHERE r.tableoid = $1::regclass
        AND r.retention_class = c.retention_class
      GROUP BY r.retention_class`,
    [partitionRegclass(partition), Object.keys(cutoffs), Object.values(cutoffs)],
  );
  const insideByClass: Record<string, number> = {};
  let total = 0;
  let inside = 0;
  for (const row of rows) {
    total += row.rows;
    inside += row.inside;
    insideByClass[row.retention_class] = row.inside;
  }
  return { total, inside, insideByClass };
}

async function readPage(
  client: PoolClient, partition: string, pageSize: number, after: { occurredAt: Date; id: string } | null,
): Promise<readonly AuditArchiveEntry[]> {
  const { rows } = await client.query<ArchiveRowRecord>(
    `SELECT ${ENTRY_COLUMNS}
       FROM audit.audit_entry
      WHERE tableoid = $1::regclass
        AND ($2::timestamptz IS NULL OR (occurred_at, id) > ($2::timestamptz, $3::uuid))
      ORDER BY occurred_at, id
      LIMIT $4`,
    after
      ? [partitionRegclass(partition), after.occurredAt.toISOString(), after.id, pageSize]
      : [partitionRegclass(partition), null, null, pageSize],
  );
  return rows.map(toArchiveEntry);
}

type RetentionRun = Omit<z.output<typeof ArchiveExpiredAuditPartitionsSchema>, 'asOf'> & { asOf: Date };

async function runRetention(
  transaction: AuditedTransaction,
  input: RetentionRun,
): Promise<ArchiveExpiredAuditPartitionsResult> {
  const { client, appendAuditEntry } = transaction;
  const periods = resolveAuditRetentionPeriods(input.policy);
  const cutoffs = Object.fromEntries(
    Object.entries(periods).map(([retentionClass, period]) =>
      [retentionClass, auditRetentionHotCutoff(input.asOf, period.hotMonths)]),
  ) as Record<AuditRetentionClass, Date>;

  const partitions = await listPartitions(client);
  const outcomes: PartitionOutcome[] = [];
  let archivedRows = 0;
  let droppedPartitions = 0;
  let heldPartitions = 0;
  let partitionsNotYetClosed = 0;

  for (const partition of partitions.slice(0, input.maxPartitions)) {
    // A month that has not closed is not a candidate, whatever it holds. Two reasons, and both are
    // load-bearing: rows can still arrive into it, and an empty month still has to exist for the
    // writes that are coming. The second reason is the one a test found — a run that released every
    // empty partition would delete the months `ensureAuditPartitions` provisioned and turn the first
    // write of the next month into `no partition of relation found for row`.
    //
    // This is the other half of "never on a clock alone": the clock decides which partitions are even
    // in scope, and only the per-row period and the archive receipt decide whether one is released.
    if (partition.periodThrough.getTime() > input.asOf.getTime()) {
      partitionsNotYetClosed += 1;
      continue;
    }

    const counted = await countRowsInsideHotWindow(client, partition.partition, cutoffs);

    // The guard runs before the archive is contacted, not after. A partition holding an in-period row
    // is not a candidate at all, so there is nothing to copy and nothing to decide: a partial archive
    // would leave the archive holding copies of rows that are still in force in the primary database,
    // which is the one state in which the two disagree about what the record is.
    if (counted.inside > 0) {
      heldPartitions += 1;
      outcomes.push({
        partition: partition.partition,
        outcome: 'HELD',
        reason: 'ROWS_INSIDE_HOT_PERIOD',
        detail: Object.entries(counted.insideByClass)
          .filter(([, rows]) => rows > 0)
          .map(([retentionClass, rows]) => `${rows} ${retentionClass}`)
          .join(', '),
      });
      continue;
    }

    const attempts: PartitionPageAttempt[] = [];
    let after: { occurredAt: Date; id: string } | null = null;
    let purgeAfter: Date | null = null;
    let unreadable = false;

    // A page is read, handed to the archive, and confirmed before the next one is read, so a run
    // never holds more than `pageSize` rows in memory. At the projected ~225,000 rows/day a single
    // month is ~6.75M rows, which is why this is paged at all.
    //
    // The loop stops on three conditions and only three: the partition is exhausted, a page could not
    // be confirmed, or the row budget is exceeded. A cursor that failed to advance shows up as the
    // third — the budget is `totalRows + pageSize`, so one extra page of overlap is tolerated and
    // anything beyond that is reported as a read failure rather than spun on.
    for (;;) {
      const sentSoFar = attempts.reduce((sent, attempt) => sent + attempt.rows, 0);
      if (sentSoFar > counted.total + input.pageSize) {
        unreadable = true;
        break;
      }
      const entries = await readPage(client, partition.partition, input.pageSize, after);
      if (entries.length === 0) break;

      const first = entries[0];
      if (first === undefined) break;
      const cursor = pageCursor(partition.partition, first);
      const pagePurgeAfter = entries.reduce((latest, entry) => {
        const candidate = auditRetentionPurgeAfter(
          new Date(entry.occurredAt), periods[entry.retentionClass].totalYears,
        );
        return latest === null || candidate > latest ? candidate : latest;
      }, null as Date | null);
      if (pagePurgeAfter !== null && (purgeAfter === null || pagePurgeAfter > purgeAfter)) {
        purgeAfter = pagePurgeAfter;
      }

      const page: AuditArchivePage = {
        partition: partition.partition,
        periodFrom: partition.periodFrom.toISOString(),
        periodThrough: partition.periodThrough.toISOString(),
        purgeAfter: (pagePurgeAfter ?? partition.periodThrough).toISOString(),
        cursor,
        entries,
      };
      let receipt: AuditArchivePageReceipt | null = null;
      try {
        receipt = await input.archive.archive(page);
      } catch {
        // A failed page is recorded as an unacknowledged attempt rather than rethrown, so the
        // partition ends up HELD with a reason an operator can act on. Throwing would roll back the
        // partitions that already archived cleanly in this run, which is a worse outcome than
        // holding one partition for the next run.
        receipt = null;
      }
      attempts.push({
        pageIndex: attempts.length + 1,
        rows: entries.length,
        expectedDigest: auditArchiveDigest(entries),
        cursor,
        receipt,
      });
      if (receipt === null) {
        unreadable = true;
        break;
      }

      const last = entries[entries.length - 1];
      if (last === undefined) break;
      after = { occurredAt: new Date(last.occurredAt), id: last.id };
    }

    if (unreadable) {
      heldPartitions += 1;
      outcomes.push({
        partition: partition.partition,
        outcome: 'HELD',
        reason: 'ARCHIVE_RECEIPT_MISMATCH',
        detail: attempts.some((attempt) => attempt.receipt === null)
          ? `Page ${attempts.length} was not acknowledged by the archive.`
          : `The partition did not read as ${counted.total} row(s); more than ${input.pageSize} were returned beyond that count.`,
      });
      continue;
    }

    const disposition = decidePartitionDisposition({
      partition: partition.partition,
      totalRows: counted.total,
      rowsInsideHotPeriod: counted.inside,
      attempts,
    });

    if (disposition.outcome === 'HOLD') {
      heldPartitions += 1;
      outcomes.push({
        partition: partition.partition,
        outcome: 'HELD',
        reason: disposition.reason,
        detail: disposition.detail,
      });
      continue;
    }

    // Re-count immediately before the DROP. A closed month is not supposed to gain rows, and if one
    // appeared anyway the archive is now out of step with the table, so the partition is held for a
    // human rather than released on the strength of a count taken before the pages were sent.
    const rowsToDrop = await client.query<{ rows: number }>(
      'SELECT count(*)::int AS rows FROM audit.audit_entry WHERE tableoid = $1::regclass',
      [partitionRegclass(partition.partition)],
    );
    const remaining = rowsToDrop.rows[0]?.rows ?? 0;
    if (remaining !== counted.total) {
      heldPartitions += 1;
      outcomes.push({
        partition: partition.partition,
        outcome: 'HELD',
        reason: 'ARCHIVE_RECEIPT_MISMATCH',
        detail: `The partition holds ${remaining} row(s) now and held ${counted.total} when it was counted.`,
      });
      continue;
    }

    // The DROP goes through `audit.drop_month_partition` rather than an interpolated statement. The
    // function quotes the identifier with format('%I') and refuses anything that is not a partition of
    // `audit.audit_entry`, so a mistake in the catalogue query above cannot reach another table.
    await client.query('SELECT audit.drop_month_partition($1)', [partition.partition]);
    droppedPartitions += 1;
    archivedRows += disposition.rows;
    outcomes.push({
      partition: partition.partition,
      outcome: 'ARCHIVED_AND_DROPPED',
      rows: disposition.rows,
      pages: disposition.pages,
      purgeAfter: (purgeAfter ?? partition.periodThrough).toISOString(),
    });
  }

  // ADR-0013 §4b: a run that changed nothing is still traced, so an operator asking why a partition
  // is still there gets an answer in the trail rather than silence.
  await appendAuditEntry({
    organizationId: input.organizationId,
    actor: { serviceIdentity: input.serviceIdentity, roles: ['SYSTEM'] },
    action: 'AUDIT_RETENTION_RUN_EXECUTED',
    entity: { domain: 'audit', type: 'RetentionRun', id: randomUUID(), version: 1 },
    changes: [
      { path: 'asOf', classification: 'INTERNAL', after: input.asOf.toISOString() },
      { path: 'hotMonths', classification: 'INTERNAL', after: String(input.policy.hotMonths) },
      { path: 'totalYears', classification: 'INTERNAL', after: String(input.policy.totalYears) },
      {
        path: 'retentionClass',
        // SEC-001 asks for the new column to be classified rather than left unexamined. The SQL
        // COMMENT and DOMAIN.md say INTERNAL in prose; this says it in the record itself, on the
        // only entry where the domain states a retention value. The run's own entry is archived under
        // the same window as every other row, so a retention decision is retained rather than
        // exempt from its own rule.
        classification: retentionClassFieldClassification,
        after: defaultAuditRetentionClass,
      },
      { path: 'partitionsDropped', classification: 'INTERNAL', after: String(droppedPartitions) },
      { path: 'partitionsHeld', classification: 'INTERNAL', after: String(heldPartitions) },
      { path: 'partitionsNotYetClosed', classification: 'INTERNAL', after: String(partitionsNotYetClosed) },
      { path: 'rowsArchived', classification: 'INTERNAL', after: String(archivedRows) },
    ],
    requestId: input.requestId,
    correlationId: input.correlationId,
    source: 'SYSTEM',
  });

  return {
    asOf: input.asOf.toISOString(),
    policy: input.policy,
    outcomes,
    archivedRows,
    droppedPartitions,
    heldPartitions,
    partitionsNotYetClosed,
  };
}

export async function archiveExpiredAuditPartitions(
  pool: Pool, rawInput: ArchiveExpiredAuditPartitionsInput,
): Promise<ArchiveExpiredAuditPartitionsResult> {
  const parsed = ArchiveExpiredAuditPartitionsSchema.safeParse(rawInput);
  if (!parsed.success) throw new Error('Audit retention run input is not valid.');
  const { asOf: asOfText, ...rest } = parsed.data;
  const asOf = new Date(asOfText);
  assertAuditRetentionPolicy(parsed.data.policy);
  // A retention run dated in the future would hold partitions that are due to be released, and could
  // archive rows the primary database is about to be asked about. It is refused rather than clamped.
  if (asOf.getTime() > Date.now() + 60_000) {
    throw new Error('A retention run cannot be evaluated at a moment in the future.');
  }
  return withAuditedTransaction(pool, (transaction) => runRetention(transaction, { ...rest, asOf }));
}
