export { resolveActiveUser } from './application/resolve-active-user';
export type { ActiveUser } from './application/resolve-active-user';
export { checkAccess, requireAccess, loadActiveRoleAssignments } from './application/access-policy';
export type { AccessRequest, RoleAssignment, ScopeType, ScopedResource } from './application/access-policy';
export { resolveRolePermissions, isRegisteredRole } from './domain/role-permissions';
export { assertSessionActive, revokeUserSessions } from './application/session-revocation';
export { requireRecentMfa } from './application/mfa-policy';
export {
  MAX_BOTTOM_NAV_ITEMS, permissionsForRoles, resolveNavigation,
  type AppEntitlement, type AppKey, type NavigationResult,
} from './domain/app-entitlements';
export {
  checkForbiddenRoleCombinations, checkSystemAdministratorSod, evaluateAssignmentSod,
  type RoleAssignmentView, type SodViolation,
} from './domain/segregation-of-duties';
