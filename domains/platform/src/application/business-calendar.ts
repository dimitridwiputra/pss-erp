import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { DomainError } from '@pss/contracts';

/** §11: timestamps are stored UTC; a working-day SLA is read in the Indonesian business zone. */
export const BUSINESS_TIME_ZONE = 'Asia/Jakarta';

const NonWorkingDatesSchema = z.array(z.iso.date());

export type NonWorkingDates = z.output<typeof NonWorkingDatesSchema>;

/**
 * DQ-001.BR03 with `platform.business_calendar`: the due date is the same wall-clock time a
 * number of working days later. DQ-001.AC02 fixes the arithmetic: one working day from Friday
 * 16.00 is Monday 16.00, not Saturday 16.00. Appendix N section 68 registers the empty
 * calendar as Monday to Friday with no holidays, so an empty table is a valid calendar, not
 * a missing one.
 *
 * The walk runs in SQL so it uses PostgreSQL's own Asia/Jakarta zone handling instead of a
 * hand-rolled UTC offset.
 */
export async function addWorkingDays(
  client: PoolClient | Pool,
  from: Date,
  workingDays: number,
  nonWorkingDates: NonWorkingDates,
): Promise<Date> {
  if (!Number.isInteger(workingDays) || workingDays < 1) {
    throw new Error('A working-day SLA must be a positive whole number of days.');
  }
  const dates = NonWorkingDatesSchema.parse([...new Set(nonWorkingDates)]);
  const { rows } = await client.query<{ due_at: Date }>(
    `WITH RECURSIVE walk(remaining, local_moment) AS (
       SELECT $2::int, ($1::timestamptz AT TIME ZONE $3::text)
       UNION ALL
       SELECT remaining
              - (CASE WHEN extract(isodow FROM local_moment + interval '1 day') BETWEEN 1 AND 5
                        AND NOT ((local_moment + interval '1 day')::date) = ANY ($4::date[])
                       THEN 1 ELSE 0 END),
              local_moment + interval '1 day'
       FROM walk
       WHERE remaining > 0
     )
     SELECT (local_moment AT TIME ZONE $3::text) AS due_at
     FROM walk WHERE remaining <= 0 LIMIT 1`,
    [from, workingDays, BUSINESS_TIME_ZONE, dates],
  );
  const due = rows[0]?.due_at;
  if (!due) throw new Error('The working-day SLA could not be resolved.');
  return due;
}

/**
 * The effective non-working dates for a branch, most specific scope first. A branch row
 * overrides an organization row, which overrides a national row.
 */
export async function loadNonWorkingDates(
  client: PoolClient | Pool,
  scope: { organizationId: string; branchId?: string; from: string; to: string },
): Promise<NonWorkingDates> {
  const { rows } = await client.query<{ calendar_date: string }>(
    `SELECT to_char(d.calendar_date, 'YYYY-MM-DD') AS calendar_date
     FROM platform.business_calendar_day d
     WHERE d.is_working = false
       AND d.calendar_date BETWEEN $3::date AND $4::date
       AND (d.organization_id IS NULL OR d.organization_id = $1::uuid)
       AND (d.branch_id IS NULL OR d.branch_id IS NOT DISTINCT FROM $2::uuid)
     ORDER BY d.calendar_date`,
    [scope.organizationId, scope.branchId ?? null, scope.from, scope.to],
  );
  return NonWorkingDatesSchema.parse(rows.map((row) => row.calendar_date));
}

/** A calendar far enough ahead to cover any SLA this registry holds. */
export function calendarHorizon(businessDate: string, days = 400): { from: string; to: string } {
  return { from: businessDate, to: new Date(Date.parse(`${businessDate}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10) };
}

export function assertBusinessDate(value: string): string {
  if (!z.iso.date().safeParse(value).success) throw new DomainError('VALIDATION_FAILED');
  return value;
}
