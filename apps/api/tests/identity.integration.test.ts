import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { Module } from '@nestjs/common';
import { NestFactory, type INestApplication } from '@nestjs/core';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProblemExceptionFilter } from '@pss/http';
import { requestApproval } from '@pss/platform';
import { ApprovalController, ApprovalService } from '../src/approval.controller';
import { IdentityAdminController, IdentityController, IdentityService } from '../src/identity.controller';

@Module({ controllers: [IdentityController, IdentityAdminController, ApprovalController], providers: [IdentityService, ApprovalService] })
class IdentityTestModule {}

const databaseName = `pss_identity_test_${randomUUID().replaceAll('-', '')}`;
const organizationId = randomUUID();
const activeUserId = randomUUID();
const inactiveUserId = randomUUID();
const adminUserId = randomUUID();
const revocationTargetId = randomUUID();
const financeApproverId = randomUUID();
const issuer = 'http://localhost/realms/pss-test';
const audience = 'pss-api';
let admin: pg.Client;
let app: INestApplication;
let baseUrl: string;
let jwksServer: Server;
let privateKey: CryptoKey;
let publicJwk: JWK;
let testDatabaseUrl: string;

async function signedToken(subject: string, tokenAudience = audience, claims: { authenticationAt?: number; otp?: boolean } = {}): Promise<string> {
  return new SignJWT({
    ...(claims.authenticationAt === undefined ? {} : { auth_time: claims.authenticationAt }),
    ...(claims.otp ? { amr: ['pwd', 'otp'] } : {}),
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'identity-test-key' })
    .setIssuer(issuer)
    .setAudience(tokenAudience)
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}

