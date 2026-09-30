import { DomainError, type CurrentUserResponse } from '@pss/contracts';
import { hashRequestBody } from '@pss/http';
import { checkAccess, loadActiveRoleAssignments, requireAccess, resolveRolePermissions, type RoleAssignment } from '@pss/identity';
import { z } from 'zod';
import { requestContextFrom, type ObservedRequest } from '@pss/observability';
import { IdempotencyError, runCommand } from '@pss/platform';
import type { Pool, PoolClient } from 'pg';

/** The resolved caller of one API request: identity, live role assignments, and trace ids. */
export interface CommandContext {
  user: CurrentUserResponse;
  assignments: RoleAssignment[];
  requestId: string;
  correlationId: string;
}

export async function commandContext(pool: Pool, user: CurrentUserResponse, request: ObservedRequest): Promise<CommandContext> {
  const { requestId, correlationId } = requestContextFrom(request);
  return { user, assignments: await loadActiveRoleAssignments(pool, user.id), requestId, correlationId };
}

/** The audit/request fields every domain command takes, derived from the caller, never from the body. */
export function commandMeta(context: CommandContext) {
  return {
    actor: { userId: context.user.id, roles: [...new Set(context.assignments.map((assignment) => assignment.roleCode))] },
    requestId: context.requestId, correlationId: context.correlationId, source: 'WEB' as const,
  };
}

/** A canonical record's owners, as resolved from its own domain, never from the request. */
export interface Scoped { organizationId: string; branchId?: string; warehouseId?: string }

export function uuidParam(value: string, path: string): string {
  if (!z.uuid().safeParse(value).success) {
    throw new DomainError('VALIDATION_FAILED', [], [{ path, code: 'invalid_format', message: 'Periksa nilai ini.' }]);
  }
  return value;
}

/** A record outside the caller's organization is reported as absent, never as forbidden. */
export function inOrganization<T extends { organizationId: string }>(context: CommandContext, record: T | null): T {
  if (!record || record.organizationId !== context.user.organizationId) throw new DomainError('NOT_FOUND');
  return record;
}

function resourceOf(scope: Scoped) {
  return {
    organizationId: scope.organizationId,
    ...(scope.branchId ? { branchId: scope.branchId } : {}),
    ...(scope.warehouseId ? { warehouseId: scope.warehouseId } : {}),
  };
}

/** RBAC-002: the permission at the record's own scope. A read outside it is NOT_FOUND; a mutation, PERMISSION_DENIED. */
export function authorizeAt(context: CommandContext, permission: string, scope: Scoped, isRead = false): void {
  requireAccess({
    actorId: context.user.id, organizationId: context.user.organizationId, assignments: context.assignments, permission,
    resource: resourceOf(scope),
  }, isRead);
}

export function canAt(context: CommandContext, permission: string, scope: Scoped): boolean {
  return checkAccess({
    actorId: context.user.id, organizationId: context.user.organizationId, assignments: context.assignments, permission,
    resource: resourceOf(scope),
  });
}

/** For a read that is not yet about one record (the caller's own shift, a list scoped in SQL). */
export function requireHeldPermission(context: CommandContext, permission: string): void {
  if (!context.assignments.some((assignment) => resolveRolePermissions(assignment.roleCode).permissions.includes(permission))) {
    throw new DomainError('PERMISSION_DENIED');
  }
}

/**
 * ADR-0013: run a retriable mutation once under the caller's Idempotency-Key. The mutation, its
 * audit entry and its outbox events commit in one transaction; a retry replays the stored answer.
 */
export async function runApiCommand<T>(
  pool: Pool, context: CommandContext, commandName: string, idempotencyKey: string, requestBody: unknown,
  execute: (client: PoolClient) => Promise<T>,
): Promise<T> {
  try {
    const result = await runCommand(
      pool,
      {
        organizationId: context.user.organizationId, identityId: context.user.id, commandName,
        key: idempotencyKey, requestHash: hashRequestBody(requestBody),
      },
      async ({ client }) => ({ code: 200, body: await execute(client) }),
    );
    return result.body as T;
  } catch (error) {
    if (error instanceof IdempotencyError) throw new DomainError(error.code);
    throw error;
  }
}
