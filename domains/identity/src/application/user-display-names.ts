import type { Pool } from 'pg';

/**
 * Display names for people named on a record (the cashier on a shift, the verifier of a cash
 * handover), within one organization. An id from another organization, or one that does not
 * exist, is simply absent from the result, so a caller can never learn a foreign user's name.
 */
export async function getUserDisplayNames(
  executor: Pick<Pool, 'query'>, organizationId: string, userIds: readonly string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return new Map();
  const result = await executor.query<{ id: string; display_name: string }>(
    'SELECT id, display_name FROM identity.user_account WHERE organization_id = $1 AND id = ANY($2::uuid[])',
    [organizationId, unique],
  );
  return new Map(result.rows.map((row) => [row.id, row.display_name]));
}
