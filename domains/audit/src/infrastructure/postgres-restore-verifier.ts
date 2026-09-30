import { randomUUID } from 'node:crypto';
import pg from 'pg';
import {
  auditArchiveDigest,
  type AuditArchiveEntry,
  type AuditArchiveReader,
  type AuditRestoreVerificationRequest,
  type AuditRestoreVerificationResult,
  type AuditRestoreVerifier,
} from '../domain/audit-archive';

/**
 * Restores an archived artifact into a throwaway database and reads it back.
 *
 * This is the implementation that makes the drop gate mean something. Everything upstream of it —
 * `archive()` returning a receipt, the page digest matching, the object row being written — is a
 * statement about what the writer believes it did. Only this says whether the rows survive a trip
 * through storage and back into a database that has never seen them.
 *
 * Three properties are checked, and the choice is deliberate:
 *
 *   Row count      catches truncation — the classic archive failure, and the one an atomic write
 *                  does not prevent if the process died between two pages.
 *   Digest         catches silent field corruption: a row that restored with a null actor, a coerced
 *                  timestamp or a reordered `changes` payload is the same count and a different record.
 *   Entity probe   catches a restore that loaded but cannot be queried the way an auditor would. An
 *                  archive that can only be read by replaying its own file is not evidence; an archive
 *                  you can run `WHERE entity_id = ...` against is.
 *
 * The scratch database is deliberately separate, and deliberately dropped in a `finally`. Verification
 * that ran against the source would prove nothing, and a verifier that leaves a copy of the audit
 * trail lying around in a second database after dropping the partition it was protecting would be a
 * new disclosure surface rather than a control.
 *
 * Note this does not go through `runCommand`/`withConnection`. It is not a business mutation: it
 * writes to a scratch database created for this verification and destroyed before the call returns,
 * outside the operational transaction, and `CREATE DATABASE` cannot run inside a transaction at all.
 * It touches no business aggregate and appends no audit entry, which is why it is exempt from
 * ADR-0013 rather than routed around it.
 */
export interface PostgresRestoreVerifierOptions {
  /**
   * A connection to the server (any database on it). Used only for CREATE/DROP DATABASE, which is why
   * it is a single Client rather than a pool: the scratch database's lifetime is strictly nested
   * inside this call, and a pooled session would let it outlive the verification that justified it.
   */
  admin: { query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }> };
  /**
   * Opens a connected client to a freshly created scratch database.
   *
   * Supplied by the caller rather than derived here. `pg.Client.connectionParameters` looks like the
   * obvious source — it has host, port, user and a password — but `password` is defined
   * non-enumerably, so spreading the object into a new client silently drops it and every connection
   * fails with a SCRAM error. That failure is at least safe (the partition is held), but it looks
   * like an archive problem rather than a configuration one. Making the caller hand over a connected
   * client also keeps the verifier independent of how the deployment authenticates.
   */
  connectToScratchDatabase: (databaseName: string) => Promise<pg.Client>;
  reader: AuditArchiveReader;
  /**
   * The SQL that builds the restore target, normally the audit domain's own migrations read from
   * disk. Injected rather than imported so that production code does not depend on a test helper, and
   * so the schema under verification is an explicit choice rather than whatever a helper defaults to.
   */
  schemaSql: string;
  /** Rows inserted per statement. Bounded so a large artifact does not build one enormous query. */
  insertBatchSize?: number;
}

export class PostgresRestoreVerifier implements AuditRestoreVerifier {
  private readonly insertBatchSize: number;

  constructor(private readonly options: PostgresRestoreVerifierOptions) {
    this.insertBatchSize = options.insertBatchSize ?? 500;
  }

