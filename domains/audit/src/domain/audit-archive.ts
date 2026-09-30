import { createHash } from 'node:crypto';
import type { AuditArchiveRetention, AuditRetentionClass } from './retention-policy';

/**
 * Cold archive for audit entries that have passed their hot window (OD-19).
 *
 * The interface is deliberately shaped like `EventTransport` in `domains/platform/src/application/outbox.ts`:
 * one narrow method, no SDK, no credentials, and no knowledge of S3 or GCS. The retention rule that
 * decides whether a partition may be dropped is in the domain and is testable without a cloud account;
 * only the bytes go somewhere else. A real client is supplied later and this file does not change.
 */

/** The audit columns an archive must preserve verbatim. `changes` is already redacted at append time. */
export interface AuditArchiveEntry {
  id: string;
  occurredAt: string;
  retentionClass: AuditRetentionClass;
  organizationId: string;
  branchId: string | null;
  actorUserId: string | null;
  actorRoles: readonly string[];
  actorOnBehalfOf: string | null;
  actorServiceIdentity: string | null;
  action: string;
  entityDomain: string;
  entityType: string;
  entityId: string;
  entityVersion: number;
  changes: unknown;
  reasonCode: string | null;
  requestId: string;
  correlationId: string;
  causationId: string | null;
  source: string;
}

/**
 * One bounded page of a partition. A month of `audit.audit_entry` is ~6.75M rows at the projected
 * volume, so the archive is fed pages rather than a whole partition; a client that tried to hold a
 * partition in memory would fail the first month it ran.
 *
 * `cursor` is derived from the partition and the page's first key, so a retry after a crash writes the
 * same object name. Re-archiving is therefore idempotent (AGENTS.md §3.6) without a second ledger.
 */
export interface AuditArchivePage {
  partition: string;
  /** Inclusive start of the partition's month, ISO 8601 UTC. */
  periodFrom: string;
  /** Exclusive end of the partition's month, ISO 8601 UTC. */
  periodThrough: string;
  /**
   * How long this artifact must be kept, and whether it may be destroyed at all.
   *
   * Deliberately a union rather than a date. The earlier shape returned a `purgeAfter` string for
   * every page, which asserted that every archive is eventually destroyed and left `KOSONG`
   * retention with no way to say "never" — while the owner's decision is that an unset
   * `audit.retention_years` means the archived object is kept indefinitely.
   */
  retention: AuditArchiveRetention;
  cursor: string;
  entries: readonly AuditArchiveEntry[];
}

export interface AuditArchivePageReceipt {
  partition: string;
  cursor: string;
  /** Row count the archive says it stored. Must equal the page it was handed. */
  rows: number;
  /** Content digest the archive computed. Must equal the digest the domain computed. */
  digest: string;
  archivedAt: string;
}

export interface AuditArchive {
  archive(page: AuditArchivePage): Promise<AuditArchivePageReceipt>;
}

/**
 * Digest over exactly the fields an archive must preserve, in a fixed order.
 *
 * Object key order in a JSON body is not stable across languages and drivers, so the digest is taken
 * over an array of positional values instead of over the objects. Two implementations that store the
 * same rows therefore agree, which is the only property that makes the receipt check meaningful.
 */
export function auditArchiveDigest(entries: readonly AuditArchiveEntry[]): string {
  const ordered = [...entries].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const canonical = ordered.map((entry) => [
    entry.id, entry.occurredAt, entry.retentionClass, entry.organizationId, entry.branchId,
    entry.actorUserId, entry.actorRoles, entry.actorOnBehalfOf, entry.actorServiceIdentity,
    entry.action, entry.entityDomain, entry.entityType, entry.entityId, entry.entityVersion,
    entry.changes, entry.reasonCode, entry.requestId, entry.correlationId, entry.causationId, entry.source,
  ]);
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
