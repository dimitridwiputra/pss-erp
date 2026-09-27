export { resolveActiveUser } from './application/resolve-active-user';
export type { ActiveUser } from './application/resolve-active-user';
export { checkAccess, requireAccess, loadActiveRoleAssignments } from './application/access-policy';
export type { AccessRequest, RoleAssignment, ScopeType, ScopedResource } from './application/access-policy';
export { resolveRolePermissions, isRegisteredRole } from './domain/role-permissions';