beforeAll(async () => {
  const baseDatabaseUrl = process.env.PSS_TEST_DATABASE_URL;
  if (!baseDatabaseUrl) throw new Error('PSS_TEST_DATABASE_URL is required for PostgreSQL integration tests.');
  admin = new pg.Client({ connectionString: baseDatabaseUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${databaseName}`);
  const testUrl = new URL(baseDatabaseUrl);
  testUrl.pathname = `/${databaseName}`;
  testDatabaseUrl = testUrl.toString();
  const setup = new pg.Client({ connectionString: testDatabaseUrl });
  await setup.connect();
  try {
    for (const file of ['0001_user_account.sql', '0002_role_assignment.sql', '0003_session_revocation.sql']) {
      const migration = await readFile(new URL(`../../../domains/identity/infrastructure/database/migrations/${file}`, import.meta.url), 'utf8');
      await setup.query(migration);
    }
    await setup.query(
      `INSERT INTO identity.user_account (id, organization_id, idp_subject, display_name, status)
       VALUES ($1, $2, 'active-subject', 'Pengguna Aktif', 'ACTIVE'),
              ($3, $2, 'inactive-subject', 'Pengguna Nonaktif', 'INACTIVE'),
              ($4, $2, 'admin-subject', 'Admin Sistem', 'ACTIVE'),
              ($5, $2, 'target-subject', 'Pengguna Target', 'ACTIVE'),
              ($6, $2, 'finance-subject', 'Penyetuju Keuangan', 'ACTIVE')`,
      [activeUserId, organizationId, inactiveUserId, adminUserId, revocationTargetId, financeApproverId],
    );
    await setup.query(
      `INSERT INTO identity.role_assignment (id, user_id, role_code, scope_type, scope_id)
       VALUES ($1, $2, 'SALES_ADMIN', 'BRANCH', $3)`,
      [randomUUID(), activeUserId, randomUUID()],
    );
    await setup.query(
      `INSERT INTO identity.role_assignment (id, user_id, role_code, scope_type, scope_id)
       VALUES ($1, $2, 'SYSTEM_ADMIN', 'ORGANIZATION', $3)`,
      [randomUUID(), adminUserId, organizationId],
    );
    await setup.query(
      `INSERT INTO identity.role_assignment (id, user_id, role_code, scope_type, scope_id)
       VALUES ($1, $2, 'FINANCE_APPROVER', 'ORGANIZATION', $3)`,
      [randomUUID(), financeApproverId, organizationId],
    );
    const auditMigration = await readFile(new URL('../../../domains/audit/infrastructure/database/migrations/0001_audit_entry.sql', import.meta.url), 'utf8');
    await setup.query(auditMigration);
    for (const file of ['0001_outbox_event.sql', '0003_approval.sql']) {
      await setup.query(await readFile(new URL(`../../../domains/platform/infrastructure/database/migrations/${file}`, import.meta.url), 'utf8'));
    }
    const policyId = randomUUID();
    await setup.query(
      `INSERT INTO platform.approval_type (code, owner_domain, subject_type, expiry_hours)
       VALUES ('credit_override', 'credit', 'CreditProfile', 48)`,
    );
    await setup.query(
      `INSERT INTO platform.approval_policy (id, type_code, effective_from, status)
       VALUES ($1, 'credit_override', '2026-01-01', 'ACTIVE')`, [policyId],
    );
    await setup.query(
      `INSERT INTO platform.approval_level (policy_id, level, role_code, permission_code)
       VALUES ($1, 2, 'FINANCE_APPROVER', 'credit.override.approve')`, [policyId],
    );
  } finally {
    await setup.end();
  }

  const keys = await generateKeyPair('RS256');
  privateKey = keys.privateKey;
  publicJwk = { ...await exportJWK(keys.publicKey), kid: 'identity-test-key', alg: 'RS256', use: 'sig' };
  jwksServer = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ keys: [publicJwk] }));
  });
  await new Promise<void>((resolve) => jwksServer.listen(0, '127.0.0.1', resolve));
  const address = jwksServer.address();
  if (!address || typeof address === 'string') throw new Error('Test JWKS server did not bind.');
  process.env.DATABASE_URL = testUrl.toString();
  process.env.PSS_OIDC_ISSUER = issuer;
  process.env.PSS_OIDC_AUDIENCE = audience;
  process.env.PSS_OIDC_JWKS_URI = `http://127.0.0.1:${address.port}/jwks`;

  app = await NestFactory.create(IdentityTestModule, { logger: false });
  app.useGlobalFilters(new ProblemExceptionFilter());
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
}, 30_000);

afterAll(async () => {
  await app?.close();
  if (jwksServer) await new Promise<void>((resolve, reject) => jwksServer.close((error) => error ? reject(error) : resolve()));
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
    await admin.end();
  }
  delete process.env.DATABASE_URL;
  delete process.env.PSS_OIDC_ISSUER;
  delete process.env.PSS_OIDC_AUDIENCE;
  delete process.env.PSS_OIDC_JWKS_URI;
});

describe('IDN-001 admin session revocation and IDN-002 step-up', () => {
  it('rejects unauthorized or unverified revocation, audits success, and blocks refreshed tokens from the old login', async () => {
    const url = `${baseUrl}/identity/users/${revocationTargetId}/revoke-sessions`;
    const oldAuthTime = Math.floor(Date.now() / 1000) - 60;
    const oldTargetToken = await signedToken('target-subject', audience, { authenticationAt: oldAuthTime });
    expect((await fetch(`${baseUrl}/me`, { headers: { authorization: `Bearer ${oldTargetToken}` } })).status).toBe(200);

    const request = (token: string) => fetch(url, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'Perangkat hilang' }),
    });
    const salesCaller = await request(await signedToken('active-subject', audience, { authenticationAt: Math.floor(Date.now() / 1000), otp: true }));
    expect(salesCaller.status).toBe(403);
    const noMfa = await request(await signedToken('admin-subject', audience, { authenticationAt: Math.floor(Date.now() / 1000) }));
    expect(noMfa.status).toBe(401);
    expect(await noMfa.json()).toMatchObject({ code: 'MFA_REQUIRED' });

    const adminToken = await signedToken('admin-subject', audience, { authenticationAt: Math.floor(Date.now() / 1000), otp: true });
    const revoked = await request(adminToken);
    expect(revoked.status).toBe(201);
    expect(await revoked.json()).toEqual({ status: 'REVOKED' });
    const oldSession = await fetch(`${baseUrl}/me`, { headers: { authorization: `Bearer ${oldTargetToken}` } });
    expect(oldSession.status).toBe(401);
    expect(await oldSession.json()).toMatchObject({ code: 'SESSION_EXPIRED' });
    const refreshedOldLogin = await signedToken('target-subject', audience, { authenticationAt: oldAuthTime });
    expect((await fetch(`${baseUrl}/me`, { headers: { authorization: `Bearer ${refreshedOldLogin}` } })).status).toBe(401);

    const client = new pg.Client({ connectionString: testDatabaseUrl });
    await client.connect();
    try {
      const audit = await client.query(
        "SELECT reason_code, actor_user_id FROM audit.audit_entry WHERE action = 'USER_SESSIONS_REVOKED' AND entity_id = $1",
        [revocationTargetId],
      );
      expect(audit.rows).toEqual([expect.objectContaining({ reason_code: 'Perangkat hilang', actor_user_id: adminUserId })]);
    } finally {
      await client.end();
    }
  });
});

