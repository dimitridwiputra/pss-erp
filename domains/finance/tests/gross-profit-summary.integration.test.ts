import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations } from '../../../scripts/apply-migrations.mjs';
import { grossProfitSummary } from '../src/application/queries';

const databaseName = `pss_finance_summary_${randomUUID().replaceAll('-', '')}`;
const organizationId = randomUUID();
const branchA = randomUUID();
const branchB = randomUUID();
let admin: pg.Client;
let pool: pg.Pool;
let periodId: string;

beforeAll(async () => {
  const baseUrl = process.env.PSS_TEST_DATABASE_URL;
  if (!baseUrl) throw new Error('PSS_TEST_DATABASE_URL is required.');
  admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${databaseName}`);
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  pool = new pg.Pool({ connectionString: url.toString() });
  await applyMigrations(pool, 'finance');
  await pool.query(`INSERT INTO finance.account (code, name, type, normal_balance) VALUES
    ('1-1100','Kas','ASSET','DEBIT'),('1-1400','Persediaan','ASSET','DEBIT'),
    ('4-1000','Penjualan','REVENUE','CREDIT'),('5-1000','HPP','EXPENSE','DEBIT')`);
  await pool.query(`INSERT INTO finance.account_role_mapping (role_code, account_code, effective_from)
    VALUES ('SALES_REVENUE','4-1000','2026-01-01'),('COGS','5-1000','2026-01-01')`);
  periodId = (await pool.query<{ id: string }>(
    `INSERT INTO finance.accounting_period (organization_id, code, status)
     VALUES ($1,'2026-10','OPEN') RETURNING id`, [organizationId],
  )).rows[0]!.id;
}, 30_000);

afterAll(async () => {
  await pool?.end();
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
    await admin.end();
  }
});

async function post(branchId: string | null, sales: string, cogs: string) {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO finance.journal (id, organization_id, number, period_id, business_date,
       source_type, status, branch_id)
     VALUES ($1,$2,$3,$4,'2026-10-15','INVOICE_ISSUED','DRAFT',$5)`,
    [id, organizationId, id, periodId, branchId],
  );
  await pool.query(`INSERT INTO finance.journal_line
    (journal_id, line_number, account_code, debit, credit) VALUES
    ($1,1,'1-1100',$2,0),($1,2,'4-1000',0,$2),
    ($1,3,'5-1000',$3,0),($1,4,'1-1400',0,$3)`, [id, sales, cogs]);
  await pool.query(`UPDATE finance.journal SET status = 'POSTED' WHERE id = $1`, [id]);
}

describe('MVP-OD-10 posted Finance gross-profit summary', () => {
  it('returns only the assigned branch while an organization scope sees both branches', async () => {
    await post(branchA, '100.00', '40.00');
    await post(branchB, '200.00', '50.00');
    const own = await grossProfitSummary(pool, organizationId, '2026-10-15', branchA);
    expect(own.today).toMatchObject({ netSales: '100.00', cogs: '40.00',
      grossProfit: '60.00', grossMarginPercent: '60.00' });
    const org = await grossProfitSummary(pool, organizationId, '2026-10-15', null);
    expect(org.today).toMatchObject({ netSales: '300.00', cogs: '90.00', grossProfit: '210.00' });
    expect(own.previousDay.grossProfit).toBe('0.00');
  });

  it('refuses a branch figure when a posted economic journal lacks branch attribution', async () => {
    await post(null, '10.00', '5.00');
    await expect(grossProfitSummary(pool, organizationId, '2026-10-15', branchA))
      .rejects.toThrow('DEPENDENCY_UNAVAILABLE');
  });
});
