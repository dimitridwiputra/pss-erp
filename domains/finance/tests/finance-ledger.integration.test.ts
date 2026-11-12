import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations } from '../../../scripts/apply-migrations.mjs';
import { reconciliation, trialBalance } from '../src/application/queries';

const databaseName = `pss_finance_test_${randomUUID().replaceAll('-', '')}`;
const organizationId = randomUUID();
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
    ('1-1100','Kas Kantor','ASSET','DEBIT'),('6-9000','Beban Lain-lain','EXPENSE','DEBIT')`);
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

async function draft(number: string) {
  const journalId = randomUUID();
  await pool.query(
    `INSERT INTO finance.journal
       (id, organization_id, number, period_id, business_date, source_type, status)
     VALUES ($1,$2,$3,$4,'2026-10-01','MANUAL','DRAFT')`,
    [journalId, organizationId, number, periodId],
  );
  return journalId;
}

describe('finance database invariants', () => {
  it('rejects posting a journal whose debits and credits differ', async () => {
    const id = await draft('UNBALANCED');
    await pool.query(`INSERT INTO finance.journal_line
      (journal_id, line_number, account_code, debit, credit) VALUES
      ($1,1,'6-9000',100,0),($1,2,'1-1100',0,90)`, [id]);
    await expect(pool.query(`UPDATE finance.journal SET status = 'POSTED' WHERE id = $1`, [id]))
      .rejects.toThrow('JOURNAL_NOT_BALANCED');
  });

  it('makes a posted journal and its lines immutable, while allowing a linked reversal', async () => {
    const id = await draft('BALANCED');
    await pool.query(`INSERT INTO finance.journal_line
      (journal_id, line_number, account_code, debit, credit) VALUES
      ($1,1,'6-9000',100,0),($1,2,'1-1100',0,100)`, [id]);
    await pool.query(`UPDATE finance.journal SET status = 'POSTED' WHERE id = $1`, [id]);
    await expect(pool.query(`UPDATE finance.journal SET number = 'CHANGED' WHERE id = $1`, [id]))
      .rejects.toThrow('POSTED_JOURNAL_IMMUTABLE');
    await expect(pool.query(`UPDATE finance.journal_line SET debit = 101 WHERE journal_id = $1`, [id]))
      .rejects.toThrow('POSTED_JOURNAL_IMMUTABLE');
    await expect(pool.query(`DELETE FROM finance.journal WHERE id = $1`, [id]))
      .rejects.toThrow('POSTED_JOURNAL_IMMUTABLE');
    const reversalId = randomUUID();
    await pool.query(
      `INSERT INTO finance.journal (id, organization_id, number, period_id, business_date,
       source_type, status, reverses_journal_id) VALUES
       ($1,$2,'REVERSAL',$3,'2026-10-01','REVERSAL','DRAFT',$4)`,
      [reversalId, organizationId, periodId, id],
    );
    await pool.query(`INSERT INTO finance.journal_line
      (journal_id, line_number, account_code, debit, credit) VALUES
      ($1,1,'6-9000',0,100),($1,2,'1-1100',100,0)`, [reversalId]);
    await pool.query(`UPDATE finance.journal SET status = 'POSTED' WHERE id = $1`, [reversalId]);
    await pool.query(`UPDATE finance.journal SET status = 'REVERSED', reversed_by_journal_id = $2 WHERE id = $1`, [id, reversalId]);
    expect((await pool.query<{ status: string }>('SELECT status FROM finance.journal WHERE id = $1', [id])).rows[0]?.status)
      .toBe('REVERSED');
  });

  it('rejects a post into a closed period', async () => {
    const id = await draft('CLOSED-PERIOD');
    await pool.query(`INSERT INTO finance.journal_line
      (journal_id, line_number, account_code, debit, credit) VALUES
      ($1,1,'6-9000',100,0),($1,2,'1-1100',0,100)`, [id]);
    await pool.query(`UPDATE finance.accounting_period SET status = 'CLOSED' WHERE id = $1`, [periodId]);
    await expect(pool.query(`UPDATE finance.journal SET status = 'POSTED' WHERE id = $1`, [id]))
      .rejects.toThrow('ACCOUNTING_PERIOD_CLOSED');
  });

  it('reconciles an expected temporary receivable credit after payment precedes invoice', async () => {
    await pool.query(`UPDATE finance.accounting_period SET status = 'OPEN' WHERE id = $1`, [periodId]);
    await pool.query(`INSERT INTO finance.account (code, name, type, normal_balance) VALUES
      ('1-1300','Piutang Usaha','ASSET','DEBIT'),
      ('1-1400','Persediaan Barang Dagang','ASSET','DEBIT'),
      ('2-1150','Barang Diterima Belum Ditagih','LIABILITY','CREDIT')`);
    const paymentId = await draft('PAYMENT-EARLY');
    await pool.query(`INSERT INTO finance.journal_line
      (journal_id, line_number, account_code, debit, credit) VALUES
      ($1,1,'1-1100',100,0),($1,2,'1-1300',0,100)`, [paymentId]);
    await pool.query(`UPDATE finance.journal SET status = 'POSTED' WHERE id = $1`, [paymentId]);
    const receiptId = await draft('RECEIPT-VALUED');
    await pool.query(`INSERT INTO finance.journal_line
      (journal_id, line_number, account_code, debit, credit) VALUES
      ($1,1,'1-1400',60,0),($1,2,'2-1150',0,60)`, [receiptId]);
    await pool.query(`UPDATE finance.journal SET status = 'POSTED' WHERE id = $1`, [receiptId]);
    await pool.query(`INSERT INTO finance.subledger_event
      (event_id, organization_id, event_type, business_date, inventory_delta, receivable_delta) VALUES
      ($1,$3,'PAYMENT_RECEIVED','2026-10-01',0,-100),
      ($2,$3,'INVENTORY_RECEIVED','2026-10-01',60,0)`, [randomUUID(), randomUUID(), organizationId]);
    const report = await reconciliation(pool, organizationId, '2026-10-01');
    expect(report.receivables).toMatchObject({ gl: '-100.00', invoicesMinusPayments: '-100.00',
      difference: '0.00', temporaryCreditBalance: true });
    expect(report.inventory).toMatchObject({ gl: '60.00', source: '60.00', difference: '0.00' });
    expect((await trialBalance(pool, organizationId, '2026-10-01')).balanced).toBe(true);
  });
});
