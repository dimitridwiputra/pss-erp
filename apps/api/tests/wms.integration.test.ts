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
import { IdentityService } from '../src/identity.controller';
import { WmsController, WmsService } from '../src/wms.controller';
import { applyAuditMigrations } from '../../../scripts/apply-migrations.mjs';

@Module({ controllers: [WmsController], providers: [IdentityService, WmsService] })
class WmsTestModule {}

const databaseName = `pss_wms_api_test_${randomUUID().replaceAll('-', '')}`;
const organizationId = randomUUID();
const warehouseId = randomUUID();
const otherWarehouseId = randomUUID();
const issuer = 'http://localhost/realms/pss-test';
const audience = 'pss-api';
let admin: pg.Client;
let app: INestApplication;
let baseUrl: string;
let jwksServer: Server;
let privateKey: CryptoKey;
let publicJwk: JWK;
let testDatabaseUrl: string;

async function signedToken(subject: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', kid: 'wms-test-key' })
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
    // The whole audit domain, not a hand-picked pair of its files. Naming 0001 and 0002 is what
    // made amending a shipped migration look safe (MIG-RISK-AUD-001), and it breaks as soon as the
    // domain grows a migration.
    await applyAuditMigrations(setup);
    for (const file of ['0001_outbox_event.sql', '0002_idempotency_key.sql']) {
      await setup.query(await readFile(new URL(`../../../domains/platform/infrastructure/database/migrations/${file}`, import.meta.url), 'utf8'));
    }
    for (const file of ['0001_wms.sql', '0002_wms_reconciliation_and_units.sql', '0003_wms_pack_stage_load.sql', '0004_wms_presence_capacity_exceptions.sql']) {
      await setup.query(await readFile(new URL(`../../../domains/wms/infrastructure/database/migrations/${file}`, import.meta.url), 'utf8'));
    }

    await setup.query(
      `INSERT INTO identity.user_account (id, organization_id, idp_subject, display_name, status)
       VALUES ($1, $2, 'no-role-subject', 'Tanpa Peran', 'ACTIVE'),
              ($3, $2, 'admin-subject', 'Admin Gudang', 'ACTIVE'),
              ($4, $2, 'wrong-scope-subject', 'Admin Gudang Lain', 'ACTIVE')`,
      [randomUUID(), organizationId, randomUUID(), randomUUID()],
    );
    const adminUser = await setup.query(`SELECT id FROM identity.user_account WHERE idp_subject = 'admin-subject'`);
    const wrongScopeUser = await setup.query(`SELECT id FROM identity.user_account WHERE idp_subject = 'wrong-scope-subject'`);
    await setup.query(
      `INSERT INTO identity.role_assignment (id, user_id, role_code, scope_type, scope_id)
       VALUES ($1, $2, 'WAREHOUSE_ADMIN', 'WAREHOUSE', $3)`,
      [randomUUID(), adminUser.rows[0].id, warehouseId],
    );
    await setup.query(
      `INSERT INTO identity.role_assignment (id, user_id, role_code, scope_type, scope_id)
       VALUES ($1, $2, 'WAREHOUSE_ADMIN', 'WAREHOUSE', $3)`,
      [randomUUID(), wrongScopeUser.rows[0].id, otherWarehouseId],
    );
  } finally {
    await setup.end();
  }

  const keys = await generateKeyPair('RS256');
  privateKey = keys.privateKey;
  publicJwk = { ...await exportJWK(keys.publicKey), kid: 'wms-test-key', alg: 'RS256', use: 'sig' };
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

  app = await NestFactory.create(WmsTestModule, { logger: false });
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

describe('RBAC-002 WMS route authorization', () => {
  it('denies a user with no WMS role assignment', async () => {
    const response = await fetch(`${baseUrl}/wms/locations`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await signedToken('no-role-subject')}`, 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      body: JSON.stringify({ warehouseId, code: `BIN-${randomUUID().slice(0, 8)}`, type: 'BIN' }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('denies a WAREHOUSE_ADMIN scoped to a different warehouse', async () => {
    const response = await fetch(`${baseUrl}/wms/locations`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await signedToken('wrong-scope-subject')}`, 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      body: JSON.stringify({ warehouseId, code: `BIN-${randomUUID().slice(0, 8)}`, type: 'BIN' }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'PERMISSION_DENIED' });
  });
});

describe('PLT-006 WMS idempotency-key enforcement', () => {
  it('rejects a mutating request with no Idempotency-Key header', async () => {
    const response = await fetch(`${baseUrl}/wms/locations`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await signedToken('admin-subject')}`, 'content-type': 'application/json' },
      body: JSON.stringify({ warehouseId, code: `BIN-${randomUUID().slice(0, 8)}`, type: 'BIN' }),
    });
    expect(response.status).toBe(400);
  });

  it('replays the stored response for a repeated key + body, and rejects the same key reused with a different body', async () => {
    const token = await signedToken('admin-subject');
    const key = randomUUID();
    const body = { warehouseId, code: `BIN-${randomUUID().slice(0, 8)}`, type: 'BIN' };
    const request = (payload: unknown) => fetch(`${baseUrl}/wms/locations`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify(payload),
    });

    const first = await request(body);
    expect(first.status).toBe(201);
    const firstBody = await first.json();
    expect(firstBody.id).toBeTruthy();

    const replay = await request(body);
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual(firstBody);

    const client = new pg.Client({ connectionString: testDatabaseUrl });
    await client.connect();
    try {
      const rows = await client.query('SELECT id FROM wms.warehouse_location WHERE code = $1', [body.code]);
      expect(rows.rows).toHaveLength(1);
    } finally {
      await client.end();
    }

    const reused = await request({ ...body, code: `BIN-${randomUUID().slice(0, 8)}` });
    expect(reused.status).toBe(409);
    expect(await reused.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });
});
