import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newEventId } from '@pss/contracts';
import { scheduleTaxRate } from '../src/application/schedule-tax-rate';
import {
  applyApprovalDecision, TAX_RATE_CHANGE_APPROVAL_TYPE,
} from '../src/application/apply-approval-decision';
import { loadApplicableTaxRates } from '../src/application/tax-rate-resolver';
import { createTestDatabase } from './database-fixture';

let pool: pg.Pool;
let dropDatabase: () => Promise<void>;

/**
 * TAX-001 main flow 2-4, against a real database: a rate is scheduled SCHEDULED and only becomes
 * applicable once an approval decides it. The `APPROVAL_DECIDED` envelope below is built by hand
 * because producing one for real means standing up the approval engine's policy, level and
 * request tables — which is the approval engine's test, not this one's.
 */
function approvalDecided(input: {
  organizationId: string;
  requestId: string;
  decision: 'APPROVED' | 'REJECTED';
}): unknown {
  return {
    eventId: newEventId(),
    eventType: 'APPROVAL_DECIDED',
    eventVersion: 1,
    occurredAt: new Date().toISOString(),
    businessDate: '2026-03-10',
    organizationId: input.organizationId,
    aggregateType: 'ApprovalRequest',
    aggregateId: input.requestId,
    aggregateVersion: 2,
    producer: 'approval',
    actor: { userId: randomUUID(), roles: ['CONTROLLER'] },
    correlationId: randomUUID(),
    causationId: randomUUID(),
    payload: {
      requestId: input.requestId,
      type: TAX_RATE_CHANGE_APPROVAL_TYPE,
      subjectRef: randomUUID(),
      ownerDomain: 'tax',
      decision: input.decision,
      decidedBy: randomUUID(),
      level: 2,
    },
  };
}

function auditContext() {
  return {
    organizationId: randomUUID(), taxCode: 'VAT_OUTPUT' as const, rate: '11.000000',
    validFrom: '2026-04-01', approvalId: randomUUID(),
    reason: 'Kenaikan tarif PPN',
    actor: { userId: randomUUID(), roles: ['FINANCE_MAKER'] },
    requestId: randomUUID(), correlationId: randomUUID(), source: 'API' as const,
  };
}

beforeAll(async () => {
  const created = await createTestDatabase('pss_tax_test');
  pool = created.pool;
  dropDatabase = created.drop;
  await pool.query(
    `INSERT INTO core.tax_code (id, code, name, zero_rated)
     VALUES ($1, 'VAT_OUTPUT', 'PPN Keluaran', false), ($2, 'EXEMPT', 'Bebas PPN', true)
     ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, zero_rated = EXCLUDED.zero_rated`,
    [randomUUID(), randomUUID()],
  );
}, 60_000);

afterAll(async () => {
  // `beforeAll` failing means there is no database to drop; guarding keeps the original failure as
  // the reported one instead of a second error about a missing fixture.
  if (dropDatabase) await dropDatabase();
});

