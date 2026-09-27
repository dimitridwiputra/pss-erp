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
import { IdentityController, IdentityService } from '../src/identity.controller';

@Module({ controllers: [IdentityController], providers: [IdentityService] })
class IdentityTestModule {}

const databaseName = `pss_identity_test_${randomUUID().replaceAll('-', '')}`;
const organizationId = randomUUID();
const activeUserId = randomUUID();
const inactiveUserId = randomUUID();
const issuer = 'http://localhost/realms/pss-test';
const audience = 'pss-api';
let admin: pg.Client;
let app: INestApplication;
let baseUrl: string;
let jwksServer: Server;
let privateKey: CryptoKey;
let publicJwk: JWK;
let testDatabaseUrl: string;

async function signedToken(subject: string, tokenAudience = audience): Promise<string> {
  return new SignJWT({})
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
    const migration = await readFile(new URL('../../../domains/identity/infrastructure/database/migrations/0001_user_account.sql', import.meta.url), 'utf8');
    await setup.query(migration);
    await setup.query(
      `INSERT INTO identity.user_account (id, organization_id, idp_subject, display_name, status)
       VALUES ($1, $2, 'active-subject', 'Pengguna Aktif', 'ACTIVE'),
              ($3, $2, 'inactive-subject', 'Pengguna Nonaktif', 'INACTIVE')`,
      [activeUserId, organizationId, inactiveUserId],
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
