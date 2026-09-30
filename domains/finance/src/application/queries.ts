import Decimal from 'decimal.js';
import type { Pool } from 'pg';

export interface PageInput { limit: number; offset: number }

export async function listAccounts(pool: Pool) {
  return (await pool.query<{ code: string; name: string; type: string; normal_balance: string; active: boolean }>(
    'SELECT code, name, type, normal_balance, active FROM finance.account ORDER BY code',
  )).rows;
}

export async function listJournals(pool: Pool, organizationId: string, page: PageInput) {
  const [items, count] = await Promise.all([
    pool.query(
      `SELECT j.id, j.number, j.business_date, j.source_type, j.source_document_id, j.source_document_number,
              j.status, p.code AS period_code
       FROM finance.journal j JOIN finance.accounting_period p ON p.id = j.period_id
       WHERE j.organization_id = $1 ORDER BY j.business_date DESC, j.created_at DESC, j.id DESC
       LIMIT $2 OFFSET $3`, [organizationId, page.limit, page.offset],
    ),
    pool.query<{ count: number }>('SELECT count(*)::int AS count FROM finance.journal WHERE organization_id = $1', [organizationId]),
  ]);
  return { items: items.rows, total: count.rows[0]!.count, ...page };
}

export async function getJournal(pool: Pool, organizationId: string, journalId: string) {
  const journal = (await pool.query(
    `SELECT j.*, p.code AS period_code FROM finance.journal j
     JOIN finance.accounting_period p ON p.id = j.period_id
     WHERE j.id = $1 AND j.organization_id = $2`, [journalId, organizationId],
  )).rows[0];
  if (!journal) return null;
  const lines = (await pool.query(
    `SELECT l.line_number, l.account_code, a.name AS account_name, l.debit, l.credit, l.memo
     FROM finance.journal_line l JOIN finance.account a ON a.code = l.account_code
     WHERE l.journal_id = $1 ORDER BY l.line_number`, [journalId],
  )).rows;
  return { ...journal, lines };
}

