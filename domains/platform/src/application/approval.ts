import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { runAuditedWork, withAuditedTransaction } from '@pss/audit';
import { ApprovalTypeCodeSchema, DomainError, FinanceApprovalSubmittedV1Schema, newEventId } from '@pss/contracts';
import { appendOutboxEvent } from './outbox';
import { withInbox, type ConsumerInbox } from './inbox';

const RequestApprovalSchema = z.strictObject({
  organizationId: z.uuid(), branchId: z.uuid().optional(),
  typeCode: z.string().min(1), ownerDomain: z.string().min(1), subjectRef: z.string().min(1),
  requesterId: z.uuid(), amount: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
  summary: z.string().trim().min(1).max(200), businessDate: z.iso.date(),
  requestId: z.string().min(1),
  subjectType: z.string().min(1).optional(), subjectVersion: z.int().positive().optional(),
  contextHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  causationId: z.string().min(1).optional(),
});
export type RequestApprovalInput = z.input<typeof RequestApprovalSchema>;

const DecideApprovalSchema = z.strictObject({
  approvalId: z.uuid(), organizationId: z.uuid(), actorId: z.uuid(),
  decision: z.enum(['APPROVED', 'REJECTED']), reason: z.string().trim().max(500).optional(),
  businessDate: z.iso.date(), requestId: z.string().min(1),
});
export type DecideApprovalInput = z.input<typeof DecideApprovalSchema>;

export interface ApprovalAuthorization {
  actorId: string;
  organizationId: string;
  branchId: string | null;
  permission: string;
  roleCode: string;
  onBehalfOf?: string;
}

export type AuthorizeApproval = (request: ApprovalAuthorization) => Promise<boolean>;

/** The owning domain calls this command; only Platform writes the approval aggregate. */
export async function requestApproval(pool: Pool, rawInput: RequestApprovalInput) {
  const parsed = RequestApprovalSchema.safeParse(rawInput);
  if (!parsed.success) throw new DomainError('VALIDATION_FAILED');
  const input = parsed.data;
  return withAuditedTransaction(pool, async ({ client, appendAuditEntry }) =>
    requestApprovalWork(client, appendAuditEntry, input));
}

