import type { RoleAssignment } from './access-policy';

/**
 * PLT-009 configuration write permission.
 *
 * The owner decided that SYSTEM_ADMIN may manage TECHNICAL configuration, that BUSINESS
 * configuration is proposed by the configured owner role for that key, and that SYSTEM_ADMIN does
 * not receive general business-mutation authority. Sensitive keys additionally go through the
 * `config_change` approval.
 *
 * Why this is not `checkAccess`. `checkAccess` answers "does this actor hold permission P", where P
 * comes from a role's static permission groups. A per-key owner role is not a static permission —
 * the same actor may own `tax.vat_output_rate` and not `ar.aging_buckets`, and two actors may own
 * different keys. So the question here is "does this actor hold the role that owns THIS key", which
 * is a different lookup against the same assignment rows.
 *
 * The split is also what keeps SOD-07 satisfiable. SYSTEM_ADMIN holding a business mutation role is
 * a hard violation with no exception path, so a design where SYSTEM_ADMIN manages every
 * configuration key would require SYSTEM_ADMIN to be a business role holder. Narrowing the grant to
 * technical keys removes the conflict at the source rather than relying on an exception nobody has
 * approved.
 *
 * The policy shape is declared here and populated by Platform, which owns `platform.config_key`. A
 * domain is the sole owner of its facts (AGENTS.md 3.1), so Identity must not query a Platform
 * table; the API layer supplies the policy, and Identity decides.
 */

/** The permission a SYSTEM_ADMIN holds for TECHNICAL keys. Concrete, never a wildcard. */
export const CONFIG_TECHNICAL_MANAGE = 'configuration.technical.manage';

export interface ConfigKeyPolicy {
  key: string;
  classification: 'TECHNICAL' | 'BUSINESS';
  sensitivity: 'SENSITIVE' | 'ROUTINE';
  ownerRoleCode: string | null;
  approvalLevel: number | null;
}

export interface ConfigWriteDecision {
  allowed: boolean;
  /** Present when denied, so the caller can record why rather than only that it failed. */
  reason?: 'NOT_OWNER' | 'NOT_TECHNICAL_ADMIN' | 'KEY_UNKNOWN';
  /** True when the change must additionally clear the `config_change` approval. */
  requiresApproval: boolean;
  /** The level to route to, or null to let `requestApproval` choose the policy's highest. */
  approvalLevel: number | null;
}

/**
 * Decide whether an actor may PROPOSE a change to a key.
 *
 * Deciding the resulting approval is a separate question with a separate check. Holding write
 * permission never implies approval permission — the owner's explicit instruction — so this reports
 * whether approval is required and never approves anything.
 */
export function evaluateConfigWrite(
  key: string,
  assignments: readonly RoleAssignment[],
  options: { holdsTechnicalManage: boolean; policy: ConfigKeyPolicy | undefined },
): ConfigWriteDecision {
  const { policy } = options;
  if (!policy) {
    return { allowed: false, reason: 'KEY_UNKNOWN', requiresApproval: true, approvalLevel: null };
  }

  if (policy.classification === 'TECHNICAL') {
    return {
      allowed: options.holdsTechnicalManage,
      ...(options.holdsTechnicalManage ? {} : { reason: 'NOT_TECHNICAL_ADMIN' as const }),
      requiresApproval: policy.sensitivity === 'SENSITIVE',
      approvalLevel: policy.approvalLevel,
    };
  }

  const owns = policy.ownerRoleCode !== null
    && assignments.some((assignment) => assignment.roleCode === policy.ownerRoleCode);
  return {
    allowed: owns,
    ...(owns ? {} : { reason: 'NOT_OWNER' as const }),
    requiresApproval: policy.sensitivity === 'SENSITIVE',
    approvalLevel: policy.approvalLevel,
  };
}

/**
 * The concrete permission that satisfies a TECHNICAL key. Read from the registry rather than
 * written as a literal, so a registry change moves the gate with it (AGENTS.md 18).
 *
 * Throws when the registry no longer grants it: a missing technical grant means the technical write
 * path is unreachable, which must fail loudly at startup rather than silently downgrade to some
 * fallback permission.
 */
export function technicalConfigPermission(
  permissionGroups: readonly { group: string; permissions: readonly string[] }[],
): string {
  const group = permissionGroups.find((entry) => entry.group === 'SYS-ADMIN');
  const permission = group?.permissions.find((code) => code === CONFIG_TECHNICAL_MANAGE);
  if (!permission) {
    throw new Error('The SYS-ADMIN registry group no longer grants configuration.technical.manage.');
  }
  return permission;
}
