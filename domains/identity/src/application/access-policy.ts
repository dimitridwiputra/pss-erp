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

export function requireAccess(request: AccessRequest, isRead = false): void {
  if (!checkAccess(request)) throw new DomainError(isRead ? 'NOT_FOUND' : 'PERMISSION_DENIED');
}

export async function loadActiveRoleAssignments(pool: Pool, userId: string): Promise<RoleAssignment[]> {
  const result = await pool.query<{
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
