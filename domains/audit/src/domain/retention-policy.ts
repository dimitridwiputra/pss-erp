import { z } from 'zod';

/**
 * OD-19 audit retention: 10 years total, 24 months hot in the primary database.
 *
 * The obligation and the split are configuration, never schema, because `infrastructure/terraform/README.md`
 * projects `audit.audit_entry` at ~225,000 rows/day (~82.1M/year at ~700 B/row, ~57.5 GB/year).
 * Hot for 24 months is ~115 GB; a flat 10 years would be ~575 GB of the largest table in the system for
 * records almost nobody reads. Rows past the hot window move to cold archive storage; the 10-year
 * obligation is met by the archive, so nothing is destroyed at the 24-month line.
 *
 * WHAT IS NOT DECIDED: the per-class periods. `docs/decisions/2026-09-30-open-decision-proposals.md`
 * proposed 10y/7y/3y/180d for FINANCIAL/BUSINESS/SECURITY/RAW_LANDING and the owner answered only
 * the hot/total split, leaving "retention class periods = ______" blank. The accepted decision does
 * establish that a class exists ("every row in it is past the period for its class"), so the
 * vocabulary is here, but the default deliberately applies OD-19's 24/10 to every class instead of
 * inventing four numbers nobody approved. `classPeriods` is the seam where the later decision lands
 * as a configuration write, with no migration.
 */

export const auditRetentionClasses = ['FINANCIAL', 'BUSINESS', 'SECURITY', 'RAW_LANDING'] as const;
export type AuditRetentionClass = (typeof auditRetentionClasses)[number];

/**
 * A caller that does not declare a class gets this one. BUSINESS is the middle of the proposed
 * table rather than the shortest or the longest, so a caller that forgets to classify over-retains
 * rather than silently destroying a record.
 */
export const defaultAuditRetentionClass: AuditRetentionClass = 'BUSINESS';

/**
 * SEC-001 classification for the `retention_class` field. A retention class is an internal policy
 * label: it reveals nothing about a person and must not be masked away in an export or a log line.
 * `INTERNAL` rather than `CONFIDENTIAL` because the obligation it encodes is published policy, not a
 * commercial secret, and the value is safe to show an operator diagnosing a partition that was held.
 */
export const retentionClassFieldClassification = 'INTERNAL' as const;

const AuditRetentionPeriodSchema = z.strictObject({
  hotMonths: z.number().int().min(1).max(120),
  totalYears: z.number().int().min(1).max(25),
});
export type AuditRetentionPeriod = z.output<typeof AuditRetentionPeriodSchema>;

/**
 * The whole retention policy is one validated object so that a period can be changed by writing a
 * configuration value rather than by a migration (OD-19). The schema is `strict` on purpose: an
 * unrecognised key is a typo in a policy change and must fail loudly rather than be ignored.
 */
export const AuditRetentionPolicySchema = z.strictObject({
  /** Months a row stays in the primary database before it is archived. OD-19 accepted 24. */
  hotMonths: z.number().int().min(1).max(120),
  /** Years the record must survive somewhere, archive included. OD-19 accepted 10. */
  totalYears: z.number().int().min(1).max(25),
  /**
   * Per-class overrides. Empty means every class uses the two numbers above.
   *
   * `partialRecord` rather than `record`: zod 4's `record` with an enum key requires EVERY key to be
   * present, which would make a one-class override a validation error. An unrecognised class name is
   * still rejected, so a typo in a policy write fails loudly.
   */
  classPeriods: z.partialRecord(z.enum(auditRetentionClasses), AuditRetentionPeriodSchema).default({}),
});
export type AuditRetentionPolicy = z.output<typeof AuditRetentionPolicySchema>;

/** OD-19 as accepted: 24 months hot, 10 years total, for every class until a decision says otherwise. */
export const defaultAuditRetentionPolicy: AuditRetentionPolicy = AuditRetentionPolicySchema.parse({
  hotMonths: 24,
  totalYears: 10,
  classPeriods: {},
});

/**
 * The period that actually applies to a class. An unconfigured class inherits the policy numbers, so
 * a class never ends up with an undefined period and a row is never evaluated against a missing rule.
 */
export function resolveAuditRetentionPeriods(
  policy: AuditRetentionPolicy,
): Readonly<Record<AuditRetentionClass, AuditRetentionPeriod>> {
  const periods = {} as Record<AuditRetentionClass, AuditRetentionPeriod>;
  for (const retentionClass of auditRetentionClasses) {
    periods[retentionClass] = policy.classPeriods[retentionClass]
      ?? { hotMonths: policy.hotMonths, totalYears: policy.totalYears };
  }
  return periods;
}

/**
 * A class whose hot window outlives its total obligation is refused at load time, not at drop time.
 * The archive would be eligible for deletion while the row was still inside its hot window, which is
 * exactly the "archived" state the owner requires the drop to be impossible from.
 */
export function assertAuditRetentionPolicy(policy: AuditRetentionPolicy): void {
  const periods = resolveAuditRetentionPeriods(policy);
  for (const retentionClass of auditRetentionClasses) {
    const period = periods[retentionClass];
    if (period.hotMonths > period.totalYears * 12) {
      throw new Error(
        `Retention class ${retentionClass} keeps rows hot for ${period.hotMonths} months but drops them ` +
        `from the archive after ${period.totalYears} years; the hot window must fit inside the total obligation.`,
      );
    }
  }
}

/**
 * The first instant of the month that is `months` before the month containing `asOf`.
 *
 * The boundary is a month, not an instant, because the storage unit is a monthly partition: a
 * month-aligned cutoff is the only one that makes "every row in this partition is past its period" a
 * decidable question about the partition rather than about each row's timestamp. A cutoff at an
 * arbitrary instant would classify a partition by its newest row, so the archive volume would depend
 * on the hour the job ran.
 */
function firstInstantOfMonthMonthsBefore(instant: Date, months: number): Date {
  const monthIndex = instant.getUTCFullYear() * 12 + instant.getUTCMonth() - months;
  const year = Math.floor(monthIndex / 12);
  return new Date(Date.UTC(year, ((monthIndex % 12) + 12) % 12, 1));
}

/** See `firstInstantOfMonthMonthsBefore`: a row is past its hot window when it is strictly before this. */
export function auditRetentionHotCutoff(asOf: Date, hotMonths: number): Date {
  return firstInstantOfMonthMonthsBefore(asOf, hotMonths);
}

/**
 * When the archive may stop holding a row. Month-aligned for the same reason the hot cutoff is, and
 * derived from the row's own month so a partition archived in one run does not expire its rows in
 * different months.
 */
export function auditRetentionPurgeAfter(occurredAt: Date, totalYears: number): Date {
  return firstInstantOfMonthMonthsBefore(new Date(Date.UTC(
    occurredAt.getUTCFullYear() + totalYears, occurredAt.getUTCMonth(), 1,
  )), 0);
}