  async verify(request: AuditRestoreVerificationRequest): Promise<AuditRestoreVerificationResult> {
    const scratchName = `pss_audit_restore_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    let scratch: pg.Client | null = null;

    try {
      // 1. Read the artifact back through the reader, not through anything the writer still holds.
      //    A verifier that reused the writer's in-memory rows would pass no matter how the storage
      //    behaved, which is the failure this whole gate was added to catch.
      const archived = await this.options.reader.read(request.objectUri);
      const archivedDigest = auditArchiveDigest(archived);

      // 2. The bytes must match the domain's expectation before a restore is even attempted.
      //    Restoring known-wrong data and then reporting the mismatch from the scratch database would
      //    still be correct, but it would do it expensively.
      if (archivedDigest !== request.expectedDigest) {
        return {
          status: 'FAILED',
          failureReason: `Archived digest ${archivedDigest} does not match the expected ${request.expectedDigest}.`,
          scratchDatabase: scratchName,
        };
      }
      if (archived.length !== request.expectedRows) {
        return {
          status: 'FAILED',
          failureReason: `Archived object holds ${archived.length} row(s); ${request.expectedRows} were expected.`,
          scratchDatabase: scratchName,
        };
      }

      await this.options.admin.query(`CREATE DATABASE ${quoteIdentifier(scratchName)}`);

      scratch = await this.options.connectToScratchDatabase(scratchName);
      await scratch.query(this.options.schemaSql);
      // Partitions for the archived months must exist before the rows can be loaded, and the
      // scratch database has none for them: a freshly migrated schema only creates partitions for the
      // current and forthcoming months, so restoring an archive from 2021 into it fails with "no
      // partition of relation audit_entry found for row".
      //
      // This is what only a real round trip finds. A restore written against a mock reads its rows
      // back perfectly and would have shipped a procedure that cannot restore anything older than
      // the current quarter.
      await this.provisionPartitions(scratch, request);
      await this.insert(scratch, archived);

      // 3. Read every row back out of the scratch database and compare, rather than comparing what
      //    was just inserted. This is the step that would catch a column the archive does not carry,
      //    a type that does not round-trip, or a restore that wrote to the wrong schema.
      const restoredRows = await scratch.query(ENTRY_COLUMNS_FOR_RESTORE);
      const restored = restoredRows.rows.map(toArchiveEntry);
      const restoredDigest = auditArchiveDigest(restored);

      if (restored.length !== request.expectedRows) {
        return {
          status: 'FAILED',
          restoredRowCount: restored.length,
          restoredDigest,
          scratchDatabase: scratchName,
          failureReason: `Restore loaded ${restored.length} row(s); ${request.expectedRows} were expected.`,
        };
      }
      if (restoredDigest !== request.expectedDigest) {
        return {
          status: 'FAILED',
          restoredRowCount: restored.length,
          restoredDigest,
          scratchDatabase: scratchName,
          failureReason: 'Restored rows are readable but their digest differs, so at least one field did not round-trip.',
        };
      }

      const occurredAt = restored.map((entry) => entry.occurredAt).sort();
      const restoredMin = occurredAt[0] ?? null;
      const restoredMax = occurredAt[occurredAt.length - 1] ?? null;
      if (restoredMin !== request.expectedMinOccurredAt || restoredMax !== request.expectedMaxOccurredAt) {
        return {
          status: 'FAILED',
          restoredRowCount: restored.length,
          restoredDigest,
          ...(restoredMin !== null ? { restoredMinOccurredAt: restoredMin } : {}),
          ...(restoredMax !== null ? { restoredMaxOccurredAt: restoredMax } : {}),
          scratchDatabase: scratchName,
          failureReason: `Restored occurred_at range ${restoredMin}..${restoredMax} differs from ${request.expectedMinOccurredAt}..${request.expectedMaxOccurredAt}.`,
        };
      }

      // 4. The probe. An archive that only replays its own file is not evidence; the question an
      //    auditor actually asks is "show me every action on invoice X", which is an indexed lookup
      //    against the restored table.
      const probe = await scratch.query(
        'SELECT count(*)::int AS hits FROM audit.audit_entry WHERE entity_id = $1 AND request_id = $2',
        [archived[0]?.entityId ?? null, archived[0]?.requestId ?? null],
      );
      const hits = (probe.rows[0] as { hits: number } | undefined)?.hits ?? 0;
      if (hits < 1) {
        return {
          status: 'FAILED',
          restoredRowCount: restored.length,
          restoredDigest,
          scratchDatabase: scratchName,
          failureReason: 'The restored table loaded, but a row could not be found by entity_id and request_id.',
        };
      }

      return {
        status: 'VERIFIED',
        restoredRowCount: restored.length,
        restoredDigest,
        ...(restoredMin !== null ? { restoredMinOccurredAt: restoredMin } : {}),
        ...(restoredMax !== null ? { restoredMaxOccurredAt: restoredMax } : {}),
        entityProbe: `${hits} row(s) found by entity_id + request_id`,
        scratchDatabase: scratchName,
      };
    } catch (cause) {
      // Anything thrown here is a failed verification, not a failed run. The caller turns this into a
      // HELD partition, so a verifier that cannot even reach storage cannot delete anything.
      return { status: 'FAILED', failureReason: describe(cause) };
    } finally {
      // The scratch database is destroyed even when verification succeeded, and even when it threw.
      // Leaving it would mean every run kept a full copy of aged audit rows in a second database
      // that nothing manages or purges.
      if (scratch) await scratch.end().catch(() => undefined);
      await this.options.admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(scratchName)}`).catch(() => undefined);
    }
  }

  /**
   * Create a monthly partition per month the artifact covers.
   *
   * Written as a DO block rather than interpolated DDL because the identifiers are checked against a
   * strict pattern first: the partition name is derived from a month, and a name that does not match
   * is refused rather than quoted. Belt and braces, because this is the one place the verifier
   * composes DDL, and a restore that can be talked into creating an arbitrary table by a crafted
   * archive file would be worse than one that cannot restore.
   */
  private async provisionPartitions(client: pg.Client, request: AuditRestoreVerificationRequest): Promise<void> {
    const months = monthsBetween(request.periodFrom, request.periodThrough);
    if (months.length === 0) return;
    for (const month of months) {
      if (!MONTH_PATTERN.test(month)) {
        throw new Error(`Refusing to create a partition for ${month}: not a YYYY-MM month.`);
      }
      const next = addMonth(month);
      await client.query(
        `DO $do$ BEGIN
           IF to_regclass('audit.audit_entry_${month.replace('-', '_')}') IS NULL THEN
             EXECUTE format(
               'CREATE TABLE audit.audit_entry_${month.replace('-', '_')} PARTITION OF audit.audit_entry FOR VALUES FROM (%L) TO (%L)',
               '${month}-01 00:00:00+00', '${next}-01 00:00:00+00');
           END IF;
         END $do$`,
      );
    }
  }

  private async insert(client: pg.Client, entries: readonly AuditArchiveEntry[]): Promise<void> {
    for (let offset = 0; offset < entries.length; offset += this.insertBatchSize) {
      const batch = entries.slice(offset, offset + this.insertBatchSize);
      const values: unknown[] = [];
      const tuples = batch.map((entry, index) => {
        const at = (field: number): string => `$${index * 20 + field}`;
        values.push(
          entry.id, entry.occurredAt, entry.retentionClass, entry.organizationId, entry.branchId,
          entry.actorUserId, entry.actorRoles, entry.actorOnBehalfOf, entry.actorServiceIdentity,
          entry.action, entry.entityDomain, entry.entityType, entry.entityId, entry.entityVersion,
          JSON.stringify(entry.changes), entry.reasonCode, entry.requestId, entry.correlationId,
          entry.causationId, entry.source,
        );
        return `(${Array.from({ length: 20 }, (_, field) => at(field + 1)).join(',')})`;
      });
      await client.query(
        `INSERT INTO audit.audit_entry (id, occurred_at, retention_class, organization_id, branch_id,
           actor_user_id, actor_roles, actor_on_behalf_of, actor_service_identity, action,
           entity_domain, entity_type, entity_id, entity_version, changes, reason_code, request_id,
           correlation_id, causation_id, source) VALUES ${tuples.join(',')}`,
        values,
      );
    }
  }
}

