import type { Pool, PoolClient } from 'pg';
import { runAuditedWork, withAuditedTransaction, type AuditedTransaction } from '@pss/audit';

/**
 * Runs `work` inside an audited transaction that always ends with at least one audit entry.
 *
 * When `client` is already open (a caller such as domains/pos sharing one transaction across
 * several domain calls during checkout), reuse it via `runAuditedWork` so a second `BEGIN` is
 * never nested. Otherwise open a new transaction the same way `withAuditedTransaction` does
 * (`pool.connect()` + `BEGIN`/`COMMIT`/`ROLLBACK`).
 *
 * Only use this for commands that unconditionally mutate + audit when they do not throw first.
 * A command with a legitimate no-mutation no-op path (see `releaseReservation`) must manage its
 * transaction directly instead, since `runAuditedWork` rejects a callback that never audits.
 */
export async function withConnection<T>(
  pool: Pool,
  client: PoolClient | undefined,
  work: (transaction: AuditedTransaction) => Promise<T>,
): Promise<T> {
  if (client) return runAuditedWork(client, work);
  return withAuditedTransaction(pool, work);
}
