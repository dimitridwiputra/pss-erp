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
  /**
   * Where the client actually put the bytes.
   *
   * Reported by the client rather than composed by the caller, because only the client knows where
   * it wrote them. The use case used to build a `audit://partition/cursor` string itself, which is a
   * fiction: nothing could resolve it, so the recorded URI described a location that did not exist
   * and the restore had no way to read the artifact back. A real client must be able to name its own
   * object, and the receipt is the only place that name can come from.
   */
  objectUri: string;
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
 * Reading an artifact back, which is the other half of the archive contract.
 *
 * `AuditArchive` is write-only by design — a client that cannot read its own objects cannot be
 * verified, and an unverifiable archive cannot gate a partition drop. Keeping the read side as a
 * separate interface means the restore verifier depends on the ability to retrieve an artifact, not
 * on the write path that produced it, so a restore genuinely exercises storage rather than replaying
 * whatever the writer still has in memory.
 */
export interface AuditArchiveReader {
  /** Resolve an `objectUri` from a receipt back to the rows it was written from. */
  read(objectUri: string): Promise<readonly AuditArchiveEntry[]>;
}

/**
 * Restore verification, and the gate it exists to enforce.
 *
 * `audit.audit_entry` is append-only and its UPDATE/DELETE are refused by trigger, so a partition
 * DROP is the only way a row leaves the hot table. The archive is therefore the only other copy, and
 * "the archive call returned success" is not evidence that the bytes are readable — it is evidence
 * that a client accepted a request. A client that silently discards its input still returns a
 * receipt, and the receipt is what the drop was previously gated on.
 *
 * So a partition may only be dropped after the artifact has been restored into an isolated database
 * and read back. This interface is the seam for that, shaped like `AuditArchive` above: one narrow
 * method, no credentials, no knowledge of a cloud provider, so the rule that a drop requires a
 * verified restore is testable without a storage account or a second database.
 */
export interface AuditRestoreVerifier {
  /**
   * Restore the artifact into an isolated database and check it. Implementations must NOT touch the
   * source partition; the point is to prove the archive is independently readable.
   */
  verify(request: AuditRestoreVerificationRequest): Promise<AuditRestoreVerificationResult>;
}

export interface AuditRestoreVerificationRequest {
  partition: string;
  objectUri: string;
  /** The digest the domain computed, which a restore must reproduce. */
  expectedDigest: string;
  expectedRows: number;
  expectedMinOccurredAt: string;
  expectedMaxOccurredAt: string;
  periodFrom: string;
  periodThrough: string;
  serviceIdentity: string;
  correlationId: string;
}

export interface AuditRestoreVerificationResult {
  status: 'VERIFIED' | 'FAILED';
  /** Present only when VERIFIED: a claim with no evidence must not satisfy the gate. */
  restoredRowCount?: number;
  restoredDigest?: string;
  restoredMinOccurredAt?: string;
  restoredMaxOccurredAt?: string;
  /** A representative read, so "it loaded" is not mistaken for "an auditor could find a row in it". */
  entityProbe?: string;
  scratchDatabase?: string;
  failureReason?: string;
}

/**
 * True only when the verification both succeeded and carries the evidence it claims.
 *
 * A verifier returning `{ status: 'VERIFIED' }` with nothing else is treated as a failure, not as a
 * pass. Otherwise a stub, a crash mid-verification, or a future implementation that forgets a field
 * would silently unlock partition deletion.
 */
export function isRestoreVerified(result: AuditRestoreVerificationResult): boolean {
  return result.status === 'VERIFIED'
    && typeof result.restoredRowCount === 'number'
    && typeof result.restoredDigest === 'string' && result.restoredDigest.length > 0
    && typeof result.restoredMinOccurredAt === 'string'
    && typeof result.restoredMaxOccurredAt === 'string';
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
