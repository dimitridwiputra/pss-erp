import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import { DomainError, registryCatalog } from '@pss/contracts';
import { withAuditedTransaction } from '@pss/audit';

/**
 * PLT-010 — audited administration of `platform.feature_flag` and its targeting rules.
 *
 * Division of labour with `@pss/configuration`: Platform owns persistence (the flag registry,
 * the targeting rules, the audited writes, and the rollout projection). The library owns
 * evaluation — `evaluateFlag` and the OpenFeature `PssFeatureFlagProvider` decide precedence,
 * expiry, and the fail-closed default. Platform never re-implements flag resolution (AGENTS.md §6),
 * so PLT-010.AC02 / NC02 can only be satisfied in one place.
 *
 * `loadFlagRows` returns rows already shaped as the library's `FeatureFlagRow`, so a caller
 * holding that dependency evaluates without a translation layer. The deterministic percentage
 * bucket below is the only rollout logic Platform owns, and it only decides whether a rule is
 * *applicable* to a subject — never whether the feature is on.
 */

const FlagKeySchema = z.string().trim().min(1).max(120);

const SetFlagSchema = z.strictObject({
  organizationId: z.uuid(),
  key: FlagKeySchema,
  /** The default when no targeting rule applies. False is the safe default (PLT-010.BR02). */
  enabled: z.boolean(),
  owner: z.string().trim().min(1).max(120),
  /** PLT-010.AC04: the date by which the flag should have been removed. */
  targetRemoveDate: z.iso.date().optional(),
  requestId: z.string().min(1),
});
export type SetFeatureFlagInput = z.input<typeof SetFlagSchema>;

const TargetingSchema = z.strictObject({
  organizationId: z.uuid(),
  flagKey: FlagKeySchema,
  branchId: z.uuid().optional(),
  roleCode: z.string().trim().min(1).max(60).optional(),
  userId: z.uuid().optional(),
  enabled: z.boolean(),
  /** 0-100. Absent means the rule always applies to a matching subject (AC01). */
  percentage: z.int().min(0).max(100).optional(),
  priority: z.int().min(0).max(1000).default(0),
  /** After this instant the rule is dropped, so evaluation falls through to a lower rule or off. */
  expiresAt: z.iso.datetime().optional(),
  requestId: z.string().min(1),
});
export type SetFlagTargetingInput = z.input<typeof TargetingSchema>;

const LoadFlagRowsSchema = z.strictObject({
  key: FlagKeySchema,
  /** The subject being evaluated. A percentage share is measured against this, and only the
   * rules whose constrained dimensions match it are returned. */
  context: z.strictObject({
    organizationId: z.uuid().optional(),
    branchId: z.uuid().optional(),
    /** Every role the subject currently holds. Empty means the subject has no role. */
    roleCodes: z.array(z.string().trim().min(1).max(60)).default([]),
    userId: z.uuid().optional(),
  }),
});
export type LoadFlagRowsInput = z.input<typeof LoadFlagRowsSchema>;

/**
 * The evaluation projection, shaped to match `@pss/configuration`'s `FeatureFlagTarget` so the
 * rows can be handed straight to `evaluateFlag` and the OpenFeature provider. It names the
 * role field `role` because the library reads that name; renaming it would mean every caller
 * had to translate, and a translation is somewhere a dimension silently goes missing.
 */
export interface FlagTarget {
  organizationId?: string;
  branchId?: string;
  role?: string;
  userId?: string;
}

/** The administration view, in the repository's `roleCode` vocabulary. */
export interface FlagTargetingScope {
  organizationId?: string;
  branchId?: string;
  roleCode?: string;
  userId?: string;
}
export interface FlagRow {
  key: string;
  enabled: boolean;
  /**
   * Absent, never `{}`, for a rule that constrains nothing. `@pss/configuration`'s `flagRank`
   * gives an absent target rank 0 but an empty-object target rank -1, so a global default
   * written as `target: {}` is dropped from evaluation entirely instead of acting as the
   * fallback every unmatched subject relies on.
   */
  target?: FlagTarget;
  priority?: number;
  updatedAt?: string;
  expiresAt?: string;
}

export interface FeatureFlagView {
  id: string;
  key: string;
  enabled: boolean;
  owner: string;
  targetRemoveDate: string | null;
  version: number;
  updatedBy: string;
  updatedAt: string;
}

