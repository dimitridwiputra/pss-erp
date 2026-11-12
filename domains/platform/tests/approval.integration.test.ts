import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decideApproval, requestApproval, type AuthorizeApproval } from '../src/application/approval';
import { applyAuditMigrations } from '../../../scripts/apply-migrations.mjs';

const databaseName = `pss_approval_test_${randomUUID().replaceAll('-', '')}`;
const organizationId = randomUUID();
const branchId = randomUUID();
const requesterId = randomUUID();
const approverId = randomUUID();
let admin: pg.Client;
let pool: pg.Pool;

beforeAll(async () => {
  const baseUrl = process.env.PSS_TEST_DATABASE_URL;
  if (!baseUrl) throw new Error('PSS_TEST_DATABASE_URL is required.');
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
    '../infrastructure/database/migrations/0001_outbox_event.sql',
    '../infrastructure/database/migrations/0003_approval.sql',
    '../infrastructure/database/migrations/0011_approval_subject_version.sql',
  ]) {
    await pool.query(await readFile(new URL(relativePath, import.meta.url), 'utf8'));
  }
  const policyId = randomUUID();
  await pool.query(
    `INSERT INTO platform.approval_type (code, owner_domain, subject_type, expiry_hours, delegation_allowed)
     VALUES ('credit_override', 'credit', 'CreditProfile', 48, true)`,
  );
  await pool.query(
    `INSERT INTO platform.approval_policy (id, type_code, effective_from, status)
     VALUES ($1, 'credit_override', '2026-01-01', 'ACTIVE')`, [policyId],
  );
  await pool.query(
    `INSERT INTO platform.approval_level (policy_id, level, role_code, permission_code, max_amount)
     VALUES ($1, 1, 'BRANCH_MANAGER', 'credit.override.approve', 10000000),
            ($1, 2, 'FINANCE_APPROVER', 'credit.override.approve', NULL)`, [policyId],
  );
}, 30_000);

afterAll(async () => {
  await pool?.end();
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
    await admin.end();
  }
});

function input(amount: string) {
  return {
    organizationId, branchId, typeCode: 'credit_override', ownerDomain: 'credit',
    subjectRef: randomUUID(), requesterId, amount, summary: 'Perubahan batas kredit',
    businessDate: '2026-09-27', requestId: randomUUID(),
  };
}

describe('APR-001 audited approval aggregate', () => {
  it('routes the threshold boundary without floating-point money and fails safe above it', async () => {
    const atThreshold = await requestApproval(pool, input('10000000.00'));
    const aboveThreshold = await requestApproval(pool, input('10000000.01'));
    expect(atThreshold).toMatchObject({ level: 1, requiredRole: 'BRANCH_MANAGER' });
    expect(aboveThreshold).toMatchObject({ level: 2, requiredRole: 'FINANCE_APPROVER' });
    const event = await pool.query<{ event_type: string }>(
      'SELECT event_type FROM platform.outbox_event WHERE aggregate_id = $1', [aboveThreshold.id],
    );
    expect(event.rows).toEqual([{ event_type: 'APPROVAL_REQUESTED' }]);
  });

  it('prevents self-approval, authorizes the chosen level, and emits one final event under concurrency', async () => {
    const request = await requestApproval(pool, input('15000000'));
    const command = { approvalId: request.id, organizationId, decision: 'APPROVED' as const,
      reason: 'Sesuai kebijakan', businessDate: '2026-09-27', requestId: randomUUID() };
    const authorize: AuthorizeApproval = async (access) =>
      access.actorId === approverId && access.roleCode === 'FINANCE_APPROVER' && access.branchId === branchId;
    await expect(decideApproval(pool, { ...command, actorId: requesterId }, authorize)).rejects.toThrow('SEGREGATION_OF_DUTIES');
    await expect(decideApproval(pool, { ...command, actorId: randomUUID() }, authorize)).rejects.toThrow('PERMISSION_DENIED');
    const results = await Promise.allSettled([
      decideApproval(pool, { ...command, actorId: approverId }, authorize),
      decideApproval(pool, { ...command, actorId: approverId, requestId: randomUUID() }, authorize),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const events = await pool.query<{ event_type: string }>(
      'SELECT event_type FROM platform.outbox_event WHERE aggregate_id = $1 ORDER BY aggregate_version', [request.id],
    );
    expect(events.rows.map((row) => row.event_type)).toEqual(['APPROVAL_REQUESTED', 'APPROVAL_DECIDED']);
    expect((await pool.query("SELECT * FROM audit.audit_entry WHERE entity_id = $1 AND action = 'APPROVAL_DECIDED'", [request.id])).rowCount).toBe(1);
  });

  it('routes unset thresholds to the highest level and records an authorized delegation', async () => {
    await pool.query('UPDATE platform.approval_level SET max_amount = NULL WHERE level = 1');
    const request = await requestApproval(pool, input('1'));
    expect(request.level).toBe(2);
    const delegateId = randomUUID();
    await pool.query(
      `INSERT INTO platform.approval_delegation
       (id, organization_id, branch_id, type_code, delegator_id, delegate_id, valid_from, valid_to)
       VALUES ($1,$2,$3,'credit_override',$4,$5,now() - interval '1 hour',now() + interval '1 hour')`,
      [randomUUID(), organizationId, branchId, approverId, delegateId],
    );
    await decideApproval(pool, {
      approvalId: request.id, organizationId, actorId: delegateId,
      decision: 'APPROVED', reason: 'Delegasi aktif', businessDate: '2026-09-27', requestId: randomUUID(),
    }, async (access) => access.onBehalfOf === approverId);
    const audit = await pool.query<{ actor_user_id: string; actor_on_behalf_of: string }>(
      "SELECT actor_user_id, actor_on_behalf_of FROM audit.audit_entry WHERE entity_id = $1 AND action = 'APPROVAL_DECIDED'",
      [request.id],
    );
    expect(audit.rows).toEqual([{ actor_user_id: delegateId, actor_on_behalf_of: approverId }]);
  });
});
