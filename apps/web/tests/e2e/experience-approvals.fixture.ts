import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * Synthetic local fixtures for the APR-002 browser suite.
 *
 * `pnpm dev:up` creates a demo account that can only be a SALES_ADMIN, so the approval
 * inbox and the decision command have nothing to show. This module gives the local
 * database the smallest arrangement the feature already allows — a branch-scoped
 * BRANCH_MANAGER assignment for that same account, and one pending credit-override request
 * in its own branch — through `docker compose exec ... psql`, so no application code and no
 * test file imports a database driver (PLT-002: experience/BFF code cannot access a
 * database directly).
 *
 * Everything is idempotent and scoped to the local Compose database. The suite removes the
 * request it raised; the approval type, policy, level and role assignment are reference
 * configuration and are left in place so repeated runs behave the same.
 */
const APPROVAL_TYPE = 'credit_profile_change';
const APPROVAL_PERMISSION = 'credit.override.approve';
const APPROVAL_ROLE = 'BRANCH_MANAGER';
const DEMO_DISPLAY_NAME = 'Admin Demo PSS';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PG_USER = process.env.PSS_LOCAL_PGUSER ?? 'pss_local';
const PG_DATABASE = process.env.PSS_LOCAL_PGDATABASE ?? 'pss_operational';
const COMPOSE_FILE = resolve(process.cwd(), '../../compose.yaml');

/** Runs one statement batch against the local Compose database and fails loudly. */
export function runLocalSql(sql: string): void {
  execFileSync(
    'docker',
    ['compose', '--file', COMPOSE_FILE, 'exec', '-T', 'postgres',
      'psql', '--username', PG_USER, '--dbname', PG_DATABASE, '--no-psqlrc', '--set', 'ON_ERROR_STOP=1', '--command', sql],
    { cwd: resolve(process.cwd(), '../..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

export async function demoCredentials(): Promise<{ username: string; password: string } | null> {
  const login = await readFile(resolve(process.cwd(), '../../.local/pss-demo-login.txt'), 'utf8').catch(() => null);
  if (!login) return null;
  const username = login.match(/^Username: (.+)$/m)?.[1];
  const password = login.match(/^Password: (.+)$/m)?.[1];
  return username && password ? { username, password } : null;
}

function requireUuid(approvalId: string): string {
  if (!UUID_PATTERN.test(approvalId)) throw new Error('Refusing to run SQL with a non-UUID approval id.');
  return approvalId;
}

/** The demo account becomes a branch approver, and one pending request appears in its branch. */
export function seedLocalApproval(): void {
  runLocalSql(`
    DO $seed$
    DECLARE
      v_account uuid; v_branch uuid; v_organization uuid; v_policy uuid; v_request uuid;
    BEGIN
      SELECT u.id, u.primary_branch_id, u.organization_id INTO v_account, v_branch, v_organization
        FROM identity.user_account u WHERE u.display_name = '${DEMO_DISPLAY_NAME}' AND u.status = 'ACTIVE';
      IF v_account IS NULL OR v_branch IS NULL THEN
        RAISE EXCEPTION 'Run pnpm dev:up: the local demo PSS account is missing.';
      END IF;

      INSERT INTO platform.approval_type (code, owner_domain, subject_type, expiry_hours, delegation_allowed, reason_required)
        VALUES ('${APPROVAL_TYPE}', 'credit', 'CreditProfile', 48, false, true)
        ON CONFLICT (code) DO NOTHING;

      INSERT INTO identity.role_assignment (id, user_id, role_code, scope_type, scope_id)
        SELECT gen_random_uuid(), v_account, '${APPROVAL_ROLE}', 'BRANCH', v_branch
         WHERE NOT EXISTS (
           SELECT 1 FROM identity.role_assignment a
            WHERE a.user_id = v_account AND a.role_code = '${APPROVAL_ROLE}'
              AND a.scope_type = 'BRANCH' AND a.scope_id = v_branch AND a.revoked_at IS NULL);

      SELECT p.id INTO v_policy FROM platform.approval_policy p
        WHERE p.type_code = '${APPROVAL_TYPE}' AND p.status = 'ACTIVE' AND p.effective_from <= current_date
        ORDER BY p.effective_from DESC LIMIT 1;
      IF v_policy IS NULL THEN
        v_policy := gen_random_uuid();
        INSERT INTO platform.approval_policy (id, type_code, effective_from, status)
          VALUES (v_policy, '${APPROVAL_TYPE}', current_date, 'ACTIVE');
      END IF;

      INSERT INTO platform.approval_level (policy_id, level, role_code, permission_code, max_amount)
        VALUES (v_policy, 1, '${APPROVAL_ROLE}', '${APPROVAL_PERMISSION}', NULL)
        ON CONFLICT DO NOTHING;

      v_request := gen_random_uuid();
      INSERT INTO platform.approval_request
        (id, organization_id, branch_id, type_code, policy_id, owner_domain, subject_ref,
         requester_id, amount, summary, status, level, required_role, permission_code, expires_at)
        VALUES (v_request, v_organization, v_branch, '${APPROVAL_TYPE}', v_policy, 'credit', gen_random_uuid(),
                gen_random_uuid(), '15000000.00', 'Override kredit · Toko Makmur · Rp 15 jt', 'PENDING', 1,
                '${APPROVAL_ROLE}', '${APPROVAL_PERMISSION}', now() + interval '2 days');
    END
    $seed$;`);
}

/**
 * Moves the request to a final state the way another approver's decision would, so the
 * browser meets the APR-002.E1 stale path on a real round trip through the API.
 */
export function markLocalApprovalDecided(approvalId: string): void {
  runLocalSql(`UPDATE platform.approval_request
      SET status = 'APPROVED', decided_by = gen_random_uuid(), decided_at = now(),
          decision_reason = 'Local e2e fixture', version = version + 1
    WHERE id = '${requireUuid(approvalId)}';`);
}

export function removeLocalApproval(approvalId: string): void {
  runLocalSql(`DELETE FROM platform.approval_request WHERE id = '${requireUuid(approvalId)}';`);
}