export async function generalLedger(pool: Pool, organizationId: string, accountCode: string,
  from: string, to: string, page: PageInput) {
  const opening = (await pool.query<{ balance: string }>(
    `SELECT COALESCE(sum(l.debit - l.credit),0)::text AS balance
     FROM finance.journal_line l JOIN finance.journal j ON j.id = l.journal_id
     WHERE j.organization_id = $1 AND j.status IN ('POSTED','REVERSED')
       AND l.account_code = $2 AND j.business_date < $3::date`, [organizationId, accountCode, from],
  )).rows[0]!.balance;
  const [items, count] = await Promise.all([
    pool.query(
      `SELECT j.id AS journal_id, j.number, j.business_date, j.source_type, j.source_document_number,
              l.line_number, l.debit, l.credit, l.memo
       FROM finance.journal_line l JOIN finance.journal j ON j.id = l.journal_id
       WHERE j.organization_id = $1 AND j.status IN ('POSTED','REVERSED')
         AND l.account_code = $2 AND j.business_date BETWEEN $3::date AND $4::date
       ORDER BY j.business_date, j.created_at, l.line_number LIMIT $5 OFFSET $6`,
      [organizationId, accountCode, from, to, page.limit, page.offset],
    ),
    pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM finance.journal_line l JOIN finance.journal j ON j.id = l.journal_id
       WHERE j.organization_id = $1 AND j.status IN ('POSTED','REVERSED') AND l.account_code = $2
         AND j.business_date BETWEEN $3::date AND $4::date`, [organizationId, accountCode, from, to],
    ),
  ]);
  return { openingBalance: opening, items: items.rows, total: count.rows[0]!.count, ...page };
}

export interface AccountBalance { code: string; name: string; type: string; normal_balance: string; net: string }
export async function accountBalances(pool: Pool, organizationId: string, through: string): Promise<AccountBalance[]> {
  return (await pool.query<AccountBalance>(
    `SELECT a.code, a.name, a.type, a.normal_balance,
            COALESCE(sum(l.debit - l.credit) FILTER (WHERE j.id IS NOT NULL),0)::text AS net
     FROM finance.account a
     LEFT JOIN finance.journal_line l ON l.account_code = a.code
     LEFT JOIN finance.journal j ON j.id = l.journal_id
       AND j.organization_id = $1 AND j.status IN ('POSTED','REVERSED') AND j.business_date <= $2::date
     GROUP BY a.code, a.name, a.type, a.normal_balance ORDER BY a.code`, [organizationId, through],
  )).rows;
}

export async function trialBalance(pool: Pool, organizationId: string, through: string) {
  const balances = await accountBalances(pool, organizationId, through);
  const lines = balances.map((account) => {
    const net = new Decimal(account.net);
    return { ...account, debit: Decimal.max(net, 0).toFixed(2), credit: Decimal.max(net.negated(), 0).toFixed(2) };
  });
  const totalDebit = lines.reduce((sum, line) => sum.plus(line.debit), new Decimal(0));
  const totalCredit = lines.reduce((sum, line) => sum.plus(line.credit), new Decimal(0));
  return { through, lines, totalDebit: totalDebit.toFixed(2), totalCredit: totalCredit.toFixed(2),
    balanced: totalDebit.equals(totalCredit) };
}

export async function profitAndLoss(pool: Pool, organizationId: string, from: string, to: string) {
  const rows = (await pool.query<AccountBalance>(
    `SELECT a.code, a.name, a.type, a.normal_balance,
            COALESCE(sum(CASE WHEN a.type = 'REVENUE' THEN l.credit - l.debit
                              ELSE l.debit - l.credit END) FILTER (WHERE j.id IS NOT NULL),0)::text AS net
     FROM finance.account a
     LEFT JOIN finance.journal_line l ON l.account_code = a.code
     LEFT JOIN finance.journal j ON j.id = l.journal_id
       AND j.organization_id = $1 AND j.status IN ('POSTED','REVERSED')
       AND j.business_date BETWEEN $2::date AND $3::date
     WHERE a.type IN ('REVENUE','EXPENSE')
     GROUP BY a.code, a.name, a.type, a.normal_balance ORDER BY a.code`, [organizationId, from, to],
  )).rows;
  const revenue = rows.filter((row) => row.type === 'REVENUE').reduce((sum, row) => sum.plus(row.net), new Decimal(0));
  const costOfGoods = new Decimal(rows.find((row) => row.code === '5-1000')?.net ?? 0);
  const expenses = rows.filter((row) => row.type === 'EXPENSE').reduce((sum, row) => sum.plus(row.net), new Decimal(0));
  return { from, to, lines: rows, revenue: revenue.toFixed(2), costOfGoods: costOfGoods.toFixed(2),
    grossProfit: revenue.minus(costOfGoods).toFixed(2), netProfit: revenue.minus(expenses).toFixed(2) };
}

export async function balanceSheet(pool: Pool, organizationId: string, through: string) {
  const balances = await accountBalances(pool, organizationId, through);
  const asset = balances.filter((row) => row.type === 'ASSET').map((row) => ({ ...row, amount: row.net }));
  const liability = balances.filter((row) => row.type === 'LIABILITY').map((row) => ({ ...row, amount: new Decimal(row.net).negated().toFixed(2) }));
  const equity = balances.filter((row) => row.type === 'EQUITY').map((row) => ({ ...row, amount: new Decimal(row.net).negated().toFixed(2) }));
  const yearStart = `${through.slice(0, 4)}-01-01`;
  const profit = await profitAndLoss(pool, organizationId, yearStart, through);
  const total = (rows: Array<{ amount: string }>) => rows.reduce((sum, row) => sum.plus(row.amount), new Decimal(0));
  const assets = total(asset), liabilities = total(liability), equityValue = total(equity).plus(profit.netProfit);
  return { through, assets: asset, liabilities: liability, equity,
    currentPeriodProfit: profit.netProfit, totalAssets: assets.toFixed(2),
    totalLiabilities: liabilities.toFixed(2), totalEquity: equityValue.toFixed(2),
    difference: assets.minus(liabilities).minus(equityValue).toFixed(2) };
}

export async function reconciliation(pool: Pool, organizationId: string, through: string) {
  const gl = await accountBalances(pool, organizationId, through);
  const source = (await pool.query<{ inventory: string; receivable: string }>(
    `SELECT COALESCE(sum(inventory_delta),0)::text AS inventory,
            COALESCE(sum(receivable_delta),0)::text AS receivable
     FROM finance.subledger_event WHERE organization_id = $1 AND business_date <= $2::date`, [organizationId, through],
  )).rows[0]!;
  const inventoryGl = new Decimal(gl.find((row) => row.code === '1-1400')?.net ?? 0);
  const receivableGl = new Decimal(gl.find((row) => row.code === '1-1300')?.net ?? 0);
  return {
    through,
    inventory: { gl: inventoryGl.toFixed(2), source: source.inventory,
      difference: inventoryGl.minus(source.inventory).toFixed(2) },
    receivables: { gl: receivableGl.toFixed(2), invoicesMinusPayments: source.receivable,
      difference: receivableGl.minus(source.receivable).toFixed(2),
      temporaryCreditBalance: receivableGl.isNegative() },
  };
}

export async function financeSummary(pool: Pool, organizationId: string, businessDate: string) {
  const today = await profitAndLoss(pool, organizationId, businessDate, businessDate);
  const month = await profitAndLoss(pool, organizationId, `${businessDate.slice(0, 7)}-01`, businessDate);
  return { businessDate, grossProfitToday: today.grossProfit, grossProfitMonthToDate: month.grossProfit };
}

export async function listPostingExceptions(pool: Pool, organizationId: string, page: PageInput) {
  const [items, count] = await Promise.all([
    pool.query(
      `SELECT id, event_id, event_type, business_date, reason_code, status, owner, created_at
       FROM finance.posting_exception WHERE organization_id = $1 ORDER BY created_at DESC, id DESC
       LIMIT $2 OFFSET $3`, [organizationId, page.limit, page.offset],
    ),
    pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM finance.posting_exception WHERE organization_id = $1', [organizationId],
    ),
  ]);
  return { items: items.rows, total: count.rows[0]!.count, ...page };
}

export async function listPeriods(pool: Pool, organizationId: string) {
  return (await pool.query(
    `SELECT id, code, status, soft_closed_at, closed_at, reopened_at
     FROM finance.accounting_period WHERE organization_id = $1 ORDER BY code DESC LIMIT 24`, [organizationId],
  )).rows;
}
