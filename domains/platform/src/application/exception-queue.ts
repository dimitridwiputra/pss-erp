import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { DomainError } from '@pss/contracts';
import { withAuditedTransaction, type AuditedTransaction } from '@pss/audit';
import {
  BUSINESS_TIME_ZONE, addWorkingDays, calendarHorizon, loadNonWorkingDates,
} from './business-calendar';

const ReasonCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{2,79}$/);
const SubjectRefSchema = z.strictObject({
  domain: z.string().min(1).max(50),
  type: z.string().min(1).max(50),
  id: z.string().min(1).max(200),
});

const OpenExceptionSchema = z.strictObject({
  organizationId: z.uuid(),
  branchId: z.uuid().optional(),
  queueCode: z.string().min(1),
  subject: SubjectRefSchema,
  ownerDomain: z.string().min(1).max(50),
  reasonCode: ReasonCodeSchema,
  dedupeKey: z.string().min(1).max(200),
  /** Minimal, non-personal context for the queue screen (DQ-001 privacy). */
  context: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
  businessDate: z.iso.date(),
  requestId: z.string().min(1),
  correlationId: z.string().min(1),
});
export type OpenExceptionInput = z.input<typeof OpenExceptionSchema>;

export type ExceptionStatus = 'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | 'DISMISSED';

