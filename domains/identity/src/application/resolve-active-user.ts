import type { Pool } from 'pg';
import { DomainError } from '@pss/contracts';

export interface ActiveUser {
  id: string;
  organizationId: string;
  displayName: string;
  primaryBranchId: string | null;
}

/** Look up the current PSS account on every request; IdP validity alone grants no access. */
export async function resolveActiveUser(pool: Pool, idpSubject: string): Promise<ActiveUser> {
  const result = await pool.query<{
    id: string;
    organization_id: string;
    display_name: string;
    primary_branch_id: string | null;
    status: 'ACTIVE' | 'INACTIVE';
  }>(
    `SELECT id, organization_id, display_name, primary_branch_id, status
     FROM identity.user_account WHERE idp_subject = $1`,
    [idpSubject],
  );
  const user = result.rows[0];
  if (!user) throw new DomainError('UNAUTHENTICATED');
  if (user.status !== 'ACTIVE') throw new DomainError('ACCOUNT_INACTIVE');
  return {
    id: user.id,
    organizationId: user.organization_id,
    displayName: user.display_name,
    primaryBranchId: user.primary_branch_id,
  };
}
