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
import { ConfigAdminController, ConfigAdminService, FeatureFlagController } from '../src/config-admin.controller';
import { IdentityService } from '../src/identity.controller';

@Module({
  controllers: [ConfigAdminController, FeatureFlagController],
  providers: [IdentityService, ConfigAdminService],
})
class ConfigAdminTestModule {}

const databaseName = `pss_config_admin_api_test_${randomUUID().replaceAll('-', '')}`;
const organizationId = randomUUID();
const branchId = randomUUID();
const issuer = 'http://localhost/realms/pss-config-test';
const audience = 'pss-api';
let admin: pg.Client;
let app: INestApplication;
let baseUrl: string;
let jwksServer: Server;
let privateKey: CryptoKey;
let publicJwk: JWK;
let testDatabaseUrl: string;
let adminUserId: string;

async function signedToken(subject: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', kid: 'config-admin-test-key' })
    .setIssuer(issuer)
    .setAudience(audience)
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
      await setup.query(await readFile(new URL(`../../../domains/identity/infrastructure/database/migrations/${file}`, import.meta.url), 'utf8'));
    }
    await setup.query(await readFile(new URL('../../../domains/audit/infrastructure/database/migrations/0001_audit_entry.sql', import.meta.url), 'utf8'));
    for (const file of ['0001_outbox_event.sql', '0002_idempotency_key.sql', '0004_configuration.sql', '0009_config_flag_admin.sql']) {
      await setup.query(await readFile(new URL(`../../../domains/platform/infrastructure/database/migrations/${file}`, import.meta.url), 'utf8'));
    }
    await setup.query(
      `INSERT INTO identity.user_account (id, organization_id, idp_subject, display_name, status)
       VALUES ($1, $2, 'no-role-subject', 'Tanpa Peran', 'ACTIVE'),
              ($3, $2, 'sysadmin-subject', 'Admin Sistem', 'ACTIVE')`,
      [randomUUID(), organizationId, randomUUID()],
    );
    const sysadmin = await setup.query(`SELECT id FROM identity.user_account WHERE idp_subject = 'sysadmin-subject'`);
    adminUserId = sysadmin.rows[0].id as string;
    // SYSTEM_ADMIN is scoped to the organization and holds the registry's configuration
    // permission group. Whether that wildcard resolves to a concrete code is what the
    // authorization test below measures.
    await setup.query(
      `INSERT INTO identity.role_assignment (id, user_id, role_code, scope_type, scope_id)
       VALUES ($1, $2, 'SYSTEM_ADMIN', 'ORGANIZATION', $3)`,
      [randomUUID(), adminUserId, organizationId],
    );
  } finally {
    await setup.end();
  }

  const keys = await generateKeyPair('RS256');
  privateKey = keys.privateKey;
  publicJwk = { ...await exportJWK(keys.publicKey), kid: 'config-admin-test-key', alg: 'RS256', use: 'sig' };
  jwksServer = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ keys: [publicJwk] }));
  });
  await new Promise<void>((resolve) => jwksServer.listen(0, '127.0.0.1', resolve));
  const address = jwksServer.address();
  if (!address || typeof address === 'string') throw new Error('Test JWKS server did not bind.');
  process.env.DATABASE_URL = testDatabaseUrl;
  process.env.PSS_OIDC_ISSUER = issuer;
  process.env.PSS_OIDC_AUDIENCE = audience;
  process.env.PSS_OIDC_JWKS_URI = `http://127.0.0.1:${address.port}/jwks`;

  app = await NestFactory.create(ConfigAdminTestModule, { logger: false });
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

function auth(subject: string): Promise<Record<string, string>> {
  return signedToken(subject).then((token) => ({
    authorization: `Bearer ${token}`, 'content-type': 'application/json',
  }));
}

