import { describe, expect, it } from 'vitest';
import { checkAccess, requireAccess, type RoleAssignment } from '../src/application/access-policy';
import { resolveRolePermissions } from '../src/domain/role-permissions';

const actorId = '00000000-0000-4000-8000-000000000001';
const organizationId = '00000000-0000-4000-8000-000000000002';
const branchId = '00000000-0000-4000-8000-000000000003';
const otherBranchId = '00000000-0000-4000-8000-000000000004';
const assignment: RoleAssignment = { roleCode: 'SALES_ADMIN', scopeType: 'BRANCH', scopeId: branchId };

describe('RBAC-002 scoped access decision', () => {
  it('RBAC-002.TS01 grants only a declared permission in the assigned branch', () => {
    const request = {
      actorId, organizationId, assignments: [assignment],
      permission: 'orders.order.create',
      resource: { organizationId, branchId },
    };
    expect(checkAccess(request)).toBe(true);
    expect(checkAccess({ ...request, resource: { organizationId, branchId: otherBranchId } })).toBe(false);
    expect(checkAccess({ ...request, resource: { organizationId: otherBranchId, branchId } })).toBe(false);
    expect(checkAccess({ ...request, permission: 'payments.payment.verify' })).toBe(false);
    expect(checkAccess({ ...request, allowedByState: false })).toBe(false);
  });

  it('RBAC-002.BR01 limits OWN grants to the assigned actor', () => {
    const request = {
      actorId, organizationId,
      assignments: [{ roleCode: 'DRIVER', scopeType: 'OWN' as const, scopeId: null }],
      permission: 'payments.evidence.record',
      resource: { organizationId, ownerId: actorId },
    };
    expect(checkAccess(request)).toBe(true);
    expect(checkAccess({ ...request, resource: { organizationId, ownerId: otherBranchId } })).toBe(false);
  });

  it('RBAC-001.BR01 denies unknown roles, absent assignments, and incompatible scope types', () => {
    const base = { actorId, organizationId, permission: 'orders.order.create', resource: { organizationId, branchId } };
    expect(checkAccess({ ...base, assignments: [] })).toBe(false);
    expect(checkAccess({ ...base, assignments: [{ ...assignment, roleCode: 'UNKNOWN' }] })).toBe(false);
    expect(checkAccess({ ...base, assignments: [{ ...assignment, scopeType: 'ORGANIZATION', scopeId: organizationId }] })).toBe(false);
    expect(() => requireAccess({ ...base, assignments: [] })).toThrowError('PERMISSION_DENIED');
    expect(() => requireAccess({ ...base, assignments: [] }, true)).toThrowError('NOT_FOUND');
  });

  it('RBAC-001.NC01 never grants business mutation or finance approval to System Admin', () => {
    const permissions = resolveRolePermissions('SYSTEM_ADMIN').permissions;
    expect(permissions).toContain('identity.user.manage');
    expect(permissions).not.toContain('finance.journal.approve');
    expect(permissions).not.toContain('payments.payment.verify');
    expect(permissions.every((permission) => !permission.endsWith('.approve') && !permission.startsWith('payments.') && !permission.startsWith('finance.journal.'))).toBe(true);
  });

  it('RBAC-001.TS01 does not turn undefined Appendix D groups into wildcard grants', () => {
    const grants = resolveRolePermissions('SALES_SUPERVISOR');
    expect(grants.permissions).toContain('master_data.prospect.approve');
    expect(resolveRolePermissions('DISPATCHER').unresolvedGroups).toContain('FLT-EXCEPTION');
    expect(grants.permissions).not.toContain('*');
  });
});
