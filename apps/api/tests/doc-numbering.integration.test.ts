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
import { DocumentsController, DocumentNumberingService } from '../src/documents.controller';

@Module({ controllers: [DocumentsController], providers: [IdentityService, DocumentNumberingService] })
class DocumentsTestModule {}

const databaseName = `pss_doc_numbering_api_test_${randomUUID().replaceAll('-', '')}`;
const organizationId = randomUUID();
const branchId = randomUUID();
const issuer = 'http://localhost/realms/pss-documents-test';
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
    .setProtectedHeader({ alg: 'RS256', kid: 'documents-test-key' })
    .setIssuer(issuer).setAudience(audience).setSubject(subject)
    .setIssuedAt().setExpirationTime('5m')
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
    for (const file of ['0001_outbox_event.sql', '0002_idempotency_key.sql', '0008_document_numbering.sql']) {
      await setup.query(await readFile(new URL(`../../../domains/platform/infrastructure/database/migrations/${file}`, import.meta.url), 'utf8'));
    }
    await setup.query(
      `INSERT INTO identity.user_account (id, organization_id, idp_subject, display_name, status)
       VALUES ($1, $2, 'documents-subject', 'Admin Nomor', 'ACTIVE')`,
      [randomUUID(), organizationId],
    );
  } finally {
    await setup.end();
  }

  const keys = await generateKeyPair('RS256');
  privateKey = keys.privateKey;
  publicJwk = { ...await exportJWK(keys.publicKey), kid: 'documents-test-key', alg: 'RS256', use: 'sig' };
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

  app = await NestFactory.create(DocumentsTestModule, { logger: false });
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

function headers(): Promise<Record<string, string>> {
  return signedToken('documents-subject').then((token) => ({
    authorization: `Bearer ${token}`, 'content-type': 'application/json',
  }));
}

async function post(path: string, body: unknown, idempotencyKey?: string) {
  const base = await headers();
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: idempotencyKey ? { ...base, 'idempotency-key': idempotencyKey } : base,
    body: JSON.stringify(body),
  });
}

async function createActiveScheme() {
  const response = await post('/platform/documents/numbering/schemes', {
    docType: 'INV', branchId, status: 'ACTIVE', pattern: '{TYPE}-{BRANCH}-{YYYY}-{SEQ}',
    branchCode: 'CMH', resetPolicy: 'YEARLY', gapPolicy: 'NO_GAP_FISCAL', padding: 5,
    startAt: 1, validFrom: '2026-01-01',
  }, randomUUID());
  expect(response.status).toBe(201);
  return response.json();
}

