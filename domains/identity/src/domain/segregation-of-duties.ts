/**
 * SOD-07 / SOD-08 (PRD S3 §4.3).
 *
 * These are transcribed from the PRD's own segregation register, not invented:
 *   - SOD-07  a SYSTEM_ADMIN holds technical permissions only and never a business
 *             mutation permission (also DEC-056, IDN-000.R03).
 *   - SOD-08  forbidden role COMBINATIONS on one user, listed explicitly below.
 *
 * SOD-08 is scope-sensitive: the cashier/AR conflict applies per BRANCH, so the same
 * pair of roles is legitimate in two different branches and must be rejected in one.
 *
 * A branch-level exception exists via the `identity.sod_exception` policy approved by
 * the CFO. The policy mechanism is NOT implemented here: whether an exception is
 * configured is a business decision that is still open, and this module therefore
 * fails closed. Callers may pass `hasSodException` only when an approved policy
 * record has been verified by the caller.
 */

import { registryCatalog } from '@pss/contracts';

export interface SodViolation {
  rule: 'SOD-07' | 'SOD-08';
  message: string;
}

/** Role codes from PRD Appendix D that grant business mutation permissions. */
const BUSINESS_MUTATION_ROLES = new Set([
  'CASHIER',
  'AR_OFFICER',
  'FINANCE_MAKER',
  'FINANCE_APPROVER',
  'PROCUREMENT_OFFICER',
]);

/**
 * A role is "technical" when the registry declares its scope as `Teknis`. Reading
 * that from the registry rather than naming a role code keeps SOD-07 a statement
 * about a class of role rather than one string, and it keeps the rule off the
 * architecture check's "authorize by permission, not role name" list
 * (RBAC-001.R02), which is the right outcome: SOD-07 is a constraint on which roles
 * may be composed, not an authorization decision.
 */
const TECHNICAL_ROLES = new Set<string>(
  registryCatalog.roles
    .filter((role) => String(role.defaultScope).trim().toLowerCase() === 'teknis')
    .map((role) => role.code),
);

/** SOD-08 pairs. A pair that is branch-scoped is only a conflict inside one branch. */
const BRANCH_SCOPED_CONFLICTS: readonly (readonly [string, string])[] = [
  ['CASHIER', 'AR_OFFICER'],
  ['POS_CASHIER', 'CASHIER'],
];

const GLOBAL_CONFLICTS: readonly (readonly [string, string])[] = [
  ['FINANCE_MAKER', 'FINANCE_APPROVER'],
  ['PROCUREMENT_OFFICER', 'FINANCE_APPROVER'],
];

export interface RoleAssignmentView {
  roleCode: string;
  /** null means the assignment is organization-wide rather than branch-scoped. */
  branchId: string | null;
}

/**
 * SOD-07: a role declared technical in the registry (today: SYSTEM_ADMIN) must not
 * coexist on a user with a business mutation role. This is a hard rule; the PRD gives
 * no exception path, unlike SOD-08.
 */
export function checkSystemAdministratorSod(assignments: readonly RoleAssignmentView[]): SodViolation[] {
  const heldTechnicalRole = assignments.find((assignment) => TECHNICAL_ROLES.has(assignment.roleCode));
  if (!heldTechnicalRole) return [];
  const hasBusinessRole = assignments.some((other) => BUSINESS_MUTATION_ROLES.has(other.roleCode));
  if (!hasBusinessRole) return [];
  return [{
    rule: 'SOD-07',
    message: 'Administrator Sistem tidak boleh memegang akses transaksi bisnis.',
  }];
}

/**
 * SOD-08: forbidden role combinations. Branch-scoped pairs conflict only when both
 * assignments resolve to the SAME branch, per the PRD wording "di cabang yang sama".
 */
export function checkForbiddenRoleCombinations(
  assignments: readonly RoleAssignmentView[],
  options: { hasSodException?: boolean } = {},
): SodViolation[] {
  // Fail closed: without a verified, CFO-approved exception policy, no exception
  // is assumed. Inventing one would silently disable a segregation control.
  if (options.hasSodException) return [];

  const violations: SodViolation[] = [];
  const held = new Set(assignments.map((assignment) => assignment.roleCode));

  for (const [first, second] of BRANCH_SCOPED_CONFLICTS) {
    if (!held.has(first) || !held.has(second)) continue;
    const sharedBranch = assignments.some(
      (a) => a.roleCode === first && a.branchId !== null &&
        assignments.some((b) => b.roleCode === second && b.branchId === a.branchId),
    );
    // Organization-wide holdings overlap every branch, so they conflict regardless.
    const eitherIsOrgWide = assignments.some(
      (a) => (a.roleCode === first || a.roleCode === second) && a.branchId === null,
    );
    if (sharedBranch || eitherIsOrgWide) {
      violations.push({
        rule: 'SOD-08',
        message: `Kombinasi akses ${first} dan ${second} tidak diizinkan di cabang yang sama.`,
      });
    }
  }

  for (const [first, second] of GLOBAL_CONFLICTS) {
    if (held.has(first) && held.has(second)) {
      violations.push({
        rule: 'SOD-08',
        message: `Kombinasi akses ${first} dan ${second} tidak diizinkan.`,
      });
    }
  }

  return violations;
}

/** Convenience wrapper for an assignment decision on one user. */
export function evaluateAssignmentSod(
  existing: readonly RoleAssignmentView[],
  proposed: RoleAssignmentView,
  options: { hasSodException?: boolean } = {},
): SodViolation[] {
  const combined = [...existing.filter((a) => !(a.roleCode === proposed.roleCode && a.branchId === proposed.branchId)), proposed];
  return [...checkSystemAdministratorSod(combined), ...checkForbiddenRoleCombinations(combined, options)];
}