async function requestApprovalWork(client: PoolClient,
  appendAuditEntry: Parameters<Parameters<typeof withAuditedTransaction>[1]>[0]['appendAuditEntry'],
  input: z.infer<typeof RequestApprovalSchema>) {
    if (input.subjectVersion !== undefined) {
      if (!ApprovalTypeCodeSchema.safeParse(input.typeCode).success || !z.uuid().safeParse(input.requestId).success) {
        throw new DomainError('VALIDATION_FAILED');
      }
      const existing = (await client.query<{ id: string }>(
        `SELECT id FROM platform.approval_request WHERE organization_id = $1 AND type_code = $2
         AND owner_domain = $3 AND subject_ref = $4 AND subject_version = $5`,
        [input.organizationId, input.typeCode, input.ownerDomain, input.subjectRef, input.subjectVersion],
      )).rows[0];
      if (existing) {
        if (existing.id !== input.requestId) throw new DomainError('STALE_DATA');
        return { id: existing.id, status: 'PENDING' as const };
      }
    }
    const type = (await client.query<{
      code: string; owner_domain: string; expiry_hours: number;
    }>('SELECT code, owner_domain, expiry_hours FROM platform.approval_type WHERE code = $1', [input.typeCode])).rows[0];
    if (!type || type.owner_domain !== input.ownerDomain) throw new DomainError('APPROVAL_TYPE_UNKNOWN');
    const policy = (await client.query<{ id: string }>(
      `SELECT id FROM platform.approval_policy
       WHERE type_code = $1 AND status = 'ACTIVE' AND effective_from <= $2::date
         AND (effective_to IS NULL OR effective_to > $2::date)
       ORDER BY effective_from DESC LIMIT 1`, [input.typeCode, input.businessDate],
    )).rows[0];
    if (!policy) throw new DomainError('APPROVAL_TYPE_UNKNOWN');
    const levels = (await client.query<{
      level: number; role_code: string; permission_code: string; fits: boolean;
    }>(
      `SELECT level, role_code, permission_code,
              (max_amount IS NOT NULL AND $2::numeric IS NOT NULL AND $2::numeric <= max_amount) AS fits
       FROM platform.approval_level WHERE policy_id = $1 ORDER BY level`,
      [policy.id, input.amount ?? null],
    )).rows;
    if (levels.length === 0) throw new DomainError('APPROVAL_TYPE_UNKNOWN');
    // An unset threshold is deliberately not zero: choose the highest authority.
    const level = levels.find((entry) => entry.fits) ?? levels.at(-1)!;
    const approvalId = input.subjectVersion === undefined ? randomUUID() : input.requestId;
    const inserted = await client.query<{ expires_at: Date }>(
      `INSERT INTO platform.approval_request (
         id, organization_id, branch_id, type_code, policy_id, owner_domain, subject_ref,
         requester_id, amount, summary, status, level, required_role, permission_code, expires_at,
         subject_type, subject_version, context_hash
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'PENDING',$11,$12,$13,now() + make_interval(hours => $14),$15,$16,$17)
       RETURNING expires_at`,
      [approvalId, input.organizationId, input.branchId ?? null, input.typeCode, policy.id,
        input.ownerDomain, input.subjectRef, input.requesterId, input.amount ?? null, input.summary,
        level.level, level.role_code, level.permission_code, type.expiry_hours,
        input.subjectType ?? null, input.subjectVersion ?? null, input.contextHash ?? null],
    );
    if (input.subjectVersion !== undefined) {
      await client.query(
        `INSERT INTO platform.approval_step (request_id, level, status) VALUES ($1,$2,'PENDING')`,
        [approvalId, level.level],
      );
    }
    await appendAuditEntry({
      organizationId: input.organizationId, branchId: input.branchId,
      actor: { userId: input.requesterId, roles: [] },
      action: 'APPROVAL_REQUESTED',
      entity: { domain: 'platform', type: 'ApprovalRequest', id: approvalId, version: 1 },
      changes: [{ path: 'status', classification: 'INTERNAL', after: 'PENDING' }],
      requestId: input.requestId, correlationId: input.requestId,
      ...(input.causationId ? { causationId: input.causationId } : {}),
      source: input.causationId ? 'SYSTEM' : 'API',
    });
    await appendOutboxEvent(client, {
      eventId: newEventId(), eventType: 'APPROVAL_REQUESTED', eventVersion: input.subjectVersion === undefined ? 1 : 2,
      occurredAt: new Date().toISOString(), businessDate: input.businessDate,
      organizationId: input.organizationId,
      ...(input.branchId ? { branchId: input.branchId } : {}),
      aggregateType: 'ApprovalRequest', aggregateId: approvalId, aggregateVersion: 1,
      producer: 'approval', actor: { userId: input.requesterId, roles: [] },
      correlationId: input.requestId, causationId: input.causationId ?? input.requestId,
      payload: input.subjectVersion === undefined
        ? { requestId: approvalId, type: input.typeCode, subjectRef: input.subjectRef,
          ownerDomain: input.ownerDomain, decision: 'PENDING' }
        : { requestId: approvalId, type: input.typeCode, subjectType: input.subjectType!,
          subjectRef: input.subjectRef, subjectVersion: input.subjectVersion,
          ownerDomain: input.ownerDomain, decision: 'PENDING' },
    });
    return { id: approvalId, status: 'PENDING' as const, level: level.level,
      requiredRole: level.role_code, expiresAt: inserted.rows[0]!.expires_at.toISOString() };
}

const approvalSubmissionInbox: ConsumerInbox = {
  reserve: async (client, eventId) => (await client.query(
    'INSERT INTO platform.approval_inbox (event_id) VALUES ($1) ON CONFLICT DO NOTHING', [eventId],
  )).rowCount === 1,
};

