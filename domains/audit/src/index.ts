export { withAuditedTransaction, runAuditedWork } from './application/append-audit-entry';
export type { AuditedTransaction } from './application/append-audit-entry';
export { AuditEntryInputSchema, type AuditEntryInput } from './domain/audit-entry';
export { redactAuditChanges } from './domain/rules/redact-audit-changes';
export {
  archiveExpiredAuditPartitions,
  type ArchiveExpiredAuditPartitionsInput,
  type ArchiveExpiredAuditPartitionsResult,
  type PartitionOutcome,
} from './application/archive-expired-audit-partitions';
export {
  ensureAuditPartitions,
  type EnsureAuditPartitionsInput,
  type EnsureAuditPartitionsResult,
} from './application/ensure-audit-partitions';
export {
  auditRetentionClasses,
  defaultAuditRetentionClass,
  retentionClassFieldClassification,
  AuditRetentionPolicySchema,
  defaultAuditRetentionPolicy,
  resolveAuditRetentionPeriods,
  assertAuditRetentionPolicy,
  auditRetentionHotCutoff,
  resolveAuditArchiveRetention, isArchivePurgeEligible,
  type AuditRetentionClass,
  type AuditRetentionPeriod,
  type AuditRetentionPolicy,
  type AuditArchiveRetention,
} from './domain/retention-policy';
export {
  auditArchiveDigest, isRestoreVerified,
  type AuditArchive,
  type AuditArchiveReader,
  type AuditArchiveEntry,
  type AuditArchivePage,
  type AuditArchivePageReceipt,
  type AuditRestoreVerifier,
  type AuditRestoreVerificationRequest,
  type AuditRestoreVerificationResult,
} from './domain/audit-archive';
export { FileAuditArchive } from './infrastructure/file-audit-archive';
export { PostgresRestoreVerifier, type PostgresRestoreVerifierOptions } from './infrastructure/postgres-restore-verifier';
export {
  decidePartitionDisposition,
  type PartitionDisposition,
  type PartitionDispositionInput,
  type PartitionHoldReason,
  type PartitionPageAttempt,
} from './domain/rules/partition-retention-decision';
