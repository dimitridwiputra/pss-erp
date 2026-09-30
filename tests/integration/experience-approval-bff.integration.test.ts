import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkAccess, loadActiveRoleAssignments, resolveRolePermissions } from '@pss/identity';
import { listPendingApprovals, requestApproval, type AuthorizeApproval } from '@pss/platform';
import { resolveApprovalDetail, resolveApprovalInbox } from '../../apps/web/lib/experience/experience-handler';
import { IDENTITY_GRANTS_PATH, IDENTITY_SELF_PATH, PLATFORM_APPROVAL_INBOX_PATH } from '../../apps/web/lib/experience/sources';
import type { UpstreamRead, UpstreamTransport } from '../../apps/web/lib/experience/sources';
import { applyAuditMigrations } from '../../scripts/apply-migrations.mjs';

/**
 * PLT-008.AC04 / PLT-008.TS04 against a real database.
 *
 * The BFF has no scope logic of its own, so the guarantee is a property of the chain: the
 * platform approval query applies the identity access policy per row, and only the rows it
 * returns can reach the view model. This test wires the real domain query and the real
 * identity policy to the real BFF composition and then looks for the other branch in the
 * serialized response.
 */
const databaseName = `pss_experience_bff_test_${randomUUID().replaceAll('-', '')}`;
const organizationId = randomUUID();
const branchA = randomUUID();
const branchB = randomUUID();
const approverA = randomUUID();
const approverB = randomUUID();
const salesAdmin = randomUUID();
const requester = randomUUID();
let admin: pg.Client;
let pool: pg.Pool;
let approvalInBranchA: string;
let approvalInBranchB: string;

/** The same authorization `IdentityService.canApprove` applies, minus the OIDC token. */
function authorizeFor(actorId: string): AuthorizeApproval {
  return async (request) => {
    if (request.actorId !== actorId || request.organizationId !== organizationId) return false;
    const assignments = await loadActiveRoleAssignments(pool, actorId);
    if (!assignments.some((assignment) => assignment.roleCode === request.roleCode)) return false;
    return checkAccess({
      actorId, organizationId: request.organizationId, assignments, permission: request.permission,
      resource: {
        organizationId: request.organizationId,
        ...(request.branchId ? { branchId: request.branchId } : {}),
      },
    });
  };
}

function transportFor(actorId: string, displayName: string, primaryBranchId: string): UpstreamTransport {
  return async (read: UpstreamRead) => {
    if (read.method !== 'GET') throw new Error(`The BFF must not issue ${read.method}.`);
    if (read.path === IDENTITY_SELF_PATH) {
      return Response.json({ id: actorId, organizationId, displayName, primaryBranchId });
    }
    if (read.path === IDENTITY_GRANTS_PATH) {
      const assignments = await loadActiveRoleAssignments(pool, actorId);
      return Response.json({
        userId: actorId,
        grants: assignments.flatMap((assignment) =>
          resolveRolePermissions(assignment.roleCode).permissions.map((permission) => ({
            permission, scopeType: assignment.scopeType, scopeId: assignment.scopeId,
          }))),
      });
    }
    if (read.path === PLATFORM_APPROVAL_INBOX_PATH) {
      return Response.json(await listPendingApprovals(pool, organizationId, actorId, authorizeFor(actorId)));
    }
    throw new Error(`Unexpected upstream read ${read.path}.`);
  };
}

const context = { requestId: 'req-bff', instance: '/api/experience/approvals', now: new Date('2026-09-29T02:00:00.000Z') };

