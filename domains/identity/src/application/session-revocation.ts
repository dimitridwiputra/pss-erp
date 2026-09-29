import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { withAuditedTransaction } from '@pss/audit';
import { DomainError } from '@pss/contracts';
import { loadActiveRoleAssignments, requireAccess } from './access-policy';

/** Refresh tokens retain the original IdP auth_time, so a revoked login cannot regain access by refreshing. */
export async function assertSessionActive(pool: Pool, userId: string, authenticationAt: number | undefined): Promise<void> {
  const result = await pool.query<{ sessions_revoked_at: Date | null }>(
    'SELECT sessions_revoked_at FROM identity.user_account WHERE id = $1', [userId],
  );
  const revokedAt = result.rows[0]?.sessions_revoked_at;
  if (revokedAt && (authenticationAt === undefined || authenticationAt * 1000 <= revokedAt.getTime())) {
    throw new DomainError('SESSION_EXPIRED');
  }
}

export async function revokeUserSessions(pool: Pool, input: {
  actorId: string;
  organizationId: string;
  targetUserId: string;
  reason: string;
  requestId: string;
}): Promise<void> {
  const assignments = await loadActiveRoleAssignments(pool, input.actorId);
  await withAuditedTransaction(pool, async ({ client, appendAuditEntry }) => {
    const target = await client.query<{ organization_id: string; version: number; sessions_revoked_at: Date | null }>(
      'SELECT organization_id, version, sessions_revoked_at FROM identity.user_account WHERE id = $1 FOR UPDATE',
      [input.targetUserId],
    );
    const user = target.rows[0];
    if (!user || user.organization_id !== input.organizationId) throw new DomainError('NOT_FOUND');
    requireAccess({
      actorId: input.actorId,
      organizationId: input.organizationId,
      assignments,
      permission: 'identity.session.revoke',
      resource: { organizationId: user.organization_id },
    });
    const updated = await client.query<{ version: number; sessions_revoked_at: Date }>(
      `UPDATE identity.user_account SET sessions_revoked_at = now(), version = version + 1, updated_at = now()
       WHERE id = $1 RETURNING version, sessions_revoked_at`, [input.targetUserId],
    );
    const result = updated.rows[0]!;
    await appendAuditEntry({
      organizationId: input.organizationId,
      actor: { userId: input.actorId, roles: [] },
      action: 'USER_SESSIONS_REVOKED',
      entity: { domain: 'identity', type: 'User', id: input.targetUserId, version: result.version },
      changes: [{
        path: 'sessionsRevokedAt', classification: 'INTERNAL',
        before: user.sessions_revoked_at?.toISOString() ?? null,
        after: result.sessions_revoked_at.toISOString(),
      }],
      reasonCode: input.reason,
      requestId: input.requestId || randomUUID(),
      correlationId: input.requestId || randomUUID(),
      source: 'API',
    });
  });
}