/** Platform consumes an owner request only after the owner transaction has committed. */
export async function processFinanceApprovalSubmission(pool: Pool, rawEvent: unknown) {
  const parsed = FinanceApprovalSubmittedV1Schema.parse(rawEvent);
  if (parsed.payload.ownerDomain !== 'finance') throw new DomainError('VALIDATION_FAILED');
  return withInbox(pool, approvalSubmissionInbox, parsed, async (client, event) => {
    const payload = FinanceApprovalSubmittedV1Schema.parse(event).payload;
    return runAuditedWork(client, async ({ appendAuditEntry }) => requestApprovalWork(client, appendAuditEntry,
      RequestApprovalSchema.parse({
        organizationId: event.organizationId,
        ...(payload.scopeType === 'BRANCH' ? { branchId: payload.scopeId } : {}),
        typeCode: payload.type, ownerDomain: payload.ownerDomain,
        subjectType: payload.subjectType, subjectRef: payload.subjectRef,
        subjectVersion: payload.subjectVersion, contextHash: payload.contextHash,
        requesterId: payload.requestedBy, amount: payload.amount, summary: payload.summary,
        businessDate: event.businessDate, requestId: payload.requestId,
        causationId: event.eventId,
      })));
  });
}

/** Decisions are serialized by row lock; a final request cannot be decided twice. */
export async function decideApproval(pool: Pool, rawInput: DecideApprovalInput, authorize: AuthorizeApproval) {
  const parsed = DecideApprovalSchema.safeParse(rawInput);
  if (!parsed.success) throw new DomainError('VALIDATION_FAILED');
  const input = parsed.data;
  return withAuditedTransaction(pool, async ({ client, appendAuditEntry }) => {
    const approval = (await client.query<{
      organization_id: string; branch_id: string | null; type_code: string; owner_domain: string;
      subject_ref: string; subject_type: string | null; subject_version: number | null;
      requester_id: string; status: string; version: number; level: number;
      required_role: string; permission_code: string; expires_at: Date; delegation_allowed: boolean;
      reason_required: boolean;
    }>(
      `SELECT r.*, t.delegation_allowed, t.reason_required FROM platform.approval_request r
       JOIN platform.approval_type t ON t.code = r.type_code WHERE r.id = $1 FOR UPDATE OF r`,
      [input.approvalId],
    )).rows[0];
    if (!approval || approval.organization_id !== input.organizationId) throw new DomainError('NOT_FOUND');
    if (approval.status !== 'PENDING') throw new DomainError('STALE_DATA');
    if (approval.expires_at.getTime() <= Date.now()) throw new DomainError('INVALID_STATE_TRANSITION');
    if (input.actorId === approval.requester_id) throw new DomainError('SEGREGATION_OF_DUTIES');
    if ((input.decision === 'REJECTED' || approval.reason_required) && !input.reason) {
      throw new DomainError('VALIDATION_FAILED');
    }
    const permission = {
      actorId: input.actorId, organizationId: input.organizationId,
      branchId: approval.branch_id, permission: approval.permission_code, roleCode: approval.required_role,
    };
    let onBehalfOf: string | undefined;
    if (!await authorize(permission)) {
      if (!approval.delegation_allowed) throw new DomainError('PERMISSION_DENIED');
      const delegations = (await client.query<{ delegator_id: string }>(
        `SELECT delegator_id FROM platform.approval_delegation
         WHERE organization_id = $1 AND delegate_id = $2 AND type_code = $3
           AND branch_id IS NOT DISTINCT FROM $4::uuid AND revoked_at IS NULL
           AND valid_from <= now() AND valid_to > now() ORDER BY valid_from DESC`,
        [input.organizationId, input.actorId, approval.type_code, approval.branch_id],
      )).rows;
      for (const delegation of delegations) {
        if (delegation.delegator_id === approval.requester_id) continue;
        if (await authorize({ ...permission, onBehalfOf: delegation.delegator_id })) {
          onBehalfOf = delegation.delegator_id;
          break;
        }
      }
      if (!onBehalfOf) throw new DomainError('PERMISSION_DENIED');
    }
    const version = approval.version + 1;
    await client.query(
      `UPDATE platform.approval_request SET status = $1, decided_by = $2,
         decided_at = now(), decision_reason = $3, version = $4, updated_at = now() WHERE id = $5`,
      [input.decision, input.actorId, input.reason ?? null, version, input.approvalId],
    );
    if (approval.subject_version !== null) {
      await client.query(
        `UPDATE platform.approval_step SET status = $2, decided_by = $3, decided_at = now(), reason = $4
         WHERE request_id = $1 AND level = $5 AND status = 'PENDING'`,
        [input.approvalId, input.decision, input.actorId, input.reason ?? null, approval.level],
      );
    }
    await appendAuditEntry({
      organizationId: input.organizationId,
      ...(approval.branch_id ? { branchId: approval.branch_id } : {}),
      actor: { userId: input.actorId, roles: [], ...(onBehalfOf ? { onBehalfOf } : {}) },
      action: 'APPROVAL_DECIDED',
      entity: { domain: 'platform', type: 'ApprovalRequest', id: input.approvalId, version },
      changes: [{ path: 'status', classification: 'INTERNAL', before: 'PENDING', after: input.decision }],
      reasonCode: input.reason,
      requestId: input.requestId, correlationId: input.requestId, source: 'API',
    });
    await appendOutboxEvent(client, {
      eventId: newEventId(), eventType: 'APPROVAL_DECIDED', eventVersion: approval.subject_version === null ? 1 : 2,
      occurredAt: new Date().toISOString(), businessDate: input.businessDate,
      organizationId: input.organizationId,
      ...(approval.branch_id ? { branchId: approval.branch_id } : {}),
      aggregateType: 'ApprovalRequest', aggregateId: input.approvalId, aggregateVersion: version,
      producer: 'approval', actor: { userId: input.actorId, roles: [], ...(onBehalfOf ? { onBehalfOf } : {}) },
      correlationId: input.requestId, causationId: input.requestId,
      payload: approval.subject_version === null
        ? { requestId: input.approvalId, type: approval.type_code, subjectRef: approval.subject_ref,
          ownerDomain: approval.owner_domain, decision: input.decision, decidedBy: input.actorId, level: approval.level }
        : { requestId: input.approvalId, type: approval.type_code, subjectType: approval.subject_type!,
          subjectRef: approval.subject_ref, subjectVersion: approval.subject_version,
          ownerDomain: approval.owner_domain, decision: input.decision, decidedBy: input.actorId,
          ...(input.reason ? { reason: input.reason } : {}), step: approval.level },
    });
    return { id: input.approvalId, status: input.decision, version };
  });
}

