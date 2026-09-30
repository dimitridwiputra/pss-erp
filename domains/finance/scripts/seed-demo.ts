import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { CompensationTemplateSchema, PostingTemplateSchema, demoCompensationRules, demoPostingRules } from '../src/domain/posting-rule';

const accounts = [
  ['1-1100', 'Kas Kantor', 'ASSET', 'DEBIT'],
  ['1-1110', 'Kas Konter', 'ASSET', 'DEBIT'],
  ['1-1300', 'Piutang Usaha', 'ASSET', 'DEBIT'],
  ['1-1400', 'Persediaan Barang Dagang', 'ASSET', 'DEBIT'],
  ['2-1150', 'Barang Diterima Belum Ditagih', 'LIABILITY', 'CREDIT'],
  ['2-1300', 'PPN Keluaran', 'LIABILITY', 'CREDIT'],
  ['3-1000', 'Modal', 'EQUITY', 'CREDIT'],
  ['3-2000', 'Laba Ditahan', 'EQUITY', 'CREDIT'],
  ['4-1000', 'Penjualan', 'REVENUE', 'CREDIT'],
  ['5-1000', 'Harga Pokok Penjualan', 'EXPENSE', 'DEBIT'],
  ['6-2100', 'Selisih Persediaan', 'EXPENSE', 'DEBIT'],
  ['6-2200', 'Selisih Kas', 'EXPENSE', 'DEBIT'],
  ['6-9000', 'Beban Lain-lain', 'EXPENSE', 'DEBIT'],
] as const;

async function main() {
  if (!process.env.DATABASE_URL || !process.env.DEMO_ORGANIZATION_ID) {
    throw new Error('DATABASE_URL and DEMO_ORGANIZATION_ID are required.');
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const current = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit' }).format(new Date());
  const effectiveFrom = `${current}-01`;
  const client = await pool.connect();
  try {
  await client.query('BEGIN');
  for (const [code, name, type, normalBalance] of accounts) {
    await client.query(
      `INSERT INTO finance.account (code, name, type, normal_balance) VALUES ($1,$2,$3,$4)
       ON CONFLICT (code) DO NOTHING`, [code, name, type, normalBalance],
    );
  }
  for (const [roleCode, accountCode] of [
    ['AR_CONTROL', '1-1300'], ['INVENTORY', '1-1400'], ['GRNI', '2-1150'],
    ['SALES_REVENUE', '4-1000'], ['COGS', '5-1000'],
  ]) {
    await client.query(
      `INSERT INTO finance.account_role_mapping (role_code, account_code, effective_from)
       VALUES ($1,$2,$3) ON CONFLICT (role_code, account_code, effective_from) DO NOTHING`,
      [roleCode, accountCode, effectiveFrom],
    );
  }
  for (const rule of demoPostingRules) {
    const template = PostingTemplateSchema.parse(rule.template);
    await client.query(
      `INSERT INTO finance.posting_rule (id, event_type, version, effective_from, line_template)
       VALUES ($1,$2,$3,$4,$5::jsonb)
       ON CONFLICT (event_type, version) DO NOTHING`,
      [randomUUID(), rule.eventType, rule.version, effectiveFrom, JSON.stringify(template)],
    );
  }
  for (const rule of demoCompensationRules) {
    const template = CompensationTemplateSchema.parse(rule.template);
    await client.query(
      `INSERT INTO finance.posting_rule (id, event_type, version, effective_from, line_template)
       VALUES ($1,$2,$3,$4,$5::jsonb)
       ON CONFLICT (event_type, version) DO NOTHING`,
      [randomUUID(), rule.eventType, rule.version, effectiveFrom, JSON.stringify(template)],
    );
  }
  await client.query(
    `INSERT INTO finance.accounting_period (organization_id, code, status) VALUES ($1,$2,'OPEN')
     ON CONFLICT (organization_id, code) DO NOTHING`, [process.env.DEMO_ORGANIZATION_ID, current],
  );
  await client.query('COMMIT');
  process.stdout.write(`Seeded demo COA, v1 posting rules, and period ${current}. Finance sign-off remains pending.\n`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

void main();
