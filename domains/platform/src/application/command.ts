import { runAuditedWork, withAuditedTransaction, type AuditedTransaction } from '@pss/audit';
import type { Pool, PoolClient } from 'pg';
import { withIdempotentCommand, type CommandKey, type CommandResponse } from './idempotency';

/**
 * The single audited-transaction primitive for every write path (AGENTS.md §4, §14, §18).
 *
 * This function used to be copied into each domain as `application/support/with-connection.ts`.
 * Three near-identical copies had already drifted apart in their comments by the time this was
 * hoisted, and twelve domains still have no files at all. The concern is solved here, once;
 * `scripts/check-command-fitness.mjs` fails a build that reintroduces a second copy.
 *
 * When `client` is already open — a caller such as `domains/pos` sharing one transaction across
 * several domain calls during checkout — reuse it via `runAuditedWork` so a second `BEGIN` is
 * never nested. Otherwise open a new transaction the same way `withAuditedTransaction` does
 * (`pool.connect()` + `BEGIN`/`COMMIT`/`ROLLBACK`).
 *
 * Only use this for commands that unconditionally mutate and audit when they do not throw first.
 * A command with a legitimate no-mutation no-op path (see `releaseReservation`) must manage its
 * transaction directly, because `runAuditedWork` rejects a callback that never audits — that
 * rejection is the guarantee, not an obstacle to route around.
 */
export async function withConnection<T>(
  pool: Pool,
  client: PoolClient | undefined,
  work: (transaction: AuditedTransaction) => Promise<T>,
): Promise<T> {
  if (client) return runAuditedWork(client, work);
  return withAuditedTransaction(pool, work);
}

/**
 * The only supported way to execute a mutation that a client can retry.
 *
 * One commit contains the idempotency row, the audited mutation, and any outbox event the command
 * appends, so a retry either replays the stored response or executes exactly once. There is no
 * injection point for the transaction runner: `withIdempotentCommand` accepted one, and all four
 * call sites passed a pass-through, which meant the audit guarantee was a convention rather than a
 * constraint. Here the audited runner is not selectable, so a mutation cannot commit without an
 * audit entry (AGENTS.md §14) and a retry cannot double-apply (AGENTS.md §3.6).
 *
 * `execute` receives the audited transaction. It must append at least one audit entry through
 * `transaction.appendAuditEntry` on every success path.
 */
export async function runCommand(
  pool: Pool,
  key: CommandKey,
  execute: (transaction: AuditedTransaction) => Promise<CommandResponse>,
): Promise<CommandResponse & { replayed: boolean }> {
  return withIdempotentCommand(
    pool,
    key,
    (client, work) => runAuditedWork(client, work),
    execute,
  );
}

/**
 * For the narrow class of commands whose effect legitimately cannot share the caller's
 * transaction, so the audit guard would fire on a command that is in fact audited.
 *
 * Two shapes qualify, and both must say which in `reason`:
 *
 *   1. A batch that must stay independent per item. `syncOfflineConfirmations` runs each queued
 *      confirmation through `confirmPickTask`/`putawayStock` in its own transaction, so one
 *      rejected scan surfaces as `NEEDS_REVIEW` instead of rolling back the device's whole queue.
 *      Every applied item is audited there, with `source: 'OFFLINE'`.
 *   2. Operational presence rather than a business mutation. `heartbeatOperatorSession` records
 *      that an operator is still on a task; no aggregate's state changed.
 *
 * A single business mutation has no reason to be here — that is what `runCommand` is for, and it
 * refuses to commit without an audit entry. `reason` is mandatory, and every use is reported by
 * `scripts/check-command-fitness.mjs`, so this stays a short enumerable list rather than the
 * silent exception the WMS commands previously had.
 */
export async function runCommandWithoutAudit(
  pool: Pool,
  key: CommandKey,
  execute: () => Promise<CommandResponse>,
  reason: string,
): Promise<CommandResponse & { replayed: boolean }> {
  if (reason.trim().length < 20) {
    throw new Error('An unaudited command must state why its effect cannot share the caller transaction.');
  }
  return withIdempotentCommand(
    pool,
    key,
    (client, work) => work(client),
    execute,
  );
}