export interface FlagTargetingView {
  id: string;
  flagKey: string;
  target: FlagTargetingScope;
  enabled: boolean;
  percentage: number | null;
  priority: number;
  expiresAt: string | null;
  version: number;
  updatedBy: string;
  updatedAt: string;
}

interface FlagRecord {
  id: string;
  key: string;
  enabled: boolean;
  owner: string;
  target_remove_date: string | null;
  version: number;
  updated_by: string;
  updated_at: Date;
}

interface TargetingRecord {
  id: string;
  flag_key: string;
  organization_id: string | null;
  branch_id: string | null;
  role_code: string | null;
  user_id: string | null;
  enabled: boolean;
  percentage: number | null;
  priority: number;
  expires_at: Date | null;
  updated_by: string;
  updated_at: Date;
  version: number;
}

// `target_remove_date::text` because node-postgres materialises a `date` as a Date at local
// midnight, and toISOString() would shift it by the server's UTC offset (see config-admin.ts).
const FLAG_COLUMNS = 'id, key, enabled, owner, target_remove_date::text AS target_remove_date, version, updated_by, updated_at';
const TARGETING_COLUMNS = `id, flag_key, organization_id, branch_id, role_code, user_id, enabled,
  percentage, priority, expires_at, updated_by, updated_at, version`;

function toFlagView(row: FlagRecord): FeatureFlagView {
  return {
    id: row.id,
    key: row.key,
    enabled: row.enabled,
    owner: row.owner,
    targetRemoveDate: row.target_remove_date,
    version: row.version,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at.toISOString(),
  };
}

function toTargetingScope(row: TargetingRecord): FlagTargetingScope {
  return {
    ...(row.organization_id ? { organizationId: row.organization_id } : {}),
    ...(row.branch_id ? { branchId: row.branch_id } : {}),
    ...(row.role_code ? { roleCode: row.role_code } : {}),
    ...(row.user_id ? { userId: row.user_id } : {}),
  };
}