describe('APR-001/002 protected approval inbox and decision API', () => {
  it('shows only authorized work and requires recent MFA to decide', async () => {
    const pool = new pg.Pool({ connectionString: testDatabaseUrl });
    const created = await requestApproval(pool, {
      organizationId, typeCode: 'credit_override', ownerDomain: 'credit',
      subjectRef: randomUUID(), requesterId: activeUserId, amount: '15000000',
      summary: 'Batas kredit perlu diputuskan', businessDate: '2026-09-27', requestId: randomUUID(),
    });
    try {
      const salesToken = await signedToken('active-subject');
      const salesInbox = await fetch(`${baseUrl}/platform/approvals/inbox`, { headers: { authorization: `Bearer ${salesToken}` } });
      expect(salesInbox.status).toBe(200);
      expect(await salesInbox.json()).toEqual([]);

      const financeToken = await signedToken('finance-subject', audience, {
        authenticationAt: Math.floor(Date.now() / 1000), otp: true,
      });
      const financeInbox = await fetch(`${baseUrl}/platform/approvals/inbox`, { headers: { authorization: `Bearer ${financeToken}` } });
      expect(financeInbox.status).toBe(200);
      expect(await financeInbox.json()).toEqual([expect.objectContaining({ id: created.id, requiredRole: 'FINANCE_APPROVER' })]);

      const decisionUrl = `${baseUrl}/platform/approvals/${created.id}/decision`;
      const body = JSON.stringify({ decision: 'APPROVED', reason: 'Bukti lengkap' });
      const withoutMfa = await fetch(decisionUrl, {
        method: 'POST', headers: { authorization: `Bearer ${await signedToken('finance-subject')}`, 'content-type': 'application/json' }, body,
      });
      expect(withoutMfa.status).toBe(401);
      expect(await withoutMfa.json()).toMatchObject({ code: 'MFA_REQUIRED' });
      const decided = await fetch(decisionUrl, {
        method: 'POST', headers: { authorization: `Bearer ${financeToken}`, 'content-type': 'application/json' }, body,
      });
      expect(decided.status).toBe(201);
      expect(await decided.json()).toMatchObject({ status: 'APPROVED' });
      const after = await fetch(`${baseUrl}/platform/approvals/inbox`, { headers: { authorization: `Bearer ${financeToken}` } });
      expect(await after.json()).toEqual([]);
    } finally {
      await pool.end();
    }
  });
});

