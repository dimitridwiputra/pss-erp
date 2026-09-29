import type { EvaluationContext, JsonValue, Logger, ResolutionDetails } from '@openfeature/server-sdk';
import { ErrorCode, ProviderStatus, StandardResolutionReasons, type Provider } from '@openfeature/server-sdk';
import { registryCatalog } from '@pss/contracts';

export type ConfigScope = { organizationId?: string; branchId?: string; principalId?: string; customerId?: string };
export type ConfigValueStatus = 'PENDING_APPROVAL' | 'SCHEDULED' | 'ACTIVE' | 'SUPERSEDED';
export type ConfigValueRow = { key: string; scope: ConfigScope; value: JsonValue | null; validFrom: string; validTo?: string; status: ConfigValueStatus; revision?: number };
export type ConfigContext = ConfigScope & { businessDate: string };
export type ConfigResult<T extends JsonValue = JsonValue> =
  | { kind: 'VALUE'; key: string; value: T; source: ConfigValueRow }
  | { kind: 'UNSET'; key: string; reason: 'NO_ACTIVE_VALUE' | 'EMPTY_VALUE' };
export type FeatureFlagTarget = ConfigScope & { role?: string; userId?: string };
export type FeatureFlagRow = { key: string; enabled: boolean; target?: FeatureFlagTarget; priority?: number; updatedAt?: string; expiresAt?: string };
export type FlagContext = ConfigScope & { role?: string; userId?: string };

const configKeys = new Set<string>([
  ...registryCatalog.configurationSeeds.map((entry) => entry.keyExpression),
  ...registryCatalog.configurationAdditions.flatMap((entry) => entry.keys),
]);
const flagKeys = new Set<string>(registryCatalog.configurationAdditions.filter((entry) => entry.kind === 'Flag' || entry.kind === 'Config / flag').flatMap((entry) => entry.keys));
export const CONFIG_KEYS = Object.freeze([...configKeys] as readonly string[]);
export const FEATURE_FLAG_KEYS = Object.freeze([...flagKeys] as readonly string[]);

export class ConfigurationError extends Error {
  constructor(public readonly code: 'CONFIG_KEY_UNKNOWN' | 'FEATURE_FLAG_UNKNOWN', key: string) { super(`${code}: ${key}`); this.name = 'ConfigurationError'; }
}
export function assertKnownConfigKey(key: string): void { if (!configKeys.has(key)) throw new ConfigurationError('CONFIG_KEY_UNKNOWN', key); }
export function assertKnownFeatureFlag(key: string): void { if (!flagKeys.has(key)) throw new ConfigurationError('FEATURE_FLAG_UNKNOWN', key); }

function matchesScope(candidate: ConfigScope, requested: ConfigScope): boolean {
  return Object.entries(candidate).every(([key, value]) => value === requested[key as keyof ConfigScope]);
}
function scopeRank(scope: ConfigScope): number {
  if (scope.customerId && scope.principalId && scope.branchId) return 5;
  if (scope.principalId && scope.branchId) return 4;
  if (scope.customerId) return 3;
  if (scope.branchId) return 2;
  if (scope.principalId) return 1;
  if (scope.organizationId) return 0;
  return -1;
}
function activeAt(row: ConfigValueRow, businessDate: string): boolean {
  return row.status !== 'SUPERSEDED' && row.validFrom <= businessDate && (row.validTo === undefined || businessDate < row.validTo);
}

/** Resolve a registered value by business date, then most-specific scope, then revision. */
export function getConfig<T extends JsonValue = JsonValue>(rows: readonly ConfigValueRow[], key: string, context: ConfigContext): ConfigResult<T> {
  assertKnownConfigKey(key);
  const selected = rows.filter((row) => row.key === key && activeAt(row, context.businessDate) && matchesScope(row.scope, context))
    .sort((left, right) => scopeRank(right.scope) - scopeRank(left.scope) || (right.revision ?? 0) - (left.revision ?? 0))[0];
  if (!selected) return { kind: 'UNSET', key, reason: 'NO_ACTIVE_VALUE' };
  if (selected.value === null) return { kind: 'UNSET', key, reason: 'EMPTY_VALUE' };
  return { kind: 'VALUE', key, value: selected.value as T, source: selected };
}

function flagRank(target: FeatureFlagTarget | undefined, context: FlagContext): number {
  if (!target) return 0;
  if (target.userId && target.userId === context.userId) return 5;
  if (target.customerId && target.customerId === context.customerId) return 4;
  if (target.role && target.role === context.role && (!target.branchId || target.branchId === context.branchId)) return 3;
  if (target.branchId && target.branchId === context.branchId) return 2;
  if (target.organizationId && target.organizationId === context.organizationId) return 1;
  return -1;
}
/** Evaluate a registered flag. Unknown, expired, or malformed rows fail closed to false. */
export function evaluateFlag(rows: readonly FeatureFlagRow[], key: string, context: FlagContext): boolean {
  assertKnownFeatureFlag(key);
  const selected = rows.filter((row) => row.key === key && flagRank(row.target, context) >= 0 && (row.expiresAt === undefined || row.expiresAt > new Date().toISOString()))
    .sort((left, right) => flagRank(right.target, context) - flagRank(left.target, context) || (right.priority ?? 0) - (left.priority ?? 0) || (right.updatedAt ?? '').localeCompare(left.updatedAt ?? ''))[0];
  return selected?.enabled === true;
}

export class PssFeatureFlagProvider implements Provider {
  readonly metadata = { name: 'pss-configuration' } as const;
  readonly status = ProviderStatus.READY;
  constructor(private readonly rows: readonly FeatureFlagRow[], private readonly context: FlagContext = {}) {}
  async initialize(): Promise<void> { return undefined; }
  async onClose(): Promise<void> { return undefined; }
  resolveBooleanEvaluation(flagKey: string, defaultValue: boolean, context: EvaluationContext, logger: Logger): Promise<ResolutionDetails<boolean>> {
    void logger;
    try {
      if (!flagKeys.has(flagKey)) return Promise.resolve({ value: defaultValue, reason: StandardResolutionReasons.ERROR, errorCode: ErrorCode.FLAG_NOT_FOUND });
      return Promise.resolve({ value: evaluateFlag(this.rows, flagKey, { ...this.context, ...context } as FlagContext), reason: StandardResolutionReasons.STATIC });
    } catch { return Promise.resolve({ value: defaultValue, reason: StandardResolutionReasons.ERROR, errorCode: ErrorCode.GENERAL }); }
  }
  resolveStringEvaluation(_flagKey: string, defaultValue: string): Promise<ResolutionDetails<string>> { return Promise.resolve({ value: defaultValue, reason: StandardResolutionReasons.ERROR, errorCode: ErrorCode.TYPE_MISMATCH }); }
  resolveNumberEvaluation(_flagKey: string, defaultValue: number): Promise<ResolutionDetails<number>> { return Promise.resolve({ value: defaultValue, reason: StandardResolutionReasons.ERROR, errorCode: ErrorCode.TYPE_MISMATCH }); }
  resolveObjectEvaluation<T extends JsonValue>(_flagKey: string, defaultValue: T): Promise<ResolutionDetails<T>> { return Promise.resolve({ value: defaultValue, reason: StandardResolutionReasons.ERROR, errorCode: ErrorCode.TYPE_MISMATCH }); }
}