describe('TAX-001.BR02 scheduling a rate writes a new row and closes its predecessor', () => {
  it('stores the new rate SCHEDULED and leaves the predecessor effective up to the new date', async () => {
    const organizationId = randomUUID();
    const first = await scheduleTaxRate(pool, undefined, {
      ...auditContext(), organizationId, taxCode: 'VAT_OUTPUT', rate: '11.000000', validFrom: '2026-01-01',
    });
    expect(first.status).toBe('SCHEDULED');

    const second = await scheduleTaxRate(pool, undefined, {
      ...auditContext(), organizationId, taxCode: 'VAT_OUTPUT', rate: '12.000000', validFrom: '2026-04-01',
    });

    const rows = await pool.query(
      `SELECT rate::text AS rate, valid_from::text AS valid_from, valid_to::text AS valid_to, status
       FROM core.tax_rate WHERE organization_id = $1 ORDER BY valid_from`,
      [organizationId],
    );
    expect(rows.rows).toEqual([
      { rate: '11.000000', valid_from: '2026-01-01', valid_to: '2026-04-01', status: 'SCHEDULED' },
      { rate: '12.000000', valid_from: '2026-04-01', valid_to: null, status: 'SCHEDULED' },
    ]);
    expect(second.taxRateId).not.toBe(first.taxRateId);
  });

  it('audits the scheduling, including the approval it is waiting on', async () => {
    const input = auditContext();
    const scheduled = await scheduleTaxRate(pool, undefined, input);

    const { rows } = await pool.query(
      `SELECT action, changes FROM audit.audit_entry
       WHERE entity_id = $1 AND entity_domain = 'tax'`,
      [scheduled.taxRateId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('TAX_RATE_SCHEDULED');
    expect(rows[0].changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'rate', after: input.rate }),
      expect.objectContaining({ path: 'approvalId', after: input.approvalId }),
    ]));
  });

  it('refuses a zero-rated code, which has no rate to schedule', async () => {
    await expect(scheduleTaxRate(pool, undefined, { ...auditContext(), taxCode: 'EXEMPT' }))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('refuses a rate that would start before one already in force (DB.R06)', async () => {
    const organizationId = randomUUID();
    await scheduleTaxRate(pool, undefined, {
      ...auditContext(), organizationId, validFrom: '2026-03-01',
    });

    // A later valid_from supersedes and is allowed; an EARLIER one cannot, because the row already
    // in force would then overlap. The exclusion constraint rejects it — a check-then-write in the
    // command would still race two concurrent schedulers.
    await expect(scheduleTaxRate(pool, undefined, {
      ...auditContext(), organizationId, validFrom: '2026-01-01',
    })).rejects.toThrow(/tax_rate_effective_range_excl|conflicting key value/);

    const rows = await pool.query(
      `SELECT valid_from::text AS valid_from FROM core.tax_rate WHERE organization_id = $1`,
      [organizationId],
    );
    expect(rows.rows).toEqual([{ valid_from: '2026-03-01' }]);
  });

  it('rejects an UPDATE that rewrites a rate, so a used rate is never edited (TAX-001.BR02)', async () => {
    const organizationId = randomUUID();
    const scheduled = await scheduleTaxRate(pool, undefined, { ...auditContext(), organizationId });

    await expect(pool.query(
      `UPDATE core.tax_rate SET rate = 5 WHERE id = $1`, [scheduled.taxRateId],
    )).rejects.toThrow(/never rewritten/);
    // Lifecycle columns stay writable, because DB.R06 requires the predecessor's range to be closed.
    await expect(pool.query(
      `UPDATE core.tax_rate SET status = 'ACTIVE', valid_to = '2026-12-31' WHERE id = $1`,
      [scheduled.taxRateId],
    )).resolves.toMatchObject({ rowCount: 1 });
  });

  it('refuses to delete a rate, so the history of what applied stays intact', async () => {
    const organizationId = randomUUID();
    const scheduled = await scheduleTaxRate(pool, undefined, { ...auditContext(), organizationId });

    await expect(pool.query(`DELETE FROM core.tax_rate WHERE id = $1`, [scheduled.taxRateId]))
      .rejects.toThrow(/never rewritten/);
  });
});