describe('PLT-009 configuration admin route boundary', () => {
  it('rejects a mutating request with no Idempotency-Key header', async () => {
    const headers = await auth('sysadmin-subject');
    const response = await fetch(`${baseUrl}/platform/config/values`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        key: 'invoicing.recognition_point', value: 'AT_DELIVERY', validFrom: '2026-01-01',
        reason: 'Nilai awal',
      }),
    });
    // PLT-006: the retry guard is read before any business logic runs.
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: 'VALIDATION_FAILED',
      fieldErrors: [{ path: 'Idempotency-Key' }],
    });
  });

  it('rejects a malformed body before any command runs', async () => {
    const response = await fetch(`${baseUrl}/platform/config/values`, {
      method: 'POST',
      headers: { ...(await auth('sysadmin-subject')), 'idempotency-key': randomUUID() },
      // `validFrom` must be an ISO business date; a server timestamp is not acceptable.
      body: JSON.stringify({ key: 'invoicing.recognition_point', value: 'AT_DELIVERY', validFrom: '01/01/2026' }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'VALIDATION_FAILED', status: 400 });
  });

  it('denies an unauthenticated caller', async () => {
    const response = await fetch(`${baseUrl}/platform/config/values`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      body: JSON.stringify({ key: 'invoicing.recognition_point', value: 'AT_DELIVERY', validFrom: '2026-01-01', reason: 'x' }),
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('resolves the caller from the session and never from the body', async () => {
    // A body that names a different organization is ignored: the value is stored under the
    // caller's organization, or the write is refused, but never under the body's.
    const response = await fetch(`${baseUrl}/platform/config/values`, {
      method: 'POST',
      headers: { ...(await auth('sysadmin-subject')), 'idempotency-key': randomUUID() },
      body: JSON.stringify({
        key: 'invoicing.recognition_point', value: 'AT_DELIVERY', validFrom: '2026-01-01',
        reason: 'Nilai awal', organizationId: randomUUID(),
      }),
    });
    // `organizationId` is not part of the accepted body, so it is a 400 rather than a silently
    // ignored field: a client must not believe it chose the tenant.
    expect(response.status).toBe(400);
  });

  it('gates the configuration write on the registry permission, and a user without one is denied', async () => {
    const denied = await fetch(`${baseUrl}/platform/config/values`, {
      method: 'POST',
      headers: { ...(await auth('no-role-subject')), 'idempotency-key': randomUUID() },
      body: JSON.stringify({
        key: 'invoicing.recognition_point', value: 'AT_DELIVERY', validFrom: '2026-01-01',
        reason: 'Tanpa permission',
      }),
    });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: 'PERMISSION_DENIED' });

    // A SYSTEM_ADMIN is also denied, and that is the measured current behaviour rather than an
    // assumption. The registry grants SYS-ADMIN the wildcard `configuration.*.manage`, while
    // `checkAccess` matches permission codes exactly against `groupPermissions['SYS-ADMIN']`,
    // which does not contain it. So no role can write configuration today. That is the correct
    // direction of failure under AGENTS.md §15 -- a system admin holds technical permissions,
    // not implicit mutation permission, and configuration is the change that must never happen
    // by accident -- but it does mean the write is unreachable until @pss/identity transcribes
    // the grant. This assertion is expected to flip to 200 at that point.
    const adminAttempt = await fetch(`${baseUrl}/platform/config/values`, {
      method: 'POST',
      headers: { ...(await auth('sysadmin-subject')), 'idempotency-key': randomUUID() },
      body: JSON.stringify({
        key: 'invoicing.recognition_point', value: 'AT_DELIVERY', validFrom: '2026-01-01',
        reason: 'Nilai awal recognition point',
      }),
    });
    expect(adminAttempt.status).toBe(403);
    expect(await adminAttempt.json()).toMatchObject({ code: 'PERMISSION_DENIED' });

    // Nothing was written, and nothing consumed the idempotency key: the gate runs first, so a
    // denied write leaves no trace to confuse a later retry.
    const stored = await new pg.Client({ connectionString: testDatabaseUrl });
    await stored.connect();
    const rows = await stored.query('SELECT count(*)::int AS n FROM platform.config_value');
    const keys = await stored.query('SELECT count(*)::int AS n FROM platform.idempotency_key');
    await stored.end();
    expect([rows.rows[0].n, keys.rows[0].n]).toEqual([0, 0]);
  });
});

describe('PLT-010 feature flag admin route boundary', () => {
  it('rejects a flag write with no Idempotency-Key and a malformed flag key', async () => {
    const noKey = await fetch(`${baseUrl}/platform/flags`, {
      method: 'POST', headers: await auth('sysadmin-subject'),
      body: JSON.stringify({ key: 'sfa.app_enabled', enabled: true, owner: 'Engineering' }),
    });
    expect(noKey.status).toBe(400);

    const badKey = await fetch(`${baseUrl}/platform/flags`, {
      method: 'POST',
      headers: { ...(await auth('sysadmin-subject')), 'idempotency-key': randomUUID() },
      body: JSON.stringify({ key: '', enabled: true, owner: 'Engineering' }),
    });
    expect(badKey.status).toBe(400);
  });

  it('validates a percentage rollout share before it reaches the domain', async () => {
    const response = await fetch(`${baseUrl}/platform/flags/sfa.app_enabled/targeting`, {
      method: 'POST',
      headers: { ...(await auth('sysadmin-subject')), 'idempotency-key': randomUUID() },
      body: JSON.stringify({ branchId, enabled: true, percentage: 150 }),
    });
    // 101 is the ceiling of a rollout share; a value above it is a request error, not a clamp.
    expect(response.status).toBe(400);
  });

  it('serves the effective-dated rows a reader hands to the configuration library', async () => {
    // The write gate is closed today, so the read path is exercised against a value inserted
    // directly. It proves the route, the Zod query validation, and the row shape the library
    // consumes, without depending on a permission that is not yet granted.
    const setup = new pg.Client({ connectionString: testDatabaseUrl });
    await setup.connect();
    await setup.query(
      `INSERT INTO platform.config_value (id, key, organization_id, value, valid_from, status, proposed_by, reason_code)
       VALUES ($1, 'invoicing.recognition_point', $2, '"AT_DELIVERY"'::jsonb, '2026-01-01', 'ACTIVE', $3, 'seed')`,
      [randomUUID(), organizationId, adminUserId],
    );
    await setup.end();
    const response = await fetch(
      `${baseUrl}/platform/config/values/rows?key=invoicing.recognition_point`,
      { headers: await auth('sysadmin-subject') },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      rows: [{
        key: 'invoicing.recognition_point',
        scope: { organizationId },
        value: 'AT_DELIVERY',
        validFrom: '2026-01-01',
        status: 'ACTIVE',
        revision: 1,
      }],
    });
  });

  it('serves the stale-flag report with a required business date', async () => {
    const missingDate = await fetch(`${baseUrl}/platform/flags/stale`, { headers: await auth('sysadmin-subject') });
    expect(missingDate.status).toBe(400);
    const withDate = await fetch(`${baseUrl}/platform/flags/stale?businessDate=2026-06-01`, { headers: await auth('sysadmin-subject') });
    expect(withDate.status).toBe(200);
    expect(await withDate.json()).toEqual({ flags: [] });
  });
});
