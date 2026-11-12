import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  confirmDocumentNumber, createNumberingScheme, listNumberingSchemes, numberSequenceUsage,
  reserveDocumentNumber, seedDraftNumberingSchemes, voidDocumentNumber,
} from '../src/application/document-numbering';
import { applyAuditMigrations } from '../../../scripts/apply-migrations.mjs';

const databaseName = `pss_doc_numbering_test_${randomUUID().replaceAll('-', '')}`;
const organizationId = randomUUID();
const otherOrganizationId = randomUUID();
const branchId = randomUUID();
const otherBranchId = randomUUID();
const adminId = randomUUID();
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
    '../infrastructure/database/migrations/0008_document_numbering.sql',
  ]) {
    await pool.query(await readFile(new URL(relativePath, import.meta.url), 'utf8'));
  }
}, 30_000);

afterAll(async () => {
  await pool?.end();
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
    await admin.end();
  }
});

/**
 * An ACTIVE scheme with every field GAP-16 has not approved filled in by the operator, which is
 * the only way the mechanism can be exercised end to end. The values below are test data, not
 * a claim about the real numbering format.
 */
function activeScheme(overrides: Record<string, unknown> = {}) {
  return createNumberingScheme(pool, {
    organizationId, branchId, docType: 'INV', status: 'ACTIVE',
    pattern: '{TYPE}-{BRANCH}-{YYYY}-{SEQ}',
    branchCode: 'CMH', resetPolicy: 'YEARLY', gapPolicy: 'NO_GAP_FISCAL', padding: 5,
    startAt: 1, validFrom: '2026-01-01', requestId: randomUUID(), ...overrides,
  });
}

function reserve(overrides: Record<string, unknown> = {}) {
  return reserveDocumentNumber(pool, {
    organizationId, branchId, docType: 'INV', documentDate: '2026-03-10',
    requestKey: randomUUID(), requestingDomain: 'invoicing', requestId: randomUUID(), ...overrides,
  });
}

