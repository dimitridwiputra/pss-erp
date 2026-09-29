import type { Pool } from 'pg';
import { DomainError } from '@pss/contracts';
import { EVENTS_ARCHIVE_DAYS } from '@pss/platform';

/**
 * PLT-005.R05: a receipt may only go once the event it proves is no longer replayable, so the
 * inbox floor is the event archive window. Reporting owns this table, so Reporting prunes it;
 * Platform only owns the policy value it must not go below.
 */
export async function deleteExpiredInboxReceipts(
  pool: Pool, retentionDays: number = EVENTS_ARCHIVE_DAYS,
): Promise<number> {
  if (!Number.isInteger(retentionDays) || retentionDays < EVENTS_ARCHIVE_DAYS) {
    throw new DomainError('VALIDATION_FAILED');
  }
  return pool.query(
    `DELETE FROM reporting.inbox_event
     WHERE processed_at < now() - make_interval(days => $1)`, [retentionDays],
  ).then((result) => result.rowCount ?? 0);
}