describe('TAX-001.NC02 a rate cannot become ACTIVE without an approved decision', () => {
  it('is not applicable while SCHEDULED, however old its valid_from is', async () => {
    const organizationId = randomUUID();
    await scheduleTaxRate(pool, undefined, {
      ...auditContext(), organizationId, validFrom: '2020-01-01',
    });

    expect(await loadApplicableTaxRates(pool, organizationId, '2026-03-10')).toEqual([]);
  });

  it('becomes applicable once APPROVAL_DECIDED approves it, and the change is audited', async () => {
    const organizationId = randomUUID();
    const scheduled = await scheduleTaxRate(pool, undefined, {
      ...auditContext(), organizationId, validFrom: '2020-01-01',
    });

    const result = await applyApprovalDecision(
      pool, approvalDecided({ organizationId, requestId: scheduled.approvalId, decision: 'APPROVED' }),
    );
    expect(result).toMatchObject({ status: 'PROCESSED' });
    expect((result as { value: { status: string } }).value?.status).toBe('ACTIVE');

    const rates = await loadApplicableTaxRates(pool, organizationId, '2026-03-10');
    expect(rates).toEqual([
      { taxCode: 'VAT_OUTPUT', rate: '11.000000', validFrom: '2020-01-01', validTo: null, rateId: scheduled.taxRateId },
    ]);

    const { rows } = await pool.query(
      `SELECT action FROM audit.audit_entry WHERE entity_id = $1 AND action = 'TAX_RATE_ACTIVATED'`,
      [scheduled.taxRateId],
    );
    expect(rows).toHaveLength(1);
  });

  it('stays SCHEDULED — and unapplied — when the approval is rejected', async () => {
    const organizationId = randomUUID();
    const scheduled = await scheduleTaxRate(pool, undefined, {
      ...auditContext(), organizationId, validFrom: '2020-01-01',
    });

    await applyApprovalDecision(
      pool, approvalDecided({ organizationId, requestId: scheduled.approvalId, decision: 'REJECTED' }),
    );

    expect(await loadApplicableTaxRates(pool, organizationId, '2026-03-10')).toEqual([]);
    const status = await pool.query(
      `SELECT status FROM core.tax_rate WHERE id = $1`, [scheduled.taxRateId],
    );
    expect(status.rows[0].status).toBe('SCHEDULED');
  });

  it('applies the activation once for a redelivered event (PLT-005.BR03)', async () => {
    const organizationId = randomUUID();
    const scheduled = await scheduleTaxRate(pool, undefined, {
      ...auditContext(), organizationId, validFrom: '2020-01-01',
    });
    const event = approvalDecided({
      organizationId, requestId: scheduled.approvalId, decision: 'APPROVED',
    });

    expect((await applyApprovalDecision(pool, event)).status).toBe('PROCESSED');
    const replay = await applyApprovalDecision(pool, event);
    expect(replay.status).toBe('DUPLICATE');

    const audits = await pool.query(
      `SELECT count(*)::int AS count FROM audit.audit_entry
       WHERE entity_id = $1 AND action = 'TAX_RATE_ACTIVATED'`,
      [scheduled.taxRateId],
    );
    expect(audits.rows[0].count).toBe(1);
  });

  it('ignores an approval belonging to another organization', async () => {
    const organizationId = randomUUID();
    const scheduled = await scheduleTaxRate(pool, undefined, { ...auditContext(), organizationId });

    // The decision names the right approval id but arrives for a different organization: resolving
    // by approval id alone would let one tenant activate another's rate.
    await applyApprovalDecision(pool, approvalDecided({
      organizationId: randomUUID(), requestId: scheduled.approvalId, decision: 'APPROVED',
    }));

    expect(await loadApplicableTaxRates(pool, organizationId, '2026-03-10')).toEqual([]);
  });

  it('ignores an approval for another owner domain or approval type', async () => {
    const organizationId = randomUUID();
    const scheduled = await scheduleTaxRate(pool, undefined, { ...auditContext(), organizationId });

    const foreign = approvalDecided({
      organizationId, requestId: scheduled.approvalId, decision: 'APPROVED',
    }) as { payload: Record<string, unknown> };
    expect(await applyApprovalDecision(pool, {
      ...foreign, payload: { ...foreign.payload, ownerDomain: 'commercial' },
    })).toBeNull();
    expect(await applyApprovalDecision(pool, {
      ...foreign, payload: { ...foreign.payload, type: 'credit_profile_change' },
    })).toBeNull();

    expect(await loadApplicableTaxRates(pool, organizationId, '2026-03-10')).toEqual([]);
  });
});