function toTargetingView(row: TargetingRecord): FlagTargetingView {
  return {
    id: row.id,
    flagKey: row.flag_key,
    target: toTargetingScope(row),
    enabled: row.enabled,
    percentage: row.percentage,
    priority: row.priority,
    expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
    version: row.version,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * The flag registry is code (PLT-010 "flag registry"), generated from the PRD appendices. Both
 * this module and `@pss/configuration` derive it from `registryCatalog`, so an unregistered flag
 * is refused here instead of being written and then silently never matching.
 */
export function registeredFlagKeys(): readonly string[] {
  return registryCatalog.configurationAdditions
    .filter((entry) => entry.kind === 'Flag' || entry.kind === 'Config / flag')
    .flatMap((entry) => entry.keys);
}

export function assertRegisteredFlagKey(key: string): void {
  // `CONFIG_KEY_UNKNOWN` (Appendix F, §84) is the registered code for a key that is not in the
  // generated registry. `@pss/configuration` raises an internal `FEATURE_FLAG_UNKNOWN` for the
  // same condition, but that code is not in the PRD's error registry, so it cannot be thrown
  // as a `DomainError` without failing its own constructor. Reported as an open registry gap.
  if (!registeredFlagKeys().includes(key)) throw new DomainError('CONFIG_KEY_UNKNOWN');
}

/**
 * PLT-010 staged rollout. The bucket is a hash of the flag key and the subject, so the same
 * subject lands in the same bucket on every node and after every restart — a random draw would
 * make one user's experience flap between requests (AC01). A subject outside its share sees the
 * rule as inapplicable, so evaluation falls through to a lower-priority rule or the default.
 */
function inRollout(flagKey: string, subjectId: string, percentage: number): boolean {
  const bucket = createHash('sha256').update(`${flagKey}:${subjectId}`).digest().readUInt32BE(0) % 100;
  return bucket < percentage;
}

/**
 * PLT-010.R02 / AC03. Upserts the flag's global default and owner. `enabled` is the value that
 * applies when no rule matches, so a rollout can never widen by accident. A flag that does not
 * exist yet is created disabled first, then targeted.
 */
export async function setFeatureFlag(
  pool: Pool, rawInput: SetFeatureFlagInput, updatedBy: string,
): Promise<FeatureFlagView> {
  const parsed = SetFlagSchema.safeParse(rawInput);
  if (!parsed.success) throw new DomainError('VALIDATION_FAILED');
  const input = parsed.data;
  assertRegisteredFlagKey(input.key);
  return withAuditedTransaction(pool, async ({ client, appendAuditEntry }) => {
    const before = await client.query<FlagRecord>(
      `SELECT ${FLAG_COLUMNS} FROM platform.feature_flag WHERE key = $1 FOR UPDATE`, [input.key],
    );
    const previous = before.rows[0];
    const result = await client.query<FlagRecord>(
      `INSERT INTO platform.feature_flag (id, key, enabled, targeting, owner, target_remove_date, updated_by, updated_at)
       VALUES ($1, $2, $3, '{}'::jsonb, $4, $5::date, $6, now())
       ON CONFLICT (key) DO UPDATE SET
         enabled = EXCLUDED.enabled, owner = EXCLUDED.owner,
         target_remove_date = EXCLUDED.target_remove_date, updated_by = EXCLUDED.updated_by,
         updated_at = now(), version = platform.feature_flag.version + 1
       RETURNING ${FLAG_COLUMNS}`,
      [randomUUID(), input.key, input.enabled, input.owner, input.targetRemoveDate ?? null, updatedBy],
    );
    const row = result.rows[0];
    if (!row) throw new Error('The feature flag was not returned after upsert.');
    await appendAuditEntry({
      organizationId: input.organizationId,
      actor: { userId: updatedBy, roles: [] },
      action: 'FEATURE_FLAG_CHANGED',
      entity: { domain: 'platform', type: 'FeatureFlag', id: row.id, version: row.version },
      changes: [
        {
          path: 'enabled', classification: 'INTERNAL',
          ...(previous ? { before: String(previous.enabled) } : {}), after: String(row.enabled),
        },
        { path: 'owner', classification: 'INTERNAL', ...(previous ? { before: previous.owner } : {}), after: row.owner },
        { path: 'targetRemoveDate', classification: 'INTERNAL', after: row.target_remove_date ?? 'UNSET' },
      ],
      requestId: input.requestId, correlationId: input.requestId, source: 'API',
    });
    return toFlagView(row);
  });
}

/**
 * PLT-010 main flow 2. One row per targeting rule so a branch rollout and a user override can
 * coexist. Expired rules stay in the table as history but are projected out by `loadFlagRows`,
 * which is what makes expiry behave as "off" rather than as a stale on (AC02, NC02).
 */
export async function setFlagTargeting(
  pool: Pool, rawInput: SetFlagTargetingInput, updatedBy: string,
): Promise<FlagTargetingView> {
  const parsed = TargetingSchema.safeParse(rawInput);
  if (!parsed.success) throw new DomainError('VALIDATION_FAILED');
  const input = parsed.data;
  assertRegisteredFlagKey(input.flagKey);
  return withAuditedTransaction(pool, async ({ client, appendAuditEntry }) => {
    const existing = await client.query<TargetingRecord>(
      `SELECT ${TARGETING_COLUMNS} FROM platform.feature_flag_targeting
       WHERE flag_key = $1
         AND coalesce(organization_id, '00000000-0000-0000-0000-000000000000'::uuid) = $2::uuid
         AND coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid) = $3::uuid
         AND coalesce(role_code, '') = $4
         AND coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid) = $5::uuid
       FOR UPDATE`,
      [input.flagKey, input.organizationId, input.branchId ?? null, input.roleCode ?? '',
        input.userId ?? null],
    );
    const previous = existing.rows[0];
    const result = await client.query<TargetingRecord>(
      `INSERT INTO platform.feature_flag_targeting (
         id, flag_key, organization_id, branch_id, role_code, user_id,
         enabled, percentage, priority, expires_at, updated_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz,$11)
       ON CONFLICT (flag_key,
                     coalesce(organization_id, '00000000-0000-0000-0000-000000000000'::uuid),
                     coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid),
                     coalesce(role_code, ''),
                     coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid))
       DO UPDATE SET enabled = EXCLUDED.enabled, percentage = EXCLUDED.percentage,
                     priority = EXCLUDED.priority, expires_at = EXCLUDED.expires_at,
                     updated_by = EXCLUDED.updated_by, updated_at = now(),
                     version = platform.feature_flag_targeting.version + 1
       RETURNING ${TARGETING_COLUMNS}`,
      [previous?.id ?? randomUUID(), input.flagKey, input.organizationId, input.branchId ?? null,
        input.roleCode ?? null, input.userId ?? null, input.enabled, input.percentage ?? null,
        input.priority, input.expiresAt ?? null, updatedBy],
    );
    const row = result.rows[0];
    if (!row) throw new Error('The flag targeting rule was not returned after upsert.');
    await appendAuditEntry({
      organizationId: input.organizationId,
      ...(input.branchId ? { branchId: input.branchId } : {}),
      actor: { userId: updatedBy, roles: [] },
      action: 'FEATURE_FLAG_CHANGED',
      entity: { domain: 'platform', type: 'FlagTargeting', id: row.id, version: row.version },
      changes: [
        {
          path: 'enabled', classification: 'INTERNAL',
          ...(previous ? { before: String(previous.enabled) } : {}), after: String(row.enabled),
        },
        {
          path: 'percentage', classification: 'INTERNAL',
          ...(previous ? { before: previous.percentage === null ? 'UNSET' : String(previous.percentage) } : {}),
          after: row.percentage === null ? 'UNSET' : String(row.percentage),
        },
        { path: 'priority', classification: 'INTERNAL', after: String(row.priority) },
        { path: 'expiresAt', classification: 'INTERNAL', after: row.expires_at ? row.expires_at.toISOString() : 'UNSET' },
        // Only the targeting dimensions the caller actually set are recorded; an omitted one
        // means "matches anything at this level", not "cleared".
        ...(input.branchId ? [{ path: 'branchId', classification: 'INTERNAL' as const, after: input.branchId }] : []),
        ...(input.roleCode ? [{ path: 'roleCode', classification: 'INTERNAL' as const, after: input.roleCode }] : []),
        ...(input.userId ? [{ path: 'userId', classification: 'INTERNAL' as const, after: input.userId }] : []),
      ],
      requestId: input.requestId, correlationId: input.requestId, source: 'API',
    });
    return toTargetingView(row);
  });
}

/**
 * PLT-010.AC01/AC02 / TS01 / TS02. Projects one flag's global default plus every rule that
 * applies to this subject: a non-expired rule whose constrained dimensions all match and whose
 * percentage share contains the subject. An unregistered key, a missing flag row, and an
 * expired rule all leave the provider with only the global default — the fail-closed path.
 */
export async function loadFlagRows(pool: Pool, rawInput: LoadFlagRowsInput): Promise<FlagRow[]> {
  const parsed = LoadFlagRowsSchema.safeParse(rawInput);
  if (!parsed.success) throw new DomainError('VALIDATION_FAILED');
  const input = parsed.data;
  assertRegisteredFlagKey(input.key);
  const { rows } = await pool.query<{
    flag_id: string | null; flag_enabled: boolean | null; flag_updated_at: Date | null;
    rule_id: string | null; rule_enabled: boolean | null; rule_percentage: number | null;
    rule_priority: number | null; rule_expires_at: Date | null; rule_updated_at: Date | null;
    organization_id: string | null; branch_id: string | null;
    role_code: string | null; user_id: string | null;
  }>(
    `SELECT f.id AS flag_id, f.enabled AS flag_enabled, f.updated_at AS flag_updated_at,
            t.id AS rule_id, t.enabled AS rule_enabled, t.percentage AS rule_percentage,
            t.priority AS rule_priority, t.expires_at AS rule_expires_at,
            t.updated_at AS rule_updated_at, t.organization_id, t.branch_id, t.role_code, t.user_id
     FROM platform.feature_flag f
     LEFT JOIN platform.feature_flag_targeting t ON t.flag_key = f.key
     WHERE f.key = $1`,
    [input.key],
  );
  const nowMs = Date.now();
  const { organizationId, branchId, roleCodes, userId } = input.context;
  const rules: FlagRow[] = [];
  for (const row of rows) {
    if (row.rule_id === null || row.rule_enabled === null) continue;
    if (row.rule_expires_at !== null && row.rule_expires_at.getTime() <= nowMs) continue;
    // Every dimension the rule constrains must match the subject, or the rule does not apply.
    if (row.organization_id !== null && row.organization_id !== organizationId) continue;
    if (row.branch_id !== null && row.branch_id !== branchId) continue;
    // A user may hold several roles, so a role-targeted rule applies if it names any of them.
    if (row.role_code !== null && !roleCodes.includes(row.role_code)) continue;
    if (row.user_id !== null && row.user_id !== userId) continue;
    // Only the narrowest constrained dimension becomes the target. `@pss/configuration`'s
    // `flagRank` returns the first dimension that MATCHES rather than requiring all of them,
    // so projecting several would let a subject satisfy the rule on one dimension alone --
    // an organization-owned, branch-constrained rule would then match every branch in that
    // organization. The narrowest dimension is also the one that decides precedence, so the
    // library still ranks a user rule above a branch rule above an organization rule.
    const target: FlagTarget = row.user_id !== null ? { userId: row.user_id }
      : row.role_code !== null ? { role: row.role_code }
        : row.branch_id !== null ? { branchId: row.branch_id }
          : row.organization_id !== null ? { organizationId: row.organization_id }
            : {};
    if (row.rule_percentage !== null && row.rule_enabled) {
      // A rule that switches a feature OFF is never percentage-gated: a staged rollout must
      // never leave part of the population still on (PLT-010.A1 kill switch).
      const subject = userId ?? row.user_id ?? row.branch_id ?? row.organization_id;
      if (subject === null || !inRollout(input.key, subject, row.rule_percentage)) continue;
    }
    rules.push({
      key: input.key,
      enabled: row.rule_enabled,
      target,
      ...(row.rule_priority === null ? {} : { priority: row.rule_priority }),
      ...(row.rule_updated_at ? { updatedAt: row.rule_updated_at.toISOString() } : {}),
      ...(row.rule_expires_at ? { expiresAt: row.rule_expires_at.toISOString() } : {}),
    });
  }
  const flag = rows[0];
  // The global default is always present and always ranks lowest, so a matching rule wins and
  // an unmatched subject falls through to it. Its value is `false` unless an administrator
  // explicitly turned the flag on, which is what makes a provider failure harmless.
  return [{
    key: input.key,
    enabled: flag?.flag_enabled === true,
    ...(flag?.flag_updated_at ? { updatedAt: flag.flag_updated_at.toISOString() } : {}),
  }, ...rules];
}

export async function listFeatureFlags(pool: Pool): Promise<FeatureFlagView[]> {
  const { rows } = await pool.query<FlagRecord>(
    `SELECT ${FLAG_COLUMNS} FROM platform.feature_flag ORDER BY key`,
  );
  return rows.map(toFlagView);
}

export async function listFlagTargeting(
  pool: Pool, flagKey: string, organizationId: string,
): Promise<FlagTargetingView[]> {
  assertRegisteredFlagKey(flagKey);
  const { rows } = await pool.query<TargetingRecord>(
    `SELECT ${TARGETING_COLUMNS} FROM platform.feature_flag_targeting
     WHERE flag_key = $1 AND organization_id = $2::uuid
     ORDER BY priority DESC, updated_at DESC`,
    [flagKey, organizationId],
  );
  return rows.map(toTargetingView);
}

export interface StaleFlag {
  key: string;
  owner: string;
  targetRemoveDate: string;
  daysOverdue: number;
}

/** PLT-010.AC04 / R03: flags past their target removal date, so the registry stays clean. */
export async function staleFeatureFlags(pool: Pool, businessDate: string): Promise<StaleFlag[]> {
  if (!z.iso.date().safeParse(businessDate).success) throw new DomainError('VALIDATION_FAILED');
  const { rows } = await pool.query<{
    key: string; owner: string; target_remove_date: string; days_overdue: number;
  }>(
    `SELECT key, owner, target_remove_date::text AS target_remove_date,
            ($1::date - target_remove_date)::int AS days_overdue
     FROM platform.feature_flag
     WHERE target_remove_date IS NOT NULL AND target_remove_date < $1::date
     ORDER BY target_remove_date`,
    [businessDate],
  );
  return rows.map((row) => ({
    key: row.key,
    owner: row.owner,
    targetRemoveDate: row.target_remove_date,
    daysOverdue: row.days_overdue,
  }));
}
