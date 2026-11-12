import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { withAuditedTransaction } from './append-audit-entry';

/**
 * Creating next month's audit partition, on a schedule, before the first write of that month.
 *
 * This exists because `0003_audit_entry_partitioning_prereq.sql` deliberately attached no DEFAULT
 * partition, and that decision has a consequence: with no DEFAULT, a write into a month that has no
 * partition raises `no partition of relation "audit.audit_entry" found for row`. That is the correct
 * failure — a silent catch-all is how audit entries go missing — but it means the partition set has to
 * be extended ahead of time or the system stops accepting audit entries at midnight on the first of a
 * month. Manual monthly DDL is a convention, and conventions fail on the day nobody remembers them.
 *
 * It is a mutation and it is audited like one. The audit entry records how many partitions were
 * created rather than only that the job ran, so a partition set that is silently not advancing is
 * visible in the trail before it becomes a write failure.
 *
 * The whole call is one transaction, so the entry recording the created partitions and the partitions
 * themselves commit together. A crash between them would otherwise leave a trail claiming partitions
 * that do not exist, which is the kind of false record §3.7 exists to prevent.
 */

const EnsureAuditPartitionsSchema = z.strictObject({
  organizationId: z.uuid(),
  serviceIdentity: z.string().min(1),
  requestId: z.string().min(1),
  correlationId: z.string().min(1),
  /**
   * How many months ahead to provision, counted from the current month inclusive. One month is the
   * minimum that works: a run on the last day of a month with a horizon of 1 covers that month only,
   * which is the month already open, so the next run must happen before the month turns.
   */
  monthsAhead: z.number().int().min(1).max(24).default(2),
});
export type EnsureAuditPartitionsInput = z.input<typeof EnsureAuditPartitionsSchema>;

export interface EnsureAuditPartitionsResult {
  created: number;
  throughMonth: string;
}

/**
 * Months are read from the DATABASE clock rather than the Node one. AGENTS.md §11.1 puts timestamps
 * in UTC and the business date in Asia/Jakarta, and a partitioned table's month edges follow the
 * server's zone; a container's wall clock drifting from the database's would provision the wrong
 * months and the failure would appear as a write failure a month later.
 */
async function currentMonth(client: PoolClient): Promise<string> {
  const { rows } = await client.query(`SELECT to_char(date_trunc('month', now() AT TIME ZONE 'UTC'), 'YYYY-MM') AS month`);
  const month = rows[0]?.month;
  if (month === undefined) throw new Error('The database did not return a current month.');
  return month;
}

function addMonths(month: string, count: number): string {
  const [year, monthOfYear] = month.split('-').map(Number);
  if (year === undefined || monthOfYear === undefined) throw new Error(`Month ${month} is not YYYY-MM.`);
  const zeroBased = year * 12 + (monthOfYear - 1) + count;
  return `${Math.floor(zeroBased / 12)}-${String((zeroBased % 12) + 1).padStart(2, '0')}`;
}

export async function ensureAuditPartitions(
  pool: Pool, rawInput: EnsureAuditPartitionsInput,
): Promise<EnsureAuditPartitionsResult> {
  const parsed = EnsureAuditPartitionsSchema.safeParse(rawInput);
  if (!parsed.success) throw new Error('Audit partition provisioning input is not valid.');
  const input = parsed.data;

  return withAuditedTransaction(pool, async ({ client, appendAuditEntry }) => {
    const fromMonth = await currentMonth(client);
    const throughMonth = addMonths(fromMonth, input.monthsAhead - 1);
    const { rows } = await client.query<{ created: number }>(
      `SELECT audit.ensure_month_partitions(
         'audit.audit_entry'::regclass, $1::date, $2::date
       ) AS created`,
      [`${fromMonth}-01`, `${throughMonth}-01`],
    );
    const created = rows[0]?.created ?? 0;
    await appendAuditEntry({
      organizationId: input.organizationId,
      actor: { serviceIdentity: input.serviceIdentity, roles: ['SYSTEM'] },
      action: 'AUDIT_PARTITIONS_PROVISIONED',
      entity: { domain: 'audit', type: 'PartitionSet', id: randomUUID(), version: 1 },
      changes: [
        { path: 'fromMonth', classification: 'INTERNAL', after: fromMonth },
        { path: 'throughMonth', classification: 'INTERNAL', after: throughMonth },
        // Recorded even at zero: a run that created nothing is the evidence that the partition set is
        // already ahead, which is the question an operator is actually asking.
        { path: 'created', classification: 'INTERNAL', after: String(created) },
      ],
      requestId: input.requestId,
      correlationId: input.correlationId,
      source: 'SYSTEM',
    });
    return { created, throughMonth };
  });
}
