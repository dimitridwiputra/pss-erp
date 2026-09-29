import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { DomainError, registryCatalog } from '@pss/contracts';
import { runAuditedWork, withAuditedTransaction, type AuditedTransaction } from '@pss/audit';

/**
 * PLT-009 — the audited administrative write path for `platform.config_value`, plus the row
 * projection the read path is fed from.
 *
 * Division of labour with `@pss/configuration`: Platform owns persistence (the effective-dated
 * rows and the audited writes). `@pss/configuration` owns evaluation (`getConfig`, scope
 * ranking, the `UNSET` contract, the OpenFeature provider). Platform never re-implements
 * resolution, so PLT-009.BR02/BR04/AC02/NC02 have exactly one implementation. `loadConfigRows`
 * returns rows already shaped as the library's `ConfigValueRow`, so a caller holding that
 * dependency evaluates without a translation layer.
 *
 * `registeredConfigKeys` re-derives the key set from the same generated `registryCatalog` the
 * library reads, because Platform cannot import the library today (see the note on
 * `activeConfigStatuses`). When `@pss/configuration` becomes a Platform dependency these two
 * helpers must be deleted in favour of `CONFIG_KEYS` and `assertKnownConfigKey`.
 */

const ConfigKeySchema = z.string().trim().min(1).max(200);

const ScopeSchema = z.strictObject({
  branchId: z.uuid().optional(),
  principalId: z.uuid().optional(),
  customerId: z.uuid().optional(),
});

const ProposeSchema = z.strictObject({
  /** The caller's organization, resolved from the session — never taken from the body. */
  organizationId: z.uuid(),
  key: ConfigKeySchema,
  scope: ScopeSchema,
  /** `null` is the documented KOSONG case: stored as such, never defaulted (BR04/NC02). */
  value: z.unknown().nullable(),
  /** ISO business date in Asia/Jakarta, never the server date (BR06/NC03). */
  validFrom: z.iso.date(),
  validTo: z.iso.date().optional(),
  reason: z.string().trim().min(1).max(500),
  requiresOwnerApproval: z.boolean(),
  approvalId: z.uuid().optional(),
  requestId: z.string().min(1),
});
export type ProposeConfigValueInput = z.input<typeof ProposeSchema>;

const LoadRowsSchema = z.strictObject({
  key: ConfigKeySchema,
  organizationId: z.uuid(),
  scope: ScopeSchema,
});
export type LoadConfigRowsInput = z.input<typeof LoadRowsSchema>;

export type ConfigValueStatus = 'PENDING_APPROVAL' | 'SCHEDULED' | 'ACTIVE' | 'SUPERSEDED';

export interface ConfigScope {
  organizationId?: string;
  branchId?: string;
  principalId?: string;
  customerId?: string;
}

/** Structurally identical to `@pss/configuration`'s `ConfigValueRow`, so no mapping is needed. */
export interface ConfigValueRow {
  key: string;
  scope: ConfigScope;
  value: unknown;
  validFrom: string;
  validTo?: string;
  status: ConfigValueStatus;
  revision?: number;
}

export interface ConfigValueView {
  id: string;
  key: string;
  scope: ConfigScope;
  value: unknown;
  validFrom: string;
  validTo: string | null;
  status: ConfigValueStatus;
  revision: number;
  proposedBy: string;
  approvedBy: string | null;
  reasonCode: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ConfigRow {
  id: string;
  key: string;
  organization_id: string | null;
  branch_id: string | null;
  principal_id: string | null;
  customer_id: string | null;
  value: unknown;
  valid_from: Date | string;
  valid_to: Date | string | null;
  status: ConfigValueStatus;
  revision: number;
  proposed_by: string;
  approved_by: string | null;
  reason_code: string | null;
  created_at: Date;
  updated_at: Date;
}

// `date` columns are cast to text in SQL on purpose. node-postgres materialises a `date` as a
// JavaScript Date at local midnight, so `toISOString()` shifts it by the machine's UTC offset
// and a value effective on 1 Nov would read as 31 Oct. AGENTS.md §11 wants UTC timestamps with
// an Asia/Jakarta business date; the business date itself must not move with the server's zone.
const VALUE_COLUMNS = `id, key, organization_id, branch_id, principal_id, customer_id, value,
  valid_from::text AS valid_from, valid_to::text AS valid_to, status, revision,
  proposed_by, approved_by, reason_code, created_at, updated_at`;

/**
 * The library's `getConfig` treats every status other than `SUPERSEDED` as effective, so a
 * `PENDING_APPROVAL` value would become readable if it were handed over. Restricting reads to
 * these two statuses is what keeps an unapproved value invisible, which is the whole point of
 * that status. It also mirrors the partial index migration 0004 already built.
 */
const READABLE_STATUSES = "('SCHEDULED', 'ACTIVE')";

function toDate(value: Date | string): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value;
}

