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
import { IdentityAdminController, IdentityController, IdentityService } from '../src/identity.controller';

@Module({ controllers: [IdentityController, IdentityAdminController], providers: [IdentityService] })
class NavigationTestModule {}

const databaseName = `pss_nav_test_${randomUUID().replaceAll('-', '')}`;
const organizationId = randomUUID();
const branchA = randomUUID();
const adminId = randomUUID();
const auditorId = randomUUID();
const warehouseOperatorId = randomUUID();
const financeMakerId = randomUUID();
const inactiveId = randomUUID();
const issuer = 'http://localhost/realms/pss-nav-test';
const audience = 'pss-api';
let app: INestApplication;
let baseUrl: string;
let jwksServer: Server;
let privateKey: CryptoKey;
let testDatabaseUrl: string;
let admin: pg.Client;

async function signedToken(subject: string, claims: { authenticationAt?: number; otp?: boolean } = {}) {
  return new SignJWT({
    ...(claims.authenticationAt === undefined ? {} : { auth_time: claims.authenticationAt }),
    ...(claims.otp ? { amr: ['pwd', 'otp'] } : {}),
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'nav-test-key' })
    .setSubject(subject)
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}

beforeAll(async () => {
  const baseDatabaseUrl = process.env.PSS_TEST_DATABASE_URL;
  if (!baseDatabaseUrl) throw new Error('PSS_TEST_DATABASE_URL is required for PostgreSQL integration tests.');
  // Connect to the base database first: a client cannot CREATE DATABASE while its
  // own connection string already points at the not-yet-existing database.
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
      await setup.query(await readFile(new URL(`../../../domains/identity/infrastructure/database/migrations/${file}`, import.meta.url), 'utf8'));
    }
    await setup.query(
      `INSERT INTO identity.user_account (id, organization_id, idp_subject, display_name, status)
       VALUES ($1,$2,'nav-admin','Administrator Sistem','ACTIVE'),
              ($3,$2,'nav-auditor','Auditor Internal','ACTIVE'),
              ($4,$2,'nav-warehouse','Operator Gudang','ACTIVE'),
              ($5,$2,'nav-finance','Pembuat Jurnal','ACTIVE'),
              ($6,$2,'nav-inactive','Pengguna Nonaktif','INACTIVE')`,
      [adminId, organizationId, auditorId, warehouseOperatorId, financeMakerId, inactiveId],
    );

    // SYSTEM_ADMIN is technical only (SOD-07). INTERNAL_AUDIT holds audit.entry.read,
    // which is what the access-review read is gated on. Branch-scoped rows carry
    // scope_id = branch; the org-wide SYSTEM_ADMIN row carries NULL.
    // Scope must match each role's declared defaultScope, because roleAllowsScope
    // rejects a grant outside it: INTERNAL_AUDIT is "ORG (read-only)" and
    // WAREHOUSE_OPERATOR is "WAREHOUSE". The DB also requires scope_id for every
    // scope_type except OWN, so an org-wide grant points at the organization.
    const warehouseA = randomUUID();
    await setup.query(
      `INSERT INTO identity.role_assignment (id, user_id, role_code, scope_type, scope_id)
       VALUES ($1, $2, 'SYSTEM_ADMIN', 'ORGANIZATION', $3),
              ($4, $5, 'INTERNAL_AUDIT', 'ORGANIZATION', $6),
              ($7, $8, 'WAREHOUSE_OPERATOR', 'WAREHOUSE', $9),
              ($10, $11, 'FINANCE_MAKER', 'ORGANIZATION', $12)`,
      [
        randomUUID(), adminId, organizationId,
        randomUUID(), auditorId, organizationId,
        randomUUID(), warehouseOperatorId, warehouseA,
        randomUUID(), financeMakerId, organizationId,
      ],
    );
  } finally {
    await setup.end();
  }

  const keys = await generateKeyPair('RS256', { extractable: true });
  privateKey = keys.privateKey;
  const jwk: JWK = { ...(await exportJWK(keys.publicKey)), kid: 'nav-test-key', alg: 'RS256', use: 'sig' };
  jwksServer = createServer((request, response) => {
    if (request.url === '/jwks') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => jwksServer.listen(0, '127.0.0.1', resolve));
  const port = (jwksServer.address() as { port: number }).port;

  process.env.PSS_OIDC_ISSUER = issuer;
  process.env.PSS_OIDC_AUDIENCE = audience;
  process.env.PSS_OIDC_JWKS_URI = `http://127.0.0.1:${port}/jwks`;
  process.env.DATABASE_URL = testDatabaseUrl;

  app = await NestFactory.create(NavigationTestModule, { logger: false });
  app.useGlobalFilters(new ProblemExceptionFilter());
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
});

