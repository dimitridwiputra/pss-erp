import type { PoolClient } from 'pg';

/**
 * The business date a movement belongs to, taken from the caller when it knows one and from the
 * database clock when it does not.
 *
 * Asia/Jakarta, not UTC and not the application host's locale: AGENTS.md §11.1 stores timestamps in
 * UTC and interprets the business date in Asia/Jakarta, and a receipt that lands at 23:30 WIB on the
 * 30th belongs to the 30th. Reading the clock from the database rather than from `new Date()` in Node
 * keeps the date consistent with the `created_at` the same statement writes, so a movement and its
 * event cannot disagree about which day they are on.
 *
 * A caller that is replaying a dated document — an import, a backdated receipt — must pass its own
 * date: resolving from the clock would silently restate the document's date as today.
 */
export async function resolveBusinessDate(tx: PoolClient, supplied: string | undefined): Promise<string> {
  if (supplied !== undefined) return supplied;
  const result = await tx.query<{ business_date: string }>(
    `SELECT to_char(now() AT TIME ZONE 'Asia/Jakarta', 'YYYY-MM-DD') AS business_date`,
  );
  const resolved = result.rows[0]?.business_date;
  if (!resolved) throw new Error('Could not resolve the current business date.');
  return resolved;
}