beforeAll(async () => {
  const baseUrl = process.env.PSS_TEST_DATABASE_URL;
  if (!baseUrl) throw new Error('PSS_TEST_DATABASE_URL is required for PostgreSQL integration tests.');
  admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${databaseName}`);
  const testUrl = new URL(baseUrl);
  testUrl.pathname = `/${databaseName}`;
  pool = new pg.Pool({ connectionString: testUrl.toString() });

  // The whole audit domain, not one file: a fixture that replays only
  // 0001 is what made amending a shipped migration look safe (MIG-RISK-AUD-001).
  await applyAuditMigrations(pool);
  for (const relativePath of [
    '../../domains/platform/infrastructure/database/migrations/0001_outbox_event.sql',
    '../../domains/platform/infrastructure/database/migrations/0003_approval.sql',
    '../../domains/identity/infrastructure/database/migrations/0001_user_account.sql',
    '../../domains/identity/infrastructure/database/migrations/0002_role_assignment.sql',
  ]) {
    await pool.query(await readFile(new URL(relativePath, import.meta.url), 'utf8'));
  }

  const policyId = randomUUID();
  await pool.query(
    `INSERT INTO platform.approval_type (code, owner_domain, subject_type, expiry_hours, delegation_allowed)
     VALUES ('credit_profile_change', 'credit', 'CreditProfile', 48, false)`,
  );
  await pool.query(
    `INSERT INTO platform.approval_policy (id, type_code, effective_from, status)
     VALUES ($1, 'credit_profile_change', '2026-01-01', 'ACTIVE')`, [policyId],
  );
  await pool.query(
    `INSERT INTO platform.approval_level (policy_id, level, role_code, permission_code, max_amount)
     VALUES ($1, 1, 'BRANCH_MANAGER', 'credit.override.approve', NULL)`, [policyId],
  );

  for (const [userId, displayName, branchId, roleCode] of [
    [approverA, 'Kepala Cabang A', branchA, 'BRANCH_MANAGER'],
    [approverB, 'Kepala Cabang B', branchB, 'BRANCH_MANAGER'],
    [salesAdmin, 'Sales Admin A', branchA, 'SALES_ADMIN'],
  ] as const) {
    await pool.query(
      `INSERT INTO identity.user_account (id, organization_id, idp_subject, display_name, primary_branch_id, status)
       VALUES ($1, $2, $3, $4, $5, 'ACTIVE')`, [userId, organizationId, `subject-${userId}`, displayName, branchId],
    );
    await pool.query(
      `INSERT INTO identity.role_assignment (id, user_id, role_code, scope_type, scope_id)
       VALUES ($1, $2, $3, 'BRANCH', $4)`, [randomUUID(), userId, roleCode, branchId],
    );
  }

  const raise = (branchId: string, summary: string, amount: string) => requestApproval(pool, {
    organizationId, branchId, typeCode: 'credit_profile_change', ownerDomain: 'credit',
    subjectRef: randomUUID(), requesterId: requester, amount, summary, businessDate: '2026-09-29', requestId: randomUUID(),
  }).then((result) => result.id);
  approvalInBranchA = await raise(branchA, 'Override kredit · Toko Makmur · Rp 15 jt', '15000000.00');
  approvalInBranchB = await raise(branchB, 'Override kredit · Toko Sejahtera · Rp 9 jt', '9000000.00');

}, 30_000);

afterAll(async () => {
  await pool?.end();
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
    await admin.end();
  }
});

describe('PLT-008.AC04 the BFF response cannot contain another branch', () => {
  it('returns only the caller branch, and the other branch is absent from the bytes', async () => {
    const outcome = await resolveApprovalInbox({
      ...context, transport: transportFor(approverA, 'Kepala Cabang A', branchA), accessToken: 'token-a',
    });
    if (outcome.kind !== 'VIEW') throw new Error(`expected a view, got ${outcome.problem.code}`);
    expect(outcome.view.items?.map((item) => item.approvalId)).toEqual([approvalInBranchA]);
    const serialized = JSON.stringify(outcome.view);
    expect(serialized).not.toContain(approvalInBranchB);
    expect(serialized).not.toContain(branchB);
    expect(serialized).not.toContain('Toko Sejahtera');
    expect(serialized).not.toContain('9000000.00');
  });

  it('gives each branch manager exactly their own request', async () => {
    const forB = await resolveApprovalInbox({
      ...context, transport: transportFor(approverB, 'Kepala Cabang B', branchB), accessToken: 'token-b',
    });
    if (forB.kind !== 'VIEW') throw new Error(`expected a view, got ${forB.problem.code}`);
    expect(forB.view.items?.map((item) => item.approvalId)).toEqual([approvalInBranchB]);
    expect(JSON.stringify(forB.view)).not.toContain(approvalInBranchA);
  });

  it('refuses a deep link into the other branch with the same problem as an unknown id', async () => {
    const transport = transportFor(approverA, 'Kepala Cabang A', branchA);
    const foreign = await resolveApprovalDetail({ ...context, transport, accessToken: 'token-a' }, approvalInBranchB);
    const unknown = await resolveApprovalDetail({ ...context, transport, accessToken: 'token-a' }, randomUUID());
    expect(foreign.kind).toBe('PROBLEM');
    expect(foreign).toEqual(unknown);
    if (foreign.kind !== 'PROBLEM') return;
    expect(foreign.problem).toMatchObject({ code: 'PERMISSION_DENIED', status: 403 });
    expect(JSON.stringify(foreign.problem)).not.toContain(branchB);
  });

  it('gives a caller with no decision permission an empty, complete queue', async () => {
    const outcome = await resolveApprovalInbox({
      ...context, transport: transportFor(salesAdmin, 'Sales Admin A', branchA), accessToken: 'token-sales',
    });
    if (outcome.kind !== 'VIEW') throw new Error('expected a view');
    // Complete and empty, which is what tells the screen apart from a failed read.
    expect(outcome.view.incomplete).toBe(false);
    expect(outcome.view.items).toEqual([]);
    expect(outcome.view.viewer.canDecide).toBe(false);
    expect(JSON.stringify(outcome.view)).not.toContain(approvalInBranchA);
    expect(JSON.stringify(outcome.view)).not.toContain(branchA);
  });
});
