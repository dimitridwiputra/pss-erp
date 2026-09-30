import { DomainError, registryCatalog } from '@pss/contracts';
import type { Pool } from 'pg';
import { isRegisteredRole, resolveRolePermissions } from '../domain/role-permissions';

export type ScopeType = 'ORGANIZATION' | 'BRANCH' | 'WAREHOUSE' | 'TERRITORY' |
  'PRINCIPAL' | 'CUSTOMER' | 'SALES_TEAM' | 'OWN';

export interface RoleAssignment {
  roleCode: string;
  scopeType: ScopeType;
  scopeId: string | null;
}

export interface ScopedResource {
  organizationId: string;
  branchId?: string;
  warehouseId?: string;
  territoryId?: string;
  principalId?: string;
  customerId?: string;
  salesTeamId?: string;
  ownerId?: string;
}

export interface AccessRequest {
  actorId: string;
  organizationId: string;
  assignments: readonly RoleAssignment[];
  permission: string;
  resource: ScopedResource;
  allowedByState?: boolean;
}

function matchesScope(assignment: RoleAssignment, request: AccessRequest): boolean {
  const { resource } = request;
  if (resource.organizationId !== request.organizationId) return false;
  switch (assignment.scopeType) {
    case 'ORGANIZATION': return assignment.scopeId === request.organizationId;
    case 'BRANCH': return assignment.scopeId === resource.branchId;
    case 'WAREHOUSE': return assignment.scopeId === resource.warehouseId;
    case 'TERRITORY': return assignment.scopeId === resource.territoryId;
    case 'PRINCIPAL': return assignment.scopeId === resource.principalId;
    case 'CUSTOMER': return assignment.scopeId === resource.customerId;
    case 'SALES_TEAM': return assignment.scopeId === resource.salesTeamId;
    case 'OWN': return assignment.scopeId === null && resource.ownerId === request.actorId;
  }
}

function roleAllowsScope(roleCode: string, scopeType: ScopeType): boolean {
  const role = registryCatalog.roles.find((entry) => entry.code === roleCode);
  if (!role) return false;
  const declared = role.defaultScope.toUpperCase();
  if (declared === 'TEKNIS') return scopeType === 'ORGANIZATION';
  return declared.includes(scopeType === 'ORGANIZATION' ? 'ORG' : scopeType);
}

/** The caller supplies canonical resource attributes, never request-body scope. */
export function checkAccess(request: AccessRequest): boolean {
  if (request.allowedByState === false) return false;
  return request.assignments.some((assignment) =>
    isRegisteredRole(assignment.roleCode) &&
    roleAllowsScope(assignment.roleCode, assignment.scopeType) &&
    resolveRolePermissions(assignment.roleCode).permissions.includes(request.permission) &&
    matchesScope(assignment, request));
}

/**
 * For a list query: the concrete branch or warehouse ids where `permission` is held, or `all` when an
 * organization-wide assignment grants it. The same rules as `checkAccess` apply (registered role,
 * declared permission, role-compatible scope), so a list scoped by this never shows a row that
 * `checkAccess` would refuse on its own record. Other scope types grant nothing here.
 */
export function scopeIdsFor(
  assignments: readonly RoleAssignment[], organizationId: string, permission: string, scopeType: 'BRANCH' | 'WAREHOUSE',
): { all: boolean; ids: string[] } {
  const granting = assignments.filter((assignment) =>
    isRegisteredRole(assignment.roleCode) &&
    roleAllowsScope(assignment.roleCode, assignment.scopeType) &&
    resolveRolePermissions(assignment.roleCode).permissions.includes(permission));
  const all = granting.some((assignment) => assignment.scopeType === 'ORGANIZATION' && assignment.scopeId === organizationId);
  const ids = [...new Set(granting.filter((assignment) => assignment.scopeType === scopeType && assignment.scopeId)
    .map((assignment) => assignment.scopeId as string))];
  return { all, ids };
}

export function requireAccess(request: AccessRequest, isRead = false): void {
  if (!checkAccess(request)) throw new DomainError(isRead ? 'NOT_FOUND' : 'PERMISSION_DENIED');
}

export async function loadActiveRoleAssignments(executor: Pick<Pool, 'query'>, userId: string): Promise<RoleAssignment[]> {
  const result = await executor.query<{
    role_code: string;
    scope_type: ScopeType;
    scope_id: string | null;
  }>(
    `SELECT role_code, scope_type, scope_id FROM identity.role_assignment
     WHERE user_id = $1 AND revoked_at IS NULL AND effective_at <= now()
       AND (expires_at IS NULL OR expires_at > now())`,
    [userId],
  );
  return result.rows.map((row) => ({
    roleCode: row.role_code,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
  }));
}