export interface ExceptionItem {
  id: string;
  organizationId: string;
  branchId: string | null;
  queueCode: string;
  subject: { domain: string; type: string; id: string };
  ownerDomain: string;
  reasonCode: string;
  context: Record<string, string | number | boolean | null>;
  status: ExceptionStatus;
  assigneeId: string | null;
  slaDueAt: string;
  overdueAt: string | null;
  escalatedAt: string | null;
  lastErrorMessage: string | null;
  occurrenceCount: number;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface OpenExceptionResult {
  item: ExceptionItem;
  /** False when the same dedupe key was already active and the existing item was updated. */
  created: boolean;
}

/** DQ-001.BR06: the escalation role joins the item only once it is overdue. */
const NO_ESCALATION_ROLES: string[] = [];

interface QueueRow {
  code: string; label: string; owner_roles: string[]; escalation_roles: string[];
  sla_unit: 'MINUTES' | 'HOURS' | 'DAYS' | 'BUSINESS_DAYS'; sla_value: number | null;
  sla_config_key: string | null; reason_codes: string[]; dismissible: boolean;
}

function toExceptionItem(row: Record<string, unknown>): ExceptionItem {
  return {
    id: row.id as string,
    organizationId: row.organization_id as string,
    branchId: (row.branch_id as string | null) ?? null,
    queueCode: row.queue_code as string,
    subject: {
      domain: row.subject_domain as string,
      type: row.subject_type as string,
      id: row.subject_id as string,
    },
    ownerDomain: row.owner_domain as string,
    reasonCode: row.reason_code as string,
    context: row.context as Record<string, string | number | boolean | null>,
    status: row.status as ExceptionStatus,
    assigneeId: (row.assignee_id as string | null) ?? null,
    slaDueAt: (row.sla_due_at as Date).toISOString(),
    overdueAt: (row.overdue_at as Date | null)?.toISOString() ?? null,
    escalatedAt: (row.escalated_at as Date | null)?.toISOString() ?? null,
    lastErrorMessage: (row.last_error_message as string | null) ?? null,
    occurrenceCount: row.occurrence_count as number,
    version: row.version as number,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}

const ITEM_COLUMNS = `id, organization_id, branch_id, queue_code, subject_domain, subject_type, subject_id,
  owner_domain, reason_code, context, status, assignee_id, sla_due_at, overdue_at, escalated_at,
  last_error_message, occurrence_count, version, created_at, updated_at`;

async function loadQueue(client: PoolClient | Pool, queueCode: string): Promise<QueueRow> {
  const { rows } = await client.query<QueueRow>(
    `SELECT code, label, owner_roles, escalation_roles, sla_unit, sla_value, sla_config_key,
            reason_codes, dismissible
     FROM platform.queue_definition WHERE code = $1 AND active`, [queueCode],
  );
  const definition = rows[0];
  if (!definition) throw new DomainError('QUEUE_UNKNOWN');
  return definition;
}

/**
 * DQ-001: the SLA comes from the registry, with the `exception.<queue>.sla` override the PRD
 * registers, or from the config key Appendix P itself names. A queue whose registry SLA is
 * neither (Appendix P writes "per tipe" or a KOSONG key) stays closed: Platform does not
 * invent a deadline.
 */
async function resolveSlaDueAt(
  client: PoolClient | Pool,
  definition: QueueRow,
  scope: { organizationId: string; branchId?: string; businessDate: string },
): Promise<Date> {
  const configKey = definition.sla_config_key ?? `exception.${definition.code}.sla`;
  const configured = await client.query<{ value: string | null }>(
    `SELECT value #>> '{}' AS value
     FROM platform.config_value
     WHERE key = $1 AND status = 'ACTIVE'
       AND (organization_id IS NULL OR organization_id = $2::uuid)
       AND (branch_id IS NULL OR branch_id IS NOT DISTINCT FROM $3::uuid)
       AND valid_from <= $4::date AND (valid_to IS NULL OR valid_to > $4::date)
     ORDER BY (branch_id IS NOT NULL) DESC, (organization_id IS NOT NULL) DESC, valid_from DESC
     LIMIT 1`,
    [configKey, scope.organizationId, scope.branchId ?? null, scope.businessDate],
  );
  const configuredValue = configured.rows[0]?.value;
  const amount = configuredValue === null || configuredValue === undefined
    ? definition.sla_value
    : Number.parseInt(configuredValue, 10);
  if (amount === null || amount === undefined || !Number.isInteger(amount) || amount < 1) {
    throw new Error(
      `Queue ${definition.code} has no resolvable SLA. Its owner must register one before items can be opened.`,
    );
  }
  if (definition.sla_unit === 'BUSINESS_DAYS') {
    const horizon = calendarHorizon(scope.businessDate, amount * 7 + 21);
    const nonWorking = await loadNonWorkingDates(client, {
      organizationId: scope.organizationId,
      ...(scope.branchId ? { branchId: scope.branchId } : {}),
      ...horizon,
    });
    return addWorkingDays(client, new Date(), amount, nonWorking);
  }
  const intervalUnit = definition.sla_unit === 'DAYS' ? 'days' : definition.sla_unit === 'HOURS' ? 'hours' : 'mins';
  const { rows } = await client.query<{ due_at: Date }>(
    `SELECT now() + make_interval(${intervalUnit} => $1) AS due_at`, [amount],
  );
  return rows[0]!.due_at;
}

/**
 * DQ-001.AC01 / TS01: one active item per (queue, dedupe key). A re-fire updates the existing
 * item and counts the occurrence instead of stacking a second one, and the partial unique
 * index makes that safe under concurrency.
 */
export async function openException(pool: Pool, rawInput: OpenExceptionInput): Promise<OpenExceptionResult> {
  const parsed = OpenExceptionSchema.safeParse(rawInput);
  if (!parsed.success) throw new DomainError('VALIDATION_FAILED');
  return withAuditedTransaction(pool, async ({ client, appendAuditEntry }) =>
    runOpenException(client, appendAuditEntry, parsed.data));
}

/**
 * The same open, inside the calling domain's own transaction so the item, the domain mutation,
 * and the domain's own outbox event share one commit (AGENTS.md 3.5). The audit entry is
 * mandatory, so a caller cannot open an item without its trail.
 */
export async function openExceptionInTransaction(
  transaction: AuditedTransaction, rawInput: OpenExceptionInput,
): Promise<OpenExceptionResult> {
  const parsed = OpenExceptionSchema.safeParse(rawInput);
  if (!parsed.success) throw new DomainError('VALIDATION_FAILED');
  return runOpenException(transaction.client, transaction.appendAuditEntry, parsed.data);
}

async function runOpenException(
  client: PoolClient,
  appendAuditEntry: AuditedTransaction['appendAuditEntry'],
  input: z.output<typeof OpenExceptionSchema>,
): Promise<OpenExceptionResult> {
  const definition = await loadQueue(client, input.queueCode);
  if (definition.reason_codes.length > 0 && !definition.reason_codes.includes(input.reasonCode)) {
    throw new DomainError('VALIDATION_FAILED');
  }
  const slaDueAt = await resolveSlaDueAt(client, definition, {
    organizationId: input.organizationId, businessDate: input.businessDate,
    ...(input.branchId ? { branchId: input.branchId } : {}),
  });
  const id = randomUUID();
  const { rows } = await client.query<Record<string, unknown>>(
    `INSERT INTO platform.exception_item (
       id, organization_id, branch_id, queue_code, subject_domain, subject_type, subject_id,
       owner_domain, owner_roles, escalation_roles, reason_code, context, dedupe_key, status, sla_due_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,'OPEN',$14)
     ON CONFLICT (queue_code, dedupe_key) WHERE status IN ('OPEN', 'IN_PROGRESS')
     DO UPDATE SET
       context = platform.exception_item.context || EXCLUDED.context,
       reason_code = EXCLUDED.reason_code,
       occurrence_count = platform.exception_item.occurrence_count + 1,
       version = platform.exception_item.version + 1,
       updated_at = now()
     RETURNING ${ITEM_COLUMNS}, (xmax = 0) AS inserted`,
    [
      id, input.organizationId, input.branchId ?? null, input.queueCode,
      input.subject.domain, input.subject.type, input.subject.id, input.ownerDomain,
      definition.owner_roles, NO_ESCALATION_ROLES, input.reasonCode,
      JSON.stringify(input.context), input.dedupeKey, slaDueAt,
    ],
  );
  const row = rows[0]!;
  const created = row.inserted === true;
  await appendAuditEntry({
    organizationId: input.organizationId,
    ...(input.branchId ? { branchId: input.branchId } : {}),
    actor: { serviceIdentity: `domain:${input.ownerDomain}`, roles: [] },
    action: created ? 'EXCEPTION_OPENED' : 'EXCEPTION_UPDATED',
    entity: { domain: 'platform', type: 'ExceptionItem', id: row.id as string, version: row.version as number },
    changes: [{
      path: 'status', classification: 'INTERNAL',
      ...(created ? { after: 'OPEN' } : { before: 'OPEN', after: 'OPEN' }),
    }],
    reasonCode: input.reasonCode,
    requestId: input.requestId, correlationId: input.correlationId,
    causationId: input.requestId, source: 'SYSTEM',
  });
  return { item: toExceptionItem(row), created };
}

const UpdateExceptionSchema = z.strictObject({
  itemId: z.uuid(),
  organizationId: z.uuid(),
  requestId: z.string().min(1),
  correlationId: z.string().min(1),
  context: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
});
export type UpdateExceptionInput = z.input<typeof UpdateExceptionSchema>;

/** DQ-001: adding context and aggregating occurrences, never changing the queue or subject. */
export async function updateException(pool: Pool, rawInput: UpdateExceptionInput): Promise<ExceptionItem> {
  const input = UpdateExceptionSchema.safeParse(rawInput);
  if (!input.success) throw new DomainError('VALIDATION_FAILED');
  return withAuditedTransaction(pool, async ({ client, appendAuditEntry }) => {
    const { rows } = await client.query<Record<string, unknown>>(
      `UPDATE platform.exception_item
       SET context = context || $3::jsonb, version = version + 1, updated_at = now()
       WHERE id = $1 AND organization_id = $2 AND status IN ('OPEN', 'IN_PROGRESS')
       RETURNING ${ITEM_COLUMNS}`,
      [input.data.itemId, input.data.organizationId, JSON.stringify(input.data.context)],
    );
    const row = rows[0];
    if (!row) throw new DomainError('NOT_FOUND');
    await appendAuditEntry({
      organizationId: input.data.organizationId, actor: { serviceIdentity: 'platform.exception', roles: [] },
      action: 'EXCEPTION_UPDATED',
      entity: { domain: 'platform', type: 'ExceptionItem', id: input.data.itemId, version: row.version as number },
      changes: [{ path: 'context', classification: 'INTERNAL', after: JSON.stringify(input.data.context) }],
      requestId: input.data.requestId, correlationId: input.data.correlationId, source: 'SYSTEM',
    });
    return toExceptionItem(row);
  });
}

/** DQ-001.NC03: Platform never reads the identity schema, so the caller passes the decision in. */
export interface ExceptionAuthorization {
  actorId: string;
  organizationId: string;
  branchId: string | null;
  queueCode: string;
  roles: string[];
}

export type AuthorizeException = (request: ExceptionAuthorization) => Promise<boolean>;

const ClaimSchema = z.strictObject({
  itemId: z.uuid(), organizationId: z.uuid(), actorId: z.uuid(),
  roleCodes: z.array(z.string().min(1)).min(1),
  requestId: z.string().min(1), correlationId: z.string().min(1),
});
export type ClaimExceptionInput = z.input<typeof ClaimSchema>;

/** OPEN -> IN_PROGRESS. The row lock makes two claims of the same item resolve to one winner. */
export async function claimExceptionItem(
  pool: Pool, rawInput: ClaimExceptionInput, authorize: AuthorizeException,
): Promise<ExceptionItem> {
  const input = ClaimSchema.safeParse(rawInput);
  if (!input.success) throw new DomainError('VALIDATION_FAILED');
  const data = input.data;
  return withAuditedTransaction(pool, async ({ client, appendAuditEntry }) => {
    const { rows } = await client.query<Record<string, unknown>>(
      `SELECT ${ITEM_COLUMNS} FROM platform.exception_item WHERE id = $1 FOR UPDATE`, [data.itemId],
    );
    const row = rows[0];
    if (!row || row.organization_id !== data.organizationId) throw new DomainError('NOT_FOUND');
    if (row.status !== 'OPEN') throw new DomainError('INVALID_STATE_TRANSITION');
    if (!await authorize({
      actorId: data.actorId, organizationId: data.organizationId,
      branchId: (row.branch_id as string | null) ?? null,
      queueCode: row.queue_code as string, roles: data.roleCodes,
    })) {
      throw new DomainError('PERMISSION_DENIED');
    }
    const version = (row.version as number) + 1;
    const updated = await client.query<Record<string, unknown>>(
      `UPDATE platform.exception_item
       SET status = 'IN_PROGRESS', assignee_id = $2, version = $3, updated_at = now()
       WHERE id = $1 RETURNING ${ITEM_COLUMNS}`, [data.itemId, data.actorId, version],
    );
    await appendAuditEntry({
      organizationId: data.organizationId,
      ...(row.branch_id ? { branchId: row.branch_id as string } : {}),
      actor: { userId: data.actorId, roles: data.roleCodes },
      action: 'EXCEPTION_CLAIMED',
      entity: { domain: 'platform', type: 'ExceptionItem', id: data.itemId, version },
      changes: [{ path: 'status', classification: 'INTERNAL', before: 'OPEN', after: 'IN_PROGRESS' }],
      requestId: data.requestId, correlationId: data.correlationId, source: 'API',
    });
    return toExceptionItem(updated.rows[0]!);
  });
}

const ReleaseSchema = z.strictObject({
  itemId: z.uuid(), organizationId: z.uuid(), actorId: z.uuid(),
  roleCodes: z.array(z.string().min(1)).min(1),
  requestId: z.string().min(1), correlationId: z.string().min(1),
});
export type ReleaseExceptionInput = z.input<typeof ReleaseSchema>;

/** IN_PROGRESS -> OPEN. Only the current assignee releases; anything else is a conflict. */
export async function releaseExceptionItem(
  pool: Pool, rawInput: ReleaseExceptionInput, authorize: AuthorizeException,
): Promise<ExceptionItem> {
  const input = ReleaseSchema.safeParse(rawInput);
  if (!input.success) throw new DomainError('VALIDATION_FAILED');
  const data = input.data;
  return withAuditedTransaction(pool, async ({ client, appendAuditEntry }) => {
    const { rows } = await client.query<Record<string, unknown>>(
      `SELECT ${ITEM_COLUMNS} FROM platform.exception_item WHERE id = $1 FOR UPDATE`, [data.itemId],
    );
    const row = rows[0];
    if (!row || row.organization_id !== data.organizationId) throw new DomainError('NOT_FOUND');
    if (row.status !== 'IN_PROGRESS' || row.assignee_id !== data.actorId) {
      throw new DomainError('INVALID_STATE_TRANSITION');
    }
    if (!await authorize({
      actorId: data.actorId, organizationId: data.organizationId,
      branchId: (row.branch_id as string | null) ?? null,
      queueCode: row.queue_code as string, roles: data.roleCodes,
    })) {
      throw new DomainError('PERMISSION_DENIED');
    }
    const version = (row.version as number) + 1;
    const updated = await client.query<Record<string, unknown>>(
      `UPDATE platform.exception_item
       SET status = 'OPEN', assignee_id = NULL, last_error_message = NULL, version = $2, updated_at = now()
       WHERE id = $1 RETURNING ${ITEM_COLUMNS}`, [data.itemId, version],
    );
    await appendAuditEntry({
      organizationId: data.organizationId,
      ...(row.branch_id ? { branchId: row.branch_id as string } : {}),
      actor: { userId: data.actorId, roles: data.roleCodes },
      action: 'EXCEPTION_RELEASED',
      entity: { domain: 'platform', type: 'ExceptionItem', id: data.itemId, version },
      changes: [{ path: 'status', classification: 'INTERNAL', before: 'IN_PROGRESS', after: 'OPEN' }],
      requestId: data.requestId, correlationId: data.correlationId, source: 'API',
    });
    return toExceptionItem(updated.rows[0]!);
  });
}

const ResolveSchema = z.strictObject({
  itemId: z.uuid(), organizationId: z.uuid(), ownerDomain: z.string().min(1),
  command: z.string().min(1).max(100), result: z.string().min(1).max(2000),
  resolvedBy: z.uuid().optional(),
  requestId: z.string().min(1), correlationId: z.string().min(1),
});
export type ResolveExceptionInput = z.input<typeof ResolveSchema>;

/**
 * DQ-001.BR01 / NC01: only the domain that owns the subject resolves it, and only with the
 * command that actually succeeded. Platform records the fact; it never performs the command
 * and never touches the subject (DQ-001.BR05 / NC02).
 */
export async function resolveException(
  pool: Pool, rawInput: ResolveExceptionInput,
): Promise<ExceptionItem> {
  const input = ResolveSchema.safeParse(rawInput);
  if (!input.success) throw new DomainError('VALIDATION_FAILED');
  const data = input.data;
  return withAuditedTransaction(pool, async ({ client, appendAuditEntry }) => {
    const { rows } = await client.query<Record<string, unknown>>(
      `SELECT ${ITEM_COLUMNS} FROM platform.exception_item WHERE id = $1 FOR UPDATE`, [data.itemId],
    );
    const row = rows[0];
    if (!row || row.organization_id !== data.organizationId) throw new DomainError('NOT_FOUND');
    if (row.owner_domain !== data.ownerDomain) throw new DomainError('PERMISSION_DENIED');
    if (row.status === 'RESOLVED' || row.status === 'DISMISSED') {
      throw new DomainError('INVALID_STATE_TRANSITION');
    }
    const version = (row.version as number) + 1;
    const updated = await client.query<Record<string, unknown>>(
      `UPDATE platform.exception_item
       SET status = 'RESOLVED', resolved_at = now(), resolved_by = $2,
           resolution_command = $3, resolution_result = $4,
           assignee_id = NULL, last_error_message = NULL, version = $5, updated_at = now()
       WHERE id = $1 RETURNING ${ITEM_COLUMNS}`,
      [data.itemId, data.resolvedBy ?? null, data.command, data.result, version],
    );
    await appendAuditEntry({
      organizationId: data.organizationId,
      ...(row.branch_id ? { branchId: row.branch_id as string } : {}),
      actor: {
        ...(data.resolvedBy ? { userId: data.resolvedBy } : {}),
        serviceIdentity: `domain:${data.ownerDomain}`, roles: [],
      },
      action: 'EXCEPTION_RESOLVED',
      entity: { domain: 'platform', type: 'ExceptionItem', id: data.itemId, version },
      changes: [
        { path: 'status', classification: 'INTERNAL', before: row.status as string, after: 'RESOLVED' },
        { path: 'resolutionCommand', classification: 'INTERNAL', after: data.command },
      ],
      requestId: data.requestId, correlationId: data.correlationId,
      causationId: data.requestId, source: 'SYSTEM',
    });
    return toExceptionItem(updated.rows[0]!);
  });
}

const CommandFailureSchema = z.strictObject({
  itemId: z.uuid(), organizationId: z.uuid(), ownerDomain: z.string().min(1),
  message: z.string().min(1).max(500),
  requestId: z.string().min(1), correlationId: z.string().min(1),
});
export type ExceptionCommandFailureInput = z.input<typeof CommandFailureSchema>;

/**
 * DQ-001.AC04: a subject command that failed leaves the item where it was and shows why. The
 * item is never rolled back to OPEN by a failure, and never resolved by one.
 */
export async function recordExceptionCommandFailure(
  pool: Pool, rawInput: ExceptionCommandFailureInput,
): Promise<ExceptionItem> {
  const input = CommandFailureSchema.safeParse(rawInput);
  if (!input.success) throw new DomainError('VALIDATION_FAILED');
  const data = input.data;
  return withAuditedTransaction(pool, async ({ client, appendAuditEntry }) => {
    const { rows } = await client.query<Record<string, unknown>>(
      `UPDATE platform.exception_item
       SET last_error_message = $3, version = version + 1, updated_at = now()
       WHERE id = $1 AND organization_id = $2 AND owner_domain = $4
         AND status IN ('OPEN', 'IN_PROGRESS')
       RETURNING ${ITEM_COLUMNS}`,
      [data.itemId, data.organizationId, data.message, data.ownerDomain],
    );
    const row = rows[0];
    if (!row) throw new DomainError('NOT_FOUND');
    await appendAuditEntry({
      organizationId: data.organizationId, actor: { serviceIdentity: `domain:${data.ownerDomain}`, roles: [] },
      action: 'EXCEPTION_COMMAND_FAILED',
      entity: { domain: 'platform', type: 'ExceptionItem', id: data.itemId, version: row.version as number },
      changes: [{ path: 'lastErrorMessage', classification: 'INTERNAL', after: data.message }],
      requestId: data.requestId, correlationId: data.correlationId, source: 'SYSTEM',
    });
    return toExceptionItem(row);
  });
}

const DismissSchema = z.strictObject({
  itemId: z.uuid(), organizationId: z.uuid(), actorId: z.uuid(),
  roleCodes: z.array(z.string().min(1)).min(1),
  reason: z.string().trim().min(1).max(500),
  requestId: z.string().min(1), correlationId: z.string().min(1),
});
export type DismissExceptionInput = z.input<typeof DismissSchema>;

/**
 * DQ-001.BR04 / AC06: dismissal exists only for a registry queue marked dismissible. No
 * Appendix P queue is marked dismissible, so this is refused rather than half-supported.
 */
export async function dismissException(
  pool: Pool, rawInput: DismissExceptionInput, authorize: AuthorizeException,
): Promise<ExceptionItem> {
  const input = DismissSchema.safeParse(rawInput);
  if (!input.success) throw new DomainError('VALIDATION_FAILED');
  const data = input.data;
  return withAuditedTransaction(pool, async ({ client, appendAuditEntry }) => {
    const { rows } = await client.query<Record<string, unknown>>(
      `SELECT i.${ITEM_COLUMNS.split(', ').join(', i.')}, d.dismissible
       FROM platform.exception_item i JOIN platform.queue_definition d ON d.code = i.queue_code
       WHERE i.id = $1 FOR UPDATE OF i`, [data.itemId],
    );
    const row = rows[0];
    if (!row || row.organization_id !== data.organizationId) throw new DomainError('NOT_FOUND');
    if (row.dismissible !== true) throw new DomainError('INVALID_STATE_TRANSITION');
    if (row.status === 'RESOLVED' || row.status === 'DISMISSED') {
      throw new DomainError('INVALID_STATE_TRANSITION');
    }
    if (!await authorize({
      actorId: data.actorId, organizationId: data.organizationId,
      branchId: (row.branch_id as string | null) ?? null,
      queueCode: row.queue_code as string, roles: data.roleCodes,
    })) {
      throw new DomainError('PERMISSION_DENIED');
    }
    const version = (row.version as number) + 1;
    const updated = await client.query<Record<string, unknown>>(
      `UPDATE platform.exception_item
       SET status = 'DISMISSED', dismissed_at = now(), dismissed_by = $2, dismiss_reason = $3,
           assignee_id = NULL, version = $4, updated_at = now()
       WHERE id = $1 RETURNING ${ITEM_COLUMNS}`, [data.itemId, data.actorId, data.reason, version],
    );
    await appendAuditEntry({
      organizationId: data.organizationId,
      ...(row.branch_id ? { branchId: row.branch_id as string } : {}),
      actor: { userId: data.actorId, roles: data.roleCodes },
      action: 'EXCEPTION_DISMISSED',
      entity: { domain: 'platform', type: 'ExceptionItem', id: data.itemId, version },
      changes: [{ path: 'status', classification: 'INTERNAL', before: row.status as string, after: 'DISMISSED' }],
      reasonCode: data.reason,
      requestId: data.requestId, correlationId: data.correlationId, source: 'API',
    });
    return toExceptionItem(updated.rows[0]!);
  });
}

const ListSchema = z.strictObject({
  organizationId: z.uuid(),
  actorId: z.uuid(),
  roleCodes: z.array(z.string().min(1)).min(1),
  queueCode: z.string().min(1).optional(),
  branchId: z.uuid().optional(),
  statuses: z.array(z.enum(['OPEN', 'IN_PROGRESS'])).min(1).default(['OPEN', 'IN_PROGRESS']),
  overdueOnly: z.boolean().default(false),
  limit: z.int().min(1).max(200).default(50),
});
export type ListExceptionItemsInput = z.input<typeof ListSchema>;

/**
 * DQ-001.R06 / NC03: the role and scope filter is part of the query, so a 100k-item backlog
 * never has to be scanned to decide what one person may see. Branch scope narrows in SQL;
 * anything the caller must still decide (territory, warehouse, own-only) is delegated to
 * `authorize` per row, which is also the check a role-based access layer needs.
 */
export async function listExceptionItems(
  pool: Pool, rawInput: ListExceptionItemsInput, authorize: AuthorizeException,
): Promise<ExceptionItem[]> {
  const input = ListSchema.safeParse(rawInput);
  if (!input.success) throw new DomainError('VALIDATION_FAILED');
  const data = input.data;
  const items: ExceptionItem[] = [];
  const pageSize = 100;
  let cursor: { slaDueAt: Date; id: string } | undefined;
  for (;;) {
    const { rows } = await pool.query<Record<string, unknown>>(
      `SELECT ${ITEM_COLUMNS} FROM platform.exception_item
       WHERE organization_id = $1
         AND status = ANY ($2::text[])
         AND (owner_roles && $3::text[] OR escalation_roles && $3::text[])
         AND ($4::text IS NULL OR queue_code = $4)
         AND ($5::uuid IS NULL OR branch_id = $5)
         AND ($6::boolean = false OR sla_due_at <= now())
         AND ($7::timestamptz IS NULL OR (sla_due_at, id) > ($7::timestamptz, $8::uuid))
       ORDER BY sla_due_at, id LIMIT 100`,
      [data.organizationId, data.statuses, data.roleCodes, data.queueCode ?? null,
        data.branchId ?? null, data.overdueOnly, cursor?.slaDueAt ?? null, cursor?.id ?? null],
    );
    for (const row of rows) {
      cursor = { slaDueAt: row.sla_due_at as Date, id: row.id as string };
      if (!await authorize({
        actorId: data.actorId, organizationId: data.organizationId,
        branchId: (row.branch_id as string | null) ?? null,
        queueCode: row.queue_code as string, roles: data.roleCodes,
      })) continue;
      items.push(toExceptionItem(row));
      if (items.length >= data.limit) return items;
    }
    if (rows.length < pageSize) return items;
  }
}

export interface QueueDefinitionView {
  code: string;
  label: string;
  ownerRoles: string[];
  escalationRoles: string[];
  permittedActions: string[];
  dismissible: boolean;
  slaConfigured: boolean;
}

const PERMITTED_ACTIONS: z.ZodType<string[]> = z.array(z.string().min(1));

/** The registry the queue screen and the owner-role routing read (DQ-001.R01). */
export async function listQueueDefinitions(pool: Pool): Promise<QueueDefinitionView[]> {
  const { rows } = await pool.query<{
    code: string; label: string; owner_roles: string[]; escalation_roles: string[];
    permitted_actions: string[]; dismissible: boolean; sla_configured: boolean;
  }>(
    `SELECT code, label, owner_roles, escalation_roles, permitted_actions, dismissible,
            (sla_value IS NOT NULL OR sla_config_key IS NOT NULL) AS sla_configured
     FROM platform.queue_definition WHERE active ORDER BY code`,
  );
  return rows.map((row) => ({
    code: row.code, label: row.label, ownerRoles: row.owner_roles,
    escalationRoles: row.escalation_roles,
    permittedActions: PERMITTED_ACTIONS.parse(row.permitted_actions),
    dismissible: row.dismissible, slaConfigured: row.sla_configured,
  }));
}

export interface QueueSlaMetrics {
  queueCode: string;
  open: number;
  overdue: number;
  resolved: number;
  /** Median and 95th percentile resolution time in minutes, or null while nothing is resolved. */
  resolutionMinutesP50: number | null;
  resolutionMinutesP95: number | null;
}

/** DQ-001.R04: backlog, overdue, and resolution time per queue. */
export async function exceptionQueueMetrics(pool: Pool): Promise<QueueSlaMetrics[]> {
  const { rows } = await pool.query<{
    queue_code: string; open: number; overdue: number; resolved: number;
    p50: number | null; p95: number | null;
  }>(
    `SELECT queue_code,
            count(*) FILTER (WHERE status IN ('OPEN', 'IN_PROGRESS'))::int AS open,
            count(*) FILTER (WHERE status IN ('OPEN', 'IN_PROGRESS') AND sla_due_at <= now())::int AS overdue,
            count(*) FILTER (WHERE status = 'RESOLVED')::int AS resolved,
            percentile_cont(0.5) WITHIN GROUP (
              ORDER BY extract(epoch FROM (resolved_at - created_at)) / 60
            ) FILTER (WHERE status = 'RESOLVED') AS p50,
            percentile_cont(0.95) WITHIN GROUP (
              ORDER BY extract(epoch FROM (resolved_at - created_at)) / 60
            ) FILTER (WHERE status = 'RESOLVED') AS p95
     FROM platform.exception_item
     GROUP BY queue_code ORDER BY queue_code`,
  );
  return rows.map((row) => ({
    queueCode: row.queue_code, open: row.open, overdue: row.overdue, resolved: row.resolved,
    resolutionMinutesP50: row.p50 === null ? null : Math.round(Number(row.p50)),
    resolutionMinutesP95: row.p95 === null ? null : Math.round(Number(row.p95)),
  }));
}

/** Records the non-working dates an operations owner loads into `platform.business_calendar_day`. */
export async function registerBusinessCalendarDay(
  pool: Pool, input: {
    id?: string; calendarDate: string; organizationId?: string; branchId?: string;
    isWorking: boolean; source: 'NATIONAL_HOLIDAY' | 'BRANCH_CLOSED' | 'OPEN';
  },
): Promise<void> {
  const parsed = z.strictObject({
    id: z.uuid().optional(), calendarDate: z.iso.date(),
    organizationId: z.uuid().optional(), branchId: z.uuid().optional(),
    isWorking: z.boolean(), source: z.enum(['NATIONAL_HOLIDAY', 'BRANCH_CLOSED', 'OPEN']),
  }).safeParse(input);
  if (!parsed.success) throw new DomainError('VALIDATION_FAILED');
  await pool.query(
    `INSERT INTO platform.business_calendar_day (
       id, calendar_date, organization_id, branch_id, is_working, source
     ) VALUES ($1, $2::date, $3, $4, $5, $6)
     ON CONFLICT (calendar_date, coalesce(organization_id, '00000000-0000-0000-0000-000000000000'::uuid),
                             coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid))
     DO UPDATE SET is_working = EXCLUDED.is_working, source = EXCLUDED.source`,
    [parsed.data.id ?? randomUUID(), parsed.data.calendarDate, parsed.data.organizationId ?? null,
      parsed.data.branchId ?? null, parsed.data.isWorking, parsed.data.source],
  );
}

export const EXCEPTION_BUSINESS_TIME_ZONE = BUSINESS_TIME_ZONE;

const EscalateSchema = z.strictObject({
  serviceIdentity: z.string().min(1).max(200),
  requestId: z.string().min(1),
  correlationId: z.string().min(1),
  batchSize: z.int().min(1).max(1000).default(200),
});
export type EscalateOverdueInput = z.input<typeof EscalateSchema>;

export interface EscalateOverdueResult {
  escalated: Array<{ itemId: string; queueCode: string; escalationRoles: string[] }>;
}

/**
 * DQ-001.AC05 first half: an item past its SLA becomes overdue, and the registry's escalation
 * roles join the roles that can see it (DQ-001.BR06). Overdue only ever widens visibility, so
 * the sweep is safe to re-run. The overdue notification itself belongs to NTF-001 and is not
 * sent from here; nothing is marked notified.
 */
export async function escalateOverdueExceptions(
  pool: Pool, rawInput: EscalateOverdueInput,
): Promise<EscalateOverdueResult> {
  const input = EscalateSchema.safeParse(rawInput);
  if (!input.success) throw new DomainError('VALIDATION_FAILED');
  const data = input.data;
  const due = await pool.query<{ id: string }>(
    `SELECT id FROM platform.exception_item
     WHERE status IN ('OPEN', 'IN_PROGRESS') AND overdue_at IS NULL AND sla_due_at <= now()
     ORDER BY sla_due_at, id LIMIT $1`, [data.batchSize],
  );
  if (due.rowCount === 0) return { escalated: [] };
  return withAuditedTransaction(pool, async ({ client, appendAuditEntry }) => {
    const { rows } = await client.query<{
      id: string; organization_id: string; branch_id: string | null; queue_code: string;
      escalation_roles: string[]; version: number;
    }>(
      `UPDATE platform.exception_item i
       SET overdue_at = now(),
           escalated_at = now(),
           escalation_roles = i.escalation_roles || d.escalation_roles,
           version = i.version + 1,
           updated_at = now()
       FROM platform.queue_definition d
       WHERE i.id = ANY($1::uuid[]) AND i.overdue_at IS NULL AND d.code = i.queue_code
       RETURNING i.id, i.organization_id, i.branch_id, i.queue_code, i.escalation_roles, i.version`,
      [due.rows.map((row) => row.id)],
    );
    for (const row of rows) {
      await appendAuditEntry({
        organizationId: row.organization_id,
        ...(row.branch_id ? { branchId: row.branch_id } : {}),
        actor: { serviceIdentity: data.serviceIdentity, roles: [] },
        action: 'EXCEPTION_ESCALATED',
        entity: { domain: 'platform', type: 'ExceptionItem', id: row.id, version: row.version },
        changes: [{ path: 'overdueAt', classification: 'INTERNAL', after: 'now' }],
        requestId: data.requestId, correlationId: data.correlationId, source: 'SYSTEM',
      });
    }
    return { escalated: rows.map((row) => ({
      itemId: row.id, queueCode: row.queue_code, escalationRoles: row.escalation_roles,
    })) };
  });
}