export async function listPendingApprovals(
  pool: Pool, organizationId: string, actorId: string, authorize: AuthorizeApproval, limit = 50,
) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new DomainError('VALIDATION_FAILED');
  const items: Array<{
    id: string; typeCode: string; summary: string; amount: string | null;
    branchId: string | null; expiresAt: string; requiredRole: string;
  }> = [];
  let cursor: { createdAt: Date; id: string } | undefined;
  for (;;) {
    const rows = (await pool.query<{
      id: string; type_code: string; summary: string; amount: string | null;
      branch_id: string | null; expires_at: Date; created_at: Date;
      required_role: string; permission_code: string;
    }>(
      `SELECT id, type_code, summary, amount, branch_id, expires_at, created_at,
              required_role, permission_code
       FROM platform.approval_request
       WHERE organization_id = $1 AND status = 'PENDING' AND expires_at > now()
         AND ($2::timestamptz IS NULL OR (created_at, id) > ($2::timestamptz, $3::uuid))
       ORDER BY created_at, id LIMIT 100`,
      [organizationId, cursor?.createdAt ?? null, cursor?.id ?? null],
    )).rows;
    for (const row of rows) {
      cursor = { createdAt: row.created_at, id: row.id };
      if (!await authorize({ actorId, organizationId, branchId: row.branch_id,
        permission: row.permission_code, roleCode: row.required_role })) continue;
      items.push({ id: row.id, typeCode: row.type_code, summary: row.summary,
        amount: row.amount, branchId: row.branch_id,
        expiresAt: row.expires_at.toISOString(), requiredRole: row.required_role });
      if (items.length >= limit) return items;
    }
    if (rows.length < 100) return items;
  }
}