const ENTRY_COLUMNS_FOR_RESTORE = `SELECT id, occurred_at, retention_class, organization_id, branch_id,
  actor_user_id, actor_roles, actor_on_behalf_of, actor_service_identity, action, entity_domain,
  entity_type, entity_id, entity_version, changes, reason_code, request_id, correlation_id,
  causation_id, source FROM audit.audit_entry ORDER BY occurred_at, id`;

function toArchiveEntry(row: Record<string, unknown>): AuditArchiveEntry {
  return {
    id: row.id as string,
    occurredAt: (row.occurred_at as Date).toISOString(),
    retentionClass: row.retention_class as AuditArchiveEntry['retentionClass'],
    organizationId: row.organization_id as string,
    branchId: row.branch_id as string | null,
    actorUserId: row.actor_user_id as string | null,
    actorRoles: row.actor_roles as string[],
    actorOnBehalfOf: row.actor_on_behalf_of as string | null,
    actorServiceIdentity: row.actor_service_identity as string | null,
    action: row.action as string,
    entityDomain: row.entity_domain as string,
    entityType: row.entity_type as string,
    entityId: row.entity_id as string,
    entityVersion: row.entity_version as number,
    changes: row.changes,
    reasonCode: row.reason_code as string | null,
    requestId: row.request_id as string,
    correlationId: row.correlation_id as string,
    causationId: row.causation_id as string | null,
    source: row.source as string,
  };
}

const MONTH_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])$/;

/** Months covering [from, through), derived from the period rather than from the rows. */
function monthsBetween(from: string, through: string): string[] {
  const months: string[] = [];
  let cursor = from.slice(0, 7);
  const last = through.slice(0, 7);
  while (cursor <= last && months.length < 240) {
    months.push(cursor);
    cursor = addMonth(cursor);
  }
  return months;
}

function addMonth(month: string): string {
  const [year, monthOfYear] = month.split('-').map(Number);
  const date = new Date(Date.UTC(year ?? 1970, monthOfYear ?? 1, 1));
  date.setUTCMonth(date.getUTCMonth() + 1);
  return date.toISOString().slice(0, 7);
}

/** The database name is generated here and never user-supplied; quoted anyway. */
function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function describe(cause: unknown): string {
  return cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
}