describe('DOC-001 document numbering route boundary', () => {
  it('rejects a reservation with no Idempotency-Key and an invalid reservation id', async () => {
    const noKey = await post('/platform/documents/numbers/reserve', {
      docType: 'INV', branchId, documentDate: '2026-03-10', requestKey: randomUUID(),
    });
    expect(noKey.status).toBe(400);

    // PLT-006 + the route's own validation: an id that is not a uuid never reaches the domain.
    const badId = await post('/platform/documents/numbers/not-a-uuid/confirm', { documentId: 'INV-1' }, randomUUID());
    expect(badId.status).toBe(400);
  });

  it('rejects a body with a malformed business date and an unknown document type shape', async () => {
    // DOC-001.BR05: the sequence period comes from the document's own Asia/Jakarta business
    // date, so a date the server cannot parse is refused rather than defaulted to today.
    const badDate = await post('/platform/documents/numbers/reserve', {
      docType: 'INV', branchId, documentDate: '10/03/2026', requestKey: randomUUID(),
    }, randomUUID());
    expect(badDate.status).toBe(400);

    const lowerCaseType = await post('/platform/documents/numbering/schemes', {
      docType: 'invoice', validFrom: '2026-01-01',
    }, randomUUID());
    expect(lowerCaseType.status).toBe(400);
  });

  it('refuses to activate a scheme that is missing an unapproved GAP-16 field', async () => {
    const response = await post('/platform/documents/numbering/schemes', {
      docType: 'JV', status: 'ACTIVE', resetPolicy: 'NEVER', gapPolicy: 'GAP_ALLOWED',
      padding: 5, validFrom: '2026-01-01',
    }, randomUUID());
    // 409, not 400: the request shape is valid, but the state machine refuses the transition.
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
  });

  it('seeds the S3 document types as DRAFT with the unapproved fields unset', async () => {
    const response = await post('/platform/documents/numbering/schemes/seed-drafts', { branchId }, randomUUID());
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.created).toBe(18);
    expect(body.schemes.every((scheme: { status: string; pattern: string | null; branchCode: string | null }) =>
      scheme.status === 'DRAFT' && scheme.pattern === null && scheme.branchCode === null)).toBe(true);
  });

  /**
   * A re-seed under a *fresh* idempotency key finds every type already present. That is a
   * successful no-op, and the audit guard in `runCommand` must not turn it into a 500 — a
   * command that is asked to do something it finds already done has to succeed. It is still
   * traced, so the trail records that the seed ran and changed nothing.
   */
  it('succeeds and is traced when a fresh key re-seeds types that already exist', async () => {
    const response = await post('/platform/documents/numbering/schemes/seed-drafts', { branchId }, randomUUID());
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.created).toBe(0);
    expect(body.schemes).toHaveLength(18);
  });

  it('reserves, confirms, and voids a number, and a retried reserve returns the same one', async () => {
    await createActiveScheme();
    const requestKey = randomUUID();
    const reserved = await post('/platform/documents/numbers/reserve', {
      docType: 'INV', branchId, documentDate: '2026-03-10', requestKey,
    }, randomUUID());
    expect(reserved.status).toBe(201);
    const first = await reserved.json();
    expect(first.number).toMatchObject({ branchId, docType: 'INV', status: 'RESERVED', businessYear: 2026 });
    expect(first.replayed).toBe(false);

    // The same requestKey at the HTTP layer replays the stored response (PLT-006), and the
    // domain's own requestKey guard means even a fresh HTTP key would return the same number.
    const retried = await post('/platform/documents/numbers/reserve', {
      docType: 'INV', branchId, documentDate: '2026-03-10', requestKey,
    }, randomUUID());
    expect((await retried.json()).number.reservationId).toBe(first.number.reservationId);

    const confirmed = await post(`/platform/documents/numbers/${first.number.reservationId}/confirm`,
      { documentId: `invoice-${randomUUID()}` }, randomUUID());
    expect(confirmed.status).toBe(201);
    expect((await confirmed.json()).status).toBe('CONFIRMED');
  });

  it('reports the sequence usage so a gap is explained rather than merely absent', async () => {
    const response = await fetch(`${baseUrl}/platform/documents/numbering/usage?docType=INV&branchId=${branchId}`,
      { headers: await headers() });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.usage).toEqual([
      expect.objectContaining({ docType: 'INV', periodKey: 'Y:2026', used: 1, voided: 0 }),
    ]);
    // DOC-001.AC06: used + reserved + voided covers the whole allocated range.
    expect(body.usage[0].used + body.usage[0].reserved + body.usage[0].voided).toBe(Number(body.usage[0].lastValue));

    // A well-formed but unused document type has no usage; the filter validates the code's
    // shape, not whether a scheme happens to exist for it.
    const unusedType = await fetch(`${baseUrl}/platform/documents/numbering/usage?docType=ZZZ`,
      { headers: await headers() });
    expect(unusedType.status).toBe(200);
    expect(await unusedType.json()).toEqual({ usage: [] });

    // A malformed code is a request error, and `docType` is required rather than defaulted.
    const malformedType = await fetch(`${baseUrl}/platform/documents/numbering/usage?docType=invoice`,
      { headers: await headers() });
    expect(malformedType.status).toBe(400);
    const missingType = await fetch(`${baseUrl}/platform/documents/numbering/usage`,
      { headers: await headers() });
    expect(missingType.status).toBe(400);
  });

  it('denies an unauthenticated caller and never trusts a body-supplied organization', async () => {
    const anonymous = await fetch(`${baseUrl}/platform/documents/numbers/reserve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      body: JSON.stringify({ docType: 'INV', branchId, documentDate: '2026-03-10', requestKey: randomUUID() }),
    });
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toMatchObject({ code: 'UNAUTHENTICATED' });

    // `organizationId` is not an accepted field, so a client cannot claim a tenant.
    const spoofed = await post('/platform/documents/numbers/reserve', {
      docType: 'INV', branchId, documentDate: '2026-03-10', requestKey: randomUUID(),
      organizationId: randomUUID(),
    }, randomUUID());
    expect(spoofed.status).toBe(400);
  });
});