afterAll(async () => {
  await app?.close();
  jwksServer?.close();
  delete process.env.PSS_OIDC_ISSUER;
  delete process.env.PSS_OIDC_AUDIENCE;
  delete process.env.PSS_OIDC_JWKS_URI;
  delete process.env.DATABASE_URL;
  await admin?.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`).catch(() => undefined);
  await admin?.end().catch(() => undefined);
});

const get = async (path: string, token: string) => {
  const response = await fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${token}` } });
  return { status: response.status, body: await response.json().catch(() => null) };
};

describe('RBAC-003 server-computed navigation', () => {
  it('returns only the apps the caller may actually open', async () => {
    const token = await signedToken('nav-warehouse', { authenticationAt: Math.floor(Date.now() / 1000) });
    const { status, body } = await get('/me/navigation', token);
    expect(status).toBe(200);
    const apps = body.apps.map((entry: { app: string }) => entry.app);
    expect(apps).toEqual(['gudang']);
    // A warehouse operator has no business-menu entry in any other product.
    expect(apps).not.toContain('keuangan');
    expect(apps).not.toContain('konsol');
  });

  it('hides an individual menu item the caller may not use', async () => {
    const token = await signedToken('nav-warehouse', { authenticationAt: Math.floor(Date.now() / 1000) });
    const { body } = await get('/me/navigation', token);
    const gudang = body.apps.find((entry: { app: string }) => entry.app === 'gudang');
    // WAREHOUSE_OPERATOR grants wms.task.execute only, not reassignment or counting.
    expect(gudang.items.map((item: { key: string }) => item.key)).toEqual(['task']);
  });

  it('requires authentication', async () => {
    const response = await fetch(`${baseUrl}/me/navigation`);
    expect(response.status).toBe(401);
    expect((await response.json()).code).toBe('UNAUTHENTICATED');
  });

  it('denies an inactive account even with a valid token', async () => {
    const token = await signedToken('nav-inactive', { authenticationAt: Math.floor(Date.now() / 1000) });
    const { status, body } = await get('/me/navigation', token);
    expect(status).toBe(403);
    expect(body.code).toBe('ACCOUNT_INACTIVE');
  });
});

describe('IDN-003.R02 access review report', () => {
  it('returns granted permissions and flags unresolved permission groups', async () => {
    const token = await signedToken('nav-auditor', { authenticationAt: Math.floor(Date.now() / 1000), otp: true });
    const { status, body } = await get('/identity/access-review', token);
    expect(status).toBe(200);
    expect(body.organizationId).toBe(organizationId);

    const names = body.holders.map((holder: { displayName: string }) => holder.displayName);
    expect(names).toContain('Administrator Sistem');
    expect(names).toContain('Operator Gudang');

    const operator = body.holders.find((holder: { displayName: string }) => holder.displayName === 'Operator Gudang');
    expect(operator.permissions).toContain('wms.task.execute');
    expect(operator.scopeType).toBe('WAREHOUSE');
    expect(operator.accountStatus).toBe('AKTIF');
    expect(operator.validTo).toBeNull();
  });

  it('excludes an account whose assignment has not taken effect yet', async () => {
    const token = await signedToken('nav-auditor', { authenticationAt: Math.floor(Date.now() / 1000), otp: true });
    const { body } = await get('/identity/access-review', token);
    // nav-inactive is INACTIVE and holds no role, so it must not appear as a holder.
    const names = body.holders.map((holder: { displayName: string }) => holder.displayName);
    expect(names).not.toContain('Pengguna Nonaktif');
  });

  it('scopes a branch review to that branch plus organization-wide grants', async () => {
    const token = await signedToken('nav-auditor', { authenticationAt: Math.floor(Date.now() / 1000), otp: true });
    const { status, body } = await get(`/identity/access-review?branchId=${branchA}`, token);
    expect(status).toBe(200);
    expect(body.branchId).toBe(branchA);
    // The warehouse operator is scoped to a warehouse, not this branch, so a branch
    // review must not list them; the org-wide system admin still applies.
    const names = body.holders.map((holder: { displayName: string }) => holder.displayName);
    expect(names).toContain('Administrator Sistem');
    expect(names).not.toContain('Operator Gudang');
  });

  it('scopes the report: a caller without audit.entry.read is denied', async () => {
    const token = await signedToken('nav-warehouse', { authenticationAt: Math.floor(Date.now() / 1000) });
    const { status, body } = await get('/identity/access-review', token);
    expect(status).toBe(403);
    expect(body.code).toBe('PERMISSION_DENIED');
  });
});