function toScope(row: Pick<ConfigRow, 'organization_id' | 'branch_id' | 'principal_id' | 'customer_id'>): ConfigScope {
  return {
    ...(row.organization_id ? { organizationId: row.organization_id } : {}),
    ...(row.branch_id ? { branchId: row.branch_id } : {}),
    ...(row.principal_id ? { principalId: row.principal_id } : {}),
    ...(row.customer_id ? { customerId: row.customer_id } : {}),
  };
}

function toView(row: ConfigRow): ConfigValueView {
  return {
    id: row.id,
    key: row.key,
    scope: toScope(row),
    value: row.value,
    validFrom: toDate(row.valid_from),
    validTo: row.valid_to === null ? null : toDate(row.valid_to),
    status: row.status,
    revision: row.revision,
    proposedBy: row.proposed_by,
    approvedBy: row.approved_by,
    reasonCode: row.reason_code,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * The key registry is code, not data (PLT-009.R02). Both this module and `@pss/configuration`
 * derive it from the generated `registryCatalog`, so an unregistered key is rejected on the
 * write path instead of being stored and only failing later at read time (PLT-009.E2/AC02).
 */
export function registeredConfigKeys(): readonly string[] {
  return [
    ...registryCatalog.configurationSeeds.map((entry) => entry.keyExpression),
    ...registryCatalog.configurationAdditions.flatMap((entry) => entry.keys),
  ];
}

export function assertRegisteredConfigKey(key: string): void {
  if (!registeredConfigKeys().includes(key)) throw new DomainError('CONFIG_KEY_UNKNOWN');
}

/**
 * PLT-009 main flow 1-3. The prior value for the same key and scope is SUPERSEDED with its
 * `valid_to` closed and is never deleted (BR03/NC01). Claiming owner approval without an
 * approval id is refused, so a value cannot reach SCHEDULED on an approval that does not exist.
 *
 * `client` lets the caller supply the transaction that PLT-006's idempotency wrapper already
 * opened, so the replay record, the superseded-value updates, and the audit entries commit
 * together. The audit requirement holds either way: `runAuditedWork` refuses to return until an
 * entry has been appended, so a caller cannot use the shared client to write unaudited.
 */
export async function proposeConfigValue(
  pool: Pool, rawInput: ProposeConfigValueInput, proposedBy: string, client?: PoolClient,
): Promise<ConfigValueView> {
  if (client) {
    return runAuditedWork(client, (transaction) => writeConfigValue(transaction.client, transaction.appendAuditEntry, rawInput, proposedBy));
  }
  return withAuditedTransaction(pool, (transaction) => writeConfigValue(transaction.client, transaction.appendAuditEntry, rawInput, proposedBy));
}

async function writeConfigValue(
  client: PoolClient,
  appendAuditEntry: AuditedTransaction['appendAuditEntry'],
  rawInput: ProposeConfigValueInput,
  proposedBy: string,
): Promise<ConfigValueView> {
  const parsed = ProposeSchema.safeParse(rawInput);
  if (!parsed.success) throw new DomainError('VALIDATION_FAILED');
  const input = parsed.data;
  assertRegisteredConfigKey(input.key);
  if (input.requiresOwnerApproval && input.approvalId === undefined) {
    throw new DomainError('VALIDATION_FAILED', [], [{
      path: 'approvalId', code: 'required',
      message: 'Nilai yang memerlukan persetujuan owner harus menyertakan approvalId.',
    }]);
  }
  if (input.validTo !== undefined && input.validTo <= input.validFrom) {
    throw new DomainError('VALIDATION_FAILED', [], [{
      path: 'validTo', code: 'invalid_value',
      message: 'Tanggal berakhir harus setelah tanggal mulai berlaku.',
    }]);
  }
  const status: ConfigValueStatus = input.requiresOwnerApproval ? 'PENDING_APPROVAL' : 'SCHEDULED';
  const { branchId, principalId, customerId } = input.scope;

  const superseded = await client.query<{ id: string; revision: number; status: string }>(
    `UPDATE platform.config_value
     SET status = 'SUPERSEDED', superseded_at = now(), superseded_by_id = $5,
         valid_to = $4::date, updated_at = now()
     WHERE key = $1 AND organization_id = $2::uuid
       AND (branch_id, principal_id, customer_id)
           IS NOT DISTINCT FROM ($3::uuid, $6::uuid, $7::uuid)
       AND status IN ('SCHEDULED', 'ACTIVE')
       AND valid_from < $4::date AND (valid_to IS NULL OR valid_to > $4::date)
     RETURNING id, revision, status`,
    [input.key, input.organizationId, branchId ?? null, input.validFrom, proposedBy,
      principalId ?? null, customerId ?? null],
  );
  const revisionRows = await client.query<{ revision: number }>(
    `SELECT coalesce(max(revision), 0)::int + 1 AS revision FROM platform.config_value
     WHERE key = $1 AND organization_id = $2::uuid
       AND (branch_id, principal_id, customer_id)
           IS NOT DISTINCT FROM ($3::uuid, $4::uuid, $5::uuid)`,
    [input.key, input.organizationId, branchId ?? null, principalId ?? null, customerId ?? null],
  );
  const revision = revisionRows.rows[0]?.revision ?? 1;
  const id = randomUUID();
  const inserted = await client.query<ConfigRow>(
    `INSERT INTO platform.config_value (
       id, key, organization_id, branch_id, principal_id, customer_id, value,
       valid_from, valid_to, status, proposed_by, approved_by, revision, reason_code
     ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::date,$9::date,$10,$11,$12,$13,$14)
     RETURNING ${VALUE_COLUMNS}`,
    [id, input.key, input.organizationId, branchId ?? null, principalId ?? null,
      customerId ?? null, JSON.stringify(input.value ?? null), input.validFrom,
      input.validTo ?? null, status, proposedBy, input.approvalId ?? null, revision, input.reason],
  );
  const row = inserted.rows[0];
  if (!row) throw new Error('The configuration value was not returned after insertion.');

  await appendAuditEntry({
    organizationId: input.organizationId,
    ...(branchId ? { branchId } : {}),
    actor: { userId: proposedBy, roles: [] },
    action: 'CONFIG_VALUE_PROPOSED',
    entity: { domain: 'platform', type: 'ConfigValue', id, version: revision },
    changes: [
      { path: 'status', classification: 'INTERNAL', after: status },
      { path: 'validFrom', classification: 'INTERNAL', after: input.validFrom },
      { path: 'value', classification: 'CONFIDENTIAL', after: input.value === null ? 'KOSONG' : 'SET' },
      { path: 'requiresOwnerApproval', classification: 'INTERNAL', after: String(input.requiresOwnerApproval) },
    ],
    reasonCode: input.reason,
    requestId: input.requestId, correlationId: input.requestId, source: 'API',
  });
  for (const previous of superseded.rows) {
    await appendAuditEntry({
      organizationId: input.organizationId,
      ...(branchId ? { branchId } : {}),
      actor: { userId: proposedBy, roles: [] },
      action: 'CONFIG_VALUE_SUPERSEDED',
      entity: { domain: 'platform', type: 'ConfigValue', id: previous.id, version: previous.revision + 1 },
      changes: [
        { path: 'status', classification: 'INTERNAL', before: previous.status, after: 'SUPERSEDED' },
        { path: 'validTo', classification: 'INTERNAL', after: input.validFrom },
      ],
      reasonCode: input.reason,
      requestId: input.requestId, correlationId: input.requestId, causationId: id, source: 'API',
    });
  }
  return toView(row);
}

/**
 * The rows `getConfig` needs for one key and scope, already filtered to the statuses a reader
 * may see. Scope filtering is a superset of the request (a null column matches any value), so
 * the library still performs the most-specific-wins ranking (PLT-009.BR02).
 */
export async function loadConfigRows(
  pool: Pool, rawInput: LoadConfigRowsInput,
): Promise<ConfigValueRow[]> {
  const parsed = LoadRowsSchema.safeParse(rawInput);
  if (!parsed.success) throw new DomainError('VALIDATION_FAILED');
  const input = parsed.data;
  assertRegisteredConfigKey(input.key);
  const { rows } = await pool.query<ConfigRow>(
    `SELECT ${VALUE_COLUMNS} FROM platform.config_value
     WHERE key = $1 AND organization_id = $2::uuid
       AND (branch_id IS NULL OR branch_id = $3::uuid)
       AND (principal_id IS NULL OR principal_id = $4::uuid)
       AND (customer_id IS NULL OR customer_id = $5::uuid)
       AND status IN ${READABLE_STATUSES}`,
    [input.key, input.organizationId, input.scope.branchId ?? null,
      input.scope.principalId ?? null, input.scope.customerId ?? null],
  );
  return rows.map((row) => ({
    key: row.key,
    scope: toScope(row),
    value: row.value,
    validFrom: toDate(row.valid_from),
    ...(row.valid_to === null ? {} : { validTo: toDate(row.valid_to) }),
    status: row.status,
    revision: row.revision,
  }));
}

/** PLT-009.UX: the console table needs the schedule and the history, not just the active value. */
export async function listConfigValues(
  pool: Pool, key: string, organizationId: string,
  scope: z.input<typeof ScopeSchema> = {}, limit = 100,
): Promise<ConfigValueView[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new DomainError('VALIDATION_FAILED');
  assertRegisteredConfigKey(key);
  const { rows } = await pool.query<ConfigRow>(
    `SELECT ${VALUE_COLUMNS} FROM platform.config_value
     WHERE key = $1 AND organization_id = $2::uuid
       AND (branch_id IS NULL OR branch_id = $3::uuid)
       AND (principal_id IS NULL OR principal_id = $4::uuid)
       AND (customer_id IS NULL OR customer_id = $5::uuid)
     ORDER BY valid_from DESC, revision DESC LIMIT $6`,
    [key, organizationId, scope.branchId ?? null, scope.principalId ?? null,
      scope.customerId ?? null, limit],
  );
  return rows.map(toView);
}

export interface ConfigGateReportEntry {
  key: string;
  status: ConfigValueStatus | 'UNSET';
  value: 'SET' | 'KOSONG' | 'UNSET';
  validFrom: string | null;
  scope: ConfigScope | null;
}

/**
 * PLT-009.R05 / AC05: every registered key with what is currently in force, so the phase gate
 * can list the ASM/KOSONG keys that still need an owner. A key with no row is reported as
 * `UNSET` rather than being given a default.
 */
export async function configGateReport(
  pool: Pool, businessDate: string,
): Promise<ConfigGateReportEntry[]> {
  if (!z.iso.date().safeParse(businessDate).success) throw new DomainError('VALIDATION_FAILED');
  const { rows } = await pool.query<{
    key: string; organization_id: string | null; branch_id: string | null;
    principal_id: string | null; customer_id: string | null; value: unknown;
    valid_from: string; status: ConfigValueStatus;
  }>(
    `SELECT DISTINCT ON (key) key, organization_id, branch_id, principal_id, customer_id, value,
            valid_from, status
     FROM platform.config_value
     WHERE status IN ${READABLE_STATUSES} AND valid_from <= $1::date
       AND (valid_to IS NULL OR valid_to > $1::date)
     ORDER BY key, valid_from DESC, revision DESC`,
    [businessDate],
  );
  const inForce = new Map(rows.map((row) => [row.key, {
    scope: toScope(row),
    value: row.value === null ? 'KOSONG' as const : 'SET' as const,
    validFrom: row.valid_from,
    status: row.status,
  }]));
  return registeredConfigKeys().map((key) => {
    const entry = inForce.get(key);
    return entry
      ? { key, status: entry.status, value: entry.value, validFrom: entry.validFrom, scope: entry.scope }
      : { key, status: 'UNSET' as const, value: 'UNSET' as const, validFrom: null, scope: null };
  });
}