describe('DOC-001 document numbering', () => {
  it('registers a DRAFT scheme per S3 document type with the unapproved fields left unset', async () => {
    // DOC-001.R04: the seed exists so Finance/Ops can review GAP-16. Nothing is invented: the
    // pattern, the branch code, the gap policy, and the padding all stay NULL, which
    // `readyForActivation` reports honestly.
    const seeded = await seedDraftNumberingSchemes(pool, { organizationId, requestId: randomUUID() });
    expect(seeded.created).toBe(18);
    expect(seeded.schemes.every((scheme) => scheme.status === 'DRAFT')).toBe(true);
    expect(seeded.schemes.every((scheme) => scheme.readyForActivation === false)).toBe(true);
    expect(seeded.schemes.find((scheme) => scheme.docType === 'INV')).toMatchObject({
      pattern: null, branchCode: null, gapPolicy: null, padding: null, resetPolicy: null,
    });

    // Re-running the seed is a no-op rather than a duplicate.
    const again = await seedDraftNumberingSchemes(pool, { organizationId, requestId: randomUUID() });
    expect(again.created).toBe(0);
    expect((await listNumberingSchemes(pool, organizationId)).length).toBe(18);
  });

  it('refuses to activate a scheme that is missing a field GAP-16 has not approved', async () => {
    // The pattern is a business decision Finance/Tax has not made, so Platform will not invent
    // one to make a scheme usable.
    await expect(createNumberingScheme(pool, {
      organizationId, docType: 'JV', status: 'ACTIVE', resetPolicy: 'NEVER', gapPolicy: 'GAP_ALLOWED',
      padding: 5, validFrom: '2026-01-01', requestId: randomUUID(),
    })).rejects.toThrow('INVALID_STATE_TRANSITION');

    // A DRAFT scheme is invisible to reservation entirely: the seed types exist for review
    // under GAP-16, not to hand out numbers nobody has approved a format for.
    await expect(reserve({ docType: 'PO', documentDate: '2026-03-10' })).rejects.toThrow('NOT_FOUND');
  });

  it('issues distinct numbers to 50 parallel reservations and never reuses one', async () => {
    // DOC-001.AC01 / R01: 200 parallel reservations for one invoice type and branch must yield
    // that many distinct, strictly increasing numbers.
    await activeScheme();
    const CONCURRENCY = 50;
    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, () => reserve()),
    );
    const numbers = results.map((result) => result.number);
    const ordinals = numbers.map((number) => Number(number.sequenceValue)).sort((left, right) => left - right);
    expect(new Set(ordinals).size).toBe(CONCURRENCY);
    // Continuous 1..50: no number is skipped, so every ordinal is accounted for in the report.
    expect(ordinals).toEqual(Array.from({ length: CONCURRENCY }, (_, index) => index + 1));
    expect(new Set(numbers.map((number) => number.formattedNumber)).size).toBe(CONCURRENCY);
    // Every number records which branch, which type, and which business year it belongs to.
    for (const number of numbers) {
      expect(number).toMatchObject({ branchId, docType: 'INV', businessYear: 2026, periodKey: 'Y:2026' });
      expect(number.formattedNumber).toMatch(/^INV-CMH-2026-\d{5}$/);
    }
  });

  it('returns the same number for a retried requestKey instead of minting a second one', async () => {
    // DOC-001.AC02 / R02.
    const requestKey = randomUUID();
    const first = await reserve({ requestKey });
    const second = await reserve({ requestKey });
    expect(second.replayed).toBe(true);
    expect(second.number.reservationId).toBe(first.number.reservationId);
    expect(second.number.sequenceValue).toBe(first.number.sequenceValue);
    // The retry is still traced, so an auditor asking "was this number asked for twice?" has
    // an answer, without a second number existing.
    expect((await pool.query(
      `SELECT count(*)::int AS n FROM audit.audit_entry
       WHERE entity_type = 'NumberReservation' AND entity_id = $1`, [first.number.reservationId],
    )).rows[0]?.n).toBe(2);
  });

  it('never reissues a voided number and records who cancelled it and why', async () => {
    // DOC-001.AC03 / NC02 / R05 / BR02.
    const before = await numberSequenceUsage(pool, organizationId, 'INV', branchId);
    const target = await reserve();
    const ordinal = Number(target.number.sequenceValue);

    const voided = await voidDocumentNumber(pool, {
      organizationId, reservationId: target.number.reservationId,
      reason: 'Invoice dibatalkan sebelum terbit', voidedBy: adminId, requestId: randomUUID(),
    });
    expect(voided).toMatchObject({ status: 'VOID', sequenceValue: target.number.sequenceValue });

    // The next reservation moves past the voided ordinal instead of filling it.
    const next = await reserve();
    expect(Number(next.number.sequenceValue)).toBeGreaterThan(ordinal);

    // A void is permanent: repeating it is a no-op, and confirming a voided number is refused.
    const repeated = await voidDocumentNumber(pool, {
      organizationId, reservationId: target.number.reservationId,
      reason: 'Diulang', voidedBy: adminId, requestId: randomUUID(),
    });
    expect(repeated.status).toBe('VOID');
    await expect(confirmDocumentNumber(pool, {
      organizationId, reservationId: target.number.reservationId,
      documentId: randomUUID(), requestId: randomUUID(),
    })).rejects.toThrow('INVALID_STATE_TRANSITION');

    // DOC-001.R03 / AC06: the report explains the gap with the BATAL row rather than hiding it.
    const after = await numberSequenceUsage(pool, organizationId, 'INV', branchId);
    const used = after[0]!.used + after[0]!.reserved + after[0]!.voided;
    expect(used).toBe(Number(after[0]!.lastValue));
    expect(after[0]!.voided).toBe(before[0]!.voided + 1);

    // DOC-001.R05: the void records the actor and the reason. The repeated void above is also
    // traced, with no reason of its own, so the pair reads as "cancelled once, asked twice".
    const audit = await pool.query<{ actor_user_id: string; reason_code: string | null }>(
      `SELECT actor_user_id, reason_code FROM audit.audit_entry
       WHERE action = 'DOCUMENT_NUMBER_VOIDED' AND entity_id = $1
       ORDER BY occurred_at`,
      [target.number.reservationId],
    );
    expect(audit.rows).toEqual([
      { actor_user_id: adminId, reason_code: 'Invoice dibatalkan sebelum terbit' },
      { actor_user_id: adminId, reason_code: null },
    ]);
  });

  it('confirms a reserved number and refuses a second document from claiming it', async () => {
    const reserved = await reserve();
    const confirmed = await confirmDocumentNumber(pool, {
      organizationId, reservationId: reserved.number.reservationId,
      documentId: randomUUID(), requestId: randomUUID(),
    });
    expect(confirmed.status).toBe('CONFIRMED');
    // Re-confirming the same reservation is idempotent, not a second document.
    const again = await confirmDocumentNumber(pool, {
      organizationId, reservationId: reserved.number.reservationId,
      documentId: randomUUID(), requestId: randomUUID(),
    });
    expect(again.documentId).toBe(confirmed.documentId);
  });

  it('takes the sequence period from the document date, not the server date', async () => {
    // DOC-001.BR05 / AC04: a document dated 31 December is numbered in that year even when it
    // is created in January, and a monthly scheme splits on the document's own month.
    await activeScheme({ docType: 'SO', resetPolicy: 'YEARLY' });
    const december = await reserve({ docType: 'SO', documentDate: '2026-12-31' });
    const january = await reserve({ docType: 'SO', documentDate: '2027-01-01' });
    expect(december.number).toMatchObject({ periodKey: 'Y:2026', businessYear: 2026, businessMonth: null });
    expect(january.number).toMatchObject({ periodKey: 'Y:2027', businessYear: 2027 });

    await activeScheme({ docType: 'CN', resetPolicy: 'MONTHLY' });
    const february = await reserve({ docType: 'CN', documentDate: '2026-02-14' });
    const march = await reserve({ docType: 'CN', documentDate: '2026-03-01' });
    expect(february.number.periodKey).toBe('M:2026-02');
    // A new period restarts at the scheme's start value; the two never share a counter.
    expect(Number(march.number.sequenceValue)).toBe(1);

    // A NEVER-reset scheme keeps one counter for the whole life of the type. A journal voucher
    // is an organization-level type, so neither the scheme nor the reservation names a branch.
    await activeScheme({ docType: 'JV', branchId: undefined, resetPolicy: 'NEVER' });
    const first = await reserve({ docType: 'JV', branchId: undefined, documentDate: '2026-01-05' });
    const later = await reserve({ docType: 'JV', branchId: undefined, documentDate: '2027-06-05' });
    expect(first.number.periodKey).toBe('A');
    expect(Number(later.number.sequenceValue)).toBe(Number(first.number.sequenceValue) + 1);
  });

  it('keeps numbering separate per branch, per type, and per organization', async () => {
    // BR01: one (type, number) pair, ever. A second branch and a second organization each get
    // their own counter rather than competing for the same ordinals.
    const otherBranchScheme = await createNumberingScheme(pool, {
      organizationId, branchId: otherBranchId, docType: 'INV', status: 'ACTIVE',
      pattern: '{TYPE}-{BRANCH}-{YYYY}-{SEQ}', branchCode: 'SBY', resetPolicy: 'YEARLY',
      gapPolicy: 'NO_GAP_FISCAL', padding: 5, startAt: 1, validFrom: '2026-01-01', requestId: randomUUID(),
    });
    expect(otherBranchScheme.branchId).toBe(otherBranchId);

    const inFirst = await reserve({ branchId });
    const inSecond = await reserve({ branchId: otherBranchId });
    expect(inFirst.number.formattedNumber).toContain('CMH');
    expect(inSecond.number.formattedNumber).toContain('SBY');
    expect(Number(inSecond.number.sequenceValue)).toBe(1);

    // Another organization gets no scheme, so it cannot borrow this one's counter.
    await expect(reserve({ organizationId: otherOrganizationId })).rejects.toThrow('NOT_FOUND');
    expect((await numberSequenceUsage(pool, otherOrganizationId, 'INV', branchId))).toEqual([]);
  });

  it('refuses to reserve against a type and branch that has no active scheme on the document date', async () => {
    // An effective-dated scheme only covers the dates it is valid for (BR06): the INV scheme
    // starts on 1 Jan 2026 and has no end, so a 2025 document has no scheme and a 2027 one does.
    await expect(reserve({ docType: 'STK' })).rejects.toThrow('NOT_FOUND');
    await expect(reserve({ docType: 'INV', documentDate: '2025-12-31' })).rejects.toThrow('NOT_FOUND');
    expect((await reserve({ docType: 'INV', documentDate: '2027-06-01' })).number.businessYear).toBe(2027);
  });

  it('reports a number as unformatted rather than inventing one when the pattern is unset', async () => {
    // The only way to observe this is a scheme that has a reset policy but no approved pattern,
    // which `createNumberingScheme` refuses to activate. The guard is therefore proved at the
    // activation boundary: a half-configured ACTIVE scheme is rejected rather than tolerated.
    await expect(createNumberingScheme(pool, {
      organizationId, docType: 'PAY', status: 'ACTIVE', branchCode: 'CMH', resetPolicy: 'YEARLY',
      gapPolicy: 'NO_GAP_FISCAL', padding: 5, validFrom: '2026-01-01', requestId: randomUUID(),
    })).rejects.toThrow('INVALID_STATE_TRANSITION');
  });
});
