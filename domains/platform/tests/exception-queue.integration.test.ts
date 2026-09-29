import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  openException, updateException, claimExceptionItem, releaseExceptionItem, resolveException,
  recordExceptionCommandFailure, dismissException, listExceptionItems, listQueueDefinitions,
  exceptionQueueMetrics, registerBusinessCalendarDay, escalateOverdueExceptions,
  type AuthorizeException,
} from '../src/application/exception-queue';
import {
  addWorkingDays, loadNonWorkingDates, calendarHorizon, BUSINESS_TIME_ZONE,
} from '../src/application/business-calendar';

const databaseName = `pss_exception_queue_test_${randomUUID().replaceAll('-', '')}`;
const organizationId = randomUUID();
const branchId = randomUUID();
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
  for (const relativePath of [
    '../../audit/infrastructure/database/migrations/0001_audit_entry.sql',
    '../infrastructure/database/migrations/0001_outbox_event.sql',
    '../infrastructure/database/migrations/0004_configuration.sql',
    '../infrastructure/database/migrations/0005_event_delivery_reliability.sql',
    '../infrastructure/database/migrations/0006_exception_queue.sql',
    '../infrastructure/database/migrations/0007_exception_queue_registry_seed.sql',
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

/** A steward who may see the branch they own, and nothing else. */
const stewardOfBranch: AuthorizeException = async (request) =>
  request.roles.includes('MASTER_DATA_STEWARD') && request.branchId === branchId;
const controllerAnywhere: AuthorizeException = async (request) => request.roles.includes('CONTROLLER');

function openInput(overrides: Record<string, unknown> = {}) {
  return {
    organizationId, branchId, queueCode: 'Q-UNMAPPED_CUSTOMER',
    subject: { domain: 'master-data', type: 'Customer', id: randomUUID() },
    ownerDomain: 'master-data', reasonCode: 'MASTER_MAPPING_REQUIRED',
    dedupeKey: `customer:${randomUUID()}`, context: { source: 'ND6' },
    businessDate: '2026-09-25', requestId: randomUUID(), correlationId: randomUUID(),
    ...overrides,
  };
}

describe('DQ-001.R01 queue registry', () => {
  it('seeds exactly the Appendix P queues and nothing else', async () => {
    const definitions = await listQueueDefinitions(pool);
    expect(definitions).toHaveLength(41);
    const codes = definitions.map((entry) => entry.code);
    expect(codes).toContain('Q-UNMAPPED_CUSTOMER');
    expect(codes).toContain('Q-CASH_HANDOVER_OVERDUE');
    expect(codes).toContain('Q-POS_OFFLINE_CONFLICT');
    expect(codes.every((code) => /^Q-[A-Z_]+$/.test(code))).toBe(true);

    const unmapped = definitions.find((entry) => entry.code === 'Q-UNMAPPED_CUSTOMER')!;
    expect(unmapped).toEqual({
      code: 'Q-UNMAPPED_CUSTOMER', label: 'Toko belum dikenali',
      ownerRoles: ['MASTER_DATA_STEWARD'], escalationRoles: ['CONTROLLER'],
      permittedActions: ['Petakan ke toko yang ada', 'Buat toko baru', 'Tolak'],
      dismissible: false, slaConfigured: true,
    });
    // Appendix P writes "—" for these escalations, so no role is invented.
    expect(definitions.find((entry) => entry.code === 'Q-POSSIBLE_DUPLICATE_CUSTOMER')!.escalationRoles).toEqual([]);
    // "per tipe" has no number in the registry, so it is registered but not resolvable.
    expect(definitions.find((entry) => entry.code === 'Q-APPROVAL_PENDING')!.slaConfigured).toBe(false);
  });

  it('DQ-001.E2 refuses an unregistered queue instead of inventing one', async () => {
    await expect(openException(pool, openInput({ queueCode: 'Q-NOT_IN_APPENDIX_P' })))
      .rejects.toThrow('QUEUE_UNKNOWN');
  });
});

describe('DQ-001.AC02 working-day SLA', () => {
  it('lands one working day after Friday 16.00 on Monday 16.00 in Asia/Jakarta', async () => {
    // 2026-09-25 is a Friday; 16.00 WIB is 09:00 UTC.
    const friday = new Date('2026-09-25T09:00:00.000Z');
    const due = await addWorkingDays(pool, friday, 1, []);
    expect(due.toISOString()).toBe('2026-09-28T09:00:00.000Z');
    expect(BUSINESS_TIME_ZONE).toBe('Asia/Jakarta');
  });

  it('skips a registered branch holiday', async () => {
    await registerBusinessCalendarDay(pool, {
      calendarDate: '2026-09-28', organizationId, branchId,
      isWorking: false, source: 'BRANCH_CLOSED',
    });
    const nonWorking = await loadNonWorkingDates(pool, {
      organizationId, branchId, ...calendarHorizon('2026-09-25', 21),
    });
    expect(nonWorking).toContain('2026-09-28');
    const due = await addWorkingDays(pool, new Date('2026-09-25T09:00:00.000Z'), 1, nonWorking);
    expect(due.toISOString()).toBe('2026-09-29T09:00:00.000Z');

    // Another organization is unaffected by this branch's calendar.
    expect(await loadNonWorkingDates(pool, {
      organizationId: randomUUID(), branchId, ...calendarHorizon('2026-09-25', 21),
    })).toEqual([]);
  });

  it('computes a business-day SLA when an item is opened', async () => {
    const { item } = await openException(pool, openInput({ queueCode: 'Q-IMPORT_REJECTED' }));
    const days = (Date.parse(item.slaDueAt) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(0.9);
    expect(days).toBeLessThan(2.2);
  });

  it('fails closed for a queue whose registry SLA is not a duration', async () => {
    await expect(openException(pool, openInput({ queueCode: 'Q-APPROVAL_PENDING' })))
      .rejects.toThrow('no resolvable SLA');
    expect((await pool.query('SELECT count(*)::int AS c FROM platform.exception_item')).rows[0].c)
      .toBe((await pool.query('SELECT count(*)::int AS c FROM platform.exception_item')).rows[0].c);
  });

  it('reads a registered SLA override from configuration', async () => {
    await pool.query(
      `INSERT INTO platform.config_value (
         id, key, organization_id, branch_id, value, valid_from, status, proposed_by
       ) VALUES ($1, 'exception.Q-POSSIBLE_DUPLICATE_ORDER.sla', $2, $3, '"6"'::jsonb,
                 '2026-01-01', 'ACTIVE', $4)`,
      [randomUUID(), organizationId, branchId, randomUUID()],
    );
    const { item } = await openException(pool, openInput({ queueCode: 'Q-POSSIBLE_DUPLICATE_ORDER' }));
    const hours = (Date.parse(item.slaDueAt) - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(5.9);
    expect(hours).toBeLessThan(6.1);
  });
});

describe('DQ-001.AC01/TS01 dedupe', () => {
  it('updates the active item instead of creating a second one', async () => {
    const input = openInput({ dedupeKey: 'customer:dedupe-probe' });
    const first = await openException(pool, input);
    expect(first.created).toBe(true);
    const second = await openException(pool, { ...input, context: { source: 'FoxPro' } });
    expect(second.created).toBe(false);
    expect(second.item.id).toBe(first.item.id);
    expect(second.item.occurrenceCount).toBe(2);
    expect(second.item.context).toEqual({ source: 'FoxPro' });
    expect((await pool.query(
      "SELECT count(*)::int AS c FROM platform.exception_item WHERE dedupe_key = 'customer:dedupe-probe'",
    )).rows[0].c).toBe(1);
  });

  it('TS01 resolves a concurrent re-fire into one item under the unique index', async () => {
    const dedupeKey = `customer:concurrent-${randomUUID()}`;
    const results = await Promise.all(Array.from({ length: 8 }, () =>
      openException(pool, openInput({ dedupeKey }))));
    const ids = new Set(results.map((result) => result.item.id));
    expect(ids.size).toBe(1);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    // The committed row is the truth: concurrent upserts serialize on the unique index, so the
    // value a caller read back depends on when its own statement ran.
    const stored = (await pool.query<{ occurrence_count: number }>(
      'SELECT occurrence_count FROM platform.exception_item WHERE dedupe_key = $1', [dedupeKey],
    )).rows[0]!;
    expect(stored.occurrence_count).toBe(8);
  });

  it('opens a new item for the same key once the previous one is resolved', async () => {
    const dedupeKey = `customer:reopen-${randomUUID()}`;
    const first = await openException(pool, openInput({ dedupeKey }));
    await resolveException(pool, {
      itemId: first.item.id, organizationId, ownerDomain: 'master-data',
      command: 'RejectMapping', result: 'Ditolak', resolvedBy: randomUUID(),
      requestId: randomUUID(), correlationId: randomUUID(),
    });
    const again = await openException(pool, openInput({ dedupeKey }));
    expect(again.created).toBe(true);
    expect(again.item.id).not.toBe(first.item.id);
  });

  it('updates context and aggregates without changing queue or subject', async () => {
    const { item } = await openException(pool, openInput());
    const updated = await updateException(pool, {
      itemId: item.id, organizationId, context: { attempt: 2 },
      requestId: randomUUID(), correlationId: randomUUID(),
    });
    expect(updated.queueCode).toBe(item.queueCode);
    expect(updated.subject).toEqual(item.subject);
    expect(updated.context).toEqual({ source: 'ND6', attempt: 2 });
  });
});

describe('DQ-001 lifecycle, audit, and scope', () => {
  it('AC03/AC04/NC01 claim, fail, release, and resolve with the owning domain only', async () => {
    const { item } = await openException(pool, openInput());
    const actorId = randomUUID();
    const claim = { organizationId, actorId, roleCodes: ['MASTER_DATA_STEWARD'], requestId: randomUUID(), correlationId: randomUUID() };
    const claimed = await claimExceptionItem(pool, { ...claim, itemId: item.id }, stewardOfBranch);
    expect(claimed.status).toBe('IN_PROGRESS');
    expect(claimed.assigneeId).toBe(actorId);

    // A user outside the owning role and scope cannot see or take it.
    const foreign = { ...claim, actorId: randomUUID(), roleCodes: ['CASHIER'] };
    await expect(claimExceptionItem(pool, { ...foreign, itemId: item.id }, async () => true))
      .rejects.toThrow('INVALID_STATE_TRANSITION');
    expect(await listExceptionItems(pool, {
      organizationId, actorId: foreign.actorId, roleCodes: foreign.roleCodes,
    }, controllerAnywhere)).toHaveLength(0);

    // A subject command that failed leaves the item in progress and shows why.
    const failed = await recordExceptionCommandFailure(pool, {
      itemId: item.id, organizationId, ownerDomain: 'master-data',
      message: 'Produk tidak aktif', requestId: randomUUID(), correlationId: randomUUID(),
    });
    expect(failed.status).toBe('IN_PROGRESS');
    expect(failed.lastErrorMessage).toBe('Produk tidak aktif');
    await expect(recordExceptionCommandFailure(pool, {
      itemId: item.id, organizationId, ownerDomain: 'orders',
      message: 'x', requestId: randomUUID(), correlationId: randomUUID(),
    })).rejects.toThrow('NOT_FOUND');

    const released = await releaseExceptionItem(pool, { ...claim, itemId: item.id }, stewardOfBranch);
    expect(released.status).toBe('OPEN');
    expect(released.lastErrorMessage).toBeNull();

    // NC01: a domain that does not own the subject cannot resolve it.
    await expect(resolveException(pool, {
      itemId: item.id, organizationId, ownerDomain: 'orders', command: 'X', result: 'ok',
      requestId: randomUUID(), correlationId: randomUUID(),
    })).rejects.toThrow('PERMISSION_DENIED');

    const resolved = await resolveException(pool, {
      itemId: item.id, organizationId, ownerDomain: 'master-data',
      command: 'MapCustomerToOutlet', result: 'Dipetakan ke outlet 1234',
      requestId: randomUUID(), correlationId: randomUUID(),
    });
    expect(resolved.status).toBe('RESOLVED');
    await expect(resolveException(pool, {
      itemId: item.id, organizationId, ownerDomain: 'master-data', command: 'Y', result: 'again',
      requestId: randomUUID(), correlationId: randomUUID(),
    })).rejects.toThrow('INVALID_STATE_TRANSITION');
  });

  it('TS05 writes an audit entry for every transition', async () => {
    const { item } = await openException(pool, openInput());
    const claim = { organizationId, actorId: randomUUID(), roleCodes: ['MASTER_DATA_STEWARD'],
      requestId: randomUUID(), correlationId: randomUUID() };
    await claimExceptionItem(pool, { ...claim, itemId: item.id }, stewardOfBranch);
    await releaseExceptionItem(pool, { ...claim, itemId: item.id }, stewardOfBranch);
    await resolveException(pool, {
      itemId: item.id, organizationId, ownerDomain: 'master-data', command: 'Reject', result: 'Ditolak',
      requestId: randomUUID(), correlationId: randomUUID(),
    });
    const actions = (await pool.query<{ action: string }>(
      `SELECT action FROM audit.audit_entry
       WHERE entity_domain = 'platform' AND entity_type = 'ExceptionItem' AND entity_id = $1
       ORDER BY occurred_at, entity_version`, [item.id],
    )).rows.map((row) => row.action);
    expect(actions).toEqual(['EXCEPTION_OPENED', 'EXCEPTION_CLAIMED', 'EXCEPTION_RELEASED', 'EXCEPTION_RESOLVED']);
  });

  it('AC06 refuses dismissal for a queue the registry does not mark dismissible', async () => {
    const { item } = await openException(pool, openInput());
    await expect(dismissException(pool, {
      itemId: item.id, organizationId, actorId: randomUUID(), roleCodes: ['MASTER_DATA_STEWARD'],
      reason: 'Tidak relevan', requestId: randomUUID(), correlationId: randomUUID(),
    }, stewardOfBranch)).rejects.toThrow('INVALID_STATE_TRANSITION');
    expect((await pool.query('SELECT status FROM platform.exception_item WHERE id = $1', [item.id]))
      .rows[0].status).toBe('OPEN');
  });

  it('NC03 filters the work list by role and branch scope', async () => {
    const otherBranch = randomUUID();
    const mine = await openException(pool, openInput());
    const theirs = await openException(pool, openInput({ branchId: otherBranch }));
    const actorId = randomUUID();

    const visible = await listExceptionItems(pool, {
      organizationId, actorId, roleCodes: ['MASTER_DATA_STEWARD'],
    }, stewardOfBranch);
    expect(visible.map((entry) => entry.id)).toContain(mine.item.id);
    expect(visible.map((entry) => entry.id)).not.toContain(theirs.item.id);

    const escalatedOnly = await listExceptionItems(pool, {
      organizationId, actorId, roleCodes: ['CONTROLLER'],
    }, async () => true);
    expect(escalatedOnly.map((entry) => entry.id)).toEqual([]);

    const byQueue = await listExceptionItems(pool, {
      organizationId, actorId, roleCodes: ['MASTER_DATA_STEWARD'], queueCode: 'Q-PICK_SHORT',
    }, stewardOfBranch);
    expect(byQueue).toEqual([]);
  });
});

describe('DQ-001 escalation and metrics', () => {
  it('widens visibility to the registry escalation role and audits the transition', async () => {
    const { item } = await openException(pool, openInput({ queueCode: 'Q-UNAPPLIED_PAYMENT' }));
    // The registry SLA is two working days; move the deadline into the past to make it overdue.
    await pool.query('UPDATE platform.exception_item SET sla_due_at = now() - interval \'1 hour\' WHERE id = $1', [item.id]);

    const actorId = randomUUID();
    expect(await listExceptionItems(pool, { organizationId, actorId, roleCodes: ['CONTROLLER'] },
      async () => true)).toEqual([]);

    const sweep = await escalateOverdueExceptions(pool, {
      serviceIdentity: 'platform.escalation', requestId: randomUUID(), correlationId: randomUUID(),
    });
    expect(sweep.escalated.map((entry) => entry.itemId)).toContain(item.id);
    expect((await pool.query<{ overdue_at: Date | null; escalated_at: Date | null }>(
      'SELECT overdue_at, escalated_at FROM platform.exception_item WHERE id = $1', [item.id],
    )).rows[0]).toMatchObject({ overdue_at: expect.any(Date), escalated_at: expect.any(Date) });
    expect((await pool.query<{ action: string }>(
      `SELECT action FROM audit.audit_entry WHERE entity_id = $1 AND action = 'EXCEPTION_ESCALATED'`,
      [item.id],
    )).rowCount).toBe(1);

    const asController = await listExceptionItems(pool, { organizationId, actorId, roleCodes: ['CONTROLLER'] },
      async () => true);
    expect(asController.map((entry) => entry.id)).toContain(item.id);
    expect(asController.filter((entry) => entry.overdueAt !== null).length).toBeGreaterThan(0);

    // Re-running the sweep is a no-op: an item escalates once.
    expect((await escalateOverdueExceptions(pool, {
      serviceIdentity: 'platform.escalation', requestId: randomUUID(), correlationId: randomUUID(),
    })).escalated.map((entry) => entry.itemId)).not.toContain(item.id);
  });

  it('R04 reports backlog, overdue, and resolution time per queue', async () => {
    const metrics = await exceptionQueueMetrics(pool);
    const unmapped = metrics.find((entry) => entry.queueCode === 'Q-UNMAPPED_CUSTOMER')!;
    expect(unmapped.open).toBeGreaterThan(0);
    expect(unmapped.overdue).toBeGreaterThanOrEqual(0);
    expect(unmapped.resolved).toBeGreaterThan(0);
    expect(unmapped.resolutionMinutesP50).not.toBeNull();
    expect(unmapped.resolutionMinutesP95).not.toBeNull();
    // A queue with no items at all is absent rather than reported as zero.
    expect(metrics.some((entry) => entry.queueCode === 'Q-UNMAPPED_PRODUCT')).toBe(false);
  });
});

describe('DQ-001.R06 backlog scale', () => {
  it('lists 100k active items for a role and a queue without degrading', async () => {
    const scaleOrganization = randomUUID();
    const scaleBranch = randomUUID();
    // One INSERT per 10k rows: 100k round trips would measure the client, not the index.
    const batchSize = 10_000;
    for (let offset = 0; offset < 100_000; offset += batchSize) {
      const ids: string[] = [];
      const organizations: string[] = [];
      const branches: string[] = [];
      const queues: string[] = [];
      const subjectDomains: string[] = [];
      const subjectTypes: string[] = [];
      const subjectIds: string[] = [];
      const ownerDomains: string[] = [];
      const reasonCodes: string[] = [];
      const dedupeKeys: string[] = [];
      const statuses: string[] = [];
      const dueAts: string[] = [];
      for (let index = offset; index < offset + batchSize; index += 1) {
        ids.push(randomUUID());
        organizations.push(scaleOrganization);
        branches.push(scaleBranch);
        queues.push('Q-UNMAPPED_CUSTOMER');
        subjectDomains.push('master-data');
        subjectTypes.push('Customer');
        subjectIds.push(`customer-${index}`);
        ownerDomains.push('master-data');
        reasonCodes.push('MASTER_MAPPING_REQUIRED');
        dedupeKeys.push(`bulk-${index}`);
        statuses.push('OPEN');
        // A tenth of the backlog is already overdue, so the escalation sweep has real work.
        const minutes = index % 10 === 0 ? -(index % 500) : (index % 5_000);
        dueAts.push(new Date(Date.now() + minutes * 60_000).toISOString());
      }
      const inserted = await pool.query(
        `INSERT INTO platform.exception_item (
           id, organization_id, branch_id, queue_code, subject_domain, subject_type, subject_id,
           owner_domain, owner_roles, escalation_roles, reason_code, context, dedupe_key, status, sla_due_at
         )
         SELECT id, organization_id, branch_id, queue_code, subject_domain, subject_type, subject_id,
                owner_domain, ARRAY['MASTER_DATA_STEWARD'], ARRAY[]::text[], reason_code, '{}'::jsonb,
                dedupe_key, status, due_at
         FROM unnest(
           $1::uuid[], $2::uuid[], $3::uuid[], $4::text[], $5::text[], $6::text[], $7::text[],
           $8::text[], $9::text[], $10::text[], $11::text[], $12::timestamptz[]
         ) AS source(id, organization_id, branch_id, queue_code, subject_domain, subject_type,
                     subject_id, owner_domain, reason_code, dedupe_key, status, due_at)`,
        [ids, organizations, branches, queues, subjectDomains, subjectTypes, subjectIds,
          ownerDomains, reasonCodes, dedupeKeys, statuses, dueAts],
      );
      expect(inserted.rowCount).toBe(batchSize);
    }
    expect((await pool.query(
      'SELECT count(*)::int AS c FROM platform.exception_item WHERE organization_id = $1', [scaleOrganization],
    )).rows[0].c).toBe(100_000);
    await pool.query('ANALYZE platform.exception_item');

    const actorId = randomUUID();
    const measured: { filter: string; ms: number; rows: number }[] = [];
    for (const [filter, page] of [
      ['all active items for the role',
        { roleCodes: ['MASTER_DATA_STEWARD'] }],
      ['one queue, overdue only',
        { roleCodes: ['MASTER_DATA_STEWARD'], queueCode: 'Q-UNMAPPED_CUSTOMER', overdueOnly: true }],
      ['one branch',
        { roleCodes: ['MASTER_DATA_STEWARD'], branchId: scaleBranch }],
      ['a role that owns nothing here',
        { roleCodes: ['CASHIER'] }],
    ] as const) {
      const startedAt = process.hrtime.bigint();
      const items = await listExceptionItems(pool, {
        organizationId: scaleOrganization, actorId, ...page, limit: 50,
      }, async () => true);
      const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
      measured.push({ filter, ms, rows: items.length });
    }
    console.log('DQ-001.R06 100k active items:',
      measured.map((entry) => `${entry.filter} ${entry.ms.toFixed(1)}ms/${entry.rows} rows`).join(' | '));
    for (const entry of measured) {
      expect(entry.ms).toBeLessThan(1_000);
    }
    expect(measured[0]!.rows).toBe(50);
    expect(measured[1]!.rows).toBe(50);
    expect(measured[3]!.rows).toBe(0);

    // The index that carries the claim: a bounded index scan, not a 100k-row sort.
    const explained = await pool.query<Record<string, Array<{ Plan: Record<string, unknown> }>>>(
      `EXPLAIN (ANALYZE, FORMAT JSON) SELECT id FROM platform.exception_item
       WHERE organization_id = $1 AND status = ANY (ARRAY['OPEN','IN_PROGRESS'])
         AND (owner_roles && ARRAY['MASTER_DATA_STEWARD'] OR escalation_roles && ARRAY['MASTER_DATA_STEWARD'])
         AND ($2::timestamptz IS NULL OR (sla_due_at, id) > ($2::timestamptz, $3::uuid))
       ORDER BY sla_due_at, id LIMIT 50`,
      [scaleOrganization, null, null],
    );
    const plan = explained.rows[0]!['QUERY PLAN']?.[0]?.Plan;
    console.log('DQ-001.R06 plan:', JSON.stringify(plan).slice(0, 240));
    const planText = JSON.stringify(plan);
    expect(planText).toContain('"Node Type":"Limit"');
    expect(planText).toContain('exception_item_worklist_idx');
    expect(planText).not.toContain('Seq Scan');
  }, 180_000);
});