describe('IDN-001 protected current-user endpoint', () => {
  it('returns the PSS account for a valid token and active mapping', async () => {
    const response = await fetch(`${baseUrl}/me`, { headers: { authorization: `Bearer ${await signedToken('active-subject')}` } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: activeUserId,
      organizationId,
      displayName: 'Pengguna Aktif',
      primaryBranchId: null,
    });
  });

  it('rejects missing, wrong-audience, and unknown accounts', async () => {
    const missing = await fetch(`${baseUrl}/me`);
    expect(missing.status).toBe(401);
    expect(await missing.json()).toMatchObject({ code: 'UNAUTHENTICATED' });

    const wrongAudience = await fetch(`${baseUrl}/me`, { headers: { authorization: `Bearer ${await signedToken('active-subject', 'another-api')}` } });
    expect(wrongAudience.status).toBe(401);
    expect(await wrongAudience.json()).toMatchObject({ code: 'UNAUTHENTICATED' });

    const unknown = await fetch(`${baseUrl}/me`, { headers: { authorization: `Bearer ${await signedToken('unknown-subject')}` } });
    expect(unknown.status).toBe(401);
    expect(await unknown.json()).toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('rejects an inactive PSS account despite a valid IdP token', async () => {
    const response = await fetch(`${baseUrl}/me`, { headers: { authorization: `Bearer ${await signedToken('inactive-subject')}` } });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'ACCOUNT_INACTIVE' });
  });

  it('IDN-001.AC02 denies the same token immediately after PSS deactivation', async () => {
    const sameToken = await signedToken('active-subject');
    const before = await fetch(`${baseUrl}/me`, { headers: { authorization: `Bearer ${sameToken}` } });
    expect(before.status).toBe(200);

    const client = new pg.Client({ connectionString: testDatabaseUrl });
    await client.connect();
    try {
      await client.query("UPDATE identity.user_account SET status = 'INACTIVE', version = version + 1, updated_at = now() WHERE id = $1", [activeUserId]);
      const after = await fetch(`${baseUrl}/me`, { headers: { authorization: `Bearer ${sameToken}` } });
      expect(after.status).toBe(403);
      expect(await after.json()).toMatchObject({ code: 'ACCOUNT_INACTIVE' });
    } finally {
      await client.query("UPDATE identity.user_account SET status = 'ACTIVE', version = version + 1, updated_at = now() WHERE id = $1", [activeUserId]);
      await client.end();
    }
  });
});

describe('RBAC-002 current permissions endpoint', () => {
  it('returns stored active assignments as scoped grants, not role claims in the token', async () => {
    const response = await fetch(`${baseUrl}/me/permissions`, { headers: { authorization: `Bearer ${await signedToken('active-subject')}` } });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.userId).toBe(activeUserId);
    expect(body.grants).toEqual(expect.arrayContaining([
      expect.objectContaining({ permission: 'orders.order.create', scopeType: 'BRANCH' }),
    ]));
    expect(body.grants).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ permission: 'finance.journal.approve' }),
    ]));
  });

  it('denies missing token and an inactive PSS account', async () => {
    expect((await fetch(`${baseUrl}/me/permissions`)).status).toBe(401);
    const inactive = await fetch(`${baseUrl}/me/permissions`, { headers: { authorization: `Bearer ${await signedToken('inactive-subject')}` } });
    expect(inactive.status).toBe(403);
  });

  it('RBAC-002.AC04 removes revoked permissions on the next request', async () => {
    const token = await signedToken('active-subject');
    const client = new pg.Client({ connectionString: testDatabaseUrl });
    await client.connect();
    const assignmentId = randomUUID();
    try {
      await client.query(
        `INSERT INTO identity.role_assignment (id, user_id, role_code, scope_type, scope_id)
         VALUES ($1, $2, 'INTERNAL_AUDIT', 'ORGANIZATION', $3)`,
        [assignmentId, activeUserId, organizationId],
      );
      const before = await fetch(`${baseUrl}/me/permissions`, { headers: { authorization: `Bearer ${token}` } });
      expect((await before.json()).grants).toEqual(expect.arrayContaining([
        expect.objectContaining({ permission: 'audit.entry.read', scopeType: 'ORGANIZATION' }),
      ]));
      await client.query('UPDATE identity.role_assignment SET revoked_at = now(), updated_at = now() WHERE id = $1', [assignmentId]);
      const after = await fetch(`${baseUrl}/me/permissions`, { headers: { authorization: `Bearer ${token}` } });
      expect((await after.json()).grants).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ permission: 'audit.entry.read' }),
      ]));
    } finally {
      await client.query('DELETE FROM identity.role_assignment WHERE id = $1', [assignmentId]);
      await client.end();
    }
  });
});
